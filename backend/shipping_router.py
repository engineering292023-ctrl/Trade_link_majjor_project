"""
TRADELINK — Shipping Router  (backend/shipping_router.py)

8 FastAPI routes for the complete shipping flow.
Uses 100% simulated tracking — no third-party APIs.

ROUTES:
  POST /api/shipping/calculate-rate       rate estimate before booking
  POST /api/shipping/create-request       save shipment request to Sheets
  POST /api/shipping/create-payment       Razorpay order for shipping fee
  POST /api/shipping/verify-payment       verify payment + create shipment
  GET  /api/shipping/track/{request_id}   live simulated tracking status
  GET  /api/shipping/requests/{seller_id} all shipments for a seller
  GET  /api/shipping/request/{request_id} single shipment detail
  GET  /api/shipping/all                  all shipments (admin)
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import razorpay
import hmac
import hashlib
import asyncio

from auth import get_current_user
from database import MongoDB as SheetsDB
from config import settings
from shipping import (
    calculate_shipping_rate,
    create_shipment_record,
    get_simulated_tracking_status,
    generate_tracking_number,
    send_shipping_confirmation_email,
    send_shipping_payment_email,
    DEFAULT_COURIER,
)

router = APIRouter(prefix="/api/shipping", tags=["shipping"])


# ─────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────

class CalculateRateRequest(BaseModel):
    weight_kg:     float
    pickup_city:   str
    delivery_city: str
    courier:       Optional[str] = "bluedart"


class CreateShipmentRequest(BaseModel):
    seller_id:         str
    goods_description: str
    category:          str
    weight_kg:         float
    pickup_address:    str
    pickup_city:       str
    pickup_state:      str
    pickup_lat:        Optional[float] = 0.0
    pickup_lng:        Optional[float] = 0.0
    delivery_address:  str
    delivery_city:     str
    delivery_state:    str
    delivery_lat:      Optional[float] = 0.0
    delivery_lng:      Optional[float] = 0.0
    pickup_date:       str
    courier:           Optional[str] = "bluedart"
    deal_id:           Optional[str] = ""


class CreateShippingPaymentRequest(BaseModel):
    request_id: str
    seller_id:  str


class VerifyShippingPaymentRequest(BaseModel):
    request_id:          str
    seller_id:           str
    razorpay_payment_id: str
    razorpay_order_id:   str
    razorpay_signature:  str


# ─────────────────────────────────────────
# HELPER
# ─────────────────────────────────────────

def _check_owner(user: dict, seller_id: str):
    if user.get("id") != seller_id:
        raise HTTPException(403, "Access denied — you can only view your own shipments.")


def _transport_cols() -> list:
    """Column list for Transport_Requests sheet — must match setup_sheets.py."""
    return [
        "id", "seller_id", "seller_name", "deal_id",
        "title", "category", "quantity_kg", "volume_cft",
        "pickup_city", "pickup_state", "pickup_address",
        "pickup_lat", "pickup_lng",
        "delivery_city", "delivery_state", "delivery_address",
        "delivery_lat", "delivery_lng",
        "pickup_date", "budget_inr", "status",
        "accepted_vehicle_id", "transporter_id", "transporter_name",
        "agreed_price_inr", "payment_status",
        "razorpay_order_id", "razorpay_payment_id",
        "pickup_at", "delivered_at",
        "current_lat", "current_lng",
        "last_location_update", "tracking_notes",
        # 3 columns added by setup_sheets_shipping.py
        "courier_slug", "tracking_number", "aftership_tracking_url",
        "created_at",
    ]


# ─────────────────────────────────────────
# ROUTE 1 — CALCULATE RATE
# ─────────────────────────────────────────

@router.post("/calculate-rate")
async def calculate_rate(body: CalculateRateRequest):
    """
    Returns shipping cost estimate — no auth needed.
    Called live as seller fills the form so they see price before paying.
    """
    if body.weight_kg <= 0:
        raise HTTPException(400, "Weight must be greater than 0.")
    if body.weight_kg > 5000:
        raise HTTPException(400, "Maximum weight is 5000 kg per shipment.")

    rate = calculate_shipping_rate(
        weight_kg=body.weight_kg,
        pickup_city=body.pickup_city,
        delivery_city=body.delivery_city,
        courier=body.courier or DEFAULT_COURIER,
    )
    return {"success": True, "rate": rate}


# ─────────────────────────────────────────
# ROUTE 2 — CREATE SHIPMENT REQUEST
# ─────────────────────────────────────────

@router.post("/create-request")
async def create_shipment_request(
    body: CreateShipmentRequest,
    user=Depends(get_current_user)
):
    """
    Saves a new shipping request to Transport_Requests sheet.
    Status = 'payment_pending' until Razorpay payment is verified.
    """
    _check_owner(user, body.seller_id)
    db   = SheetsDB()
    now  = datetime.utcnow().isoformat() + "Z"

    rate = calculate_shipping_rate(
        weight_kg=body.weight_kg,
        pickup_city=body.pickup_city,
        delivery_city=body.delivery_city,
        courier=body.courier or DEFAULT_COURIER,
    )

    row = {
        "role":               "transport",   # used for ID prefix TR...
        "seller_id":          body.seller_id,
        "seller_name":        user.get("name", ""),
        "deal_id":            body.deal_id or "",
        "title":              body.goods_description,
        "category":           body.category,
        "quantity_kg":        str(body.weight_kg),
        "volume_cft":         "",
        "pickup_city":        body.pickup_city,
        "pickup_state":       body.pickup_state,
        "pickup_address":     body.pickup_address,
        "pickup_lat":         str(body.pickup_lat or ""),
        "pickup_lng":         str(body.pickup_lng or ""),
        "delivery_city":      body.delivery_city,
        "delivery_state":     body.delivery_state,
        "delivery_address":   body.delivery_address,
        "delivery_lat":       str(body.delivery_lat or ""),
        "delivery_lng":       str(body.delivery_lng or ""),
        "pickup_date":        body.pickup_date,
        "budget_inr":         str(rate["total_inr"]),
        "status":             "payment_pending",
        "accepted_vehicle_id":"",
        "transporter_id":     "",
        "transporter_name":   rate["courier_name"],
        "agreed_price_inr":   str(rate["total_inr"]),
        "payment_status":     "unpaid",
        "razorpay_order_id":  "",
        "razorpay_payment_id":"",
        "pickup_at":          "",
        "delivered_at":       "",
        "current_lat":        "",
        "current_lng":        "",
        "last_location_update":"",
        "tracking_notes":     "",
        "courier_slug":       body.courier or DEFAULT_COURIER,
        "tracking_number":    "",
        "aftership_tracking_url": "",
        "created_at":         now,
    }

    req_id = db._append("Transport_Requests", _transport_cols(), row)

    return {
        "success":    True,
        "request_id": req_id,
        "rate":       rate,
        "message":    "Shipment request saved. Proceed to payment.",
    }


# ─────────────────────────────────────────
# ROUTE 3 — CREATE RAZORPAY ORDER
# ─────────────────────────────────────────

@router.post("/create-payment")
async def create_shipping_payment(
    body: CreateShippingPaymentRequest,
    user=Depends(get_current_user)
):
    """
    Creates a Razorpay order for the shipping fee.
    Amount is in paise (multiply INR × 100).
    """
    _check_owner(user, body.seller_id)
    db = SheetsDB()

    all_reqs = db._read_all("Transport_Requests")
    req      = next((r for r in all_reqs if r.get("id") == body.request_id), None)
    if not req:
        raise HTTPException(404, "Shipment request not found.")
    if req.get("seller_id") != body.seller_id:
        raise HTTPException(403, "Access denied.")

    try:
        amount_inr = float(req.get("agreed_price_inr", 0))
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid shipment amount.")

    if amount_inr <= 0:
        raise HTTPException(400, "Shipping amount must be greater than 0.")

    # Razorpay requires paise (₹1 = 100 paise)
    amount_paise = int(amount_inr * 100)

    try:
        rz = razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))
        order = rz.order.create({
            "amount":   amount_paise,
            "currency": "INR",
            "receipt":  f"ship_{body.request_id[:12]}",
            "notes": {
                "request_id": body.request_id,
                "seller_id":  body.seller_id,
                "type":       "shipping",
            },
        })
    except Exception as e:
        raise HTTPException(500, f"Payment gateway error: {e}")

    # Save order ID to sheet
    db._update_row(
        "Transport_Requests", _transport_cols(),
        body.request_id,
        {"razorpay_order_id": order["id"]}
    )

    return {
        "success":    True,
        "order_id":   order["id"],
        "amount":     amount_paise,
        "currency":   "INR",
        "amount_inr": amount_inr,
        "key_id":     settings.RAZORPAY_KEY_ID,
    }


# ─────────────────────────────────────────
# ROUTE 4 — VERIFY PAYMENT + CREATE SHIPMENT
# ─────────────────────────────────────────

@router.post("/verify-payment")
async def verify_shipping_payment(
    body: VerifyShippingPaymentRequest,
    user=Depends(get_current_user)
):
    """
    Called by frontend after Razorpay payment succeeds.

    Steps:
    1. Verify Razorpay HMAC-SHA256 signature (security — always do this)
    2. Generate tracking number
    3. Create local shipment record (no external API)
    4. Update Transport_Requests sheet
    5. Create in-app notification
    6. Send Email 1: payment confirmed
    7. Send Email 2: tracking number + full details
    8. Return tracking details to frontend
    """
    _check_owner(user, body.seller_id)

    # ── 1. Verify Razorpay signature ─────────────────────────────
    # HMAC-SHA256(order_id + "|" + payment_id, secret) must match
    try:
        expected = hmac.new(
            settings.RAZORPAY_KEY_SECRET.encode(),
            f"{body.razorpay_order_id}|{body.razorpay_payment_id}".encode(),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected, body.razorpay_signature):
            raise HTTPException(400, "Payment signature invalid — possible tampering.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Signature check failed: {e}")

    # ── 2. Load request ──────────────────────────────────────────
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")
    req      = next((r for r in all_reqs if r.get("id") == body.request_id), None)
    if not req:
        raise HTTPException(404, "Shipment request not found.")

    # ── 3. Generate tracking number ──────────────────────────────
    courier_slug    = req.get("courier_slug", DEFAULT_COURIER)
    tracking_number = generate_tracking_number(courier_slug)

    # ── 4. Create shipment record (simulation) ───────────────────
    shipment = create_shipment_record(
        tracking_number=tracking_number,
        courier=courier_slug,
        title=req.get("title", "Goods"),
        pickup_address=req.get("pickup_address", ""),
        delivery_address=req.get("delivery_address", ""),
    )

    # ── 5. Update Sheets ─────────────────────────────────────────
    now = datetime.utcnow().isoformat() + "Z"
    db._update_row(
        "Transport_Requests", _transport_cols(),
        body.request_id,
        {
            "status":                 "booked",
            "payment_status":         "paid",
            "razorpay_payment_id":    body.razorpay_payment_id,
            "tracking_number":        tracking_number,
            "aftership_tracking_url": shipment["tracking_url"],
            "pickup_at":              now,
        }
    )

    # ── 6. In-app notification ───────────────────────────────────
    db.create_notification(
        user_id=body.seller_id,
        type="success",
        icon="📦",
        title="Shipment Booked!",
        message=f"Tracking: {tracking_number} via {shipment['courier_name']}",
    )

    # ── 7. Send emails in background ─────────────────────────────
    amount_inr    = float(req.get("agreed_price_inr", 0))
    seller_email  = user.get("email", "")
    seller_name   = user.get("name", "Seller")

    rate_info = calculate_shipping_rate(
        weight_kg=float(req.get("quantity_kg", 1)),
        pickup_city=req.get("pickup_city", ""),
        delivery_city=req.get("delivery_city", ""),
        courier=courier_slug,
    )

    # Email 1 — payment confirmed (immediate)
    asyncio.create_task(asyncio.to_thread(
        send_shipping_payment_email,
        seller_email, seller_name,
        req.get("title", "your goods"),
        amount_inr,
        body.request_id,
    ))

    # Email 2 — tracking number + full details
    asyncio.create_task(asyncio.to_thread(
        send_shipping_confirmation_email,
        seller_email, seller_name,
        tracking_number,
        shipment["courier_name"],
        req.get("pickup_address", ""),
        req.get("delivery_address", ""),
        req.get("title", "Goods"),
        float(req.get("quantity_kg", 0)),
        amount_inr,
        rate_info["estimated_days"],
    ))

    return {
        "success":         True,
        "tracking_number": tracking_number,
        "courier":         shipment["courier_name"],
        "tracking_url":    shipment["tracking_url"],
        "status":          "booked",
        "message":         "Shipment booked! Tracking details sent to your email.",
    }


# ─────────────────────────────────────────
# ROUTE 5 — LIVE TRACKING
# ─────────────────────────────────────────

@router.get("/track/{request_id}")
async def track_shipment(request_id: str, user=Depends(get_current_user)):
    """
    Returns simulated live tracking status.
    Status auto-progresses based on time elapsed since booking.
    No external API call — 100% local.
    """
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")
    req      = next((r for r in all_reqs if r.get("id") == request_id), None)

    if not req:
        raise HTTPException(404, "Shipment not found.")
    if req.get("seller_id") != user.get("id"):
        raise HTTPException(403, "Access denied.")

    tracking_number = req.get("tracking_number", "")
    if not tracking_number:
        return {
            "success": False,
            "message": "Tracking number not yet assigned. Payment may still be processing.",
        }

    status = get_simulated_tracking_status(
        tracking_number=tracking_number,
        courier=req.get("courier_slug", DEFAULT_COURIER),
        pickup_city=req.get("pickup_city", ""),
        delivery_city=req.get("delivery_city", ""),
        booked_at=req.get("pickup_at", datetime.utcnow().isoformat() + "Z"),
    )

    # Attach request metadata
    status["request_id"]      = request_id
    status["pickup_address"]  = req.get("pickup_address", "")
    status["delivery_address"]= req.get("delivery_address", "")
    status["goods"]           = req.get("title", "")
    status["weight_kg"]       = req.get("quantity_kg", "")
    status["payment_status"]  = req.get("payment_status", "")
    status["amount_paid"]     = req.get("agreed_price_inr", "")

    return status


# ─────────────────────────────────────────
# ROUTE 6 — LIST SELLER'S SHIPMENTS
# ─────────────────────────────────────────

@router.get("/requests/{seller_id}")
async def get_seller_shipments(
    seller_id: str,
    page:  int = 1,
    limit: int = 10,
    user=Depends(get_current_user)
):
    """All shipments for a seller — newest first, paginated."""
    _check_owner(user, seller_id)
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")
    mine     = [r for r in all_reqs if r.get("seller_id") == seller_id]
    mine.sort(key=lambda r: r.get("created_at", ""), reverse=True)

    total = len(mine)
    start = (page - 1) * limit

    return {
        "success":  True,
        "total":    total,
        "page":     page,
        "requests": mine[start:start + limit],
    }


# ─────────────────────────────────────────
# ROUTE 7 — SINGLE REQUEST DETAIL
# ─────────────────────────────────────────

@router.get("/request/{request_id}")
async def get_shipment_detail(request_id: str, user=Depends(get_current_user)):
    """Returns full detail of one shipment."""
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")
    req      = next((r for r in all_reqs if r.get("id") == request_id), None)

    if not req:
        raise HTTPException(404, "Shipment not found.")
    if req.get("seller_id") != user.get("id"):
        raise HTTPException(403, "Access denied.")

    return {"success": True, "request": req}


# ─────────────────────────────────────────
# ROUTE 8 — ALL SHIPMENTS (admin)
# ─────────────────────────────────────────

@router.get("/all")
async def get_all_shipments(
    status: str = "",
    page:   int = 1,
    limit:  int = 20,
):
    """All shipments — for admin dashboard."""
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")

    if status:
        all_reqs = [r for r in all_reqs if r.get("status") == status]
    all_reqs.sort(key=lambda r: r.get("created_at", ""), reverse=True)

    total = len(all_reqs)
    start = (page - 1) * limit

    return {
        "success":  True,
        "total":    total,
        "page":     page,
        "requests": all_reqs[start:start + limit],
    }


# ─────────────────────────────────────────
# ROUTE 9 — TRACK BY DEAL ID
# ─────────────────────────────────────────

CITY_COORDS = {
    "bengaluru": (12.9716, 77.5946),
    "bangalore": (12.9716, 77.5946),
    "pune": (18.5204, 73.8567),
    "mumbai": (19.0760, 72.8777),
    "delhi": (28.6139, 77.2090),
    "new delhi": (28.6139, 77.2090),
    "hyderabad": (17.3850, 78.4867),
    "chennai": (13.0827, 80.2707),
    "kolkata": (22.5726, 88.3639),
    "ahmedabad": (23.0225, 72.5714),
    "surat": (21.1702, 72.8311),
    "jaipur": (26.9124, 75.7873),
    "belagavi": (15.8497, 74.4977),
    "belgaum": (15.8497, 74.4977),
    "nagpur": (21.1458, 79.0882),
    "indore": (22.7196, 75.8577),
    "kochi": (9.9312, 76.2673),
}

def _get_city_lat_lng(city_name: str, fallback_lat: float, fallback_lng: float):
    c = str(city_name or "").strip().lower()
    return CITY_COORDS.get(c, (fallback_lat, fallback_lng))


@router.get("/track-by-deal/{deal_id}")
async def track_by_deal(deal_id: str):
    """Returns transport tracking info and map coordinates linked to a deal."""
    db       = SheetsDB()
    all_reqs = db._read_all("Transport_Requests")
    req      = next((r for r in all_reqs if r.get("deal_id") == deal_id), None)

    if not req:
        from database import MongoDB
        deal = MongoDB().get_deal(deal_id)
        p_city = (deal.get("pickup_city") if deal else "") or "Bengaluru"
        d_city = (deal.get("deliver_to") or deal.get("delivery_city") if deal else "") or "Pune"
        plat, plng = _get_city_lat_lng(p_city, 12.9716, 77.5946)
        dlat, dlng = _get_city_lat_lng(d_city, 18.5204, 73.8567)
        clat, clng = round((plat + dlat)/2, 4), round((plng + dlng)/2, 4)

        return {
            "success": True,
            "has_transport": True,
            "tracking": {
                "status": deal.get("delivery_status", "in_transit") if deal else "in_transit",
                "status_label": "🚛 Shipment In Transit",
                "pickup_city": p_city,
                "delivery_city": d_city,
                "pickup_lat": plat,
                "pickup_lng": plng,
                "delivery_lat": dlat,
                "delivery_lng": dlng,
                "current_lat": clat,
                "current_lng": clng,
                "progress_pct": 55,
                "courier": "TradeLink Express Logistics",
                "transporter_name": (deal.get("transporter_name") if deal else "") or "TradeLink Logistics",
                "tracking_number": (deal.get("tracking_number") if deal else "") or f"TLTRK-{deal_id[:8].upper()}"
            }
        }

    p_city = req.get("pickup_city", "Bengaluru")
    d_city = req.get("delivery_city", "Pune")
    plat, plng = _get_city_lat_lng(p_city, 12.9716, 77.5946)
    dlat, dlng = _get_city_lat_lng(d_city, 18.5204, 73.8567)
    clat, clng = round((plat + dlat)/2, 4), round((plng + dlng)/2, 4)

    tracking_data = get_simulated_tracking_status(
        req.get("tracking_number", f"TLTRK-{deal_id[:8].upper()}"),
        req.get("courier", "tl_logistics"),
        p_city,
        d_city,
        req.get("created_at", "")
    )
    tracking_data["pickup_lat"] = plat
    tracking_data["pickup_lng"] = plng
    tracking_data["delivery_lat"] = dlat
    tracking_data["delivery_lng"] = dlng
    tracking_data["current_lat"] = clat
    tracking_data["current_lng"] = clng
    tracking_data["status_label"] = req.get("status", "").replace("_", " ").title() or "In Transit"
    tracking_data["transporter_name"] = req.get("transporter_name") or "TradeLink Logistics"

    return {
        "success": True,
        "has_transport": True,
        "request": req,
        "tracking": tracking_data
    }
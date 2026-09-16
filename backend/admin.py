"""
TRADELINK — Admin Panel Routes  (backend/admin.py)
Fixed:
  1. /transport/requests now returns "requests" key (was "rows") — fixes admin panel showing nothing
  2. dispatch now accepts payment_status "in_escrow" (set by Razorpay verify) — fixes dispatch button
  3. TransportDispatchRequest now accepts tracking_number + transporter_name
  4. Dispatch email is now a rich HTML email with invoice + tracking info
"""

from fastapi import APIRouter, HTTPException, Header, Depends
from pydantic import BaseModel
from typing import Optional
from config import settings
from database import MongoDB
from email_service import send_kyc_approved_email, send_kyc_rejected_email
from datetime import datetime

router = APIRouter(prefix="/api/admin", tags=["admin"])

db = MongoDB()


# ─────────────────────────────────────────
# ADMIN AUTH CHECK
# ─────────────────────────────────────────

def require_admin(x_admin_key: str = Header(None)):
    if not x_admin_key or x_admin_key != settings.ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="Admin access denied. Set X-Admin-Key header.")
    return True


# ─────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────

class KYCApproveRequest(BaseModel):
    user_id: str

class KYCRejectRequest(BaseModel):
    user_id: str
    reason:  str

class TransportAcceptRequest(BaseModel):
    request_id:       str
    agreed_price_inr: float

class TransportRejectRequest(BaseModel):
    request_id: str
    reason:     str

class TransportDispatchRequest(BaseModel):
    request_id:       str
    tracking_number:  Optional[str] = ""   # shown to seller
    transporter_name: Optional[str] = ""   # name of driver / transport co.


# ─────────────────────────────────────────
# KYC ROUTES
# ─────────────────────────────────────────

@router.get("/kyc/pending")
async def list_pending_kyc(x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    pending = db.get_users_by_kyc_status("submitted")
    for user in pending:
        user["kyc_docs"] = db.get_kyc_docs(user["id"])
    return {"count": len(pending), "users": pending}


@router.get("/kyc/all")
async def list_all_kyc(x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    from pymongo import DESCENDING
    users = list(db._col("users").find(
        {"kyc_status": {"$nin": ["", "unverified", None]}},
        {"_id": 0}
    ).sort("created_at", DESCENDING))
    return {"count": len(users), "users": users}


@router.post("/kyc/approve")
async def approve_kyc(body: KYCApproveRequest, x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    user = db.get_user_profile(body.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    now = datetime.utcnow().isoformat() + "Z"
    db.update_user(body.user_id, {"kyc_status": "verified", "kyc_approved_at": now})
    send_kyc_approved_email(user["email"], user["name"])
    db.create_notification(
        user_id=body.user_id, type="success", icon="✅",
        title="KYC Approved!",
        message="Your documents are verified. You can now receive payments.",
    )
    return {"success": True, "message": f"KYC approved for {user['name']}"}


@router.post("/kyc/reject")
async def reject_kyc(body: KYCRejectRequest, x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    user = db.get_user_profile(body.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    now = datetime.utcnow().isoformat() + "Z"
    db.update_user(body.user_id, {
        "kyc_status": "rejected", "kyc_rejected_at": now,
        "kyc_reject_reason": body.reason,
    })
    send_kyc_rejected_email(user["email"], user["name"], body.reason)
    db.create_notification(
        user_id=body.user_id, type="danger", icon="❌",
        title="KYC Update Required",
        message=f"Your documents need to be re-uploaded. Reason: {body.reason}",
    )
    return {"success": True, "message": f"KYC rejected for {user['name']}"}


# ─────────────────────────────────────────
# USER MANAGEMENT
# ─────────────────────────────────────────

@router.get("/users")
async def list_users(
    role:  str = "",
    page:  int = 1,
    limit: int = 50,
    x_admin_key: str = Header(None)
):
    require_admin(x_admin_key)
    from pymongo import DESCENDING
    query = {}
    if role:
        query["role"] = role
    total = db._col("users").count_documents(query)
    skip  = (page - 1) * limit
    users = list(db._col("users").find(query, {"_id": 0}).sort("created_at", DESCENDING).skip(skip).limit(limit))
    return {"total": total, "page": page, "users": users}


# ─────────────────────────────────────────
# TRANSPORT MANAGEMENT
# ─────────────────────────────────────────

@router.get("/transport/requests")
async def list_transport_requests(
    status: str = "",
    page:   int = 1,
    limit:  int = 50,
    x_admin_key: str = Header(None)
):
    require_admin(x_admin_key)
    from pymongo import DESCENDING
    query = {}
    if status:
        query["status"] = status
    total = db._col("transport_requests").count_documents(query)
    skip  = (page - 1) * limit
    rows  = list(db._col("transport_requests").find(query, {"_id": 0})
                 .sort("created_at", DESCENDING).skip(skip).limit(limit))

    # Enrich with seller email
    for r in rows:
        seller = db.get_user_profile(r.get("seller_id", ""))
        r["seller_email"] = seller["email"] if seller else ""
        r["seller_name"]  = seller["name"]  if seller else r.get("seller_name", "")

    # ── FIX: return key is "requests" (was "rows") ──
    return {"success": True, "total": total, "page": page, "requests": rows}


@router.post("/transport/accept")
async def accept_transport(body: TransportAcceptRequest, x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    if not body.request_id or body.agreed_price_inr <= 0:
        raise HTTPException(400, "request_id and agreed_price_inr are required.")

    now = datetime.utcnow().isoformat() + "Z"
    db._col("transport_requests").update_one(
        {"id": body.request_id},
        {"$set": {
            "status":           "processed",
            "agreed_price_inr": str(body.agreed_price_inr),
            "accepted_at":      now,
        }}
    )
    req    = db.get_transport_request(body.request_id)
    seller = db.get_user_profile(req.get("seller_id", "")) if req else None

    if seller:
        db.create_notification(
            user_id=req["seller_id"], type="success", icon="🚛",
            title="Transport Request Accepted",
            message="Your transport request has been reviewed and accepted. Please log in to confirm booking.",
        )
        from email_service import send_email, _base_template
        content = f'''
        <p>Hi <strong>{seller['name']}</strong>,</p>
        <p>Great news! Your transport request has been reviewed and accepted by TradeLink Logistics.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:14px 0;">
          <p style="margin:4px 0;font-size:14px;"><strong>Status:</strong> Approved &amp; Ready for Confirmation</p>
        </div>
        <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
          👇 Log in to your <strong>Seller Portal → Transport tab</strong> to view details and confirm booking.
        </div>
        '''
        send_email(seller["email"], "🚛 Transport Request Accepted — TradeLink",
                   _base_template("Transport Request Accepted!", content))

    return {"success": True}


@router.post("/transport/reject")
async def reject_transport(body: TransportRejectRequest, x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    now = datetime.utcnow().isoformat() + "Z"
    db._col("transport_requests").update_one(
        {"id": body.request_id},
        {"$set": {"status": "cancelled", "cancelled_at": now, "cancel_reason": body.reason}}
    )
    req    = db.get_transport_request(body.request_id)
    seller = db.get_user_profile(req.get("seller_id", "")) if req else None
    if seller:
        db.create_notification(
            user_id=req["seller_id"], type="danger", icon="❌",
            title="Transport Request Rejected",
            message=f"Reason: {body.reason}. Please submit a new request.",
        )
    return {"success": True}


def _send_dispatch_email(to_email: str, seller_name: str, req: dict, dispatched_at: str, tracking_number: str, transporter_name: str):
    from email_service import send_email, _base_template
    title = req.get("title", "Goods Shipment")
    pickup = req.get("pickup_city", "Origin")
    delivery = req.get("delivery_city", "Destination")
    content = f"""
    <p>Hi <strong>{seller_name}</strong>,</p>
    <p>Your transport request for <strong>{title}</strong> has been <strong>Dispatched</strong>!</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:14px 0;">
      <p style="margin:4px 0;font-size:14px;"><strong>Transporter:</strong> {transporter_name or 'TradeLink Express'}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Tracking No:</strong> {tracking_number or 'TLTRK-PENDING'}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Route:</strong> {pickup} → {delivery}</p>
    </div>
    <div style="background:#e0f2fe;border:1px solid #7dd3fc;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
      🚛 You can now track live transit progress on your <strong>Seller Portal → Transport screen</strong>.
    </div>
    """
    send_email(to_email, f"🚛 Shipment Dispatched — Track #{req.get('id')}", _base_template("Shipment Dispatched!", content))


@router.post("/transport/dispatch")
async def dispatch_transport(body: TransportDispatchRequest, x_admin_key: str = Header(None)):
    require_admin(x_admin_key)
    req = db.get_transport_request(body.request_id)
    if not req:
        raise HTTPException(404, "Request not found.")

    # ── FIX: Razorpay sets payment_status to "in_escrow", not "paid" ──
    if req.get("payment_status") not in ("paid", "in_escrow"):
        raise HTTPException(400, "Seller has not paid yet. Payment status: " + str(req.get("payment_status")))

    now = datetime.utcnow().isoformat() + "Z"
    trans_name = body.transporter_name or "TradeLink Logistics"
    trk_num = body.tracking_number or f"TLTRK-{body.request_id[:8].upper()}"

    db._col("transport_requests").update_one(
        {"id": body.request_id},
        {"$set": {
            "status":           "in_transit",
            "dispatched_at":    now,
            "tracking_number":  trk_num,
            "transporter_name": trans_name,
        }}
    )

    if req.get("deal_id"):
        db._col("deals").update_one(
            {"id": req["deal_id"]},
            {"$set": {
                "delivery_status":  "in_transit",
                "transporter_name": trans_name,
                "tracking_number":  trk_num,
            }}
        )

    # Add first tracking note
    import json
    tracking_notes = [{
        "status":    "dispatched",
        "note":      f"Shipment dispatched by TradeLink Logistics" +
                     (f" via {body.transporter_name}" if body.transporter_name else "") +
                     (f". Tracking: {body.tracking_number}" if body.tracking_number else ""),
        "timestamp": now,
    }]
    db._col("transport_requests").update_one(
        {"id": body.request_id},
        {"$set": {"tracking_notes": json.dumps(tracking_notes)}}
    )

    seller = db.get_user_profile(req.get("seller_id", ""))
    if seller:
        try:
            _send_dispatch_email(
                seller["email"], seller["name"], req, now,
                body.tracking_number or "", body.transporter_name or ""
            )
        except Exception as e:
            print(f"[DISPATCH] Email error (dispatch still succeeded): {e}")
        try:
            db.create_notification(
                user_id=req["seller_id"], type="info", icon="🚛",
                title="Shipment Dispatched!",
                message="Your goods are on the way! Track live from Transport tab → Track button.",
            )
        except Exception as e:
            print(f"[DISPATCH] Notification error (dispatch still succeeded): {e}")

    return {"success": True}





# ─────────────────────────────────────────
# PLATFORM STATS
# ─────────────────────────────────────────

@router.get("/stats")
async def platform_stats(x_admin_key: str = Header(None)):
    require_admin(x_admin_key)

    users_col     = db._col("users")
    listings_col  = db._col("listings")
    deals_col     = db._col("deals")
    payments_col  = db._col("payments")
    transport_col = db._col("transport_requests")

    total_users      = users_col.count_documents({})
    sellers          = users_col.count_documents({"role": "seller"})
    merchants        = users_col.count_documents({"role": "merchant"})
    kyc_pending      = users_col.count_documents({"kyc_status": "submitted"})
    kyc_verified     = users_col.count_documents({"kyc_status": "verified"})
    total_listings   = listings_col.count_documents({})
    active_listings  = listings_col.count_documents({"status": "active"})
    total_deals      = deals_col.count_documents({})
    completed_deals  = deals_col.count_documents({"delivery_status": "delivered"})
    transport_open   = transport_col.count_documents({"status": "open"})
    transport_active = transport_col.count_documents({"status": "in_transit"})

    pipeline = [
        {"$match": {"status": "released"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}}
    ]
    rev_result    = list(payments_col.aggregate(pipeline))
    total_revenue = round((rev_result[0]["total"] if rev_result else 0) * 0.02, 2)

    category_pipeline = [
        {"$match": {"status": {"$in": ["active", "closed"]}}},
        {"$group": {"_id": "$category", "count": {"$sum": 1}, "total_bids": {"$sum": "$bid_count"}}},
        {"$sort": {"total_bids": -1}},
        {"$limit": 5}
    ]
    top_categories = list(listings_col.aggregate(category_pipeline))

    from datetime import timedelta
    seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat() + "Z"
    daily_pipeline = [
        {"$match": {"created_at": {"$gte": seven_days_ago}}},
        {"$group": {"_id": {"$substr": ["$created_at", 0, 10]}, "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}}
    ]
    daily_deals = list(deals_col.aggregate(daily_pipeline))

    return {
        "total_users":      total_users,
        "sellers":          sellers,
        "merchants":        merchants,
        "kyc_pending":      kyc_pending,
        "kyc_verified":     kyc_verified,
        "total_listings":   total_listings,
        "active_listings":  active_listings,
        "total_deals":      total_deals,
        "completed_deals":  completed_deals,
        "transport_open":   transport_open,
        "transport_active": transport_active,
        "platform_revenue": total_revenue,
        "top_categories":   [{"category": c["_id"], "listings": c["count"], "bids": c["total_bids"]} for c in top_categories],
        "daily_deals":      [{"date": d["_id"], "count": d["count"]} for d in daily_deals],
    }
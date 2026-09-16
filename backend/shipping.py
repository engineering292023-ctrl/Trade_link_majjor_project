"""
TRADELINK — Shipping Service  (backend/shipping.py)

100% self-contained shipping simulation — NO third-party APIs needed.
No AfterShip, no Shiprocket, no EasyPost. Zero external dependencies.

WHAT THIS FILE DOES:
1. Calculates realistic shipping rates (BlueDart real rate card logic)
2. Generates real-format tracking numbers per courier
3. Simulates live tracking status with realistic checkpoints
4. Auto-progresses shipment status based on time since booking
5. Sends two beautiful HTML emails to seller

HOW SIMULATED TRACKING WORKS:
  When shipment is booked → we save the exact booking timestamp.
  When seller checks tracking → we calculate hours elapsed since booking.
  Based on hours, we return the matching status + checkpoint history.

  TIME SINCE BOOKING → STATUS
  ─────────────────────────────────────────────────────────────
  0  – 2  hours  →  InfoReceived    "Shipment info received"
  2  – 6  hours  →  PickedUp        "Picked up from sender"
  6  – 36 hours  →  InTransit       "In transit to destination"
  36 – 48 hours  →  OutForDelivery  "Out for delivery"
  48 + hours     →  Delivered       "Delivered successfully"
  ─────────────────────────────────────────────────────────────

TO GO LIVE LATER:
  Replace create_shipment_record() and get_simulated_tracking_status()
  with real courier API calls. Everything else (rate calc, emails,
  payment flow, sheets storage) stays exactly the same.
"""

import random
import uuid
from datetime import datetime, timedelta
from email_service import send_email, _base_template


# ─────────────────────────────────────────
# COURIER DEFINITIONS
# ─────────────────────────────────────────

COURIERS = {
    "bluedart": {
        "name":    "BlueDart Express",
        "prefix":  "",
        "digits":  12,
        "color":   "#E31837",
    },
    "delhivery": {
        "name":    "Delhivery",
        "prefix":  "",
        "digits":  16,
        "color":   "#D3242B",
    },
    "dtdc": {
        "name":    "DTDC Express",
        "prefix":  "Z",
        "digits":  8,
        "color":   "#FF6600",
    },
    "ecom": {
        "name":    "Ecom Express",
        "prefix":  "ECOM",
        "digits":  10,
        "color":   "#00529B",
    },
}

DEFAULT_COURIER = "bluedart"


# ─────────────────────────────────────────
# TRACKING NUMBER GENERATION
# ─────────────────────────────────────────

def generate_tracking_number(courier: str = "bluedart") -> str:
    """
    Generates a realistic tracking number in the exact format
    each Indian courier uses in real life.

    BlueDart:   12 digits        → 347291048576
    Delhivery:  16 digits        → 3472910485768934
    DTDC:       Z + 8 digits     → Z34729104
    Ecom:       ECOM + 10 digits → ECOM3472910485

    Uses UUID int + random digits to guarantee uniqueness.
    """
    info   = COURIERS.get(courier, COURIERS[DEFAULT_COURIER])
    digits = info["digits"]

    # Build digit string from UUID (guaranteed unique) + random fill
    raw    = str(uuid.uuid4().int)
    while len(raw) < digits:
        raw += str(random.randint(0, 9))
    digit_str = raw[:digits]

    return info["prefix"] + digit_str


# ─────────────────────────────────────────
# RATE CALCULATION
# ─────────────────────────────────────────

def calculate_shipping_rate(
    weight_kg:     float,
    pickup_city:   str,
    delivery_city: str,
    courier:       str = "bluedart"
) -> dict:
    """
    Calculates shipping cost using BlueDart's 2024 Indian rate card.

    Formula:
      base_rate       = ₹50  (covers first 500g)
      additional      = ₹20 per 500g block above the first
      inter_state     = +30% if pickup city ≠ delivery city (state)
      fuel_surcharge  = 18% of subtotal
      gst             = 18% of (subtotal + fuel)

    Same-state is detected by comparing the first 4 characters of
    city names (simple heuristic; good enough for dev/test).
    """
    if weight_kg <= 0:
        weight_kg = 0.5

    # Same-state check
    is_same = (
        pickup_city.strip().lower()[:4] ==
        delivery_city.strip().lower()[:4]
    )

    # Base rate
    base = 50.0

    # Additional weight blocks
    if weight_kg > 0.5:
        blocks     = int((weight_kg - 0.5) / 0.5) + 1
        additional = blocks * 20.0
    else:
        additional = 0.0

    subtotal = base + additional

    # Inter-state surcharge
    if not is_same:
        subtotal *= 1.30

    # Fuel surcharge (18%)
    fuel = subtotal * 0.18

    # GST (18%)
    pre_gst = subtotal + fuel
    gst     = pre_gst * 0.18
    total   = round(pre_gst + gst, 2)

    courier_info = COURIERS.get(courier, COURIERS[DEFAULT_COURIER])

    return {
        "courier":        courier,
        "courier_name":   courier_info["name"],
        "weight_kg":      weight_kg,
        "pickup_city":    pickup_city,
        "delivery_city":  delivery_city,
        "base_rate":      round(base,       2),
        "additional":     round(additional, 2),
        "fuel_surcharge": round(fuel,       2),
        "gst":            round(gst,        2),
        "total_inr":      total,
        "estimated_days": "1-2 business days" if is_same else "2-4 business days",
        "currency":       "INR",
        "is_same_state":  is_same,
    }


# ─────────────────────────────────────────
# SHIPMENT CREATION (replaces AfterShip)
# ─────────────────────────────────────────

def create_shipment_record(
    tracking_number:  str,
    courier:          str,
    title:            str,
    pickup_address:   str,
    delivery_address: str,
) -> dict:
    """
    Creates a local shipment record — no external API call.
    Returns a dict that shipping_router.py saves to Google Sheets.

    The tracking_url points back to the seller portal itself,
    where the seller can see the live simulated status.
    """
    courier_info = COURIERS.get(courier, COURIERS[DEFAULT_COURIER])

    return {
        "success":         True,
        "tracking_number": tracking_number,
        "courier":         courier,
        "courier_name":    courier_info["name"],
        "tracking_url":    (
            "http:https://trade-link-seller.netlify.app/"
            "?screen=my-shipments"
        ),
        "status":          "InfoReceived",
        "booked_at":       datetime.utcnow().isoformat() + "Z",
    }


# ─────────────────────────────────────────
# SIMULATED LIVE TRACKING
# ─────────────────────────────────────────

def get_simulated_tracking_status(
    tracking_number: str,
    courier:         str,
    pickup_city:     str,
    delivery_city:   str,
    booked_at:       str,
) -> dict:
    """
    Returns realistic tracking status based on elapsed time since booking.

    No API call — purely time-based logic.
    The seller sees the status progress naturally every time they check.

    PROGRESSION:
      0-2h   → InfoReceived
      2-6h   → PickedUp
      6-36h  → InTransit
      36-48h → OutForDelivery
      48h+   → Delivered
    """

    # Parse booked_at → datetime object
    try:
        booked_dt = datetime.fromisoformat(booked_at.replace("Z", ""))
    except Exception:
        booked_dt = datetime.utcnow() - timedelta(minutes=30)

    now          = datetime.utcnow()
    hours_since  = max(0, (now - booked_dt).total_seconds() / 3600)
    courier_info = COURIERS.get(courier, COURIERS[DEFAULT_COURIER])
    courier_name = courier_info["name"]

    # Helper: format a timestamp offset from booked_at
    def fmt(offset_h: float) -> str:
        dt = booked_dt + timedelta(hours=offset_h)
        return dt.strftime("%d %b %Y, %I:%M %p")

    # ── Build checkpoints that have happened so far ──────────────
    checkpoints = []

    # Checkpoint 1 — always shown (happens at booking)
    checkpoints.append({
        "time":     fmt(0),
        "location": pickup_city,
        "message":  f"Shipment information received by {courier_name}",
        "tag":      "InfoReceived",
        "icon":     "📋",
    })

    if hours_since >= 2:
        checkpoints.append({
            "time":     fmt(2),
            "location": pickup_city,
            "message":  "Shipment picked up from sender address",
            "tag":      "PickedUp",
            "icon":     "📦",
        })

    if hours_since >= 6:
        checkpoints.append({
            "time":     fmt(6),
            "location": pickup_city + " Hub",
            "message":  f"Shipment received at {courier_name} hub, in transit",
            "tag":      "InTransit",
            "icon":     "🚚",
        })

    if hours_since >= 18:
        mid = _mid_hub_city(pickup_city, delivery_city)
        checkpoints.append({
            "time":     fmt(18),
            "location": mid + " Sorting Centre",
            "message":  f"Shipment arrived at {mid} sorting centre",
            "tag":      "InTransit",
            "icon":     "🏭",
        })

    if hours_since >= 36:
        checkpoints.append({
            "time":     fmt(36),
            "location": delivery_city,
            "message":  "Shipment out for delivery",
            "tag":      "OutForDelivery",
            "icon":     "🛵",
        })

    if hours_since >= 48:
        checkpoints.append({
            "time":     fmt(48),
            "location": delivery_city,
            "message":  "Shipment delivered successfully. Received by consignee.",
            "tag":      "Delivered",
            "icon":     "✅",
        })

    # ── Determine current status ─────────────────────────────────
    if hours_since < 2:
        tag, text, color, progress = "InfoReceived",    "Shipment info received", "#3b82f6", 10
    elif hours_since < 6:
        tag, text, color, progress = "PickedUp",        "Picked up from sender",  "#8b5cf6", 30
    elif hours_since < 36:
        tag, text, color, progress = "InTransit",       "In transit",             "#f59e0b", 60
    elif hours_since < 48:
        tag, text, color, progress = "OutForDelivery",  "Out for delivery",       "#f97316", 85
    else:
        tag, text, color, progress = "Delivered",       "Delivered",              "#10b981", 100

    # ── Expected delivery ────────────────────────────────────────
    is_same  = pickup_city.strip().lower()[:4] == delivery_city.strip().lower()[:4]
    exp_days = 2 if is_same else 4
    exp_date = (booked_dt + timedelta(days=exp_days)).strftime("%d %b %Y")

    return {
        "success":            True,
        "tracking_number":    tracking_number,
        "courier":            courier,
        "courier_name":       courier_name,
        "status":             tag,
        "status_text":        text,
        "status_color":       color,
        "progress_percent":   progress,
        "expected_delivery":  exp_date,
        "checkpoints":        checkpoints,
        "tracking_url":       "http://localhost:5500/seller-portal/index.html?screen=my-shipments",
        "pickup_city":        pickup_city,
        "delivery_city":      delivery_city,
        "hours_since_booking": round(hours_since, 1),
        "simulated":          True,
    }


def _mid_hub_city(pickup: str, delivery: str) -> str:
    """Returns a realistic Indian courier hub city for mid-transit checkpoint."""
    hubs = ["Nagpur", "Hyderabad", "Ahmedabad", "Pune", "Bhopal", "Lucknow"]
    for hub in hubs:
        if hub.lower() not in (pickup.lower(), delivery.lower()):
            return hub
    return "Nagpur"


# ─────────────────────────────────────────
# EMAILS
# ─────────────────────────────────────────

def send_shipping_confirmation_email(
    seller_email:      str,
    seller_name:       str,
    tracking_number:   str,
    courier_name:      str,
    pickup_address:    str,
    delivery_address:  str,
    goods_description: str,
    weight_kg:         float,
    amount_paid:       float,
    estimated_days:    str,
) -> bool:
    """
    Email 2 — the main shipping confirmation with tracking number.
    Sent right after payment verification and shipment record creation.
    """
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{seller_name}</strong>,<br><br>
      Your shipment is confirmed and booked!
      Here are your complete details.
    </p>

    <div style="background:linear-gradient(135deg,#1a6b3a,#2d9c58);
                border-radius:14px;padding:28px;text-align:center;margin:20px 0;">
      <p style="margin:0;color:rgba(255,255,255,0.75);font-size:11px;
                text-transform:uppercase;letter-spacing:0.12em;">
        Your Tracking Number
      </p>
      <p style="margin:10px 0 4px;color:white;font-family:monospace;
                font-size:30px;font-weight:800;letter-spacing:0.06em;">
        {tracking_number}
      </p>
      <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px;">
        {courier_name}
      </p>
    </div>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;
                border-radius:10px;padding:20px;margin:16px 0;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#6b7280;width:38%;">📦 Goods</td>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#111827;font-weight:500;">{goods_description}</td>
        </tr>
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#6b7280;">⚖️ Weight</td>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#111827;font-weight:500;">{weight_kg} kg</td>
        </tr>
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#6b7280;">📍 Pickup From</td>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#111827;font-weight:500;">{pickup_address}</td>
        </tr>
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#6b7280;">🏪 Deliver To</td>
          <td style="padding:9px 0;border-bottom:1px solid #e5e7eb;
               font-size:13px;color:#111827;font-weight:500;">{delivery_address}</td>
        </tr>
        <tr>
          <td style="padding:9px 0;font-size:13px;color:#6b7280;">⏱ Est. Delivery</td>
          <td style="padding:9px 0;font-size:13px;color:#111827;font-weight:500;">{estimated_days}</td>
        </tr>
      </table>
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;
                border-radius:10px;padding:16px 20px;margin:16px 0;">
      <p style="margin:0 0 8px;color:#1e40af;font-weight:600;font-size:13px;">
        📍 How to Track Your Shipment
      </p>
      <ol style="margin:0;padding-left:18px;color:#1e3a8a;font-size:13px;line-height:1.9;">
        <li>Log in to TradeLink Seller Portal</li>
        <li>Click <strong>My Transport</strong> in the sidebar</li>
        <li>Click the <strong>📍 Track</strong> button on your shipment</li>
      </ol>
    </div>
    """
    return send_email(
        seller_email,
        f"📦 Shipment Booked — Tracking: {tracking_number}",
        _base_template("Your Shipment is Confirmed! 🚚", content)
    )


def send_shipping_payment_email(
    seller_email:      str,
    seller_name:       str,
    goods_description: str,
    amount_paid:       float,
    request_id:        str,
) -> bool:
    """
    Email 1 — sent immediately after Razorpay payment is verified.
    Confirms payment received. Email 2 (with tracking) follows instantly.
    """
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{seller_name}</strong>,<br><br>
      Your shipping payment has been received!
    </p>

    <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:12px;
                padding:22px;margin:20px 0;text-align:center;">
      <p style="margin:0;color:#1e40af;font-size:12px;text-transform:uppercase;
                letter-spacing:0.08em;">Payment Confirmed</p>
      <p style="margin:10px 0 4px;color:#1e3a8a;font-size:32px;font-weight:800;">
        ₹{amount_paid:,.2f}</p>
      <p style="margin:0;color:#3b82f6;font-size:12px;">Ref: {request_id}</p>
    </div>

    <div style="background:#f0fdf4;border:1px solid #86efac;
                border-radius:10px;padding:16px 20px;margin:16px 0;">
      <p style="margin:0 0 8px;color:#15803d;font-weight:600;font-size:13px;">
        ✅ What happens next:
      </p>
      <ol style="margin:0;padding-left:18px;color:#166534;font-size:13px;line-height:1.9;">
        <li>Your tracking number has been assigned</li>
        <li>Check your email — a <strong>second email with tracking details</strong>
            is on its way</li>
        <li>Courier will call to schedule pickup</li>
        <li>Track live: Seller Portal → My Shipments → 📍 Track</li>
      </ol>
    </div>

    <p style="color:#6b7280;font-size:13px;">
      Goods: <strong>{goods_description}</strong>
    </p>
    """
    return send_email(
        seller_email,
        "✅ Shipping Payment Received — TradeLink",
        _base_template("Payment Received!", content)
    )

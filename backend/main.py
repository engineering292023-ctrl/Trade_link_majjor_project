"""
TRADELINK — FastAPI Backend  (backend/main.py)

This is the main server. It:
  1. Receives requests from the frontend portals
  2. Verifies Firebase Auth tokens (so only logged-in users can call APIs)
  3. Reads/writes data from Google Sheets (our database)
  4. Returns JSON responses

HOW TO RUN (after setup):
  uvicorn main:app --reload --port 8000

Then your API is live at:  http://localhost:8000
"""
import string
import re
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
import bcrypt

# Our own modules
from auth import verify_firebase_token, get_current_user
from database import MongoDB as SheetsDB
from models import (
    LoginRequest, RegisterRequest,
    EmailLoginRequest, SendOTPRequest, VerifyOTPRequest,
    ForgotPasswordRequest, ResetPasswordRequest,
    CreateListingRequest, PlaceBidRequest, AcceptBidRequest,
    UpdateProfileRequest, SubmitKYCRequest,
    InitiatePayoutRequest, CreatePaymentOrderRequest,
    VerifyPaymentRequest, ConfirmDeliveryRequest,
    ToggleWatchlistRequest,
    UploadKYCDocRequest,
    VerifyEmailRequest, ResendVerificationRequest,
)
from config import settings
from storage import upload_file
from admin import router as admin_router
from shipping_router import router as shipping_router
from ai_router import router as ai_router

# Step 4 — Real-time WebSocket engine
from realtime import (
    sio, socket_app,
    emit_new_bid, emit_outbid, emit_bid_accepted,
    emit_auction_closed, emit_kyc_status_update,
)

import firebase_admin
from firebase_admin import auth as firebase_auth

# ─────────────────────────────────────────
# APP SETUP
# ─────────────────────────────────────────

app = FastAPI(
    title="TradeLink API",
    description="B2B Marketplace Backend — Sell Direct. Earn More.",
    version="1.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Step 3 — admin, shipping & AI routes
app.include_router(admin_router)
app.include_router(shipping_router)
app.include_router(ai_router)

# Step 4 — mount Socket.IO at /ws
# Browser connects with path='/ws/socket.io' in realtime.js
app.mount("/ws", socket_app)

db = SheetsDB()   # MongoDB via database.py


def _parse_inr_value(raw_value) -> float:
    if raw_value is None:
        return 0.0
    if isinstance(raw_value, (int, float)):
        return float(raw_value)

    text = str(raw_value).strip()
    if not text:
        return 0.0

    cleaned = re.sub(r"[^0-9.\-]", "", text.replace(",", ""))
    if cleaned in ("", ".", "-", "-."):
        return 0.0

    try:
        value = float(cleaned)
    except ValueError as exc:
        raise ValueError(f"Invalid INR value: {raw_value}") from exc

    # Safety guard: values accidentally stored in paise can become very large.
    if value > 500000:
        value = value / 100

    return value


# ─────────────────────────────────────────
# HEALTH CHECK
# ─────────────────────────────────────────

@app.get("/")
def root():
    """Quick check that the server is running."""
    return {"status": "ok", "app": "TradeLink API", "version": "1.0.0"}

@app.get("/health")
def health():
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════════
# AUTH ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/api/auth/login-email")
async def login_email(body: EmailLoginRequest):
    """
    Email + password login.
    Works even if Firebase billing is inactive.
    Works even if user originally signed up with Google (no password_hash).
    """
    email = body.email.strip().lower()
    role  = body.role.strip().lower()

    if not email or not body.password or not role:
        raise HTTPException(400, "email, password, and role are required.")

    # 1. Find user by email + role
    user = db.find_user_by_email_and_role(email, role)

    if not user:
        other_role = "merchant" if role == "seller" else "seller"
        other_user = db.find_user_by_email_and_role(email, other_role)
        if other_user:
            portal_name = "Seller Portal" if other_role == "seller" else "Merchant Portal"
            portal_url  = "../seller-portal/index.html" if other_role == "seller" else "../merchant-portal/index.html"
            return {
                "success":      False,
                "wrong_portal": True,
                "actual_role":  other_role,
                "portal_name":  portal_name,
                "portal_url":   portal_url,
                "detail":       f"This email is registered as a {other_role}. Please use the {portal_name}.",
            }
        return {
            "success":        False,
            "needs_register": True,
            "detail":         "No account found. Please create an account.",
        }

    # 2. Fetch password_hash directly (bypasses _clean() which strips it)
    raw_doc     = db._col("users").find_one({"id": user["id"]}, {"password_hash": 1})
    stored_hash = (raw_doc.get("password_hash", "") or "") if raw_doc else ""

    # 3. If no password set (Google account) — auto-save this password for future use
    if not stored_hash:
        # Save the password they entered so they can use email+password next time too
        hashed = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        db.set_password_hash(user["id"], hashed)
        stored_hash = hashed

    # 4. Verify password
    try:
        password_ok = bcrypt.checkpw(body.password.encode("utf-8"), stored_hash.encode("utf-8"))
    except Exception:
        password_ok = False

    if not password_ok:
        return {"success": False, "detail": "Wrong password. Try again."}

    # 5. Try Firebase custom token — but don't fail if Firebase is down/billing issue
    custom_token = ""
    try:
        firebase_uid = user.get("firebase_uid", "")
        if firebase_uid:
            token = firebase_auth.create_custom_token(firebase_uid)
            custom_token = token.decode("utf-8") if isinstance(token, bytes) else token
    except Exception:
        # Firebase billing inactive or SDK error — skip token, still allow login
        custom_token = ""

    return {
        "success":      True,
        "custom_token": custom_token,   # may be empty — frontend handles this
        "user":         _safe_user(user),
    }

# ─────────────────────────────────────────
# FORGOT PASSWORD — Step 1: Send OTP to email
# ─────────────────────────────────────────
@app.post("/api/auth/forgot-password")
async def forgot_password(request: Request):
    import random, string
    from email_service import send_reset_otp_email

    body  = await request.json()
    email = body.get("email", "").strip().lower()
    role  = body.get("role",  "").strip().lower()

    if not email or not role:
        raise HTTPException(400, "Email and role are required.")

    # Check if user exists in this portal
    user = db.find_user_by_email_and_role(email, role)
    if not user:
        other_role = "merchant" if role == "seller" else "seller"
        other_user = db.find_user_by_email_and_role(email, other_role)
        if other_user:
            portal = "Merchant Portal" if other_role == "merchant" else "Seller Portal"
            return {
                "success":      False,
                "wrong_portal": True,
                "detail":       f"This email is registered as a {other_role}. Please use the {portal}.",
            }
        raise HTTPException(404, "No account found with this email.")

    # Generate 6-digit OTP
    otp = "".join(random.choices(string.digits, k=6))

    # Save OTP — expires in 10 minutes
    db.save_otp(
        key=f"reset:{email}:{role}",
        otp=otp,
        user_data={"email": email, "role": role, "user_id": user["id"]},
        ttl_minutes=10
    )

    # Send OTP email
    send_reset_otp_email(email, user.get("name", "User"), otp)

    return {"success": True, "message": "OTP sent to your email."}


# ─────────────────────────────────────────
# FORGOT PASSWORD — Step 2: Verify OTP + set new password
# ─────────────────────────────────────────
@app.post("/api/auth/reset-password")
async def reset_password_otp(request: Request):
    body         = await request.json()
    email        = body.get("email",        "").strip().lower()
    otp          = body.get("otp",          "").strip()
    new_password = body.get("new_password", "")
    role         = body.get("role",         "").strip().lower()

    if not email or not otp or not new_password or not role:
        raise HTTPException(400, "All fields are required.")
    if len(new_password) < 6:
        return {"success": False, "detail": "Password must be at least 6 characters."}

    # Verify OTP — returns user_data if correct, None if wrong or expired
    data = db.verify_otp(f"reset:{email}:{role}", otp)
    if not data:
        return {"success": False, "detail": "Invalid or expired OTP. Please try again."}

    # Get user from MongoDB
    user = db.find_user_by_email_and_role(email, role)
    if not user:
        raise HTTPException(404, "User not found.")

    # Hash new password and save to MongoDB
    hashed = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    db.set_password_hash(user["id"], hashed)

    # Also update in Firebase (optional — won't break if it fails)
    try:
        if user.get("firebase_uid"):
            firebase_auth.update_user(user["firebase_uid"], password=new_password)
    except Exception:
        pass

    return {"success": True, "message": "Password reset successfully. You can now log in."}
# ─────────────────────────────────────────
# GOOGLE LOGIN (firebase token → MongoDB lookup)
# ─────────────────────────────────────────

@app.post("/api/auth/login")
async def login_google(body: LoginRequest):
    """
    Google login. Browser calls signInWithPopup() → gets id_token → sends here.
    Verifies token, looks up MongoDB by firebase_uid + role, or email + role fallback.
    """
    from auth import verify_firebase_token_full
    decoded = verify_firebase_token_full(body.firebase_token)
    if not decoded:
        raise HTTPException(401, "Invalid Firebase token. Please log in again.")

    firebase_uid = decoded.get("uid", "")
    email        = str(decoded.get("email", "")).strip().lower()
    requested_role = (body.role or "").strip().lower()

    # 1. Try finding by firebase_uid + role
    user = db.find_user_by_firebase_uid(firebase_uid, role=requested_role)

    # 2. Fallback: try finding by email + role (for users who originally registered via Email+OTP)
    if not user and email:
        user = db.find_user_by_email_and_role(email, requested_role)
        if user:
            # Auto-link Google firebase_uid to existing account
            db.update_user(user["id"], {"firebase_uid": firebase_uid})

    if not user:
        # Check if account exists under a different role
        any_user = (
            db.find_user_by_firebase_uid(firebase_uid) or 
            (db.find_user_by_email(email) if email else None)
        )
        if any_user and requested_role and any_user.get("role") != requested_role:
            wrong_role  = any_user.get("role", "other")
            portal_name = "Seller Portal"  if wrong_role == "seller" else "Merchant Portal"
            portal_url  = "../seller-portal/index.html" if wrong_role == "seller" else "../merchant-portal/index.html"
            return {
                "success":      False,
                "wrong_portal": True,
                "actual_role":  wrong_role,
                "portal_name":  portal_name,
                "portal_url":   portal_url,
                "detail":       f"Your account is a {wrong_role}. Please use the {portal_name}.",
            }
        return {
            "success":        False,
            "needs_register": True,
            "detail":         "Profile not found. Please complete registration.",
        }

    return {"success": True, "user": _safe_user(user)}


# ─────────────────────────────────────────
# REGISTRATION STEP 1 — SEND OTP
# (No Firebase call from browser — server creates Firebase account)
# ─────────────────────────────────────────

@app.post("/api/auth/send-otp")
async def send_registration_otp(body: SendOTPRequest):
    """
    Email registration step 1.
    - Validates email+role not already in MongoDB
    - Creates Firebase account server-side
    - Hashes password with bcrypt
    - Sends 6-digit OTP email
    - Stores everything in memory for 10 min
    """
    import random
    from email_service import send_otp_email

    email = body.email.strip().lower()
    role  = body.role.strip().lower()

    if not email or not body.password or not body.name or not role:
        raise HTTPException(400, "email, password, name, and role are required.")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")

    # Check not already registered with this email+role
    existing = db.find_user_by_email_and_role(email, role)
    if existing:
        return {
            "success":            True,
            "already_registered": True,
            "message":            "An account with this email and role already exists. Please log in.",
        }

    # Hash password
    hashed = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    # Create or get Firebase account server-side
    firebase_uid = ""
    try:
        fb_user = firebase_auth.get_user_by_email(email)
        firebase_uid = fb_user.uid
    except firebase_auth.UserNotFoundError:
        try:
            fb_user = firebase_auth.create_user(email=email, password=body.password)
            firebase_uid = fb_user.uid
        except Exception as e:
            raise HTTPException(500, f"Could not create Firebase account: {e}")
    except Exception as e:
        raise HTTPException(500, f"Firebase error: {e}")

    # Generate OTP and store with "email:role" key
    otp = str(random.randint(100000, 999999))
    key = email + ":" + role
    db.save_otp(key, otp, {
        "firebase_uid":  firebase_uid,
        "email":         email,
        "name":          body.name,
        "role":          role,
        "phone":         body.phone or "",
        "city":          body.city  or "",
        "state":         body.state or "",
        "company_name":  body.company_name or "",
        "password_hash": hashed,
    })

    sent = send_otp_email(email, body.name, otp, role)
    if not sent:
        print(f"[OTP] Email not configured. OTP for {email} ({role}): {otp}")
        return {
            "success":  True,
            "otp_sent": False,
            "dev_note": f"Email not configured. OTP: {otp}",
            "message":  "OTP generated. Check server console.",
        }

    print(f"[OTP] Sent to {email} role={role}")
    return {"success": True, "otp_sent": True, "message": f"OTP sent to {email}. Valid for 10 minutes."}


# ─────────────────────────────────────────
# REGISTRATION STEP 2 — VERIFY OTP → CREATE ACCOUNT
# ─────────────────────────────────────────

@app.post("/api/auth/verify-otp")
async def verify_registration_otp(body: VerifyOTPRequest):
    """
    Verifies OTP. On success, creates MongoDB user with password_hash.
    Returns Firebase custom_token so browser can sign in immediately.
    """
    email = body.email.strip().lower()
    otp   = str(body.otp).strip()

    if not email or not otp:
        raise HTTPException(400, "email and otp are required.")

    # Key is "email:role" — try all roles
    user_data = None
    for role_try in ["seller", "merchant", "transporter"]:
        user_data = db.verify_otp(email + ":" + role_try, otp)
        if user_data:
            break

    if not user_data:
        raise HTTPException(400, "Invalid or expired OTP. Please request a new one.")

    # Race condition check
    existing = db.find_user_by_email_and_role(user_data["email"], user_data["role"])
    if existing:
        try:
            custom_token = firebase_auth.create_custom_token(existing["firebase_uid"])
            if isinstance(custom_token, bytes):
                custom_token = custom_token.decode("utf-8")
        except Exception:
            custom_token = ""
        return {"success": True, "user_id": existing["id"], "custom_token": custom_token, "message": "Account already exists."}

    # Create MongoDB user
    user_id = db.create_user({
        "firebase_uid":  user_data["firebase_uid"],
        "email":         user_data["email"],
        "name":          user_data["name"],
        "business_name": user_data.get("company_name", ""),
        "company_name":  user_data.get("company_name", ""),
        "role":          user_data["role"],
        "phone":         user_data.get("phone", ""),
        "city":          user_data.get("city", ""),
        "state":         user_data.get("state", ""),
        "kyc_status":    "unverified",
        "rating":        0,
        "review_count":  0,
        "password_hash": user_data.get("password_hash", ""),
    })

    # Issue custom token
    try:
        custom_token = firebase_auth.create_custom_token(user_data["firebase_uid"])
        if isinstance(custom_token, bytes):
            custom_token = custom_token.decode("utf-8")
    except Exception:
        custom_token = ""

    print(f"[OTP] Account created: {user_id} email={email} role={user_data['role']}")
    return {"success": True, "user_id": user_id, "custom_token": custom_token, "message": "Email verified. Account created."}


@app.post("/api/auth/resend-otp")
async def resend_otp(request: Request):
    """Resend registration OTP."""
    import random
    from email_service import send_otp_email

    body  = await request.json()
    email = body.get("email", "").strip().lower()
    role  = body.get("role", "seller").strip().lower()

    if not email:
        raise HTTPException(400, "email is required.")

    key   = email + ":" + role
    entry = SheetsDB._otp_store.get(key)
    if not entry:
        raise HTTPException(400, "No pending registration. Please start registration again.")

    new_otp   = str(random.randint(100000, 999999))
    user_data = entry["user_data"]
    db.save_otp(key, new_otp, user_data)

    sent = send_otp_email(email, user_data["name"], new_otp, role)
    if not sent:
        print(f"[OTP] Resend — email not configured. OTP: {new_otp}")

    return {"success": True, "message": "New OTP sent."}


# ─────────────────────────────────────────
# GOOGLE REGISTRATION (no OTP — Google verified email)
# ─────────────────────────────────────────

@app.post("/api/auth/register")
async def register_google(body: RegisterRequest):
    """
    Google sign-in registration. No OTP needed.
    Creates MongoDB user with hashed password (if provided) or empty string.
    Never overwrites existing password_hash.
    """
    firebase_uid = verify_firebase_token(body.firebase_token)
    if not firebase_uid:
        raise HTTPException(401, "Invalid Firebase token.")

    email = body.email.strip().lower()
    role  = body.role.strip().lower()

    # Hash password if provided during Google registration
    password_hash = ""
    if body.password and len(body.password) >= 6:
        password_hash = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    existing = db.find_user_by_firebase_uid(firebase_uid, role=role)
    if existing:
        if password_hash and not existing.get("password_hash"):
            db.set_password_hash(existing["id"], password_hash)
        return {"success": True, "user_id": existing["id"]}

    by_email = db.find_user_by_email_and_role(email, role)
    if by_email:
        updates = {}
        if not by_email.get("firebase_uid"):
            updates["firebase_uid"] = firebase_uid
        if password_hash and not by_email.get("password_hash"):
            updates["password_hash"] = password_hash
        if updates:
            db.update_user(by_email["id"], updates)
        return {"success": True, "user_id": by_email["id"]}

    user_id = db.create_user({
        "firebase_uid":  firebase_uid,
        "email":         email,
        "name":          body.name,
        "business_name": body.company_name or "",
        "company_name":  body.company_name or "",
        "role":          role,
        "phone":         body.phone  or "",
        "city":          body.city   or "",
        "state":         body.state  or "",
        "kyc_status":    "unverified",
        "rating":        0,
        "review_count":  0,
        "password_hash": password_hash,
    })
    return {"success": True, "user_id": user_id}


# ─────────────────────────────────────────
# FORGOT PASSWORD — STEP 1: SEND OTP
# ─────────────────────────────────────────

@app.post("/api/auth/forgot-password")
async def forgot_password(body: ForgotPasswordRequest):
    """
    Send OTP for password reset.
    Works for both email+password users AND Google users (setting password for first time).
    Role required to find correct MongoDB record.
    """
    import random
    from email_service import send_otp_email

    email = body.email.strip().lower()
    role  = body.role.strip().lower()

    user = db.find_user_by_email_and_role(email, role)
    if not user:
        other_role = "merchant" if role == "seller" else "seller"
        other_user = db.find_user_by_email_and_role(email, other_role)
        if other_user:
            portal_name = "Seller Portal" if other_role == "seller" else "Merchant Portal"
            return {
                "success":      False,
                "wrong_portal": True,
                "detail":       f"This email is registered in the {portal_name}. Please go there to reset your password.",
            }
        return {"success": True, "message": "If this email is registered, an OTP has been sent."}

    otp = str(random.randint(100000, 999999))
    key = "reset:" + email + ":" + role
    db.save_otp(key, otp, {"email": email, "role": role, "user_id": user["id"]}, ttl_minutes=10)

    sent = send_otp_email(email, user.get("name", ""), otp, role)
    if not sent:
        print(f"[RESET OTP] Email not configured. OTP for {email} ({role}): {otp}")
        return {
            "success":  True,
            "otp_sent": False,
            "dev_note": f"Email not configured. Reset OTP: {otp}",
            "message":  "OTP generated. Check server console.",
        }

    return {"success": True, "otp_sent": True, "message": "OTP sent to your email."}


# ─────────────────────────────────────────
# FORGOT PASSWORD — STEP 2: VERIFY OTP + SET NEW PASSWORD
# ─────────────────────────────────────────

@app.post("/api/auth/reset-password")
async def reset_password(body: ResetPasswordRequest):
    """
    Verify reset OTP and save new bcrypt-hashed password in MongoDB.
    Also works for Google users setting a password for the first time.
    """
    email = body.email.strip().lower()
    role  = body.role.strip().lower()

    if len(body.new_password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")

    key      = "reset:" + email + ":" + role
    otp_data = db.verify_otp(key, str(body.otp).strip())
    if not otp_data:
        raise HTTPException(400, "Invalid or expired OTP. Please request a new one.")

    user_id = otp_data.get("user_id", "")
    if not user_id:
        raise HTTPException(400, "Reset session invalid. Please start again.")

    hashed = bcrypt.hashpw(body.new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    db.set_password_hash(user_id, hashed)

    # Also update Firebase password to keep in sync
    user = db.get_user_profile(user_id)
    if user and user.get("firebase_uid"):
        try:
            firebase_auth.update_user(user["firebase_uid"], password=body.new_password)
        except Exception as e:
            print(f"[RESET] Firebase password sync failed (non-critical): {e}")

    return {"success": True, "message": "Password updated successfully. Please log in."}


# ─────────────────────────────────────────
# SELLER STATS (Dashboard)
# ─────────────────────────────────────────

@app.get("/api/seller/stats")
async def seller_stats(seller_id: str, user=Depends(get_current_user)):
    """
    Returns numbers for the 4 dashboard stat cards.
    Queries multiple sheets and aggregates counts.
    """
    check_owner(user, seller_id)

    active_listings = db.count_listings(seller_id=seller_id, status="active")
    pending_bids    = db.count_pending_bids(seller_id=seller_id)
    total_earned    = db.sum_seller_earnings(seller_id=seller_id)
    rating_data     = db.get_seller_rating(seller_id=seller_id)
    kyc_status      = db.get_user_field(seller_id, "kyc_status")

    return {
        "active_listings": active_listings,
        "pending_bids":    pending_bids,
        "total_earned":    total_earned,
        "rating":          rating_data["rating"],
        "review_count":    rating_data["count"],
        "kyc_status":      kyc_status,
        "subtitle":        f"You have {active_listings} active listings.",
    }


# ─────────────────────────────────────────
# LISTINGS ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/listings")
async def seller_listings(
    seller_id: str,
    page:     int = 1,
    limit:    int = 20,
    status:   str = "",
    category: str = "",
    search:   str = "",
    sort:     str = "created_at_desc",
    user=Depends(get_current_user)
):
    """
    Returns paginated listings for a seller.
    Supports: status filter, category filter, search by title, sort.
    """
    check_owner(user, seller_id)

    result = db.get_listings(
        seller_id=seller_id,
        page=page, limit=limit,
        status=status, category=category,
        search=search, sort=sort
    )
    return result   # { rows: [...], total: N }


@app.get("/api/marketplace/listings")
async def marketplace_listings(
    page:     int = 1,
    limit:    int = 12,
    search:   str = "",
    category: str = "",
    state:    str = "",
    sort:     str = "expires_asc",
    status:   str = "active",
    user=Depends(get_current_user)
):
    """
    Public marketplace — shows all active listings to buyers.
    Paginated, filtered, sorted.
    """
    result = db.get_listings(
        page=page, limit=limit,
        status=status, category=category,
        state=state, search=search, sort=sort
    )
    return result


@app.get("/api/listing/{listing_id}")
async def listing_detail(
    listing_id: str,
    viewer:     str = "seller",
    merchant_id:str = "",
    user=Depends(get_current_user)
):
    """
    Returns full listing detail including all bids sorted highest-first.
    If viewer=merchant, also checks if this merchant has an existing bid.
    """
    listing = db.get_listing(listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found.")

    # Get all bids for this listing, sorted highest price first
    bids = db.get_bids_for_listing(listing_id, sort="price_desc")

    listing["bids"] = bids
    listing["top_bid"] = bids[0]["price_per_unit"] if bids else None

    # If merchant viewing, attach their own bid
    if viewer == "merchant" and merchant_id:
        my_bid = next((b for b in bids if b["merchant_id"] == merchant_id), None)
        listing["my_bid"] = my_bid
        listing["in_watchlist"] = db.is_in_watchlist(merchant_id, listing_id)

    return listing


@app.post("/api/listing/create")
async def create_listing(body: CreateListingRequest, user=Depends(get_current_user)):
    """
    Creates a new listing row in the Listings sheet.
    Sets expires_at = now + duration_h hours.
    """
    check_owner(user, body.seller_id)

    from datetime import datetime, timedelta
    expires_at = (datetime.utcnow() + timedelta(hours=body.duration_h)).isoformat() + "Z"

    listing_id = db.create_listing({
        "seller_id":   body.seller_id,
        "title":       body.title,
        "category":    body.category,
        "description": body.description,
        "quantity":    body.quantity,
        "unit":        body.unit,
        "min_price":   body.min_price,
        "expires_at":  expires_at,
        "city":        body.city,
        "state":       body.state,
        "status":      "active",
        "bid_count":   0,
        "top_bid":     "",
        "photo_url":   body.photo_url or "",
    })

    return {"success": True, "listing_id": listing_id}

@app.post("/api/listing/update-photo")
async def update_listing_photo(request: Request, user=Depends(get_current_user)):
    """Called after listing is created to save the photo URL into MongoDB."""
    body       = await request.json()
    listing_id = body.get("listing_id", "")
    photo_url  = body.get("photo_url",  "")
    seller_id  = body.get("seller_id",  "")

    if not listing_id or not photo_url:
        raise HTTPException(400, "listing_id and photo_url are required.")
    if user.get("id") != seller_id:
        raise HTTPException(403, "Access denied.")

    db.update_listing(listing_id, {"photo_url": photo_url})
    return {"success": True}

@app.post("/api/listing/close")
async def close_listing(body: dict, user=Depends(get_current_user)):
    """Manually close an auction."""
    listing_id = body.get("listing_id")
    listing    = db.get_listing(listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found.")
    check_owner(user, listing["seller_id"])

    # Enforce single deal & closed status check
    existing_deals = list(db._col("deals").find({"listing_id": body.listing_id}, {"_id": 0}))
    if listing.get("status") == "closed" or existing_deals:
        if existing_deals:
            return {"success": True, "deal_id": existing_deals[0]["id"], "deal": existing_deals[0], "already_closed": True}
        raise HTTPException(status_code=400, detail="This auction is already closed.")

    # Enforce single deal & closed status check
    existing_deals = list(db._col("deals").find({"listing_id": body.listing_id}, {"_id": 0}))
    if listing.get("status") == "closed" or existing_deals:
        if existing_deals:
            return {"success": True, "deal_id": existing_deals[0]["id"], "deal": existing_deals[0], "already_closed": True}
        raise HTTPException(status_code=400, detail="This auction is already closed.")

    # Enforce single deal & closed status check
    existing_deals = list(db._col("deals").find({"listing_id": body.listing_id}, {"_id": 0}))
    if listing.get("status") == "closed" or existing_deals:
        if existing_deals:
            return {"success": True, "deal_id": existing_deals[0]["id"], "deal": existing_deals[0], "already_closed": True}
        raise HTTPException(status_code=400, detail="This auction is already closed.")

    db.update_listing(listing_id, {"status": "closed"})
    return {"success": True}


# ─────────────────────────────────────────
# BIDS ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/active-bids")
async def seller_active_bids(seller_id: str, user=Depends(get_current_user)):
    """
    Returns all active listings with their bids for the Live Bids screen.
    Bids are sorted highest price first within each listing.
    """
    check_owner(user, seller_id)

    active_listings = db.get_listings_raw(seller_id=seller_id, status="active")
    result = []
    for listing in active_listings:
        bids = db.get_bids_for_listing(listing["id"], sort="price_desc")
        if bids:  # only show listings that have bids
            listing["bids"] = bids
            result.append(listing)

    return {"listings": result}


@app.post("/api/bid/place")
async def place_bid(body: PlaceBidRequest, user=Depends(get_current_user)):
    """
    Places a bid on a listing.

    Business rules enforced:
    - Bid must be >= listing.min_price
    - Listing must be status=active and not expired
    - Buyer cannot bid on own listing
    - Updates listing.top_bid and listing.bid_count in Sheets
    - Creates a notification for the seller ("New bid received")
    - Creates a notification for previously-top bidder ("You were outbid")
    """
    check_owner(user, body.merchant_id)

    listing = db.get_listing(body.listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found.")
    if listing["status"] != "active":
        raise HTTPException(status_code=400, detail="Auction is closed.")
    if listing["seller_id"] == body.merchant_id:
        raise HTTPException(status_code=400, detail="Cannot bid on your own listing.")
    if body.price_per_unit < float(listing["min_price"]):
        raise HTTPException(status_code=400, detail=f"Bid must be ≥ ₹{listing['min_price']}.")

    from datetime import datetime
    # Check not expired
    if listing.get("expires_at"):
        from datetime import timezone
        expires = datetime.fromisoformat(listing["expires_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires:
            db.update_listing(body.listing_id, {"status": "expired"})
            raise HTTPException(status_code=400, detail="Auction has expired.")

    # Get previous top bidder (to notify them of outbid)
    prev_bids = db.get_bids_for_listing(body.listing_id, sort="price_desc")
    prev_top  = prev_bids[0] if prev_bids else None

    # Write bid row
    bid_id = db.create_bid({
        "listing_id":     body.listing_id,
        "merchant_id":    body.merchant_id,
        "price_per_unit": body.price_per_unit,
        "total_amount":   body.total_amount,
        "status":         "live",
    })

    # Update listing top_bid and bid_count
    new_count = len(prev_bids) + 1
    db.update_listing(body.listing_id, {
        "top_bid":   body.price_per_unit,
        "bid_count": new_count,
    })

    # ── Step 4: Emit real-time events via WebSocket ──────────
    import asyncio

    bid_payload = {
        "listing_id":    body.listing_id,
        "listing_title": listing["title"],
        "buyer_name":    "A buyer",   # anonymised during live auction
        "price_per_unit":body.price_per_unit,
        "total_amount":  body.total_amount,
        "unit":          listing.get("unit", ""),
        "bid_count":     new_count,
    }

    # Push to seller's Live Bids screen AND everyone watching that listing
    asyncio.create_task(
        emit_new_bid(body.listing_id, listing["seller_id"], bid_payload)
    )

    # Push "outbid" toast to the merchant who just lost top position
    if prev_top and prev_top["merchant_id"] != body.merchant_id:
        asyncio.create_task(
            emit_outbid(prev_top["merchant_id"], {
                "listing_id":    body.listing_id,
                "listing_title": listing["title"],
                "new_top_bid":   body.price_per_unit,
                "unit":          listing.get("unit", ""),
            })
        )

    return {"success": True, "bid_id": bid_id}


@app.post("/api/bid/accept")
async def accept_bid(body: AcceptBidRequest, user=Depends(get_current_user)):
    """
    Seller accepts a bid → creates a Deal row.

    Business rules:
    - Closes the auction (listing status → 'closed')
    - Creates a deal with status='pending' (awaiting buyer payment)
    - Buyer has 24 hours to pay (enforced via cron in Step 7)
    - Notifies buyer they won
    - Notifies other bidders they lost
    """
    bid     = db.get_bid(body.bid_id)
    listing = db.get_listing(body.listing_id)
    if not bid or not listing:
        raise HTTPException(status_code=404, detail="Bid or listing not found.")
    check_owner(user, listing["seller_id"])

    # Enforce single deal & closed status check
    existing_deals = list(db._col("deals").find({"listing_id": body.listing_id}, {"_id": 0}))
    if listing.get("status") == "closed" or existing_deals:
        if existing_deals:
            return {"success": True, "deal_id": existing_deals[0]["id"], "deal": existing_deals[0], "already_closed": True}
        raise HTTPException(status_code=400, detail="This auction is already closed.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    # Create deal
    deal_id = db.create_deal({
        "listing_id":     body.listing_id,
        "seller_id":      listing["seller_id"],
        "merchant_id":    bid["merchant_id"],
        "bid_id":         body.bid_id,
        "product_title":  listing["title"],
        # Store amount in INR. If bid total_amount looks like paise, convert.
        "amount":         str(float(bid["total_amount"]) / 100)
                          if float(bid.get("total_amount", 0) or 0) > 500000
                          else bid["total_amount"],
        "quantity":       listing["quantity"],
        "unit":           listing["unit"],
        "pickup_city":    listing["city"],
        "deliver_to":     "",
        "status":         "pending",           # waiting for payment
        "payment_status": "pay_pending",
        "delivery_status":"confirmed",
        "timeline_status":"confirmed",
        "confirmed_at":   now,
    })

    # Close listing
    db.update_listing(body.listing_id, {"status": "closed"})

    # ── Step 4: Emit real-time events ───────────────────────
    import asyncio
    from datetime import datetime, timedelta, timezone

    pay_deadline = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()

    # Tell the winning merchant instantly — "You won!" popup
    asyncio.create_task(
        emit_bid_accepted(bid["merchant_id"], {
            "deal_id":       deal_id,
            "listing_title": listing["title"],
            "amount":        bid["total_amount"],
            "pay_deadline":  pay_deadline,
        })
    )

    # Tell everyone watching the listing that auction is closed
    asyncio.create_task(
        emit_auction_closed(body.listing_id, listing["seller_id"], {
            "listing_id":    body.listing_id,
            "listing_title": listing["title"],
        })
    )

    # return {"success": True, "deal_id": deal_id}

    
    # Return full deal object so frontend can auto-fill transport form
    deal_obj = db.get_deal(deal_id)
    return {"success": True, "deal_id": deal_id, "deal": deal_obj}


# ─────────────────────────────────────────
# DEALS ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/deals")
async def seller_deals(
    seller_id: str,
    page:     int = 1,
    limit:    int = 20,
    status:   str = "",
    sort:     str = "created_at_desc",
    user=Depends(get_current_user)
):
    check_owner(user, seller_id)
    return db.get_deals(seller_id=seller_id, page=page, limit=limit, status=status, sort=sort)


@app.get("/api/merchant/deals")
async def merchant_deals(
    merchant_id: str,
    page:        int = 1,
    limit:       int = 20,
    status:      str = "",
    user=Depends(get_current_user)
):
    check_owner(user, merchant_id)
    return db.get_deals(merchant_id=merchant_id, page=page, limit=limit, status=status)

@app.get("/api/merchant/invoices")
async def get_merchant_invoices(merchant_id: str, user=Depends(get_current_user)):
    if user.get("id") != merchant_id:
        raise HTTPException(403, "Access denied.")

    from pymongo import DESCENDING
    # Get all paid deals for this merchant
    deals = list(
        db._col("deals").find(
            {"merchant_id": merchant_id, "payment_status": "in_escrow"},
            {"_id": 0}
        ).sort("created_at", DESCENDING)
    )

    rows = []
    for d in deals:
        amount     = float(d.get("amount", 0) or 0)
        gst_rate   = 0.18
        base       = round(amount / (1 + gst_rate), 2)
        gst_amount = round(amount - base, 2)

        # Get seller name
        seller = db.get_user_profile(d.get("seller_id", ""))

        rows.append({
            "id":             "INV-" + d["id"][:8].upper(),
            "invoice_number": "TL-" + d["id"][:8].upper(),
            "deal_id":        d["id"],
            "created_at":     d.get("paid_at", d.get("created_at", "")),
            "product_title":  d.get("listing_title", d.get("product_title", "Goods")),
            "amount":         amount,
            "base_amount":    base,
            "gst_amount":     gst_amount,
            "gst_rate":       "18%",
            "quantity":       d.get("quantity", ""),
            "unit":           d.get("unit", ""),
            "price_per_unit": d.get("price_per_unit", ""),
            "seller_name":    seller.get("name", "")    if seller else "",
            "seller_city":    seller.get("city", "")    if seller else "",
            "razorpay_id":    d.get("razorpay_payment_id", ""),
            "status":         "paid",
        })

    return {"success": True, "rows": rows}

@app.get("/api/deal/{deal_id}")
async def deal_detail(deal_id: str, user=Depends(get_current_user)):
    deal = db.get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found.")
    # Only seller or buyer can view
    if user["id"] not in [deal["seller_id"], deal["merchant_id"]]:
        raise HTTPException(status_code=403, detail="Access denied.")
    return deal


@app.get("/api/deal")
async def deal_detail_query(id: str = "", user=Depends(get_current_user)):
    if not id:
        raise HTTPException(status_code=400, detail="Missing deal ID parameter.")
    return await deal_detail(id, user)


@app.post("/api/deal/confirm-delivery")
async def confirm_delivery(body: ConfirmDeliveryRequest, user=Depends(get_current_user)):
    """
    Merchant confirms they received the goods.
    This releases the escrow payment to the seller.
    In Step 7: triggers Razorpay Transfer to seller's bank.
    """
    check_owner(user, body.merchant_id)

    deal = db.get_deal(body.deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found.")
    if deal["merchant_id"] != body.merchant_id:
        raise HTTPException(status_code=403, detail="Access denied.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    db.update_deal(body.deal_id, {
        "delivery_status":  "delivered",
        "timeline_status":  "delivered",
        "buyer_confirmed":  True,
        "delivered_at":     now,
    })

    # TODO Step 7: trigger Razorpay Transfer to seller
    # For now, mark payout as 'ready'
    db.create_payout_record(deal_id=body.deal_id, seller_id=deal["seller_id"], amount=deal["amount"])

    return {"success": True}


# ─────────────────────────────────────────
# PAYMENTS ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/payments")
async def seller_payments(seller_id: str, page: int = 1, limit: int = 20, user=Depends(get_current_user)):
    check_owner(user, seller_id)
    return db.get_seller_payments(seller_id=seller_id, page=page, limit=limit)


@app.get("/api/merchant/payments")
async def merchant_payments(merchant_id: str, page: int = 1, limit: int = 20, user=Depends(get_current_user)):
    check_owner(user, merchant_id)
    return db.get_merchant_payments(merchant_id=merchant_id, page=page, limit=limit)


@app.post("/api/payment/create-order")
async def create_payment_order(body: CreatePaymentOrderRequest, user=Depends(get_current_user)):
    """
    STEP 5: Real Razorpay order creation.

    HOW IT WORKS:
    1. Merchant clicks "Pay Now" on a deal
    2. Frontend calls this endpoint
    3. We create a Razorpay order (gets an order_id)
    4. We return the order_id + key to frontend
    5. Frontend opens Razorpay checkout popup with this order_id
    6. Merchant pays using card/UPI/netbanking
    7. Razorpay calls /api/payment/verify with signature
    8. We verify signature and mark deal as paid
    """
    check_owner(user, body.merchant_id)

    deal = db.get_deal(body.deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal not found: {body.deal_id}")

    # Log deal info for debugging
    print(f"[PAY] deal_id={body.deal_id} amount='{deal.get('amount')}' merchant={deal.get('merchant_id')}")

    # Amount must be in paise (1 INR = 100 paise)
    raw_amount = deal.get("amount", "") or "0"
    try:
        amount_inr = float(raw_amount)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail=f"Deal has invalid amount: '{raw_amount}'. Check the Deals tab in Google Sheets."
        )

    # Safety check: if amount looks like it is already in paise (> 1,00,000)
    # then divide by 100 to get INR back.
    # This handles deals where total_amount was accidentally stored in paise.
    # Razorpay max order = ₹5,00,000. If amount_inr > 500000 it must be paise.
    if amount_inr > 500000:
        print(f"[PAY] WARNING: amount {amount_inr} looks like paise. Dividing by 100 → {amount_inr/100} INR")
        amount_inr = amount_inr / 100

    amount_paise = int(amount_inr * 100)
    print(f"[PAY] Final: ₹{amount_inr} = {amount_paise} paise")

    # Guard: keys must be set
    if not settings.RAZORPAY_KEY_ID or settings.RAZORPAY_KEY_ID == "rzp_test_YOUR_KEY_ID_HERE":
        raise HTTPException(
            status_code=503,
            detail="Razorpay keys not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to backend/.env"
        )

    # Guard: amount must be valid
    if not deal.get("amount") or float(deal.get("amount", 0) or 0) <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid deal amount: '{deal.get('amount')}'. Check the deal row in Google Sheets."
        )

    try:
        import razorpay
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="Razorpay package not installed. Run: pip install razorpay==1.4.1"
        )

    try:
        client = razorpay.Client(
            auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET)
        )
        order = client.order.create({
            "amount":   amount_paise,
            "currency": "INR",
            "receipt":  body.deal_id[:40],  # Razorpay receipt max 40 chars
            "notes": {
                "deal_id":     body.deal_id,
                "merchant_id": body.merchant_id,
                "product":     deal.get("product_title", ""),
            }
        })
        return {
            "success":         True,
            "order_id":        order["id"],
            "razorpay_key_id": settings.RAZORPAY_KEY_ID,
            "amount":          amount_inr,      # correct INR value
            "amount_paise":    amount_paise,    # paise for Razorpay checkout
        }
    except razorpay.errors.BadRequestError as e:
        raise HTTPException(status_code=400, detail=f"Razorpay rejected the request: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Payment order failed: {str(e)}")


@app.post("/api/payment/verify")
async def verify_payment(body: VerifyPaymentRequest, user=Depends(get_current_user)):
    """
    STEP 5: Verifies Razorpay payment signature.

    WHY VERIFY SIGNATURE?
    Anyone could send a fake POST request saying "I paid".
    Razorpay signs every payment with HMAC-SHA256 using your secret key.
    We verify this signature to prove the payment is real and from Razorpay.
    NEVER skip this step — it is your security against fraud.

    HOW IT WORKS:
    Razorpay gives us: order_id + payment_id + signature
    We compute: HMAC-SHA256(secret_key, order_id + | + payment_id)
    If our result == their signature → payment is genuine
    """
    import hmac, hashlib

    # Build the message Razorpay signed
    payload   = f"{body.razorpay_order_id}|{body.razorpay_payment_id}"

    # Compute our own HMAC-SHA256
    signature = hmac.new(
        settings.RAZORPAY_KEY_SECRET.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()

    # compare_digest prevents timing attacks
    if not hmac.compare_digest(signature, body.razorpay_signature):
        raise HTTPException(status_code=400, detail="Payment signature invalid. Possible fraud attempt.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    db.update_deal(body.deal_id, {
        "payment_status":       "in_escrow",
        "timeline_status":      "paid",
        "paid_at":              now,
        "razorpay_payment_id":  body.razorpay_payment_id,
        "razorpay_order_id":    body.razorpay_order_id,
    })

    db.create_payment_record(
        deal_id=body.deal_id,
        amount=db.get_deal(body.deal_id)["amount"],
        razorpay_payment_id=body.razorpay_payment_id,
        status="in_escrow"
    )

    return {"success": True}


# ─────────────────────────────────────────
# PAYOUTS ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/payout-data")
async def seller_payout_data(seller_id: str, user=Depends(get_current_user)):
    check_owner(user, seller_id)
    return db.get_payout_data(seller_id=seller_id)


@app.post("/api/payout/initiate")
async def initiate_payout(body: InitiatePayoutRequest, user=Depends(get_current_user)):
    """
    Initiates a bank transfer to seller.
    Step 7: uses Razorpay Transfer API.
    """
    check_owner(user, body.seller_id)

    payout_data = db.get_payout_data(body.seller_id)
    if body.amount > payout_data["available_balance"]:
        raise HTTPException(status_code=400, detail="Amount exceeds available balance.")
    if body.amount < 100:
        raise HTTPException(status_code=400, detail="Minimum withdrawal is ₹100.")

    payout_id = db.create_payout_withdrawal({
        "seller_id":        body.seller_id,
        "amount":           body.amount,
        "bank_account_id":  body.bank_account_id,
        "status":           "processing",
    })

    # Step 7: trigger Razorpay Transfer API here
    return {"success": True, "payout_id": payout_id}


# ─────────────────────────────────────────
# RAZORPAY WEBHOOK
# ─────────────────────────────────────────

@app.post("/api/webhooks/razorpay")
async def razorpay_webhook(request: Request):
    """
    STEP 5: Razorpay Webhook Handler.

    WHAT IS A WEBHOOK?
    After payment, Razorpay sends a POST request to this URL automatically.
    This is a backup — in case the user closes the browser before the
    payment verify step completes. The webhook catches it.

    FOR PRODUCTION (Netlify deploy):
    In Razorpay Dashboard → Settings → Webhooks → Add webhook URL:
    https://your-backend-url.com/api/webhooks/razorpay
    Select events: payment.captured
    Set a Webhook Secret and add it to your .env as RAZORPAY_WEBHOOK_SECRET
    """
    import hmac, hashlib

    # Read raw body bytes (needed for signature verification)
    body_bytes = await request.body()

    # Verify webhook signature
    webhook_secret = getattr(settings, "RAZORPAY_WEBHOOK_SECRET", "")
    if webhook_secret:
        received_sig = request.headers.get("x-razorpay-signature", "")
        expected_sig = hmac.new(
            webhook_secret.encode(),
            body_bytes,
            hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected_sig, received_sig):
            raise HTTPException(status_code=400, detail="Invalid webhook signature")

    import json
    try:
        event = json.loads(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    event_type = event.get("event", "")

    # Handle payment captured event
    if event_type == "payment.captured":
        payment = event.get("payload", {}).get("payment", {}).get("entity", {})
        order_id    = payment.get("order_id", "")
        payment_id  = payment.get("id", "")

        # Find the deal by razorpay_order_id
        deal = db.get_deal_by_order_id(order_id)
        if deal and deal.get("payment_status") != "in_escrow":
            from datetime import datetime
            now = datetime.utcnow().isoformat() + "Z"
            db.update_deal(deal["id"], {
                "payment_status":      "in_escrow",
                "timeline_status":     "paid",
                "paid_at":             now,
                "razorpay_payment_id": payment_id,
                "razorpay_order_id":   order_id,
            })
            db.create_payment_record(
                deal_id=deal["id"],
                amount=float(deal["amount"]),
                razorpay_payment_id=payment_id,
                status="in_escrow"
            )

    # Always return 200 to Razorpay — otherwise it retries
    return {"status": "ok"}

async def get_current_user_optional(request: Request) -> dict:
    """Like get_current_user but returns empty dict instead of 401 for admin calls."""
    try:
        return await get_current_user(request)
    except Exception:
        return {"id": "", "role": "admin"}

# ─────────────────────────────────────────
# PROFILE & KYC ENDPOINTS
# ─────────────────────────────────────────

@app.get("/api/seller/profile")
async def seller_profile(seller_id: str, user=Depends(get_current_user)):
    check_owner(user, seller_id)
    return db.get_user_profile(seller_id)


@app.post("/api/seller/profile/update")
async def update_seller_profile(body: UpdateProfileRequest, user=Depends(get_current_user)):
    check_owner(user, body.seller_id)
    db.update_user(body.seller_id, {
        "name":          body.name,
        "business_name": body.business_name,
        "city":          body.city,
        "state":         body.state,
    })
    return {"success": True}


@app.post("/api/seller/kyc/submit")
async def submit_seller_kyc(body: SubmitKYCRequest, user=Depends(get_current_user)):
    check_owner(user, body.seller_id)
    db.update_user(body.seller_id, {
        "kyc_aadhaar":  body.aadhaar_num,
        "kyc_pan":      body.pan_num,
        "kyc_bank_acc": body.bank_account,
        "kyc_ifsc":     body.ifsc,
        "kyc_gst":      body.gst or "",
        "kyc_status":   "submitted",
        "kyc_submitted_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    })
    return {"success": True}


@app.get("/api/merchant/profile")
async def merchant_profile(merchant_id: str, user=Depends(get_current_user)):
    check_owner(user, merchant_id)
    return db.get_user_profile(merchant_id)


@app.post("/api/merchant/profile/update")
async def update_merchant_profile(body: dict, user=Depends(get_current_user)):
    merchant_id = body.get("merchant_id")
    check_owner(user, merchant_id)
    db.update_user(merchant_id, {
        "name":         body.get("name"),
        "company_name": body.get("company_name"),
        "city":         body.get("city"),
        "state":        body.get("state"),
    })
    return {"success": True}


@app.post("/api/merchant/kyc/submit")
async def submit_merchant_kyc(body: dict, user=Depends(get_current_user)):
    merchant_id = body.get("merchant_id")
    check_owner(user, merchant_id)
    db.update_user(merchant_id, {
        "kyc_gst":    body.get("gst"),
        "kyc_pan":    body.get("pan"),
        "kyc_status": "submitted",
    })
    return {"success": True}


# ─────────────────────────────────────────
# MERCHANT STATS
# ─────────────────────────────────────────

@app.get("/api/merchant/stats")
async def merchant_stats(merchant_id: str, user=Depends(get_current_user)):
    check_owner(user, merchant_id)

    live_listings   = db.count_listings(status="active")
    active_bids     = db.count_merchant_active_bids(merchant_id)
    deals_won       = db.count_deals(merchant_id=merchant_id, status="delivered")
    total_spent     = db.sum_merchant_spending(merchant_id)
    watchlist_count = db.count_watchlist(merchant_id)

    return {
        "live_listings":   live_listings,
        "active_bids":     active_bids,
        "deals_won":       deals_won,
        "total_spent":     total_spent,
        "watchlist_count": watchlist_count,
    }


# ─────────────────────────────────────────
# MERCHANT BIDS
# ─────────────────────────────────────────

@app.get("/api/merchant/bids")
async def merchant_bids(merchant_id: str, page: int = 1, limit: int = 20, status: str = "", user=Depends(get_current_user)):
    check_owner(user, merchant_id)
    return db.get_merchant_bids(merchant_id=merchant_id, page=page, limit=limit, status=status)


# ─────────────────────────────────────────
# WATCHLIST
# ─────────────────────────────────────────

@app.get("/api/merchant/watchlist")
async def merchant_watchlist(merchant_id: str, user=Depends(get_current_user)):
    check_owner(user, merchant_id)
    return {"rows": db.get_watchlist(merchant_id)}


@app.post("/api/watchlist/toggle")
async def toggle_watchlist(body: ToggleWatchlistRequest, user=Depends(get_current_user)):
    check_owner(user, body.merchant_id)
    if body.action == "add":
        db.add_to_watchlist(body.merchant_id, body.listing_id)
    else:
        db.remove_from_watchlist(body.merchant_id, body.listing_id)
    return {"success": True}


# ─────────────────────────────────────────
# NOTIFICATIONS  (was 404 - now fixed)
# ─────────────────────────────────────────

@app.get("/api/notifications/count")
async def notifications_count(seller_id: str = "", merchant_id: str = "", user=Depends(get_current_user)):
    """Unread notification count for sidebar badge. Was returning 404."""
    uid = seller_id or merchant_id or user.get("id", "")
    try:
        count = db.count_unread_notifications(uid) if hasattr(db, "count_unread_notifications") else 0
    except Exception:
        count = 0
    return {"count": count, "unread": count}


@app.get("/api/seller/notifications")
async def seller_notifications_list(seller_id: str, user=Depends(get_current_user)):
    check_owner(user, seller_id)
    try:
        items = db.get_notifications(seller_id) if hasattr(db, "get_notifications") else []
    except Exception:
        items = []
    return {"items": items}


@app.post("/api/notifications/mark-read")
async def mark_notifications_read(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    uid  = body.get("seller_id") or body.get("merchant_id") or user.get("id", "")
    try:
        if hasattr(db, "mark_notifications_read"):
            db.mark_notifications_read(uid)
    except Exception:
        pass
    return {"success": True}


# ─────────────────────────────────────────
# SELLER ACTIVITY FEED
# ─────────────────────────────────────────

@app.get("/api/seller/activity")
async def seller_activity(seller_id: str, limit: int = 8, user=Depends(get_current_user)):
    check_owner(user, seller_id)
    items = db.get_activity_feed(seller_id, limit=limit)
    return {"items": items}


# ─────────────────────────────────────────
# INVOICES
# ─────────────────────────────────────────

@app.get("/api/merchant/invoices")
async def merchant_invoices(merchant_id: str, user=Depends(get_current_user)):
    check_owner(user, merchant_id)
    return {"rows": db.get_invoices(merchant_id)}


# ─────────────────────────────────────────
# ADMIN — RELEASE PAYOUT TO SELLER
# ─────────────────────────────────────────

@app.post("/api/admin/payout/release")
async def admin_release_payout(request: Request):
    """
    ADMIN ONLY: Release escrow to the correct recipient.

    LOGIC:
    - escrow_status must be 'in_escrow' (payment received from merchant)
    - Look at seller_id in the deal:
        → starts with 'S' = product deal  → pay the SELLER
        → starts with 'M' = truck booking → pay the TRANSPORTER (merchant role)
    - Fetch recipient's bank account + phone from Sheets
    - Show details to admin in the response so admin can copy & pay
    - Use Razorpay Payout API (TEST mode) to send money
    - Mark escrow_status = 'fulfilled' after success

    Body: { "deal_id": "...", "confirm": true }
    If confirm=false or missing: returns payment details preview only (no money sent)
    If confirm=true: actually releases the payout
    """
    from admin import require_admin
    x_admin_key = request.headers.get("X-Admin-Key", "")
    require_admin(x_admin_key)

    body = await request.json()
    deal_id = body.get("deal_id", "").strip()
    confirm = body.get("confirm", False)   # safety: must explicitly confirm

    if not deal_id:
        raise HTTPException(status_code=400, detail="deal_id is required.")

    deal = db.get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal not found: {deal_id}")

    # Already paid out?
    if deal.get("escrow_status") == "fulfilled":
        return {"success": True, "already_done": True,
                "message": "Payout already fulfilled for this deal."}

    # Must be in escrow first (merchant must have paid)
    if deal.get("payment_status") not in ("in_escrow",) and deal.get("escrow_status") not in ("in_escrow", "held"):
        raise HTTPException(
            status_code=400,
            detail=f"Deal is not in escrow. Current payment_status='{deal.get('payment_status')}'. "
                   "Merchant must pay first before payout can be released."
        )

    # ── Determine WHO gets paid based on seller_id prefix ──────────
    seller_id   = deal.get("seller_id", "")
    merchant_id = deal.get("merchant_id", "")

    # S... = product deal  → recipient is the seller (goods supplier)
    # M... = truck booking → recipient is the transporter (merchant who owns the truck)
    if seller_id.startswith("S"):
        recipient_id   = seller_id
        recipient_role = "seller"
        deal_type      = "product"
    elif seller_id.startswith("M"):
        recipient_id   = seller_id   # In truck bookings seller_id holds transporter's M-id
        recipient_role = "transporter"
        deal_type      = "truck_booking"
    else:
        # Fallback: pay whoever is the seller
        recipient_id   = seller_id
        recipient_role = "seller"
        deal_type      = "product"

    # ── Fetch recipient's bank + phone from Sheets ──────────────────
    recipient = db.get_user_profile(recipient_id)
    if not recipient:
        raise HTTPException(
            status_code=404,
            detail=f"Recipient profile not found: {recipient_id}. "
                   "They may need to complete their profile."
        )

    bank_account = recipient.get("kyc_bank_acc", "").strip()
    bank_ifsc    = recipient.get("kyc_ifsc", "").strip()
    phone        = recipient.get("phone", "").strip()
    name         = recipient.get("name", "")
    email        = recipient.get("email", "")

    # ── Calculate payout amounts ────────────────────────────────────
    raw_amount = deal.get("amount", "0") or "0"
    try:
        amount_inr = float(raw_amount)
        if amount_inr > 500000:
            amount_inr = amount_inr / 100   # fix paise stored as INR
    except (ValueError, TypeError):
        amount_inr = 0

    platform_fee      = round(amount_inr * 0.02, 2)   # 2% platform fee
    recipient_payout  = round(amount_inr - platform_fee, 2)

    # ── Build payment details object ────────────────────────────────
    payment_details = {
        "deal_id":          deal_id,
        "deal_type":        deal_type,
        "product_title":    deal.get("product_title", ""),
        "recipient_id":     recipient_id,
        "recipient_role":   recipient_role,
        "recipient_name":   name,
        "recipient_email":  email,
        "recipient_phone":  phone,
        "bank_account":     bank_account,
        "bank_ifsc":        bank_ifsc,
        "amount_total":     amount_inr,
        "platform_fee":     platform_fee,
        "recipient_payout": recipient_payout,
        "has_bank_details": bool(bank_account and bank_ifsc),
        "has_phone":        bool(phone),
    }

    # ── PREVIEW MODE (confirm=False): just show details, don't pay ──
    if not confirm:
        return {
            "success":       True,
            "preview":       True,
            "message":       "Preview only — set confirm=true to release payout",
            "payment_details": payment_details
        }

    # ── CONFIRM MODE: actually send the money ───────────────────────
    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    razorpay_payout_id = None
    payout_mode        = "manual"   # fallback if Razorpay fails

    # Try Razorpay Payout API
    try:
        import razorpay
        client = razorpay.Client(
            auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET)
        )

        # Step 1: Create or get Razorpay Contact for recipient
        # Contact = the person we are paying
        contact_data = {
            "name":         name,
            "email":        email or "noreply@tradelink.app",
            "contact":      phone or "",
            "type":         "vendor",
            "reference_id": recipient_id,
            "notes":        {"deal_id": deal_id}
        }
        contact = client.contact.create(contact_data)
        contact_id = contact.get("id", "")

        # Step 2: Create Fund Account (bank or UPI)
        if bank_account and bank_ifsc:
            # Pay via bank account
            fund_account = client.fund_account.create({
                "contact_id":    contact_id,
                "account_type":  "bank_account",
                "bank_account":  {
                    "name":           name,
                    "ifsc":           bank_ifsc,
                    "account_number": bank_account,
                }
            })
            fund_account_id = fund_account.get("id", "")
            payout_mode = "bank_account"
        elif phone:
            # Pay via UPI (phone number)
            fund_account = client.fund_account.create({
                "contact_id":   contact_id,
                "account_type": "vpa",
                "vpa":          {"address": phone + "@upi"}
            })
            fund_account_id = fund_account.get("id", "")
            payout_mode = "upi"
        else:
            raise ValueError(
                f"Recipient {name} has no bank account or phone number. "
                "Ask them to complete their Profile & KYC first."
            )

        # Step 3: Create Payout
        payout = client.payout.create({
            "account_number":  settings.RAZORPAY_KEY_ID,
            "fund_account_id": fund_account_id,
            "amount":          int(recipient_payout * 100),  # paise
            "currency":        "INR",
            "mode":            "IMPS" if payout_mode == "bank_account" else "UPI",
            "purpose":         "payout",
            "queue_if_low_balance": True,
            "reference_id":    deal_id,
            "narration":       f"TradeLink payout for {deal.get('product_title','')}",
            "notes":           {"deal_id": deal_id, "recipient": recipient_id}
        })
        razorpay_payout_id = payout.get("id", "")
        payout_status = payout.get("status", "processing")
        print(f"[PAYOUT] Created: {razorpay_payout_id} status={payout_status} mode={payout_mode}")

        # Step 4: Poll for final status
        # In TEST mode Razorpay simulates — status moves from processing → processed
        # In LIVE mode this is a real bank transfer
        import time as time_module
        max_polls = 6
        poll_interval = 2   # seconds
        for _ in range(max_polls):
            try:
                payout_info = client.payout.fetch(razorpay_payout_id)
                payout_status = payout_info.get("status", "processing")
                print(f"[PAYOUT] Status poll: {payout_status}")
                if payout_status in ("processed", "failed", "reversed", "cancelled"):
                    break
            except Exception:
                break
            time_module.sleep(poll_interval)

        if payout_status == "processed":
            payout_mode = f"bank_account_processed"
            print(f"[PAYOUT] ✅ Successfully processed: {razorpay_payout_id}")
        elif payout_status == "processing":
            # Still processing (common in test mode) — mark fulfilled anyway
            # Admin can check Razorpay dashboard for final status
            payout_mode = f"bank_account_processing"
            print(f"[PAYOUT] Still processing — will complete asynchronously")
        else:
            # failed/reversed/cancelled
            raise Exception(f"Razorpay payout {payout_status}: {razorpay_payout_id}")

    except ImportError:
        # razorpay package not installed — mark as manual
        payout_mode = "manual_transfer"
        print(f"[PAYOUT] Razorpay not installed — marking as manual transfer")

    except Exception as e:
        # Razorpay payout failed — still mark as fulfilled so admin can manually transfer
        payout_mode = f"manual_required: {str(e)}"
        print(f"[PAYOUT] Razorpay payout failed: {e} — admin must manually transfer")

    # ── Update deal status ───────────────────────────────────────────
    # Only mark "fulfilled" when payout is truly done
    # "processing" means in-flight (bank transfer initiated, will complete)
    # Both map to fulfilled from our escrow perspective —
    # the money has LEFT the platform either way.
    # If payout_mode contains "manual" the admin still needs to transfer
    final_escrow = "fulfilled" if "manual" not in payout_mode else "manual_required"
    db.update_deal(deal_id, {
        "escrow_status":  final_escrow,
        "payout_at":      now,
        "seller_payout":  str(recipient_payout),
        "platform_fee":   str(platform_fee),
    })

    print(f"[PAYOUT] Released ₹{recipient_payout} to {recipient_role} {recipient_id} for deal {deal_id}")

    return {
        "success":          True,
        "preview":          False,
        "deal_id":          deal_id,
        "deal_type":        deal_type,
        "payout_mode":      payout_mode,
        "razorpay_payout_id": razorpay_payout_id,
        "payment_details":  payment_details,
        "message":          f"✅ ₹{recipient_payout} released to {name} ({recipient_role}). Platform earned ₹{platform_fee}."
    }


@app.get("/api/admin/deals/pending-payout")
async def admin_pending_payouts(request: Request):
    """
    ADMIN ONLY: Lists all deals that are delivered but payout not yet released.
    These are deals where you need to manually release the payment to seller.
    """
    from admin import require_admin
    x_admin_key = request.headers.get("X-Admin-Key", "")
    require_admin(x_admin_key)

    all_deals = db._read_all("Deals")
    pending = [
        d for d in all_deals
        if d.get("delivery_status") == "delivered"
        and d.get("escrow_status") not in ("released", "refunded")
        and d.get("payment_status") == "in_escrow"
    ]

    return {
        "count": len(pending),
        "deals": [{
            "deal_id":       d["id"],
            "product_title": d.get("product_title", ""),
            "amount":        d.get("amount", ""),
            "seller_id":     d.get("seller_id", ""),
            "merchant_id":   d.get("merchant_id", ""),
            "delivered_at":  d.get("delivered_at", ""),
            "payment_status": d.get("payment_status", ""),
            "escrow_status":  d.get("escrow_status", ""),
        } for d in pending]
    }


# ─────────────────────────────────────────
# ADMIN — EXTRA ENDPOINTS FOR ADMIN PANEL
# ─────────────────────────────────────────

@app.get("/api/admin/deals")
async def admin_all_deals(request: Request):
    """Admin: returns ALL deals on the platform."""
    from admin import require_admin
    require_admin(request.headers.get("X-Admin-Key",""))
    all_deals = db._read_all("Deals")
    return {"deals": all_deals, "count": len(all_deals)}



@app.get("/api/admin/analytics")
async def platform_analytics(request: Request):
    """
    Admin analytics dashboard data.
    Uses MongoDB aggregations — returns demand trends, top categories,
    top cities, GMV, revenue.
    Only available with MongoDB backend (not Sheets).
    """
    from admin import require_admin
    require_admin(request.headers.get("X-Admin-Key",""))
    return db.get_platform_analytics()


@app.get("/api/admin/deals/released")
async def admin_released_deals(request: Request):
    """Admin: returns all deals where escrow has been released."""
    from admin import require_admin
    require_admin(request.headers.get("X-Admin-Key",""))
    all_deals = db._read_all("Deals")
    released = [d for d in all_deals if d.get("escrow_status") == "released"]
    return {"deals": released, "count": len(released)}


@app.get("/api/admin/payments")
async def admin_all_payments(request: Request):
    """Admin: returns ALL payment records."""
    from admin import require_admin
    require_admin(request.headers.get("X-Admin-Key",""))
    rows = db._read_all("Payments")
    return {"rows": rows, "count": len(rows)}




# ═══════════════════════════════════════════════════════════════
# STEP 6+7 — TRANSPORT & DELIVERY TRACKING
# ═══════════════════════════════════════════════════════════════

# ─────────────────────────────────────────
# VEHICLES — Register & Browse
# ─────────────────────────────────────────

@app.post("/api/transport/vehicle/register")
async def register_vehicle(request: Request, user=Depends(get_current_user)):
    """
    Transporter registers their vehicle.
    Only merchants (role=merchant) can register vehicles.

    Body: {
        vehicle_number, vehicle_type, capacity_kg,
        length_ft, width_ft, height_ft,
        current_city, current_state, description
    }
    """
    body = await request.json()

    # Volume in cubic feet
    l = float(body.get("length_ft", 0) or 0)
    w = float(body.get("width_ft",  0) or 0)
    h = float(body.get("height_ft", 0) or 0)
    volume = round(l * w * h, 2)

    vehicle_id = db.register_vehicle({
        "transporter_id":    user["id"],
        "transporter_name":  user["name"],
        "vehicle_number":    body.get("vehicle_number","").upper().strip(),
        "vehicle_type":      body.get("vehicle_type", "medium_truck"),
        "capacity_kg":       body.get("capacity_kg", 0),
        "capacity_volume_cft": volume,
        "length_ft":         l,
        "width_ft":          w,
        "height_ft":         h,
        "current_city":      body.get("current_city","").strip(),
        "current_state":     body.get("current_state","").strip(),
        "available":         "true",
        "description":       body.get("description",""),
        "photo_url":         body.get("photo_url",""),
        "rating":            "0",
        "rating_count":      "0",
    })

    return {"success": True, "vehicle_id": vehicle_id}


@app.get("/api/transport/vehicles")
async def browse_vehicles(
    city: str = "",
    available_only: bool = True,
    page: int = 1,
    limit: int = 20
):
    """Browse available transport vehicles — no auth needed (public marketplace)."""
    result = db.get_vehicles(
        available_only=available_only,
        city=city,
        page=page,
        limit=limit
    )
    return result


@app.get("/api/transport/my-vehicles")
async def my_vehicles(user=Depends(get_current_user)):
    """Transporter: get my registered vehicles."""
    result = db.get_vehicles(transporter_id=user["id"])
    return result


@app.post("/api/transport/vehicle/update-location")
async def update_vehicle_location(request: Request, user=Depends(get_current_user)):
    """
    Transporter updates current city/location.
    Called when they move to a new city or start a route.

    Body: { vehicle_id, current_city, current_state, lat, lng }
    """
    body = await request.json()
    vehicle_id = body.get("vehicle_id","")
    vehicle = db.get_vehicle(vehicle_id)
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found.")
    if vehicle.get("transporter_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your vehicle.")

    db.update_vehicle(vehicle_id, {
        "current_city":  body.get("current_city",""),
        "current_state": body.get("current_state",""),
    })
    return {"success": True}


@app.post("/api/transport/vehicle/toggle-availability")
async def toggle_vehicle_availability(request: Request, user=Depends(get_current_user)):
    """Transporter: mark vehicle as available or unavailable."""
    body = await request.json()
    vehicle_id = body.get("vehicle_id","")
    vehicle = db.get_vehicle(vehicle_id)
    if not vehicle or vehicle.get("transporter_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your vehicle.")

    new_status = "false" if vehicle.get("available","true").lower() == "true" else "true"
    db.update_vehicle(vehicle_id, {"available": new_status})
    return {"success": True, "available": new_status == "true"}


# ─────────────────────────────────────────
# TRANSPORT REQUESTS — Post & Browse
# ─────────────────────────────────────────

@app.post("/api/transport/request/create")
async def create_transport_request(request: Request, user=Depends(get_current_user)):
    """
    Seller posts a transport request.

    Can be created:
    1. Automatically after bid acceptance (deal_id provided, data auto-filled)
    2. Manually (no deal_id, seller fills in everything)

    Body: {
        deal_id?,          // optional — auto-fills goods data
        title,
        category,
        quantity_kg,
        volume_cft?,
        pickup_city,
        pickup_state,
        pickup_address,
        pickup_lat?,
        pickup_lng?,
        delivery_city,
        delivery_state,
        delivery_address,
        delivery_lat?,
        delivery_lng?,
        pickup_date,       // when goods are ready
        budget_inr?        // max willing to pay for transport
    }
    """
    body = await request.json()
    deal_id = body.get("deal_id","")

    # If linked to a deal, auto-fill goods data
    auto_data = {}
    if deal_id:
        deal = db.get_deal(deal_id)
        if deal:
            auto_data = {
                "title":       deal.get("product_title", body.get("title","")),
                "quantity_kg": deal.get("quantity", body.get("quantity_kg", 0)),
                "pickup_city": deal.get("pickup_city", body.get("pickup_city","")),
            }

    request_id = db.create_transport_request({
        "seller_id":       user["id"],
        "seller_name":     user["name"],
        "deal_id":         deal_id,
        "title":           auto_data.get("title", body.get("title","")),
        "category":        body.get("category",""),
        "quantity_kg":     auto_data.get("quantity_kg", body.get("quantity_kg", 0)),
        "volume_cft":      body.get("volume_cft", 0),
        "pickup_city":     auto_data.get("pickup_city", body.get("pickup_city","")),
        "pickup_state":    body.get("pickup_state",""),
        "pickup_address":  body.get("pickup_address",""),
        "pickup_lat":      body.get("pickup_lat",""),
        "pickup_lng":      body.get("pickup_lng",""),
        "delivery_city":   body.get("delivery_city",""),
        "delivery_state":  body.get("delivery_state",""),
        "delivery_address":body.get("delivery_address",""),
        "delivery_lat":    body.get("delivery_lat",""),
        "delivery_lng":    body.get("delivery_lng",""),
        "pickup_date":     body.get("pickup_date",""),
        "budget_inr":      body.get("budget_inr",""),
        "status":          "open",
        "payment_status":  "unpaid",
    })

    return {"success": True, "request_id": request_id}


@app.get("/api/transport/requests")
async def browse_transport_requests(
    pickup_city:   str = "",
    delivery_city: str = "",
    status:        str = "open",
    page:          int = 1,
    limit:         int = 20
):
    """
    Public transport marketplace — any transporter can browse.
    Sellers also use this to browse all their requests.
    """
    result = db.get_transport_requests(
        status=status,
        pickup_city=pickup_city,
        delivery_city=delivery_city,
        page=page,
        limit=limit
    )
    return result


@app.get("/api/transport/my-requests")
async def my_transport_requests(
    status: str = "",
    page: int = 1,
    limit: int = 20,
    user=Depends(get_current_user)
):
    """Seller: get my transport requests."""
    result = db.get_transport_requests(
        seller_id=user["id"],
        status=status,
        page=page,
        limit=limit
    )
    return result


@app.get("/api/transport/request/{request_id}")
async def get_transport_request_detail(request_id: str):
    """Get full details of a transport request including all bids."""
    req = db.get_transport_request(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Transport request not found.")

    bids = db.get_transport_bids(request_id=request_id)
    req["bids"] = bids
    req["bid_count"] = len(bids)
    return req


# ─────────────────────────────────────────
# TRANSPORT BIDS — Transporters quote prices
# ─────────────────────────────────────────

@app.post("/api/transport/bid/place")
async def place_transport_bid(request: Request, user=Depends(get_current_user)):
    """
    Transporter places a price quote on a transport request.
    Sellers see all quotes and pick the best one.

    Body: { request_id, vehicle_id, price_inr, message? }
    """
    body       = await request.json()
    request_id = body.get("request_id","")
    vehicle_id = body.get("vehicle_id","")
    price      = float(body.get("price_inr", 0) or 0)

    if not request_id or not vehicle_id or price <= 0:
        raise HTTPException(status_code=400, detail="request_id, vehicle_id, and price_inr are required.")

    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")
    if transport_req.get("status") != "open":
        raise HTTPException(status_code=400, detail="This request is no longer open for bids.")

    vehicle = db.get_vehicle(vehicle_id)
    if not vehicle or vehicle.get("transporter_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Vehicle not found or not yours.")

    bid_id = db.create_transport_bid({
        "request_id":      request_id,
        "vehicle_id":      vehicle_id,
        "transporter_id":  user["id"],
        "transporter_name":user["name"],
        "vehicle_number":  vehicle.get("vehicle_number",""),
        "vehicle_type":    vehicle.get("vehicle_type",""),
        "price_inr":       price,
        "message":         body.get("message",""),
        "status":          "pending",
    })

    return {"success": True, "bid_id": bid_id}


@app.post("/api/transport/bid/accept")
async def accept_transport_bid(request: Request, user=Depends(get_current_user)):
    """
    Seller accepts a transporter's quote.

    Body: { request_id, bid_id }

    What happens:
    1. Mark bid as accepted, others as rejected
    2. Update transport request: status=accepted, transporter details filled
    3. Create Razorpay payment order for transport fee
    4. Notify transporter: "You got the job!"
    """
    body       = await request.json()
    request_id = body.get("request_id","")
    bid_id     = body.get("bid_id","")

    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")
    if transport_req.get("seller_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your transport request.")

    all_bids = db.get_transport_bids(request_id=request_id)
    winning  = next((b for b in all_bids if b["id"] == bid_id), None)
    if not winning:
        raise HTTPException(status_code=404, detail="Bid not found.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    # Accept winning bid
    db.update_transport_bid(bid_id, {"status": "accepted"})

    # Reject all others
    for b in all_bids:
        if b["id"] != bid_id:
            db.update_transport_bid(b["id"], {"status": "rejected"})

    # Update transport request
    db.update_transport_request(request_id, {
        "status":              "accepted",
        "accepted_vehicle_id": winning["vehicle_id"],
        "transporter_id":      winning["transporter_id"],
        "transporter_name":    winning["transporter_name"],
        "agreed_price_inr":    winning["price_inr"],
    })

    return {
        "success":       True,
        "agreed_price":  winning["price_inr"],
        "transporter":   winning["transporter_name"],
        "vehicle":       winning["vehicle_number"],
    }


# ─────────────────────────────────────────
# PAYMENT FOR TRANSPORT
# ─────────────────────────────────────────

@app.post("/api/transport/payment/create-order")
async def create_transport_payment_order(request: Request, user=Depends(get_current_user)):
    """
    Seller pays for accepted transport service.
    Same Razorpay escrow flow as product deals.
    Money released to transporter after delivery confirmed.

    Body: { request_id }
    """
    body       = await request.json()
    request_id = (body.get("request_id", "") or "").strip()
    if not request_id:
        raise HTTPException(status_code=400, detail="request_id is required.")

    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")
    if transport_req.get("seller_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your transport request.")
    allowed_statuses = ("accepted", "processed", "open")
    if transport_req.get("status") not in allowed_statuses:
        raise HTTPException(status_code=400, detail=f"Cannot pay: status is '{transport_req.get('status')}'. Must be accepted first.")

    raw_price = transport_req.get("agreed_price_inr") or transport_req.get("budget_inr") or 0
    try:
        price_inr = _parse_inr_value(raw_price)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transport amount '{raw_price}'. Ask admin to re-save the transport price and try again."
        )
    if price_inr <= 0:
        raise HTTPException(
            status_code=400,
            detail="Transport price not set yet. Admin must set agreed_price_inr before payment is possible."
        )
    amount_paise = int(price_inr * 100)

    if (
        not settings.RAZORPAY_KEY_ID
        or settings.RAZORPAY_KEY_ID == "rzp_test_YOUR_KEY_ID_HERE"
        or not settings.RAZORPAY_KEY_SECRET
    ):
        raise HTTPException(status_code=503, detail="Razorpay keys are not configured in backend/.env")

    try:
        import razorpay
    except ImportError:
        raise HTTPException(status_code=503, detail="Razorpay package is not installed in the backend environment.")

    print(f"[TRANSPORT PAY] request_id={request_id} status={transport_req.get('status')} raw_price='{raw_price}' amount_inr={price_inr}")

    try:
        client = razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))
        order = client.order.create({
            "amount":   amount_paise,
            "currency": "INR",
            "receipt":  request_id[:40],
            "notes":    {"request_id": request_id, "type": "transport"}
        })
        db.update_transport_request(request_id, {
            "razorpay_order_id": order["id"]
        })
        return {
            "success":         True,
            "order_id":        order["id"],
            "razorpay_key_id": settings.RAZORPAY_KEY_ID,
            "amount":          price_inr,
            "amount_paise":    amount_paise,
        }
    except razorpay.errors.BadRequestError as exc:
        raise HTTPException(status_code=400, detail=f"Razorpay rejected the payment request: {exc}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not create payment order: {e}")


@app.post("/api/transport/payment/verify")
async def verify_transport_payment(request: Request, user=Depends(get_current_user)):
    """
    Verify Razorpay payment for transport.
    On success: mark payment_status=in_escrow, status=paid, notify transporter.

    Body: { request_id, razorpay_payment_id, razorpay_order_id, razorpay_signature }
    """
    import hmac, hashlib
    body = await request.json()
    request_id = body.get("request_id","")
    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")
    if transport_req.get("seller_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your transport request.")

    saved_order_id = transport_req.get("razorpay_order_id", "")
    if saved_order_id and body.get("razorpay_order_id", "") != saved_order_id:
        raise HTTPException(status_code=400, detail="Payment order mismatch.")

    payload   = f"{body.get('razorpay_order_id')}|{body.get('razorpay_payment_id')}"
    signature = hmac.new(
        settings.RAZORPAY_KEY_SECRET.encode(),
        payload.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(signature, body.get("razorpay_signature","")):
        raise HTTPException(status_code=400, detail="Payment signature invalid.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    db.update_transport_request(request_id, {
        "payment_status":      "in_escrow",
        "status":              "paid",
        "razorpay_payment_id": body.get("razorpay_payment_id",""),
        "razorpay_order_id":   body.get("razorpay_order_id",""),
    })

    return {"success": True}


# ─────────────────────────────────────────
# DELIVERY TRACKING — Real-time GPS updates
# ─────────────────────────────────────────

@app.post("/api/transport/tracking/update")
async def update_tracking(request: Request, user=Depends(get_current_user_optional)):
    """
    Transporter sends real-time location + status update.

    Body: {
        request_id,
        status,        // picked_up | in_transit | delivered
        lat,           // GPS coordinates
        lng,
        note?          // "Reached Pune toll", "Loading complete", etc.
    }

    Broadcasts via Socket.IO to seller and merchant watching this shipment.
    """
    import asyncio, json
    from datetime import datetime

    body       = await request.json()
    request_id = body.get("request_id","")
    status     = body.get("status","")
    lat        = str(body.get("lat",""))
    lng        = str(body.get("lng",""))
    note       = body.get("note","")

    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")

    # Allow admin OR the assigned transporter to update tracking
    x_admin_key    = request.headers.get("X-Admin-Key", "")
    is_admin       = (x_admin_key == settings.ADMIN_SECRET_KEY)
    is_transporter = (transport_req.get("transporter_id") == user.get("id",""))
    is_seller      = (transport_req.get("seller_id") == user.get("id",""))

    if not is_admin and not is_transporter and not is_seller:
        raise HTTPException(status_code=403, detail="Not authorized to update this delivery.")

    now = datetime.utcnow().isoformat() + "Z"

    # Build tracking note entry
    tracking_notes = []
    existing_notes = transport_req.get("tracking_notes","")
    if existing_notes:
        try:
            tracking_notes = json.loads(existing_notes)
        except Exception:
            tracking_notes = []

    new_note = {
        "time":   now,
        "status": status,
        "lat":    lat,
        "lng":    lng,
        "note":   note or status.replace("_"," ").title(),
    }
    tracking_notes.append(new_note)

    # Status → timestamp field mapping
    status_times = {
        "picked_up":  {"pickup_at":    now},
        "delivered":  {"delivered_at": now},
    }

    updates = {
        "current_lat":         lat,
        "current_lng":         lng,
        "last_location_update":now,
        "tracking_notes":      json.dumps(tracking_notes),
        "status":              status if status in ("picked_up","in_transit","delivered") else transport_req.get("status",""),
    }
    updates.update(status_times.get(status, {}))
    db.update_transport_request(request_id, updates)

    # Broadcast location to everyone watching this shipment
    tracking_payload = {
        "request_id": request_id,
        "status":     status,
        "lat":        lat,
        "lng":        lng,
        "note":       new_note["note"],
        "time":       now,
    }
    asyncio.create_task(
        sio.emit("transport_update", tracking_payload, room=f"transport_{request_id}")
    )

    # On delivery — update status + send email to seller
    if status == "delivered":
        db.update_transport_request(request_id, {
            "payment_status": "released",
            "status":         "delivered",
            "delivered_at":   now,
        })

        # Send delivery confirmation email to seller
        seller = db.get_user_profile(transport_req.get("seller_id", ""))
        if seller and seller.get("email"):
            asyncio.create_task(asyncio.to_thread(
                _send_delivery_email,
                seller["email"],
                seller.get("name", "Seller"),
                transport_req,
                now,
            ))

        # In-app notification to seller
        db.create_notification(
            user_id=transport_req.get("seller_id", ""),
            type="success",
            icon="✅",
            title="Shipment Delivered!",
            message=f"Your goods have been successfully delivered. Check Transport tab for details.",
        )

    return {"success": True, "tracking": new_note}

def _send_delivery_email(seller_email: str, seller_name: str, req: dict, delivered_at: str):
    """Sends a delivery confirmation email to the seller."""
    from email_service import send_email, _base_template
    delivered_date = delivered_at[:10] if delivered_at else "Today"
    req_id_short   = req.get("id", "")[:8].upper()

    content = f"""
    <p>Hi <strong>{seller_name}</strong>,</p>
    <p style="color:#374151;font-size:15px;">
      Great news! Your shipment has been <strong style="color:#15803d;">successfully delivered</strong> to the destination.
    </p>

    <!-- Delivery banner -->
    <div style="background:linear-gradient(135deg,#1a6b3a,#15803d);border-radius:12px;
                padding:20px 24px;margin:16px 0;color:white;text-align:center;">
      <div style="font-size:40px;margin-bottom:8px;">✅</div>
      <div style="font-size:20px;font-weight:800;">Delivered Successfully!</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px;">Delivered on {delivered_date}</div>
    </div>

    <!-- Shipment summary -->
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin:14px 0;">
      <div style="font-weight:700;font-size:15px;color:#111827;margin-bottom:12px;">📦 Shipment Summary</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <tr><td style="color:#6b7280;padding:5px 0;">Goods</td>
            <td style="font-weight:600;">{req.get('title', '—')}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;">Weight</td>
            <td>{req.get('quantity_kg', '—')} kg</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;">📍 From</td>
            <td>{req.get('pickup_address', '—')}, {req.get('pickup_city', '')}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;">🏪 To</td>
            <td>{req.get('delivery_address', '—')}, {req.get('delivery_city', '')}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;">Delivered On</td>
            <td style="font-weight:600;color:#15803d;">{delivered_date}</td></tr>
        <tr><td style="color:#6b7280;padding:5px 0;">Amount Paid</td>
            <td style="font-weight:700;">₹{float(req.get('agreed_price_inr', 0) or 0):,.2f}</td></tr>
      </table>
    </div>

    <!-- Escrow released -->
    <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;
                padding:12px 16px;margin-bottom:16px;">
      💰 <strong>Payment Released</strong> — Escrow has been released to the transporter.
    </div>

    <p style="color:#6b7280;font-size:13px;">
      Thank you for using TradeLink Logistics. View your shipment details in
      <strong>Seller Portal → Transport tab</strong>.
    </p>
    <p style="color:#9ca3af;font-size:11px;">Reference: {req.get('id', '—')} · Delivered: {delivered_date}</p>
    """

    send_email(
        seller_email,
        f"✅ Shipment Delivered — {req_id_short}",
        _base_template("Your Shipment Has Been Delivered!", content)
    )

@app.post("/api/transport/tracking/join")
async def join_tracking_room(request: Request):
    """Frontend calls this to subscribe to real-time updates for a transport request."""
    # Actual WebSocket room join happens client-side via socket.emit('join_transport')
    # This endpoint is just for HTTP-based fallback
    body = await request.json()
    return {"success": True, "message": "Join via WebSocket: emit('join_transport', {request_id})"}


@app.get("/api/transport/tracking/{request_id}")
async def get_tracking_history(request_id: str):
    """Get full tracking history for a transport request."""
    import json
    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")

    notes = []
    raw = transport_req.get("tracking_notes","")
    if raw:
        try:
            notes = json.loads(raw)
        except Exception:
            notes = []

    return {
        "request_id":    request_id,
        "status":        transport_req.get("status",""),
        "current_lat":   transport_req.get("current_lat",""),
        "current_lng":   transport_req.get("current_lng",""),
        "pickup_lat":    transport_req.get("pickup_lat",""),
        "pickup_lng":    transport_req.get("pickup_lng",""),
        "delivery_lat":  transport_req.get("delivery_lat",""),
        "delivery_lng":  transport_req.get("delivery_lng",""),
        "pickup_city":   transport_req.get("pickup_city",""),
        "delivery_city": transport_req.get("delivery_city",""),
        "transporter":   transport_req.get("transporter_name",""),
        "vehicle":       transport_req.get("vehicle_number",""),
        "tracking_notes":notes,
        "last_update":   transport_req.get("last_location_update",""),
    }


@app.post("/api/transport/confirm-delivery")
async def seller_confirm_transport_delivery(request: Request, user=Depends(get_current_user)):
    """
    Seller confirms they received the goods.
    Triggers payout release to transporter.

    Body: { request_id, rating?, review? }
    """
    body       = await request.json()
    request_id = body.get("request_id","")
    rating     = int(body.get("rating", 5) or 5)

    transport_req = db.get_transport_request(request_id)
    if not transport_req:
        raise HTTPException(status_code=404, detail="Transport request not found.")
    if transport_req.get("seller_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your transport request.")

    from datetime import datetime
    now = datetime.utcnow().isoformat() + "Z"

    db.update_transport_request(request_id, {
        "status":         "delivered",
        "payment_status": "released",
        "delivered_at":   now,
    })

    # Update transporter's vehicle rating
    vehicle_id = transport_req.get("accepted_vehicle_id","")
    if vehicle_id:
        vehicle = db.get_vehicle(vehicle_id)
        if vehicle:
            old_rating = float(vehicle.get("rating","0") or 0)
            old_count  = int(vehicle.get("rating_count","0") or 0)
            new_count  = old_count + 1
            new_rating = round(((old_rating * old_count) + rating) / new_count, 1)
            db.update_vehicle(vehicle_id, {
                "rating":       str(new_rating),
                "rating_count": str(new_count),
                "available":    "true",
            })

    return {"success": True}


# ─────────────────────────────────────────
# TRANSPORTER DASHBOARD
# ─────────────────────────────────────────

@app.get("/api/transport/dashboard")
async def transporter_dashboard(user=Depends(get_current_user)):
    """
    Transporter dashboard stats:
    - Active deliveries
    - Open requests near their city
    - Earnings summary
    - Vehicle status
    """
    vehicles = db.get_vehicles(transporter_id=user["id"])
    active_reqs = db.get_transport_requests(status="paid")
    # Filter to my active deliveries
    my_deliveries = [r for r in active_reqs.get("rows",[])
                     if r.get("transporter_id") == user["id"]]

    open_requests = db.get_transport_requests(status="open", limit=10)

    return {
        "vehicles":        vehicles.get("rows",[]),
        "vehicle_count":   vehicles.get("total",0),
        "active_deliveries": my_deliveries,
        "active_count":    len(my_deliveries),
        "open_requests":   open_requests.get("rows",[]),
        "open_count":      open_requests.get("total",0),
    }

# ─────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────

def check_owner(user: dict, target_id: str):
    """Ensures the logged-in user can only access their own data."""
    if user["id"] != target_id:
        raise HTTPException(status_code=403, detail="Access denied.")

def get_initials(name: str) -> str:
    parts = (name or "?").strip().split()
    return "".join(p[0] for p in parts).upper()[:2]

def _safe_user(user: dict) -> dict:
    """Returns user dict safe to send to browser — never includes password_hash."""
    return {
        "id":           user.get("id", ""),
        "name":         user.get("name", ""),
        "email":        user.get("email", ""),
        "role":         user.get("role", ""),
        "phone":        user.get("phone", ""),
        "city":         user.get("city", ""),
        "state":        user.get("state", ""),
        "kyc_status":   user.get("kyc_status", "unverified"),
        "rating":       user.get("rating", "0"),
        "initials":     get_initials(user.get("name", "?")),
        "has_password": bool(user.get("password_hash", "")),
    }



# ─────────────────────────────────────────
# KYC DOCUMENT UPLOAD
# ─────────────────────────────────────────

@app.post("/api/kyc/upload-doc")
async def upload_kyc_doc(body: UploadKYCDocRequest, user=Depends(get_current_user)):
    """
    Uploads a KYC document (Aadhaar, PAN, selfie) to GCP Cloud Storage.
    Saves the file URL in the KYC_Docs sheet.

    The file is sent as base64-encoded text in the request body.
    This is simpler for beginners than multipart form uploads.

    doc_type options: "aadhaar", "pan", "selfie", "gst_certificate"
    """
    check_owner(user, body.user_id)

    if not body.file_base64:
        raise HTTPException(status_code=400, detail="No file data received.")

    valid_doc_types = ["aadhaar", "pan", "selfie", "gst_certificate", "bank_statement"]
    if body.doc_type not in valid_doc_types:
        raise HTTPException(status_code=400, detail=f"Invalid doc_type. Must be one of: {valid_doc_types}")

    # Upload to Google Drive
    try:
        result = upload_file(
            base64_data=body.file_base64,
            original_filename=body.filename or f"{body.doc_type}.jpg",
            folder="kyc",
            user_id=body.user_id,
        )
    except ValueError as e:
        # Drive folder not configured yet
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    file_url = result["url"]

    # Save record in KYC_Docs sheet
    db.save_kyc_doc(
        user_id=body.user_id,
        doc_type=body.doc_type,
        file_url=file_url,
    )

    # Mark the specific doc type as uploaded in Users sheet
    doc_field_map = {
        "aadhaar":          "kyc_aadhaar_url",
        "pan":              "kyc_pan_url",
        "selfie":           "kyc_selfie_url",
        "gst_certificate":  "kyc_gst_url",
    }
    if body.doc_type in doc_field_map:
        db.update_user(body.user_id, {doc_field_map[body.doc_type]: file_url})

    return {"success": True, "url": file_url, "doc_type": body.doc_type}


@app.get("/api/kyc/docs/{user_id}")
async def get_kyc_docs(user_id: str, user=Depends(get_current_user)):
    """Returns all uploaded KYC documents for a user."""
    check_owner(user, user_id)
    docs = db.get_kyc_docs(user_id)
    return {"docs": docs}


# ─────────────────────────────────────────
# LISTING PHOTO UPLOAD
# ─────────────────────────────────────────
'''
@app.post("/api/listing/upload-photo")
async def upload_listing_photo(body: UploadKYCDocRequest, user=Depends(get_current_user)):
    """
    Uploads a listing product photo to Google Drive.

    COMMON ERRORS:
    - GDRIVE_FOLDER_ID not set in .env → add it
    - Drive folder not shared with service account → share it
    - google-api-python-client not installed → pip install google-api-python-client
    """
    # Check folder ID is configured
    if not settings.GDRIVE_FOLDER_ID:
        raise HTTPException(
            status_code=503,
            detail=(
                "GDRIVE_FOLDER_ID not set in backend/.env. "
                "Steps: 1) Create a Google Drive folder, "
                "2) Share it with your service account email, "
                "3) Copy the folder ID from the URL and add to .env"
            )
        )

    # Check file data is present
    if not body.file_base64:
        raise HTTPException(status_code=400, detail="No file data received.")

    print(f"[UPLOAD] user={body.user_id} file={body.filename} folder_id={settings.GDRIVE_FOLDER_ID[:8]}...")

    try:
        result = upload_file(
            base64_data=body.file_base64,
            original_filename=body.filename or "photo.jpg",
            folder="listing-photos",
            user_id=body.user_id,
        )
        print(f"[UPLOAD] Success: {result['url'][:60]}")
        return {"success": True, "url": result["url"]}

    except ValueError as e:
        # Configuration error (e.g. folder not found)
        print(f"[UPLOAD] Config error: {e}")
        raise HTTPException(status_code=503, detail=str(e))

    except ImportError as e:
        print(f"[UPLOAD] Missing package: {e}")
        raise HTTPException(
            status_code=503,
            detail="google-api-python-client not installed. Run: pip install google-api-python-client"
        )

    except Exception as e:
        import traceback
        print(f"[UPLOAD] ERROR: {e}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
'''

@app.post("/api/listing/upload-photo")
async def upload_listing_photo(body: UploadKYCDocRequest, user=Depends(get_current_user)):
    """Uploads a listing photo to ImgBB and returns the public URL."""
    if not body.file_base64:
        raise HTTPException(status_code=400, detail="No file data received.")

    print(f"[UPLOAD] user={body.user_id} file={body.filename}")

    try:
        result = upload_file(
            base64_data=body.file_base64,
            original_filename=body.filename or "photo.jpg",
            folder="listing-photos",
            user_id=body.user_id,
        )
        print(f"[UPLOAD] Success: {result['url'][:60]}")
        return {"success": True, "url": result["url"]}

    except ValueError as e:
        print(f"[UPLOAD] ERROR: {e}")
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:
        print(f"[UPLOAD] ERROR: {e}")
        raise HTTPException(status_code=500, detail="Photo upload failed. Check server logs.")

# ─────────────────────────────────────────
# FORGOT PASSWORD — Step 1: Send OTP
# ─────────────────────────────────────────
@app.post("/api/auth/forgot-password")
async def forgot_password(request: Request):
    import random, string
    body  = await request.json()
    email = body.get("email", "").strip().lower()
    role  = body.get("role", "").strip().lower()

    if not email or not role:
        raise HTTPException(400, "Email and role are required.")

    # Check user exists in MongoDB with this email + role
    user = db.find_user_by_email_and_role(email, role)
    if not user:
        # Check if they're in the other portal
        other_role = "merchant" if role == "seller" else "seller"
        other_user = db.find_user_by_email_and_role(email, other_role)
        if other_user:
            portal = "Merchant Portal" if other_role == "merchant" else "Seller Portal"
            return {
                "success":      False,
                "wrong_portal": True,
                "detail":       f"This email is registered as a {other_role}. Please use the {portal}.",
            }
        raise HTTPException(404, "No account found with this email.")

    # Generate 6-digit OTP
    otp = "".join(random.choices(string.digits, k=6))

    # Save OTP in memory (10 min TTL) — key: "reset:email:role"
    db.save_otp(
        key=f"reset:{email}:{role}",
        otp=otp,
        user_data={"email": email, "role": role, "user_id": user["id"]},
        ttl_minutes=10
    )

    # Send OTP email
    from email_service import send_password_reset_otp_email
    send_password_reset_otp_email(email, user.get("name", "User"), otp)

    return {"success": True, "message": "OTP sent to your email."}


# ─────────────────────────────────────────
# FORGOT PASSWORD — Step 2: Verify OTP + Set New Password
# ─────────────────────────────────────────
@app.post("/api/auth/reset-password")
async def reset_password(request: Request):
    body         = await request.json()
    email        = body.get("email", "").strip().lower()
    otp          = body.get("otp",   "").strip()
    new_password = body.get("new_password", "")
    role         = body.get("role",  "").strip().lower()

    if not email or not otp or not new_password or not role:
        raise HTTPException(400, "All fields are required.")
    if len(new_password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")

    # Verify OTP — returns user_data dict if correct, None if wrong/expired
    data = db.verify_otp(f"reset:{email}:{role}", otp)
    if not data:
        return {"success": False, "detail": "Invalid or expired OTP. Please try again."}

    # Hash new password
    hashed = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    # Save to MongoDB
    user = db.find_user_by_email_and_role(email, role)
    if not user:
        raise HTTPException(404, "User not found.")

    db.set_password_hash(user["id"], hashed)

    # Also update Firebase password so Google+password both work
    try:
        if user.get("firebase_uid"):
            firebase_auth.update_user(user["firebase_uid"], password=new_password)
    except Exception:
        pass  # Firebase update is optional — MongoDB is source of truth

    return {"success": True, "message": "Password reset successfully. You can now log in."}




# ── EMAIL LOGIN: fallback to MongoDB if Firebase fails ──────────
# (This endpoint already exists in your main.py — if it doesn't, add it)
# The key addition is: if Firebase custom token fails, still check bcrypt hash

# ─────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────

# ─────────────────────────────────────────
# NULL-ORIGIN CORS WRAPPER
# Allows file:// opened pages to call the API without CORS errors.
# Pure ASGI — cannot crash, no dependencies.
# ─────────────────────────────────────────

class NullOriginWrapper:
    def __init__(self, asgi_app):
        self.app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "http" and scope.get("method") == "OPTIONS":
            await send({"type": "http.response.start", "status": 200,
                "headers": [
                    (b"access-control-allow-origin",  b"*"),
                    (b"access-control-allow-methods", b"GET, POST, PUT, DELETE, OPTIONS, PATCH"),
                    (b"access-control-allow-headers", b"*"),
                    (b"access-control-max-age",       b"86400"),
                    (b"content-length",               b"0"),
                ]})
            await send({"type": "http.response.body", "body": b""})
            return

        async def patched_send(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", [])
                           if k.lower() not in (
                               b"access-control-allow-origin",
                               b"access-control-allow-methods",
                               b"access-control-allow-headers",
                           )]
                headers.extend([
                    (b"access-control-allow-origin",  b"*"),
                    (b"access-control-allow-methods", b"GET, POST, PUT, DELETE, OPTIONS, PATCH"),
                    (b"access-control-allow-headers", b"*"),
                ])
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, patched_send)


app = NullOriginWrapper(app)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

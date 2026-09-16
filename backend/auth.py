"""
TRADELINK — Firebase Auth  (backend/auth.py)

Verifies Firebase ID tokens (used for Google login).
Email+password login is handled directly in main.py using bcrypt.
"""

import firebase_admin
from firebase_admin import credentials, auth
from fastapi import Request, HTTPException
from config import settings
import os

# ─────────────────────────────────────────
# INITIALIZE FIREBASE ADMIN SDK (once)
# ─────────────────────────────────────────

_firebase_initialized = False

'''def init_firebase():
    global _firebase_initialized
    if _firebase_initialized:
        return

    sdk_path = settings.FIREBASE_ADMIN_SDK_JSON

    if not os.path.exists(sdk_path):
        print(f"⚠️  Firebase Admin SDK JSON not found at: {sdk_path}")
        print("   Auth will be disabled until you add the file.")
        _firebase_initialized = True
        return

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(sdk_path)
            firebase_admin.initialize_app(cred)
        _firebase_initialized = True
        print("✅ Firebase Admin SDK initialized")
    except Exception as e:
        print(f"⚠️  Firebase init error: {e}")
        _firebase_initialized = True
'''

import json

def init_firebase():
    global _firebase_initialized
    if _firebase_initialized:
        return

    cred = None

    # 1. Check if raw JSON content is provided in Render environment variables
    raw_json = os.environ.get("FIREBASE_ADMIN_SDK_JSON_CONTENT") or getattr(settings, "FIREBASE_ADMIN_SDK_JSON_CONTENT", "")
    if raw_json and raw_json.strip().startswith("{"):
        try:
            cred_dict = json.loads(raw_json)
            cred = credentials.Certificate(cred_dict)
            print("✅ Firebase initialized from FIREBASE_ADMIN_SDK_JSON_CONTENT")
        except Exception as e:
            print(f"⚠️ Error parsing FIREBASE_ADMIN_SDK_JSON_CONTENT: {e}")

    # 2. Fallback to local file path if available
    if not cred:
        sdk_path = getattr(settings, "FIREBASE_ADMIN_SDK_JSON", "firebase-adminsdk.json")
        if os.path.exists(sdk_path):
            cred = credentials.Certificate(sdk_path)
            print(f"✅ Firebase initialized from file: {sdk_path}")
        else:
            print(f"⚠️ Firebase Admin SDK key not found (no file at {sdk_path} and no JSON env var)")

    # 3. Initialize Firebase Admin SDK
    if cred:
        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app(cred)
            _firebase_initialized = True
        except Exception as e:
            print(f"⚠️ Firebase init error: {e}")
    else:
        _firebase_initialized = True


init_firebase()


# ─────────────────────────────────────────
# TOKEN VERIFICATION
# ─────────────────────────────────────────

def verify_firebase_token(token: str) -> str | None:
    """
    Verifies a Firebase ID token.
    Returns the Firebase UID if valid, None if invalid.
    """
    if not token:
        return None
    try:
        decoded = auth.verify_id_token(token)
        return decoded["uid"]
    except Exception as e:
        print(f"Token verification failed: {e}")
        return None


def verify_firebase_token_full(token: str) -> dict | None:
    """
    Verifies a Firebase ID token.
    Returns the full decoded payload dictionary if valid, None if invalid.
    """
    if not token:
        return None
    try:
        return auth.verify_id_token(token)
    except Exception as e:
        print(f"Token verification failed: {e}")
        return None


def extract_token_from_header(request: Request) -> str | None:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return None


# ─────────────────────────────────────────
# FASTAPI DEPENDENCY
# ─────────────────────────────────────────

async def get_current_user(request: Request) -> dict:
    """
    FastAPI dependency — validates Firebase token and returns user dict.
    Used on all protected endpoints (everything except auth routes).

    Role detection:
    - Reads X-User-Role header (most reliable — frontend sends it)
    - Falls back to URL path detection
    """
    from database import MongoDB

    token = extract_token_from_header(request)
    if not token:
        raise HTTPException(status_code=401, detail="Missing auth token. Please log in.")

    firebase_uid = verify_firebase_token(token)
    if not firebase_uid:
        raise HTTPException(status_code=401, detail="Invalid or expired token. Please log in again.")

    # Detect role from header or URL path
    path       = request.url.path.lower()
    role_hint  = request.headers.get("X-User-Role", "").strip().lower()

    if not role_hint:
        seller_paths   = ["/seller/", "/listing/", "/bid/", "/deal/", "/payout"]
        merchant_paths = ["/merchant/", "/marketplace/", "/my-bids", "/watchlist"]
        if any(p in path for p in seller_paths):
            role_hint = "seller"
        elif any(p in path for p in merchant_paths):
            role_hint = "merchant"

    db   = MongoDB()
    user = db.find_user_by_firebase_uid(firebase_uid, role=role_hint)

    if not user:
        user = db.find_user_by_firebase_uid(firebase_uid)

    if not user:
        raise HTTPException(status_code=404, detail="User profile not found.")

    return user

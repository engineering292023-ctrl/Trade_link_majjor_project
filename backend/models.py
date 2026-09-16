"""
TRADELINK — Pydantic Models  (backend/models.py)
Updated: MongoDB auth, no notifications, OTP-based password reset
"""

from pydantic import BaseModel
from typing import Optional


# ─────────────────────────────────────────
# AUTH MODELS
# ─────────────────────────────────────────

class EmailLoginRequest(BaseModel):
    """Email + password login — fully server-side, no Firebase call from browser."""
    email:    str
    password: str
    role:     str   # "seller" or "merchant"


class GoogleLoginRequest(BaseModel):
    """Google login — browser calls signInWithPopup, sends id_token here."""
    firebase_token: str
    role:           str   # "seller" or "merchant"


class LoginRequest(BaseModel):
    """Legacy / Google login — kept for compatibility."""
    firebase_token: str
    email:    Optional[str] = ""
    password: Optional[str] = ""
    role:     Optional[str] = ""


class RegisterRequest(BaseModel):
    """Legacy register endpoint — used for Google sign-in registration."""
    firebase_token: str
    email:         str
    name:          str
    role:          str
    phone:         Optional[str] = ""
    city:          Optional[str] = ""
    state:         Optional[str] = ""
    company_name:  Optional[str] = ""
    password:      Optional[str] = ""


class SendOTPRequest(BaseModel):
    """Step 1 of email registration — send OTP to verify email."""
    email:        str
    password:     str    # stored hashed after OTP verified
    name:         str
    role:         str    # "seller" or "merchant"
    phone:        Optional[str] = ""
    city:         Optional[str] = ""
    state:        Optional[str] = ""
    company_name: Optional[str] = ""


class VerifyOTPRequest(BaseModel):
    """Step 2 of email registration — verify OTP and create account."""
    email: str
    otp:   str


class ForgotPasswordRequest(BaseModel):
    """Send OTP to reset password. Role needed to find correct MongoDB record."""
    email: str
    role:  str   # "seller" or "merchant"


class ResetPasswordRequest(BaseModel):
    """Verify OTP and set new password in MongoDB."""
    email:        str
    otp:          str
    new_password: str
    role:         str   # "seller" or "merchant"


class SetPasswordRequest(BaseModel):
    """
    Allow a Google-registered user to set a password for the first time.
    Called after they verify OTP from forgot-password flow.
    Same endpoint as reset, just the UI labels differ.
    """
    email:        str
    otp:          str
    new_password: str
    role:         str


# ─────────────────────────────────────────
# LISTING / BID / DEAL MODELS
# ─────────────────────────────────────────

class CreateListingRequest(BaseModel):
    seller_id:   str
    title:       str
    category:    str
    description: str
    quantity:    float
    unit:        str
    min_price:   float
    duration_h:  int
    city:        str
    state:       Optional[str] = ""
    photo_url:   Optional[str] = ""


class PlaceBidRequest(BaseModel):
    listing_id:     str
    merchant_id:    str
    price_per_unit: float
    total_amount:   float


class AcceptBidRequest(BaseModel):
    bid_id:     str
    listing_id: str


class UpdateProfileRequest(BaseModel):
    seller_id:     str
    name:          str
    business_name: Optional[str] = ""
    city:          Optional[str] = ""
    state:         Optional[str] = ""


class SubmitKYCRequest(BaseModel):
    seller_id:    str
    aadhaar_num:  str
    pan_num:      str
    bank_account: str
    ifsc:         str
    gst:          Optional[str] = ""


class InitiatePayoutRequest(BaseModel):
    seller_id:       str
    amount:          float
    bank_account_id: str


class CreatePaymentOrderRequest(BaseModel):
    deal_id:     str
    merchant_id: str
    amount:      float


class VerifyPaymentRequest(BaseModel):
    deal_id:             str
    razorpay_payment_id: str
    razorpay_order_id:   str
    razorpay_signature:  str


class ConfirmDeliveryRequest(BaseModel):
    deal_id:     str
    merchant_id: str


class ToggleWatchlistRequest(BaseModel):
    merchant_id: str
    listing_id:  str
    action:      str   # "add" or "remove"


# ─────────────────────────────────────────
# KYC UPLOAD MODEL
# ─────────────────────────────────────────

class UploadKYCDocRequest(BaseModel):
    user_id:     str
    doc_type:    str
    file_base64: str
    filename:    Optional[str] = ""


# ─────────────────────────────────────────
# KEPT FOR COMPATIBILITY (Step 3 routes)
# ─────────────────────────────────────────

class VerifyEmailRequest(BaseModel):
    user_id: str


class ResendVerificationRequest(BaseModel):
    user_id: str

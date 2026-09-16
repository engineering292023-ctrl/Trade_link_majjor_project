"""
TRADELINK — Configuration  (backend/config.py)

ALL values come from environment variables (.env file).
NOTHING sensitive is hardcoded here.

Pydantic-settings reads .env automatically.
If a required variable is missing the app raises a clear error on startup.
"""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):

    # ── MongoDB ───────────────────────────────────────────────────
    # Get from: https://cloud.mongodb.com → Connect → Drivers
    MONGODB_URI:     str = Field(..., description="MongoDB Atlas connection string")
    MONGODB_DB_NAME: str = Field(default="tradelink")

    # ── Redis (optional — bid caching) ────────────────────────────
    # Get from: https://upstash.com → Create Database → copy redis://... URL
    # Leave blank to disable (app still works, just no caching)
    REDIS_URL: str = Field(default="")

    # ── Firebase ──────────────────────────────────────────────────
    #FIREBASE_ADMIN_SDK_JSON: str = Field(default="firebase-adminsdk.json")

    # Around line 28 in backend/config.py:
    FIREBASE_ADMIN_SDK_JSON:         str = Field(default="firebase-adminsdk.json")
    FIREBASE_ADMIN_SDK_JSON_CONTENT: str = Field(default="")


    # ── Razorpay ──────────────────────────────────────────────────
    RAZORPAY_KEY_ID:         str = Field(..., description="Razorpay Key ID")
    RAZORPAY_KEY_SECRET:     str = Field(..., description="Razorpay Key Secret")
    RAZORPAY_WEBHOOK_SECRET: str = Field(default="")

    # ── Google Drive (file uploads) ───────────────────────────────
    GOOGLE_SERVICE_ACCOUNT_JSON: str = Field(default="service-account.json")
    GDRIVE_FOLDER_ID:            str = Field(default="")

    # ── Gmail SMTP & AppsScript ───────────────────────────────────
    GMAIL_ADDRESS:       str = Field(default="")
    GMAIL_APP_PASSWORD:  str = Field(default="")
    APPSCRIPT_EMAIL_URL: str = Field(default="")

    # ── Mailjet Email API ──────────────────────────────────────────
    MAILJET_API_KEY:      str = Field(default="")
    MAILJET_API_SECRET:   str = Field(default="")
    MAILJET_SENDER_EMAIL: str = Field(default="")

    # ── ImgBB ─────────────────────────────────────────────────────
    IMGBB_API_KEY: str = Field(default="")

    # ── Gemini AI (3 Keys Rotation) ───────────────────────────────
    GEMINI_API_KEY_1: str = Field(default="")
    GEMINI_API_KEY_2: str = Field(default="")
    GEMINI_API_KEY_3: str = Field(default="")

    # ── Admin ─────────────────────────────────────────────────────
    ADMIN_SECRET_KEY: str = Field(..., description="Admin panel secret key")

    # ── App ───────────────────────────────────────────────────────
    APP_ENV:       str = Field(default="development")
    ALLOWED_HOSTS: str = Field(default="*")

    class Config:
        env_file          = ".env"
        env_file_encoding = "utf-8"
        extra             = "ignore"


settings = Settings()

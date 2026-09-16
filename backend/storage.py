"""
TRADELINK — File Storage using ImgBB  (backend/storage.py)

Uses ImgBB free image hosting API instead of Google Drive or Firebase.

WHY IMGBB?
- 100% free forever
- No credit card, no account needed for basic use
- Simple REST API — just POST base64, get back a URL
- Permanent image hosting
- Supports JPG, PNG, GIF, WEBP, PDF (as image)
- Max file size: 32MB per image (way more than enough)

SETUP (2 minutes):
1. Go to: https://imgbb.com
2. Click "Sign Up" (free) — top right
3. After login, go to: https://api.imgbb.com
4. Click "Get API key"
5. Copy the key
6. Add to backend/.env:
   IMGBB_API_KEY=your_key_here

That is it. No folder setup, no sharing, no quota issues.

HOW IT WORKS:
1. Frontend reads file as base64 and sends to backend
2. Backend POSTs the base64 to ImgBB API
3. ImgBB returns a permanent public URL
4. URL is saved in Google Sheets
5. Images display anywhere using that URL
"""

import base64
import os
import re
import httpx
import uuid
from config import settings


# ─────────────────────────────────────────
# MIME TYPE HELPERS
# ─────────────────────────────────────────

MIME_TYPES = {
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".gif":  "image/gif",
    ".bmp":  "image/bmp",
}

DATAURL_MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg":  ".jpg",
    "image/png":  ".png",
    "image/webp": ".webp",
    "image/gif":  ".gif",
    "image/bmp":  ".bmp",
}


def _safe_b64decode(data: str) -> bytes:
    """Decode base64 safely — handles missing padding."""
    data = data.strip().replace("\n", "").replace("\r", "").replace(" ", "")
    missing = len(data) % 4
    if missing:
        data += "=" * (4 - missing)
    return base64.b64decode(data)


def _extract_mime_and_data(base64_data: str) -> tuple:
    """
    Splits a data URL into (mime_type, raw_base64).
    Input:  "data:image/png;base64,iVBORw0KGgo..."
    Output: ("image/png", "iVBORw0KGgo...")
    """
    if base64_data.startswith("data:"):
        try:
            header, raw = base64_data.split(",", 1)
            mime = header.split(":")[1].split(";")[0].strip().lower()
            return mime, raw
        except Exception:
            pass
    return "", base64_data


def _detect_name(original_filename: str, folder: str, user_id: str) -> str:
    """Builds a clean unique name for the image on ImgBB."""
    base = os.path.splitext(original_filename or "upload")[0]
    base = re.sub(r"[^\w\-]", "_", base)[:20]
    uid  = str(uuid.uuid4())[:6]
    return f"{folder}_{user_id[:8]}_{base}_{uid}"


# ─────────────────────────────────────────
# MAIN UPLOAD FUNCTION
# ─────────────────────────────────────────

def upload_file(
    base64_data: str,
    original_filename: str,
    folder: str,
    user_id: str,
) -> dict:
    """
    Uploads an image to ImgBB and returns a permanent public URL.

    Parameters:
        base64_data       — file as base64 string (with or without data: prefix)
        original_filename — e.g. "aadhaar.jpg"
        folder            — label: "kyc" or "listing-photos"
        user_id           — used to build a unique filename

    Returns:
        {
          "url":          "https://i.ibb.co/xxx/filename.jpg",   ← direct image URL
          "download_url": "https://i.ibb.co/xxx/filename.jpg",
          "filename":     "kyc_S1234_aadhaar_ab12cd.jpg",
          "file_id":      "ImgBB image ID"
        }

    Raises:
        ValueError   — if IMGBB_API_KEY is not set in .env
        RuntimeError — if ImgBB upload fails
    """

    # ── Check API key ─────────────────────────────────────────────
    if not settings.IMGBB_API_KEY:
        raise ValueError(
            "IMGBB_API_KEY not set in backend/.env\n"
            "Quick setup (2 minutes, free):\n"
            "  1. Go to https://imgbb.com → Sign Up (free)\n"
            "  2. Go to https://api.imgbb.com → Get API key\n"
            "  3. Add to backend/.env:  IMGBB_API_KEY=your_key_here\n"
            "  4. Restart the server"
        )

    if not base64_data:
        raise ValueError("No file data received.")

    # ── Extract raw base64 (strip data URL prefix if present) ────
    detected_mime, raw_b64 = _extract_mime_and_data(base64_data)

    # ── Validate it decodes correctly ────────────────────────────
    try:
        file_bytes = _safe_b64decode(raw_b64)
    except Exception as e:
        raise ValueError(f"Could not decode file: {e}")

    if len(file_bytes) == 0:
        raise ValueError("File is empty (0 bytes).")

    print(f"[UPLOAD] ImgBB upload: {len(file_bytes)} bytes  folder={folder}")

    # ── Build image name ──────────────────────────────────────────
    image_name = _detect_name(original_filename, folder, user_id)

    # ── POST to ImgBB API ─────────────────────────────────────────
    # ImgBB API docs: https://api.imgbb.com
    # Endpoint: POST https://api.imgbb.com/1/upload
    # Params:   key (API key), image (base64 string), name (optional)
    try:
        response = httpx.post(
            "https://api.imgbb.com/1/upload",
            data={
                "key":   settings.IMGBB_API_KEY,
                "image": raw_b64,          # raw base64 without data: prefix
                "name":  image_name,
            },
            timeout=30.0,
        )

        data = response.json()

        # ImgBB returns { success: true, data: { url, display_url, id, ... } }
        if response.status_code == 200 and data.get("success"):
            img_data   = data["data"]
            # Use display_url (direct image link) — works in <img src="">
            public_url = img_data.get("display_url") or img_data.get("url", "")
            image_id   = img_data.get("id", "")

            print(f"[UPLOAD] ImgBB success: {public_url[:60]}")

            return {
                "url":          public_url,
                "download_url": public_url,
                "filename":     image_name,
                "file_id":      image_id,
            }

        else:
            # ImgBB returned an error
            error_msg = data.get("error", {})
            if isinstance(error_msg, dict):
                error_msg = error_msg.get("message", str(data))
            print(f"[UPLOAD] ImgBB error response: {data}")
            raise RuntimeError(
                f"ImgBB upload failed: {error_msg}\n"
                "Check your IMGBB_API_KEY in .env is correct."
            )

    except httpx.TimeoutException:
        raise RuntimeError(
            "ImgBB upload timed out (30s). Check internet connection and try again."
        )
    except httpx.RequestError as e:
        raise RuntimeError(
            f"Could not reach ImgBB API: {e}\n"
            "Check internet connection."
        )
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"ImgBB upload failed: {e}")


# ─────────────────────────────────────────
# DELETE (not supported by ImgBB free API)
# ─────────────────────────────────────────

def delete_file(file_id: str):
    """
    ImgBB free API does not support deletion via API.
    Files can be deleted manually from your ImgBB account.
    This function exists for compatibility but does nothing.
    """
    if file_id:
        print(f"[UPLOAD] Note: ImgBB deletion not supported via API. "
              f"Delete manually at imgbb.com if needed. ID: {file_id}")
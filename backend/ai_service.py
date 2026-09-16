"""
TRADELINK — Gemini AI Service (backend/ai_service.py)

Direct, structured Gemini AI Assistant:
- Dynamic 3-tier API key rotation (Key 1 -> Key 2 -> Key 3)
- Pure user prompt processing from chat textbox (any product, quantity, unit, or topic)
- Concise, structured output format rules (under 120 words, structured Markdown)
"""

import os
import logging
from typing import List, Dict, Any, Optional
import httpx
from dotenv import dotenv_values
from config import settings

logger = logging.getLogger("tradelink.ai")

SYSTEM_INSTRUCTION = """You are TradeLink AI — a smart, fast, and structured assistant for TradeLink Marketplace.

Your Role & Behavior:
- Directly and accurately answer whatever question the user types into the chat box.
- User can ask about ANY item, product, commodity, or quantity (e.g. "what is the price of the doms proxima pen single unit", "10 kg rice", "50 solar panels", "100 notebooks", electronics, raw materials, or services).
- When asked about pricing, provide realistic estimated market rates in ₹ (INR):
  - **Estimated Price**: Unit price (e.g. ₹10 – ₹15 / unit) and total cost for requested quantity.
  - **Market Details**: 2-3 crisp bullet points on key specs, wholesale vs retail pack pricing, or standard pack sizes.
  - **Trade Tip**: 1 brief practical buying/selling advice.
- When asked general trade, calculation, or platform questions, give a structured, direct answer.
- Keep total response under 120 words. No boilerplate greetings or conversational fluff. Use clean markdown with bold figures and bullet points.
"""


class GeminiManager:
    """
    Manages up to 3 Gemini API keys with sequential failover.
    Works seamlessly with 1 key (Keys 2 and 3 are optional).
    """

    def __init__(self):
        self.active_key_index = 0

    def get_keys(self) -> List[str]:
        """Returns list of all configured non-empty Gemini API keys in priority order (1 -> 2 -> 3)."""
        live_env = {}
        try:
            if os.path.exists(".env"):
                live_env = dotenv_values(".env")
            elif os.path.exists("backend/.env"):
                live_env = dotenv_values("backend/.env")
        except Exception:
            pass

        raw_keys = [
            live_env.get("GEMINI_API_KEY_1") or settings.GEMINI_API_KEY_1,
            live_env.get("GEMINI_API_KEY_2") or settings.GEMINI_API_KEY_2,
            live_env.get("GEMINI_API_KEY_3") or settings.GEMINI_API_KEY_3,
        ]
        keys = []
        for k in raw_keys:
            val = str(k or "").strip().strip('"').strip("'")
            if val and val not in keys:
                keys.append(val)
        return keys

    async def generate_content(
        self,
        contents: List[Dict[str, Any]],
        system_instruction: str = SYSTEM_INSTRUCTION,
        temperature: float = 0.4
    ) -> Dict[str, Any]:
        """
        Sends the user's prompt directly to Gemini models.
        """
        keys = self.get_keys()
        if not keys:
            return {
                "success": False,
                "error": "No Gemini API key found in backend/.env",
                "text": "⚠️ No Gemini API key found. Please add your key starting with `AIzaSy...` to `GEMINI_API_KEY_1` in `backend/.env`."
            }

        models = [
            "gemini-3.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
            "gemini-3.1-pro-preview",
            "gemini-flash-latest",
            "gemini-2.5-flash",
        ]
        start_index = self.active_key_index % len(keys)
        total_keys = len(keys)
        last_error_code = None

        payload: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": 800,
            },
            "systemInstruction": {
                "parts": [{"text": system_instruction}]
            }
        }

        async with httpx.AsyncClient(timeout=25.0) as client:
            for attempt in range(total_keys):
                current_idx = (start_index + attempt) % total_keys
                api_key = keys[current_idx]

                for model in models:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
                    headers = {
                        "Content-Type": "application/json",
                        "x-goog-api-key": api_key
                    }

                    try:
                        res = await client.post(url, json=payload, headers=headers)
                        last_error_code = res.status_code

                        if res.status_code == 200:
                            data = res.json()
                            candidates = data.get("candidates", [])
                            if candidates:
                                parts = candidates[0].get("content", {}).get("parts", [])
                                text = "".join([p.get("text", "") for p in parts if "text" in p])
                                if text:
                                    self.active_key_index = current_idx
                                    return {
                                        "success": True,
                                        "text": text,
                                        "key_used_index": current_idx + 1,
                                        "model_used": model
                                    }

                        if res.status_code in (401, 403):
                            logger.warning(f"Key #{current_idx + 1} returned {res.status_code}. Trying next key...")
                            break
                        else:
                            logger.info(f"Model {model} returned {res.status_code}. Trying next fallback model...")
                            continue
                    except Exception as e:
                        logger.warning(f"Error calling {model} with key #{current_idx + 1}: {e}")
                        continue

        # If all attempts failed
        if last_error_code == 401:
            msg = "Google rejected the key (401 Unauthorized). Please ensure your key in `GEMINI_API_KEY_1` is an active Google AI Studio key starting with `AIzaSy...`."
        elif last_error_code == 429:
            msg = "Gemini rate limit reached (429). Please wait a moment or add a backup key."
        else:
            msg = f"Unable to reach Gemini ({last_error_code or 'network error'}). Please check your API key in `backend/.env`."

        return {
            "success": False,
            "error": msg,
            "text": f"⚠️ {msg}"
        }


gemini_manager = GeminiManager()


async def get_ai_chat_response(
    messages: List[Dict[str, str]],
    role: str = "seller",
    form_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Builds clean message contents from user chat box input and calls Gemini.
    """
    contents: List[Dict[str, Any]] = []

    for m in messages:
        gemini_role = "user" if m.get("role") in ("user", "human") else "model"
        text = (m.get("content") or "").strip()
        if text:
            contents.append({
                "role": gemini_role,
                "parts": [{"text": text}]
            })

    if not contents:
        contents = [{"role": "user", "parts": [{"text": "Hello"}]}]

    return await gemini_manager.generate_content(contents=contents)


async def evaluate_commodity_price(
    title: str,
    category: str,
    price: float,
    unit: str,
    quantity: float = 1.0,
    city: str = ""
) -> Dict[str, Any]:
    """
    Evaluates price via Gemini.
    """
    prompt = (
        f"Evaluate price:\n"
        f"- Product: {title} ({category})\n"
        f"- Proposed: ₹{price} per {unit} for {quantity} {unit}\n"
        f"- Location: {city or 'India'}\n\n"
        f"Is this fair, high, or low? What is the standard market range in ₹, and recommended price?"
    )
    return await gemini_manager.generate_content(
        contents=[{"role": "user", "parts": [{"text": prompt}]}]
    )

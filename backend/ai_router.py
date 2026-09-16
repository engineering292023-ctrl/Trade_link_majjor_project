"""
TRADELINK — AI Router (backend/ai_router.py)

FastAPI endpoints for Gemini AI Assistant & Commodity Price Advisor:
- POST /api/ai/chat              Interactive contextual conversation
- POST /api/ai/evaluate-price    Instant price benchmark & unit check
- GET  /api/ai/status            Check AI service health & configured key count
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ai_service import get_ai_chat_response, evaluate_commodity_price, gemini_manager

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ChatMessage(BaseModel):
    role: str = Field(..., description="'user' or 'assistant'/'model'")
    content: str = Field(..., description="Message text")


class AIChatRequest(BaseModel):
    messages: List[ChatMessage]
    role: Optional[str] = "seller"   # "seller" or "merchant"
    form_context: Optional[Dict[str, Any]] = None


class PriceEvaluateRequest(BaseModel):
    title: str = Field(..., description="Product or commodity name")
    category: str = Field(..., description="Category name")
    price: float = Field(..., description="Seller proposed price per unit")
    unit: str = Field(default="", description="Unit (kg, quintal, ton, etc.)")
    quantity: Optional[float] = 1.0
    city: Optional[str] = ""


@router.post("/chat")
async def chat_with_gemini(req: AIChatRequest):
    """
    Interactive AI chat for sellers & merchants with automatic 3-key failover.
    """
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    result = await get_ai_chat_response(
        messages=msgs,
        role=req.role or "seller",
        form_context=req.form_context
    )
    return result


@router.post("/evaluate-price")
async def evaluate_price(req: PriceEvaluateRequest):
    """
    Dedicated endpoint to evaluate if seller's price is fair/high/low,
    validate unit selection, and give Mandi benchmark numerical ranges.
    """
    result = await evaluate_commodity_price(
        title=req.title,
        category=req.category,
        price=req.price,
        unit=req.unit,
        quantity=req.quantity or 1.0,
        city=req.city or ""
    )
    return result


@router.get("/status")
async def ai_status():
    """
    Returns AI configuration status (number of available keys, active key index).
    """
    keys = gemini_manager.get_keys()
    return {
        "status": "configured" if keys else "no_keys",
        "keys_count": len(keys),
        "active_key_index": (gemini_manager.active_key_index % len(keys) + 1) if keys else 0,
        "model": "gemini-1.5-flash"
    }

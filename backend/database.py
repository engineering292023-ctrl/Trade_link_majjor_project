"""
TRADELINK — MongoDB Database Layer  (backend/database.py)

Changes from original:
- password_hash field supported on users
- Notifications completely removed
- OTP key format supports "email:role" for multi-role accounts
- find_user_by_email_and_role added
"""

import uuid
import json
from datetime import datetime, timedelta
from typing import Optional
from pymongo import MongoClient, DESCENDING, ASCENDING
from pymongo.collection import Collection
from config import settings

# ─────────────────────────────────────────
# ID PREFIXES
# ─────────────────────────────────────────
ID_PREFIX = {
    "users":              {"seller": "S", "merchant": "M", "transporter": "T"},
    "listings":           "L",
    "bids":               "B",
    "deals":              "D",
    "payments":           "P",
    "payouts":            "PO",
    "kyc_docs":           "K",
    "watchlist":          "W",
    "vehicles":           "V",
    "transport_requests": "TR",
    "transport_bids":     "TB",
}


def _new_id(collection: str, role: str = "") -> str:
    short      = uuid.uuid4().hex[:11]
    prefix_map = ID_PREFIX.get(collection, "")
    if isinstance(prefix_map, dict):
        prefix = prefix_map.get(role, "X")
    else:
        prefix = prefix_map
    return prefix + short


# ─────────────────────────────────────────
# REDIS CACHE (optional)
# ─────────────────────────────────────────

_redis_client = None

def _get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if not settings.REDIS_URL:
        return None
    try:
        import redis
        _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        _redis_client.ping()
        print("✅ Redis connected")
        return _redis_client
    except Exception as e:
        print(f"⚠️  Redis not available: {e} — running without cache")
        return None


def _cache_get(key: str):
    r = _get_redis()
    if not r:
        return None
    try:
        val = r.get(key)
        return json.loads(val) if val else None
    except Exception:
        return None


def _cache_set(key: str, value, ttl_seconds: int = 10):
    r = _get_redis()
    if not r:
        return
    try:
        r.setex(key, ttl_seconds, json.dumps(value, default=str))
    except Exception:
        pass


def _cache_delete(key: str):
    r = _get_redis()
    if not r:
        return
    try:
        r.delete(key)
    except Exception:
        pass


# ─────────────────────────────────────────
# MAIN DATABASE CLASS
# ─────────────────────────────────────────

class MongoDB:
    """
    MongoDB database layer. Drop-in replacement for SheetsDB.
    Notifications are removed — not used in this version.
    """

    _client: Optional[MongoClient] = None
    _db = None

    # In-memory OTP store — key is "email:role" for reg, "reset:email:role" for reset
    _otp_store: dict = {}

    def __init__(self):
        if MongoDB._client is None:
            MongoDB._connect_class()

    @classmethod
    def _connect_class(cls):
        uri = settings.MONGODB_URI
        if not uri:
            raise RuntimeError(
                "MONGODB_URI not set in .env\n"
                "Get it from: https://cloud.mongodb.com → Connect → Drivers"
            )
        cls._client = MongoClient(uri, serverSelectionTimeoutMS=5000)
        cls._db     = cls._client[settings.MONGODB_DB_NAME]
        cls._client.admin.command("ping")
        print(f"✅ MongoDB connected → db: {settings.MONGODB_DB_NAME}")

    def _col(self, name: str) -> Collection:
        return MongoDB._db[name]

    # ─────────────────────────────────────────
    # USERS
    # ─────────────────────────────────────────

    def find_user_by_email(self, email: str) -> dict | None:
        doc = self._col("users").find_one({"email": email.lower()})
        return _clean(doc)

    def find_user_by_email_and_role(self, email: str, role: str) -> dict | None:
        """Find a user matching BOTH email AND role. Critical for multi-role accounts."""
        doc = self._col("users").find_one(
            {"email": email.lower(), "role": role}
        )
        return _clean(doc)

    def find_user_by_firebase_uid(self, uid: str, role: str = "") -> dict | None:
        query = {"firebase_uid": uid}
        if role:
            query["role"] = role
        doc = self._col("users").find_one(query)
        return _clean(doc)

    def get_user_profile(self, user_id: str) -> dict | None:
        doc = self._col("users").find_one({"id": user_id})
        return _clean(doc)

    def get_user_field(self, user_id: str, field: str) -> str:
        doc = self._col("users").find_one({"id": user_id}, {field: 1})
        return str(doc.get(field, "")) if doc else ""

    def create_user(self, data: dict) -> str:
        role    = data.get("role", "seller")
        user_id = _new_id("users", role)
        data["id"]         = user_id
        data["email"]      = data.get("email", "").lower()
        data["created_at"] = _now()
        # Ensure password_hash field always exists
        data.setdefault("password_hash", "")
        self._col("users").insert_one(_strip_mongo(data))
        return user_id

    def update_user(self, user_id: str, updates: dict):
        # Never allow password_hash to be overwritten with empty string via this method
        # (use explicit set_password_hash for that)
        if "password_hash" in updates and not updates["password_hash"]:
            updates.pop("password_hash", None)
        self._col("users").update_one({"id": user_id}, {"$set": updates})

    def create_notification(self, user_id: str, type: str, icon: str, title: str, message: str):
        """Create an in-app notification for a user."""
        from datetime import datetime
        import uuid
        notif = {
            "id":         "N" + str(uuid.uuid4()).replace("-", "")[:12],
            "user_id":    user_id,
            "type":       type,
            "icon":       icon,
            "title":      title,
            "message":    message,
            "is_read":    False,
            "created_at": datetime.utcnow().isoformat() + "Z",
        }
        self._col("notifications").insert_one(notif)

    def set_password_hash(self, user_id: str, hashed: str):
        """Explicitly set password hash — separate method so it can't be accidentally cleared."""
        self._col("users").update_one(
            {"id": user_id},
            {"$set": {"password_hash": hashed}}
        )

    def get_seller_rating(self, seller_id: str) -> dict:
        doc = self._col("users").find_one(
            {"id": seller_id}, {"rating": 1, "review_count": 1}
        )
        if not doc:
            return {"rating": 0.0, "count": 0}
        return {
            "rating": float(doc.get("rating", 0) or 0),
            "count":  int(doc.get("review_count", 0) or 0),
        }

    def get_users_by_kyc_status(self, kyc_status: str) -> list:
        return list(self._col("users").find(
            {"kyc_status": kyc_status}, {"_id": 0, "password_hash": 0}
        ))

    # ─────────────────────────────────────────
    # LISTINGS
    # ─────────────────────────────────────────

    def _get_user_map(self, user_ids) -> dict:
        ids = [uid for uid in set(user_ids or []) if uid]
        if not ids:
            return {}
        return {
            doc["id"]: doc for doc in self._col("users").find(
                {"id": {"$in": ids}},
                {"_id": 0, "id": 1, "name": 1, "city": 1, "state": 1, "rating": 1, "review_count": 1}
            )
            if doc.get("id")
        }

    def _enrich_listing_rows(self, rows: list) -> list:
        if not rows:
            return rows

        seller_map = self._get_user_map([row.get("seller_id", "") for row in rows])
        for row in rows:
            seller = seller_map.get(row.get("seller_id", ""), {})
            row["seller_name"] = row.get("seller_name") or seller.get("name", "")
            row["seller_rating"] = float(row.get("seller_rating") or seller.get("rating") or 0)
            row["seller_review_count"] = int(row.get("seller_review_count") or seller.get("review_count") or 0)
        return rows

    def _deal_status_query(self, status: str) -> dict:
        status_key = str(status or "").strip().lower()
        if not status_key:
            return {}
        if status_key in {"pay_pending", "paid", "in_escrow", "released", "failed"}:
            return {"payment_status": status_key}
        if status_key in {"confirmed", "accepted", "booked", "in_transit", "delivered", "cancelled"}:
            return {"delivery_status": status_key}
        return {"status": status_key}

    def _enrich_deal_rows(self, rows: list) -> list:
        if not rows:
            return rows

        seller_map = self._get_user_map([row.get("seller_id", "") for row in rows])
        merchant_map = self._get_user_map([row.get("merchant_id", "") for row in rows])
        listing_ids = [row.get("listing_id", "") for row in rows if row.get("listing_id")]
        deal_ids = [row.get("id", "") for row in rows if row.get("id")]

        listing_map = {
            doc["id"]: doc for doc in self._col("listings").find(
                {"id": {"$in": list(set(listing_ids))}},
                {"_id": 0}
            )
            if doc.get("id")
        } if listing_ids else {}

        transport_map = {}
        if deal_ids:
            transport_rows = list(
                self._col("transport_requests")
                .find({"$or": [{"deal_id": {"$in": list(set(deal_ids))}}]}, {"_id": 0})
                .sort("created_at", DESCENDING)
            )
            for transport in transport_rows:
                deal_id = transport.get("deal_id", "")
                if deal_id and deal_id not in transport_map:
                    transport_map[deal_id] = transport

        for row in rows:
            seller = seller_map.get(row.get("seller_id", ""), {})
            merchant = merchant_map.get(row.get("merchant_id", ""), {})
            listing = listing_map.get(row.get("listing_id", ""), {})
            transport = transport_map.get(row.get("id", ""), {})

            row["seller_name"] = row.get("seller_name") or seller.get("name", "")
            row["merchant_name"] = row.get("merchant_name") or merchant.get("name", "")
            row["product_title"] = row.get("product_title") or listing.get("title") or "Goods"
            row["listing_title"] = row.get("listing_title") or listing.get("title", "")
            row["pickup_city"] = row.get("pickup_city") or transport.get("pickup_city") or listing.get("city", "")
            row["pickup_state"] = row.get("pickup_state") or listing.get("state", "")
            row["delivery_city"] = row.get("delivery_city") or transport.get("delivery_city", "")
            row["quantity"] = row.get("quantity") or listing.get("quantity", "")
            row["unit"] = row.get("unit") or listing.get("unit", "")
            row["deliver_to"] = row.get("deliver_to") or merchant.get("city", "")
            
            # Transport enrichment
            if transport:
                row["has_transport"] = True
                row["transport_id"] = transport.get("id", "")
                row["transporter_name"] = (
                    row.get("transporter_name") or 
                    transport.get("transporter_name") or 
                    "TradeLink Logistics"
                )
                row["tracking_number"] = (
                    row.get("tracking_number") or 
                    transport.get("tracking_number") or 
                    f"TLTRK-{row.get('id', '')[:8].upper()}"
                )
                row["transport_status"] = transport.get("status", "")
                t_stat = str(transport.get("status", "")).lower()
                if t_stat in {"in_transit", "dispatched"}:
                    row["delivery_status"] = "in_transit"
                elif t_stat == "delivered":
                    row["delivery_status"] = "delivered"
            else:
                row["transporter_name"] = row.get("transporter_name") or ""
                row["transport_status"] = row.get("transport_status") or ""

            if row.get("delivery_status") == "delivered" or row.get("buyer_confirmed"):
                row["timeline_status"] = "delivered"
            elif row.get("delivery_status") == "in_transit":
                row["timeline_status"] = "in_transit"
            elif row.get("payment_status") in {"paid", "in_escrow", "released"}:
                row["timeline_status"] = "paid"
            else:
                row["timeline_status"] = "confirmed"

        return rows

    def get_listings(self, seller_id="", page=1, limit=20, status="",
                     category="", state="", search="", sort="created_at_desc") -> dict:
        query = {}
        if seller_id:
            query["seller_id"] = seller_id
        if status:
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            query["status"] = {"$in": statuses} if len(statuses) > 1 else statuses[0]
        if category:
            query["category"] = category
        if state:
            query["state"] = state
        if search:
            query["$or"] = [
                {"title":       {"$regex": search, "$options": "i"}},
                {"description": {"$regex": search, "$options": "i"}},
            ]

        sort_map = {
            "created_at_desc": [("created_at", DESCENDING)],
            "created_at_asc":  [("created_at", ASCENDING)],
            "expires_asc":     [("expires_at",  ASCENDING)],
            "price_asc":       [("min_price",   ASCENDING)],
            "price_desc":      [("min_price",   DESCENDING)],
            "bid_count_desc":  [("bid_count",   DESCENDING)],
        }
        mongo_sort = sort_map.get(sort, [("created_at", DESCENDING)])
        total = self._col("listings").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("listings").find(query, {"_id": 0})
            .sort(mongo_sort).skip(skip).limit(limit)
        )
        rows = self._enrich_listing_rows(rows)
        return {"rows": rows, "total": total}

    def get_listings_raw(self, seller_id="", status="") -> list:
        query = {}
        if seller_id: query["seller_id"] = seller_id
        if status:    query["status"]    = status
        return list(self._col("listings").find(query, {"_id": 0}))

    def get_listing(self, listing_id: str) -> dict | None:
        row = _clean(self._col("listings").find_one({"id": listing_id}))
        if not row:
            return None
        return self._enrich_listing_rows([row])[0]

    def create_listing(self, data: dict) -> str:
        lid = _new_id("listings")
        data["id"]         = lid
        data["created_at"] = _now()
        data.setdefault("bid_count", 0)
        data.setdefault("top_bid", None)
        self._col("listings").insert_one(_strip_mongo(data))
        return lid

    def update_listing(self, listing_id: str, updates: dict):
        self._col("listings").update_one({"id": listing_id}, {"$set": updates})

    def count_listings(self, seller_id="", status="") -> int:
        q = {}
        if seller_id: q["seller_id"] = seller_id
        if status:    q["status"]    = status
        return self._col("listings").count_documents(q)

    # ─────────────────────────────────────────
    # BIDS
    # ─────────────────────────────────────────

    def get_bids_for_listing(self, listing_id: str, sort="price_desc") -> list:
        cache_key = f"bids:{listing_id}"
        cached    = _cache_get(cache_key)
        if cached is not None:
            return cached
        direction = DESCENDING if "desc" in sort else ASCENDING
        field     = "price_per_unit" if "price" in sort else "created_at"
        bids      = list(
            self._col("bids")
            .find({"listing_id": listing_id}, {"_id": 0})
            .sort(field, direction)
        )
        buyer_map = self._get_user_map([bid.get("merchant_id", "") for bid in bids])
        for bid in bids:
            buyer = buyer_map.get(bid.get("merchant_id", ""), {})
            bid["buyer_name"] = bid.get("buyer_name") or buyer.get("name", "")
        _cache_set(cache_key, bids, ttl_seconds=10)
        return bids

    def get_bid(self, bid_id: str) -> dict | None:
        return _clean(self._col("bids").find_one({"id": bid_id}))

    def create_bid(self, data: dict) -> str:
        bid_id = _new_id("bids")
        data["id"]         = bid_id
        data["created_at"] = _now()
        self._col("bids").insert_one(_strip_mongo(data))
        _cache_delete(f"bids:{data.get('listing_id', '')}")
        return bid_id

    def update_bid(self, bid_id: str, updates: dict):
        doc = self._col("bids").find_one({"id": bid_id}, {"listing_id": 1})
        self._col("bids").update_one({"id": bid_id}, {"$set": updates})
        if doc:
            _cache_delete(f"bids:{doc.get('listing_id', '')}")

    def count_pending_bids(self, seller_id: str) -> int:
        listing_ids = [
            l["id"] for l in self._col("listings").find(
                {"seller_id": seller_id, "status": "active"}, {"id": 1}
            )
        ]
        if not listing_ids:
            return 0
        return self._col("bids").count_documents(
            {"listing_id": {"$in": listing_ids}, "status": "live"}
        )

    def count_merchant_active_bids(self, merchant_id: str) -> int:
        return self._col("bids").count_documents(
            {"merchant_id": merchant_id, "status": "live"}
        )

    def get_merchant_bids(self, merchant_id: str, page=1, limit=20, status="") -> dict:
        bids = list(
            self._col("bids")
            .find({"merchant_id": merchant_id}, {"_id": 0})
            .sort("created_at", DESCENDING)
        )
        listing_ids = {b.get("listing_id", "") for b in bids if b.get("listing_id")}
        listings = {
            l["id"]: l for l in self._enrich_listing_rows(list(
                self._col("listings").find({"id": {"$in": list(listing_ids)}}, {"_id": 0})
            ))
        } if listing_ids else {}
        deal_bid_ids = {b.get("id", "") for b in bids if b.get("id")}
        deals_list = list(
            self._col("deals").find({"bid_id": {"$in": list(deal_bid_ids)}}, {"_id": 0})
        ) if deal_bid_ids else []
        deals_map = {d["bid_id"]: d for d in deals_list}

        def _safe_float(value) -> float:
            try:
                return float(value or 0)
            except (TypeError, ValueError):
                return 0.0

        for b in bids:
            lst = listings.get(b.get("listing_id", ""), {})
            top_bid = lst.get("top_bid")
            b["listing_title"] = lst.get("title", "")
            b["product_title"] = b.get("product_title") or lst.get("title", "")
            b["listing_category"] = lst.get("category", "")
            b["listing_unit"] = lst.get("unit", "")
            b["unit"] = b.get("unit") or lst.get("unit", "")
            b["listing_city"] = lst.get("city", "")
            b["listing_photo"] = lst.get("photo_url", "")
            b["seller_name"] = b.get("seller_name") or lst.get("seller_name", "")
            b["top_bid"] = top_bid if top_bid not in ("", None) else b.get("price_per_unit", "")
            b["expires_at"] = lst.get("expires_at", "")
            b["is_top_bid"] = _safe_float(b.get("price_per_unit")) >= _safe_float(b.get("top_bid"))

            d = deals_map.get(b.get("id", ""))
            if d:
                b["deal_id"] = d["id"]
                b["payment_status"] = d.get("payment_status", "")
                b["delivery_status"] = d.get("delivery_status", "")
                b["amount"] = d.get("amount", "")
                b["bid_status"] = "won"
            elif str(lst.get("status", "")).lower() in {"closed", "expired", "cancelled"}:
                b["bid_status"] = "outbid"
            else:
                b["bid_status"] = "live"

        if status:
            bids = [bid for bid in bids if str(bid.get("bid_status", "")).lower() == str(status).lower()]

        total = len(bids)
        skip = (page - 1) * limit
        rows = bids[skip:skip + limit]
        return {"rows": rows, "total": total}

    # ─────────────────────────────────────────
    # DEALS
    # ─────────────────────────────────────────

    def get_deals(self, seller_id="", merchant_id="", page=1, limit=20,
                  status="", sort="created_at_desc") -> dict:
        query = {}
        if seller_id:   query["seller_id"]   = seller_id
        if merchant_id: query["merchant_id"] = merchant_id
        query.update(self._deal_status_query(status))
        direction = DESCENDING if "desc" in sort else ASCENDING
        total = self._col("deals").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("deals")
            .find(query, {"_id": 0})
            .sort("created_at", direction)
            .skip(skip).limit(limit)
        )
        rows = self._enrich_deal_rows(rows)
        return {"rows": rows, "total": total}

    def get_deal(self, deal_id: str) -> dict | None:
        row = _clean(self._col("deals").find_one({"id": deal_id}))
        if not row:
            return None
        return self._enrich_deal_rows([row])[0]

    def get_deal_by_order_id(self, razorpay_order_id: str) -> dict | None:
        return _clean(
            self._col("deals").find_one({"razorpay_order_id": razorpay_order_id})
        )

    def create_deal(self, data: dict) -> str:
        did = _new_id("deals")
        data["id"]         = did
        data["created_at"] = _now()
        self._col("deals").insert_one(_strip_mongo(data))
        return did

    def update_deal(self, deal_id: str, updates: dict):
        self._col("deals").update_one({"id": deal_id}, {"$set": updates})

    def count_deals(self, seller_id="", merchant_id="", status="") -> int:
        q = {}
        if seller_id:   q["seller_id"]   = seller_id
        if merchant_id: q["merchant_id"] = merchant_id
        q.update(self._deal_status_query(status))
        return self._col("deals").count_documents(q)

    # ─────────────────────────────────────────
    # PAYMENTS
    # ─────────────────────────────────────────

    def create_payment_record(self, deal_id, amount, razorpay_payment_id, status):
        deal = self.get_deal(deal_id)
        pid  = _new_id("payments")
        self._col("payments").insert_one({
            "id":                  pid,
            "deal_id":             deal_id,
            "seller_id":           deal["seller_id"]   if deal else "",
            "merchant_id":         deal["merchant_id"] if deal else "",
            "product_title":       deal["product_title"] if deal else "",
            "amount":              str(amount),
            "razorpay_payment_id": razorpay_payment_id,
            "razorpay_order_id":   deal.get("razorpay_order_id", "") if deal else "",
            "status":              status,
            "created_at":          _now(),
        })

    def get_seller_payments(self, seller_id: str, page=1, limit=20) -> dict:
        query = {"seller_id": seller_id}
        total = self._col("payments").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("payments")
            .find(query, {"_id": 0})
            .sort("created_at", DESCENDING)
            .skip(skip).limit(limit)
        )
        return {"rows": rows, "total": total}

    def get_merchant_payments(self, merchant_id: str, page=1, limit=20) -> dict:
        query = {"merchant_id": merchant_id}
        total = self._col("payments").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("payments")
            .find(query, {"_id": 0})
            .sort("created_at", DESCENDING)
            .skip(skip).limit(limit)
        )
        return {"rows": rows, "total": total}

    def sum_seller_earnings(self, seller_id: str) -> float:
        docs = self._col("deals").find(
            {"seller_id": seller_id, "escrow_status": "fulfilled"},
            {"seller_payout": 1}
        )
        return sum(float(d.get("seller_payout", 0) or 0) for d in docs)

    def sum_merchant_spending(self, merchant_id: str) -> float:
        docs = self._col("deals").find(
            {"merchant_id": merchant_id, "payment_status": "in_escrow"},
            {"amount": 1}
        )
        return sum(float(d.get("amount", 0) or 0) for d in docs)

    # ─────────────────────────────────────────
    # PAYOUTS
    # ─────────────────────────────────────────

    def create_payout_record(self, deal_id: str, seller_id: str, amount: float):
        existing = self._col("payouts").find_one({"deal_id": deal_id})
        if existing:
            self._col("payouts").update_one(
                {"deal_id": deal_id},
                {"$set": {"status": "completed", "amount": str(amount)}}
            )
            return
        self._col("payouts").insert_one({
            "id":         _new_id("payouts"),
            "seller_id":  seller_id,
            "deal_id":    deal_id,
            "amount":     str(amount),
            "status":     "completed",
            "created_at": _now(),
        })

    def create_payout_withdrawal(self, data: dict) -> str:
        pid = _new_id("payouts")
        data["id"]         = pid
        data["created_at"] = _now()
        self._col("payouts").insert_one(_strip_mongo(data))
        return pid

    def get_seller_payouts(self, seller_id: str, page=1, limit=20) -> dict:
        query = {"seller_id": seller_id}
        total = self._col("payouts").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("payouts")
            .find(query, {"_id": 0})
            .sort("created_at", DESCENDING)
            .skip(skip).limit(limit)
        )
        return {"rows": rows, "total": total}

    def get_available_balance(self, seller_id: str) -> float:
        released = list(self._col("deals").find(
            {"seller_id": seller_id, "escrow_status": "fulfilled"}, {"seller_payout": 1}
        ))
        total_released = sum(float(d.get("seller_payout", 0) or 0) for d in released)
        withdrawn = list(self._col("payouts").find(
            {"seller_id": seller_id, "status": "completed"}, {"amount": 1}
        ))
        total_withdrawn = sum(float(w.get("amount", 0) or 0) for w in withdrawn)
        return round(total_released - total_withdrawn, 2)

    # ─────────────────────────────────────────
    # WATCHLIST
    # ─────────────────────────────────────────

    def get_watchlist(self, merchant_id: str) -> list:
        items       = list(self._col("watchlist").find({"merchant_id": merchant_id}, {"_id": 0}))
        listing_ids = [i["listing_id"] for i in items]
        if not listing_ids:
            return []
        return list(self._col("listings").find(
            {"id": {"$in": listing_ids}}, {"_id": 0}
        ))

    def is_in_watchlist(self, merchant_id: str, listing_id: str) -> bool:
        return bool(self._col("watchlist").find_one(
            {"merchant_id": merchant_id, "listing_id": listing_id}
        ))

    def add_to_watchlist(self, merchant_id: str, listing_id: str):
        if not self.is_in_watchlist(merchant_id, listing_id):
            self._col("watchlist").insert_one({
                "id":          _new_id("watchlist"),
                "merchant_id": merchant_id,
                "listing_id":  listing_id,
                "created_at":  _now(),
            })

    def remove_from_watchlist(self, merchant_id: str, listing_id: str):
        self._col("watchlist").delete_one(
            {"merchant_id": merchant_id, "listing_id": listing_id}
        )

    def count_watchlist(self, merchant_id: str) -> int:
        return self._col("watchlist").count_documents({"merchant_id": merchant_id})

    # ─────────────────────────────────────────
    # ACTIVITY FEED
    # ─────────────────────────────────────────

    def get_activity_feed(self, seller_id: str, limit: int = 8) -> list:
        listing_ids = [
            l["id"] for l in self._col("listings")
            .find({"seller_id": seller_id}, {"id": 1}).limit(50)
        ]
        bids = list(
            self._col("bids")
            .find({"listing_id": {"$in": listing_ids}}, {"_id": 0})
            .sort("created_at", DESCENDING)
            .limit(limit)
        )
        feed = []
        for b in bids:
            feed.append({
                "type":       "bid",
                "icon":       "🔨",
                "title":      f"New bid: ₹{b.get('price_per_unit','')}/unit",
                "subtitle":   f"From {b.get('buyer_city', 'Unknown')}",
                "created_at": b.get("created_at", ""),
                "listing_id": b.get("listing_id", ""),
            })
        return feed

    # ─────────────────────────────────────────
    # INVOICES
    # ─────────────────────────────────────────

    def get_invoices(self, merchant_id: str) -> list:
        deals = list(
            self._col("deals")
            .find({"merchant_id": merchant_id, "payment_status": "in_escrow"}, {"_id": 0})
            .sort("created_at", DESCENDING)
        )
        invoices = []
        for d in deals:
            invoices.append({
                "id":          "INV-" + d["id"][:8].upper(),
                "deal_id":     d["id"],
                "date":        d.get("paid_at", d.get("created_at", ""))[:10],
                "product":     d.get("product_title", ""),
                "amount":      d.get("amount", "0"),
                "seller_name": "",
                "status":      "paid",
            })
        return invoices

    # ─────────────────────────────────────────
    # KYC DOCS
    # ─────────────────────────────────────────

    def save_kyc_doc(self, user_id: str, doc_type: str, file_url: str):
        now       = _now()
        field_map = {
            "aadhaar": "kyc_aadhaar",
            "pan":     "kyc_pan",
            "bank":    "kyc_bank_acc",
        }
        field = field_map.get(doc_type)
        if field:
            self._col("users").update_one(
                {"id": user_id},
                {"$set": {field: file_url, "kyc_submitted_at": now}}
            )
        self._col("kyc_docs").update_one(
            {"user_id": user_id, "doc_type": doc_type},
            {"$set": {
                "id":         _new_id("kyc_docs"),
                "user_id":    user_id,
                "doc_type":   doc_type,
                "file_url":   file_url,
                "status":     "submitted",
                "created_at": now,
            }},
            upsert=True
        )

    def get_kyc_docs(self, user_id: str) -> list:
        return list(self._col("kyc_docs").find({"user_id": user_id}, {"_id": 0}))

    def get_latest_kyc_doc(self, user_id: str, doc_type: str) -> dict | None:
        return _clean(self._col("kyc_docs").find_one(
            {"user_id": user_id, "doc_type": doc_type}
        ))

    # ─────────────────────────────────────────
    # OTP  (in-memory, 10 min TTL)
    # Key format:
    #   registration → "email:role"
    #   password reset → "reset:email:role"
    # ─────────────────────────────────────────

    def save_otp(self, key: str, otp: str, user_data: dict, ttl_minutes: int = 10):
        MongoDB._otp_store[key.lower()] = {
            "otp":        otp,
            "expires_at": datetime.utcnow() + timedelta(minutes=ttl_minutes),
            "user_data":  user_data,
        }

    def verify_otp(self, key: str, otp: str) -> dict | None:
        k     = key.lower()
        entry = MongoDB._otp_store.get(k)
        if not entry:
            return None
        if entry["otp"] != str(otp).strip():
            return None
        if datetime.utcnow() > entry["expires_at"]:
            del MongoDB._otp_store[k]
            return None
        user_data = entry["user_data"]
        del MongoDB._otp_store[k]
        return user_data

    def clear_otp(self, key: str):
        MongoDB._otp_store.pop(key.lower(), None)

    # ─────────────────────────────────────────
    # TRANSPORT — VEHICLES
    # ─────────────────────────────────────────

    def register_vehicle(self, data: dict) -> str:
        vid = _new_id("vehicles")
        data["id"]         = vid
        data["created_at"] = _now()
        self._col("vehicles").insert_one(_strip_mongo(data))
        return vid

    def get_vehicles(self, transporter_id: str = "", available_only: bool = False,
                     city: str = "", page: int = 1, limit: int = 20) -> dict:
        query: dict = {}
        if transporter_id: query["transporter_id"] = transporter_id
        if available_only: query["available"]       = "true"
        if city:           query["current_city"]    = {"$regex": city, "$options": "i"}
        total = self._col("vehicles").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(self._col("vehicles").find(query, {"_id": 0}).skip(skip).limit(limit))
        return {"rows": rows, "total": total}

    def get_vehicle(self, vehicle_id: str) -> dict | None:
        return _clean(self._col("vehicles").find_one({"id": vehicle_id}))

    def update_vehicle(self, vehicle_id: str, updates: dict):
        self._col("vehicles").update_one({"id": vehicle_id}, {"$set": updates})

    # ─────────────────────────────────────────
    # TRANSPORT — REQUESTS
    # ─────────────────────────────────────────

    def create_transport_request(self, data: dict) -> str:
        rid = _new_id("transport_requests")
        data["id"]         = rid
        data["created_at"] = _now()
        self._col("transport_requests").insert_one(_strip_mongo(data))
        return rid

    def get_transport_requests(self, seller_id: str = "", status: str = "",
                                pickup_city: str = "", delivery_city: str = "",
                                page: int = 1, limit: int = 20) -> dict:
        query: dict = {}
        if seller_id:     query["seller_id"]    = seller_id
        if status:        query["status"]        = status
        if pickup_city:   query["pickup_city"]   = {"$regex": pickup_city,   "$options": "i"}
        if delivery_city: query["delivery_city"] = {"$regex": delivery_city, "$options": "i"}
        total = self._col("transport_requests").count_documents(query)
        skip  = (page - 1) * limit
        rows  = list(
            self._col("transport_requests")
            .find(query, {"_id": 0})
            .sort("created_at", DESCENDING)
            .skip(skip).limit(limit)
        )
        return {"rows": rows, "total": total}

    def get_transport_request(self, request_id: str) -> dict | None:
        return _clean(self._col("transport_requests").find_one({"id": request_id}))

    def update_transport_request(self, request_id: str, updates: dict):
        self._col("transport_requests").update_one(
            {"id": request_id}, {"$set": updates}
        )

    # ─────────────────────────────────────────
    # TRANSPORT — BIDS
    # ─────────────────────────────────────────

    def create_transport_bid(self, data: dict) -> str:
        bid_id = _new_id("transport_bids")
        data["id"]         = bid_id
        data["created_at"] = _now()
        self._col("transport_bids").insert_one(_strip_mongo(data))
        return bid_id

    def get_transport_bids(self, request_id: str = "", transporter_id: str = "") -> list:
        query: dict = {}
        if request_id:     query["request_id"]    = request_id
        if transporter_id: query["transporter_id"] = transporter_id
        return list(
            self._col("transport_bids")
            .find(query, {"_id": 0})
            .sort("price_inr", ASCENDING)
        )

    def update_transport_bid(self, bid_id: str, updates: dict):
        self._col("transport_bids").update_one({"id": bid_id}, {"$set": updates})

    # ─────────────────────────────────────────
    # ANALYTICS
    # ─────────────────────────────────────────

    def get_platform_analytics(self) -> dict:
        top_categories = list(self._col("listings").aggregate([
            {"$group": {"_id": "$category", "count": {"$sum": 1},
                        "avg_price": {"$avg": {"$toDouble": "$min_price"}}}},
            {"$sort":  {"count": -1}},
            {"$limit": 8},
        ]))
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).isoformat()
        deals_trend = list(self._col("deals").aggregate([
            {"$match": {"created_at": {"$gte": thirty_days_ago}}},
            {"$group": {
                "_id":   {"$substr": ["$created_at", 0, 10]},
                "count": {"$sum": 1},
                "value": {"$sum": {"$toDouble": "$amount"}},
            }},
            {"$sort": {"_id": 1}},
        ]))
        top_cities = list(self._col("listings").aggregate([
            {"$group": {"_id": "$city", "listings": {"$sum": 1}}},
            {"$sort":  {"listings": -1}},
            {"$limit": 6},
        ]))
        total_deals_value = list(self._col("deals").aggregate([
            {"$match": {"payment_status": "in_escrow"}},
            {"$group": {"_id": None, "total": {"$sum": {"$toDouble": "$amount"}}}},
        ]))
        gmv = total_deals_value[0]["total"] if total_deals_value else 0
        return {
            "top_categories": [
                {"category": c["_id"] or "Other",
                 "count": c["count"],
                 "avg_price": round(c["avg_price"] or 0, 2)}
                for c in top_categories
            ],
            "deals_trend": [
                {"date": d["_id"], "deals": d["count"],
                 "value": round(d["value"] or 0, 2)}
                for d in deals_trend
            ],
            "top_cities": [
                {"city": c["_id"] or "Unknown", "listings": c["listings"]}
                for c in top_cities
            ],
            "gmv":              round(gmv, 2),
            "platform_revenue": round(gmv * 0.02, 2),
        }

    # ─────────────────────────────────────────
    # ADMIN HELPERS
    # ─────────────────────────────────────────

    def _read_all(self, collection_name: str) -> list:
        cname = collection_name.lower().replace(" ", "_")
        return list(self._col(cname).find({}, {"_id": 0, "password_hash": 0}))

    def admin_get_pending_kyc(self) -> list:
        return list(self._col("users").find(
            {"kyc_status": {"$in": ["submitted", "pending"]}},
            {"_id": 0, "password_hash": 0}
        ))

    def admin_get_pending_payouts(self) -> list:
        return list(self._col("deals").find(
            {"payment_status": "in_escrow",
             "escrow_status":  {"$nin": ["fulfilled", "released", "refunded"]}},
            {"_id": 0}
        ))


# ─────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────

def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _clean(doc: dict | None) -> dict | None:
    if doc is None:
        return None
    doc.pop("_id", None)
    doc.pop("password_hash", None)   # NEVER send password hash to API callers
    return doc


def _strip_mongo(data: dict) -> dict:
    data.pop("_id", None)
    return data

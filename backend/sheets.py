"""
TRADELINK — Google Sheets Database  (backend/sheets.py)

This is our entire database layer.
Google Sheets = our database.  gspread = Python library to read/write Sheets.

SHEET STRUCTURE (8 tabs in one Google Spreadsheet):
  1. Users         — all users (sellers + merchants)
  2. Listings      — all product listings
  3. Bids          — all bids placed
  4. Deals         — all confirmed deals
  5. Payments      — payment records (Razorpay)
  6. Payouts       — seller withdrawal records
  7. Notifications — in-app notification inbox
  8. KYC_Docs      — KYC document metadata

PERFORMANCE:
  - We use gspread's batch read to fetch entire sheets at once
  - Then filter in Python (avoids multiple API calls per query)
  - Sheet reads are cached for 30 seconds to reduce API calls
  - For high traffic (Step 6+): add Redis cache in front of this
"""

import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime
from config import settings
import uuid
import time
import os

# ─────────────────────────────────────────
# SCOPES — what permissions we need
# ─────────────────────────────────────────
SCOPES = [
    "https://spreadsheets.google.com/feeds",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# ─────────────────────────────────────────
# SHEET COLUMN DEFINITIONS
# Row 1 of each sheet is the header row.
# Column order must match exactly.
# ─────────────────────────────────────────

USERS_COLS = [
    "id", "firebase_uid", "email", "name", "business_name", "company_name",
    "role", "phone", "city", "state",
    "kyc_status", "kyc_aadhaar", "kyc_pan", "kyc_bank_acc", "kyc_ifsc", "kyc_gst",
    "kyc_submitted_at",
    "rating", "review_count",
    "created_at"
]

LISTINGS_COLS = [
    "id", "seller_id", "title", "category", "description",
    "quantity", "unit", "min_price",
    "expires_at", "city", "state",
    "status", "bid_count", "top_bid",
    "photo_url",
    "created_at"
]

BIDS_COLS = [
    "id", "listing_id", "merchant_id", "buyer_name", "buyer_city",
    "price_per_unit", "total_amount",
    "status",   # live | won | lost
    "created_at"
]

DEALS_COLS = [
    "id", "listing_id", "seller_id", "merchant_id", "bid_id",
    "product_title", "amount", "quantity", "unit",
    "pickup_city", "deliver_to",
    "status", "payment_status", "delivery_status", "timeline_status",
    "transporter_id", "transporter_name", "truck_number",
    "razorpay_payment_id", "razorpay_order_id",
    "buyer_confirmed",
    "confirmed_at", "paid_at", "pickup_at", "delivered_at", "payout_at",
    "created_at"
]

PAYMENTS_COLS = [
    "id", "deal_id", "seller_id", "merchant_id",
    "product_title", "amount",
    "razorpay_payment_id", "razorpay_order_id",
    "status",   # pay_pending | in_escrow | released
    "created_at"
]

PAYOUTS_COLS = [
    "id", "seller_id", "deal_id",
    "amount", "bank_account_id", "bank_name", "last4",
    "status",   # processing | completed | failed
    "razorpay_transfer_id",
    "created_at"
]

NOTIFICATIONS_COLS = [
    "id", "user_id", "type", "icon", "title", "message",
    "is_read",
    "created_at"
]

KYC_DOCS_COLS = [
    "id", "user_id", "doc_type", "file_url", "status",
    "reviewed_at", "created_at"
]

WATCHLIST_COLS = [
    "id", "merchant_id", "listing_id", "created_at"
]

# ── TRANSPORT TABLES ────────────────────────────────

# Vehicles registered by transporters
VEHICLES_COLS = [
    "id",                    # V... prefix
    "transporter_id",        # M... (merchant who is a transporter)
    "transporter_name",
    "vehicle_number",        # e.g. KA01AB1234
    "vehicle_type",          # mini_truck | medium_truck | large_truck | pickup | van
    "capacity_kg",           # max weight in kg
    "capacity_volume_cft",   # cubic feet (L x W x H)
    "length_ft", "width_ft", "height_ft",
    "current_city",
    "current_state",
    "available",             # true | false
    "description",           # transporter's own description
    "photo_url",
    "rating", "rating_count",
    "created_at"
]

# Transport requests posted by sellers
TRANSPORT_REQUESTS_COLS = [
    "id",                    # TR... prefix
    "seller_id",             # who posted this request
    "seller_name",
    "deal_id",               # linked deal (if came from bid acceptance)
    "title",                 # goods description
    "category",
    "quantity_kg",
    "volume_cft",
    "pickup_city",
    "pickup_state",
    "pickup_address",
    "pickup_lat", "pickup_lng",
    "delivery_city",
    "delivery_state",
    "delivery_address",
    "delivery_lat", "delivery_lng",
    "pickup_date",           # when goods are ready
    "budget_inr",            # max they want to pay (optional)
    "status",                # open | accepted | in_transit | delivered | cancelled
    "accepted_vehicle_id",   # which vehicle accepted
    "transporter_id",
    "transporter_name",
    "agreed_price_inr",      # final agreed transport price
    "payment_status",        # unpaid | in_escrow | fulfilled
    "razorpay_order_id",
    "razorpay_payment_id",
    "pickup_at",
    "delivered_at",
    "current_lat", "current_lng",   # live GPS from transporter
    "last_location_update",
    "tracking_notes",        # transporter updates (JSON array as string)
    "created_at"
]

# Transport bids — transporters bid on requests (reverse auction)
TRANSPORT_BIDS_COLS = [
    "id",
    "request_id",
    "vehicle_id",
    "transporter_id",
    "transporter_name",
    "vehicle_number",
    "vehicle_type",
    "price_inr",             # their quote
    "message",               # optional message to seller
    "status",                # pending | accepted | rejected
    "created_at"
]


# ─────────────────────────────────────────
# SHEETS DATABASE CLASS
# ─────────────────────────────────────────

class SheetsDB:
    """
    All database operations.
    One instance per request (FastAPI creates it fresh each time).
    """

    def __init__(self):
        self._client = None
        self._spreadsheet = None
        self._cache = {}          # { sheet_name: (timestamp, data) }
        self._cache_ttl = 30      # seconds — cache sheet reads for 30s

    def _connect(self):
        """Lazy connection — only connects when first needed."""
        if self._client:
            return

        sdk_path = settings.GOOGLE_SERVICE_ACCOUNT_JSON
        if not os.path.exists(sdk_path):
            raise RuntimeError(
                f"Google service account JSON not found at: {sdk_path}\n"
                "See README Step 2 for setup instructions."
            )

        creds = Credentials.from_service_account_file(sdk_path, scopes=SCOPES)
        self._client = gspread.authorize(creds)
        self._spreadsheet = self._client.open_by_key(settings.GOOGLE_SHEET_ID)

    def _sheet(self, name: str):
        """Returns a gspread Worksheet object by tab name."""
        self._connect()
        return self._spreadsheet.worksheet(name)

    def _read_all(self, sheet_name: str) -> list[dict]:
        """
        Reads ALL rows from a sheet as a list of dicts.
        Uses 30-second in-memory cache to avoid hammering the Sheets API.

        Each row becomes a dict: { column_name: value, ... }
        Row 1 (headers) is used as keys.
        Empty rows are skipped.
        """
        # Check cache
        cached = self._cache.get(sheet_name)
        if cached and (time.time() - cached[0]) < self._cache_ttl:
            return cached[1]

        ws   = self._sheet(sheet_name)
        rows = ws.get_all_records()   # gspread returns list of dicts automatically
        # Convert all values to strings (Sheets sometimes returns ints for numbers)
        result = [{k: str(v) for k, v in row.items()} for row in rows if any(row.values())]
        self._cache[sheet_name] = (time.time(), result)
        return result

    def _append(self, sheet_name: str, cols: list, row_dict: dict) -> str:
        """
        Appends a new row to a sheet.
        Assigns a new UUID as the 'id' field.
        Returns the new row's ID.
        """
        self._invalidate_cache(sheet_name)
        ws = self._sheet(sheet_name)

        # ID prefix by role or sheet name
        role   = row_dict.get("role", "")
        prefix_map = {
            "seller":    "S",
            "merchant":  "M",
            "transporter": "T",
            "vehicle":   "V",    # registered vehicles
            "transport": "TR",   # transport requests
        }
        prefix = prefix_map.get(role, "")
        row_id = prefix + str(uuid.uuid4())[:11].replace("-","")
        row_dict["id"] = row_id
        # Clean up role field if it was only used for prefix (not a real column)
        # But keep it for Users table where role IS a column
        if sheet_name not in ("Users",):
            row_dict.pop("role", None)
        row_dict.setdefault("created_at", datetime.utcnow().isoformat() + "Z")

        # Build row in column order
        row_values = [row_dict.get(col, "") for col in cols]
        ws.append_row(row_values, value_input_option="USER_ENTERED")
        return row_id

    def _update_row(self, sheet_name: str, cols: list, row_id: str, updates: dict):
        """
        Finds the row with matching 'id' and updates specified columns.
        """
        self._invalidate_cache(sheet_name)
        ws   = self._sheet(sheet_name)
        rows = ws.get_all_records()

        for i, row in enumerate(rows):
            if str(row.get("id")) == str(row_id):
                sheet_row = i + 2  # +1 for 1-indexing, +1 for header row
                for col_name, new_value in updates.items():
                    if col_name in cols:
                        col_idx = cols.index(col_name) + 1  # 1-indexed
                        ws.update_cell(sheet_row, col_idx, str(new_value))
                return
        raise ValueError(f"Row {row_id} not found in {sheet_name}")

    def _invalidate_cache(self, sheet_name: str):
        self._cache.pop(sheet_name, None)


    # ─────────────────────────────────────────
    # USERS
    # ─────────────────────────────────────────

    def find_user_by_email(self, email: str) -> dict | None:
        users = self._read_all("Users")
        return next((u for u in users if u["email"].lower() == email.lower()), None)

    def find_user_by_email_and_role(self, email: str, role: str) -> dict | None:
        """Finds user matching BOTH email and role — allows same email for seller+merchant."""
        users = self._read_all("Users")
        return next(
            (u for u in users
             if u["email"].lower() == email.lower() and u.get("role") == role),
            None
        )

    def find_user_by_firebase_uid(self, uid: str, role: str = "") -> dict | None:
        """
        Finds user by Firebase UID.
        If role is given (e.g. "seller" or "merchant"), it returns only the
        matching role. This allows one person to have both a seller AND
        merchant account under the same Firebase/Google login.
        """
        users = self._read_all("Users")
        matches = [u for u in users if u.get("firebase_uid") == uid]
        if not matches:
            return None
        if role:
            # Return the account matching the requested role
            return next((u for u in matches if u.get("role") == role), None)
        # No role filter — return the first match (backwards-compatible)
        return matches[0]

    def get_user_profile(self, user_id: str) -> dict | None:
        users = self._read_all("Users")
        user  = next((u for u in users if u["id"] == user_id), None)
        if not user:
            return None
        # Build KYC sub-object
        user["kyc"] = {
            "phone_verified":   bool(user.get("phone")),
            "email_verified":   True,
            "aadhaar_uploaded": bool(user.get("kyc_aadhaar")),
            "pan_uploaded":     bool(user.get("kyc_pan")),
            "bank_linked":      bool(user.get("kyc_bank_acc")),
            "approved":         user.get("kyc_status") == "verified",
            "submitted":        user.get("kyc_status") in ["submitted","verified"],
        }
        return user

    def get_user_field(self, user_id: str, field: str) -> str:
        user = self.get_user_profile(user_id)
        return user.get(field, "") if user else ""

    def create_user(self, data: dict) -> str:
        return self._append("Users", USERS_COLS, data)

    def update_user(self, user_id: str, updates: dict):
        self._update_row("Users", USERS_COLS, user_id, updates)

    def get_seller_rating(self, seller_id: str) -> dict:
        user = self.get_user_profile(seller_id)
        return {
            "rating": float(user.get("rating", 0)) if user else 0,
            "count":  int(user.get("review_count", 0)) if user else 0,
        }


    # ─────────────────────────────────────────
    # LISTINGS
    # ─────────────────────────────────────────

    def _filter_listings(self, rows, seller_id="", status="", category="", state="", search="") -> list:
        """Filter listings in Python after reading all from sheet."""
        result = rows

        if seller_id:
            result = [r for r in result if r.get("seller_id") == seller_id]

        if status:
            # status can be comma-separated e.g. "active,pending"
            statuses = [s.strip() for s in status.split(",")]
            result   = [r for r in result if r.get("status") in statuses]

        if category:
            result = [r for r in result if r.get("category", "").lower() == category.lower()]

        if state:
            result = [r for r in result if r.get("state", "").lower() == state.lower()]

        if search:
            q = search.lower()
            result = [r for r in result if
                q in r.get("title", "").lower() or
                q in r.get("category", "").lower() or
                q in r.get("city", "").lower()]

        return result

    def _sort_listings(self, rows, sort: str) -> list:
        """Sort listings by given sort key."""
        if sort == "created_at_desc":
            return sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)
        if sort == "expires_asc" or sort == "expires_at_asc":
            return sorted(rows, key=lambda r: r.get("expires_at",""))
        if sort == "bids_desc":
            return sorted(rows, key=lambda r: int(r.get("bid_count","0") or 0), reverse=True)
        if sort == "price_asc":
            return sorted(rows, key=lambda r: float(r.get("min_price","0") or 0))
        if sort == "created_desc":
            return sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)
        return rows

    def get_listings(self, seller_id="", page=1, limit=20, status="", category="", state="", search="", sort="created_at_desc") -> dict:
        """Paginated, filtered, sorted listings."""
        rows    = self._read_all("Listings")
        rows    = self._filter_listings(rows, seller_id=seller_id, status=status, category=category, state=state, search=search)
        rows    = self._sort_listings(rows, sort)
        total   = len(rows)
        start   = (page - 1) * limit
        rows    = rows[start:start + limit]
        return {"rows": rows, "total": total, "page": page, "limit": limit}

    def get_listings_raw(self, seller_id="", status="") -> list:
        rows = self._read_all("Listings")
        return self._filter_listings(rows, seller_id=seller_id, status=status)

    def get_listing(self, listing_id: str) -> dict | None:
        rows = self._read_all("Listings")
        return next((r for r in rows if r["id"] == listing_id), None)

    def create_listing(self, data: dict) -> str:
        return self._append("Listings", LISTINGS_COLS, data)

    def update_listing(self, listing_id: str, updates: dict):
        self._update_row("Listings", LISTINGS_COLS, listing_id, updates)

    def count_listings(self, seller_id="", status="") -> int:
        rows = self._read_all("Listings")
        return len(self._filter_listings(rows, seller_id=seller_id, status=status))


    # ─────────────────────────────────────────
    # BIDS
    # ─────────────────────────────────────────

    def get_bids_for_listing(self, listing_id: str, sort="price_desc") -> list:
        rows = self._read_all("Bids")
        bids = [r for r in rows if r.get("listing_id") == listing_id]
        if sort == "price_desc":
            bids = sorted(bids, key=lambda b: float(b.get("price_per_unit","0") or 0), reverse=True)
        return bids

    def get_bid(self, bid_id: str) -> dict | None:
        rows = self._read_all("Bids")
        return next((r for r in rows if r["id"] == bid_id), None)

    def create_bid(self, data: dict) -> str:
        return self._append("Bids", BIDS_COLS, data)

    def count_pending_bids(self, seller_id: str) -> int:
        """Count total live bids across all active listings for this seller."""
        active_listings = self.get_listings_raw(seller_id=seller_id, status="active")
        listing_ids     = {l["id"] for l in active_listings}
        all_bids        = self._read_all("Bids")
        return sum(1 for b in all_bids if b.get("listing_id") in listing_ids and b.get("status") == "live")

    def count_merchant_active_bids(self, merchant_id: str) -> int:
        all_bids = self._read_all("Bids")
        return sum(1 for b in all_bids if b.get("merchant_id") == merchant_id and b.get("status") == "live")

    def get_merchant_bids(self, merchant_id: str, page=1, limit=20, status="") -> dict:
        """Returns bids placed by a merchant, enriched with listing info."""
        all_bids = self._read_all("Bids")
        bids     = [b for b in all_bids if b.get("merchant_id") == merchant_id]

        # Get all relevant listings to enrich bid data
        all_listings = {l["id"]: l for l in self._read_all("Listings")}

        enriched = []
        for bid in bids:
            listing = all_listings.get(bid.get("listing_id"), {})
            top_bids = self.get_bids_for_listing(bid.get("listing_id",""), sort="price_desc")
            top_bid  = top_bids[0] if top_bids else None

            bid_status = "lost"
            if listing.get("status") == "active":
                bid_status = "live"
            elif top_bid and top_bid["merchant_id"] == merchant_id:
                bid_status = "won"
            else:
                bid_status = "outbid"

            enriched.append({
                **bid,
                "product_title": listing.get("title",""),
                "seller_name":   listing.get("seller_name",""),
                "unit":          listing.get("unit",""),
                "expires_at":    listing.get("expires_at",""),
                "top_bid":       top_bid["price_per_unit"] if top_bid else bid["price_per_unit"],
                "is_top_bid":    (top_bid and top_bid["merchant_id"] == merchant_id),
                "bid_status":    bid_status,
                "payment_status":listing.get("payment_status",""),
                "deal_id":       "",  # filled after deal created
                "listing_id":    bid.get("listing_id",""),
            })

        if status:
            enriched = [b for b in enriched if b.get("bid_status") == status]

        total = len(enriched)
        start = (page - 1) * limit
        return {"rows": enriched[start:start + limit], "total": total}


    # ─────────────────────────────────────────
    # DEALS
    # ─────────────────────────────────────────

    def get_deals(self, seller_id="", merchant_id="", page=1, limit=20, status="", sort="created_at_desc") -> dict:
        rows = self._read_all("Deals")
        if seller_id:
            rows = [r for r in rows if r.get("seller_id") == seller_id]
        if merchant_id:
            rows = [r for r in rows if r.get("merchant_id") == merchant_id]
        if status:
            rows = [r for r in rows if r.get("status") == status or r.get("delivery_status") == status or r.get("payment_status") == status]
        rows  = sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)
        total = len(rows)
        start = (page - 1) * limit
        return {"rows": rows[start:start + limit], "total": total}

    def get_deal(self, deal_id: str) -> dict | None:
        rows = self._read_all("Deals")
        return next((r for r in rows if r["id"] == deal_id), None)

    def get_deal_by_order_id(self, razorpay_order_id: str) -> dict | None:
        """Finds a deal by its Razorpay order ID — used by webhook handler."""
        rows = self._read_all("Deals")
        return next((r for r in rows if r.get("razorpay_order_id") == razorpay_order_id), None)

    def create_deal(self, data: dict) -> str:
        return self._append("Deals", DEALS_COLS, data)

    def update_deal(self, deal_id: str, updates: dict):
        self._update_row("Deals", DEALS_COLS, deal_id, updates)

    def count_deals(self, seller_id="", merchant_id="", status="") -> int:
        result = self.get_deals(seller_id=seller_id, merchant_id=merchant_id, status=status, limit=10000)
        return result["total"]


    # ─────────────────────────────────────────
    # PAYMENTS
    # ─────────────────────────────────────────

    def create_payment_record(self, deal_id, amount, razorpay_payment_id, status):
        deal = self.get_deal(deal_id)
        self._append("Payments", PAYMENTS_COLS, {
            "deal_id":              deal_id,
            "seller_id":            deal["seller_id"] if deal else "",
            "merchant_id":          deal["merchant_id"] if deal else "",
            "product_title":        deal["product_title"] if deal else "",
            "amount":               amount,
            "razorpay_payment_id":  razorpay_payment_id,
            "status":               status,
        })

    def get_seller_payments(self, seller_id: str, page=1, limit=20) -> dict:
        rows  = self._read_all("Payments")
        rows  = [r for r in rows if r.get("seller_id") == seller_id]
        rows  = sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)
        total_received  = sum(float(r.get("amount","0") or 0) for r in rows if r.get("status") == "released")
        pending_release = sum(float(r.get("amount","0") or 0) for r in rows if r.get("status") == "in_escrow")
        total_fees      = sum(float(r.get("amount","0") or 0) * 0.02 for r in rows if r.get("status") == "released")
        total = len(rows)
        start = (page - 1) * limit
        return {
            "rows":            rows[start:start + limit],
            "total":           total,
            "total_received":  total_received,
            "pending_release": pending_release,
            "total_fees":      round(total_fees, 2),
        }

    def get_merchant_payments(self, merchant_id: str, page=1, limit=20) -> dict:
        rows = self._read_all("Payments")
        rows = [r for r in rows if r.get("merchant_id") == merchant_id]
        rows = sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)

        # Find pending deals (pay_pending)
        all_deals    = self._read_all("Deals")
        pending_deals= [d for d in all_deals if d.get("merchant_id") == merchant_id and d.get("payment_status") == "pay_pending"]

        total_spent  = sum(float(r.get("amount","0") or 0) for r in rows)
        in_escrow    = sum(float(d.get("amount","0") or 0) for d in all_deals if d.get("merchant_id") == merchant_id and d.get("payment_status") == "in_escrow")
        pending_count= len(pending_deals)

        total = len(rows)
        start = (page - 1) * limit
        return {
            "rows":          rows[start:start + limit],
            "total":         total,
            "total_spent":   total_spent,
            "in_escrow":     in_escrow,
            "pending_count": pending_count,
            "pending_deals": pending_deals[:5],  # max 5 shown in UI banner
        }

    def sum_seller_earnings(self, seller_id: str) -> float:
        rows = self._read_all("Payments")
        rows = [r for r in rows if r.get("seller_id") == seller_id and r.get("status") == "released"]
        total = sum(float(r.get("amount","0") or 0) for r in rows)
        return round(total * 0.98, 2)  # after 2% fee

    def sum_merchant_spending(self, merchant_id: str) -> float:
        rows = self._read_all("Payments")
        rows = [r for r in rows if r.get("merchant_id") == merchant_id]
        return sum(float(r.get("amount","0") or 0) for r in rows)


    # ─────────────────────────────────────────
    # PAYOUTS
    # ─────────────────────────────────────────

    def create_payout_record(self, deal_id: str, seller_id: str, amount: float):
        """Called when delivery is confirmed — creates a 'ready' payout record."""
        self._append("Payouts", PAYOUTS_COLS, {
            "seller_id": seller_id,
            "deal_id":   deal_id,
            "amount":    round(float(amount) * 0.98, 2),  # 2% fee deducted
            "status":    "ready",
        })

    def create_payout_withdrawal(self, data: dict) -> str:
        return self._append("Payouts", PAYOUTS_COLS, data)

    def get_payout_data(self, seller_id: str) -> dict:
        payouts  = self._read_all("Payouts")
        sp       = [p for p in payouts if p.get("seller_id") == seller_id]
        ready    = sum(float(p.get("amount","0") or 0) for p in sp if p.get("status") == "ready")
        withdrawn= sum(float(p.get("amount","0") or 0) for p in sp if p.get("status") == "completed")
        balance  = ready - withdrawn

        # Bank accounts from KYC
        user     = self.get_user_profile(seller_id)
        accounts = []
        if user and user.get("kyc_bank_acc"):
            acc_num = user["kyc_bank_acc"]
            accounts = [{
                "id":        f"bank_{seller_id}",
                "bank_name": "Bank Account",
                "last4":     acc_num[-4:] if len(acc_num) >= 4 else acc_num,
                "primary":   True,
            }]

        history = sorted(sp, key=lambda p: p.get("created_at",""), reverse=True)[:10]
        settled_deals = sum(1 for p in sp if p.get("status") in ["ready","completed"])

        return {
            "available_balance": max(0, balance),
            "settled_deals":     settled_deals,
            "bank_accounts":     accounts,
            "payout_history":    history,
        }


    # ─────────────────────────────────────────
    # NOTIFICATIONS
    # ─────────────────────────────────────────

    def create_notification(self, user_id: str, type: str, icon: str, title: str, message: str):
        self._append("Notifications", NOTIFICATIONS_COLS, {
            "user_id": user_id,
            "type":    type,
            "icon":    icon,
            "title":   title,
            "message": message,
            "is_read": "false",
        })

    def create_notification_for_merchants(self, message: str, listing_id: str, category: str, state: str):
        """Sends notification to all merchants in the same state + category."""
        users = self._read_all("Users")
        merchants = [u for u in users if u.get("role") == "merchant" and u.get("state") == state]
        for m in merchants[:50]:  # cap at 50 to avoid too many writes
            self.create_notification(
                user_id=m["id"],
                type="system",
                icon="🏪",
                title="New listing in your area",
                message=message,
            )

    def get_notifications(self, user_id: str) -> list:
        rows = self._read_all("Notifications")
        rows = [r for r in rows if r.get("user_id") == user_id]
        return sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)[:50]

    def count_unread_notifications(self, user_id: str) -> int:
        rows = self._read_all("Notifications")
        return sum(1 for r in rows if r.get("user_id") == user_id and r.get("is_read","").lower() != "true")

    def mark_all_notifications_read(self, user_id: str):
        ws   = self._sheet("Notifications")
        rows = ws.get_all_records()
        for i, row in enumerate(rows):
            if str(row.get("user_id")) == user_id and str(row.get("is_read","")).lower() != "true":
                col_idx = NOTIFICATIONS_COLS.index("is_read") + 1
                ws.update_cell(i + 2, col_idx, "true")
        self._invalidate_cache("Notifications")


    # ─────────────────────────────────────────
    # WATCHLIST
    # ─────────────────────────────────────────

    def get_watchlist(self, merchant_id: str) -> list:
        rows     = self._read_all("Watchlist")
        rows     = [r for r in rows if r.get("merchant_id") == merchant_id]
        listing_ids = [r["listing_id"] for r in rows]
        all_listings = {l["id"]: l for l in self._read_all("Listings")}
        return [all_listings[lid] for lid in listing_ids if lid in all_listings]

    def is_in_watchlist(self, merchant_id: str, listing_id: str) -> bool:
        rows = self._read_all("Watchlist")
        return any(r.get("merchant_id") == merchant_id and r.get("listing_id") == listing_id for r in rows)

    def add_to_watchlist(self, merchant_id: str, listing_id: str):
        if not self.is_in_watchlist(merchant_id, listing_id):
            self._append("Watchlist", WATCHLIST_COLS, {
                "merchant_id": merchant_id,
                "listing_id":  listing_id,
            })

    def remove_from_watchlist(self, merchant_id: str, listing_id: str):
        self._invalidate_cache("Watchlist")
        ws   = self._sheet("Watchlist")
        rows = ws.get_all_records()
        for i, row in enumerate(rows):
            if str(row.get("merchant_id")) == merchant_id and str(row.get("listing_id")) == listing_id:
                ws.delete_rows(i + 2)
                return

    def count_watchlist(self, merchant_id: str) -> int:
        rows = self._read_all("Watchlist")
        return sum(1 for r in rows if r.get("merchant_id") == merchant_id)


    # ─────────────────────────────────────────
    # ACTIVITY FEED
    # ─────────────────────────────────────────

    def get_activity_feed(self, seller_id: str, limit: int = 8) -> list:
        """Combines recent bids, deals, and payments into one feed."""
        notifications = self.get_notifications(seller_id)
        return notifications[:limit]


    # ─────────────────────────────────────────
    # INVOICES
    # ─────────────────────────────────────────

    def get_invoices(self, merchant_id: str) -> list:
        deals = self._read_all("Deals")
        deals = [d for d in deals if d.get("merchant_id") == merchant_id and d.get("delivery_status") == "delivered"]
        invoices = []
        for i, deal in enumerate(deals):
            amount     = float(deal.get("amount","0") or 0)
            gst_amount = round(amount * 0.18, 2)  # 18% GST example
            invoices.append({
                "id":             deal["id"],
                "invoice_number": f"TL-INV-{deal['id'][:8].upper()}",
                "deal_id":        deal["id"],
                "product_title":  deal.get("product_title",""),
                "amount":         amount,
                "gst_amount":     gst_amount,
                "created_at":     deal.get("delivered_at",""),
            })
        return invoices


    # ─────────────────────────────────────────
    # KYC DOCUMENTS  (Step 3)
    # ─────────────────────────────────────────

    def save_kyc_doc(self, user_id: str, doc_type: str, file_url: str):
        """
        Saves a KYC document record to the KYC_Docs sheet.
        One row per document — user can upload multiple times (each gets its own row).
        The latest upload for each doc_type is considered current.
        """
        self._append("KYC_Docs", KYC_DOCS_COLS, {
            "user_id":  user_id,
            "doc_type": doc_type,
            "file_url": file_url,
            "status":   "pending",   # pending → approved or rejected by admin
        })

        # BUG FIX: use real USERS_COLS column names (kyc_aadhaar not kyc_aadhaar_uploaded)
        url_field_map = {
            "aadhaar":         "kyc_aadhaar",
            "pan":             "kyc_pan",
            "gst_certificate": "kyc_gst",
        }
        if doc_type in url_field_map:
            try:
                self.update_user(user_id, {url_field_map[doc_type]: file_url})
            except Exception as _e:
                print(f"[KYC] Warning: could not update user field: {_e}")

        # Auto-advance kyc_status to submitted once aadhaar + pan are uploaded
        try:
            existing_docs  = self.get_kyc_docs(user_id)
            uploaded_types = {d.get("doc_type") for d in existing_docs}
            uploaded_types.add(doc_type)
            user = self.get_user_profile(user_id)
            if user:
                has_aadhaar = "aadhaar" in uploaded_types
                has_pan     = "pan"     in uploaded_types
                has_bank    = bool(user.get("kyc_bank_acc") or user.get("kyc_ifsc"))
                if has_aadhaar and has_pan and has_bank:
                    if user.get("kyc_status","unverified") not in ("submitted","verified"):
                        self.update_user(user_id, {"kyc_status": "submitted"})
        except Exception as _e2:
            print(f"[KYC] Warning: could not auto-advance kyc_status: {_e2}")

    def get_kyc_docs(self, user_id: str) -> list:
        """
        Returns all KYC documents uploaded by a user.
        Sorted newest first. The admin sees these when reviewing KYC.
        """
        rows = self._read_all("KYC_Docs")
        rows = [r for r in rows if r.get("user_id") == user_id]
        return sorted(rows, key=lambda r: r.get("created_at", ""), reverse=True)

    def get_latest_kyc_doc(self, user_id: str, doc_type: str) -> dict | None:
        """Returns the most recent upload of a specific doc type."""
        docs = self.get_kyc_docs(user_id)
        return next((d for d in docs if d.get("doc_type") == doc_type), None)

    # ─────────────────────────────────────────
    # EMAIL OTP STORAGE (in-memory, 10 min TTL)
    # ─────────────────────────────────────────

    # Class-level dict so it persists across SheetsDB() instances in same process
    _otp_store: dict = {}

    def save_otp(self, email: str, otp: str, user_data: dict, ttl_minutes: int = 10):
        """Save OTP with expiry for this email."""
        from datetime import datetime, timedelta
        SheetsDB._otp_store[email.lower()] = {
            "otp":        otp,
            "expires_at": datetime.utcnow() + timedelta(minutes=ttl_minutes),
            "user_data":  user_data,
        }

    def verify_otp(self, email: str, otp: str) -> dict | None:
        """
        Verify OTP for email.
        Returns user_data dict if correct and not expired.
        Returns None if wrong or expired.
        Deletes OTP after first successful use.
        """
        from datetime import datetime
        key = email.lower()
        entry = SheetsDB._otp_store.get(key)
        if not entry:
            return None
        if entry["otp"] != str(otp).strip():
            return None
        if datetime.utcnow() > entry["expires_at"]:
            del SheetsDB._otp_store[key]
            return None
        user_data = entry["user_data"]
        del SheetsDB._otp_store[key]   # one-time use
        return user_data

    def clear_otp(self, email: str):
        """Remove OTP entry."""
        SheetsDB._otp_store.pop(email.lower(), None)


    # ═════════════════════════════════════════
    # TRANSPORT — VEHICLES
    # ═════════════════════════════════════════

    def register_vehicle(self, data: dict) -> str:
        """Register a new transport vehicle. ID starts with V."""
        data["role"] = "vehicle"   # so _append gives V prefix
        vid = self._append("Vehicles", VEHICLES_COLS, data)
        return vid

    def get_vehicles(self, transporter_id: str = "", available_only: bool = False,
                     city: str = "", page: int = 1, limit: int = 20) -> dict:
        rows = self._read_all("Vehicles")
        if transporter_id:
            rows = [r for r in rows if r.get("transporter_id") == transporter_id]
        if available_only:
            rows = [r for r in rows if r.get("available", "true").lower() == "true"]
        if city:
            rows = [r for r in rows if r.get("current_city", "").lower() == city.lower()]
        total = len(rows)
        start = (page - 1) * limit
        return {"rows": rows[start:start+limit], "total": total}

    def get_vehicle(self, vehicle_id: str) -> dict | None:
        rows = self._read_all("Vehicles")
        return next((r for r in rows if r.get("id") == vehicle_id), None)

    def update_vehicle(self, vehicle_id: str, updates: dict):
        self._update_row("Vehicles", VEHICLES_COLS, vehicle_id, updates)

    # ═════════════════════════════════════════
    # TRANSPORT — REQUESTS
    # ═════════════════════════════════════════

    def create_transport_request(self, data: dict) -> str:
        data["role"] = "transport"   # so _append gives T prefix (no prefix defined — will use T)
        # Override: use TR prefix
        rid = self._append("Transport_Requests", TRANSPORT_REQUESTS_COLS, data)
        return rid

    def get_transport_requests(self, seller_id: str = "", status: str = "",
                                pickup_city: str = "", delivery_city: str = "",
                                page: int = 1, limit: int = 20) -> dict:
        rows = self._read_all("Transport_Requests")
        if seller_id:
            rows = [r for r in rows if r.get("seller_id") == seller_id]
        if status:
            rows = [r for r in rows if r.get("status") == status]
        if pickup_city:
            rows = [r for r in rows if pickup_city.lower() in r.get("pickup_city","").lower()]
        if delivery_city:
            rows = [r for r in rows if delivery_city.lower() in r.get("delivery_city","").lower()]
        rows = sorted(rows, key=lambda r: r.get("created_at",""), reverse=True)
        total = len(rows)
        start = (page - 1) * limit
        return {"rows": rows[start:start+limit], "total": total}

    def get_transport_request(self, request_id: str) -> dict | None:
        rows = self._read_all("Transport_Requests")
        return next((r for r in rows if r.get("id") == request_id), None)

    def update_transport_request(self, request_id: str, updates: dict):
        self._update_row("Transport_Requests", TRANSPORT_REQUESTS_COLS, request_id, updates)

    # ═════════════════════════════════════════
    # TRANSPORT — BIDS
    # ═════════════════════════════════════════

    def create_transport_bid(self, data: dict) -> str:
        return self._append("Transport_Bids", TRANSPORT_BIDS_COLS, data)

    def get_transport_bids(self, request_id: str = "", transporter_id: str = "") -> list:
        rows = self._read_all("Transport_Bids")
        if request_id:
            rows = [r for r in rows if r.get("request_id") == request_id]
        if transporter_id:
            rows = [r for r in rows if r.get("transporter_id") == transporter_id]
        return sorted(rows, key=lambda r: float(r.get("price_inr","0") or 0))

    def update_transport_bid(self, bid_id: str, updates: dict):
        self._update_row("Transport_Bids", TRANSPORT_BIDS_COLS, bid_id, updates)
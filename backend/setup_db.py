"""
TRADELINK — MongoDB Index Setup  (backend/setup_db.py)

Run ONCE after connecting MongoDB to create all indexes.
Indexes make queries fast — without them MongoDB does full collection scans.

Run:
    cd backend
    python setup_db.py
"""

from pymongo import MongoClient, ASCENDING, DESCENDING, TEXT
from config import settings


def setup():
    print("Connecting to MongoDB...")
    client = MongoClient(settings.MONGODB_URI)
    db     = client[settings.MONGODB_DB_NAME]
    print(f"Connected → database: {settings.MONGODB_DB_NAME}")

    # ─────────────────────────────────────────
    # USERS
    # ─────────────────────────────────────────
    users = db["users"]
    users.create_index([("email", ASCENDING)],         unique=True, sparse=True, name="email_unique")
    users.create_index([("firebase_uid", ASCENDING)],              name="firebase_uid")
    users.create_index([("firebase_uid", ASCENDING), ("role", ASCENDING)], name="uid_role")
    users.create_index([("role", ASCENDING), ("kyc_status", ASCENDING)],   name="role_kyc")
    users.create_index([("role", ASCENDING), ("state", ASCENDING)],        name="role_state")
    print("✅ users indexes created")

    # ─────────────────────────────────────────
    # LISTINGS
    # ─────────────────────────────────────────
    listings = db["listings"]
    listings.create_index([("seller_id", ASCENDING)],                         name="seller_id")
    listings.create_index([("status", ASCENDING)],                            name="status")
    listings.create_index([("status", ASCENDING), ("category", ASCENDING)],   name="status_category")
    listings.create_index([("status", ASCENDING), ("state", ASCENDING)],      name="status_state")
    listings.create_index([("expires_at", ASCENDING)],                        name="expires_at")
    listings.create_index([("created_at", DESCENDING)],                       name="created_at_desc")
    listings.create_index([("title", TEXT), ("description", TEXT)],           name="full_text_search")
    print("✅ listings indexes created")

    # ─────────────────────────────────────────
    # BIDS
    # ─────────────────────────────────────────
    bids = db["bids"]
    bids.create_index([("listing_id", ASCENDING)],                            name="listing_id")
    bids.create_index([("merchant_id", ASCENDING)],                           name="merchant_id")
    bids.create_index([("listing_id", ASCENDING), ("price_per_unit", DESCENDING)], name="listing_price")
    bids.create_index([("status", ASCENDING)],                                name="status")
    print("✅ bids indexes created")

    # ─────────────────────────────────────────
    # DEALS
    # ─────────────────────────────────────────
    deals = db["deals"]
    deals.create_index([("seller_id", ASCENDING)],                            name="seller_id")
    deals.create_index([("merchant_id", ASCENDING)],                          name="merchant_id")
    deals.create_index([("payment_status", ASCENDING)],                       name="payment_status")
    deals.create_index([("escrow_status", ASCENDING)],                        name="escrow_status")
    deals.create_index([("razorpay_order_id", ASCENDING)],                    name="razorpay_order_id")
    deals.create_index([("created_at", DESCENDING)],                          name="created_at_desc")
    # Compound index for admin pending payout query
    deals.create_index(
        [("payment_status", ASCENDING), ("escrow_status", ASCENDING)],
        name="payment_escrow"
    )
    print("✅ deals indexes created")

    # ─────────────────────────────────────────
    # PAYMENTS
    # ─────────────────────────────────────────
    db["payments"].create_index([("seller_id",   ASCENDING)], name="seller_id")
    db["payments"].create_index([("merchant_id", ASCENDING)], name="merchant_id")
    db["payments"].create_index([("deal_id",     ASCENDING)], name="deal_id")
    print("✅ payments indexes created")

    # ─────────────────────────────────────────
    # NOTIFICATIONS
    # ─────────────────────────────────────────
    notifications = db["notifications"]
    notifications.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)], name="user_created")
    notifications.create_index([("user_id", ASCENDING), ("is_read", ASCENDING)],     name="user_unread")
    print("✅ notifications indexes created")

    # ─────────────────────────────────────────
    # WATCHLIST
    # ─────────────────────────────────────────
    db["watchlist"].create_index(
        [("merchant_id", ASCENDING), ("listing_id", ASCENDING)],
        unique=True, name="merchant_listing_unique"
    )
    print("✅ watchlist indexes created")

    # ─────────────────────────────────────────
    # KYC DOCS
    # ─────────────────────────────────────────
    db["kyc_docs"].create_index([("user_id", ASCENDING), ("doc_type", ASCENDING)], name="user_doctype")
    print("✅ kyc_docs indexes created")

    # ─────────────────────────────────────────
    # PAYOUTS
    # ─────────────────────────────────────────
    db["payouts"].create_index([("seller_id", ASCENDING)], name="seller_id")
    db["payouts"].create_index([("deal_id",   ASCENDING)], name="deal_id")
    print("✅ payouts indexes created")

    # ─────────────────────────────────────────
    # VEHICLES
    # ─────────────────────────────────────────
    vehicles = db["vehicles"]
    vehicles.create_index([("transporter_id", ASCENDING)],           name="transporter_id")
    vehicles.create_index([("available", ASCENDING)],                 name="available")
    vehicles.create_index([("current_city", ASCENDING)],              name="current_city")
    vehicles.create_index([("available", ASCENDING), ("current_city", ASCENDING)], name="available_city")
    print("✅ vehicles indexes created")

    # ─────────────────────────────────────────
    # TRANSPORT REQUESTS
    # ─────────────────────────────────────────
    tr = db["transport_requests"]
    tr.create_index([("seller_id",    ASCENDING)],                    name="seller_id")
    tr.create_index([("status",       ASCENDING)],                    name="status")
    tr.create_index([("transporter_id", ASCENDING)],                  name="transporter_id")
    tr.create_index([("pickup_city",  ASCENDING), ("status", ASCENDING)], name="pickup_status")
    tr.create_index([("delivery_city", ASCENDING), ("status", ASCENDING)], name="delivery_status")
    tr.create_index([("created_at",   DESCENDING)],                   name="created_at_desc")
    print("✅ transport_requests indexes created")

    # ─────────────────────────────────────────
    # TRANSPORT BIDS
    # ─────────────────────────────────────────
    tb = db["transport_bids"]
    tb.create_index([("request_id",    ASCENDING), ("price_inr", ASCENDING)], name="request_price")
    tb.create_index([("transporter_id", ASCENDING)], name="transporter_id")
    print("✅ transport_bids indexes created")

    print("\n🎉 All MongoDB indexes created successfully!")
    print(f"   Database: {settings.MONGODB_DB_NAME}")
    print(f"   Collections: {db.list_collection_names()}")
    client.close()


if __name__ == "__main__":
    setup()
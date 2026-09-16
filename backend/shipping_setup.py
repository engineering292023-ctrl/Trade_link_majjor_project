"""
TRADELINK — Shipping Setup Guide
=================================

STEP 1 — Add to backend/.env
Add these 2 lines to your existing .env file:

AFTERSHIP_API_KEY=your_key_here
# Get FREE key: https://www.aftership.com → Sign Up → Settings → API Keys
# Free plan: unlimited tracking, 500+ couriers including BlueDart

STEP 2 — Add to backend/config.py (inside the Settings class)
Add this line after RAZORPAY_WEBHOOK_SECRET:

    AFTERSHIP_API_KEY: str = ""


STEP 3 — Add to backend/requirements.txt
Add this line:

    httpx==0.27.0


STEP 4 — Add to backend/main.py
Find the line: from admin import router as admin_router
Add BELOW it:

    from shipping_router import router as shipping_router

Find the line: app.include_router(admin_router)
Add BELOW it:

    app.include_router(shipping_router)


STEP 5 — Add new columns to Transport_Requests in Google Sheets
Run: python setup_sheets_shipping.py
(This adds 3 new columns: courier_slug, tracking_number, aftership_tracking_url)

If you prefer manual: open your Google Sheet → Transport_Requests tab
Add these column headers at the end of row 1:
  courier_slug | tracking_number | aftership_tracking_url


STEP 6 — Add to seller-portal/index.html
Inside <head>:

  <!-- Leaflet Maps (free, no API key) -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <!-- Razorpay -->
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>

Before </body>:

  <script src="shipping.js"></script>


STEP 7 — Add "My Shipments" and "Book Shipment" nav items to seller-portal/index.html
Find the nav section and add:

  <div class="nav-item" onclick="navigate('my-shipments', this)">
    <span class="nav-icon">📦</span> My Shipments
  </div>
  <div class="nav-item" onclick="navigate('book-shipment', this)">
    <span class="nav-icon">🚚</span> Book Shipment
  </div>


STEP 8 — Add screens to seller-portal/index.html
Before </main>:

  <!-- MY SHIPMENTS SCREEN -->
  <div id="screen-my-shipments" class="screen">
    <div class="topbar">
      <div class="topbar-title">📦 My Shipments</div>
      <div class="topbar-sub">Track your booked deliveries · Live updates</div>
    </div>
    <div class="screen-body">
      <div style="display:flex;justify-content:flex-end;margin-bottom:16px;">
        <button class="btn primary" onclick="navigate('book-shipment')">
          + Book New Shipment
        </button>
      </div>
      <div id="my-shipments-list"></div>
    </div>
  </div>

  <!-- BOOK SHIPMENT SCREEN -->
  <div id="screen-book-shipment" class="screen">
    <div id="book-shipment-content"></div>
  </div>


STEP 9 — Add to navigate() function in seller.js
Find the navigate() function and add these cases:

  case 'my-shipments':
    loadMyShipments();
    break;
  case 'book-shipment':
    var bsc = document.getElementById('book-shipment-content');
    if (bsc) bsc.innerHTML = getBookShipmentScreenHTML();
    setTimeout(initBookShipmentScreen, 100);
    break;


STEP 10 — AfterShip Account Setup (5 minutes, free):
  1. Go to https://www.aftership.com/signup
  2. Sign up with your email (no credit card needed)
  3. Dashboard → Settings → API & Plugins → API Keys
  4. Click "Create API Key" → give it a name like "TradeLink Dev"
  5. Copy the key → paste in backend/.env as AFTERSHIP_API_KEY
  6. Done! Your AfterShip dashboard will now show all tracking entries.

  Test it: After booking a shipment, check:
    https://app.aftership.com/trackings
  Your test tracking numbers will appear there.


HOW THE COMPLETE FLOW WORKS:
═══════════════════════════════════════════════════════

  Seller Portal (seller.js + shipping.js)
    │
    │ navigate('book-shipment')
    ▼
  Book Shipment Screen loads
    │ Leaflet maps initialize (OpenStreetMap, free)
    │ Seller fills: goods, weight, pickup+delivery address
    │ Rate card updates live as they type
    ▼
  POST /api/shipping/calculate-rate
    │ Returns: ₹450 total (base + weight + fuel + GST)
    ▼
  Seller clicks "Book & Pay"
    │
    ▼
  POST /api/shipping/create-request
    │ Saves to Transport_Requests sheet, status=payment_pending
    ▼
  POST /api/shipping/create-payment
    │ Creates Razorpay order for ₹450
    │ Returns order_id
    ▼
  Razorpay Checkout opens in browser
    │ Seller pays with test card: 4111 1111 1111 1111
    │ CVV: any 3 digits, Expiry: any future date
    ▼
  Razorpay calls handler() with payment_id + signature
    │
    ▼
  POST /api/shipping/verify-payment
    │ 1. Verifies HMAC-SHA256 signature ✓
    │ 2. Generates tracking number: "123456789012" (BlueDart format)
    │ 3. POST to AfterShip API → creates tracking entry
    │ 4. Updates Transport_Requests sheet: status=booked, tracking_number=...
    │ 5. Creates in-app notification
    │ 6. Sends Email 1: "Payment received, processing..."
    │ 7. Sends Email 2: "Your tracking number is 123456789012"
    ▼
  Frontend shows success modal with tracking number
    │
    ▼
  Seller goes to My Shipments → sees shipment with "📦 Booked" status
    │ Clicks "📍 Track" button
    ▼
  GET /api/shipping/track/{request_id}
    │ Calls AfterShip API for live status
    │ Returns checkpoints, expected delivery date
    ▼
  Tracking modal shows live status
    └─ Link to https://track.aftership.com/bluedart/123456789012


RAZORPAY TEST CARDS:
  Card Number: 4111 1111 1111 1111
  Expiry:      Any future date (e.g. 12/26)
  CVV:         Any 3 digits (e.g. 123)
  OTP:         Enter any number when prompted


FILE LOCATIONS:
  backend/shipping.py          → AfterShip API + rate calculation + emails
  backend/shipping_router.py   → FastAPI routes
  TradeLink/seller-portal/shipping.js → Frontend form + maps + payment
"""

# This file is just documentation — no code to run.
# Follow the steps above to integrate shipping into TradeLink.
print("Read the comments in this file for integration steps.")
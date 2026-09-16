/**
 * TRADELINK — Real-Time Client  (shared/realtime.js)
 *
 * Connects the browser to the Socket.IO server on the backend.
 * Both seller.js and merchant.js call functions from this file.
 *
 * HOW TO USE IN seller.js / merchant.js:
 *   1. Call initRealtime(user) after login
 *   2. Call joinListing(listingId) when user opens a listing
 *   3. Call leaveListing(listingId) when user closes a listing
 *   4. The onXxx callbacks fire automatically when events arrive
 *
 * EVENTS THIS FILE HANDLES:
 *   new_bid       → seller sees new bid instantly on Live Bids screen
 *   outbid        → merchant sees "You were outbid!" toast instantly
 *   bid_accepted  → merchant sees "You won!" popup instantly
 *   auction_closed→ everyone watching sees "Auction closed" badge
 *   notification  → sidebar badge count updates instantly
 *   kyc_update    → KYC banner updates without page refresh
 */

'use strict';

// The Socket.IO client library is loaded via <script> tag in the HTML
// It creates a global `io` function we call here

var _socket       = null;   // the active Socket.IO connection
var _currentUser  = null;   // logged-in user object

// ─────────────────────────────────────────
// CONNECT
// ─────────────────────────────────────────

/**
 * initRealtime(user)
 * Call this right after login succeeds.
 * Connects to the WebSocket server and joins the user's personal room.
 *
 * @param {object} user - { id, name, role }
 */
function initRealtime(user) {
  if (!user || !user.id) return;
  _currentUser = user;

  // Disconnect old socket if exists (e.g. user logged out and back in)
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }

  // Connect to backend WebSocket
  // IMPORTANT: path must be '/ws' because that's where socket_app is mounted.
  // Socket.IO client appends '/socket.io' automatically, giving: /ws/socket.io
  _socket = io('http://localhost:8000', {
    path: '/ws/socket.io',
    auth: { user_id: user.id },
    transports: ['polling', 'websocket'],  // polling first — more reliable on localhost
    reconnection:         true,
    reconnectionAttempts: 10,
    reconnectionDelay:    2000,
  });

  // ── Connection events ─────────────────
  _socket.on('connect', function() {
    _tl_log('✅ Real-time connected.');

    // If seller — join their seller room for all listing bid updates
    if (user.role === 'seller') {
      _socket.emit('join_seller', { seller_id: user.id });
    }
  });

  _socket.on('disconnect', function(reason) {
    _tl_log('Real-time disconnected.');
    // Socket.IO auto-reconnects — no action needed
  });

  _socket.on('connect_error', function(err) {
    // Backend might not be running — silently ignore, page still works
    _tl_log('Real-time connection failed (page works normally):', err.message);
  });

  // ── Business events ────────────────────
  _socket.on('new_bid',        _onNewBid);
  _socket.on('outbid',         _onOutbid);
  _socket.on('bid_accepted',   _onBidAccepted);
  _socket.on('auction_closed', _onAuctionClosed);
  _socket.on('notification',   _onNotification);
  _socket.on('kyc_update',     _onKycUpdate);
}

/**
 * disconnectRealtime()
 * Call on logout.
 */
function disconnectRealtime() {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
  _currentUser = null;
}

// ─────────────────────────────────────────
// ROOM MANAGEMENT
// ─────────────────────────────────────────

/**
 * joinListing(listingId)
 * Call when user opens a listing detail modal.
 * Subscribes to real-time bid updates for that listing.
 */
function joinListing(listingId) {
  if (_socket && listingId) {
    _socket.emit('join_listing', { listing_id: listingId });
  }
}

/**
 * leaveListing(listingId)
 * Call when user closes the listing modal.
 */
function leaveListing(listingId) {
  if (_socket && listingId) {
    _socket.emit('leave_listing', { listing_id: listingId });
  }
}

// ─────────────────────────────────────────
// EVENT HANDLERS
// These fire when the server pushes an event to this browser.
// ─────────────────────────────────────────

/**
 * _onNewBid(data)
 * A new bid arrived on one of the seller's listings.
 * data = { listing_id, listing_title, buyer_name, price_per_unit,
 *           total_amount, unit, bid_count }
 *
 * What we do:
 * 1. Show a toast "New bid: ₹X/unit on [listing]"
 * 2. If seller is on Live Bids screen → refresh it
 * 3. Update the bid count badge in the sidebar
 */
function _onNewBid(data) {
  // Toast notification
  toast(
    '🔨 New bid: ₹' + data.price_per_unit + '/' + (data.unit || '') +
    ' on "' + (data.listing_title || 'your listing') + '"',
    'success',
    4000
  );

  // If the seller is currently viewing the Live Bids screen — reload it
  var bidsScreen = document.getElementById('screen-bids');
  if (bidsScreen && bidsScreen.classList.contains('active')) {
    // Small delay so the Sheets data has time to be written
    setTimeout(function() {
      if (typeof loadBids === 'function') loadBids();
    }, 800);
  }

  // Update sidebar bid badge
  var badge = document.getElementById('nav-badge-bids');
  if (badge) {
    var current = parseInt(badge.textContent) || 0;
    badge.textContent = current + 1;
  }

  // Update pending bids stat card if on dashboard
  var statEl = document.getElementById('stat-pending-bids');
  if (statEl && !statEl.classList.contains('loading')) {
    var val = parseInt(statEl.textContent) || 0;
    statEl.textContent = val + 1;
  }

  // If a listing modal is open showing this listing — refresh its bids
  var modalTitle = document.getElementById('modal-title');
  var overlay    = document.getElementById('modal-overlay');
  if (overlay && overlay.classList.contains('open') && data.listing_id) {
    setTimeout(function() {
      if (typeof openListingModal === 'function') {
        openListingModal(data.listing_id);
      }
    }, 800);
  }
}

/**
 * _onOutbid(data)
 * This merchant was outbid on a listing they were leading.
 * data = { listing_id, listing_title, new_top_bid, unit }
 *
 * What we do:
 * 1. Show a prominent "You were outbid!" toast
 * 2. If merchant is on My Bids screen — refresh it
 * 3. If the listing modal is open — update the bid display
 */
function _onOutbid(data) {
  // Prominent outbid toast — longer duration so they see it
  toast(
    '⚠️ You were outbid on "' + (data.listing_title || 'a listing') +
    '"! New top bid: ₹' + data.new_top_bid + '/' + (data.unit || ''),
    'warning',
    6000
  );

  // Refresh My Bids screen if open
  var bidsScreen = document.getElementById('screen-my-bids');
  if (bidsScreen && bidsScreen.classList.contains('active')) {
    setTimeout(function() {
      if (typeof loadMyBids === 'function') loadMyBids();
    }, 800);
  }

  // Refresh listing modal if it's showing this listing
  var overlay = document.getElementById('modal-overlay');
  if (overlay && overlay.classList.contains('open') && data.listing_id) {
    setTimeout(function() {
      if (typeof openListingModal === 'function') {
        openListingModal(data.listing_id);
      }
    }, 800);
  }
}

/**
 * _onBidAccepted(data)
 * Merchant won an auction — seller accepted their bid.
 * data = { deal_id, listing_title, amount, pay_deadline }
 *
 * What we do:
 * 1. Show a "You won!" celebration toast
 * 2. If on My Bids or My Deals — refresh
 * 3. Show a modal prompting them to pay
 */
function _onBidAccepted(data) {
  // Victory toast — 8 seconds so they definitely see it
  toast(
    '🏆 You won "' + (data.listing_title || 'the auction') +
    '"! Pay ₹' + (data.amount || '') + ' to confirm the deal.',
    'success',
    8000
  );

  // Refresh relevant screens
  setTimeout(function() {
    if (typeof loadMyBids  === 'function') loadMyBids();
    if (typeof loadMyDeals === 'function') loadMyDeals();
    if (typeof loadDashboardStats === 'function') loadDashboardStats();
  }, 1000);
}

/**
 * _onAuctionClosed(data)
 * An auction this user was watching has closed.
 * data = { listing_id, listing_title }
 */
function _onAuctionClosed(data) {
  toast(
    '🔒 Auction closed: "' + (data.listing_title || 'a listing') + '"',
    '',
    4000
  );

  // Refresh marketplace so the closed listing shows correct status
  setTimeout(function() {
    if (typeof loadMarketplace === 'function') loadMarketplace();
    if (typeof loadBids        === 'function') loadBids();
  }, 1000);
}

/**
 * _onNotification(data)
 * A new notification arrived for this user.
 * data = { type, icon, title, message }
 *
 * Updates the sidebar notification badge count instantly.
 */
function _onNotification(data) {
  // Increment notification badge in sidebar
  var badge = document.getElementById('nav-badge-notifs');
  if (badge) {
    var count = parseInt(badge.textContent) || 0;
    badge.textContent = count + 1;
  }

  // Show the notification dot on the bell icon
  var dot = document.getElementById('notif-dot');
  if (dot) dot.style.display = 'block';

  // If notifications screen is open — refresh it
  var notifScreen = document.getElementById('screen-notifications');
  if (notifScreen && notifScreen.classList.contains('active')) {
    setTimeout(function() {
      if (typeof loadNotifications === 'function') loadNotifications();
    }, 500);
  }
}

/**
 * _onKycUpdate(data)
 * Admin approved or rejected this user's KYC.
 * data = { status: "verified" | "rejected" }
 *
 * Updates the KYC banner on dashboard without page refresh.
 */
function _onKycUpdate(data) {
  var banner = document.getElementById('kyc-banner');
  if (banner) {
    if (data.status === 'verified') {
      banner.style.display = 'none';
      toast('✅ Your KYC has been approved! You can now receive payments.', 'success', 8000);
    } else if (data.status === 'rejected') {
      banner.style.display = 'flex';
      toast('❌ Your KYC was rejected. Check your email for details.', 'danger', 8000);
    }
  }
}
/**
 * TRADELINK — Shipping Module for Seller Portal
 * File: TradeLink/seller-portal/shipping.js
 *
 * This file handles the entire shipping flow in the seller portal:
 *   1. "Book Shipment" form — with map + manual address entry
 *   2. Rate calculation (live preview as they fill in details)
 *   3. Razorpay payment for shipping fee
 *   4. "My Shipments" screen — list of all bookings
 *   5. Live tracking screen per shipment
 *
 * HOW TO ADD TO seller-portal/index.html:
 *   Add this line before </body>:
 *   <script src="shipping.js"></script>
 *
 * LEAFLET MAP (free, no API key):
 *   Add to <head> in index.html:
 *   <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
 *   <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
 *
 * RAZORPAY:
 *   Add to <head> in index.html:
 *   <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
 */

'use strict';

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────

var _shippingState = {
  pickupLat:    null,
  pickupLng:    null,
  deliveryLat:  null,
  deliveryLng:  null,
  currentRate:  null,   // last rate calculation result
  currentReqId: null,   // request ID after creation
  pickupMap:    null,   // Leaflet map instance
  deliveryMap:  null,
  pickupMarker:    null,
  deliveryMarker:  null,
};


// ─────────────────────────────────────────
// SCREEN: MY SHIPMENTS
// Loads list of all seller's shipments
// ─────────────────────────────────────────

async function loadMyShipments() {
  if (!AppState.user) return;

  var container = document.getElementById('my-shipments-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-placeholder">Loading shipments...</div>';

  try {
    var res = await apiGet('shipping/requests/' + AppState.user.id);
    if (!res.data || !res.data.success) throw new Error('Failed to load');

    var requests = res.data.requests || [];
    if (requests.length === 0) {
      container.innerHTML = _emptyShipmentsHTML();
      return;
    }

    container.innerHTML = requests.map(_renderShipmentCard).join('');
  } catch (e) {
    container.innerHTML = '<div class="error-state">Could not load shipments. ' + e.message + '</div>';
  }
}

function _renderShipmentCard(req) {
  var statusColors = {
    'payment_pending': '#f59e0b',
    'booked':          '#3b82f6',
    'in_transit':      '#8b5cf6',
    'delivered':       '#10b981',
    'cancelled':       '#ef4444',
  };
  var color = statusColors[req.status] || '#6b7280';
  var statusLabel = {
    'payment_pending': '⏳ Payment Pending',
    'booked':          '📦 Booked',
    'in_transit':      '🚚 In Transit',
    'delivered':       '✅ Delivered',
    'cancelled':       '❌ Cancelled',
  }[req.status] || req.status;

  var trackBtn = req.tracking_number
    ? '<button class="btn primary sm" onclick="openTrackingModal(\'' + req.id + '\')">📍 Track</button>'
    : '';

  return `
    <div class="shipment-card" style="background:white;border:1px solid #e5e7eb;
         border-radius:12px;padding:18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
        <div>
          <div style="font-size:15px;font-weight:600;color:#111827;">${req.title || 'Shipment'}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            ${req.pickup_city || ''} → ${req.delivery_city || ''}
            &nbsp;·&nbsp; ${req.quantity_kg || ''}kg
          </div>
        </div>
        <span style="background:${color}20;color:${color};padding:4px 10px;
              border-radius:20px;font-size:11px;font-weight:600;">${statusLabel}</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
        <div style="font-size:12px;color:#6b7280;">
          📍 <strong style="color:#374151;">Pickup:</strong><br>
          <span style="font-size:11px;">${req.pickup_address || req.pickup_city || '-'}</span>
        </div>
        <div style="font-size:12px;color:#6b7280;">
          🏪 <strong style="color:#374151;">Delivery:</strong><br>
          <span style="font-size:11px;">${req.delivery_address || req.delivery_city || '-'}</span>
        </div>
      </div>

      ${req.tracking_number ? `
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;
           padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:13px;color:#166534;">📦 Tracking:</span>
        <span style="font-family:monospace;font-weight:700;color:#15803d;font-size:14px;">
          ${req.tracking_number}</span>
        <span style="font-size:11px;color:#6b7280;">via ${req.transporter_name || 'BlueDart'}</span>
      </div>` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:13px;color:#374151;">
          💰 <strong>₹${parseFloat(req.agreed_price_inr || 0).toLocaleString('en-IN')}</strong>
          &nbsp;·&nbsp;
          <span style="font-size:11px;color:#9ca3af;">
            ${new Date(req.created_at || '').toLocaleDateString('en-IN')}
          </span>
        </div>
        <div style="display:flex;gap:8px;">
          ${trackBtn}
          ${req.status === 'payment_pending' ? `
          <button class="btn primary sm"
            onclick="retryShippingPayment('${req.id}')">
            💳 Pay Now
          </button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function _emptyShipmentsHTML() {
  return `
    <div style="text-align:center;padding:48px 20px;color:#6b7280;">
      <div style="font-size:48px;margin-bottom:12px;">📦</div>
      <div style="font-size:17px;font-weight:600;color:#374151;margin-bottom:8px;">
        No shipments yet
      </div>
      <p style="font-size:14px;margin-bottom:20px;">
        Book your first shipment and we'll take care of the delivery.
      </p>
      <button class="btn primary" onclick="navigate('book-shipment')">
        + Book a Shipment
      </button>
    </div>
  `;
}


// ─────────────────────────────────────────
// SCREEN: BOOK SHIPMENT FORM
// ─────────────────────────────────────────

function initBookShipmentScreen() {
  /**
   * Called when seller navigates to the "Book Shipment" screen.
   * Initializes both Leaflet maps (pickup + delivery).
   * Binds the rate calculator to weight/city inputs.
   */
  _resetShippingState();

  // Give DOM time to render before initializing maps
  setTimeout(function() {
    _initPickupMap();
    _initDeliveryMap();
    _bindRateCalculator();
  }, 300);
}

function _resetShippingState() {
  _shippingState.pickupLat    = null;
  _shippingState.pickupLng    = null;
  _shippingState.deliveryLat  = null;
  _shippingState.deliveryLng  = null;
  _shippingState.currentRate  = null;
  _shippingState.currentReqId = null;
}

function _initPickupMap() {
  /**
   * Creates the pickup location Leaflet map.
   * Center: India (lat 20.5937, lng 78.9629)
   * User clicks on map to set pickup location.
   */
  var mapEl = document.getElementById('pickup-map');
  if (!mapEl || typeof L === 'undefined') return;

  // Destroy existing map if any
  if (_shippingState.pickupMap) {
    _shippingState.pickupMap.remove();
  }

  _shippingState.pickupMap = L.map('pickup-map').setView([20.5937, 78.9629], 5);

  // OpenStreetMap tiles (free, no API key)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(_shippingState.pickupMap);

  // Click to place marker
  _shippingState.pickupMap.on('click', function(e) {
    _setPickupLocation(e.latlng.lat, e.latlng.lng);
    _reverseGeocode(e.latlng.lat, e.latlng.lng, 'pickup');
  });

  // Show instruction
  _updateMapInstruction('pickup', 'Click on the map to set pickup location, or type address below');
}

function _initDeliveryMap() {
  var mapEl = document.getElementById('delivery-map');
  if (!mapEl || typeof L === 'undefined') return;

  if (_shippingState.deliveryMap) {
    _shippingState.deliveryMap.remove();
  }

  _shippingState.deliveryMap = L.map('delivery-map').setView([20.5937, 78.9629], 5);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(_shippingState.deliveryMap);

  _shippingState.deliveryMap.on('click', function(e) {
    _setDeliveryLocation(e.latlng.lat, e.latlng.lng);
    _reverseGeocode(e.latlng.lat, e.latlng.lng, 'delivery');
  });

  _updateMapInstruction('delivery', 'Click on the map to set delivery location, or type address below');
}

function _setPickupLocation(lat, lng) {
  _shippingState.pickupLat = lat;
  _shippingState.pickupLng = lng;

  // Remove old marker
  if (_shippingState.pickupMarker) {
    _shippingState.pickupMap.removeLayer(_shippingState.pickupMarker);
  }

  // Add green marker
  _shippingState.pickupMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="background:#1a6b3a;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">📍</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 32],
    })
  }).addTo(_shippingState.pickupMap);

  _updateMapInstruction('pickup', '✅ Pickup location set at ' + lat.toFixed(4) + ', ' + lng.toFixed(4));
}

function _setDeliveryLocation(lat, lng) {
  _shippingState.deliveryLat = lat;
  _shippingState.deliveryLng = lng;

  if (_shippingState.deliveryMarker) {
    _shippingState.deliveryMap.removeLayer(_shippingState.deliveryMarker);
  }

  _shippingState.deliveryMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="background:#1d4ed8;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">🏪</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 32],
    })
  }).addTo(_shippingState.deliveryMap);

  _updateMapInstruction('delivery', '✅ Delivery location set at ' + lat.toFixed(4) + ', ' + lng.toFixed(4));
}

function _reverseGeocode(lat, lng, type) {
  /**
   * Calls Nominatim (OpenStreetMap's free geocoding API) to get
   * the address text from lat/lng coordinates.
   * Fills in the address text field automatically after map click.
   */
  var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng;

  fetch(url, { headers: { 'Accept-Language': 'en' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var address = data.display_name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
      var city    = data.address ? (data.address.city || data.address.town || data.address.village || '') : '';
      var state   = data.address ? (data.address.state || '') : '';

      if (type === 'pickup') {
        var el = document.getElementById('pickup-address');
        if (el && !el.value) el.value = address;
        var cityEl = document.getElementById('pickup-city');
        if (cityEl && !cityEl.value && city) cityEl.value = city;
        var stateEl = document.getElementById('pickup-state');
        if (stateEl && !stateEl.value && state) stateEl.value = state;
      } else {
        var el2 = document.getElementById('delivery-address');
        if (el2 && !el2.value) el2.value = address;
        var cityEl2 = document.getElementById('delivery-city');
        if (cityEl2 && !cityEl2.value && city) cityEl2.value = city;
        var stateEl2 = document.getElementById('delivery-state');
        if (stateEl2 && !stateEl2.value && state) stateEl2.value = state;
      }

      // Recalculate rate if we have enough data
      _maybeCalculateRate();
    })
    .catch(function(e) {
      console.warn('Geocoding failed:', e);
    });
}

function _updateMapInstruction(type, text) {
  var el = document.getElementById(type + '-map-hint');
  if (el) el.textContent = text;
}

function _bindRateCalculator() {
  /**
   * Binds rate calculation to weight, pickup city, and delivery city fields.
   * Recalculates after 800ms of no typing (debounce).
   */
  var fields = ['weight-kg', 'pickup-city', 'delivery-city'];
  var timer;

  fields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', function() {
        clearTimeout(timer);
        timer = setTimeout(_maybeCalculateRate, 800);
      });
    }
  });
}

async function _maybeCalculateRate() {
  /**
   * Called whenever weight, pickup city, or delivery city changes.
   * Shows the rate breakdown card below the form.
   */
  var weightEl   = document.getElementById('weight-kg');
  var pickupEl   = document.getElementById('pickup-city');
  var deliveryEl = document.getElementById('delivery-city');

  if (!weightEl || !pickupEl || !deliveryEl) return;

  var weight   = parseFloat(weightEl.value);
  var pickup   = pickupEl.value.trim();
  var delivery = deliveryEl.value.trim();

  if (!weight || !pickup || !delivery || weight <= 0) {
    _hideRateCard();
    return;
  }

  try {
    var res = await apiPost('shipping/calculate-rate', {
      weight_kg:     weight,
      pickup_city:   pickup,
      delivery_city: delivery,
      courier:       'bluedart',
    });

    if (res.data && res.data.success) {
      _shippingState.currentRate = res.data.rate;
      _showRateCard(res.data.rate);
    }
  } catch (e) {
    // Silent fail — rate card stays hidden
  }
}

function _showRateCard(rate) {
  var card = document.getElementById('rate-preview-card');
  if (!card) return;

  card.style.display = 'block';
  card.innerHTML = `
    <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;color:#166534;">
          📦 ${rate.courier_name} — Rate Preview
        </div>
        <div style="font-size:20px;font-weight:800;color:#15803d;">
          ₹${rate.total_inr.toLocaleString('en-IN')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;color:#374151;">
        <div>Base rate: <strong>₹${rate.base_rate}</strong></div>
        <div>Weight charges: <strong>₹${rate.additional}</strong></div>
        <div>Fuel surcharge: <strong>₹${rate.fuel_surcharge}</strong></div>
        <div>GST (18%): <strong>₹${rate.gst}</strong></div>
      </div>
      <div style="margin-top:10px;font-size:12px;color:#6b7280;">
        ⏱ Estimated delivery: <strong>${rate.estimated_days}</strong>
        &nbsp;·&nbsp; Weight: <strong>${rate.weight_kg} kg</strong>
      </div>
    </div>
  `;
}

function _hideRateCard() {
  var card = document.getElementById('rate-preview-card');
  if (card) card.style.display = 'none';
}


// ─────────────────────────────────────────
// FORM SUBMISSION — BOOK SHIPMENT
// ─────────────────────────────────────────

async function submitBookShipment() {
  /**
   * Called when seller clicks "Book Shipment" button.
   * Validates form → creates request → opens Razorpay.
   */
  if (!AppState.user) { toast('Please log in first.', 'danger'); return; }

  // Collect form values
  var fields = {
    goods_description: document.getElementById('goods-description'),
    category:          document.getElementById('goods-category'),
    weight_kg:         document.getElementById('weight-kg'),
    pickup_address:    document.getElementById('pickup-address'),
    pickup_city:       document.getElementById('pickup-city'),
    pickup_state:      document.getElementById('pickup-state'),
    delivery_address:  document.getElementById('delivery-address'),
    delivery_city:     document.getElementById('delivery-city'),
    delivery_state:    document.getElementById('delivery-state'),
    pickup_date:       document.getElementById('pickup-date'),
  };

  // Validate required fields
  var errors = [];
  if (!fields.goods_description || !fields.goods_description.value.trim()) errors.push('Goods description');
  if (!fields.weight_kg         || !parseFloat(fields.weight_kg.value))   errors.push('Weight');
  if (!fields.pickup_address    || !fields.pickup_address.value.trim())   errors.push('Pickup address');
  if (!fields.pickup_city       || !fields.pickup_city.value.trim())      errors.push('Pickup city');
  if (!fields.delivery_address  || !fields.delivery_address.value.trim()) errors.push('Delivery address');
  if (!fields.delivery_city     || !fields.delivery_city.value.trim())    errors.push('Delivery city');
  if (!fields.pickup_date       || !fields.pickup_date.value)             errors.push('Pickup date');

  if (errors.length > 0) {
    toast('Please fill in: ' + errors.join(', '), 'danger');
    return;
  }

  // Confirm rate
  if (!_shippingState.currentRate) {
    toast('Calculating rate... please wait a moment.', 'warning');
    await _maybeCalculateRate();
    if (!_shippingState.currentRate) {
      toast('Could not calculate rate. Check pickup and delivery cities.', 'danger');
      return;
    }
  }

  var btn = document.getElementById('book-shipment-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating shipment...'; }

  try {
    // Step 1: Create the request in Sheets
    var res = await apiPost('shipping/create-request', {
      seller_id:        AppState.user.id,
      goods_description: fields.goods_description.value.trim(),
      category:         (fields.category && fields.category.value) || 'General',
      weight_kg:        parseFloat(fields.weight_kg.value),
      pickup_address:   fields.pickup_address.value.trim(),
      pickup_city:      fields.pickup_city.value.trim(),
      pickup_state:     (fields.pickup_state && fields.pickup_state.value.trim()) || '',
      pickup_lat:       _shippingState.pickupLat || 0,
      pickup_lng:       _shippingState.pickupLng || 0,
      delivery_address: fields.delivery_address.value.trim(),
      delivery_city:    fields.delivery_city.value.trim(),
      delivery_state:   (fields.delivery_state && fields.delivery_state.value.trim()) || '',
      delivery_lat:     _shippingState.deliveryLat || 0,
      delivery_lng:     _shippingState.deliveryLng || 0,
      pickup_date:      fields.pickup_date.value,
      courier:          'bluedart',
    });

    if (!res.data || !res.data.success) {
      throw new Error(res.data && res.data.detail ? res.data.detail : 'Failed to create shipment');
    }

    _shippingState.currentReqId = res.data.request_id;

    // Step 2: Create Razorpay order and open payment
    await _openShippingPayment(res.data.request_id, res.data.rate.total_inr);

  } catch (e) {
    toast('Error: ' + e.message, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💳 Book & Pay'; }
  }
}

async function _openShippingPayment(requestId, amountInr) {
  /**
   * Creates a Razorpay order and opens the payment checkout.
   * This is identical in pattern to how deals are paid.
   */
  try {
    var res = await apiPost('shipping/create-payment', {
      request_id: requestId,
      seller_id:  AppState.user.id,
    });

    if (!res.data || !res.data.success) {
      throw new Error('Could not create payment order');
    }

    var orderData = res.data;

    // Open Razorpay checkout
    var options = {
      key:         orderData.key_id,
      amount:      orderData.amount,   // paise
      currency:    'INR',
      name:        'TradeLink Shipping',
      description: 'Courier booking via BlueDart',
      order_id:    orderData.order_id,
      prefill: {
        name:  AppState.user.name  || '',
        email: AppState.user.email || '',
      },
      theme:       { color: '#1a6b3a' },
      handler:     function(response) {
        // Payment succeeded — verify on backend
        _verifyShippingPayment(
          requestId,
          response.razorpay_payment_id,
          response.razorpay_order_id,
          response.razorpay_signature
        );
      },
      modal: {
        ondismiss: function() {
          toast('Payment cancelled. You can pay later from My Shipments.', 'warning');
        }
      }
    };

    var rzp = new Razorpay(options);
    rzp.open();

  } catch (e) {
    toast('Payment error: ' + e.message, 'danger');
    throw e;
  }
}

async function _verifyShippingPayment(requestId, paymentId, orderId, signature) {
  /**
   * Called after Razorpay payment succeeds.
   * Backend verifies HMAC, books courier, sends emails.
   */
  var overlay = document.getElementById('payment-processing-overlay');
  if (overlay) overlay.style.display = 'flex';

  try {
    var res = await apiPost('shipping/verify-payment', {
      request_id:          requestId,
      seller_id:           AppState.user.id,
      razorpay_payment_id: paymentId,
      razorpay_order_id:   orderId,
      razorpay_signature:  signature,
    });

    if (!res.data || !res.data.success) {
      throw new Error(res.data && res.data.detail ? res.data.detail : 'Verification failed');
    }

    var result = res.data;

    // Show success modal
    _showShippingSuccessModal(result);

    // Refresh My Shipments
    setTimeout(loadMyShipments, 1000);

  } catch (e) {
    toast('Payment verification failed: ' + e.message, 'danger');
  } finally {
    if (overlay) overlay.style.display = 'none';
  }
}

function _showShippingSuccessModal(result) {
  /**
   * Shows a success popup after shipment is booked.
   * Displays tracking number prominently.
   */
  var modal = document.getElementById('shipping-success-modal');
  if (!modal) {
    // Create modal if it doesn't exist
    modal = document.createElement('div');
    modal.id = 'shipping-success-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;padding:36px;max-width:480px;width:100%;
         text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <div style="font-size:56px;margin-bottom:16px;">🎉</div>
      <h2 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px;">
        Shipment Booked!
      </h2>
      <p style="color:#6b7280;font-size:14px;margin-bottom:24px;">
        Your shipment has been confirmed. Check your email for details.
      </p>

      <!-- Tracking Number -->
      <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;
           padding:20px;margin-bottom:20px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;
             color:#16a34a;font-weight:600;margin-bottom:6px;">Your Tracking Number</div>
        <div style="font-family:monospace;font-size:24px;font-weight:800;color:#15803d;
             letter-spacing:0.05em;">${result.tracking_number || 'Processing...'}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">via ${result.courier || 'BlueDart Express'}</div>
      </div>

      <p style="font-size:13px;color:#6b7280;margin-bottom:20px;">
        📧 A confirmation email with your tracking number has been sent to your email address.
        Tracking updates begin after pickup (2-4 hours).
      </p>

      <div style="display:flex;gap:10px;justify-content:center;">
        <a href="${result.tracking_url || '#'}" target="_blank"
           style="background:#1a6b3a;color:white;padding:12px 24px;border-radius:8px;
                  text-decoration:none;font-weight:600;font-size:14px;">
          📍 Track Shipment
        </a>
        <button onclick="document.getElementById('shipping-success-modal').style.display='none';navigate('my-shipments')"
           style="background:#f3f4f6;color:#374151;padding:12px 24px;border-radius:8px;
                  border:none;cursor:pointer;font-weight:600;font-size:14px;">
          My Shipments
        </button>
      </div>
    </div>
  `;

  modal.style.display = 'flex';

  // Auto-close after 30 seconds
  setTimeout(function() {
    if (modal) modal.style.display = 'none';
  }, 30000);
}


// ─────────────────────────────────────────
// RETRY PAYMENT (for payment_pending requests)
// ─────────────────────────────────────────

async function retryShippingPayment(requestId) {
  /**
   * Called from My Shipments when status = payment_pending.
   * Re-opens Razorpay for the same request.
   */
  try {
    var res = await apiGet('shipping/request/' + requestId);
    if (!res.data || !res.data.success) throw new Error('Request not found');
    var req = res.data.request;
    await _openShippingPayment(requestId, parseFloat(req.agreed_price_inr || 0));
  } catch (e) {
    toast('Error: ' + e.message, 'danger');
  }
}


// ─────────────────────────────────────────
// TRACKING MODAL
// ─────────────────────────────────────────

async function openTrackingModal(requestId) {
  /**
   * Opens a modal showing live tracking status for a shipment.
   * Calls AfterShip via our backend.
   */
  var modal = document.getElementById('tracking-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tracking-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;padding:32px;max-width:540px;width:100%;
         max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h3 style="font-size:18px;font-weight:700;color:#111827;">📍 Live Tracking</h3>
        <button onclick="document.getElementById('tracking-modal').style.display='none'"
          style="background:none;border:none;font-size:20px;cursor:pointer;color:#6b7280;">✕</button>
      </div>
      <div id="tracking-modal-content" style="text-align:center;padding:24px 0;color:#6b7280;">
        <div style="font-size:32px;margin-bottom:8px;">⏳</div>
        Loading tracking info...
      </div>
    </div>
  `;
  modal.style.display = 'flex';

  // Fetch tracking data
  try {
    var res = await apiGet('shipping/track/' + requestId);
    var content = document.getElementById('tracking-modal-content');
    if (!content) return;

    if (!res.data || !res.data.success) {
      content.innerHTML = '<div style="color:#ef4444;">Could not fetch tracking info.</div>';
      return;
    }

    var d = res.data;
    var statusColors = {
      'Pending':        '#f59e0b',
      'InfoReceived':   '#3b82f6',
      'InTransit':      '#8b5cf6',
      'OutForDelivery': '#f97316',
      'Delivered':      '#10b981',
    };
    var color = statusColors[d.status] || '#6b7280';

    var checkpointsHTML = '';
    if (d.checkpoints && d.checkpoints.length > 0) {
      checkpointsHTML = '<div style="margin-top:20px;">' +
        '<div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:10px;">📋 Tracking History</div>' +
        d.checkpoints.slice().reverse().map(function(cp) {
          return `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f3f4f6;">
            <div style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:5px;flex-shrink:0;"></div>
            <div>
              <div style="font-size:13px;color:#374151;">${cp.message || ''}</div>
              <div style="font-size:11px;color:#9ca3af;margin-top:2px;">
                ${cp.location || ''} · ${cp.time ? new Date(cp.time).toLocaleString('en-IN') : ''}
              </div>
            </div>
          </div>`;
        }).join('') +
        '</div>';
    }

    content.innerHTML = `
      <!-- Status Badge -->
      <div style="text-align:center;margin-bottom:20px;">
        <div style="background:${color}15;color:${color};padding:8px 20px;border-radius:20px;
             font-size:14px;font-weight:600;display:inline-block;">${d.status_text || d.status}</div>
        ${d.expected_delivery ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;">
          Expected delivery: ${d.expected_delivery}</div>` : ''}
      </div>

      <!-- Tracking Number -->
      <div style="background:#f9fafb;border-radius:10px;padding:16px;text-align:center;margin-bottom:16px;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;">Tracking Number</div>
        <div style="font-family:monospace;font-size:20px;font-weight:700;color:#111827;margin-top:4px;">
          ${d.tracking_number}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">${d.courier || 'BlueDart'}</div>
      </div>

      <!-- Addresses -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:#f0fdf4;border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">📍 Pickup</div>
          <div style="font-size:12px;color:#374151;">${d.pickup_address || '-'}</div>
        </div>
        <div style="background:#eff6ff;border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">🏪 Delivery</div>
          <div style="font-size:12px;color:#374151;">${d.delivery_address || '-'}</div>
        </div>
      </div>

      ${checkpointsHTML}

      <div style="text-align:center;margin-top:16px;">
        <a href="${d.tracking_url || '#'}" target="_blank"
           style="background:#1a6b3a;color:white;padding:10px 24px;border-radius:8px;
                  text-decoration:none;font-size:13px;font-weight:600;">
          🔗 Track on AfterShip →
        </a>
        ${d.simulated ? '<div style="margin-top:8px;font-size:11px;color:#9ca3af;">⚠ Test mode — simulated tracking data</div>' : ''}
      </div>
    `;

  } catch (e) {
    var content2 = document.getElementById('tracking-modal-content');
    if (content2) content2.innerHTML = '<div style="color:#ef4444;">Error: ' + e.message + '</div>';
  }
}


// ─────────────────────────────────────────
// SCREEN HTML GENERATORS
// These return the HTML for each screen —
// call them from navigate() in seller.js
// ─────────────────────────────────────────

function getBookShipmentScreenHTML() {
  /**
   * Returns the complete HTML for the "Book Shipment" screen.
   * Paste this into seller-portal/index.html inside the <main> tag.
   * Or call this from navigate() to dynamically render it.
   */
  return `
    <div class="topbar">
      <div class="topbar-title">📦 Book a Shipment</div>
      <div class="topbar-sub">
        Door-to-door delivery via BlueDart · Pay securely via Razorpay
      </div>
    </div>
    <div class="screen-body" style="max-width:720px;">

      <!-- STEP INDICATOR -->
      <div style="display:flex;gap:0;margin-bottom:24px;background:#f9fafb;
           border-radius:10px;padding:4px;border:1px solid #e5e7eb;">
        <div style="flex:1;text-align:center;padding:10px;border-radius:8px;
             background:#1a6b3a;color:white;font-size:13px;font-weight:600;">
          1. Shipment Details
        </div>
        <div style="flex:1;text-align:center;padding:10px;font-size:13px;color:#6b7280;">
          2. Review Rate
        </div>
        <div style="flex:1;text-align:center;padding:10px;font-size:13px;color:#6b7280;">
          3. Pay & Confirm
        </div>
      </div>

      <!-- GOODS DETAILS -->
      <div class="form-section" style="background:white;border:1px solid #e5e7eb;
           border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="font-size:15px;font-weight:600;color:#111827;margin:0 0 16px;">
          📦 Goods Details
        </h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="grid-column:1/-1;">
            <label class="form-label">Description of Goods *</label>
            <input class="form-control" id="goods-description"
              placeholder="e.g. 50kg Premium Basmati Rice, Grade A">
          </div>
          <div>
            <label class="form-label">Category</label>
            <select class="form-control" id="goods-category">
              <option value="Grains">Grains & Cereals</option>
              <option value="Vegetables">Vegetables</option>
              <option value="Fruits">Fruits</option>
              <option value="Spices">Spices</option>
              <option value="Dairy">Dairy Products</option>
              <option value="Electronics">Electronics</option>
              <option value="Textiles">Textiles</option>
              <option value="General">General Goods</option>
            </select>
          </div>
          <div>
            <label class="form-label">Weight (kg) *</label>
            <input class="form-control" id="weight-kg" type="number"
              min="0.1" max="5000" step="0.1" placeholder="e.g. 50">
          </div>
        </div>
      </div>

      <!-- PICKUP LOCATION -->
      <div class="form-section" style="background:white;border:1px solid #e5e7eb;
           border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="font-size:15px;font-weight:600;color:#111827;margin:0 0 4px;">
          📍 Pickup Location
        </h3>
        <p style="font-size:12px;color:#6b7280;margin:0 0 14px;"
           id="pickup-map-hint">Click map to pin location, or type address below</p>

        <!-- Leaflet Map -->
        <div id="pickup-map"
          style="height:220px;border-radius:10px;border:1.5px solid #e5e7eb;
                 margin-bottom:14px;background:#f3f4f6;"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="grid-column:1/-1;">
            <label class="form-label">Full Pickup Address *</label>
            <textarea class="form-control" id="pickup-address" rows="2"
              placeholder="Door/Plot No., Street, Area, Landmark"></textarea>
          </div>
          <div>
            <label class="form-label">City *</label>
            <input class="form-control" id="pickup-city" placeholder="e.g. Mumbai">
          </div>
          <div>
            <label class="form-label">State</label>
            <input class="form-control" id="pickup-state" placeholder="e.g. Maharashtra">
          </div>
        </div>
      </div>

      <!-- DELIVERY LOCATION -->
      <div class="form-section" style="background:white;border:1px solid #e5e7eb;
           border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="font-size:15px;font-weight:600;color:#111827;margin:0 0 4px;">
          🏪 Delivery Location
        </h3>
        <p style="font-size:12px;color:#6b7280;margin:0 0 14px;"
           id="delivery-map-hint">Click map to pin location, or type address below</p>

        <div id="delivery-map"
          style="height:220px;border-radius:10px;border:1.5px solid #e5e7eb;
                 margin-bottom:14px;background:#f3f4f6;"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="grid-column:1/-1;">
            <label class="form-label">Full Delivery Address *</label>
            <textarea class="form-control" id="delivery-address" rows="2"
              placeholder="Door/Plot No., Street, Area, Landmark"></textarea>
          </div>
          <div>
            <label class="form-label">City *</label>
            <input class="form-control" id="delivery-city" placeholder="e.g. Delhi">
          </div>
          <div>
            <label class="form-label">State</label>
            <input class="form-control" id="delivery-state" placeholder="e.g. Delhi">
          </div>
        </div>
      </div>

      <!-- PICKUP DATE -->
      <div class="form-section" style="background:white;border:1px solid #e5e7eb;
           border-radius:12px;padding:20px;margin-bottom:16px;">
        <label class="form-label">📅 Goods Ready for Pickup *</label>
        <input class="form-control" id="pickup-date" type="date"
          style="max-width:240px;"
          min="${new Date().toISOString().split('T')[0]}">
      </div>

      <!-- RATE PREVIEW (shown after weight+cities filled) -->
      <div id="rate-preview-card" style="display:none;margin-bottom:16px;"></div>

      <!-- SUBMIT BUTTON -->
      <button id="book-shipment-btn" class="btn primary"
        onclick="submitBookShipment()"
        style="width:100%;padding:16px;font-size:16px;border-radius:10px;">
        💳 Book & Pay via Razorpay
      </button>

      <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:10px;">
        🔒 Payment secured by Razorpay · You'll receive a tracking email instantly after payment
      </p>

      <!-- Payment processing overlay -->
      <div id="payment-processing-overlay"
        style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);
               z-index:9998;align-items:center;justify-content:center;flex-direction:column;">
        <div style="background:white;border-radius:16px;padding:32px;text-align:center;">
          <div style="font-size:40px;margin-bottom:12px;">⏳</div>
          <div style="font-size:16px;font-weight:600;color:#111827;">Processing your shipment...</div>
          <div style="font-size:13px;color:#6b7280;margin-top:6px;">
            Booking courier · Generating tracking number · Sending email
          </div>
        </div>
      </div>
    </div>
  `;
}
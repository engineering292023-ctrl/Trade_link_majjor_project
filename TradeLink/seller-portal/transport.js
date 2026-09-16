/**
 * TRADELINK — Seller Transport Module  (seller-portal/transport.js)
 *
 * Handles:
 *  1. Transport request form popup — goods, quantity, pickup/delivery, date, budget
 *  2. My transport requests list — shows status, pay button, track button
 *  3. Payment via Razorpay when admin accepts request (status = processed)
 *  4. Live tracking modal using Leaflet map
 *
 * Add to seller-portal/index.html before </body>:
 *   <script src="transport.js"></script>
 *
 * Add to seller-portal/index.html <head>:
 *   <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
 *   <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
 *   <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
 */

'use strict';

/* ─────────────────────────────────────────
   LOAD MY TRANSPORT REQUESTS SCREEN
   ───────────────────────────────────────── */
function loadTransportScreenSeller() {
  var container = document.getElementById('transport-requests-list');
  if (!container) return;
  container.innerHTML = '<div style="padding:24px;text-align:center;color:#6b7280;">Loading...</div>';

  apiGet('transport/my-requests', { limit: 50 }).then(function(res) {
    var rows = res.data && res.data.rows ? res.data.rows : [];

    if (rows.length === 0) {
      container.innerHTML =
        '<div style="text-align:center;padding:48px 20px;color:#6b7280;">' +
          '<div style="font-size:48px;margin-bottom:12px;">🚛</div>' +
          '<div style="font-size:17px;font-weight:600;color:#374151;margin-bottom:8px;">No transport requests yet</div>' +
          '<p style="font-size:14px;margin-bottom:20px;">Submit a request to arrange delivery for your goods.</p>' +
          '<button class="btn primary" onclick="openTransportRequestModal()">+ New Transport Request</button>' +
        '</div>';
      return;
    }

    container.innerHTML = rows.map(_renderTransportRow).join('');
  });
}

function _renderTransportRow(req) {
  var statusMap = {
    'open':        { color: '#f59e0b', label: '⏳ Submitted — Awaiting Admin' },
    'processed':   { color: '#3b82f6', label: '✅ Accepted — Pay Now' },
    'paid':        { color: '#8b5cf6', label: '💰 Paid — Awaiting Dispatch' },
    'in_transit':  { color: '#10b981', label: '🚛 In Transit' },
    'delivered':   { color: '#1a6b3a', label: '✅ Delivered' },
    'cancelled':   { color: '#ef4444', label: '❌ Cancelled' },
  };
  var s = statusMap[req.status] || { color: '#6b7280', label: req.status };

  var payBtn = (req.status === 'processed' && req.payment_status !== 'paid' && req.payment_status !== 'in_escrow')
    ? '<button class="btn primary sm" onclick="payTransportRequest(\'' + req.id + '\', \'' +
        (req.agreed_price_inr || 0) + '\')" style="background:#1d4ed8;">💳 Pay ₹' +
        Number(req.agreed_price_inr || 0).toLocaleString('en-IN') + '</button>'
    : '';

  var trackBtn = req.status === 'in_transit' || req.status === 'delivered'
    ? '<button class="btn sm" onclick="openTrackingMap(\'' + req.id + '\')">📍 Track</button>'
    : '';

  return '<div style="background:white;border:1px solid #e5e7eb;border-radius:12px;' +
    'padding:18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);">' +

    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">' +
      '<div>' +
        '<div style="font-size:15px;font-weight:600;color:#111827;">' + escapeHtml(req.title || 'Shipment') + '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-top:2px;">' +
          escapeHtml(req.quantity_kg || '') + ' kg · ' +
          escapeHtml(req.pickup_city || '') + ' → ' + escapeHtml(req.delivery_city || '') +
        '</div>' +
      '</div>' +
      '<span style="background:' + s.color + '20;color:' + s.color + ';padding:4px 10px;' +
        'border-radius:20px;font-size:11px;font-weight:600;">' + s.label + '</span>' +
    '</div>' +

    // Address row
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">' +
      '<div style="background:#f9fafb;border-radius:8px;padding:10px;">' +
        '<div style="font-size:10px;color:#9ca3af;margin-bottom:2px;">📍 PICKUP</div>' +
        '<div style="font-size:12px;color:#374151;">' + escapeHtml(req.pickup_address || req.pickup_city || '—') + '</div>' +
      '</div>' +
      '<div style="background:#f9fafb;border-radius:8px;padding:10px;">' +
        '<div style="font-size:10px;color:#9ca3af;margin-bottom:2px;">🏪 DELIVERY</div>' +
        '<div style="font-size:12px;color:#374151;">' + escapeHtml(req.delivery_address || req.delivery_city || '—') + '</div>' +
      '</div>' +
    '</div>' +

    // Footer
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="font-size:13px;color:#374151;">' +
        (req.agreed_price_inr && req.agreed_price_inr !== '0'
          ? '💰 <strong>₹' + Number(req.agreed_price_inr).toLocaleString('en-IN') + '</strong>'
          : '<span style="color:#9ca3af;">Price pending admin review</span>') +
      '</div>' +
      '<div style="display:flex;gap:8px;">' + payBtn + trackBtn + '</div>' +
    '</div>' +

    // Payment done note
    (req.payment_status === 'paid' || req.payment_status === 'in_escrow'
      ? '<div style="margin-top:10px;background:#dcfce7;border-radius:6px;padding:8px 12px;' +
          'font-size:12px;color:#15803d;">✅ Payment received. Admin will dispatch shortly.</div>'
      : '') +

  '</div>';
}

/* ─────────────────────────────────────────
   OPEN NEW TRANSPORT REQUEST MODAL
   ───────────────────────────────────────── */
function openTransportRequestModal(dealId, prefillTitle, prefillQty, prefillCity) {
  /**
   * Opens the transport request form as a modal popup.
   * All fields are in the form — goods, category, weight,
   * pickup address + city + state, delivery address + city + state,
   * pickup date, and optional budget.
   *
   * Can be pre-filled from a deal (dealId, title, qty, city).
   */
  var bodyHTML =
    '<div style="margin-bottom:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);padding:12px;border-radius:10px;">' +
      '<label style="font-size:12px;font-weight:600;color:var(--text-1);display:block;margin-bottom:6px;">' +
        'Link to Active Deal (Optional)' +
      '</label>' +
      '<select class="form-control" id="tr-deal-select" onchange="if(window.handleTrDealSelectChange)window.handleTrDealSelectChange(this)">' +
        '<option value="">-- Standalone / New Transport Request --</option>' +
      '</select>' +
    '</div>' +

    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +

    // Goods description
    '<div style="grid-column:1/-1;">' +
      '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
        'Goods Description <span style="color:#dc2626;">*</span></label>' +
      '<input class="form-control" type="text" id="tr-title" ' +
        'placeholder="e.g. 50 bags Premium Wheat, Grade A" ' +
        'value="' + escapeHtml(prefillTitle || '') + '">' +
    '</div>' +

    // Category
    '<div>' +
      '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
        'Category <span style="color:#dc2626;">*</span></label>' +
      '<select class="form-control" id="tr-category">' +
        '<option value="">Select category</option>' +
        '<option>Agriculture / Farm Produce</option>' +
        '<option>Manufacturing / Industrial</option>' +
        '<option>Textiles &amp; Fabric</option>' +
        '<option>Food &amp; Processed</option>' +
        '<option>Raw Materials</option>' +
        '<option>Electronics &amp; Components</option>' +
        '<option>Other</option>' +
      '</select>' +
    '</div>' +

    // Weight
    '<div>' +
      '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
        'Total Weight (kg) <span style="color:#dc2626;">*</span></label>' +
      '<input class="form-control" type="number" id="tr-qty" min="1" ' +
        'placeholder="e.g. 500" value="' + escapeHtml(String(prefillQty || '')) + '">' +
    '</div>' +

    '</div>' + // end top grid

    // PICKUP section
    '<div style="margin-top:14px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">' +
      '<div style="font-size:12px;font-weight:700;color:#15803d;margin-bottom:10px;">📍 PICKUP LOCATION</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<div style="grid-column:1/-1;">' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
            'Full Pickup Address <span style="color:#dc2626;">*</span></label>' +
          '<textarea class="form-control" id="tr-pickup-addr" rows="2" ' +
            'placeholder="Door/Plot no, Street, Area, Landmark">' + escapeHtml(prefillCity ? prefillCity + ' area' : '') + '</textarea>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
            'Pickup City <span style="color:#dc2626;">*</span></label>' +
          '<input class="form-control" type="text" id="tr-pickup-city" ' +
            'placeholder="e.g. Mumbai" value="' + escapeHtml(prefillCity || '') + '">' +
        '</div>' +
        '<div>' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">State</label>' +
          '<input class="form-control" type="text" id="tr-pickup-state" placeholder="e.g. Maharashtra">' +
        '</div>' +
      '</div>' +
    '</div>' +

    // DELIVERY section
    '<div style="margin-top:10px;padding:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">' +
      '<div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:10px;">🏪 DELIVERY LOCATION</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<div style="grid-column:1/-1;">' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
            'Full Delivery Address <span style="color:#dc2626;">*</span></label>' +
          '<textarea class="form-control" id="tr-delivery-addr" rows="2" ' +
            'placeholder="Door/Plot no, Street, Area, Landmark"></textarea>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
            'Delivery City <span style="color:#dc2626;">*</span></label>' +
          '<input class="form-control" type="text" id="tr-delivery-city" placeholder="e.g. Delhi">' +
        '</div>' +
        '<div>' +
          '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">State</label>' +
          '<input class="form-control" type="text" id="tr-delivery-state" placeholder="e.g. Delhi">' +
        '</div>' +
      '</div>' +
    '</div>' +

    // Date + budget row
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">' +
      '<div>' +
        '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
          'Goods Ready Date <span style="color:#dc2626;">*</span></label>' +
        '<input class="form-control" type="date" id="tr-date" ' +
          'min="' + new Date().toISOString().split('T')[0] + '">' +
      '</div>' +
      '<div>' +
        '<label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px;">' +
          'Max Budget ₹ (optional)</label>' +
        '<input class="form-control" type="number" id="tr-budget" placeholder="e.g. 5000">' +
      '</div>' +
    '</div>' +

    // Info note
    '<div style="margin-top:12px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;' +
      'padding:10px 14px;font-size:12px;color:#92400e;">' +
      'ℹ️ After submitting, the admin will review your request and set the transport price. ' +
      'You will receive a notification to make payment once accepted.' +
    '</div>' +

    '<div id="tr-error" style="margin-top:8px;color:#dc2626;font-size:13px;display:none;"></div>';

  openModal({
    title:     '🚛 New Transport Request',
    sub:       'Admin will review and set price within 24 hours',
    badge:     'Free Submission', badgeClass: 'active',
    bodyHTML:  bodyHTML,
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="tr-submit-btn" onclick="submitTransportRequest(\'' + (dealId || '') + '\')">Submit Request →</button>',
    wide: true,
  });

  // Populate active deals dropdown
  apiGet('seller/deals', { seller_id: AppState.user && AppState.user.id, limit: 50 }).then(function(res) {
    var sel = document.getElementById('tr-deal-select');
    if (!sel || !res.data || !res.data.rows) return;
    res.data.rows.forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.setAttribute('data-title', d.product_title || d.listing_title || 'Goods');
      opt.setAttribute('data-qty', d.quantity || '500');
      opt.setAttribute('data-pickup', d.pickup_city || '');
      opt.setAttribute('data-dest', d.deliver_to || d.delivery_city || '');
      opt.textContent = 'Deal #' + d.id + ' — ' + (d.product_title || 'Product') + ' (' + (d.pickup_city || '') + ')';
      if (dealId && d.id === dealId) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}

window.handleTrDealSelectChange = function(sel) {
  var opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  var title  = opt.getAttribute('data-title') || '';
  var qty    = opt.getAttribute('data-qty') || '';
  var pickup = opt.getAttribute('data-pickup') || '';
  var dest   = opt.getAttribute('data-dest') || '';

  var titleEl = document.getElementById('tr-title');
  var qtyEl   = document.getElementById('tr-qty');
  var pCityEl = document.getElementById('tr-pickup-city');
  var pAddrEl = document.getElementById('tr-pickup-addr');
  var dCityEl = document.getElementById('tr-delivery-city');
  var dAddrEl = document.getElementById('tr-delivery-addr');

  if (titleEl && title) titleEl.value = title;
  if (qtyEl && qty)   qtyEl.value   = parseFloat(qty) || 500;
  if (pCityEl && pickup) pCityEl.value = pickup;
  if (pAddrEl && pickup) pAddrEl.value = pickup + ' Central Warehouse';
  if (dCityEl && dest)   dCityEl.value = dest;
  if (dAddrEl && dest)   dAddrEl.value = dest + ' Delivery Depot';
};

/* ─────────────────────────────────────────
   SUBMIT TRANSPORT REQUEST
   ───────────────────────────────────────── */
function submitTransportRequest(dealId) {
  var errEl = document.getElementById('tr-error');
  var btn   = document.getElementById('tr-submit-btn');

  var fields = {
    title:         document.getElementById('tr-title'),
    category:      document.getElementById('tr-category'),
    qty:           document.getElementById('tr-qty'),
    pickupAddr:    document.getElementById('tr-pickup-addr'),
    pickupCity:    document.getElementById('tr-pickup-city'),
    pickupState:   document.getElementById('tr-pickup-state'),
    deliveryAddr:  document.getElementById('tr-delivery-addr'),
    deliveryCity:  document.getElementById('tr-delivery-city'),
    deliveryState: document.getElementById('tr-delivery-state'),
    date:          document.getElementById('tr-date'),
    budget:        document.getElementById('tr-budget'),
  };

  // Validation
  var errors = [];
  if (!fields.title || !fields.title.value.trim())         errors.push('Goods description');
  if (!fields.category || !fields.category.value)          errors.push('Category');
  if (!fields.qty || !parseFloat(fields.qty.value))        errors.push('Weight');
  if (!fields.pickupAddr || !fields.pickupAddr.value.trim()) errors.push('Pickup address');
  if (!fields.pickupCity || !fields.pickupCity.value.trim()) errors.push('Pickup city');
  if (!fields.deliveryAddr || !fields.deliveryAddr.value.trim()) errors.push('Delivery address');
  if (!fields.deliveryCity || !fields.deliveryCity.value.trim()) errors.push('Delivery city');
  if (!fields.date || !fields.date.value)                  errors.push('Goods ready date');

  if (errors.length > 0) {
    if (errEl) { errEl.textContent = 'Please fill in: ' + errors.join(', '); errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  apiPost('transport/request/create', {
    deal_id:          dealId || '',
    title:            fields.title.value.trim(),
    category:         fields.category.value,
    quantity_kg:      parseFloat(fields.qty.value),
    pickup_address:   fields.pickupAddr.value.trim(),
    pickup_city:      fields.pickupCity.value.trim(),
    pickup_state:     fields.pickupState ? fields.pickupState.value.trim() : '',
    delivery_address: fields.deliveryAddr.value.trim(),
    delivery_city:    fields.deliveryCity.value.trim(),
    delivery_state:   fields.deliveryState ? fields.deliveryState.value.trim() : '',
    pickup_date:      fields.date.value,
    budget_inr:       fields.budget && fields.budget.value ? parseFloat(fields.budget.value) : '',
    status:           'open',
    payment_status:   'unpaid',
  }).then(function(res) {
    if (res.data && res.data.success) {
      closeModalDirect();
      toast('✅ Transport request submitted! Admin will review shortly.', 'success', 5000);
      loadTransportScreenSeller();
    } else {
      var msg = (res.data && res.data.detail) || 'Submission failed. Is the server running?';
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    }
  }).catch(function(e) {
    if (errEl) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block'; }
  }).finally(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Request →'; }
  });
}

/* ─────────────────────────────────────────
   PAY FOR ACCEPTED TRANSPORT REQUEST
   ───────────────────────────────────────── */
function payTransportRequest(requestId, agreedPrice) {
  var amount = parseFloat(agreedPrice || 0);

  openModal({
    title: '💳 Pay for Transport',
    sub:   'Secure payment via Razorpay',
    badge: 'Test Mode', badgeClass: 'warning',
    bodyHTML:
      '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;' +
        'padding:20px;text-align:center;margin-bottom:16px;">' +
        '<div style="font-size:13px;color:#1e40af;margin-bottom:6px;">Transport Fee</div>' +
        '<div style="font-family:Syne,sans-serif;font-size:36px;font-weight:800;color:#1d4ed8;">' +
          '₹' + amount.toLocaleString('en-IN') +
        '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-top:4px;">' +
          'Held in escrow · Released after delivery' +
        '</div>' +
      '</div>' +
      '<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;' +
        'padding:10px 14px;font-size:12px;color:#92400e;">' +
        'TEST MODE: Use card 4111 1111 1111 1111 · Any future date · Any CVV' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" onclick="openTransportRazorpay(\'' + requestId + '\',' + amount + ')">' +
        'Pay ₹' + amount.toLocaleString('en-IN') + ' →' +
      '</button>',
  });
}

function openTransportRazorpay(requestId, amount) {
  apiPost('transport/payment/create-order', { request_id: requestId })
    .then(function(res) {
      if (!res.data || !res.data.order_id) {
        toast('Could not create payment order. Is the server running?', 'danger'); return;
      }
      closeModalDirect();

      var options = {
        key:         res.data.razorpay_key_id,
        amount:      res.data.amount_paise,
        currency:    'INR',
        name:        'TradeLink Transport',
        description: 'Transport Request #' + requestId.substring(0, 8),
        order_id:    res.data.order_id,
        prefill: {
          name:  AppState.user && AppState.user.name,
          email: AppState.user && AppState.user.email,
        },
        theme: { color: '#1a6b3a' },
        handler: function(response) {
          toast('Verifying payment...', 'info', 2000);
          apiPost('transport/payment/verify', {
            request_id:          requestId,
            razorpay_payment_id:  response.razorpay_payment_id,
            razorpay_order_id:    response.razorpay_order_id,
            razorpay_signature:   response.razorpay_signature,
          }).then(function(vRes) {
            if (vRes.data && vRes.data.success) {
              toast('✅ Payment confirmed! Admin will dispatch your shipment.', 'success', 6000);
              loadTransportScreenSeller();
            } else {
              toast('Payment verification failed. Contact support.', 'danger');
            }
          });
        },
        modal: {
          ondismiss: function() { toast('Payment cancelled.', 'warning'); }
        },
      };

      // Load Razorpay if not already loaded
      function doOpen() {
        var rzp = new window.Razorpay(options);
        rzp.on('payment.failed', function(r) {
          toast('Payment failed: ' + (r.error.description || 'Try again'), 'danger');
        });
        rzp.open();
      }

      if (window.Razorpay) {
        doOpen();
      } else {
        var s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.onload = doOpen;
        document.head.appendChild(s);
      }
    });
}

/* ═══════════════════════════════════════════════════════════
   TRACKING MODAL — openTrackingMap(requestId)
   ADD THIS ENTIRE BLOCK AT THE BOTTOM OF transport.js
   ═══════════════════════════════════════════════════════════ */

function openTrackingMap(requestId) {
  var existing = document.getElementById('tracking-modal-overlay');
  if (existing) existing.remove();

  // Build overlay shell first
  var overlay = document.createElement('div');
  overlay.id = 'tracking-modal-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9990;' +
    'display:flex;align-items:center;justify-content:center;padding:16px;' +
      'pointer-events:none;'

  overlay.innerHTML =
    '<div style=\"background:white;border-radius:18px;width:100%;max-width:900px;' +
      'max-height:90vh;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35);' +
      'display:flex;flex-direction:column;">' +

      // ── Modal header ──
      '<div style="padding:18px 24px;border-bottom:1px solid #e5e7eb;' +
        'display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
        '<div>' +
          '<div style="font-size:17px;font-weight:700;color:#111827;">📦 Live Shipment Tracking</div>' +
          '<div style="font-size:12px;color:#6b7280;margin-top:2px;" id="tr-modal-subtitle">Loading...</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'tracking-modal-overlay\').remove()" ' +
          'style="background:#f3f4f6;border:none;border-radius:8px;padding:8px 14px;' +
          'font-size:20px;cursor:pointer;line-height:1;">✕</button>' +
      '</div>' +

      // ── Body: map + timeline side by side ──
      '<div style="display:flex;flex:1;overflow:hidden;min-height:0;">' +

        // Map side
        '<div style="flex:1;min-width:0;position:relative;">' +
          '<div id=\"tr-tracking-map\" style=\"width:100%;height:380px;\"></div>' +
          '<div id="tr-map-placeholder" style="position:absolute;inset:0;background:#f3f4f6;' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'color:#6b7280;font-size:14px;">' +
            '<div style="font-size:40px;margin-bottom:8px;">🗺️</div>' +
            'Loading map...' +
          '</div>' +
        '</div>' +

        // Timeline side
        '<div style="width:280px;flex-shrink:0;overflow-y:auto;border-left:1px solid #e5e7eb;' +
          'padding:20px;background:#fafafa;" id="tr-timeline-panel">' +
          '<div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:16px;">🚦 Delivery Timeline</div>' +
          '<div id="tr-timeline-steps"></div>' +
        '</div>' +

      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Load tracking data from backend
  _loadTrackingData(requestId);
}

// ─── Fetch data and render ───────────────────────────────────────
function _loadTrackingData(requestId) {
  var token = AppState && AppState.token ? AppState.token : (window._authToken || '');

  fetch(window.API_BASE + '/transport/tracking/' + requestId, {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.request) {
      _renderTrackingUI(d.request, d.tracking_notes || []);
    } else {
      // Fallback: load from my-requests
      fetch(window.API_BASE + '/transport/my-requests?limit=50', {
        headers: { 'Authorization': 'Bearer ' + token }
      })
      .then(function(r) { return r.json(); })
      .then(function(md) {
        var reqs = md.requests || md.data || [];
        var req = reqs.find(function(r) { return r.id === requestId; });
        if (req) _renderTrackingUI(req, []);
        else {
          var sub = document.getElementById('tr-modal-subtitle');
          if (sub) sub.textContent = 'Could not load tracking info.';
        }
      });
    }
  })
  .catch(function() {
    var sub = document.getElementById('tr-modal-subtitle');
    if (sub) sub.textContent = 'Error loading tracking. Check server.';
  });
}

// ─── Render map + timeline ───────────────────────────────────────
function _renderTrackingUI(req, notes) {
  // Update subtitle
  var sub = document.getElementById('tr-modal-subtitle');
  if (sub) sub.textContent =
    (req.title || 'Shipment') + ' · ' +
    (req.pickup_city || '') + ' → ' + (req.delivery_city || '');

  // Build ordered timeline steps
  var allSteps = [
    { key: 'order_placed',      icon: '🛒', label: 'Order Placed',      desc: 'Transport request submitted' },
    { key: 'payment_done',      icon: '💳', label: 'Payment Done',       desc: 'Escrow payment confirmed' },
    { key: 'dispatched',        icon: '🚛', label: 'Dispatched',         desc: 'Goods picked up from seller' },
    { key: 'picked_up',         icon: '📦', label: 'Picked Up',          desc: 'Loaded on vehicle' },
    { key: 'in_transit',        icon: '🛣️', label: 'In Transit',         desc: 'On the way' },
    { key: 'arrived_city',      icon: '🏙️', label: 'Arrived in City',    desc: 'Reached destination city' },
    { key: 'out_for_delivery',  icon: '🛵', label: 'Out for Delivery',   desc: 'Last mile delivery started' },
    { key: 'delivered',         icon: '✅', label: 'Delivered',          desc: 'Successfully delivered' },
  ];

  // Determine which steps are done based on status
  var status = req.status || '';
  var payDone = req.payment_status === 'paid' || req.payment_status === 'in_escrow';

  // Build a set of completed step keys
  var doneKeys = new Set();
  doneKeys.add('order_placed');
  if (payDone) doneKeys.add('payment_done');

  // Map status to done steps
  var statusOrder = ['dispatched','picked_up','in_transit','arrived_city','out_for_delivery','delivered'];

  // Add extra statuses from tracking notes
  if (notes && notes.length) {
    notes.forEach(function(n) {
      var ns = (n.status || '').toLowerCase();
      statusOrder.forEach(function(sk) {
        if (ns === sk || ns.includes(sk)) doneKeys.add(sk);
      });
    });
  }

  // Check current status in order
  var reached = false;
  if (status === 'in_transit' || status === 'dispatched') {
    doneKeys.add('dispatched'); doneKeys.add('picked_up'); doneKeys.add('in_transit');
  }
  if (status === 'delivered') {
    statusOrder.forEach(function(k) { doneKeys.add(k); });
  }

  // Find the "active" step (last done step that isn't delivered)
  var activeKey = '';
  allSteps.forEach(function(step) {
    if (doneKeys.has(step.key)) activeKey = step.key;
  });
  if (status === 'delivered') activeKey = 'delivered';

  // Build timeline HTML
  var timelineEl = document.getElementById('tr-timeline-steps');
  if (!timelineEl) return;

  timelineEl.innerHTML = allSteps.map(function(step, i) {
    var isDone   = doneKeys.has(step.key);
    var isActive = step.key === activeKey;
    var isLast   = i === allSteps.length - 1;

    // Find note for this step
    var stepNote = '';
    if (notes && notes.length) {
      var match = notes.find(function(n) {
        return (n.status || '').toLowerCase() === step.key;
      });
      if (match) stepNote = match.note || match.message || '';
    }

    return '<div style="display:flex;gap:10px;margin-bottom:' + (isLast ? '0' : '4px') + ';">' +

      // Dot + line
      '<div style="display:flex;flex-direction:column;align-items:center;width:28px;flex-shrink:0;">' +
        '<div style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;' +
          'justify-content:center;font-size:13px;flex-shrink:0;' +
          'background:' + (isDone ? (isActive ? '#1a6b3a' : '#dcfce7') : '#f3f4f6') + ';' +
          'border:2px solid ' + (isDone ? (isActive ? '#1a6b3a' : '#86efac') : '#e5e7eb') + ';' +
          'box-shadow:' + (isActive ? '0 0 0 4px rgba(26,107,58,.15)' : 'none') + ';">' +
          (isDone ? step.icon : '<span style="width:8px;height:8px;border-radius:50%;background:#d1d5db;display:block;"></span>') +
        '</div>' +
        (!isLast ? '<div style="width:2px;flex:1;margin:3px 0;background:' + (isDone ? '#86efac' : '#e5e7eb') + ';min-height:16px;"></div>' : '') +
      '</div>' +

      // Label
      '<div style="padding-bottom:' + (isLast ? '0' : '12px') + ';padding-top:4px;">' +
        '<div style="font-size:13px;font-weight:' + (isActive ? '700' : (isDone ? '600' : '400')) + ';' +
          'color:' + (isActive ? '#1a6b3a' : (isDone ? '#111827' : '#9ca3af')) + ';">' +
          step.label +
          (isActive ? ' <span style="background:#dcfce7;color:#15803d;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:600;">NOW</span>' : '') +
        '</div>' +
        '<div style="font-size:11px;color:#9ca3af;margin-top:1px;">' +
          (stepNote || step.desc) +
        '</div>' +
      '</div>' +

    '</div>';
  }).join('');

  // ── Render Leaflet map ────────────────────────────────────────
  _renderLeafletMap(req);
}

// ─── Leaflet map ─────────────────────────────────────────────────
function _renderLeafletMap(req) {
  var placeholder = document.getElementById('tr-map-placeholder');

  // Try to get lat/lng from the request
  var pickupLat  = parseFloat(req.pickup_lat  || 0);
  var pickupLng  = parseFloat(req.pickup_lng  || 0);
  var deliveryLat= parseFloat(req.delivery_lat || 0);
  var deliveryLng= parseFloat(req.delivery_lng || 0);
  var currentLat = parseFloat(req.current_lat  || 0);
  var currentLng = parseFloat(req.current_lng  || 0);

  // Default to India center if no coords
  var hasPickup   = pickupLat  !== 0 && pickupLng  !== 0;
  var hasDelivery = deliveryLat !== 0 && deliveryLng !== 0;
  var hasCurrent  = currentLat  !== 0 && currentLng  !== 0;

  var centerLat = hasPickup ? pickupLat : 20.5937;
  var centerLng = hasPickup ? pickupLng : 78.9629;
  var zoom      = hasPickup && hasDelivery ? 6 : 5;

  // Check if Leaflet is loaded
  if (typeof L === 'undefined') {
    // Load Leaflet dynamically
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    var script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = function() { _initMap(req, centerLat, centerLng, zoom, hasPickup, hasDelivery, hasCurrent, pickupLat, pickupLng, deliveryLat, deliveryLng, currentLat, currentLng, placeholder); };
    document.head.appendChild(script);
  } else {
    _initMap(req, centerLat, centerLng, zoom, hasPickup, hasDelivery, hasCurrent, pickupLat, pickupLng, deliveryLat, deliveryLng, currentLat, currentLng, placeholder);
  }
}

function _initMap(req, centerLat, centerLng, zoom, hasPickup, hasDelivery, hasCurrent,
                  pickupLat, pickupLng, deliveryLat, deliveryLng, currentLat, currentLng, placeholder) {
  var mapEl = document.getElementById('tr-tracking-map');
  if (!mapEl) return;

  // Hide placeholder
  if (placeholder) placeholder.style.display = 'none';

  // Destroy old map instance if any
  if (window._trMap) {
    try { window._trMap.remove(); } catch(e) {}
    window._trMap = null;
  }

  var map = L.map('tr-tracking-map', { zoomControl: true }).setView([centerLat, centerLng], zoom);
  window._trMap = map;

  // OpenStreetMap tiles (free, no API key)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 18,
  }).addTo(map);

  var bounds = [];

  // Pickup marker (green)
  if (hasPickup) {
    var pickupIcon = L.divIcon({
      html: '<div style="background:#1a6b3a;color:white;border-radius:50% 50% 50% 0;' +
            'width:32px;height:32px;display:flex;align-items:center;justify-content:center;' +
            'font-size:14px;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.3);">' +
            '<span style="transform:rotate(45deg)">📍</span></div>',
      iconSize: [32, 32], iconAnchor: [16, 32], className: ''
    });
    L.marker([pickupLat, pickupLng], { icon: pickupIcon })
      .addTo(map)
      .bindPopup('<strong>📍 Pickup</strong><br>' + (req.pickup_address || req.pickup_city || ''));
    bounds.push([pickupLat, pickupLng]);
  }

  // Delivery marker (blue)
  if (hasDelivery) {
    var deliveryIcon = L.divIcon({
      html: '<div style="background:#1d4ed8;color:white;border-radius:50% 50% 50% 0;' +
            'width:32px;height:32px;display:flex;align-items:center;justify-content:center;' +
            'font-size:14px;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.3);">' +
            '<span style="transform:rotate(45deg)">🏪</span></div>',
      iconSize: [32, 32], iconAnchor: [16, 32], className: ''
    });
    L.marker([deliveryLat, deliveryLng], { icon: deliveryIcon })
      .addTo(map)
      .bindPopup('<strong>🏪 Delivery</strong><br>' + (req.delivery_address || req.delivery_city || ''));
    bounds.push([deliveryLat, deliveryLng]);
  }

  // Current location marker (animated pulse, purple)
  if (hasCurrent) {
    var currentIcon = L.divIcon({
      html: '<div style="position:relative;width:36px;height:36px;">' +
            '<div style="position:absolute;inset:0;border-radius:50%;background:rgba(124,58,237,.3);' +
            'animation:trPulse 1.5s infinite;"></div>' +
            '<div style="position:absolute;inset:6px;border-radius:50%;background:#7c3aed;' +
            'display:flex;align-items:center;justify-content:center;font-size:12px;color:white;">🚛</div>' +
            '</div>',
      iconSize: [36, 36], iconAnchor: [18, 18], className: ''
    });
    L.marker([currentLat, currentLng], { icon: currentIcon })
      .addTo(map)
      .bindPopup('<strong>🚛 Current Location</strong>');
    bounds.push([currentLat, currentLng]);
  }

  // Draw route line between pickup and delivery
  if (hasPickup && hasDelivery) {
    L.polyline([[pickupLat, pickupLng], [deliveryLat, deliveryLng]], {
      color: '#7c3aed', weight: 3, opacity: 0.6, dashArray: '8,6'
    }).addTo(map);
  }

  // Fit map to show all markers
  if (bounds.length >= 2) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  // If no coords at all — show city names as info
  if (!hasPickup && !hasDelivery) {
    if (placeholder) {
      placeholder.style.display = 'flex';
      placeholder.innerHTML =
        '<div style="font-size:36px;margin-bottom:8px;">🗺️</div>' +
        '<div style="font-size:14px;color:#374151;font-weight:600;">' +
          (req.pickup_city || '?') + ' → ' + (req.delivery_city || '?') +
        '</div>' +
        '<div style="font-size:12px;color:#9ca3af;margin-top:4px;">' +
          'GPS coordinates not available for this request.' +
        '</div>';
    }
  }

  // Add pulse animation style once
  if (!document.getElementById('tr-pulse-style')) {
    var style = document.createElement('style');
    style.id = 'tr-pulse-style';
    style.textContent = '@keyframes trPulse{0%{transform:scale(1);opacity:.8}50%{transform:scale(1.8);opacity:.2}100%{transform:scale(1);opacity:.8}}';
    document.head.appendChild(style);
  }
}

/* ═══════════════════════════════════════════════════════════════
   PASTE THIS ENTIRE BLOCK AT THE VERY BOTTOM OF transport.js
   It adds the live tracking modal with Leaflet map + timeline
   ═══════════════════════════════════════════════════════════════ */

function openTrackingMap(requestId) {
  var existing = document.getElementById('tracking-modal-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'tracking-modal-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9990;' +
    'display:flex;align-items:center;justify-content:center;padding:16px;';

  overlay.innerHTML =
    '<div style="background:white;border-radius:18px;width:100%;max-width:900px;' +
      'max-height:92vh;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35);' +
      'display:flex;flex-direction:column;">' +

      // Header
      '<div style="padding:18px 24px;border-bottom:1px solid #e5e7eb;' +
        'display:flex;justify-content:space-between;align-items:center;flex-shrink:0;' +
        'background:linear-gradient(135deg,#7c3aed,#6d28d9);color:white;">' +
        '<div>' +
          '<div style="font-size:17px;font-weight:800;">📦 Live Shipment Tracking</div>' +
          '<div style="font-size:12px;opacity:.8;margin-top:2px;" id="tr-modal-subtitle">Loading...</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'tracking-modal-overlay\').remove()" ' +
          'style="background:rgba(255,255,255,.2);border:none;border-radius:8px;padding:8px 14px;' +
          'font-size:18px;cursor:pointer;color:white;line-height:1;">✕</button>' +
      '</div>' +

      // Body: map left, timeline right
      '<div style="display:flex;flex:1;overflow:hidden;min-height:0;">' +

        // Map
        '<div style="flex:1;min-width:0;position:relative;">' +
          '<div id="tr-tracking-map" style="width:100%;height:100%;min-height:380px;"></div>' +
          '<div id="tr-map-loader" style="position:absolute;inset:0;background:#f3f4f6;' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'color:#6b7280;font-size:14px;">' +
            '<div style="font-size:40px;margin-bottom:10px;">🗺️</div>' +
            'Loading map...' +
          '</div>' +
        '</div>' +

        // Timeline
        '<div style="width:290px;flex-shrink:0;overflow-y:auto;border-left:1px solid #e5e7eb;' +
          'padding:20px;background:#fafafa;" id="tr-timeline-panel">' +
          '<div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:18px;">🚦 Delivery Timeline</div>' +
          '<div id="tr-timeline-steps"><div style="color:#9ca3af;font-size:13px;">Loading...</div></div>' +
        '</div>' +

      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  _loadTrackingData(requestId);
}

function _loadTrackingData(requestId) {
  var token = (AppState && AppState.token) ? AppState.token : (window._authToken || '');
  var base  = window.API_BASE || 'http://localhost:8000/api';

  fetch(base + '/transport/tracking/' + requestId, {
    headers: { 'Authorization': 'Bearer ' + token, 'X-User-Role': 'seller' }
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d && (d.request || d.status)) {
      var req   = d.request || d;
      var notes = d.tracking_notes || d.notes || [];
      _renderTrackingUI(req, notes);
    } else {
      // Fallback: pull from my-requests list
      fetch(base + '/transport/my-requests?limit=50', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-User-Role': 'seller' }
      })
      .then(function(r2) { return r2.json(); })
      .then(function(md) {
        var list = md.requests || md.data || [];
        var req  = list.find(function(r) { return r.id === requestId; });
        if (req) _renderTrackingUI(req, []);
        else {
          var sub = document.getElementById('tr-modal-subtitle');
          if (sub) sub.textContent = 'Could not load tracking info.';
        }
      }).catch(function() {});
    }
  })
  .catch(function() {
    var sub = document.getElementById('tr-modal-subtitle');
    if (sub) sub.textContent = 'Error loading — is server running?';
  });
}

function _renderTrackingUI(req, rawNotes) {
  // Update subtitle
  var sub = document.getElementById('tr-modal-subtitle');
  if (sub) sub.textContent =
    (req.title || 'Shipment') + ' · ' +
    (req.pickup_city || '') + ' → ' + (req.delivery_city || '');

  // Parse notes (may be JSON string or array)
  var notes = [];
  if (Array.isArray(rawNotes)) {
    notes = rawNotes;
  } else if (typeof rawNotes === 'string') {
    try { notes = JSON.parse(rawNotes); } catch(e) { notes = []; }
  }

  // Also try parsing from req.tracking_notes
  if (!notes.length && req.tracking_notes) {
    if (Array.isArray(req.tracking_notes)) notes = req.tracking_notes;
    else { try { notes = JSON.parse(req.tracking_notes); } catch(e) {} }
  }

  // ── Build timeline ──
  var STEPS = [
    { key:'order_placed',     icon:'🛒', label:'Order Placed',         desc:'Transport request submitted' },
    { key:'payment_done',     icon:'💳', label:'Payment Confirmed',     desc:'Escrow payment secured' },
    { key:'dispatched',       icon:'🚛', label:'Dispatched',            desc:'Admin dispatched the goods' },
    { key:'picked_up',        icon:'📦', label:'Picked Up',             desc:'Loaded on vehicle' },
    { key:'in_transit',       icon:'🛣️', label:'In Transit',            desc:'En route to destination' },
    { key:'arrived_city',     icon:'🏙️', label:'Arrived in City',       desc:'Reached destination city' },
    { key:'out_for_delivery', icon:'🛵', label:'Out for Delivery',      desc:'Last mile delivery' },
    { key:'delivered',        icon:'✅', label:'Delivered',             desc:'Successfully delivered' },
  ];

  var status  = (req.status || '').toLowerCase();
  var payDone = req.payment_status === 'paid' || req.payment_status === 'in_escrow';

  // Build set of completed step keys
  var doneKeys = {};
  doneKeys['order_placed'] = true;
  if (payDone) doneKeys['payment_done'] = true;

  // Map status to done steps
  if (status === 'in_transit' || status === 'dispatched' || status === 'paid') {
    doneKeys['dispatched'] = true;
  }
  if (status === 'in_transit') {
    doneKeys['dispatched'] = true;
    doneKeys['picked_up']  = true;
    doneKeys['in_transit'] = true;
  }
  if (status === 'delivered') {
    STEPS.forEach(function(st) { doneKeys[st.key] = true; });
  }

  // Add steps from tracking notes
  notes.forEach(function(n) {
    var ns = (n.status || '').toLowerCase();
    if (ns) doneKeys[ns] = true;
    // map aliases
    if (ns === 'arrived_city' || ns.includes('arrived')) doneKeys['arrived_city'] = true;
    if (ns === 'out_for_delivery' || ns.includes('out_for')) doneKeys['out_for_delivery'] = true;
  });

  // Find active (latest done) step
  var activeKey = 'order_placed';
  STEPS.forEach(function(st) { if (doneKeys[st.key]) activeKey = st.key; });

  // Note lookup
  function getNoteFor(key) {
    var match = notes.filter(function(n) {
      return (n.status || '').toLowerCase() === key;
    });
    if (match.length) return match[match.length - 1].note || '';
    return '';
  }

  var timelineEl = document.getElementById('tr-timeline-steps');
  if (timelineEl) {
    timelineEl.innerHTML = STEPS.map(function(step, i) {
      var isDone   = !!doneKeys[step.key];
      var isActive = step.key === activeKey;
      var isLast   = i === STEPS.length - 1;
      var noteText = getNoteFor(step.key) || step.desc;

      var dotBg    = isDone ? (isActive ? '#7c3aed' : '#ede9fe') : '#f3f4f6';
      var dotBorder= isDone ? (isActive ? '#7c3aed' : '#c4b5fd') : '#e5e7eb';
      var labelColor = isActive ? '#7c3aed' : isDone ? '#111827' : '#9ca3af';
      var labelWeight= isActive || isDone ? '600' : '400';
      var lineColor  = isDone ? '#c4b5fd' : '#e5e7eb';

      return '<div style="display:flex;gap:10px;margin-bottom:' + (isLast ? '0' : '4px') + ';">' +
        '<div style="display:flex;flex-direction:column;align-items:center;width:30px;flex-shrink:0;">' +
          '<div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;' +
            'justify-content:center;font-size:14px;flex-shrink:0;' +
            'background:' + dotBg + ';border:2px solid ' + dotBorder + ';' +
            (isActive ? 'box-shadow:0 0 0 5px rgba(124,58,237,.15);' : '') + '">' +
            (isDone ? step.icon : '<span style="width:8px;height:8px;border-radius:50%;background:#d1d5db;display:block;"></span>') +
          '</div>' +
          (!isLast ? '<div style="width:2px;flex:1;margin:3px 0;background:' + lineColor + ';min-height:16px;"></div>' : '') +
        '</div>' +
        '<div style="padding-bottom:' + (isLast ? '0' : '14px') + ';padding-top:5px;flex:1;">' +
          '<div style="font-size:13px;font-weight:' + labelWeight + ';color:' + labelColor + ';display:flex;align-items:center;gap:6px;">' +
            step.label +
            (isActive ? '<span style="background:#ede9fe;color:#7c3aed;font-size:10px;' +
              'padding:1px 7px;border-radius:10px;font-weight:700;">NOW</span>' : '') +
          '</div>' +
          '<div style="font-size:11px;color:#9ca3af;margin-top:2px;line-height:1.4;">' + noteText + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Render map
  _renderLeafletMap(req);
}

function _renderLeafletMap(req) {
  var pickupLat   = parseFloat(req.pickup_lat   || 0);
  var pickupLng   = parseFloat(req.pickup_lng   || 0);
  var delivLat    = parseFloat(req.delivery_lat || 0);
  var delivLng    = parseFloat(req.delivery_lng || 0);
  var curLat      = parseFloat(req.current_lat  || 0);
  var curLng      = parseFloat(req.current_lng  || 0);

  var hasPickup  = pickupLat  !== 0 && pickupLng  !== 0;
  var hasDeliv   = delivLat   !== 0 && delivLng   !== 0;
  var hasCurrent = curLat     !== 0 && curLng     !== 0;

  var centerLat = hasPickup ? pickupLat : 15.8497;   // default Belagavi area
  var centerLng = hasPickup ? pickupLng : 74.4977;
  var zoom      = (hasPickup && hasDeliv) ? 7 : 10;

  function _initMapNow() {
    var mapEl = document.getElementById('tr-tracking-map');
    var loader = document.getElementById('tr-map-loader');
    if (!mapEl) return;
    if (loader) loader.style.display = 'none';

    // Destroy old instance
    if (window._trMap) { try { window._trMap.remove(); } catch(e) {} window._trMap = null; }

    var map = L.map('tr-tracking-map', { zoomControl: true }).setView([centerLat, centerLng], zoom);
    window._trMap = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 18
    }).addTo(map);
    // ── Arrow D-pad navigation control ──────────────────────────
(function addArrowPad(map) {
  var pad = document.createElement('div');
  pad.style.cssText =
    'position:absolute;bottom:36px;right:10px;z-index:1000;' +
    'display:grid;grid-template-columns:repeat(3,32px);grid-template-rows:repeat(3,32px);gap:3px;';

  function makeBtn(label, rowStart, colStart, onClick) {
    var b = document.createElement('button');
    b.innerHTML = label;
    b.style.cssText =
      'grid-row:' + rowStart + ';grid-column:' + colStart + ';' +
      'width:32px;height:32px;background:white;border:1px solid #d1d5db;' +
      'border-radius:6px;font-size:14px;cursor:pointer;display:flex;' +
      'align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.2);' +
      'transition:background .1s;';
    b.onmouseenter = function(){ b.style.background='#f3f4f6'; };
    b.onmouseleave = function(){ b.style.background='white'; };

    // Support hold-to-scroll
    var _iv;
    function doMove(){ var c = map.getCenter(); onClick(c, map); }
    b.addEventListener('mousedown',  function(){ doMove(); _iv = setInterval(doMove, 80); });
    b.addEventListener('touchstart', function(e){ e.preventDefault(); doMove(); _iv = setInterval(doMove, 80); });
    b.addEventListener('mouseup',    function(){ clearInterval(_iv); });
    b.addEventListener('mouseleave', function(){ clearInterval(_iv); });
    b.addEventListener('touchend',   function(){ clearInterval(_iv); });
    return b;
  }

  var step = 0.015; // pan distance per click (degrees)

  pad.appendChild(makeBtn('▲', 1, 2, function(c){ map.panTo([c.lat + step, c.lng]); }));
  pad.appendChild(makeBtn('◀', 2, 1, function(c){ map.panTo([c.lat, c.lng - step]); }));
  pad.appendChild(makeBtn('▶', 2, 3, function(c){ map.panTo([c.lat, c.lng + step]); }));
  pad.appendChild(makeBtn('▼', 3, 2, function(c){ map.panTo([c.lat - step, c.lng]); }));

  var mapEl = document.getElementById('tr-tracking-map');
  if (mapEl) mapEl.appendChild(pad);
})(map);
// ── end arrow pad ────────────────────────────────────────────
    var bounds = [];

    if (hasPickup) {
      var pickIcon = L.divIcon({
        html: '<div style="background:#1a6b3a;color:white;border-radius:50% 50% 50% 0;width:34px;height:34px;' +
              'display:flex;align-items:center;justify-content:center;font-size:15px;' +
              'transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.3);">' +
              '<span style="transform:rotate(45deg)">📍</span></div>',
        iconSize:[34,34], iconAnchor:[17,34], className:''
      });
      L.marker([pickupLat, pickupLng], {icon: pickIcon}).addTo(map)
        .bindPopup('<strong>📍 Pickup</strong><br>' + (req.pickup_address || req.pickup_city || ''));
      bounds.push([pickupLat, pickupLng]);
    }

    if (hasDeliv) {
      var delivIcon = L.divIcon({
        html: '<div style="background:#1d4ed8;color:white;border-radius:50% 50% 50% 0;width:34px;height:34px;' +
              'display:flex;align-items:center;justify-content:center;font-size:15px;' +
              'transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.3);">' +
              '<span style="transform:rotate(45deg)">🏪</span></div>',
        iconSize:[34,34], iconAnchor:[17,34], className:''
      });
      L.marker([delivLat, delivLng], {icon: delivIcon}).addTo(map)
        .bindPopup('<strong>🏪 Delivery</strong><br>' + (req.delivery_address || req.delivery_city || ''));
      bounds.push([delivLat, delivLng]);
    }

    if (hasCurrent) {
      var curIcon = L.divIcon({
        html: '<div style="position:relative;width:38px;height:38px;">' +
              '<div style="position:absolute;inset:0;border-radius:50%;background:rgba(124,58,237,.25);' +
              'animation:trPulse 1.6s infinite;"></div>' +
              '<div style="position:absolute;inset:7px;border-radius:50%;background:#7c3aed;' +
              'display:flex;align-items:center;justify-content:center;font-size:13px;">🚛</div></div>',
        iconSize:[38,38], iconAnchor:[19,19], className:''
      });
      L.marker([curLat, curLng], {icon: curIcon}).addTo(map)
        .bindPopup('<strong>🚛 Vehicle Location</strong>');
      bounds.push([curLat, curLng]);
    }

    if (hasPickup && hasDeliv) {
      L.polyline([[pickupLat, pickupLng], [delivLat, delivLng]], {
        color:'#7c3aed', weight:3, opacity:.55, dashArray:'8,6'
      }).addTo(map);
    }

    if (bounds.length >= 2) map.fitBounds(bounds, {padding:[40,40]});

    // No coords — show city info instead
    if (!hasPickup && !hasDeliv && loader) {
      loader.style.display = 'flex';
      loader.innerHTML =
        '<div style="font-size:36px;margin-bottom:8px;">🗺️</div>' +
        '<div style="font-size:15px;font-weight:600;color:#374151;">' +
          esc(req.pickup_city || '?') + ' → ' + esc(req.delivery_city || '?') +
        '</div>' +
        '<div style="font-size:12px;color:#9ca3af;margin-top:4px;">GPS coordinates not captured for this request.</div>';
    }

    // Pulse keyframe
    if (!document.getElementById('tr-pulse-css')) {
      var sty = document.createElement('style');
      sty.id  = 'tr-pulse-css';
      sty.textContent = '@keyframes trPulse{0%{transform:scale(1);opacity:.7}50%{transform:scale(2);opacity:.1}100%{transform:scale(1);opacity:.7}}';
      document.head.appendChild(sty);
    }
  }

  function esc(v) { return v ? String(v).replace(/</g,'&lt;') : ''; }

  if (typeof L === 'undefined') {
    /*
    if (!document.getElementById('leaflet-css')) {
      var lnk = document.createElement('link');
      lnk.id  = 'leaflet-css'; lnk.rel = 'stylesheet';
      lnk.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(lnk);
    }
    */
    if (!document.getElementById('leaflet-js')) {
      var scr = document.createElement('script');
      scr.id  = 'leaflet-js';
      scr.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      scr.onload = _initMapNow;
      document.head.appendChild(scr);
    } else {
      // Script tag exists but L not ready yet — wait
      var tries = 0;
      var wait = setInterval(function() {
        tries++;
        if (typeof L !== 'undefined') { clearInterval(wait); _initMapNow(); }
        if (tries > 30) clearInterval(wait);
      }, 100);
    }
  } else {
    _initMapNow();
  }
}

/*
  Premium seller transport overrides.
  transport.js is loaded after seller.js, so these definitions become the active ones.
*/
function loadTransportScreenSeller() {
  var container = document.getElementById('transport-requests-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  apiGet('transport/my-requests', { limit: 50 }).then(function(res) {
    if (res.error && !res.data) {
      container.innerHTML =
        '<div class="transport-empty">' +
          '<div class="empty-title">Transport data is unavailable</div>' +
          '<div class="empty-sub">' + escapeHtml(res.error) + '</div>' +
          '<button class="btn primary" style="margin-top:18px;" onclick="openTransportRequestModal()">Try again</button>' +
        '</div>';
      return;
    }

    var rows = res.data && res.data.rows ? res.data.rows : [];
    if (!rows.length) {
      container.innerHTML =
        '<div class="transport-empty">' +
          '<div class="empty-title">No transport requests yet</div>' +
          '<div class="empty-sub">Create a request when you need pickup, dispatch, payment protection, and tracking in one place.</div>' +
          '<button class="btn primary" style="margin-top:18px;" onclick="openTransportRequestModal()">Create your first request</button>' +
        '</div>';
      return;
    }

    container.innerHTML = '<div class="transport-stack">' + rows.map(_renderTransportRow).join('') + '</div>';
  });
}

function _transportStatusMeta(status) {
  var map = {
    open:       { label: 'Submitted - Awaiting Review', className: 'is-open' },
    processed:  { label: 'Accepted - Ready for Payment', className: 'is-processed' },
    accepted:   { label: 'Accepted - Ready for Payment', className: 'is-processed' },
    paid:       { label: 'Paid - Awaiting Dispatch', className: 'is-paid' },
    booked:     { label: 'Booked - Awaiting Pickup', className: 'is-paid' },
    in_transit: { label: 'In Transit', className: 'is-transit' },
    delivered:  { label: 'Delivered', className: 'is-delivered' },
    cancelled:  { label: 'Cancelled', className: 'is-cancelled' }
  };
  return map[String(status || '').toLowerCase()] || {
    label: String(status || 'Unknown').replace(/_/g, ' '),
    className: ''
  };
}

function _renderTransportRow(req) {
  var statusKey = String(req.status || '').toLowerCase();
  var paymentKey = String(req.payment_status || '').toLowerCase();
  var statusMeta = _transportStatusMeta(statusKey);
  var agreedAmount = parseFloat(req.agreed_price_inr || 0) || 0;
  var bidCount = parseInt(req.bid_count || 0, 10) || 0;
  var canPay = agreedAmount > 0 &&
    (statusKey === 'processed' || statusKey === 'accepted') &&
    paymentKey !== 'paid' &&
    paymentKey !== 'in_escrow' &&
    paymentKey !== 'released';
  var canTrack = statusKey === 'in_transit' || statusKey === 'delivered';
  var quoteCopy = bidCount > 0
    ? bidCount + ' transporter quote' + (bidCount > 1 ? 's' : '') + ' received'
    : 'Admin is reviewing the route and transport commercial.';
  var shortId = escapeHtml((req.id || '').slice(0, 8).toUpperCase());

  return '' +
    '<article class="transport-request-card">' +
      '<div class="transport-request-head">' +
        '<div>' +
          '<div class="transport-request-title">' + escapeHtml(req.title || 'Goods Transport') + '</div>' +
          '<div class="transport-request-meta">' +
            escapeHtml(String(req.quantity_kg || '0')) + ' kg' +
            '  ' + escapeHtml(req.pickup_city || 'Pickup pending') +
            ' to ' + escapeHtml(req.delivery_city || 'Delivery pending') +
            '  Request ' + shortId +
          '</div>' +
        '</div>' +
        '<span class="transport-status-pill ' + statusMeta.className + '">' + escapeHtml(statusMeta.label) + '</span>' +
      '</div>' +
      '<div class="transport-route-grid">' +
        '<div class="transport-route-stop pickup">' +
          '<div class="transport-route-label">Pickup</div>' +
          '<div class="transport-route-value">' + escapeHtml(req.pickup_address || req.pickup_city || 'Pickup address pending') + '</div>' +
        '</div>' +
        '<div class="transport-route-stop delivery">' +
          '<div class="transport-route-label">Delivery</div>' +
          '<div class="transport-route-value">' + escapeHtml(req.delivery_address || req.delivery_city || 'Delivery address pending') + '</div>' +
        '</div>' +
      '</div>' +
      (req.description ? '<div class="transport-note-copy">' + escapeHtml(req.description) + '</div>' : '') +
      '<div class="transport-card-footer">' +
        '<div>' +
          '<div class="transport-price-label">Commercials</div>' +
          (agreedAmount > 0
            ? '<div class="transport-price">' + formatINR(agreedAmount) + '</div>'
            : '<div class="transport-price pending">Price pending admin review</div>') +
          '<div class="transport-price-sub">' + escapeHtml(quoteCopy) + '</div>' +
        '</div>' +
        '<div class="transport-card-actions">' +
          (canPay
            ? '<button class="btn primary sm" onclick="payTransportRequest(\'' + escapeHtml(req.id) + '\', \'' + escapeHtml(String(agreedAmount)) + '\')">Pay ' + formatINR(agreedAmount) + '</button>'
            : '') +
          (canTrack
            ? '<button class="btn sm" onclick="openTrackingMap(\'' + escapeHtml(req.id) + '\')">Track Shipment</button>'
            : '') +
        '</div>' +
      '</div>' +
      ((paymentKey === 'paid' || paymentKey === 'in_escrow' || paymentKey === 'released')
        ? '<div class="transport-info-strip is-success">Payment is secured. Admin will dispatch the shipment once the transporter is assigned.</div>'
        : '') +
      (canTrack
        ? '<div class="transport-info-strip is-info">Live tracking is available for this request. Open the tracking map to follow the shipment.</div>'
        : '') +
    '</article>';
}

function openTransportRequestModal(dealId, prefillTitle, prefillQty, prefillCity) {
  var user = (window.AppState && window.AppState.user) || {};
  var pickupCity = prefillCity || user.city || '';
  var pickupState = user.state || '';
  var pickupAddress = user.address || (pickupCity ? pickupCity + ' warehouse' : '');
  var goodsTitle = prefillTitle || '';
  var quantity = prefillQty ? String(prefillQty) : '';

  var bodyHTML = '' +
    '<div class="transport-form-grid">' +
      '<div class="transport-form-top">' +
        '<div class="form-group transport-form-span-2">' +
          '<label>Goods Description <span class="req">*</span></label>' +
          '<input class="form-control" type="text" id="tr-title" placeholder="e.g. Premium wheat bags, steel coils, packaged stock" value="' + escapeHtml(goodsTitle) + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Category <span class="req">*</span></label>' +
          '<select class="form-control" id="tr-category">' +
            '<option value="">Select category</option>' +
            '<option>Agriculture / Farm Produce</option>' +
            '<option>Manufacturing / Industrial</option>' +
            '<option>Textiles &amp; Fabric</option>' +
            '<option>Food &amp; Processed</option>' +
            '<option>Raw Materials</option>' +
            '<option>Electronics &amp; Components</option>' +
            '<option>Other</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Total Weight (kg) <span class="req">*</span></label>' +
          '<input class="form-control" type="number" id="tr-qty" min="1" placeholder="e.g. 500" value="' + escapeHtml(quantity) + '">' +
        '</div>' +
      '</div>' +
      '<section class="transport-section pickup">' +
        '<div class="transport-section-title">Pickup Location</div>' +
        '<div class="transport-section-sub">Where the goods will be collected from.</div>' +
        '<div class="transport-section-grid">' +
          '<div class="form-group transport-form-span-2">' +
            '<label>Full Pickup Address <span class="req">*</span></label>' +
            '<textarea class="form-control" id="tr-pickup-addr" rows="3" placeholder="Door, street, area, landmark">' + escapeHtml(pickupAddress) + '</textarea>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Pickup City <span class="req">*</span></label>' +
            '<input class="form-control" type="text" id="tr-pickup-city" placeholder="e.g. Mumbai" value="' + escapeHtml(pickupCity) + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label>State</label>' +
            '<input class="form-control" type="text" id="tr-pickup-state" placeholder="e.g. Maharashtra" value="' + escapeHtml(pickupState) + '">' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<section class="transport-section delivery">' +
        '<div class="transport-section-title">Delivery Location</div>' +
        '<div class="transport-section-sub">Where the shipment needs to be dropped off.</div>' +
        '<div class="transport-section-grid">' +
          '<div class="form-group transport-form-span-2">' +
            '<label>Full Delivery Address <span class="req">*</span></label>' +
            '<textarea class="form-control" id="tr-delivery-addr" rows="3" placeholder="Warehouse, shop, factory, or landmark"></textarea>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Delivery City <span class="req">*</span></label>' +
            '<input class="form-control" type="text" id="tr-delivery-city" placeholder="e.g. Delhi">' +
          '</div>' +
          '<div class="form-group">' +
            '<label>State</label>' +
            '<input class="form-control" type="text" id="tr-delivery-state" placeholder="e.g. Delhi">' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<div class="transport-form-top">' +
        '<div class="form-group">' +
          '<label>Goods Ready Date <span class="req">*</span></label>' +
          '<input class="form-control" type="date" id="tr-date" min="' + new Date().toISOString().split('T')[0] + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Budget Cap (optional)</label>' +
          '<input class="form-control" type="number" id="tr-budget" placeholder="e.g. 5000">' +
        '</div>' +
      '</div>' +
      '<div class="transport-inline-note">Admin reviews each request, confirms the route, and sets the verified transport price before payment is collected.</div>' +
      '<div id="tr-error" class="transport-error" style="display:none;"></div>' +
    '</div>';

  openModal({
    title: 'New Transport Request',
    sub: 'Admin reviews the request and finalizes the transport price within 24 hours',
    badge: 'Free Submission',
    badgeClass: 'active',
    bodyHTML: bodyHTML,
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="tr-submit-btn" onclick="submitTransportRequest(\'' + (dealId || '') + '\')">Submit Request</button>',
    wide: true
  });
}

function submitTransportRequest(dealId) {
  var errEl = document.getElementById('tr-error');
  var btn = document.getElementById('tr-submit-btn');
  var user = (window.AppState && window.AppState.user) || {};
  var dealSeed = window._pendingTransportDeal || {};
  var hasFullForm = !!document.getElementById('tr-title');
  var payload;
  var missing = [];

  if (hasFullForm) {
    var fields = {
      title:         document.getElementById('tr-title'),
      category:      document.getElementById('tr-category'),
      qty:           document.getElementById('tr-qty'),
      pickupAddr:    document.getElementById('tr-pickup-addr'),
      pickupCity:    document.getElementById('tr-pickup-city'),
      pickupState:   document.getElementById('tr-pickup-state'),
      deliveryAddr:  document.getElementById('tr-delivery-addr'),
      deliveryCity:  document.getElementById('tr-delivery-city'),
      deliveryState: document.getElementById('tr-delivery-state'),
      date:          document.getElementById('tr-date'),
      budget:        document.getElementById('tr-budget')
    };

    if (!fields.title || !fields.title.value.trim()) missing.push('goods description');
    if (!fields.category || !fields.category.value) missing.push('category');
    if (!fields.qty || !parseFloat(fields.qty.value)) missing.push('total weight');
    if (!fields.pickupAddr || !fields.pickupAddr.value.trim()) missing.push('pickup address');
    if (!fields.pickupCity || !fields.pickupCity.value.trim()) missing.push('pickup city');
    if (!fields.deliveryAddr || !fields.deliveryAddr.value.trim()) missing.push('delivery address');
    if (!fields.deliveryCity || !fields.deliveryCity.value.trim()) missing.push('delivery city');
    if (!fields.date || !fields.date.value) missing.push('goods ready date');

    payload = {
      deal_id:          dealId || '',
      title:            fields.title ? fields.title.value.trim() : '',
      category:         fields.category ? fields.category.value : 'Goods',
      quantity_kg:      fields.qty ? parseFloat(fields.qty.value) : 0,
      pickup_address:   fields.pickupAddr ? fields.pickupAddr.value.trim() : '',
      pickup_city:      fields.pickupCity ? fields.pickupCity.value.trim() : '',
      pickup_state:     fields.pickupState ? fields.pickupState.value.trim() : '',
      delivery_address: fields.deliveryAddr ? fields.deliveryAddr.value.trim() : '',
      delivery_city:    fields.deliveryCity ? fields.deliveryCity.value.trim() : '',
      delivery_state:   fields.deliveryState ? fields.deliveryState.value.trim() : '',
      pickup_date:      fields.date ? fields.date.value : '',
      budget_inr:       fields.budget && fields.budget.value ? parseFloat(fields.budget.value) : '',
      description:      ''
    };
  } else {
    var deliveryCity = document.getElementById('tr-delivery-city');
    var deliveryAddr = document.getElementById('tr-delivery-addr');
    var pickupDate = document.getElementById('tr-pickup-date');
    var budget = document.getElementById('tr-budget');
    var notes = document.getElementById('tr-notes');

    if (!deliveryCity || !deliveryCity.value.trim()) missing.push('delivery city');
    if (!pickupDate || !pickupDate.value) missing.push('pickup date');

    payload = {
      deal_id:          dealId || dealSeed.deal_id || '',
      title:            dealSeed.title || 'Goods Transport',
      category:         'Goods',
      quantity_kg:      parseFloat(dealSeed.qty || 0) || 0,
      pickup_address:   user.address || '',
      pickup_city:      dealSeed.city || user.city || '',
      pickup_state:     user.state || '',
      delivery_address: deliveryAddr ? deliveryAddr.value.trim() : '',
      delivery_city:    deliveryCity ? deliveryCity.value.trim() : '',
      delivery_state:   '',
      pickup_date:      pickupDate ? pickupDate.value : '',
      budget_inr:       budget && budget.value ? parseFloat(budget.value) : '',
      description:      notes && notes.value ? notes.value.trim() : ''
    };
  }

  if (missing.length) {
    if (errEl) {
      errEl.textContent = 'Please complete: ' + missing.join(', ') + '.';
      errEl.style.display = 'block';
    } else {
      toast('Please complete: ' + missing.join(', ') + '.', 'warning');
    }
    return;
  }

  if (errEl) errEl.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting Request...';
  }

  apiPost('transport/request/create', payload).then(function(res) {
    if (res.data && res.data.success) {
      window._pendingTransportDeal = null;
      closeModalDirect();
      toast('Transport request submitted. Admin will review and set the price shortly.', 'success', 5000);
      loadTransportScreenSeller();
      return;
    }

    var message = (res.data && res.data.detail) || res.error || 'Submission failed. Please try again.';
    if (errEl) {
      errEl.textContent = message;
      errEl.style.display = 'block';
    } else {
      toast(message, 'danger', 5000);
    }
  }).finally(function() {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Submit Request';
    }
  });
}

function payTransportRequest(requestId, agreedPrice) {
  var amount = parseFloat(agreedPrice || 0) || 0;
  if (amount <= 0) {
    toast('Transport price is not ready yet. Please wait for admin review.', 'warning');
    return;
  }

  openModal({
    title: 'Pay for Transport',
    sub: 'Secure Razorpay checkout with escrow protection',
    badge: 'Secure Payment',
    badgeClass: 'warning',
    bodyHTML:
      '<div class="transport-payment-shell">' +
        '<div class="transport-payment-breakdown">' +
          '<div class="transport-price-label">Transport Booking</div>' +
          '<div class="transport-payment-total">' + formatINR(amount) + '</div>' +
          '<div class="transport-price-sub">The confirmed route price will be held in escrow and released only after delivery is completed.</div>' +
          '<div class="transport-payment-lines">' +
            '<div class="transport-payment-row"><span>Verified transport charge</span><strong>' + formatINR(amount) + '</strong></div>' +
            '<div class="transport-payment-row"><span>Payment protection</span><strong>Included</strong></div>' +
          '</div>' +
        '</div>' +
        '<div class="transport-info-strip is-info">Test mode card: 4111 1111 1111 1111. Use any future expiry date and any CVV.</div>' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" onclick="openTransportRazorpay(\'' + requestId + '\', \'' + amount + '\')">Pay ' + formatINR(amount) + '</button>'
  });
}

function openTransportRazorpay(requestId, amount) {
  apiPost('transport/payment/create-order', { request_id: requestId })
    .then(function(res) {
      if (!res.data || !res.data.order_id) {
        toast((res.data && res.data.detail) || res.error || 'Could not create the payment order. Please try again.', 'danger', 6000);
        return;
      }
      closeModalDirect();

      var options = {
        key:         res.data.razorpay_key_id,
        amount:      res.data.amount_paise,
        currency:    'INR',
        name:        'TradeLink Transport',
        description: 'Transport Request #' + requestId.substring(0, 8),
        order_id:    res.data.order_id,
        prefill: {
          name:  AppState.user && AppState.user.name,
          email: AppState.user && AppState.user.email
        },
        theme: { color: '#1a6b3a' },
        handler: function(response) {
          toast('Verifying payment...', 'info', 2000);
          apiPost('transport/payment/verify', {
            request_id:           requestId,
            razorpay_payment_id:  response.razorpay_payment_id,
            razorpay_order_id:    response.razorpay_order_id,
            razorpay_signature:   response.razorpay_signature
          }).then(function(vRes) {
            if (vRes.data && vRes.data.success) {
              toast('Payment confirmed. Admin will dispatch your shipment shortly.', 'success', 6000);
              loadTransportScreenSeller();
            } else {
              toast((vRes.data && vRes.data.detail) || vRes.error || 'Payment verification failed. Contact support.', 'danger', 6000);
            }
          });
        },
        modal: {
          ondismiss: function() { toast('Payment cancelled.', 'warning'); }
        }
      };

      function doOpen() {
        var rzp = new window.Razorpay(options);
        rzp.on('payment.failed', function(r) {
          toast('Payment failed: ' + (r.error.description || 'Try again'), 'danger');
        });
        rzp.open();
      }

      if (window.Razorpay) {
        doOpen();
      } else {
        var s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.onload = doOpen;
        document.head.appendChild(s);
      }
    });
}

/*
  Final tracking modal overrides.
  These definitions are appended last so they win over the duplicated legacy versions above.
*/
function _trackingStatusMeta(status) {
  var key = String(status || '').toLowerCase();
  var map = {
    open:       { label: 'Submitted', badgeClass: 'pending' },
    processed:  { label: 'Accepted', badgeClass: 'info' },
    accepted:   { label: 'Accepted', badgeClass: 'info' },
    paid:       { label: 'Paid', badgeClass: 'info' },
    booked:     { label: 'Booked', badgeClass: 'info' },
    in_transit: { label: 'In transit', badgeClass: 'active' },
    delivered:  { label: 'Delivered', badgeClass: 'active' },
    cancelled:  { label: 'Cancelled', badgeClass: 'danger' }
  };
  return map[key] || { label: 'In progress', badgeClass: 'brand' };
}

function _recenterTrackingMap() {
  if (window._trMap && window._trMapBounds) {
    window._trMap.fitBounds(window._trMapBounds, { padding: [36, 36] });
  }
}

function openTrackingMap(requestId) {
  openModal({
    title: 'Shipment tracking',
    sub: 'Request #' + String(requestId || '').slice(0, 8).toUpperCase(),
    badge: 'Live',
    badgeClass: 'active',
    wide: true,
    bodyHTML:
      '<div class="tracking-shell">' +
        '<div class="tracking-hero">' +
          '<div>' +
            '<div class="tracking-kicker">Live shipment status</div>' +
            '<div class="tracking-route" id="tr-modal-subtitle">Loading route details...</div>' +
          '</div>' +
          '<div class="tracking-live-pill" id="tr-status-pill">Syncing</div>' +
        '</div>' +
        '<div class="tracking-meta-grid">' +
          '<div class="tracking-meta-card">' +
            '<span>Pickup</span>' +
            '<strong id="tr-pickup-city">Loading...</strong>' +
            '<p id="tr-pickup-copy">Waiting for route data.</p>' +
          '</div>' +
          '<div class="tracking-meta-card">' +
            '<span>Delivery</span>' +
            '<strong id="tr-delivery-city">Loading...</strong>' +
            '<p id="tr-delivery-copy">Waiting for route data.</p>' +
          '</div>' +
          '<div class="tracking-meta-card">' +
            '<span>Transporter</span>' +
            '<strong id="tr-transporter-name">Loading...</strong>' +
            '<p id="tr-vehicle-copy">Vehicle details loading.</p>' +
          '</div>' +
        '</div>' +
        '<div class="tracking-layout">' +
          '<div class="tracking-map-card">' +
            '<div class="tracking-map-toolbar">' +
              '<button class="btn sm" onclick="_recenterTrackingMap()">Recenter route</button>' +
            '</div>' +
            '<div id="tr-tracking-map" class="tracking-map"></div>' +
            '<div id="tr-map-loader" class="tracking-loader">Loading map and route updates...</div>' +
          '</div>' +
          '<div class="tracking-timeline-card">' +
            '<div class="transport-section-title">Delivery timeline</div>' +
            '<div class="transport-section-sub">Latest milestones for this shipment.</div>' +
            '<div id="tr-timeline-steps" class="tracking-step-list">' +
              '<div class="tracking-empty">Loading timeline...</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>',
    footerHTML: '<button class="btn" onclick="closeModalDirect()">Close</button>'
  });
  _loadTrackingData(requestId);
}

function _loadTrackingData(requestId) {
  var token = (AppState && AppState.token) ? AppState.token : (window._authToken || '');
  var base  = window.API_BASE || 'http://localhost:8000/api';

  fetch(base + '/transport/tracking/' + requestId, {
    headers: { 'Authorization': 'Bearer ' + token, 'X-User-Role': 'seller' }
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d && (d.request || d.status)) {
      var req = d.request || d;
      if (!req.id) req.id = req.request_id || requestId;
      _renderTrackingUI(req, d.tracking_notes || d.notes || []);
      return;
    }

    fetch(base + '/transport/my-requests?limit=50', {
      headers: { 'Authorization': 'Bearer ' + token, 'X-User-Role': 'seller' }
    })
    .then(function(r2) { return r2.json(); })
    .then(function(md) {
      var list = md.requests || md.data || [];
      var req = list.find(function(item) { return item.id === requestId; });
      if (req) {
        _renderTrackingUI(req, []);
      } else {
        var sub = document.getElementById('tr-modal-subtitle');
        if (sub) sub.textContent = 'Tracking details could not be loaded.';
      }
    }).catch(function() {
      var sub = document.getElementById('tr-modal-subtitle');
      if (sub) sub.textContent = 'Tracking details could not be loaded.';
    });
  })
  .catch(function() {
    var sub = document.getElementById('tr-modal-subtitle');
    if (sub) sub.textContent = 'Error loading tracking. Check the server connection.';
  });
}

function _renderTrackingUI(req, rawNotes) {
  var statusMeta = _trackingStatusMeta(req.status);
  var sub = document.getElementById('tr-modal-subtitle');
  var statusPill = document.getElementById('tr-status-pill');
  var pickupCity = document.getElementById('tr-pickup-city');
  var pickupCopy = document.getElementById('tr-pickup-copy');
  var deliveryCity = document.getElementById('tr-delivery-city');
  var deliveryCopy = document.getElementById('tr-delivery-copy');
  var transporterName = document.getElementById('tr-transporter-name');
  var vehicleCopy = document.getElementById('tr-vehicle-copy');
  var modalTitle = document.getElementById('modal-title');
  var modalSub = document.getElementById('modal-sub');
  var modalBadge = document.getElementById('modal-badge');

  if (modalTitle) modalTitle.textContent = req.title || 'Shipment tracking';
  if (modalSub) modalSub.textContent = 'Request #' + String(req.id || req.request_id || '').slice(0, 8).toUpperCase();
  if (modalBadge) {
    modalBadge.textContent = statusMeta.label;
    modalBadge.className = 'badge ' + statusMeta.badgeClass;
  }
  if (sub) sub.textContent = (req.pickup_city || 'Pickup pending') + ' to ' + (req.delivery_city || 'Delivery pending');
  if (statusPill) statusPill.textContent = statusMeta.label;
  if (pickupCity) pickupCity.textContent = req.pickup_city || 'Pickup pending';
  if (pickupCopy) pickupCopy.textContent = req.pickup_address || 'Pickup address not added yet.';
  if (deliveryCity) deliveryCity.textContent = req.delivery_city || 'Delivery pending';
  if (deliveryCopy) deliveryCopy.textContent = req.delivery_address || 'Delivery address not added yet.';
  if (transporterName) transporterName.textContent = req.transporter || req.transporter_name || 'Awaiting assignment';
  if (vehicleCopy) vehicleCopy.textContent = req.vehicle ? ('Vehicle ' + req.vehicle) : 'Vehicle details will appear after dispatch.';

  var notes = [];
  if (Array.isArray(rawNotes)) {
    notes = rawNotes;
  } else if (typeof rawNotes === 'string') {
    try { notes = JSON.parse(rawNotes); } catch (e) { notes = []; }
  }
  if (!notes.length && req.tracking_notes) {
    if (Array.isArray(req.tracking_notes)) notes = req.tracking_notes;
    else {
      try { notes = JSON.parse(req.tracking_notes); } catch (e2) { notes = []; }
    }
  }

  var STEPS = [
    { key:'order_placed',     icon:'01', label:'Order placed',      desc:'Transport request submitted' },
    { key:'payment_done',     icon:'02', label:'Payment confirmed', desc:'Escrow payment secured' },
    { key:'dispatched',       icon:'03', label:'Dispatched',        desc:'Shipment dispatched for movement' },
    { key:'picked_up',        icon:'04', label:'Picked up',         desc:'Loaded on the assigned vehicle' },
    { key:'in_transit',       icon:'05', label:'In transit',        desc:'Shipment is moving to destination' },
    { key:'arrived_city',     icon:'06', label:'Arrived in city',   desc:'Reached the destination city' },
    { key:'out_for_delivery', icon:'07', label:'Out for delivery',  desc:'Final delivery run in progress' },
    { key:'delivered',        icon:'08', label:'Delivered',         desc:'Shipment delivered successfully' }
  ];

  var status = String(req.status || '').toLowerCase();
  var payDone = req.payment_status === 'paid' || req.payment_status === 'in_escrow';
  var doneKeys = { order_placed: true };
  if (payDone) doneKeys.payment_done = true;
  if (status === 'paid' || status === 'dispatched' || status === 'in_transit' || status === 'delivered') {
    doneKeys.dispatched = true;
  }
  if (status === 'in_transit' || status === 'delivered') {
    doneKeys.picked_up = true;
    doneKeys.in_transit = true;
  }
  if (status === 'delivered') {
    STEPS.forEach(function(step) { doneKeys[step.key] = true; });
  }

  notes.forEach(function(note) {
    var key = String(note.status || '').toLowerCase();
    if (!key) return;
    doneKeys[key] = true;
    if (key.indexOf('arrived') !== -1) doneKeys.arrived_city = true;
    if (key.indexOf('out_for') !== -1) doneKeys.out_for_delivery = true;
  });

  var activeKey = 'order_placed';
  STEPS.forEach(function(step) {
    if (doneKeys[step.key]) activeKey = step.key;
  });

  function getNoteFor(key) {
    var matches = notes.filter(function(note) {
      return String(note.status || '').toLowerCase() === key;
    });
    if (!matches.length) return '';
    return matches[matches.length - 1].note || '';
  }

  var timelineEl = document.getElementById('tr-timeline-steps');
  if (timelineEl) {
    timelineEl.innerHTML = STEPS.map(function(step, index) {
      var isDone = !!doneKeys[step.key];
      var isActive = step.key === activeKey;
      var isLast = index === STEPS.length - 1;
      var noteText = escapeHtml(getNoteFor(step.key) || step.desc);
      var itemClass = isActive ? ' is-active' : (isDone ? ' is-done' : '');

      return '<div class="tracking-step' + itemClass + '">' +
        '<div class="tracking-step-rail">' +
          '<div class="tracking-step-dot">' + step.icon + '</div>' +
          (!isLast ? '<div class="tracking-step-line"></div>' : '') +
        '</div>' +
        '<div class="tracking-step-body">' +
          '<div class="tracking-step-title">' + step.label + (isActive ? '<span class="tracking-step-tag">Now</span>' : '') + '</div>' +
          '<div class="tracking-step-copy">' + noteText + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  _renderLeafletMap(req);
}

function _renderLeafletMap(req) {
  var pickupLat = parseFloat(req.pickup_lat || 0);
  var pickupLng = parseFloat(req.pickup_lng || 0);
  var deliveryLat = parseFloat(req.delivery_lat || 0);
  var deliveryLng = parseFloat(req.delivery_lng || 0);
  var currentLat = parseFloat(req.current_lat || 0);
  var currentLng = parseFloat(req.current_lng || 0);

  var hasPickup = pickupLat !== 0 && pickupLng !== 0;
  var hasDelivery = deliveryLat !== 0 && deliveryLng !== 0;
  var hasCurrent = currentLat !== 0 && currentLng !== 0;

  function initMapNow() {
    var mapEl = document.getElementById('tr-tracking-map');
    var loader = document.getElementById('tr-map-loader');
    if (!mapEl) return;

    if (window._trMap) {
      try { window._trMap.remove(); } catch (e) {}
      window._trMap = null;
    }
    window._trMapBounds = null;

    // Hide the loader entirely once we start initializing the map
    if (loader) loader.style.display = 'none';

    if (!hasPickup && !hasDelivery && !hasCurrent) {
      // If no GPS data, we just show the map centered on default location without blocking text.
    }

    var seedLat = hasCurrent ? currentLat : (hasPickup ? pickupLat : (hasDelivery ? deliveryLat : 20.5937));
    var seedLng = hasCurrent ? currentLng : (hasPickup ? pickupLng : (hasDelivery ? deliveryLng : 78.9629));
    var map = L.map('tr-tracking-map', { zoomControl: true }).setView([seedLat, seedLng], 7);
    window._trMap = map;

    // Standard Light Mode Tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19
    }).addTo(map);

    // No overlay styling needed anymore as we are removing the loader entirely.

    var points = [];
    if (hasPickup) {
      L.marker([pickupLat, pickupLng]).addTo(map)
        .bindPopup('<strong>Pickup</strong><br>' + escapeHtml(req.pickup_address || req.pickup_city || 'Pickup point'));
      points.push([pickupLat, pickupLng]);
    }
    if (hasDelivery) {
      L.marker([deliveryLat, deliveryLng]).addTo(map)
        .bindPopup('<strong>Delivery</strong><br>' + escapeHtml(req.delivery_address || req.delivery_city || 'Delivery point'));
      points.push([deliveryLat, deliveryLng]);
    }
    if (hasCurrent) {
      L.circleMarker([currentLat, currentLng], {
        radius: 10,
        color: '#8ef5bf',
        weight: 2,
        fillColor: '#8ef5bf',
        fillOpacity: 0.45
      }).addTo(map).bindPopup('<strong>Current vehicle location</strong>');
      points.push([currentLat, currentLng]);
    }
    if (hasPickup && hasDelivery) {
      L.polyline([[pickupLat, pickupLng], [deliveryLat, deliveryLng]], {
        color: '#d6fce2',
        weight: 3,
        opacity: 0.72,
        dashArray: '10 8'
      }).addTo(map);
    }

    if (points.length >= 2) {
      window._trMapBounds = L.latLngBounds(points);
      map.fitBounds(window._trMapBounds, { padding: [36, 36] });
    } else if (points.length === 1) {
      map.setView(points[0], 10);
    }

    setTimeout(function() {
      if (window._trMap) {
        window._trMap.invalidateSize();
        // Recenter if we have bounds, otherwise it just stays at base center
        if (window._trMapBounds) {
          window._trMap.fitBounds(window._trMapBounds, { padding: [36, 36] });
        }
      }
    }, 150); // Increased timeout slightly for better stability
  }

  if (typeof L === 'undefined') {
    if (!document.getElementById('leaflet-js')) {
      var scr = document.createElement('script');
      scr.id = 'leaflet-js';
      scr.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      scr.onload = initMapNow;
      document.head.appendChild(scr);
    } else {
      var tries = 0;
      var wait = setInterval(function() {
        tries++;
        if (typeof L !== 'undefined') {
          clearInterval(wait);
          initMapNow();
        }
        if (tries > 30) clearInterval(wait);
      }, 100);
    }
  } else {
    initMapNow();
  }
}

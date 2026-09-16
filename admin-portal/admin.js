/**
 * TRADELINK — Admin Portal  (admin-portal/admin.js)
 * Fixed:
 *  1. reads d.requests (not d.rows) — transport requests now show
 *  2. dispatch button shows for status="paid" with payment_status="in_escrow"
 *  3. rich dispatch modal with tracking number + transporter name
 *  4. status update controls when in_transit
 */
'use strict';

var API_BASE = (window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1')
  ? 'http://localhost:8000/api'
  : 'https://tradelink-backend-cp06.onrender.com/api';

var adminKey = '';

/* ─── HELPERS ─── */
function api(method, path, body) {
  var opts = {
    method:  method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(API_BASE + path, opts)
    .then(function(r) { return r.json(); })
    .catch(function(e) { return { error: e.message }; });
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtINR(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
function toast(msg, type) {
  var host = document.getElementById('toast-container');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-container';
    document.body.appendChild(host);
  }
  var d = document.createElement('div');
  d.className = 'admin-toast ' + (type || 'info');
  d.textContent = msg;
  host.appendChild(d);
  setTimeout(function() { if (d.parentNode) d.remove(); }, 4500);
}
function closeModal(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
}
function adminEmpty(title, body) {
  return '<div class="admin-empty"><strong style="display:block;color:#f8fafc;margin-bottom:8px;">' +
    esc(title) + '</strong><span>' + esc(body || '') + '</span></div>';
}
function adminField(label, value) {
  return '<div class="admin-field">' +
    '<div class="admin-field-label">' + esc(label) + '</div>' +
    '<div class="admin-field-value">' + value + '</div>' +
  '</div>';
}

/* ─── LOGIN ─── */
function handleAdminLogin() {
  var key = ((document.getElementById('admin-key') || {}).value || '').trim();
  if (!key) { toast('Enter admin key', 'danger'); return; }
  adminKey = key;
  api('GET', '/admin/stats').then(function(d) {
    if (d.error || d.detail) {
      toast('Wrong admin key or server not running.', 'danger');
      adminKey = '';
    } else {
      document.getElementById('login-section').style.display = 'none';
      document.getElementById('admin-panel').style.display   = 'block';
      loadStats(d);
      loadTab('transport');
    }
  });
}

/* ─── STATS ─── */
function loadStats(data) {
  var map = {
    'stat-users':     data.total_users,
    'stat-sellers':   data.sellers,
    'stat-merchants': data.merchants,
    'stat-kyc':       data.kyc_pending,
    'stat-listings':  data.total_listings,
    'stat-deals':     data.total_deals,
    'stat-revenue':   fmtINR(data.platform_revenue),
  };
  Object.keys(map).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = (map[id] !== undefined && map[id] !== null) ? map[id] : '—';
  });
}

/* ─── TABS ─── */
function loadTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.style.display = p.id === 'tab-' + tab ? 'block' : 'none';
  });
  if (tab === 'transport') loadTransportRequests();
  if (tab === 'kyc')       loadKYCRequests();
  if (tab === 'users')     loadUsers();
}

/* ═══════════════════════════════════════════
   TRANSPORT
   ═══════════════════════════════════════════ */
function loadTransportRequests() {
  var container = document.getElementById('transport-list');
  if (!container) return;
  container.innerHTML = '<div class="admin-loading">Loading transport requests...</div>';

  var filter = ((document.getElementById('transport-filter') || {}).value || '');
  var url = '/admin/transport/requests' + (filter ? '?status=' + encodeURIComponent(filter) : '');

  api('GET', url).then(function(d) {
    // ── KEY FIX: backend returns "requests" (was "rows") ──
    var reqs = d.requests || d.rows || [];

    if (!reqs.length) {
      container.innerHTML = adminEmpty(
        'No transport requests' + (filter ? ' for this filter' : ''),
        'Requests will appear here when sellers submit them.'
      );
      return;
    }
    container.innerHTML = reqs.map(renderTransportCard).join('');
  });
}

function renderTransportCard(req) {
  var statusMap = {
    open:       'Awaiting review',
    processed:  'Accepted and waiting payment',
    paid:       'Paid and ready to dispatch',
    in_transit: 'Shipment in transit',
    delivered:  'Delivered',
    cancelled:  'Cancelled'
  };
  var isPaid = req.payment_status === 'paid' || req.payment_status === 'in_escrow';
  var actions = '';

  if (req.status === 'open') {
    actions =
      '<button class="admin-btn primary" onclick="openAcceptModal(\'' + req.id + '\',\'' + esc(req.title) + '\',' + esc(req.quantity_kg) + ')">Accept and set price</button>' +
      '<button class="admin-btn danger" onclick="rejectRequest(\'' + req.id + '\')">Reject request</button>';
  } else if (req.status === 'processed' && !isPaid) {
    actions = '<div class="admin-note">Waiting for seller payment before dispatch can begin.</div>';
  } else if ((req.status === 'processed' && isPaid) || req.status === 'paid') {
    actions =
      '<div class="admin-note" style="margin-bottom:14px;">Payment confirmed. Dispatch can be created now.</div>' +
      '<button class="admin-btn primary" onclick="openDispatchModal(\'' + req.id + '\',\'' + esc(req.title) + '\',\'' + esc(req.pickup_city) + '\',\'' + esc(req.delivery_city) + '\')">Create dispatch</button>';
  } else if (req.status === 'in_transit') {
    actions =
      '<button class="admin-btn primary" onclick="openUpdateStatusModal(\'' + req.id + '\')">Update status</button>' +
      '<button class="admin-btn" onclick="markDelivered(\'' + req.id + '\')">Mark delivered</button>';
  } else if (req.status === 'delivered') {
    actions = '<div class="admin-note">This shipment has been delivered and closed.</div>';
  }

  return '<article class="admin-card">' +
    '<div class="admin-card-head">' +
      '<div>' +
        '<div class="admin-card-title">' + esc(req.title || 'Goods Transport') + '</div>' +
        '<div class="admin-card-sub">Request ' + esc(req.id) + ' - Seller: ' + esc(req.seller_name || '-') + (req.seller_email ? ' - ' + esc(req.seller_email) : '') + '</div>' +
      '</div>' +
      '<span class="status-pill ' + esc(req.status || 'open') + '">' + esc(statusMap[req.status] || req.status || 'Unknown') + '</span>' +
    '</div>' +
    '<div class="admin-card-grid">' +
      adminField('Category', esc(req.category || '-')) +
      adminField('Weight', esc((req.quantity_kg || '-') + ' kg')) +
      adminField('Pickup date', esc(req.pickup_date || '-')) +
      adminField('Pickup', esc((req.pickup_address || req.pickup_city || '-') + (req.pickup_state ? ', ' + req.pickup_state : ''))) +
      adminField('Delivery', esc((req.delivery_address || req.delivery_city || '-') + (req.delivery_state ? ', ' + req.delivery_state : ''))) +
      adminField('Commercial', (req.agreed_price_inr ? fmtINR(req.agreed_price_inr) : 'Pending') + '<span class="admin-field-meta">Payment: ' + esc(req.payment_status || 'unpaid') + '</span>') +
    '</div>' +
    '<div class="admin-card-sub admin-card-meta">Submitted ' + fmtDate(req.created_at) + (req.tracking_number ? ' - Tracking ' + esc(req.tracking_number) : '') + '</div>' +
    '<div class="admin-card-actions">' + actions + '</div>' +
  '</article>';
}

function _box(label, value) {
  return adminField(label, esc(String(value)));
}

/* ─── ACCEPT MODAL ─── */
function openAcceptModal(reqId, title, qty) {
  closeModal('accept-modal-overlay');
  var o = document.createElement('div');
  o.id = 'accept-modal-overlay';
  o.className = 'admin-modal-overlay';
  o.innerHTML =
    '<div class="admin-modal-card">' +
      '<h3>Accept transport request</h3>' +
      '<p style="color:#a1a1aa;margin:8px 0 18px;">' + esc(title) + ' - ' + esc(qty) + ' kg</p>' +
      '<label style="display:block;margin-bottom:8px;color:#d4d4d8;font-weight:600;">Transport price (INR)</label>' +
      '<input id="accept-price-input" type="number" min="1" step="0.01" placeholder="3500" style="width:100%;margin-bottom:10px;">' +
      '<p style="color:#71717a;margin:0 0 18px;">This amount will be shared with the seller for payment.</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="admin-btn" onclick="closeModal(\'accept-modal-overlay\')">Cancel</button>' +
        '<button class="admin-btn primary" onclick="submitAccept(\'' + reqId + '\')">Confirm and notify seller</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(o);
  setTimeout(function() { var i = document.getElementById('accept-price-input'); if (i) i.focus(); }, 80);
}

function submitAccept(reqId) {
  var price = parseFloat(((document.getElementById('accept-price-input') || {}).value) || 0);
  if (!price || price <= 0) { toast('Enter a valid price.', 'danger'); return; }
  api('POST', '/admin/transport/accept', { request_id: reqId, agreed_price_inr: price })
    .then(function(d) {
      if (d.success) {
        closeModal('accept-modal-overlay');
        toast('Accepted and seller notified.', 'success');
        loadTransportRequests();
      } else {
        toast(d.detail || d.message || 'Error', 'danger');
      }
    });
}

/* ─── REJECT ─── */
function rejectRequest(reqId) {
  var reason = prompt('Rejection reason (shown to seller):', 'Request could not be fulfilled at this time.');
  if (reason === null) return;
  api('POST', '/admin/transport/reject', { request_id: reqId, reason: reason || 'Rejected.' })
    .then(function(d) {
      if (d.success) { toast('Rejected. Seller notified.', 'warning'); loadTransportRequests(); }
      else toast(d.detail || 'Error', 'danger');
    });
}

/* ─── DISPATCH MODAL ─── */
function openDispatchModal(reqId, title, pickupCity, deliveryCity) {
  closeModal('dispatch-modal-overlay');
  var o = document.createElement('div');
  o.id = 'dispatch-modal-overlay';
  o.className = 'admin-modal-overlay';
  o.innerHTML =
    '<div class="admin-modal-card">' +
      '<h3>Create dispatch</h3>' +
      '<p style="color:#a1a1aa;margin:8px 0 12px;">' + esc(title) + '</p>' +
      '<div class="admin-note" style="margin-bottom:18px;">Route: ' + esc(pickupCity || '-') + ' to ' + esc(deliveryCity || '-') + '</div>' +
      '<label style="display:block;margin-bottom:8px;color:#d4d4d8;font-weight:600;">Tracking number</label>' +
      '<input id="dispatch-tracking-input" type="text" placeholder="BD123456789012" style="width:100%;margin-bottom:14px;">' +
      '<label style="display:block;margin-bottom:8px;color:#d4d4d8;font-weight:600;">Transporter or driver</label>' +
      '<input id="dispatch-transporter-input" type="text" placeholder="Raju Transport Co." style="width:100%;margin-bottom:18px;">' +
      '<div class="admin-note" style="margin-bottom:18px;">The seller receives a dispatch email and invoice after this step.</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="admin-btn" onclick="closeModal(\'dispatch-modal-overlay\')">Cancel</button>' +
        '<button class="admin-btn primary" id="dispatch-confirm-btn" onclick="submitDispatch(\'' + reqId + '\')">Confirm dispatch</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(o);
}

function submitDispatch(reqId) {
  var tracking   = ((document.getElementById('dispatch-tracking-input')   || {}).value || '').trim();
  var transporter= ((document.getElementById('dispatch-transporter-input') || {}).value || '').trim();
  var btn = document.getElementById('dispatch-confirm-btn');
  if (btn) { btn.textContent = 'Creating dispatch...'; btn.disabled = true; }

  api('POST', '/admin/transport/dispatch', {
    request_id: reqId, tracking_number: tracking, transporter_name: transporter,
  }).then(function(d) {
    if (d.success) {
      closeModal('dispatch-modal-overlay');
      toast('Dispatch created and seller notified by email.', 'success');
      loadTransportRequests();
    } else {
      toast(d.detail || d.message || 'Error dispatching', 'danger');
      if (btn) { btn.textContent = 'Confirm dispatch'; btn.disabled = false; }
    }
  });
}

/* ─── UPDATE STATUS ─── */
function openUpdateStatusModal(reqId) {
  closeModal('status-modal-overlay');
  var o = document.createElement('div');
  o.id = 'status-modal-overlay';
  o.className = 'admin-modal-overlay';
  o.innerHTML =
    '<div class="admin-modal-card">' +
      '<h3>Update delivery status</h3>' +
      '<p style="color:#a1a1aa;margin:8px 0 18px;">Record the latest movement so the seller sees accurate tracking.</p>' +
      '<label style="display:block;margin-bottom:8px;color:#d4d4d8;font-weight:600;">Delivery stage</label>' +
      '<select id="update-status-select" style="width:100%;margin-bottom:14px;">' +
        '<option value="picked_up">Picked up</option>' +
        '<option value="in_transit" selected>In transit</option>' +
        '<option value="arrived_city">Arrived in destination city</option>' +
        '<option value="out_for_delivery">Out for delivery</option>' +
      '</select>' +
      '<label style="display:block;margin-bottom:8px;color:#d4d4d8;font-weight:600;">Update note</label>' +
      '<input id="update-status-note" type="text" placeholder="Arrived at Mumbai hub" style="width:100%;margin-bottom:18px;">' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="admin-btn" onclick="closeModal(\'status-modal-overlay\')">Cancel</button>' +
        '<button class="admin-btn primary" onclick="submitStatusUpdate(\'' + reqId + '\')">Save update</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(o);
}

function submitStatusUpdate(reqId) {
  var status = ((document.getElementById('update-status-select') || {}).value || '');
  var note   = ((document.getElementById('update-status-note')   || {}).value || '');
  api('POST', '/transport/tracking/update', {
    request_id: reqId, status: status, note: note, lat: '', lng: '',
  }).then(function(d) {
    if (d.success) {
      closeModal('status-modal-overlay');
      toast('Status updated. The seller can now see the latest tracking note.', 'success');
      loadTransportRequests();
    } else toast(d.detail || 'Error', 'danger');
  });
}

function markDelivered(reqId) {
  if (!confirm('Mark as Delivered?\nThis releases escrow payment to the transporter.')) return;
  api('POST', '/transport/tracking/update', {
    request_id: reqId, status: 'delivered', note: 'Goods delivered successfully.', lat: '', lng: '',
  }).then(function(d) {
    if (d.success) { toast('Marked delivered. Escrow release was triggered.', 'success'); loadTransportRequests(); }
    else toast(d.detail || 'Error', 'danger');
  });
}

/* ═══════════════════════════════════════════
   KYC
   ═══════════════════════════════════════════ */
function loadKYCRequests() {
  var container = document.getElementById('kyc-list');
  if (!container) return;
  container.innerHTML = adminEmpty('Loading KYC queue', 'Checking pending verification submissions.');
  api('GET', '/admin/kyc/pending').then(function(d) {
    if (!d.users || d.users.length === 0) {
      container.innerHTML = adminEmpty('No pending KYC reviews', 'Everything is clear right now.');
      return;
    }
    container.innerHTML = d.users.map(function(u) {
      return '<article class="admin-card">' +
        '<div class="admin-card-head">' +
          '<div>' +
            '<div class="admin-card-title">' + esc(u.name) + '</div>' +
            '<div class="admin-card-sub">' + esc(u.email) + ' - ' + esc(u.role) + '</div>' +
          '</div>' +
          '<span class="status-pill open">Pending review</span>' +
        '</div>' +
        '<div class="admin-card-actions">' +
          '<button class="admin-btn primary" onclick="approveKYC(\'' + u.id + '\')">Approve</button>' +
          '<button class="admin-btn danger" onclick="rejectKYC(\'' + u.id + '\')">Reject</button>' +
        '</div></article>';
    }).join('');
  });
}

function approveKYC(userId) {
  api('POST', '/admin/kyc/approve', { user_id: userId }).then(function(d) {
    if (d.success) { toast('KYC approved!', 'success'); loadKYCRequests(); }
    else toast(d.detail || 'Error', 'danger');
  });
}
function rejectKYC(userId) {
  var reason = prompt('Rejection reason:');
  if (!reason) return;
  api('POST', '/admin/kyc/reject', { user_id: userId, reason: reason }).then(function(d) {
    if (d.success) { toast('KYC rejected.', 'warning'); loadKYCRequests(); }
    else toast(d.detail || 'Error', 'danger');
  });
}

/* ═══════════════════════════════════════════
   USERS
   ═══════════════════════════════════════════ */
function loadUsers() {
  var container = document.getElementById('users-list');
  if (!container) return;
  container.innerHTML = adminEmpty('Loading users', 'Pulling the latest registered accounts.');
  api('GET', '/admin/users').then(function(d) {
    if (!d.users || d.users.length === 0) {
      container.innerHTML = adminEmpty('No users found', 'No registered users matched this query.');
      return;
    }
    var html = '<div class="admin-card"><table class="admin-table"><thead><tr>' +
      ['Name','Email','Role','City','KYC','Joined'].map(function(h) {
        return '<th>' + h + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      d.users.map(function(u) {
        return '<tr>' +
          '<td>' + esc(u.name) + '</td>' +
          '<td>' + esc(u.email) + '</td>' +
          '<td>' + esc(u.role) + '</td>' +
          '<td>' + esc(u.city || '-') + '</td>' +
          '<td>' + esc(u.kyc_status || '-') + '</td>' +
          '<td>' + (u.created_at ? u.created_at.substring(0,10) : '-') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
    container.innerHTML = html;
  });
}











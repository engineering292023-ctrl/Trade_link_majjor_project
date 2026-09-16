/**
 * TRADELINK  SHARED UTILITIES  (shared/utils.js)
 *
 * Contains: navigation, modal system, toast notifications,
 * auth state management, formatters, API request helpers,
 * and pagination engine.
 *
 * NO application data lives here  only pure utility functions.
 */

/**
 * _tl_log  Silent logger for TradeLink
 * Only outputs to console on localhost/127.0.0.1 (development).
 * Completely silent on any deployed/hosted URL (production).
 * This prevents leaking stack info (Firebase, API URLs, etc.) to end users.
 */
var _tl_log = (function() {
  var isDev = (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '0.0.0.0'
  );
  return function() {
    if (isDev) {
      // In development  log normally so you can debug
      console.log.apply(console, arguments);
    }
    // In production  completely silent, nothing leaks to DevTools
  };
})();


'use strict';

/* 
   SCREEN NAVIGATION
    */

/**
 * navigate(screenId, clickedNavEl)
 * Shows the screen with id="screen-{screenId}", hides all others.
 * Marks the clicked nav item as active.
 */
function navigate(screenId, navEl) {
  // Hide every screen
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });

  var target = document.getElementById('screen-' + screenId);
  if (target) target.classList.add('active');

  // Update sidebar active state
  if (navEl) {
    document.querySelectorAll('.nav-item').forEach(function(n) {
      n.classList.remove('active');
    });
    navEl.classList.add('active');
  }

  // Scroll content area back to top
  var ca = document.querySelector('.content-area');
  if (ca) ca.scrollTop = 0;

  if (typeof window.closeSidebar === 'function') {
    window.closeSidebar();
  }
}

/* 
   MODAL SYSTEM
   One shared overlay + modal per portal.
   Content injected by calling openModal().
    */

/**
 * openModal(config)
 * @param {object} config
 *   title      {string}  - modal heading
 *   sub        {string}  - subtitle / ID / date
 *   badge      {string}  - status text
 *   badgeClass {string}  - 'active' | 'pending' | 'danger' | 'info' | 'brand'
 *   bodyHTML   {string}  - full HTML string for modal body
 *   footerHTML {string}  - optional footer HTML
 *   wide       {boolean} - if true, uses wide modal (820px)
 */
function openModal(config) {
  var overlay  = document.getElementById('modal-overlay');
  var modal    = overlay ? overlay.querySelector('.modal') : null;
  var titleEl  = document.getElementById('modal-title');
  var subEl    = document.getElementById('modal-sub');
  var badgeEl  = document.getElementById('modal-badge');
  var bodyEl   = document.getElementById('modal-body');
  var footerEl = document.getElementById('modal-footer');

  if (!overlay) return;

  // Set content
  if (titleEl)  titleEl.textContent  = config.title || '';
  if (subEl)    subEl.textContent    = config.sub   || '';
  if (badgeEl) {
    badgeEl.textContent = config.badge || '';
    badgeEl.className   = 'badge ' + (config.badgeClass || 'brand');
  }
  if (bodyEl)   bodyEl.innerHTML   = config.bodyHTML   || '';
  if (footerEl) footerEl.innerHTML = config.footerHTML || '';

  // Wide variant
  if (modal) {
    modal.classList.toggle('wide', !!config.wide);
    modal.classList.toggle('small', !!config.small);
  }

  overlay.classList.add('open');
}

/**
 * closeModal(event)
 * Closes the modal. If called from overlay click, only closes if
 * the user clicked the overlay background (not the modal card).
 */
function closeModal(event) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  if (event && event.target !== overlay) return;
  overlay.classList.remove('open');
}

function closeModalDirect() {
  var overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('open');
}

/* 
   TOAST NOTIFICATION SYSTEM
    */

var _toastContainer = null;

function _getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.getElementById('toast-container');
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'toast-container';
      document.body.appendChild(_toastContainer);
    }
  }
  return _toastContainer;
}

/**
 * toast(message, type, duration)
 * @param {string} message  - text to display
 * @param {string} type     - 'success' | 'warning' | 'danger' | 'info' | '' (dark)
 * @param {number} duration - ms to show (default 3500)
 */
function toast(message, type, duration) {
  var container = _getToastContainer();
  var el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');

  var icon = { success: 'OK', warning: 'AL', danger: 'ER', info: 'IN' }[type] || 'TL';
  el.innerHTML =
    '<span>' + icon + ' ' + escapeHtml(message) + '</span>' +
    '<button class="toast-close" onclick="this.parentElement.remove()">X</button>';

  container.appendChild(el);

  // Auto-remove
  setTimeout(function() {
    if (el.parentElement) {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function() { if (el.parentElement) el.remove(); }, 300);
    }
  }, duration || 3500);
}

/* 
   AUTH STATE HELPERS
   These show/hide login vs app shell.
   Real Firebase token check happens in Step 2.
    */

/**
 * showApp(user)
 * Called after successful login. Populates sidebar user info.
 * @param {object} user - { name, role, initials, city }
 */
function showApp(user) {
  var loginShell = document.querySelector('.login-shell');
  var appShell   = document.querySelector('.app-shell');

  if (loginShell) loginShell.style.display = 'none';
  if (appShell)   appShell.style.display   = 'flex';
  document.body.classList.add('app-visible');

  // Always sync TL_USER_ROLE from the user object.
  // This prevents stale role if both portals were opened
  // in the same browser and overwrote each other.
  if (user && user.role) {
    window.TL_USER_ROLE = user.role;
  }

  // Populate sidebar user pill
  if (user) {
    var avatarEl = document.getElementById('sidebar-avatar');
    var nameEl   = document.getElementById('sidebar-name');
    var roleEl   = document.getElementById('sidebar-role');

    if (avatarEl) avatarEl.textContent = user.initials || getInitials(user.name || '');
    if (nameEl)   nameEl.textContent   = user.name || '';
    if (roleEl)   roleEl.textContent   = (user.role || '') + (user.city ? '  ' + user.city : '');
  }
}

/**
 * showLogin()
 * Called on logout or auth failure.
 */
function showLogin() {
  var loginShell = document.querySelector('.login-shell');
  var appShell   = document.querySelector('.app-shell');

  if (appShell)   appShell.style.display   = 'none';
  if (loginShell) loginShell.style.display = 'flex';
  document.body.classList.remove('app-visible');
}

/* 
   FORMAT HELPERS
    */

/** formatINR(12000)  "Rs 12,000" */
function formatINR(amount) {
  if (amount == null || isNaN(amount)) return 'Rs 0';
  return 'Rs ' + Number(amount).toLocaleString('en-IN');
}

/** formatINRShort(1200000)  "Rs 12L" */
function formatINRShort(amount) {
  if (amount == null) return 'Rs 0';
  var n = Number(amount);
  if (n >= 10000000) return 'Rs ' + (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000)   return 'Rs ' + (n / 100000).toFixed(1) + 'L';
  if (n >= 1000)     return 'Rs ' + (n / 1000).toFixed(0) + 'K';
  return 'Rs ' + n;
}

/** formatQty(5000, 'kg')  "5,000 kg" */
function formatQty(num, unit) {
  if (num == null) return '';
  return Number(num).toLocaleString('en-IN') + (unit ? ' ' + unit : '');
}

/** getInitials("Ravi Sharma")  "RS" */
function getInitials(name) {
  if (!name) return 'TL';
  return name.trim().split(/\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
}

/**
 * timeAgo(isoString)  "2 minutes ago"
 * Converts ISO date string to relative time.
 */
function timeAgo(isoString) {
  if (!isoString) return '';
  var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60)    return diff + ' sec ago';
  if (diff < 3600)  return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
  return Math.floor(diff / 86400) + ' days ago';
}

/**
 * countdownTo(isoString)  "5h 30m"
 * Returns time remaining until a future ISO date.
 */
function countdownTo(isoString) {
  if (!isoString) return '';
  var diff = Math.floor((new Date(isoString).getTime() - Date.now()) / 1000);
  if (diff <= 0) return 'Expired';
  var h = Math.floor(diff / 3600);
  var m = Math.floor((diff % 3600) / 60);
  if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  if (h > 0)  return h + 'h ' + m + 'm';
  return m + 'm';
}

/**
 * formatDate(isoString)  "20 Jan 2025"
 */
function formatDate(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

/** escapeHtml(str)  prevents XSS when inserting user content into innerHTML */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 
   VOLUME CALCULATOR (truck registration)
    */

/**
 * calcVolume(l, w, h)  numeric volume in m3, or 0
 */
function calcVolume(l, w, h) {
  var lv = parseFloat(l) || 0;
  var wv = parseFloat(w) || 0;
  var hv = parseFloat(h) || 0;
  return lv * wv * hv;
}

/* 
   API REQUEST WRAPPER
   All data calls go through here.
   In Step 2, the base URL points to our Apps Script backend.
    */

/**
 * API_BASE_URL  points to our FastAPI backend.
 *
 * LOCAL (when running on your computer):
 *   http://localhost:8000/api
 *
 * PRODUCTION (Step 8  after deploying to Cloud Run):
 *   https://your-backend-url.run.app/api
 *
 * Change this ONE line when you deploy.
 */
var API_BASE_URL = (function() {
  if (typeof window.ENV_CONFIG !== 'undefined' && window.ENV_CONFIG && window.ENV_CONFIG.BACKEND_URL) {
    return window.ENV_CONFIG.BACKEND_URL.replace(/\/+$/, '') + '/api';
  }
  if (typeof window.__ENV__ !== 'undefined' && window.__ENV__ && window.__ENV__.BACKEND_URL) {
    return window.__ENV__.BACKEND_URL.replace(/\/+$/, '') + '/api';
  }
  if (typeof window.API_BASE === 'string' && window.API_BASE) {
    return window.API_BASE.replace(/\/+$/, '');
  }
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8000/api';
  }
  return '/api';
})();
window.API_BASE = API_BASE_URL;
window.API_BASE_URL = API_BASE_URL;

/**
 * getAuthToken()  Promise<string>
 * Gets the current Firebase ID token to attach to every API request.
 * Uses window.firebaseAuth which is set by firebase-config.js
 */
function getAuthToken() {
  // window.firebaseAuth is set by firebase-config.js
  if (window.firebaseAuth && window.firebaseAuth.currentUser) {
    return window.firebaseAuth.currentUser.getIdToken(/* forceRefresh= */ false);
  }
  // Not logged in yet (e.g. during login/register flow before token exists)
  return Promise.resolve('');
}

/**
 * apiGet(endpoint, params)  Promise<{ data, error }>
 * Makes a GET request to the FastAPI backend.
 * Automatically includes Firebase auth token in headers.
 *
 * @param {string} endpoint  - e.g. 'seller/listings', 'marketplace/listings'
 * @param {object} params    - query params { page, limit, status, search, ... }
 */
function apiGet(endpoint, params) {
  return getAuthToken().then(function(token) {
    var url = new URL(API_BASE_URL + '/' + endpoint);

    if (params) {
      Object.keys(params).forEach(function(k) {
        if (params[k] !== undefined && params[k] !== '') {
          url.searchParams.set(k, params[k]);
        }
      });
    }

    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': token ? 'Bearer ' + token : '',
        'Content-Type': 'application/json',
        // X-User-Role tells the backend which account to look up.
        // Read from AppState.user.role (set on login)  more reliable
        // than window.TL_USER_ROLE which can be overwritten if both
        // portals are open in the same browser session.
        'X-User-Role': (window.AppState && window.AppState.user && window.AppState.user.role) || window.TL_USER_ROLE || '',
      }
    });
  })
  .then(_parseApiResponse)
  .catch(function(err) { return { data: null, error: err.message }; });
}

/**
 * apiPost(endpoint, body)  Promise<{ data, error }>
 * Makes a POST request to the FastAPI backend.
 * Automatically includes Firebase auth token in headers.
 *
 * @param {string} endpoint
 * @param {object} body     - JSON body
 */
function apiPost(endpoint, body) {
  return getAuthToken().then(function(token) {
    return fetch(API_BASE_URL + '/' + endpoint, {
      method: 'POST',
      headers: {
        'Authorization': token ? 'Bearer ' + token : '',
        'Content-Type': 'application/json',
        'X-User-Role': (window.AppState && window.AppState.user && window.AppState.user.role) || window.TL_USER_ROLE || '',
      },
      body: JSON.stringify(body)
    });
  })
  .then(_parseApiResponse)
  .catch(function(err) { return { data: null, error: err.message }; });
}

function _parseApiResponse(response) {
  return response.text().then(function(text) {
    var payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { detail: text };
      }
    }

    if (!response.ok) {
      return {
        data: payload,
        error: (payload && (payload.detail || payload.message || payload.error)) || ('HTTP ' + response.status)
      };
    }

    return { data: payload, error: null };
  });
}

/* 
   PAGINATION ENGINE
   Reusable across all tables.
    */

/**
 * Pagination state object.
 * Each screen that needs pagination creates its own instance.
 *
 * Usage:
 *   var pager = createPager(20, function(page) { loadMyData(page); });
 *   pager.render(containerId, currentPage, totalRows);
 */
function createPager(pageSize, onPageChange) {
  var state = { page: 1, total: 0, size: pageSize || 20 };

  function totalPages() {
    return Math.max(1, Math.ceil(state.total / state.size));
  }

  function render(containerId, currentPage, totalRows) {
    state.page  = currentPage;
    state.total = totalRows;

    var container = document.getElementById(containerId);
    if (!container) return;

    var tp = totalPages();
    var start = (state.page - 1) * state.size + 1;
    var end   = Math.min(state.page * state.size, totalRows);

    var html =
      '<div class="pagination">' +
        '<span>Showing ' + start + ' - ' + end + ' of ' + totalRows + '</span>' +
        '<div class="page-btns">' +
          '<button class="page-btn" onclick="' + containerId + '_pager.go(' + (state.page - 1) + ')"' +
            (state.page <= 1 ? ' disabled' : '') + '> Prev</button>';

    // Show up to 5 page numbers
    var startP = Math.max(1, state.page - 2);
    var endP   = Math.min(tp, startP + 4);
    for (var p = startP; p <= endP; p++) {
      html += '<button class="page-btn' + (p === state.page ? ' active' : '') + '"' +
        ' onclick="' + containerId + '_pager.go(' + p + ')">' + p + '</button>';
    }

    html +=
          '<button class="page-btn" onclick="' + containerId + '_pager.go(' + (state.page + 1) + ')"' +
            (state.page >= tp ? ' disabled' : '') + '>Next </button>' +
        '</div>' +
      '</div>';

    container.innerHTML = html;
  }

  function go(page) {
    var tp = totalPages();
    if (page < 1 || page > tp) return;
    state.page = page;
    onPageChange(page);
  }

  return { render: render, go: go, state: state };
}

/* 
   TABLE RENDERER
   Takes an array of row config objects and
   renders them into a <tbody>.
    */

/**
 * renderTableBody(tbodyId, rows, columns, onRowClick)
 *
 * @param {string}   tbodyId    - id of <tbody> element
 * @param {Array}    rows       - array of data objects from API
 * @param {Array}    columns    - [{ key, label, render }]
 *   render(value, row)  HTML string
 * @param {Function} onRowClick - called with (row) when row is clicked
 */
function renderTableBody(tbodyId, rows, columns, onRowClick) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="' + columns.length + '">' +
      '<div class="empty-state"><div class="empty-icon"></div>' +
      '<div class="empty-title">Nothing here yet</div>' +
      '<div class="empty-sub">Data will appear once entries are added.</div></div>' +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(row, i) {
    var cells = columns.map(function(col) {
      var val = row[col.key];
      var html = col.render ? col.render(val, row) : escapeHtml(String(val == null ? '' : val));
      return '<td>' + html + '</td>';
    }).join('');

    return '<tr data-row-index="' + i + '">' + cells + '</tr>';
  }).join('');

  // Attach click handlers
  if (onRowClick) {
    tbody.querySelectorAll('tr').forEach(function(tr, i) {
      tr.addEventListener('click', function() { onRowClick(rows[i]); });
    });
  }
}

/* 
   LOADING STATE HELPERS
    */

/** showLoadingRows(tbodyId, colCount, rowCount) */
function showLoadingRows(tbodyId, colCount, rowCount) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  var rows = '';
  for (var r = 0; r < (rowCount || 5); r++) {
    var cells = '';
    for (var c = 0; c < colCount; c++) {
      cells += '<td><div class="skeleton-cell" style="height:14px;width:' + (60 + Math.random() * 30).toFixed(0) + '%"></div></td>';
    }
    rows += '<tr>' + cells + '</tr>';
  }
  tbody.innerHTML = rows;
}

/** setStatLoading(statId)  shows shimmer on a stat card value */
function setStatLoading(statId) {
  var el = document.getElementById(statId);
  if (el) {
    el.classList.add('loading');
    el.textContent = '...';
  }
}

/** setStatValue(statId, value)  updates a stat card value */
function setStatValue(statId, value) {
  var el = document.getElementById(statId);
  if (el) {
    el.classList.remove('loading');
    el.textContent = value;
  }
}

/* 
   FORM VALIDATION HELPERS
    */

/**
 * validateForm(formId, rules)  true if valid
 * @param {string} formId
 * @param {Array}  rules  - [{ fieldId, required, minLen, pattern, message }]
 */
function validateForm(formId, rules) {
  var form  = document.getElementById(formId);
  if (!form) return false;

  var valid = true;

  rules.forEach(function(rule) {
    var field  = form.querySelector('#' + rule.fieldId);
    var errEl  = form.querySelector('#' + rule.fieldId + '-err');
    if (!field) return;

    var val = field.value.trim();
    var msg = '';

    if (rule.required && !val) {
      msg = rule.message || 'This field is required.';
    } else if (rule.minLen && val.length < rule.minLen) {
      msg = rule.message || 'Minimum ' + rule.minLen + ' characters.';
    } else if (rule.pattern && val && !rule.pattern.test(val)) {
      msg = rule.message || 'Invalid format.';
    }

    if (msg) {
      field.classList.add('is-error');
      if (errEl) { errEl.textContent = msg; errEl.classList.add('show'); }
      valid = false;
    } else {
      field.classList.remove('is-error');
      if (errEl) errEl.classList.remove('show');
    }
  });

  return valid;
}

/**
 * getFormData(formId)  plain object with all field values
 */
function getFormData(formId) {
  var form = document.getElementById(formId);
  if (!form) return {};
  var data = {};
  form.querySelectorAll('input, select, textarea').forEach(function(el) {
    if (el.name || el.id) {
      data[el.name || el.id] = el.value;
    }
  });
  return data;
}

/* 
   BADGE BUILDER HELPER
    */

/**
 * statusBadge(status)  HTML string for a badge
 * Maps known status strings to badge classes.
 */
function statusBadge(status) {
  var map = {
    'active':    ['active',   ' Active'],
    'open':      ['active',   ' Open'],
    'pending':   ['pending',  ' Pending'],
    'confirmed': ['brand',    ' Confirmed'],
    'processed': ['info',     ' Accepted'],
    'booked':    ['info',     ' Booked'],
    'in_transit':['pending',  ' In Transit'],
    'closed':    ['inactive', 'Closed'],
    'expired':   ['inactive', 'Expired'],
    'delivered': ['active',   ' Delivered'],
    'won':       ['brand',    ' Won'],
    'outbid':    ['danger',   ' Outbid'],
    'accepted':  ['brand',    ' Accepted'],
    'cancelled': ['danger',   'Cancelled'],
    'paid':      ['active',   ' Paid'],
    'in_escrow': ['info',     ' In Escrow'],
    'pay_pending':['danger',  ' Pay Now'],
    'approved':  ['active',   ' Approved'],
    'rejected':  ['danger',   ' Rejected'],
    'verified':  ['active',   ' Verified'],
    'unverified':['pending',  'Pending KYC'],
  };
  var entry = map[String(status).toLowerCase()];
  if (!entry) return '<span class="badge inactive">' + escapeHtml(status || '') + '</span>';
  return '<span class="badge ' + entry[0] + '">' + entry[1] + '</span>';
}

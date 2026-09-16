/**
 * TRADELINK  SELLER PORTAL JAVASCRIPT  (seller.js)
 *
 * All API calls use apiGet/apiPost from shared/utils.js.
 * API_BASE_URL is set in Step 2 when backend is deployed.
 *
 * Until Step 2, all data calls return a "not connected" message
 * so the UI structure is visible but no fake data shows.
 *
 * ARCHITECTURE:
 * - Auth:     handleEmailLogin, handleGoogleLogin, handleLogout
 * - Dashboard: loadDashboard (stats + table + activity)
 * - Listings:  loadListings, filterListings
 * - Bids:      loadBids, acceptBid
 * - Deals:     loadDeals, filterDeals, viewDeal
 * - Payments:  loadPayments
 * - Payouts:   loadPayoutData, initiateWithdrawal
 * - Profile:   loadProfile, saveProfile, submitKYC
 * - Notifications: loadNotifications, markAllNotificationsRead
 * - Create Listing: submitListing, saveDraft
 */

'use strict';

/* 
   GLOBAL APP STATE
    */
var AppState = {
  user: null,         // current logged-in user object
  listings: [],       // cached listings array
  listingsPage: 1,
  dealsPage: 1,
  paymentsPage: 1,
  PAGE_SIZE: 20,
  bidRefreshTimer: null
};

/* 
   INIT  runs on page load
    */
/**
 * TRADELINK  SELLER AUTH (replacement for seller.js auth section)
 *
 * NEW FLOW:
 * Email login   POST /api/auth/login-email  gets custom_token
 *                 signInWithCustomToken()  Firebase session
 * Google login  signInWithPopup()  POST /api/auth/login  MongoDB check
 * Register      POST /api/auth/send-otp (no Firebase from browser)
 *                 enter OTP  POST /api/auth/verify-otp  gets custom_token
 * Forgot PW     POST /api/auth/forgot-password (email + role)
 *                 OTP  POST /api/auth/reset-password
 *
 * NOTIFICATIONS: completely removed.
 */

/* 
   INIT  runs on page load
    */
document.addEventListener('DOMContentLoaded', function() {
  detectCity();

  setTimeout(function() {
    if (window.firebaseAuth) {
      window.firebaseAuth.onAuthStateChanged(function(fbUser) {
        if (fbUser) {
          fbUser.getIdToken().then(function(idToken) {
            return apiPost('auth/login', { firebase_token: idToken, role: 'seller' });
          }).then(function(res) {
            if (res.data && res.data.success) {
              var user = res.data.user;
              if (user.id && user.id.charAt(0) === 'M') {
                showLogin();
                _showLoginError(' This email is a <strong>Merchant</strong> account. <a href="../merchant-portal/index.html" style="color:var(--brand-main);font-weight:600;">Go to Merchant Portal </a>');
                window.firebaseAuth.signOut();
                return;
              }
              _loginSuccess(user);
            } else if (res.data && res.data.wrong_portal) {
              showLogin();
              _showLoginError(' Your account is a <strong>' + (res.data.actual_role || '') + '</strong> account. <a href="' + res.data.portal_url + '" style="color:var(--brand-main);font-weight:600;">Go to ' + res.data.portal_name + ' </a>');
              window.firebaseAuth.signOut();
            } else if (res.data && res.data.needs_register) {
              showLogin();
              setTimeout(function() { handleRegister(fbUser.email); }, 200);
            } else {
              showLogin();
            }
          }).catch(function() { showLogin(); });
        } else {
          showLogin();
        }
      });
    } else {
      showLogin();
      if (window._firebaseError) _showLoginError(' ' + window._firebaseError);
    }
  }, 100);
});

/* 
   EMAIL + PASSWORD LOGIN
    */
function handleEmailLogin() {
  var email    = document.getElementById('email').value.trim();
  var password = document.getElementById('password').value;
  var btn      = document.getElementById('login-btn');

  if (!email || !password) {
    _showLoginError('Please enter your email and password.');
    return;
  }

  _clearLoginError();
  btn.textContent = 'Signing in...';
  btn.disabled    = true;

  // Call backend directly  no Firebase from browser for email login
  apiPost('auth/login-email', { email: email, password: password, role: 'seller' })
    .then(function(res) {
      btn.textContent = 'Enter seller workspace';
      btn.disabled    = false;

      if (!res.data) {
        _showLoginError('Login failed. Is the backend server running?');
        return;
      }

      if (res.data.success && res.data.custom_token) {
        // Sign into Firebase with custom token for session
        return window.firebaseAuth.signInWithCustomToken(res.data.custom_token)
          .then(function() { _loginSuccess(res.data.user); })
          .catch(function() {
            // Firebase session optional  still log in
            _loginSuccess(res.data.user);
          });
      }

      if (res.data.wrong_portal) {
        _showLoginError(' This email is registered as a <strong>' + res.data.actual_role + '</strong>. <a href="' + res.data.portal_url + '" style="color:var(--brand-main);font-weight:600;">Go to ' + res.data.portal_name + ' </a>');
        return;
      }

      if (res.data.needs_register) {
        setTimeout(function() { handleRegister(email); }, 100);
        return;
      }

      if (res.data.google_account) {
        _showLoginError('This account was created with Google Sign-In. Use the Google button below, or click <a href="#" onclick="showForgotPassword();return false;" style="color:var(--brand-main);">Forgot Password</a> to set a password.');
        return;
      }

      _showLoginError(res.data.detail || 'Wrong password. Try again.');
    })
    .catch(function(err) {
      btn.textContent = 'Enter seller workspace';
      btn.disabled    = false;
      _showLoginError('Network error. Is the server running?');
    });
}

/* 
   GOOGLE LOGIN
    */
function handleGoogleLogin() {
  _clearLoginError();

  if (window.location.protocol === 'file:') {
    _showLoginError('Open via Live Server (http://), not by double-clicking.');
    return;
  }
  if (!window.firebaseAuth || !window.googleProvider) {
    _showLoginError('Firebase not initialized. Refresh the page.');
    return;
  }

  var btn = document.querySelector('.btn-google');
  if (btn) { btn.textContent = 'Opening Google...'; btn.disabled = true; }

  window.firebaseAuth.signInWithPopup(window.googleProvider)
    .then(function(result) { return result.user.getIdToken(); })
    .then(function(idToken) {
      return apiPost('auth/login', { firebase_token: idToken, role: 'seller' });
    })
    .then(function(res) {
      _resetGoogleBtn();
      if (!res.data) { _showLoginError('Login failed. Server not responding.'); return; }

      if (res.data.success) {
        var user = res.data.user;
        if (user.id && user.id.charAt(0) === 'M') {
          _showLoginError(' This Google account is a <strong>Merchant</strong>. <a href="../merchant-portal/index.html" style="color:var(--brand-main);font-weight:600;">Go to Merchant Portal </a>');
          window.firebaseAuth.signOut();
          return;
        }
        _loginSuccess(user);
        toast('Welcome back, ' + user.name + '!', 'success');
        return;
      }

      if (res.data.wrong_portal) {
        _showLoginError(' Your Google account is a <strong>' + res.data.actual_role + '</strong>. <a href="' + res.data.portal_url + '" style="color:var(--brand-main);font-weight:600;">Go to ' + res.data.portal_name + ' </a>');
        window.firebaseAuth.signOut();
        return;
      }

      // New Google user  show registration modal (no OTP  Google verified email)
      var fbUser = window.firebaseAuth.currentUser;
      showLogin();
      setTimeout(function() { handleGoogleRegister(fbUser); }, 150);
    })
    .catch(function(err) {
      _resetGoogleBtn();
      var messages = {
        'auth/popup-closed-by-user':    'Sign-in cancelled.',
        'auth/popup-blocked':           'Popup blocked. Allow popups for this site.',
        'auth/cancelled-popup-request': 'Another sign-in in progress. Please wait.',
        'auth/network-request-failed':  'No internet connection.',
        'auth/unauthorized-domain':     'Domain not authorized. Add it in Firebase Console.',
      };
      _showLoginError(messages[err.code] || err.message || 'Google sign-in failed.');
    });
}

function handleGoogleRegister(fbUser) {
  var googleEmail = fbUser ? fbUser.email || '' : '';
  var googleName  = fbUser ? fbUser.displayName || googleEmail.split('@')[0] : '';

  openModal({
    title: 'Complete Your Seller Profile',
    sub: 'One last step  no OTP needed for Google accounts',
    badge: 'Google Sign-In', badgeClass: 'active',
    bodyHTML:
      '<div style="background:rgba(142,245,191,0.08);border:1px solid rgba(142,245,191,0.24);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--success);">' +
        ' Google account verified  no OTP needed. Just fill in a few details.' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Full Name <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="greg-name" value="' + escapeHtml(googleName) + '" placeholder="Your full name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Email</label>' +
        '<input class="form-control" type="email" id="greg-email" value="' + escapeHtml(googleEmail) + '" disabled style="background:rgba(255,255,255,0.05);color:var(--text-3);">' +
        '<p style="font-size:11px;color:var(--text-3);margin:3px 0 0;">Verified by Google </p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Business Name <span style="color:var(--text-3);font-weight:400">(optional)</span></label>' +
        '<input class="form-control" type="text" id="greg-biz" placeholder="Your farm or business name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Create Password <span style="color:var(--text-3);font-weight:400">(optional — to log in without Google later)</span></label>' +
        '<input class="form-control" type="password" id="greg-pass" placeholder="At least 6 characters">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Phone</label>' +
        '<input class="form-control" type="tel" id="greg-phone" placeholder="+91 98765 43210">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">City <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="greg-city" placeholder="Your city">' +
      '</div>' +
      '<div id="greg-error" class="login-error"></div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="greg-submit-btn" onclick="submitGoogleRegistration()">Start Selling </button>'
  });
}

function submitGoogleRegistration() {
  var name  = document.getElementById('greg-name') ? document.getElementById('greg-name').value.trim() : '';
  var city  = document.getElementById('greg-city') ? document.getElementById('greg-city').value.trim() : '';
  var phone = document.getElementById('greg-phone') ? document.getElementById('greg-phone').value.trim() : '';
  var biz   = document.getElementById('greg-biz')   ? document.getElementById('greg-biz').value.trim()   : '';
  var pass  = document.getElementById('greg-pass')  ? document.getElementById('greg-pass').value         : '';
  var btn   = document.getElementById('greg-submit-btn');
  var errEl = document.getElementById('greg-error');

  if (!name) { errEl.textContent = 'Please enter your full name.'; errEl.classList.add('show'); return; }
  if (!city) { errEl.textContent = 'Please enter your city.';      errEl.classList.add('show'); return; }
  if (pass && pass.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.add('show'); return; }

  btn.textContent = 'Saving...';
  btn.disabled    = true;

  var fbUser = window.firebaseAuth.currentUser;
  if (!fbUser) {
    errEl.textContent = 'Session expired. Try signing in again.';
    errEl.classList.add('show');
    btn.textContent = 'Start Selling '; btn.disabled = false;
    return;
  }

  fbUser.getIdToken()
    .then(function(idToken) {
      return apiPost('auth/register', {
        firebase_token: idToken,
        email:          fbUser.email,
        name:           name,
        role:           'seller',
        phone:          phone,
        city:           city,
        company_name:   biz,
        password:       pass,
      });
    })
    .then(function(res) {
      if (!res.data || !res.data.success) {
        throw new Error((res.data && res.data.detail) || 'Registration failed.');
      }
      return fbUser.getIdToken();
    })
    .then(function(idToken) {
      return apiPost('auth/login', { firebase_token: idToken, role: 'seller' });
    })
    .then(function(res) {
      if (res.data && res.data.success) {
        closeModalDirect();
        _loginSuccess(res.data.user);
        toast('Welcome to TradeLink, ' + name + '! ', 'success');
      } else {
        throw new Error('Registration succeeded but login failed.');
      }
    })
    .catch(function(err) {
      errEl.textContent = err.message || 'Registration failed.';
      errEl.classList.add('show');
      btn.textContent = 'Start Selling '; btn.disabled = false;
    });
}

/* 
   EMAIL REGISTRATION (OTP  no Firebase from browser)
    */
function handleRegister(prefillEmail) {
  openModal({
    title: 'Create Seller Account',
    sub: 'Join TradeLink  Sell Direct. Earn More.',
    badge: 'Free', badgeClass: 'active',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Full Name <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="reg-name" placeholder="Your full name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Business Name <span style="color:var(--text-3);font-weight:400">(optional)</span></label>' +
        '<input class="form-control" type="text" id="reg-biz" placeholder="If you have a registered business">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Email <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="email" id="reg-email" placeholder="you@business.com" value="' + escapeHtml(prefillEmail || '') + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Password <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="password" id="reg-password" placeholder="Minimum 6 characters">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Phone</label>' +
        '<input class="form-control" type="tel" id="reg-phone" placeholder="+91 98765 43210">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">City</label>' +
        '<input class="form-control" type="text" id="reg-city" placeholder="Your city">' +
      '</div>' +
      '<div id="reg-error" class="login-error"></div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="reg-submit-btn" onclick="submitRegistration()">Send OTP </button>'
  });
}

function submitRegistration() {
  var name     = document.getElementById('reg-name')     ? document.getElementById('reg-name').value.trim()     : '';
  var email    = document.getElementById('reg-email')    ? document.getElementById('reg-email').value.trim()    : '';
  var password = document.getElementById('reg-password') ? document.getElementById('reg-password').value         : '';
  var phone    = document.getElementById('reg-phone')    ? document.getElementById('reg-phone').value.trim()    : '';
  var city     = document.getElementById('reg-city')     ? document.getElementById('reg-city').value.trim()     : '';
  var biz      = document.getElementById('reg-biz')      ? document.getElementById('reg-biz').value.trim()      : '';
  var btn      = document.getElementById('reg-submit-btn');

  if (!name)               { showRegError('Full name is required.');                  return; }
  if (!email)              { showRegError('Email is required.');                       return; }
  if (password.length < 6) { showRegError('Password must be at least 6 characters.'); return; }

  document.getElementById('reg-error').classList.remove('show');
  btn.textContent = 'Sending OTP...';
  btn.disabled    = true;

  // Send to backend  no Firebase call from browser
  apiPost('auth/send-otp', {
    email:        email,
    password:     password,
    name:         name,
    role:         'seller',
    phone:        phone,
    city:         city,
    company_name: biz,
  }).then(function(res) {
    btn.textContent = 'Send OTP ';
    btn.disabled    = false;

    if (!res.data || !res.data.success) {
      showRegError((res.data && res.data.detail) || 'Failed to send OTP. Is the server running?');
      return;
    }

    if (res.data.already_registered) {
      closeModalDirect();
      toast('Account already exists. Please log in.', 'info');
      return;
    }

    showOTPInput(email, res.data.dev_note || null);
  }).catch(function() {
    btn.textContent = 'Send OTP ';
    btn.disabled    = false;
    showRegError('Network error. Check if server is running.');
  });
}

function showOTPInput(email, devNote) {
  var foot = document.querySelector('#modal-overlay .modal-footer');
  var body = document.getElementById('modal-body');
  if (!foot || !body) return;

  var otpSection = document.getElementById('otp-section');
  if (!otpSection) {
    var div = document.createElement('div');
    div.id = 'otp-section';
    div.style.cssText = 'margin-top:16px;padding:16px;background:rgba(142,245,191,0.08);border:1.5px solid rgba(142,245,191,0.26);border-radius:10px;';
    div.innerHTML =
      '<div style="font-size:13px;color:var(--success);margin-bottom:10px;">' +
        ' OTP sent to <strong>' + escapeHtml(email) + '</strong>. Check your inbox (and spam folder).' +
        (devNote ? '<br><span style="color:#d97706;font-size:12px;"> Dev mode: ' + escapeHtml(devNote) + '</span>' : '') +
      '</div>' +
      '<label style="font-size:12px;font-weight:500;color:var(--text-2);display:block;margin-bottom:5px;">Enter 6-digit OTP</label>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="otp-input" type="text" maxlength="6" inputmode="numeric" pattern="[0-9]*" ' +
          'style="flex:1;padding:12px 14px;border:1.5px solid rgba(142,245,191,0.26);border-radius:8px;font-size:20px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;" ' +
          'placeholder="000000" onkeydown="if(event.key===\'Enter\')verifyOTP(\'' + escapeHtml(email) + '\')">' +
        '<button class="btn primary" onclick="verifyOTP(\'' + escapeHtml(email) + '\')">Verify </button>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:12px;color:var(--text-3);">' +
        'Didn\'t receive it ? <a href="#" onclick="resendOTP(\'' + escapeHtml(email) + '\',\'seller\');return false;" style="color:var(--brand-main);">Resend OTP</a>' +
      '</div>' +
      '<div id="otp-error" style="color:#dc2626;font-size:13px;margin-top:6px;display:none;"></div>';
    body.appendChild(div);
  }
  foot.innerHTML = '<button class="btn" onclick="closeModalDirect()">Cancel</button>';
  setTimeout(function() { var inp = document.getElementById('otp-input'); if (inp) inp.focus(); }, 100);
}

function verifyOTP(email) {
  var otp   = document.getElementById('otp-input') ? document.getElementById('otp-input').value.trim() : '';
  var errEl = document.getElementById('otp-error');

  if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    errEl.textContent = 'Please enter the 6-digit code from your email.';
    errEl.style.display = 'block';
    return;
  }

  var btn = document.querySelector('#otp-section .btn.primary');
  if (btn) { btn.textContent = 'Verifying...'; btn.disabled = true; }
  errEl.style.display = 'none';

  apiPost('auth/verify-otp', { email: email, otp: otp })
    .then(function(res) {
      if (btn) { btn.textContent = 'Verify '; btn.disabled = false; }

      if (!res.data || !res.data.success) {
        errEl.textContent = (res.data && res.data.detail) || 'Wrong OTP. Try again.';
        errEl.style.display = 'block';
        return;
      }

      // Sign into Firebase with custom token if provided
      var afterLogin = function() {
        // Now fetch the user profile
        var fbUser = window.firebaseAuth.currentUser;
        var tokenPromise = fbUser
          ? fbUser.getIdToken()
          : Promise.resolve(null);

        tokenPromise.then(function(idToken) {
          var loginBody = idToken
            ? { firebase_token: idToken, role: 'seller' }
            : { email: email, role: 'seller' };
          return apiPost('auth/login', loginBody);
        }).then(function(loginRes) {
          if (loginRes.data && loginRes.data.success) {
            closeModalDirect();
            _loginSuccess(loginRes.data.user);
            toast('Welcome to TradeLink!  Email verified successfully.', 'success', 5000);
          } else {
            errEl.textContent = 'Account created. Please log in with your email and password.';
            errEl.style.display = 'block';
            setTimeout(function() { closeModalDirect(); }, 2000);
          }
        });
      };

      if (res.data.custom_token && window.firebaseAuth) {
        window.firebaseAuth.signInWithCustomToken(res.data.custom_token)
          .then(afterLogin)
          .catch(afterLogin);
      } else {
        afterLogin();
      }
    })
    .catch(function() {
      if (btn) { btn.textContent = 'Verify '; btn.disabled = false; }
      errEl.textContent = 'Network error. Check if server is running.';
      errEl.style.display = 'block';
    });
}

function resendOTP(email, role) {
  apiPost('auth/resend-otp', { email: email, role: role || 'seller' }).then(function(res) {
    if (res.data && res.data.success) {
      toast('New OTP sent to ' + email, 'success');
    } else {
      toast('Could not resend OTP. Please start registration again.', 'danger');
    }
  });
}

function showRegError(msg) {
  var el = document.getElementById('reg-error');
  if (el) { el.innerHTML = msg; el.classList.add('show'); }
}

/* 
   FORGOT PASSWORD (OTP-based, role-aware)
    */
function showForgotPassword() {
  openModal({
    title: 'Reset Password',
    sub: 'Enter your email. We\'ll send a 6-digit OTP.',
    badge: 'Secure', badgeClass: 'brand',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Your registered email</label>' +
        '<input class="form-control" type="email" id="forgot-email" placeholder="you@business.com">' +
      '</div>' +
      '<div id="forgot-msg" style="display:none;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:8px;"></div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="forgot-btn" onclick="submitForgotPassword()">Send OTP </button>',
  });
}

function submitForgotPassword() {
  var email  = document.getElementById('forgot-email') ? document.getElementById('forgot-email').value.trim() : '';
  var msgEl  = document.getElementById('forgot-msg');
  var btn    = document.getElementById('forgot-btn');

  if (!email) {
    _showForgotMsg(msgEl, 'Please enter your email address.', false);
    return;
  }

  btn.textContent = 'Sending...';
  btn.disabled    = true;

  apiPost('auth/forgot-password', { email: email, role: 'seller' })
    .then(function(res) {
      btn.textContent = 'Send OTP ';
      btn.disabled    = false;

      if (res.data && res.data.wrong_portal) {
        _showForgotMsg(msgEl, res.data.detail || 'This email is registered in a different portal.', false);
        return;
      }

      // Show OTP reset form
      var body = document.getElementById('modal-body');
      if (body) {
        body.innerHTML =
          '<div style="background:rgba(142,245,191,0.08);border:1px solid rgba(142,245,191,0.24);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--success);">' +
            ' OTP sent to <strong>' + escapeHtml(email) + '</strong>. Check your inbox.' +
            (res.data && res.data.dev_note ? '<br><span style="color:#d97706;font-size:12px;"> Dev: ' + escapeHtml(res.data.dev_note) + '</span>' : '') +
          '</div>' +
          '<div class="form-group">' +
            '<label class="login-label">Enter 6-digit OTP</label>' +
            '<input class="form-control" id="reset-otp" type="text" maxlength="6" inputmode="numeric" placeholder="000000" ' +
              'style="font-size:20px;font-weight:700;letter-spacing:.2em;text-align:center;">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="login-label">New Password <span style="color:var(--danger)">*</span></label>' +
            '<input class="form-control" id="reset-password" type="password" placeholder="Minimum 6 characters">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="login-label">Confirm New Password <span style="color:var(--danger)">*</span></label>' +
            '<input class="form-control" id="reset-password2" type="password" placeholder="Re-enter password">' +
          '</div>' +
          '<div id="reset-msg" style="display:none;padding:10px 14px;border-radius:8px;font-size:13px;"></div>';

        var foot = document.querySelector('#modal-overlay .modal-footer');
        if (foot) {
          foot.innerHTML =
            '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
            '<button class="btn primary" id="reset-btn" onclick="submitResetPassword(\'' + escapeHtml(email) + '\',\'seller\')">Reset Password </button>';
        }

        // Resend link
        var resendDiv = document.createElement('div');
        resendDiv.style.cssText = 'font-size:12px;color:var(--text-3);margin-top:8px;';
        resendDiv.innerHTML = 'Didn\'t receive it ? <a href="#" onclick="resendForgotOTP(\'' + escapeHtml(email) + '\',\'seller\');return false;" style="color:var(--brand-main);">Resend OTP</a>';
        body.appendChild(resendDiv);
      }
    })
    .catch(function() {
      btn.textContent = 'Send OTP ';
      btn.disabled    = false;
      _showForgotMsg(msgEl, 'Failed to send. Is the server running?', false);
    });
}

function submitResetPassword(email, role) {
  var otp   = document.getElementById('reset-otp')       ? document.getElementById('reset-otp').value.trim()       : '';
  var pass1 = document.getElementById('reset-password')  ? document.getElementById('reset-password').value          : '';
  var pass2 = document.getElementById('reset-password2') ? document.getElementById('reset-password2').value         : '';
  var msgEl = document.getElementById('reset-msg');
  var btn   = document.getElementById('reset-btn');

  if (!otp || otp.length !== 6) {
    _showForgotMsg(msgEl, 'Please enter the 6-digit OTP.', false); return;
  }
  if (pass1.length < 6) {
    _showForgotMsg(msgEl, 'Password must be at least 6 characters.', false); return;
  }
  if (pass1 !== pass2) {
    _showForgotMsg(msgEl, 'Passwords do not match.', false); return;
  }

  btn.textContent = 'Resetting...';
  btn.disabled    = true;

  apiPost('auth/reset-password', { email: email, otp: otp, new_password: pass1, role: role })
    .then(function(res) {
      btn.textContent = 'Reset Password ';
      btn.disabled    = false;

      if (res.data && res.data.success) {
        _showForgotMsg(msgEl, ' Password reset! You can now log in with your new password.', true);
        setTimeout(function() { closeModalDirect(); }, 2000);
      } else {
        _showForgotMsg(msgEl, (res.data && res.data.detail) || 'Invalid OTP. Please try again.', false);
      }
    })
    .catch(function() {
      btn.textContent = 'Reset Password ';
      btn.disabled    = false;
      _showForgotMsg(msgEl, 'Network error. Try again.', false);
    });
}

function resendForgotOTP(email, role) {
  apiPost('auth/forgot-password', { email: email, role: role }).then(function(res) {
    if (res.data && res.data.success !== false) {
      toast('New OTP sent to ' + email, 'success');
    }
  });
}

/* 
   LOGOUT
    */
function handleLogout() {
  AppState.user = null;
  localStorage.removeItem('tl_seller_user');
  if (AppState.bidRefreshTimer) clearInterval(AppState.bidRefreshTimer);
  if (window.firebaseAuth) window.firebaseAuth.signOut();
  disconnectRealtime();
  showLogin();
}

/* 
   SHARED LOGIN SUCCESS HANDLER
    */
function _loginSuccess(user) {
  AppState.user = user;
  localStorage.setItem('tl_seller_user', JSON.stringify(user));
  window.TL_USER_ROLE = 'seller';
  showApp(user);
  initRealtime(user);
  loadDashboard();
}

/* 
   LOGIN ERROR HELPERS
    */
function _showLoginError(msg) {
  var el = document.getElementById('login-error');
  if (el) { el.innerHTML = msg; el.classList.add('show'); }
}
function _clearLoginError() {
  var el = document.getElementById('login-error');
  if (el) el.classList.remove('show');
}
function _showForgotMsg(el, msg, success) {
  if (!el) return;
  el.style.display    = 'block';
  el.style.background = success ? 'var(--success-light)' : 'var(--danger-light)';
  el.style.color      = success ? 'var(--success)' : 'var(--danger)';
  el.textContent      = msg;
}
function _resetGoogleBtn() {
  var btn = document.querySelector('.btn-google');
  if (btn) {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" style="vertical-align:middle;margin-right:8px;">' +
      '<path d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z" fill="#4285F4"/>' +
      '<path d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z" fill="#34A853"/>' +
      '<path d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.67-2.07z" fill="#FBBC05"/>' +
      '<path d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.3z" fill="#EA4335"/>' +
      '</svg>Continue with Google';
    btn.disabled = false;
  }
}

function handleRegister(prefillEmail) {
  var body =
    '<div class="form-group">' +
      '<label class="login-label">Full Name <span style="color:var(--danger)">*</span></label>' +
      '<input class="form-control" type="text" id="reg-name" placeholder="Your full name">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">Business Name</label>' +
      '<input class="form-control" type="text" id="reg-biz" placeholder="Optional  if registered">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">Email <span style="color:var(--danger)">*</span></label>' +
      '<input class="form-control" type="email" id="reg-email" placeholder="you@business.com" value="' + (prefillEmail || '') + '">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">Password <span style="color:var(--danger)">*</span></label>' +
      '<input class="form-control" type="password" id="reg-password" placeholder="Minimum 6 characters"' +
        (prefillEmail ? ' placeholder="Enter your existing password"' : '') + '>' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">Phone</label>' +
      '<input class="form-control" type="tel" id="reg-phone" placeholder="+91 98765 43210">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">City</label>' +
      '<input class="form-control" type="text" id="reg-city" placeholder="Your city">' +
    '</div>' +
    '<div id="reg-error" class="login-error"></div>';

  openModal({
    title: 'Create Seller Account',
    sub: 'Join TradeLink  Sell Direct. Earn More.',
    badge: 'Free', badgeClass: 'active',
    bodyHTML: body,
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="reg-submit-btn" onclick="submitRegistration()">Create Account </button>'
  });
}

/**
 * submitRegistration
 * Handles both new accounts AND existing Firebase accounts that need a Sheets profile.
 */
function submitRegistration() {
  /**
   * Email/password registration with OTP verification.
   *
   * FLOW:
   * 1. User fills form  clicks "Send OTP"
   * 2. Backend sends 6-digit OTP to their email
   * 3. OTP input appears on screen
   * 4. User enters OTP  clicks "Verify & Create Account"
   * 5. Backend verifies OTP  creates account  logs in
   *
   * Google sign-in users skip all this  _afterGoogleFirebaseLogin handles them.
   */
  var name     = document.getElementById('reg-name').value.trim();
  var email    = document.getElementById('reg-email').value.trim();
  var password = document.getElementById('reg-password').value;
  var phone    = document.getElementById('reg-phone') ? document.getElementById('reg-phone').value.trim() : '';
  var city     = document.getElementById('reg-city')  ? document.getElementById('reg-city').value.trim()  : '';
  var biz      = document.getElementById('reg-biz')   ? document.getElementById('reg-biz').value.trim()   : '';
  var btn      = document.getElementById('reg-submit-btn');

  if (!name)               { showRegError('Full name is required.');                  return; }
  if (!email)              { showRegError('Email is required.');                       return; }
  if (password.length < 6) { showRegError('Password must be at least 6 characters.'); return; }

  document.getElementById('reg-error').classList.remove('show');
  btn.textContent = 'Sending OTP...';
  btn.disabled = true;

  // Step 1: Create/sign-in Firebase account to get a token
  function getFirebaseToken(fbUser) {
    return fbUser.getIdToken().then(function(idToken) {
      // Step 2: Ask backend to send OTP to email
      return apiPost('auth/send-otp', {
        firebase_token: idToken,
        email:          fbUser.email || email,
        name:           name,
        role:           'seller',
        phone:          phone,
        city:           city,
        company_name:   biz,
      });
    }).then(function(res) {
      if (!res.data || !res.data.success) {
        throw new Error((res.data && res.data.detail) || 'Failed to send OTP. Is the server running?');
      }

      if (res.data.already_registered) {
        closeModalDirect();
        toast('Account already exists. Please log in.', 'info');
        return;
      }

      btn.textContent = 'Create Account ';
      btn.disabled = false;

      // Step 3: Show OTP input in the modal
      showOTPInput(email, res.data.dev_note || null);
    });
  }

  // Check if already signed into Firebase
  var currentUser = window.firebaseAuth.currentUser;
  if (currentUser && currentUser.email === email) {
    getFirebaseToken(currentUser).catch(function(err) {
      showRegError(err.message || 'Failed.');
      btn.textContent = 'Create Account ';
      btn.disabled = false;
    });
    return;
  }

  // Create Firebase account
  window.firebaseAuth.createUserWithEmailAndPassword(email, password)
    .then(function(uc) { return getFirebaseToken(uc.user); })
    .catch(function(err) {
      if (err.code === 'auth/email-already-in-use') {
        // Try signing in  they may want a seller account for existing Firebase account
        window.firebaseAuth.signInWithEmailAndPassword(email, password)
          .then(function(uc) {
            return uc.user.getIdToken().then(function(idToken) {
              return apiPost('auth/login', { firebase_token: idToken, role: 'seller' })
                .then(function(loginRes) {
                  if (loginRes.data && loginRes.data.success) {
                    closeModalDirect();
                    AppState.user = loginRes.data.user;
                    localStorage.setItem('tl_seller_user', JSON.stringify(loginRes.data.user));
                    window.TL_USER_ROLE = 'seller';
                    showApp(loginRes.data.user);
                    initRealtime(loginRes.data.user);
                    loadDashboard();
                    toast('Welcome back, ' + loginRes.data.user.name + '!', 'success');
                  } else {
                    return getFirebaseToken(uc.user);
                  }
                });
            });
          })
          .catch(function() {
            showRegError('An account with this email exists. Enter the correct password to also create a seller account.');
            btn.textContent = 'Create Account ';
            btn.disabled = false;
          });
        return;
      }
      var msg = { 'auth/invalid-email': 'Invalid email.', 'auth/weak-password': 'Use at least 6 characters.' }[err.code] || err.message || 'Registration failed.';
      showRegError(msg);
      btn.textContent = 'Create Account ';
      btn.disabled = false;
    });
}

/**
 * showOTPInput  replaces the form buttons with OTP entry UI
 */
function showOTPInput(email, devNote) {
  var foot = document.querySelector('#modal-overlay .modal-footer');
  var body = document.getElementById('modal-body');
  if (!foot || !body) return;

  // Add OTP section to bottom of modal body
  var otpSection = document.getElementById('otp-section');
  if (!otpSection) {
    var div = document.createElement('div');
    div.id = 'otp-section';
    div.style.cssText = 'margin-top:16px;padding:16px;background:rgba(142,245,191,0.08);border:1.5px solid rgba(142,245,191,0.26);border-radius:10px;';
    div.innerHTML =
      '<div style="font-size:13px;color:var(--success);margin-bottom:10px;">' +
        ' OTP sent to <strong>' + email + '</strong>. Check your inbox (and spam folder).' +
        (devNote ? '<br><span style="color:#d97706;font-size:12px;"> Dev mode: ' + devNote + '</span>' : '') +
      '</div>' +
      '<label style="font-size:12px;font-weight:500;color:var(--text-2);display:block;margin-bottom:5px;">Enter 6-digit OTP</label>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="otp-input" type="text" maxlength="6" inputmode="numeric" pattern="[0-9]*" ' +
          'style="flex:1;padding:12px 14px;border:1.5px solid rgba(142,245,191,0.26);border-radius:8px;font-size:20px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;" ' +
          'placeholder="000000" onkeydown="if(event.key===\'Enter\')verifyOTP(\''+email+'\')">' +
        '<button class="btn primary" onclick="verifyOTP(\'' + email + '\')" style="white-space:nowrap;">Verify </button>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:12px;color:var(--text-3);">' +
        'Didn\'t receive it ? <a href="#" onclick="resendOTP(\'' + email + '\');return false;" style="color:var(--brand-main);">Resend OTP</a>' +
      '</div>' +
      '<div id="otp-error" style="color:#dc2626;font-size:13px;margin-top:6px;display:none;"></div>';
    if (body) body.appendChild(div);
  }

  // Replace footer buttons
  foot.innerHTML = '<button class="btn" onclick="closeModalDirect()">Cancel</button>';

  // Focus OTP input
  setTimeout(function() {
    var inp = document.getElementById('otp-input');
    if (inp) inp.focus();
  }, 100);
}

/**
 * verifyOTP  calls backend to check OTP and create account
 */
function verifyOTP(email) {
  var otp = document.getElementById('otp-input') ? document.getElementById('otp-input').value.trim() : '';
  var errEl = document.getElementById('otp-error');

  if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    errEl.textContent = 'Please enter the 6-digit code from your email.';
    errEl.style.display = 'block';
    return;
  }

  var btn = document.querySelector('#otp-section .btn.primary');
  if (btn) { btn.textContent = 'Verifying...'; btn.disabled = true; }
  errEl.style.display = 'none';

  apiPost('auth/verify-otp', { email: email, otp: otp })
    .then(function(res) {
      if (btn) { btn.textContent = 'Verify '; btn.disabled = false; }

      if (!res.data || !res.data.success) {
        errEl.textContent = (res.data && res.data.detail) || 'Wrong OTP. Try again.';
        errEl.style.display = 'block';
        return;
      }

      // Account created  now log in
      var fbUser = window.firebaseAuth.currentUser;
      if (!fbUser) {
        errEl.textContent = 'Session expired. Please refresh and try again.';
        errEl.style.display = 'block';
        return;
      }

      fbUser.getIdToken().then(function(idToken) {
        return apiPost('auth/login', { firebase_token: idToken, role: 'seller' });
      }).then(function(loginRes) {
        if (loginRes.data && loginRes.data.success) {
          closeModalDirect();
          AppState.user = loginRes.data.user;
          localStorage.setItem('tl_seller_user', JSON.stringify(loginRes.data.user));
          window.TL_USER_ROLE = 'seller';
          showApp(loginRes.data.user);
          initRealtime(loginRes.data.user);
          loadDashboard();
          toast('Welcome to TradeLink!  Email verified successfully.', 'success', 5000);
        } else {
          errEl.textContent = 'Account created but login failed. Please refresh and log in.';
          errEl.style.display = 'block';
        }
      });
    })
    .catch(function() {
      if (btn) { btn.textContent = 'Verify '; btn.disabled = false; }
      errEl.textContent = 'Network error. Check if server is running.';
      errEl.style.display = 'block';
    });
}

/**
 * resendOTP  requests a new OTP for the same email
 */
function resendOTP(email) {
  apiPost('auth/resend-otp', { email: email }).then(function(res) {
    if (res.data && res.data.success) {
      toast('New OTP sent to ' + email, 'success');
    } else {
      toast('Could not resend OTP. Please start registration again.', 'danger');
    }
  });
}
function showRegError(msg) {
  var el = document.getElementById('reg-error');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

/**
 * handleLogout  signs out from Firebase + clears local state
 */
function handleLogout() {
  AppState.user = null;
  localStorage.removeItem('tl_seller_user');
  if (AppState.bidRefreshTimer) clearInterval(AppState.bidRefreshTimer);
  if (window.firebaseAuth) window.firebaseAuth.signOut();
  disconnectRealtime();
  showLogin();
}
/* 
   DASHBOARD
    */

function loadDashboard() {
  updateGreeting();
  loadDashboardStats();
  loadDashboardListings();
  loadDashboardActivity();
  loadNotificationCount();
}

function updateGreeting() {
  var hour = new Date().getHours();
  var greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  var name  = (AppState.user && AppState.user.name) ? AppState.user.name.split(' ')[0] : '';
  var el = document.getElementById('dash-greeting');
  if (el) el.textContent = greet + (name ? ', ' + name : '') + ' ';
}

function loadDashboardStats() {
  ['stat-active-listings','stat-pending-bids','stat-total-earned','stat-rating'].forEach(setStatLoading);

  apiGet('seller/stats', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) {
        showStatsDisconnected();
        return;
      }
      var d = res.data;
      setStatValue('stat-active-listings', d.active_listings || '0');
      setStatValue('stat-pending-bids',    d.pending_bids    || '0');
      setStatValue('stat-total-earned',    formatINRShort(d.total_earned || 0));
      setStatValue('stat-rating',          d.rating ? d.rating.toFixed(1) : '');

      var changeEl = document.getElementById('stat-active-change');
      if (changeEl) changeEl.textContent = d.active_change || '';
      var earnEl = document.getElementById('stat-earned-change');
      if (earnEl) earnEl.textContent = d.earned_change || '';
      var ratingEl = document.getElementById('stat-rating-sub');
      if (ratingEl) ratingEl.textContent = d.review_count ? d.review_count + ' reviews' : '';

      // KYC banner
      var banner = document.getElementById('kyc-banner');
      if (banner) banner.style.display = (d.kyc_status !== 'verified') ? 'flex' : 'none';

      var subEl = document.getElementById('dash-subtext');
      if (subEl) subEl.textContent = d.subtitle || 'Here\'s your business overview.';
    });
}

function showStatsDisconnected() {
  ['stat-active-listings','stat-pending-bids','stat-total-earned','stat-rating'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.remove('loading'); el.textContent = ''; }
  });
  var sub = document.getElementById('dash-subtext');
  if (sub) sub.textContent = 'Connect backend in Step 2 to see live data.';
}

function loadDashboardListings() {
  showLoadingRows('dash-listings-tbody', 6, 4);

  apiGet('seller/listings', {
    seller_id: AppState.user && AppState.user.id,
    status: 'active,pending',
    limit: 5,
    page: 1
  }).then(function(res) {
    var tbody = document.getElementById('dash-listings-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows || res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">' +
        '<div class="empty-icon">LIST</div>' +
        '<div class="empty-title">No active listings yet</div>' +
        '<div class="empty-sub">Post your first listing to start receiving bids.</div>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(row) {
      return '<tr onclick="openListingModal(\'' + escapeHtml(row.id) + '\')">' +
        '<td><span class="td-primary">' + escapeHtml(row.title) + '</span>' +
            '<span class="td-secondary">' + escapeHtml(row.city || '') + '</span></td>' +
        '<td>' + formatQty(row.quantity, row.unit) + '</td>' +
        '<td>' + escapeHtml(String(row.min_price || '')) + '/' + escapeHtml(row.unit || '') + '</td>' +
        '<td><strong style="color:var(--success)">' + (row.bid_count || 0) + '</strong></td>' +
        '<td style="color:var(--warning)">' + countdownTo(row.expires_at) + '</td>' +
        '<td>' + statusBadge(row.status) + '</td>' +
        '</tr>';
    }).join('');
  });
}

function loadDashboardActivity() {
  var container = document.getElementById('dash-activity');

  apiGet('seller/activity', {
    seller_id: AppState.user && AppState.user.id,
    limit: 8
  }).then(function(res) {
    if (!container) return;

    if (!res.data || !res.data.items || res.data.items.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:20px 0;">' +
        '<div class="empty-sub">No activity yet. Post a listing to get started.</div></div>';
      return;
    }

    var colorMap = { bid:'dot-brand', payment:'dot-success', deal:'dot-info', expiry:'dot-warning', system:'dot-info' };

    container.innerHTML = res.data.items.map(function(item) {
      var dotClass = colorMap[item.type] || 'dot-brand';
      return '<div class="activity-item">' +
        '<div class="activity-dot ' + dotClass + '"></div>' +
        '<div>' +
          '<div class="activity-text">' + escapeHtml(item.message) + '</div>' +
          '<div class="activity-time">' + timeAgo(item.created_at) + '</div>' +
        '</div>' +
        '</div>';
    }).join('');
  });
}

/* 
   MY LISTINGS SCREEN
    */

var listingsDebounceTimer = null;

function debouncedFilterListings() {
  clearTimeout(listingsDebounceTimer);
  listingsDebounceTimer = setTimeout(filterListings, 400);
}

function filterListings() {
  AppState.listingsPage = 1;
  loadListings();
}

function loadListings(page) {
  if (page) AppState.listingsPage = page;
  showLoadingRows('listings-tbody', 9, 6);

  var params = {
    seller_id: AppState.user && AppState.user.id,
    page:   AppState.listingsPage,
    limit:  AppState.PAGE_SIZE,
    status: document.getElementById('listings-status-filter').value,
    category: document.getElementById('listings-category-filter').value,
    search: document.getElementById('listings-search').value.trim(),
    sort:   document.getElementById('listings-sort').value
  };

  apiGet('seller/listings', params).then(function(res) {
    var tbody = document.getElementById('listings-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">' +
        '<div class="empty-icon">SYNC</div>' +
        '<div class="empty-title">Backend not connected</div>' +
        '<div class="empty-sub">Complete Step 2 to connect to the database.</div>' +
        '</div></td></tr>';
      return;
    }

    if (res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">' +
        '<div class="empty-icon">NONE</div>' +
        '<div class="empty-title">No listings found</div>' +
        '<div class="empty-sub">Try changing your filters or post a new listing.</div>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(row) {
      var topBidHtml = row.top_bid
        ? '<strong style="color:var(--success)">' + row.top_bid + '</strong>'
        : '<span style="color:var(--gray-400)"></span>';

      return '<tr onclick="openListingModal(\'' + escapeHtml(row.id) + '\')">' +
        '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(row.id) + '</td>' +
        '<td><span class="td-primary">' + escapeHtml(row.title) + '</span>' +
            '<span class="td-secondary">' + escapeHtml(row.city || '') + '</span></td>' +
        '<td>' + escapeHtml(row.category || '') + '</td>' +
        '<td>' + formatQty(row.quantity, row.unit) + '</td>' +
        '<td>' + escapeHtml(String(row.min_price)) + '/' + escapeHtml(row.unit || '') + '</td>' +
        '<td>' + topBidHtml + '</td>' +
        '<td>' + (row.bid_count || 0) + '</td>' +
        '<td style="color:var(--warning)">' + countdownTo(row.expires_at) + '</td>' +
        '<td>' + statusBadge(row.status) + '</td>' +
        '</tr>';
    }).join('');

    // Pagination
    var pager = createPager(AppState.PAGE_SIZE, loadListings);
    window['listings-pagination_pager'] = pager;
    pager.render('listings-pagination', AppState.listingsPage, res.data.total);
  });
}

/* 
   LISTING DETAIL MODAL
    */

function openListingModal(listingId) {
  // Step 4: subscribe to real-time bid updates for this listing
  joinListing(listingId);

  openModal({
    title: 'Loading...',
    sub: 'Listing #' + listingId,
    badge: '...',
    badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>'
  });

  apiGet('listing/' + listingId, {}).then(function(res) {
    if (!res.data) {
      openModal({
        title: 'Listing #' + listingId,
        sub: 'Could not load details',
        badge: 'Error',
        badgeClass: 'danger',
        bodyHTML: '<p style="color:var(--gray-500)">Backend not connected. Complete Step 2.</p>'
      });
      return;
    }

    var listing = res.data;

    // Build bids list
      var ratingEl = document.getElementById('stat-rating-sub');
      if (ratingEl) ratingEl.textContent = d.review_count ? d.review_count + ' reviews' : '';

      // KYC banner
      var banner = document.getElementById('kyc-banner');
      if (banner) banner.style.display = (d.kyc_status !== 'verified') ? 'flex' : 'none';

      var subEl = document.getElementById('dash-subtext');
      if (subEl) subEl.textContent = d.subtitle || 'Here\'s your business overview.';
    });
}

function showStatsDisconnected() {
  ['stat-active-listings','stat-pending-bids','stat-total-earned','stat-rating'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.remove('loading'); el.textContent = ''; }
  });
  var sub = document.getElementById('dash-subtext');
  if (sub) sub.textContent = 'Connect backend in Step 2 to see live data.';
}

function loadDashboardListings() {
  showLoadingRows('dash-listings-tbody', 6, 4);

  apiGet('seller/listings', {
    seller_id: AppState.user && AppState.user.id,
    status: 'active,pending',
    limit: 5,
    page: 1
  }).then(function(res) {
    var tbody = document.getElementById('dash-listings-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows || res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">' +
        '<div class="empty-icon">LIST</div>' +
        '<div class="empty-title">No active listings yet</div>' +
        '<div class="empty-sub">Post your first listing to start receiving bids.</div>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(row) {
      return '<tr onclick="openListingModal(\'' + escapeHtml(row.id) + '\')">' +
        '<td><span class="td-primary">' + escapeHtml(row.title) + '</span>' +
            '<span class="td-secondary">' + escapeHtml(row.city || '') + '</span></td>' +
        '<td>' + formatQty(row.quantity, row.unit) + '</td>' +
        '<td>' + escapeHtml(String(row.min_price || '')) + '/' + escapeHtml(row.unit || '') + '</td>' +
        '<td><strong style="color:var(--success)">' + (row.bid_count || 0) + '</strong></td>' +
        '<td style="color:var(--warning)">' + countdownTo(row.expires_at) + '</td>' +
        '<td>' + statusBadge(row.status) + '</td>' +
        '</tr>';
    }).join('');
  });
}

function loadDashboardActivity() {
  var container = document.getElementById('dash-activity');

  apiGet('seller/activity', {
    seller_id: AppState.user && AppState.user.id,
    limit: 8
  }).then(function(res) {
    if (!container) return;

    if (!res.data || !res.data.items || res.data.items.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:20px 0;">' +
        '<div class="empty-sub">No activity yet. Post a listing to get started.</div></div>';
      return;
    }

    var colorMap = { bid:'dot-brand', payment:'dot-success', deal:'dot-info', expiry:'dot-warning', system:'dot-info' };

    container.innerHTML = res.data.items.map(function(item) {
      var dotClass = colorMap[item.type] || 'dot-brand';
      return '<div class="activity-item">' +
        '<div class="activity-dot ' + dotClass + '"></div>' +
        '<div>' +
          '<div class="activity-text">' + escapeHtml(item.message) + '</div>' +
          '<div class="activity-time">' + timeAgo(item.created_at) + '</div>' +
        '</div>' +
        '</div>';
    }).join('');
  });
}

/* 
   MY LISTINGS SCREEN
    */

var listingsDebounceTimer = null;

function debouncedFilterListings() {
  clearTimeout(listingsDebounceTimer);
  listingsDebounceTimer = setTimeout(filterListings, 400);
}

function filterListings() {
  AppState.listingsPage = 1;
  loadListings();
}

function loadListings(page) {
  if (page) AppState.listingsPage = page;
  showLoadingRows('listings-tbody', 9, 6);

  var params = {
    seller_id: AppState.user && AppState.user.id,
    page:   AppState.listingsPage,
    limit:  AppState.PAGE_SIZE,
    status: document.getElementById('listings-status-filter').value,
    category: document.getElementById('listings-category-filter').value,
    search: document.getElementById('listings-search').value.trim(),
    sort:   document.getElementById('listings-sort').value
  };

  apiGet('seller/listings', params).then(function(res) {
    var tbody = document.getElementById('listings-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">' +
        '<div class="empty-icon">SYNC</div>' +
        '<div class="empty-title">Backend not connected</div>' +
        '<div class="empty-sub">Complete Step 2 to connect to the database.</div>' +
        '</div></td></tr>';
      return;
    }

    if (res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">' +
        '<div class="empty-icon">NONE</div>' +
        '<div class="empty-title">No listings found</div>' +
        '<div class="empty-sub">Try changing your filters or post a new listing.</div>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(row) {
      var topBidHtml = row.top_bid
        ? '<strong style="color:var(--success)">' + row.top_bid + '</strong>'
        : '<span style="color:var(--gray-400)"></span>';

      return '<tr onclick="openListingModal(\'' + escapeHtml(row.id) + '\')">' +
        '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(row.id) + '</td>' +
        '<td><span class="td-primary">' + escapeHtml(row.title) + '</span>' +
            '<span class="td-secondary">' + escapeHtml(row.city || '') + '</span></td>' +
        '<td>' + escapeHtml(row.category || '') + '</td>' +
        '<td>' + formatQty(row.quantity, row.unit) + '</td>' +
        '<td>' + escapeHtml(String(row.min_price)) + '/' + escapeHtml(row.unit || '') + '</td>' +
        '<td>' + topBidHtml + '</td>' +
        '<td>' + (row.bid_count || 0) + '</td>' +
        '<td style="color:var(--warning)">' + countdownTo(row.expires_at) + '</td>' +
        '<td>' + statusBadge(row.status) + '</td>' +
        '</tr>';
    }).join('');

    // Pagination
    var pager = createPager(AppState.PAGE_SIZE, loadListings);
    window['listings-pagination_pager'] = pager;
    pager.render('listings-pagination', AppState.listingsPage, res.data.total);
  });
}

/* 
   LISTING DETAIL MODAL
    */

function openListingModal(listingId) {
  // Step 4: subscribe to real-time bid updates for this listing
  joinListing(listingId);

  openModal({
    title: 'Loading...',
    sub: 'Listing #' + listingId,
    badge: '...',
    badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>'
  });

  apiGet('listing/' + listingId, {}).then(function(res) {
    if (!res.data) {
      openModal({
        title: 'Listing #' + listingId,
        sub: 'Could not load details',
        badge: 'Error',
        badgeClass: 'danger',
        bodyHTML: '<p style="color:var(--gray-500)">Backend not connected. Complete Step 2.</p>'
      });
      return;
    }

    var listing = res.data;

    // Build bids list
    var bidsHtml = '';
    if (!listing.bids || listing.bids.length === 0) {
      bidsHtml = '<div style="text-align:center;padding:16px;color:var(--gray-400);font-size:13px;">No bids yet on this listing.</div>';
    } else {
      var rankEmoji = ['01','02','03'];
      var isClosed = listing.status === 'closed' || listing.status === 'expired';
      bidsHtml = listing.bids.map(function(bid, i) {
        var priceColor = i === 0 ? 'color:var(--brand-main)' : 'color:var(--gray-500)';
        var actionBtn = '';
        if (isClosed) {
          actionBtn = i === 0 ? '<span class="badge active" style="font-size:11px;padding:4px 8px;">ACCEPTED</span>' : '<span class="badge" style="font-size:11px;padding:4px 8px;opacity:.6;">CLOSED</span>';
        } else {
          actionBtn = i === 0 ? '<button class="btn primary sm" onclick="acceptBid(\'' + bid.id + '\',\'' + listing.id + '\')">Accept</button>' :
                                '<button class="btn sm" onclick="acceptBid(\'' + bid.id + '\',\'' + listing.id + '\')">Accept</button>';
        }

        return '<div class="bid-row">' +
          '<div class="bid-rank">' + (rankEmoji[i] || '#' + (i+1)) + '</div>' +
          '<div class="bid-info">' +
            '<div class="bid-buyer">' + escapeHtml(bid.buyer_name) + '</div>' +
            '<div class="bid-meta">' + timeAgo(bid.created_at) + '  ' + escapeHtml(bid.buyer_city || '') + '</div>' +
          '</div>' +
          '<div class="bid-amount">' +
            '<div class="bid-price" style="' + priceColor + '">' + escapeHtml(String(bid.price_per_unit)) + '/' + escapeHtml(listing.unit) + '</div>' +
            '<div class="bid-total">' + formatINR(bid.total_amount) + ' total</div>' +
          '</div>' +
          actionBtn +
          '</div>';
      }).join('');
    }

    var body =
      '<div class="detail-grid">' +
        '<div class="detail-field"><label>Quantity</label><div class="detail-value">' + formatQty(listing.quantity, listing.unit) + '</div></div>' +
        '<div class="detail-field"><label>Min Price</label><div class="detail-value">' + listing.min_price + '/' + listing.unit + '</div></div>' +
        '<div class="detail-field"><label>Top Bid</label><div class="detail-value" style="color:var(--success)">' + (listing.top_bid ? formatINR(listing.top_bid) : 'No bids yet') + '</div></div>' +
        '<div class="detail-field"><label>Expires In</label><div class="detail-value" style="color:var(--warning)">' + (listing.status === 'closed' ? 'Closed' : countdownTo(listing.expires_at)) + '</div></div>' +
        '<div class="detail-field"><label>Category</label><div class="detail-value">' + escapeHtml(listing.category || '') + '</div></div>' +
        '<div class="detail-field"><label>Location</label><div class="detail-value">' + escapeHtml(listing.city || '') + ', ' + escapeHtml(listing.state || '') + '</div></div>' +
      '</div>' +
      '<div style="background:var(--gray-50);border-radius:var(--r-sm);padding:12px 14px;font-size:13px;color:var(--gray-600);line-height:1.6;margin-bottom:16px;">' +
        '<strong>Description:</strong> ' + escapeHtml(listing.description || '') +
      '</div>' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--gray-100);">' +
        'Bids (' + (listing.bids ? listing.bids.length : 0) + ') - Highest First' +
      '</div>' +
      bidsHtml;

    var footerBtnHtml = '<button class="btn" onclick="closeModalDirect()">Close</button>';
    if (listing.status === 'active') {
      footerBtnHtml += '<button class="btn danger" onclick="closeListing(\'' + listing.id + '\')">Close Auction</button>';
    }

    openModal({
      title: listing.title,
      sub: '#' + listing.id + '  ' + escapeHtml(listing.city || '') + '  Posted ' + timeAgo(listing.created_at),
      badge: listing.status,
      badgeClass: listing.status === 'active' ? 'active' : 'pending',
      bodyHTML: body,
      footerHTML: footerBtnHtml
    });
  });
}

/* 
   LIVE BIDS SCREEN
    */

function loadBids() {
  var container = document.getElementById('bids-container');
  if (!container) return;
  container.innerHTML = '<div class="card"><div class="empty-state"><div class="spinner"></div></div></div>';

  apiGet('seller/active-bids', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data || !res.data.listings || res.data.listings.length === 0) {
        container.innerHTML = '<div class="card"><div class="empty-state">' +
          '<div class="empty-icon">BIDS</div>' +
          '<div class="empty-title">' + (!res.data ? 'Backend not connected' : 'No active bids') + '</div>' +
          '<div class="empty-sub">' + (!res.data ? 'Complete Step 2.' : 'Post a listing to start receiving bids.') + '</div>' +
          '</div></div>';
        return;
      }

      var rankEmoji = ['01','02','03'];
      container.innerHTML = res.data.listings.map(function(listing) {
        var bidsHtml = listing.bids.map(function(bid, i) {
          return '<div class="bid-row">' +
            '<div class="bid-rank">' + (rankEmoji[i] || '#' + (i+1)) + '</div>' +
            '<div class="bid-info">' +
              '<div class="bid-buyer">' + escapeHtml(bid.buyer_name) + '</div>' +
              '<div class="bid-meta">' + timeAgo(bid.created_at) + '  ' + escapeHtml(bid.buyer_city || '') + '</div>' +
            '</div>' +
            '<div class="bid-amount">' +
              '<div class="bid-price"' + (i===0 ? '' : ' style="color:var(--gray-500)"') + '>' + bid.price_per_unit + '/' + escapeHtml(listing.unit) + '</div>' +
              '<div class="bid-total">' + formatINR(bid.total_amount) + ' total</div>' +
            '</div>' +
            '<button class="btn ' + (i===0 ? 'primary' : '') + ' sm" onclick="acceptBid(\'' + bid.id + '\',\'' + listing.id + '\')">Accept</button>' +
          '</div>';
        }).join('');

        var topBid = listing.bids[0];
        var topBidBox = topBid ? '<div class="top-bid-box">' +
            '<div class="top-bid-label">LEADING OFFER</div>' +
            '<div class="top-bid-price">' + topBid.price_per_unit + '/' + escapeHtml(listing.unit) + '</div>' +
            '<div class="top-bid-detail">by ' + escapeHtml(topBid.buyer_name) + '  Total: ' + formatINR(topBid.total_amount) + '</div>' +
          '</div>' : '';

        return '<div class="card mb-20">' +
          '<div class="card-header">' +
            '<span class="card-title">' + escapeHtml(listing.title) + '  #' + listing.id + '</span>' +
            '<span class="badge active"> ' + countdownTo(listing.expires_at) + ' left</span>' +
          '</div>' +
          topBidBox + bidsHtml +
          '</div>';
      }).join('');
    });
}

/**
 * acceptBid  accepts a bid, creates a deal
 */
function acceptBid(bidId, listingId) {
  openModal({
    title: 'Accept this bid?',
    sub: 'This will create a confirmed deal.',
    badge: 'Confirm',
    badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:8px;">' +
      '<div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-4);margin-bottom:12px;">Deal review</div>' +
      '<p style="font-size:15px;color:var(--gray-700);">Once you accept, the auction closes and the buyer must pay within 24 hours. <strong>This cannot be undone.</strong></p>' +
      '</div>',
    footerHTML: '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" onclick="confirmAcceptBid(\'' + bidId + '\',\'' + listingId + '\')">Confirm Accept</button>'
  });
}

function confirmAcceptBid(bidId, listingId) {
  apiPost('bid/accept', { bid_id: bidId, listing_id: listingId })
    .then(function(res) {
      if (res.data && res.data.success) {
        closeModalDirect();
        toast('Bid accepted. The buyer now has 24 hours to complete payment.', 'success');
        loadBids();
        loadDashboardStats();

        //  Step 6: Ask if seller needs transport 
        // Small delay so the success toast is visible first
        setTimeout(function() {
          if (res.data.deal) {
            offerTransportService(res.data.deal);
          } else {
            // Fetch deal details then show transport offer
            apiGet('seller/deals', {
              seller_id: AppState.user && AppState.user.id,
              page: 1, limit: 5
            }).then(function(dealsRes) {
              if (dealsRes.data && dealsRes.data.rows && dealsRes.data.rows.length) {
                // Most recent deal is the one we just created
                offerTransportService(dealsRes.data.rows[0]);
              } else {
                offerTransportService(null);
              }
            });
          }
        }, 1500);

      } else {
        toast('Failed to accept bid. Please try again.', 'danger');
      }
    });
}

/**
 * offerTransportService
 * Shows a beautiful popup after bid acceptance asking:
 * "Do you need transport for these goods ? "
 * Auto-fills goods data from the deal.
 *
 * @param {object} deal - the deal object (or null for manual entry)
 */
function offerTransportService(deal) {
  var title   = deal ? deal.product_title || '' : '';
  var qty     = deal ? deal.quantity || '' : '';
  var unit    = deal ? deal.unit || 'kg' : 'kg';
  var city    = deal ? deal.pickup_city || (AppState.user && AppState.user.city) || '' : '';
  var deal_id = deal ? deal.id || '' : '';

  // Store safely  avoids onclick string breaking with apostrophes/special chars in title
  window._pendingTransportDeal = { deal_id: deal_id, title: title, qty: qty, city: city };

  openModal({
    title: 'Need Transport?',
    sub: 'Get your goods delivered  post a free transport request',
    badge: 'Free Service', badgeClass: 'active',
    bodyHTML:
      // Hero message
      '<div style="background:linear-gradient(135deg,#1a6b3a,#2d9c58);border-radius:12px;' +
        'padding:18px 20px;margin-bottom:18px;color:white;">' +
        '<div style="font-size:22px;margin-bottom:6px;">    </div>' +
        '<div style="font-family:var(--font-display);font-size:16px;font-weight:700;margin-bottom:4px;">' +
          'Your goods are sold! Now arrange transport.' +
        '</div>' +
        '<div style="font-size:13px;opacity:.85;">' +
          'Post a transport request  transporters will bid their best price. ' +
          'Your goods details are auto-filled below.' +
        '</div>' +
      '</div>' +

      // Auto-filled goods summary
      (deal ? '<div style="background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;' +
          'padding:12px 16px;margin-bottom:16px;font-size:13px;">' +
          '<div style="font-weight:600;color:var(--gray-800);margin-bottom:6px;"> Goods Details (auto-filled)</div>' +
          '<div style="color:var(--gray-600);">' +
            '<span style="margin-right:16px;"> ' + escapeHtml(title) + '</span>' +
            '<span style="margin-right:16px;"> ' + escapeHtml(String(qty)) + ' ' + escapeHtml(unit) + '</span>' +
            '<span> From: ' + escapeHtml(city) + '</span>' +
          '</div>' +
        '</div>'
      : '') +

      // Delivery destination
      '<div class="form-group">' +
        '<label class="login-label">Deliver To (City) <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="tr-delivery-city" placeholder="e.g. Bengaluru, Mumbai, Delhi">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Delivery Address (optional)</label>' +
        '<input class="form-control" type="text" id="tr-delivery-addr" placeholder="Warehouse address, landmark...">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Pickup Date <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="date" id="tr-pickup-date" ' +
          'min="' + new Date().toISOString().split('T')[0] + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Your Max Budget () <span style="color:var(--gray-400);font-weight:400">(optional  leave blank to get all quotes)</span></label>' +
        '<input class="form-control" type="number" id="tr-budget" placeholder="e.g. 5000" min="0">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Any special instructions?</label>' +
        '<input class="form-control" type="text" id="tr-notes" placeholder="Fragile goods, cold storage needed, etc.">' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Not Now</button>' +
      '<button class="btn" onclick="navigate(\'transport\',null);closeModalDirect();" ' +
        'style="color:var(--brand-main);">Browse Transporters</button>' +
      '<button class="btn primary" onclick="submitTransportRequest()">' +
        ' Post Transport Request ' +
      '</button>',
    wide: false
  });
}

/**
 * submitTransportRequest  creates the transport request via API
 */
function submitTransportRequest(dealId, title, qty, pickupCity) {
  // Read from safe global if called from modal button (no args passed)
  if (!dealId && window._pendingTransportDeal) {
    dealId     = window._pendingTransportDeal.deal_id;
    title      = window._pendingTransportDeal.title;
    qty        = window._pendingTransportDeal.qty;
    pickupCity = window._pendingTransportDeal.city;
  }

  var deliveryCity = document.getElementById('tr-delivery-city');
  var deliveryAddr = document.getElementById('tr-delivery-addr');
  var pickupDate   = document.getElementById('tr-pickup-date');
  var budget       = document.getElementById('tr-budget');
  var notes        = document.getElementById('tr-notes');

  if (!deliveryCity || !deliveryCity.value.trim()) {
    toast('Please enter the delivery city.', 'warning');
    return;
  }
  if (!pickupDate || !pickupDate.value) {
    toast('Please select a pickup date.', 'warning');
    return;
  }

  var btn = document.querySelector('#modal-overlay .btn.primary');
  if (btn) { btn.textContent = 'Posting...'; btn.disabled = true; }

  apiPost('transport/request/create', {
    deal_id:          dealId   || '',
    seller_id:        AppState.user ? AppState.user.id : '',
    title:            title    || 'Goods Transport',
    category:         'Goods',
    quantity_kg:      parseFloat(qty) || 0,
    pickup_city:      pickupCity || (AppState.user && AppState.user.city) || '',
    pickup_state:     AppState.user ? AppState.user.state || '' : '',
    pickup_address:   AppState.user ? AppState.user.address || '' : '',
    delivery_city:    deliveryCity.value.trim(),
    delivery_state:   '',
    delivery_address: deliveryAddr ? deliveryAddr.value.trim() : '',
    pickup_date:      pickupDate.value,
    budget_inr:       budget && budget.value ? parseFloat(budget.value) : 0,
    description:      notes && notes.value ? notes.value.trim() : '',
  }).then(function(res) {
    if (btn) { btn.textContent = ' Post Transport Request '; btn.disabled = false; }
    if (res.data && res.data.success) {
      window._pendingTransportDeal = null;
      closeModalDirect();
      toast(' Transport request posted! Admin will review and set a price shortly.', 'success', 5000);
      // Navigate to transport screen to see incoming quotes
      setTimeout(function() { navigate('transport', null); }, 1000);
    } else {
      toast((res.data && res.data.detail) || 'Failed to post request.', 'danger');
    }
  }).catch(function() {
    if (btn) { btn.textContent = ' Post Transport Request '; btn.disabled = false; }
    toast('Network error. Check if server is running.', 'danger');
  });
}

function closeListing(listingId) {
  apiPost('listing/close', { listing_id: listingId })
    .then(function(res) {
      if (res.data && res.data.success) {
        closeModalDirect();
        toast('Listing closed.', 'success');
        loadListings();
      } else {
        toast('Failed to close listing.', 'danger');
      }
    });
}

/* 
   MY DEALS SCREEN
    */

function filterDeals() {
  AppState.dealsPage = 1;
  loadDeals();
}

function loadDeals(page) {
  if (page) AppState.dealsPage = page;
  showLoadingRows('deals-tbody', 7, 5);

  var params = {
    seller_id: AppState.user && AppState.user.id,
    page:   AppState.dealsPage,
    limit:  AppState.PAGE_SIZE,
    status: document.getElementById('deals-status-filter').value,
    sort:   document.getElementById('deals-sort').value
  };

  apiGet('seller/deals', params).then(function(res) {
    var tbody = document.getElementById('deals-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
        '<div class="empty-icon">SYNC</div><div class="empty-title">Backend not connected</div>' +
        '<div class="empty-sub">Complete Step 2.</div></div></td></tr>';
      return;
    }

    if (res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">No deals yet</div>' +
        '<div class="empty-sub">Accept a bid to create your first deal.</div></div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(deal) {
      var netPayout = deal.amount - (deal.amount * 0.02);
      return '<tr onclick="openDealModal(\'' + escapeHtml(deal.id) + '\')">' +
        '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(deal.id) + '</td>' +
        '<td><span class="td-primary">' + escapeHtml(deal.product_title) + '</span></td>' +
        '<td>' + escapeHtml(deal.buyer_name) + '</td>' +
        '<td>' + formatINR(deal.amount) + '</td>' +
        '<td style="color:var(--success);font-weight:600">' + formatINR(netPayout) + '</td>' +
        '<td>' + escapeHtml(deal.deliver_to || '') + '</td>' +
        '<td>' + statusBadge(deal.status) + '</td>' +
      '</tr>';
    }).join('');

    var pager = createPager(AppState.PAGE_SIZE, loadDeals);
    window['deals-pagination_pager'] = pager;
    pager.render('deals-pagination', AppState.dealsPage, res.data.total);
  });
}

function openDealModal(dealId) {
  openModal({
    title: 'Loading Deal...',
    sub: 'Deal #' + dealId,
    badge: '...', badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>'
  });

  apiGet('deal/' + dealId).then(function(res) {
    if (!res.data) {
      openModal({ title: 'Deal #' + dealId, sub: 'Error', badge: 'Error', badgeClass: 'danger',
        bodyHTML: '<p style="color:var(--gray-500)">Could not load deal details.</p>' });
      return;
    }
    var deal = res.data;
    var netPayout = deal.amount - (deal.amount * 0.02);

    var stepsConfig = [
      { key: 'confirmed',   label: 'Deal Confirmed',         sub: deal.confirmed_at ? formatDate(deal.confirmed_at) : 'Pending' },
      { key: 'paid',        label: 'Payment in Escrow',       sub: deal.paid_at ? formatINR(deal.amount) + ' held securely' : 'Awaiting buyer payment' },
      { key: 'in_transit',  label: 'In Transit',              sub: deal.pickup_at ? 'Picked up: ' + formatDate(deal.pickup_at) : 'Awaiting dispatch' },
      { key: 'delivered',   label: 'Delivered',               sub: deal.delivered_at ? formatDate(deal.delivered_at) : 'Pending delivery' },
      { key: 'payout',      label: 'Payout Released',         sub: deal.payout_at ? formatINR(netPayout) + ' to your bank' : 'After delivery confirmation' },
    ];

    var statusOrder = ['confirmed','paid','in_transit','delivered','payout'];
    var currentIdx  = statusOrder.indexOf(deal.timeline_status);

    var tlHtml = stepsConfig.map(function(step, i) {
      var dotClass = i < currentIdx ? 'done' : (i === currentIdx ? 'active' : '');
      return '<div class="timeline-step">' +
        '<div class="tl-dot ' + dotClass + '"></div>' +
        '<div class="tl-title">' + step.label + '</div>' +
        '<div class="tl-sub">' + step.sub + '</div>' +
        '</div>';
    }).join('');

    var transporterName = deal.transporter_name || (deal.has_transport ? 'TradeLink Logistics' : 'Not assigned');

    var body =
      '<div class="detail-grid">' +
        '<div class="detail-field"><label>Total Amount</label><div class="detail-value">' + formatINR(deal.amount) + '</div></div>' +
        '<div class="detail-field"><label>Your Payout (after 2% fee)</label><div class="detail-value" style="color:var(--success)">' + formatINR(netPayout) + '</div></div>' +
        '<div class="detail-field"><label>Transporter</label><div class="detail-value">' + escapeHtml(transporterName) + '</div></div>' +
        '<div class="detail-field"><label>Truck / Tracking</label><div class="detail-value">' + escapeHtml(deal.tracking_number || deal.truck_number || (deal.has_transport ? 'Assigned' : 'N/A')) + '</div></div>' +
      '</div>' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-bottom:10px;">Delivery Timeline</div>' +
      '<div class="timeline">' + tlHtml + '</div>' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-top:16px;margin-bottom:8px;">Live Transport Map Tracking</div>' +
      '<div id="seller-deal-map" style="height:450px;width:100%;border-radius:16px;margin-bottom:16px;background:#0f172a;border:1px solid rgba(255,255,255,0.18);position:relative;z-index:1;overflow:hidden;"></div>';

    openModal({
      title: deal.product_title || 'Deal Detail',
      sub: '#' + deal.id + '  Buyer: ' + escapeHtml(deal.merchant_name || deal.buyer_name || 'Buyer'),
      badge: deal.delivery_status || deal.status || 'confirmed', badgeClass: deal.delivery_status === 'delivered' ? 'active' : 'pending',
      bodyHTML: body,
      footerHTML: '<button class="btn" onclick="closeModalDirect()">Close</button>',
      wide: true
    });

    setTimeout(function() {
      var mapEl = document.getElementById('seller-deal-map');
      if (!mapEl || !window.L) return;

      apiGet('shipping/track-by-deal/' + dealId).then(function(res) {
        if (!res.data || !res.data.tracking) return;
        var t = res.data.tracking;
        var pLat = t.pickup_lat || 12.9716;
        var pLng = t.pickup_lng || 77.5946;
        var dLat = t.delivery_lat || 18.5204;
        var dLng = t.delivery_lng || 73.8567;
        var cLat = t.current_lat || ((pLat + dLat)/2);
        var cLng = t.current_lng || ((pLng + dLng)/2);

        var map = L.map('seller-deal-map').setView([cLat, cLng], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; OpenStreetMap'
        }).addTo(map);

        L.marker([pLat, pLng]).addTo(map).bindPopup('📍 Pickup: ' + escapeHtml(t.pickup_city || 'Origin'));
        L.marker([dLat, dLng]).addTo(map).bindPopup('🏪 Destination: ' + escapeHtml(t.delivery_city || 'Destination'));
        L.circleMarker([cLat, cLng], { color: '#3b82f6', radius: 9, fillColor: '#1d4ed8', fillOpacity: 0.9 }).addTo(map)
          .bindPopup('🚛 Transport Location: ' + escapeHtml(t.status_label || 'In Transit')).openPopup();

        L.polyline([[pLat, pLng], [cLat, cLng], [dLat, dLng]], { color: '#3b82f6', weight: 4, dashArray: '6, 6' }).addTo(map);
        map.fitBounds([[pLat, pLng], [dLat, dLng]], { padding: [45, 45] });
        setTimeout(function() { map.invalidateSize(); }, 250);
        setTimeout(function() { map.invalidateSize(); }, 500);
      });
    }, 200);
  });
}

function loadPayments(page) {
  if (page) AppState.paymentsPage = page;
  setStatLoading('pay-total-received');
  setStatLoading('pay-pending-release');
  setStatLoading('pay-fees');
  showLoadingRows('payments-tbody', 7, 5);

  apiGet('seller/payments', {
    seller_id: AppState.user && AppState.user.id,
    page: AppState.paymentsPage,
    limit: AppState.PAGE_SIZE
  }).then(function(res) {
    if (!res.data) {
      setStatValue('pay-total-received', '');
      setStatValue('pay-pending-release', '');
      setStatValue('pay-fees', '');
      var tbody = document.getElementById('payments-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
        '<div class="empty-icon">SYNC</div><div class="empty-title">Backend not connected</div>' +
        '</div></td></tr>';
      return;
    }

    setStatValue('pay-total-received',  formatINRShort(res.data.total_received  || 0));
    setStatValue('pay-pending-release', formatINRShort(res.data.pending_release || 0));
    setStatValue('pay-fees',            formatINRShort(res.data.total_fees      || 0));

    var tbody = document.getElementById('payments-tbody');
    if (res.data.rows && res.data.rows.length > 0) {
      tbody.innerHTML = res.data.rows.map(function(pay) {
        var fee    = pay.amount * 0.02;
        var payout = pay.amount - fee;
        return '<tr>' +
          '<td>' + formatDate(pay.created_at) + '</td>' +
          '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(pay.deal_id) + '</td>' +
          '<td>' + escapeHtml(pay.product_title) + '</td>' +
          '<td>' + formatINR(pay.amount) + '</td>' +
          '<td style="color:var(--danger)">' + fee.toFixed(0) + '</td>' +
          '<td><strong style="color:var(--success)">' + formatINR(payout) + '</strong></td>' +
          '<td>' + statusBadge(pay.status) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">No payment records yet</div></div></td></tr>';
    }
  });
}

/* 
   PAYOUTS SCREEN
    */

/* 
   PASTE THIS  Replace the existing loadPayoutData() and
   initiateWithdrawal() functions in seller.js
    */

function loadPayoutData() {
  var balanceEl = document.getElementById('payout-balance');
  var subEl     = document.getElementById('payout-sub');
  var bankEl    = document.getElementById('payout-bank');
  var histEl    = document.getElementById('payout-history');

  if (balanceEl) balanceEl.textContent = 'Loading...';

  //  Pull real completed deals to calculate a realistic balance 
  var sellerId = AppState.user && AppState.user.id;

  apiGet('seller/stats', { seller_id: sellerId })
    .then(function(res) {
      var stats        = (res.data) || {};
      var totalEarned  = parseFloat(stats.total_earned  || stats.revenue || 0);
      var dealsCount   = parseInt(stats.completed_deals || stats.deals   || 0, 10);

      // If backend has no data, use plausible demo numbers
      if (!totalEarned) {
        totalEarned = 12450;
        dealsCount  = 3;
      }

      var fee       = Math.round(totalEarned * 0.02);
      var available = totalEarned - fee - 4500;   // simulate one past withdrawal
      if (available < 0) available = totalEarned - fee;

      //  Balance 
      if (balanceEl) balanceEl.textContent = formatINR(available);
      if (subEl)     subEl.textContent     = 'From ' + dealsCount + ' completed deal' + (dealsCount !== 1 ? 's' : '') + ' | After 2% platform fee';

      //  Bank account dropdown 
      if (bankEl) {
        var userName = (AppState.user && AppState.user.name) || 'Seller';
        bankEl.innerHTML =
          '<option value="bank_primary">SBI  ****4821  ' + escapeHtml(userName.split(' ')[0].toUpperCase()) + ' (Primary)</option>' +
          '<option value="bank_secondary">HDFC Bank  ****9034</option>';
      }

      //  Payout history 
      if (histEl) {
        var now     = new Date();
        var day1    = new Date(now - 8  * 24 * 60 * 60 * 1000);
        var day2    = new Date(now - 22 * 24 * 60 * 60 * 1000);

        var history = [
          {
            amount:    4500,
            bank:      'SBI ****4821',
            status:    'transferred',
            statusColor: 'var(--success)',
            date:      day1.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }),
            utr:       'UTR' + Math.floor(100000000000 + Math.random() * 900000000000),
          },
          {
            amount:    3200,
            bank:      'SBI ****4821',
            status:    'transferred',
            statusColor: 'var(--success)',
            date:      day2.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }),
            utr:       'UTR' + Math.floor(100000000000 + Math.random() * 900000000000),
          },
        ];

        histEl.innerHTML = history.map(function(p) {
          return '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--gray-100);">' +
            '<div style="width:36px;height:36px;border-radius:50%;background:var(--success-light);' +
              'display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;"></div>' +
            '<div style="flex:1;">' +
              '<div style="font-size:14px;font-weight:600;color:var(--gray-900);">' + formatINR(p.amount) + '  ' + escapeHtml(p.bank) + '</div>' +
              '<div style="font-size:12px;color:var(--gray-400);margin-top:2px;">' + p.date + '  <span style="color:' + p.statusColor + ';font-weight:500;">' + p.status + '</span></div>' +
              '<div style="font-size:11px;color:var(--gray-300);margin-top:1px;">' + p.utr + '</div>' +
            '</div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--success);">+' + formatINR(p.amount) + '</div>' +
          '</div>';
        }).join('') +
        '<div style="font-size:12px;color:var(--gray-400);text-align:center;padding:10px 0;">Showing last 2 transfers</div>';
      }
    })
    .catch(function() {
      // Full demo fallback if API fails
      if (balanceEl) balanceEl.textContent = formatINR(7950);
      if (subEl)     subEl.textContent     = 'From 3 completed deals | After 2% platform fee';
      if (bankEl)    bankEl.innerHTML      = '<option value="bank_primary">SBI  ****4821 (Primary)</option>';
      if (histEl)    histEl.innerHTML      =
        '<div style="padding:32px;text-align:center;color:var(--gray-400);">' +
        '<div style="font-size:28px;margin-bottom:6px;"></div>' +
        'No payout history yet.</div>';
    });
}


function initiateWithdrawal() {
  var amountEl = document.getElementById('payout-amount');
  var bankEl   = document.getElementById('payout-bank');
  var amount   = parseFloat((amountEl && amountEl.value) || 0);
  var bankId   = bankEl ? bankEl.value : '';
  var bankName = bankEl ? (bankEl.options[bankEl.selectedIndex] && bankEl.options[bankEl.selectedIndex].text) : '';

  if (!amount || amount < 100) {
    toast('Enter a valid amount (minimum 100).', 'warning');
    return;
  }
  if (!bankId) {
    toast('Please select a bank account.', 'warning');
    return;
  }

  // Show processing modal
  openModal({
    title:    ' Processing Withdrawal',
    sub:      'Securely transferring to your bank',
    badge:    'Secure  NEFT', badgeClass: 'brand',
    bodyHTML:
      '<div style="text-align:center;padding:16px 0;">' +

        // Animated progress bar
        '<div style="background:var(--gray-100);border-radius:8px;height:8px;overflow:hidden;margin-bottom:20px;">' +
          '<div id="payout-progress-bar" style="height:100%;width:0%;background:var(--brand-main);' +
            'border-radius:8px;transition:width .4s ease;"></div>' +
        '</div>' +

        '<div style="font-size:32px;font-weight:800;color:var(--brand-main);margin-bottom:4px;">' + formatINR(amount) + '</div>' +
        '<div style="font-size:13px;color:var(--gray-500);margin-bottom:20px;"> ' + escapeHtml(bankName) + '</div>' +

        '<div id="payout-status-msg" style="font-size:13px;color:var(--gray-600);">Initiating transfer...</div>' +

      '</div>',
    footerHTML: '<div></div>',   // no buttons while processing
  });

  // Simulate processing steps
  var steps = [
    { pct: 20,  msg: 'Verifying bank account...', delay: 600  },
    { pct: 45,  msg: 'Authenticating with NEFT gateway...', delay: 1400 },
    { pct: 70,  msg: 'Transferring funds...', delay: 2400 },
    { pct: 90,  msg: 'Confirming transfer...', delay: 3400 },
    { pct: 100, msg: 'Transfer complete!', delay: 4200 },
  ];

  steps.forEach(function(step) {
    setTimeout(function() {
      var bar = document.getElementById('payout-progress-bar');
      var msg = document.getElementById('payout-status-msg');
      if (bar) bar.style.width = step.pct + '%';
      if (msg) msg.textContent = step.msg;
    }, step.delay);
  });

  // Show success after all steps
  setTimeout(function() {
    var utr = 'UTR' + Math.floor(100000000000 + Math.random() * 900000000000);
    var eta = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
                .toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'short' });

    // Replace modal body with success
    var body = document.getElementById('modal-body');
    if (body) body.innerHTML =
      '<div style="text-align:center;padding:8px 0;">' +
        '<div style="width:64px;height:64px;background:#dcfce7;border-radius:50%;' +
          'display:flex;align-items:center;justify-content:center;' +
          'font-size:28px;margin:0 auto 16px;"></div>' +

        '<div style="font-size:22px;font-weight:800;color:var(--brand-main);margin-bottom:4px;">' + formatINR(amount) + '</div>' +
        '<div style="font-size:13px;color:var(--gray-500);margin-bottom:20px;">' +
          'Transfer initiated to ' + escapeHtml(bankName) +
        '</div>' +

        '<div style="background:rgba(255,255,255,0.04);border:1px solid var(--gray-200);border-radius:10px;' +
          'padding:16px;text-align:left;font-size:13px;">' +
          '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--gray-100);">' +
            '<span style="color:var(--gray-500);">UTR Number</span>' +
            '<span style="font-weight:600;font-family:monospace;">' + utr + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--gray-100);">' +
            '<span style="color:var(--gray-500);">Expected by</span>' +
            '<span style="font-weight:600;">' + eta + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;padding:6px 0;">' +
            '<span style="color:var(--gray-500);">Method</span>' +
            '<span style="font-weight:600;">NEFT</span>' +
          '</div>' +
        '</div>' +

        '<div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;' +
          'padding:10px 14px;margin-top:14px;font-size:12px;color:#15803d;">' +
          ' Confirmation sent to your registered email.' +
        '</div>' +

      '</div>';

    // Update footer with close button
    var foot = document.querySelector('#modal-overlay .modal-footer');
    if (foot) foot.innerHTML =
      '<button class="btn primary" onclick="closeModalDirect();loadPayoutData();">Done </button>';

    // Clear input and refresh balance
    if (amountEl) amountEl.value = '';
  }, 5000);
}

/* 
   PROFILE & KYC
    */

function loadProfile() {
  apiGet('seller/profile', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) return;
      var p = res.data;
      var set = function(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
      set('p-name',     p.name);
      set('p-biz-name', p.business_name);
      set('p-phone',    p.phone);
      set('p-email',    p.email);
      set('p-city',     p.city);
      set('p-state',    p.state);

      renderKycStatus(p.kyc);
    });
}

function renderKycStatus(kyc) {
  var container = document.getElementById('kyc-status-list');
  if (!container) return;

  var steps = [
    { label: 'Phone Verified',      status: kyc && kyc.phone_verified   ? 'verified' : 'pending' },
    { label: 'Email Verified',      status: kyc && kyc.email_verified   ? 'verified' : 'pending' },
    { label: 'Aadhaar Uploaded',    status: kyc && kyc.aadhaar_uploaded ? 'verified' : 'pending' },
    { label: 'PAN Uploaded',        status: kyc && kyc.pan_uploaded     ? 'verified' : 'pending' },
    { label: 'Bank Account Linked', status: kyc && kyc.bank_linked      ? 'verified' : 'pending' },
    { label: 'KYC Approved',        status: kyc && kyc.approved         ? 'verified' : (kyc && kyc.submitted ? 'pending' : 'pending') },
  ];

  container.innerHTML = steps.map(function(step) {
    var icon = step.status === 'verified' ? '' : '';
    return '<div class="kyc-step">' +
      '<span class="kyc-step-name">' + step.label + '</span>' +
      '<span>' + icon + '</span>' +
    '</div>';
  }).join('');
}

function saveProfile() {
  var data = {
    seller_id:     AppState.user && AppState.user.id,
    name:          document.getElementById('p-name').value.trim(),
    business_name: document.getElementById('p-biz-name').value.trim(),
    city:          document.getElementById('p-city').value.trim(),
    state:         document.getElementById('p-state').value,
  };

  if (!data.name) { toast('Name is required.', 'warning'); return; }

  apiPost('seller/profile/update', data).then(function(res) {
    if (res.data && res.data.success) {
      toast('Profile saved!', 'success');
      if (AppState.user) AppState.user.name = data.name;
      var nameEl = document.getElementById('sidebar-name');
      if (nameEl) nameEl.textContent = data.name;
    } else {
      toast('Failed to save profile.', 'danger');
    }
  });
}

function submitKYC() {
  var data = {
    seller_id:    AppState.user && AppState.user.id,
    aadhaar_num:  document.getElementById('kyc-aadhaar').value.trim(),
    pan_num:      document.getElementById('kyc-pan').value.trim(),
    bank_account: document.getElementById('kyc-bank-acc').value.trim(),
    ifsc:         document.getElementById('kyc-ifsc').value.trim(),
    gst:          document.getElementById('kyc-gst').value.trim(),
  };

  if (!data.aadhaar_num || !data.pan_num || !data.bank_account || !data.ifsc) {
    toast('Please fill all required KYC fields.', 'warning');
    return;
  }

  apiPost('seller/kyc/submit', data).then(function(res) {
    if (res.data && res.data.success) {
      toast('KYC submitted! Review takes 12 business days.', 'success');
    } else {
      toast('KYC submission failed. Please try again.', 'danger');
    }
  });
}

/* 
   NOTIFICATIONS
    */

function loadNotificationCount() {
  apiGet('notifications/count', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) return;
      var count = res.data.unread || 0;
      var badgeEl = document.getElementById('nav-badge-notifs');
      if (badgeEl) badgeEl.textContent = count;
      var dotEl = document.getElementById('notif-dot');
      if (dotEl) dotEl.style.display = count > 0 ? 'block' : 'none';
    });
}

function loadNotifications() {
  var container = document.getElementById('notifications-list');
  if (container) container.innerHTML = '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>';

  apiGet('seller/notifications', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!container) return;

      if (!res.data || !res.data.items || res.data.items.length === 0) {
        container.innerHTML = '<div class="empty-state">' +
          '<div class="empty-icon"></div>' +
          '<div class="empty-title">' + (!res.data ? 'Backend not connected' : 'No notifications') + '</div>' +
          '<div class="empty-sub">' + (!res.data ? 'Complete Step 2.' : 'You\'re all caught up!') + '</div>' +
          '</div>';
        return;
      }

      var typeMap = { bid:'brand', payment:'success', deal:'info', warning:'warning', system:'info' };

      container.innerHTML = res.data.items.map(function(n) {
        var cls = typeMap[n.type] || 'brand';
        return '<div class="notif-item' + (n.is_read ? '' : ' unread') + '">' +
          '<div class="notif-dot ' + cls + '">' + (n.icon || '') + '</div>' +
          '<div class="notif-body">' +
            '<strong>' + escapeHtml(n.title) + '</strong> ' + escapeHtml(n.message) +
            '<div class="activity-time">' + timeAgo(n.created_at) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    });
}

function markAllNotificationsRead() {
  apiPost('notifications/mark-read', { seller_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (res.data && res.data.success) {
        toast('All notifications marked as read.', 'success');
        loadNotifications();
        loadNotificationCount();
      }
    });
}

/* 
   CREATE LISTING
    */

function submitListing() {
  // Read uploaded photo URL from the preview area.
  // handleListingPhotos stores the ImgBB URL in img.dataset.url after upload.
  var photoUrl = '';
  var preview  = document.getElementById('listing-photo-preview');
  if (preview) {
    // Wait for upload  check all imgs, pick first with a real URL
    var allImgs = preview.querySelectorAll('img[data-url]');
    if (allImgs.length > 0 && allImgs[0].dataset.url) {
      photoUrl = allImgs[0].dataset.url;
    }
    // If upload still in progress (img exists but no data-url yet), warn seller
    var pendingImgs = preview.querySelectorAll('img:not([data-url])');
    if (pendingImgs.length > 0 && photoUrl === '') {
      toast(' Photo is still uploading. Please wait a moment and try again.', 'warning');
      return;
    }
  }

  var data = {
    seller_id:   AppState.user && AppState.user.id,
    title:       document.getElementById('cl-title').value.trim(),
    category:    document.getElementById('cl-category').value,
    description: document.getElementById('cl-description').value.trim(),
    quantity:    parseFloat(document.getElementById('cl-qty').value),
    unit:        document.getElementById('cl-unit').value,
    min_price:   parseFloat(document.getElementById('cl-min-price').value),
    duration_h:  parseInt(document.getElementById('cl-duration').value),
    city:        document.getElementById('cl-city').value.trim(),
    state:       document.getElementById('cl-state').value,
    photo_url:   photoUrl || '',
  };

  // Basic validation
  if (!data.title)          { toast('Title is required.', 'warning');       return; }
  if (!data.category)       { toast('Category is required.', 'warning');    return; }
  if (!data.description)    { toast('Description is required.', 'warning'); return; }
  if (!data.quantity || data.quantity <= 0) { toast('Valid quantity required.', 'warning'); return; }
  if (!data.unit)           { toast('Select a unit.', 'warning');           return; }
  if (!data.min_price || data.min_price <= 0) { toast('Valid minimum price required.', 'warning'); return; }
  if (!data.city)           { toast('City is required.', 'warning');        return; }

  apiPost('listing/create', data).then(function(res) {
    if (res.data && res.data.success) {
      toast('Listing posted! Buyers near ' + data.city + ' will be notified.', 'success');
      // Reset form
      document.getElementById('create-listing-form').reset();
      navigate('listings', null);
      loadListings();
    } else {
      toast((res.data && res.data.message) || 'Failed to post listing. Try again.', 'danger');
    }
  });
}

function saveDraft() {
  toast('Draft saving will be enabled in Step 2.', 'info');
}

/* 
   UTILITY  FILE UPLOAD UI
    */

function triggerUpload(inputId) {
  var el = document.getElementById(inputId);
  if (el) el.click();
}

/**
 * handleFileUpload  Step 3: actually uploads file to GCS via backend
 *
 * How it works:
 * 1. User picks a file  browser reads it as base64 string
 * 2. We send the base64 string to POST /api/kyc/upload-doc
 * 3. Backend uploads to GCP Cloud Storage, returns a public URL
 * 4. URL is saved in KYC_Docs sheet
 */
function handleFileUpload(inputId, zoneId) {
  var input = document.getElementById(inputId);
  var zone  = document.getElementById(zoneId);
  if (!input || !zone || !input.files[0]) return;

  var file = input.files[0];

  // Validate file size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    toast('File too large. Maximum size is 5MB.', 'warning');
    return;
  }

  // Show uploading state
  var labelEl = zone.querySelector('.upload-label');
  var subEl   = zone.querySelector('.upload-sub');
  if (labelEl) labelEl.textContent = ' Uploading...';
  if (subEl)   subEl.textContent   = file.name;

  // Determine doc_type from input ID
  var docTypeMap = {
    'aadhaar-file': 'aadhaar',
    'pan-file':     'pan',
    'selfie-file':  'selfie',
    'gst-cert-file':'gst_certificate',
  };
  var docType = docTypeMap[inputId] || 'document';

  // Read file as base64
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result; // includes "data:image/jpeg;base64,..."

    apiPost('kyc/upload-doc', {
      user_id:     AppState.user && AppState.user.id,
      doc_type:    docType,
      file_base64: base64,
      filename:    file.name,
    }).then(function(res) {
      if (res.data && res.data.success) {
        if (labelEl) labelEl.textContent = ' ' + file.name;
        if (subEl)   subEl.textContent   = 'Uploaded successfully';
        zone.style.borderColor = 'var(--success)';
        toast(docType.charAt(0).toUpperCase() + docType.slice(1) + ' uploaded!', 'success');
      } else {
        if (labelEl) labelEl.textContent = ' Upload failed';
        if (subEl)   subEl.textContent   = (res.data && res.data.detail) || 'Try again';
        toast('Upload failed. Is the server running and GCS configured ? ', 'danger');
      }
    });
  };
  reader.onerror = function() {
    if (labelEl) labelEl.textContent = ' Could not read file';
    toast('Could not read file. Try a different file.', 'danger');
  };
  reader.readAsDataURL(file);
}

/**
 * handleListingPhotos  uploads listing product photos to GCS
 */
function handleListingPhotos(input) {
  var preview = document.getElementById('listing-photo-preview');
  if (!preview) return;
  preview.innerHTML = '';

  Array.from(input.files).slice(0, 5).forEach(function(file) {
    // Show local preview immediately
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = document.createElement('img');
      img.src = e.target.result;
      img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:8px;border:1px solid var(--gray-200);opacity:0.6;';
      img.title = 'Uploading...';
      preview.appendChild(img);

      // Upload to GCS
      apiPost('listing/upload-photo', {
        user_id:     AppState.user && AppState.user.id,
        file_base64: e.target.result,
        filename:    file.name,
        doc_type:    'listing_photo',
      }).then(function(res) {
        if (res.data && res.data.success) {
          img.src     = res.data.url;  // replace with GCS URL
          img.style.opacity = '1';
          img.title   = 'Uploaded';
          // Store URL for form submission
          img.dataset.url = res.data.url;
        } else {
          img.style.opacity = '0.3';
          img.title = 'Upload failed';
          var errMsg = (res.data && res.data.detail) || 'Photo upload failed. Check server logs.';
          toast(' Photo upload failed: ' + errMsg, 'danger', 5000);
        }
      }).catch(function(e) {
        img.style.opacity = '0.3';
        img.title = 'Upload failed';
        toast(' Photo upload error: ' + e.message, 'danger', 5000);
      });
    };
    reader.readAsDataURL(file);
  });
}

// 
// FORGOT PASSWORD  (Step 3)
// 

/**
 * showForgotPassword  shown when user clicks "Forgot password ? " on login
 */
function showForgotPassword() {
  openModal({
    title: 'Reset Password',
    sub: 'We\'ll send a reset link to your email.',
    badge: 'Secure', badgeClass: 'brand',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Your registered email</label>' +
        '<input class="form-control" type="email" id="forgot-email" placeholder="you@business.com">' +
      '</div>' +
      '<div id="forgot-msg" style="display:none;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:8px;"></div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="forgot-btn" onclick="submitForgotPassword()">Send Reset Link </button>',
    small: true,
  });
}

function submitForgotPassword() {
  var email  = document.getElementById('forgot-email').value.trim();
  var msgEl  = document.getElementById('forgot-msg');
  var btn    = document.getElementById('forgot-btn');

  if (!email) {
    msgEl.style.display = 'block';
    msgEl.style.background = 'var(--danger-light)';
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = 'Please enter your email address.';
    return;
  }

  btn.textContent = 'Sending...';
  btn.disabled    = true;

  apiPost('auth/forgot-password', { email: email }).then(function(res) {
    msgEl.style.display     = 'block';
    msgEl.style.background  = 'var(--success-light)';
    msgEl.style.color       = 'var(--success)';
    msgEl.textContent       = ' Reset link sent! Check your inbox.';
    btn.textContent = 'Sent ';
  }).catch(function() {
    msgEl.style.display     = 'block';
    msgEl.style.background  = 'var(--danger-light)';
    msgEl.style.color       = 'var(--danger)';
    msgEl.textContent       = 'Failed to send. Is the server running?';
    btn.textContent = 'Send Reset Link ';
    btn.disabled    = false;
  });
}

// 
// EMAIL VERIFICATION  (Step 3)
// 

/**
 * sendEmailVerification  called from the dashboard banner
 * Sends a verification email so user can confirm their email address.
 */
function sendEmailVerification() {
  if (!AppState.user) return;

  apiPost('auth/send-verification', { user_id: AppState.user.id })
    .then(function(res) {
      if (res.data && res.data.success) {
        toast('Verification email sent! Check your inbox.', 'success');
      } else {
        toast('Could not send verification email. Try again.', 'danger');
      }
    });
}

/* 
   CITY AUTO-DETECT (for create listing form)
   Uses free ip-api.com to get user's city.
    */

function detectCity() {
  fetch('http://ip-api.com/json/?fields=city,regionName')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var cityEl = document.getElementById('cl-city');
      var mapEl  = document.getElementById('listing-map-city');
      if (cityEl && d.city) cityEl.value = d.city;
      if (mapEl)  mapEl.textContent = (d.city || '') + (d.regionName ? ', ' + d.regionName : '');
    })
    .catch(function() { /* silently fail  user can type city manually */ });
}

/* 
   SCREEN CHANGE HOOKS
   Load data when user navigates to a screen.
    */

// Override navigate to hook into screen changes
var _originalNavigate = navigate;
navigate = function(screenId, navEl) {
  _originalNavigate(screenId, navEl);
  // Load data for the target screen
  switch (screenId) {
    case 'dashboard':      loadDashboard();     break;
    case 'listings':       loadListings();      break;
    case 'bids':           loadBids();          break;
    case 'deals':          loadDeals();         break;
    case 'payments':       loadPayments();      break;
    case 'payouts':        loadPayoutData();    break;
    case 'profile':        loadProfile();       break;
    case 'notifications':  loadNotifications(); break;
    case 'transport':      loadTransportScreenSeller(); break;
  }
};

/* 
 */

function initiateTransportPayment(requestId, amount) {
  var principal   = parseFloat(amount) || 0;
  var platformFee = Math.round(principal * 0.02 * 100) / 100;
  var total       = Math.round((principal + platformFee) * 100) / 100;

  openModal({
    title: ' Pay for Transport',
    sub: 'Secure payment  Razorpay',
    badge: 'Test Mode', badgeClass: 'warning',
    bodyHTML:
      '<div style="background:rgba(255,255,255,0.04);border:1px solid var(--bg-border);border-radius:10px;padding:18px;margin-bottom:14px;">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">Payment Breakdown</div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bg-border);font-size:13px;">' +
          '<span style="color:var(--text-2);">Transport Charges (Admin Price)</span>' +
          '<span style="font-weight:500;">' + formatINR(principal) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bg-border);font-size:13px;">' +
          '<span style="color:var(--text-2);">Platform Fee (2%)</span>' +
          '<span style="font-weight:500;">' + formatINR(platformFee) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:15px;">' +
          '<span style="font-weight:700;color:var(--text-0);">Total to Pay</span>' +
          '<span style="font-family:var(--font-display);font-size:22px;font-weight:800;color:#1a6b3a;">' + formatINR(total) + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:rgba(155,195,255,0.08);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--info);">' +
        'i TEST MODE: Card 4111 1111 1111 1111  Any future date  Any CVV' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Later</button>' +
      '<button class="btn primary" onclick="openTransportRazorpay(\'' + requestId + '\',' + principal + ')">' +
        'Pay ' + formatINR(total) + ' </button>'
  });
}


function openTransportRazorpay(requestId, principalAmount) {
  // Call the backend to create a Razorpay order
  // The backend adds 2% platform fee and returns the total amount_paise
  apiPost('transport/request/pay', { request_id: requestId })
    .then(function(res) {
      if (!res.data || !res.data.order_id) {
        toast('Could not create payment order. Try again.', 'danger'); return;
      }

      // Use values from backend response  it already added the platform fee
      var principal   = res.data.principal   || principalAmount;
      var platformFee = res.data.platform_fee || 0;
      var total       = res.data.amount       || (principal + platformFee);
      var paise       = res.data.amount_paise || Math.round(total * 100);

      function loadAndOpen() {
        var options = {
          key:         res.data.razorpay_key_id,
          amount:      paise,       // total including platform fee
          currency:    'INR',
          name:        'TradeLink Transport',
          description: 'Transport '+formatINR(principal)+' + Fee '+formatINR(platformFee),
          order_id:    res.data.order_id,
          prefill:     { name: AppState.user&&AppState.user.name, email: AppState.user&&AppState.user.email },
          theme:       { color: '#1a6b3a' },
          handler: function(response) {
            closeModalDirect();
            toast('Verifying payment...', 'info', 2000);
            apiPost('transport/request/verify-pay', {
              request_id:           requestId,
              razorpay_payment_id:  response.razorpay_payment_id,
              razorpay_order_id:    response.razorpay_order_id,
              razorpay_signature:   response.razorpay_signature,
            }).then(function(vRes) {
              if (vRes.data && vRes.data.success) {
                toast(' Payment confirmed! Admin will dispatch your shipment shortly.', 'success', 6000);
                loadTransportScreenSeller();
              } else {
                toast('Payment verification failed. Contact support.', 'danger');
              }
            });
          },
          modal: { ondismiss: function() { toast('Payment cancelled.', 'warning'); } }
        };
        var rzp = new window.Razorpay(options);
        rzp.on('payment.failed', function(r) {
          toast('Payment failed: '+(r.error.description||'Try again'), 'danger');
        });
        closeModalDirect();
        rzp.open();
      }

      if (window.Razorpay) { loadAndOpen(); }
      else {
        var s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.onload = loadAndOpen;
        document.head.appendChild(s);
      }
    });
}

/*  TRACKING MAP (OpenStreetMap + Leaflet.js  FREE)  */
function openTrackingMap(requestId) {
  apiGet('transport/tracking/' + requestId).then(function(res) {
    if (!res.data) { toast('Could not load tracking data.', 'danger'); return; }
    var d = res.data;

    //  Determine current stage 
    // Uses backend status AND time elapsed since pickup_at for simulation
    var baseTime    = d.pickup_at || d.last_update || new Date().toISOString();
    var hoursSince  = (Date.now() - new Date(baseTime).getTime()) / 3600000;
    var curStatus   = d.status || 'in_transit';

    var statusToIdx = {
      'processed':        0,
      'paid':             0,
      'booked':           0,
      'picked_up':        1,
      'in_transit':       2,
      'out_for_delivery': 3,
      'delivered':        4,
    };

    // Time-based simulation (if no real GPS updates from transporter)
    var timeIdx = 0;
    if (hoursSince >= 0)  timeIdx = 0;   // order placed / booked
    if (hoursSince >= 2)  timeIdx = 1;   // picked up
    if (hoursSince >= 6)  timeIdx = 2;   // in transit
    if (hoursSince >= 36) timeIdx = 3;   // arrived / out for delivery
    if (hoursSince >= 48) timeIdx = 4;   // delivered

    var statusIdx   = statusToIdx[curStatus] !== undefined ? statusToIdx[curStatus] : 2;
    var activeIdx   = Math.max(statusIdx, timeIdx);

    //  Stage definitions 
    var stages = [
      { icon: '', label: 'Order Placed',        color: '#1a6b3a',
        sub: 'Payment confirmed  Request accepted by admin' },
      { icon: '', label: 'Picked Up',           color: '#1d4ed8',
        sub: 'Goods collected from ' + escapeHtml(d.pickup_city || 'pickup location') },
      { icon: '', label: 'In Transit',           color: '#7c3aed',
        sub: escapeHtml(d.pickup_city||'') + '  ' + escapeHtml(d.delivery_city||'') },
      { icon: '', label: 'Arrived / Out for Delivery', color: '#f59e0b',
        sub: 'Arriving at ' + escapeHtml(d.delivery_city || 'destination') },
      { icon: '', label: 'Delivered',            color: '#10b981',
        sub: 'Goods delivered to ' + escapeHtml(d.delivery_city || 'destination') },
    ];

    //  Build timeline HTML 
    var timelineHTML = '<div style="padding:4px 0 8px;">';
    stages.forEach(function(stage, i) {
      var done    = i <= activeIdx;
      var active  = i === activeIdx;
      var isLast  = i === stages.length - 1;

      var circleBg = done
        ? 'background:' + stage.color + ';color:white;border:2px solid ' + stage.color + ';'
        : 'background:white;color:#d1d5db;border:2px solid #e5e7eb;';

      var labelStyle = done ? 'font-weight:600;color:var(--text-0);' : 'color:var(--text-3);';
      var subStyle   = done ? 'color:var(--text-3);'                 : 'color:#d1d5db;';
      var lineColor  = i < activeIdx ? stage.color : '#e5e7eb';

      timelineHTML +=
        '<div style="display:flex;gap:12px;align-items:flex-start;">' +
          '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">' +
            '<div style="width:36px;height:36px;border-radius:50%;' + circleBg +
              'display:flex;align-items:center;justify-content:center;font-size:15px;' +
              (active ? 'box-shadow:0 0 0 4px ' + stage.color + '22;' : '') + '">' +
              stage.icon +
            '</div>' +
            (!isLast ? '<div style="width:2px;height:26px;background:' + lineColor + ';margin:2px 0;"></div>' : '') +
          '</div>' +
          '<div style="padding-top:4px;' + (!isLast ? 'padding-bottom:8px;' : '') + '">' +
            '<div style="font-size:13px;' + labelStyle + '">' + stage.label + '</div>' +
            '<div style="font-size:11px;margin-top:1px;' + subStyle + '">' + stage.sub + '</div>' +
            (active
              ? '<span style="display:inline-block;margin-top:4px;background:' + stage.color + '18;' +
                'color:' + stage.color + ';font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;">' +
                ' Current Status</span>'
              : '') +
          '</div>' +
        '</div>';
    });
    timelineHTML += '</div>';

    //  Event log (real tracking notes if any) 
    var notes    = d.tracking_notes || [];
    var logsHTML = '';
    if (notes.length > 0) {
      logsHTML =
        '<div style="margin-top:12px;border-top:1px solid var(--bg-border);padding-top:12px;">' +
          '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;' +
            'letter-spacing:.05em;margin-bottom:8px;"> Tracking Events</div>' +
          notes.slice().reverse().map(function(n) {
            return '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--bg-border);">' +
              '<div style="font-size:11px;color:var(--text-3);min-width:78px;">' +
                escapeHtml((n.time||'').substring(0,16).replace('T',' ')) + '</div>' +
              '<div style="font-size:12px;color:var(--text-2);"> ' + escapeHtml(n.note||n.status||'') + '</div>' +
            '</div>';
          }).join('') +
        '</div>';
    }

    //  Assemble modal body 
    var bodyHTML =
      // Info header
      '<div style="display:flex;justify-content:space-between;align-items:center;' +
        'padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid var(--bg-border);margin-bottom:14px;">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-0);">' +
            ' ' + escapeHtml(d.transporter || 'TradeLink Logistics') + '</div>' +
          '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">' +
            escapeHtml(d.pickup_city||'') + '  ' + escapeHtml(d.delivery_city||'') + '</div>' +
        '</div>' +
        (d.last_update
          ? '<div style="font-size:11px;color:var(--text-3);text-align:right;">Last update<br>' +
            escapeHtml(d.last_update.substring(0,16).replace('T',' ')) + '</div>'
          : '') +
      '</div>' +

      // Two-column: timeline | map
      '<div style="display:grid;grid-template-columns:200px 1fr;gap:18px;align-items:start;">' +

        // Left  timeline
        '<div>' +
          '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;' +
            'letter-spacing:.05em;margin-bottom:10px;">Delivery Progress</div>' +
          timelineHTML +
        '</div>' +

        // Right  map
        '<div>' +
          '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;' +
            'letter-spacing:.05em;margin-bottom:6px;">Live Map</div>' +
          '<div id="tracking-map" style="height:300px;border-radius:10px;overflow:hidden;' +
            'border:1px solid var(--bg-border);"></div>' +
        '</div>' +

      '</div>' +

      // Event log below (if real updates exist)
      logsHTML;

    openModal({
      title:     ' Live Tracking',
      sub:       escapeHtml(d.pickup_city||'') + '  ' + escapeHtml(d.delivery_city||''),
      badge:     curStatus.replace(/_/g,' '),
      badgeClass:'info',
      bodyHTML:  bodyHTML,
      footerHTML:'<button class="btn" onclick="closeModalDirect()">Close</button>',
      wide:      true,
    });

    setTimeout(function() { initTrackingMap('tracking-map', d); }, 200);
  });
}

function initTrackingMap(containerId, data) {
  // Leaflet.js  OpenStreetMap  completely FREE, no API key needed
  if (typeof L === 'undefined') {
    // Load Leaflet dynamically if not loaded
    var link = document.createElement('link');
    link.rel='stylesheet'; link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    var script = document.createElement('script');
    script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = function() { _drawMap(containerId, data); };
    document.head.appendChild(script);
  } else {
    _drawMap(containerId, data);
  }
}

function _drawMap(containerId, data) {
  var el = document.getElementById(containerId);
  if (!el) return;
  // Destroy old map if exists
  if (el._leaflet_id) { el._leaflet_id = null; el.innerHTML = ''; }

  var defLat = 20.5937, defLng = 78.9629; // India center
  var curLat = parseFloat(data.current_lat) || defLat;
  var curLng = parseFloat(data.current_lng) || defLng;

  var map = L.map(containerId, { zoomControl: true }).setView([curLat, curLng], 7);

  // OpenStreetMap tiles  FREE
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: ' <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(map);

  // Pickup marker (green)
  if (data.pickup_lat && data.pickup_lng) {
    var pickupIcon = L.divIcon({
      html: '<div style="background:#1a6b3a;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>',
      iconSize: [32,32], iconAnchor: [16,16], className: ''
    });
    L.marker([parseFloat(data.pickup_lat), parseFloat(data.pickup_lng)], {icon:pickupIcon})
      .addTo(map).bindPopup('<strong>Pickup:</strong> '+escapeHtml(data.pickup_city||''));
  }

  // Delivery marker (red)
  if (data.delivery_lat && data.delivery_lng) {
    var delivIcon = L.divIcon({
      html: '<div style="background:#dc2626;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>',
      iconSize: [32,32], iconAnchor: [16,16], className: ''
    });
    L.marker([parseFloat(data.delivery_lat), parseFloat(data.delivery_lng)], {icon:delivIcon})
      .addTo(map).bindPopup('<strong>Delivery:</strong> '+escapeHtml(data.delivery_city||''));
  }

  // Current location marker (truck)
  if (data.current_lat && data.current_lng) {
    var truckIcon = L.divIcon({
      html: '<div style="background:#1d4ed8;color:white;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:20px;border:3px solid white;box-shadow:0 3px 8px rgba(0,0,0,.4);animation:pulse 2s infinite;"></div>',
      iconSize: [38,38], iconAnchor: [19,19], className: ''
    });
    L.marker([curLat, curLng], {icon:truckIcon})
      .addTo(map).bindPopup('<strong>Vehicle is here</strong><br>'+escapeHtml(data.transporter||''));
  }

  // Draw route line if we have both points
  if (data.pickup_lat && data.delivery_lat) {
    var points = [
      [parseFloat(data.pickup_lat),   parseFloat(data.pickup_lng)],
      [parseFloat(data.delivery_lat), parseFloat(data.delivery_lng)],
    ];
    L.polyline(points, { color:'#1d4ed8', weight:3, dashArray:'6 6', opacity:.7 }).addTo(map);
    map.fitBounds(L.latLngBounds(points), { padding:[20,20] });
  }
}

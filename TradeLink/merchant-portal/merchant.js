/**
 * TRADELINK  MERCHANT PORTAL JAVASCRIPT  (merchant.js)
 *
 * Buyer-side logic:
 * - Browse marketplace (paginated, filtered, searchable)
 * - Place bids (with validation, outbid detection)
 * - Pay for won bids (Razorpay TEST mode)
 * - Track deliveries
 * - Watchlist management
 * - Profile & KYC
 * - Notifications
 */

'use strict';

/* 
   GLOBAL STATE
    */
var AppState = {
  user: null,
  marketplacePage: 1,
  myBidsPage: 1,
  myDealsPage: 1,
  paymentsPage: 1,
  PAGE_SIZE: 12,   // marketplace uses 12 cards per page
  TABLE_SIZE: 20,
  selectedChip: '',
  refreshTimer: null
};

/* 
   INIT
    */
/**
 * TRADELINK  MERCHANT AUTH (replacement for merchant.js auth section)
 *
 * Identical logic to seller_auth_new.js but role = "merchant".
 * Notifications completely removed.
 */

/* 
   INIT
    */
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() {
    if (window.firebaseAuth) {
      window.firebaseAuth.onAuthStateChanged(function(fbUser) {
        if (fbUser) {
          fbUser.getIdToken().then(function(idToken) {
            return apiPost('auth/login', { firebase_token: idToken, role: 'merchant' });
          }).then(function(res) {
            if (res.data && res.data.success) {
              var user = res.data.user;
              if (user.id && user.id.charAt(0) === 'S') {
                showLogin();
                _showLoginError(' This email is a <strong>Seller</strong> account. <a href="../seller-portal/index.html" style="color:var(--brand-main);font-weight:600;">Go to Seller Portal </a>');
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

  apiPost('auth/login-email', { email: email, password: password, role: 'merchant' })
    .then(function(res) {
      btn.textContent = 'Enter merchant workspace';
      btn.disabled    = false;

      if (!res.data) {
        _showLoginError('Login failed. Is the backend server running?');
        return;
      }

      if (res.data.success && res.data.custom_token) {
        return window.firebaseAuth.signInWithCustomToken(res.data.custom_token)
          .then(function() { _loginSuccess(res.data.user); })
          .catch(function() { _loginSuccess(res.data.user); });
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
    .catch(function() {
      btn.textContent = 'Enter merchant workspace';
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
      return apiPost('auth/login', { firebase_token: idToken, role: 'merchant' });
    })
    .then(function(res) {
      _resetGoogleBtn();
      if (!res.data) { _showLoginError('Login failed. Server not responding.'); return; }

      if (res.data.success) {
        var user = res.data.user;
        if (user.id && user.id.charAt(0) === 'S') {
          _showLoginError(' This Google account is a <strong>Seller</strong>. <a href="../seller-portal/index.html" style="color:var(--brand-main);font-weight:600;">Go to Seller Portal </a>');
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
    title: 'Complete Your Buyer Profile',
    sub: 'One last step — no OTP needed for Google accounts',
    badge: 'Google Sign-In', badgeClass: 'active',
    bodyHTML:
      '<div style="background:rgba(155,195,255,0.08);border:1px solid rgba(155,195,255,0.22);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--info);">' +
        ' Google account verified — no OTP needed. Just fill in a few details.' +
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
        '<label class="login-label">Company Name <span style="color:var(--text-3);font-weight:400">(optional)</span></label>' +
        '<input class="form-control" type="text" id="greg-biz" placeholder="Your company or business name">' +
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
      '<button class="btn primary" id="greg-submit-btn" onclick="submitGoogleRegistration()">Start Buying </button>'
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
    btn.textContent = 'Start Buying '; btn.disabled = false;
    return;
  }

  fbUser.getIdToken()
    .then(function(idToken) {
      return apiPost('auth/register', {
        firebase_token: idToken,
        email:          fbUser.email,
        name:           name,
        role:           'merchant',
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
      return apiPost('auth/login', { firebase_token: idToken, role: 'merchant' });
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
      btn.textContent = 'Start Buying '; btn.disabled = false;
    });
}

function handleRegister(prefillEmail) {
  openModal({
    title: 'Create Buyer Account',
    sub: 'Join TradeLink  Buy Direct. Save More.',
    badge: 'Free', badgeClass: 'active',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Full Name <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="reg-name" placeholder="Your full name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Company Name <span style="color:var(--text-3);font-weight:400">(optional)</span></label>' +
        '<input class="form-control" type="text" id="reg-biz" placeholder="Your company or business">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Email <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="email" id="reg-email" placeholder="you@company.com" value="' + escapeHtml(prefillEmail || '') + '">' +
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

  apiPost('auth/send-otp', {
    email:        email,
    password:     password,
    name:         name,
    role:         'merchant',
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
    div.style.cssText = 'margin-top:16px;padding:16px;background:rgba(155,195,255,0.08);border:1.5px solid rgba(155,195,255,0.24);border-radius:10px;';
    div.innerHTML =
      '<div style="font-size:13px;color:var(--info);margin-bottom:10px;">' +
        ' OTP sent to <strong>' + escapeHtml(email) + '</strong>. Check your inbox (and spam folder).' +
        (devNote ? '<br><span style="color:#d97706;font-size:12px;"> Dev mode: ' + escapeHtml(devNote) + '</span>' : '') +
      '</div>' +
      '<label style="font-size:12px;font-weight:500;color:var(--text-2);display:block;margin-bottom:5px;">Enter 6-digit OTP</label>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="otp-input" type="text" maxlength="6" inputmode="numeric" pattern="[0-9]*" ' +
          'style="flex:1;padding:12px 14px;border:1.5px solid rgba(155,195,255,0.24);border-radius:8px;font-size:20px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;" ' +
          'placeholder="000000" onkeydown="if(event.key===\'Enter\')verifyOTP(\'' + escapeHtml(email) + '\')">' +
        '<button class="btn primary" onclick="verifyOTP(\'' + escapeHtml(email) + '\')">Verify </button>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:12px;color:var(--text-3);">' +
        'Didn\'t receive it ? <a href="#" onclick="resendOTP(\'' + escapeHtml(email) + '\',\'merchant\');return false;" style="color:var(--brand-main);">Resend OTP</a>' +
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

      var afterLogin = function() {
        var fbUser = window.firebaseAuth.currentUser;
        var tokenPromise = fbUser ? fbUser.getIdToken() : Promise.resolve(null);
        tokenPromise.then(function(idToken) {
          var loginBody = idToken
            ? { firebase_token: idToken, role: 'merchant' }
            : { email: email, role: 'merchant' };
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
          .then(afterLogin).catch(afterLogin);
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
  apiPost('auth/resend-otp', { email: email, role: role || 'merchant' }).then(function(res) {
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
   FORGOT PASSWORD
    */
function showForgotPassword() {
  openModal({
    title: 'Reset Password',
    sub: 'Enter your email. We\'ll send a 6-digit OTP.',
    badge: 'Secure', badgeClass: 'info',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Your registered email</label>' +
        '<input class="form-control" type="email" id="forgot-email" placeholder="you@company.com">' +
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

  if (!email) { _showForgotMsg(msgEl, 'Please enter your email.', false); return; }

  btn.textContent = 'Sending...';
  btn.disabled    = true;

  apiPost('auth/forgot-password', { email: email, role: 'merchant' })
    .then(function(res) {
      btn.textContent = 'Send OTP ';
      btn.disabled    = false;

      if (res.data && res.data.wrong_portal) {
        _showForgotMsg(msgEl, res.data.detail || 'This email is in a different portal.', false);
        return;
      }

      var body = document.getElementById('modal-body');
      if (body) {
        body.innerHTML =
          '<div style="background:rgba(155,195,255,0.08);border:1px solid rgba(155,195,255,0.22);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--info);">' +
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
          '<div id="reset-msg" style="display:none;padding:10px 14px;border-radius:8px;font-size:13px;"></div>' +
          '<div style="font-size:12px;color:var(--text-3);margin-top:8px;">' +
            'Didn\'t receive it ? <a href="#" onclick="resendForgotOTP(\'' + escapeHtml(email) + '\',\'merchant\');return false;" style="color:var(--brand-main);">Resend OTP</a>' +
          '</div>';

        var foot = document.querySelector('#modal-overlay .modal-footer');
        if (foot) {
          foot.innerHTML =
            '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
            '<button class="btn primary" id="reset-btn" onclick="submitResetPassword(\'' + escapeHtml(email) + '\',\'merchant\')">Reset Password </button>';
        }
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

  if (!otp || otp.length !== 6) { _showForgotMsg(msgEl, 'Please enter the 6-digit OTP.', false); return; }
  if (pass1.length < 6)         { _showForgotMsg(msgEl, 'Password must be at least 6 characters.', false); return; }
  if (pass1 !== pass2)          { _showForgotMsg(msgEl, 'Passwords do not match.', false); return; }

  btn.textContent = 'Resetting...';
  btn.disabled    = true;

  apiPost('auth/reset-password', { email: email, otp: otp, new_password: pass1, role: role })
    .then(function(res) {
      btn.textContent = 'Reset Password ';
      btn.disabled    = false;
      if (res.data && res.data.success) {
        _showForgotMsg(msgEl, ' Password reset! You can now log in.', true);
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
    if (res.data && res.data.success !== false) toast('New OTP sent to ' + email, 'success');
  });
}

/* 
   LOGOUT
    */
function handleLogout() {
  AppState.user = null;
  localStorage.removeItem('tl_merchant_user');
  if (window.firebaseAuth) window.firebaseAuth.signOut();
  disconnectRealtime();
  showLogin();
}

/* 
   SHARED LOGIN SUCCESS
    */
function _loginSuccess(user) {
  AppState.user = user;
  localStorage.setItem('tl_merchant_user', JSON.stringify(user));
  window.TL_USER_ROLE = 'merchant';
  showApp(user);
  initRealtime(user);
  loadDashboardStats();
  loadMarketplace();
}

/* 
   HELPERS
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
  el.style.color      = success ? 'var(--success)'       : 'var(--danger)';
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
      '<label class="login-label">Company / Business Name</label>' +
      '<input class="form-control" type="text" id="reg-company" placeholder="Your company (optional)">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="login-label">Email <span style="color:var(--danger)">*</span></label>' +
      '<input class="form-control" type="email" id="reg-email" placeholder="you@company.com" value="' + (prefillEmail || '') + '">' +
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
    '<div id="reg-error" class="login-error"></div>';

  openModal({
    title: 'Create Merchant Account',
    sub: 'Source directly from producers at the best price.',
    badge: 'Free', badgeClass: 'active',
    bodyHTML: body,
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="reg-submit-btn" onclick="submitRegistration()">Create Account </button>'
  });
}

function submitRegistration() {
  var name     = document.getElementById('reg-name').value.trim();
  var company  = document.getElementById('reg-company') ? document.getElementById('reg-company').value.trim() : '';
  var email    = document.getElementById('reg-email').value.trim();
  var password = document.getElementById('reg-password').value;
  var phone    = document.getElementById('reg-phone') ? document.getElementById('reg-phone').value.trim() : '';
  var city     = document.getElementById('reg-city')  ? document.getElementById('reg-city').value.trim()  : '';
  var btn      = document.getElementById('reg-submit-btn');

  if (!name)               { showRegError('Full name is required.');                  return; }
  if (!email)              { showRegError('Email is required.');                       return; }
  if (password.length < 6) { showRegError('Password must be at least 6 characters.'); return; }

  document.getElementById('reg-error').classList.remove('show');
  btn.textContent = 'Sending OTP...';
  btn.disabled = true;

  function getFirebaseTokenAndSendOTP(fbUser) {
    return fbUser.getIdToken().then(function(idToken) {
      return apiPost('auth/send-otp', {
        firebase_token: idToken,
        email:          fbUser.email || email,
        name:           name,
        role:           'merchant',
        phone:          phone,
        city:           city,
        company_name:   company,
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
      showOTPInput(email, res.data.dev_note || null);
    });
  }

  var currentUser = window.firebaseAuth.currentUser;
  if (currentUser && currentUser.email === email) {
    getFirebaseTokenAndSendOTP(currentUser).catch(function(err) {
      showRegError(err.message || 'Failed.');
      btn.textContent = 'Create Account ';
      btn.disabled = false;
    });
    return;
  }

  window.firebaseAuth.createUserWithEmailAndPassword(email, password)
    .then(function(uc) { return getFirebaseTokenAndSendOTP(uc.user); })
    .catch(function(err) {
      if (err.code === 'auth/email-already-in-use') {
        window.firebaseAuth.signInWithEmailAndPassword(email, password)
          .then(function(uc) {
            return uc.user.getIdToken().then(function(idToken) {
              return apiPost('auth/login', { firebase_token: idToken, role: 'merchant' })
                .then(function(lr) {
                  if (lr.data && lr.data.success) {
                    closeModalDirect();
                    AppState.user = lr.data.user;
                    localStorage.setItem('tl_merchant_user', JSON.stringify(lr.data.user));
                    window.TL_USER_ROLE = 'merchant';
                    showApp(lr.data.user);
                    initRealtime(lr.data.user);
                    loadDashboardStats();
                    loadMarketplace();
                    toast('Welcome back, ' + lr.data.user.name + '!', 'success');
                  } else {
                    return getFirebaseTokenAndSendOTP(uc.user);
                  }
                });
            });
          })
          .catch(function() {
            showRegError('An account with this email exists. Enter the correct password to also create a merchant account.');
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

function showOTPInput(email, devNote) {
  var foot = document.querySelector('#modal-overlay .modal-footer');
  var body = document.getElementById('modal-body');
  if (!foot || !body) return;

  var otpSection = document.getElementById('otp-section');
  if (!otpSection) {
    var div = document.createElement('div');
    div.id = 'otp-section';
    div.style.cssText = 'margin-top:16px;padding:16px;background:rgba(155,195,255,0.08);border:1.5px solid rgba(155,195,255,0.24);border-radius:10px;';
    div.innerHTML =
      '<div style="font-size:13px;color:var(--info);margin-bottom:10px;">' +
        ' OTP sent to <strong>' + email + '</strong>. Check your inbox.' +
        (devNote ? '<br><span style="color:#d97706;font-size:12px;"> Dev: ' + devNote + '</span>' : '') +
      '</div>' +
      '<label style="font-size:12px;font-weight:500;color:var(--text-2);display:block;margin-bottom:5px;">Enter 6-digit OTP</label>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="otp-input" type="text" maxlength="6" inputmode="numeric" ' +
          'style="flex:1;padding:12px 14px;border:1.5px solid rgba(155,195,255,0.24);border-radius:8px;font-size:20px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;" ' +
          'placeholder="000000" onkeydown="if(event.key===\'Enter\')verifyOTP(\''+email+'\')">' +
        '<button class="btn primary" onclick="verifyOTP(\'' + email + '\')" style="white-space:nowrap;">Verify </button>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:12px;color:var(--text-3);">' +
        'Didn\'t receive it ? <a href="#" onclick="resendOTP(\'' + email + '\');return false;" style="color:var(--brand-main);">Resend</a>' +
      '</div>' +
      '<div id="otp-error" style="color:#dc2626;font-size:13px;margin-top:6px;display:none;"></div>';
    if (body) body.appendChild(div);
  }
  foot.innerHTML = '<button class="btn" onclick="closeModalDirect()">Cancel</button>';
  setTimeout(function() { var i=document.getElementById('otp-input'); if(i) i.focus(); }, 100);
}

function verifyOTP(email) {
  var otp = document.getElementById('otp-input') ? document.getElementById('otp-input').value.trim() : '';
  var errEl = document.getElementById('otp-error');
  if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    errEl.textContent = 'Please enter the 6-digit code from your email.';
    errEl.style.display = 'block'; return;
  }
  var btn = document.querySelector('#otp-section .btn.primary');
  if (btn) { btn.textContent = 'Verifying...'; btn.disabled = true; }
  errEl.style.display = 'none';

  apiPost('auth/verify-otp', { email: email, otp: otp })
    .then(function(res) {
      if (btn) { btn.textContent = 'Verify '; btn.disabled = false; }
      if (!res.data || !res.data.success) {
        errEl.textContent = (res.data && res.data.detail) || 'Wrong OTP. Try again.';
        errEl.style.display = 'block'; return;
      }
      var fbUser = window.firebaseAuth.currentUser;
      if (!fbUser) { errEl.textContent = 'Session expired. Refresh and try again.'; errEl.style.display='block'; return; }
      fbUser.getIdToken().then(function(idToken) {
        return apiPost('auth/login', { firebase_token: idToken, role: 'merchant' });
      }).then(function(lr) {
        if (lr.data && lr.data.success) {
          closeModalDirect();
          AppState.user = lr.data.user;
          localStorage.setItem('tl_merchant_user', JSON.stringify(lr.data.user));
          window.TL_USER_ROLE = 'merchant';
          showApp(lr.data.user);
          initRealtime(lr.data.user);
          loadDashboardStats();
          loadMarketplace();
          toast('Welcome to TradeLink!  Email verified!', 'success', 5000);
        } else {
          errEl.textContent = 'Account created but login failed. Refresh and log in.';
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

function resendOTP(email) {
  apiPost('auth/resend-otp', { email: email }).then(function(res) {
    if (res.data && res.data.success) {
      toast('New OTP sent to ' + email, 'success');
    } else {
      toast('Could not resend. Start registration again.', 'danger');
    }
  });
}
function showRegError(msg) {
  var el = document.getElementById('reg-error');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

function handleLogout() {
  AppState.user = null;
  localStorage.removeItem('tl_merchant_user');
  if (AppState.refreshTimer) clearInterval(AppState.refreshTimer);
  if (window.firebaseAuth) window.firebaseAuth.signOut();
  disconnectRealtime();
  showLogin();
}
/* 
   MARKETPLACE STATS
    */

function loadDashboardStats() {
  ['mkt-live-count','mkt-active-bids','mkt-deals-won','mkt-total-spent'].forEach(setStatLoading);

  apiGet('merchant/stats', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) {
        ['mkt-live-count','mkt-active-bids','mkt-deals-won','mkt-total-spent'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el) { el.classList.remove('loading'); el.textContent = ''; }
        });
        return;
      }
      var d = res.data;
      setStatValue('mkt-live-count',   d.live_listings || '0');
      setStatValue('mkt-active-bids',  d.active_bids   || '0');
      setStatValue('mkt-deals-won',    d.deals_won     || '0');
      setStatValue('mkt-total-spent',  formatINRShort(d.total_spent || 0));

      // Update nav badges
      var bidBadge = document.getElementById('nav-badge-bids');
      if (bidBadge) bidBadge.textContent = d.active_bids || '0';
      var watchBadge = document.getElementById('nav-badge-watchlist');
      if (watchBadge) watchBadge.textContent = d.watchlist_count || '0';
    });
}

/* 
   MARKETPLACE  BROWSE LISTINGS
   Paginated grid of listing cards.
   All data from API, no hardcoded content.
    */

var mktDebounceTimer = null;

function debouncedLoadMarketplace() {
  clearTimeout(mktDebounceTimer);
  mktDebounceTimer = setTimeout(function() {
    AppState.marketplacePage = 1;
    loadMarketplace();
  }, 400);
}

function setChip(el, category) {
  document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  AppState.selectedChip = category;
  // Also update the select filter to match
  var sel = document.getElementById('mkt-category');
  if (sel) sel.value = category;
  AppState.marketplacePage = 1;
  loadMarketplace();
}

function loadMarketplace(page) {
  if (page) AppState.marketplacePage = page;

  var grid = document.getElementById('marketplace-grid');
  if (grid) {
    // Show skeleton cards
    grid.innerHTML = [1,2,3,4,5,6].map(function() {
      return '<div class="listing-card" style="height:320px;background:var(--gray-100);animation:shimmer 1.4s infinite;border-radius:var(--r-lg);"></div>';
    }).join('');
  }

  var params = {
    page:     AppState.marketplacePage,
    limit:    AppState.PAGE_SIZE,
    search:   document.getElementById('mkt-search').value.trim(),
    category: document.getElementById('mkt-category').value || AppState.selectedChip,
    state:    document.getElementById('mkt-state').value,
    sort:     document.getElementById('mkt-sort').value,
    status:   'active'   // marketplace always shows only active listings
  };

  apiGet('marketplace/listings', params).then(function(res) {
    if (!grid) return;

    if (!res.data || !res.data.rows) {
      grid.innerHTML = '<div style="grid-column:1/-1;"><div class="empty-state">' +
        '<div class="empty-icon"></div>' +
        '<div class="empty-title">Backend not connected</div>' +
        '<div class="empty-sub">Complete Step 2 to see live marketplace data.</div>' +
        '</div></div>';
      return;
    }

    if (res.data.rows.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;"><div class="empty-state">' +
        '<div class="empty-icon"></div>' +
        '<div class="empty-title">No listings found</div>' +
        '<div class="empty-sub">Try changing your filters or check back soon.</div>' +
        '</div></div>';
      return;
    }

    grid.innerHTML = res.data.rows.map(function(listing) {
      return buildListingCard(listing);
    }).join('');

    // Attach click handlers
    grid.querySelectorAll('.listing-card').forEach(function(card) {
      var id = card.dataset.listingId;
      if (id) card.addEventListener('click', function() { openListingModal(id); });
    });

    // Pagination
    var pager = createPager(AppState.PAGE_SIZE, loadMarketplace);
    window['marketplace-pagination_pager'] = pager;
    pager.render('marketplace-pagination', AppState.marketplacePage, res.data.total);
  });
}

/**
 * buildListingCard(listing)  HTML string
 * Called for each listing from the API.
 * listing = { id, title, category, seller_name, seller_rating, city, state,
 *             quantity, unit, min_price, top_bid, bid_count, expires_at,
 *             photo_url, description }
 */
function buildListingCard(listing) {
  var categoryIcon = {
    'Agriculture / Farm Produce':  'AG',
    'Manufacturing / Industrial':  'MF',
    'Textiles & Fabric':           'TX',
    'Food & Processed':            'FD',
    'Handicrafts & Artisans':      'HC',
    'Raw Materials':               'RM',
    'Electronics & Components':    'EL',
  }[listing.category] || 'OT';

  var imgHtml = listing.photo_url
    ? '<img src="' + escapeHtml(listing.photo_url) + '" alt="' + escapeHtml(listing.title) + '" loading="lazy">'
    : categoryIcon;

  var stars = Number(listing.seller_rating || 0).toFixed(1) + '/5 rating';

  var currentBid = listing.top_bid || listing.min_price;
  var timeLeft   = countdownTo(listing.expires_at);
  var isExpiringSoon = listing.expires_at && (new Date(listing.expires_at) - Date.now() < 3600000);

  return '<div class="listing-card" data-listing-id="' + escapeHtml(listing.id) + '">' +
    '<div class="listing-card-img">' +
      imgHtml +
      '<div class="listing-card-timer" style="' + (isExpiringSoon ? 'background:rgba(220,38,38,.8)' : '') + '">' +
        'Closing in ' + timeLeft +
      '</div>' +
    '</div>' +
    '<div class="listing-card-body">' +
      '<div class="listing-card-category">' + categoryIcon + ' ' + escapeHtml(listing.category || 'Other') + '</div>' +
      '<div class="listing-card-title">' + escapeHtml(listing.title) + '</div>' +
      '<div class="listing-card-seller">by <strong>' + escapeHtml(listing.seller_name) + '</strong>' +
        '  <span class="stars">' + stars + '</span>' +
        '  ' + escapeHtml(listing.city || '') +
      '</div>' +
      '<div class="listing-card-meta">' +
        '<div class="meta-item"><strong>' + formatQty(listing.quantity, listing.unit) + '</strong>Available</div>' +
        '<div class="meta-item"><strong>' + escapeHtml(String(listing.min_price)) + '/' + escapeHtml(listing.unit || '') + '</strong>Min Price</div>' +
        '<div class="meta-item"><strong>' + (listing.bid_count || 0) + '</strong>Bids placed</div>' +
        '<div class="meta-item"><strong>' + escapeHtml(listing.state || '') + '</strong>Location</div>' +
      '</div>' +
    '</div>' +
    '<div class="listing-card-footer">' +
      '<div>' +
        '<div class="bid-label">CURRENT TOP BID</div>' +
        '<div class="current-bid">' + escapeHtml(String(currentBid)) + '/' + escapeHtml(listing.unit || '') + '</div>' +
      '</div>' +
      '<button class="btn primary sm" onclick="event.stopPropagation();openListingModal(\'' + escapeHtml(listing.id) + '\')">Review bid</button>' +
    '</div>' +
  '</div>';
}

/* 
   LISTING DETAIL + BID PLACEMENT MODAL
    */

function openListingModal(listingId) {
  // Step 4: subscribe to real-time bid updates for this listing
  joinListing(listingId);

  openModal({
    title: 'Loading...',
    sub: 'Listing #' + listingId,
    badge: '...', badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>',
    wide: true
  });

  apiGet('listing/' + listingId, { viewer: 'merchant', merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) {
        openModal({
          title: 'Listing #' + listingId, sub: 'Error', badge: 'Error', badgeClass: 'danger',
          bodyHTML: '<p style="color:var(--gray-500)">Backend not connected. Complete Step 2.</p>',
          wide: true
        });
        return;
      }
      var listing = res.data;
      renderListingModal(listing);
    });
}

function renderListingModal(listing) {
  var currentBid = listing.top_bid || listing.min_price;
  var myBid = listing.my_bid || null;
  var isLeading = myBid && myBid.price_per_unit >= currentBid;

  // Bid placement form
  var bidFormHtml =
    '<div class="bid-form">' +
      '<div class="bid-form-title">Place Your Bid</div>' +
      (myBid ? '<div class="banner info" style="margin-bottom:12px;"><span class="banner-icon">' +
        (isLeading ? 'TOP' : 'BID') + '</span><span class="banner-text">' +
        (isLeading ? 'You are currently the highest bidder at ' + myBid.price_per_unit + '/' + listing.unit + '!' :
          'You were outbid! Your last bid was ' + myBid.price_per_unit + '. Increase your bid to stay in the race.') +
        '</span></div>' : '') +
      '<div class="bid-input-row">' +
        '<div class="bid-input-wrap">' +
          '<label>Your Bid Price (per ' + escapeHtml(listing.unit) + ')</label>' +
          '<input type="number" class="bid-input" id="modal-bid-price" ' +
            'placeholder="Min: ' + listing.min_price + '" ' +
            'min="' + listing.min_price + '" ' +
            'step="1" ' +
            'oninput="updateBidCalc(\'' + escapeHtml(listing.unit) + '\',' + listing.quantity + ')">' +
          '<div class="bid-calc" id="bid-calc-display">Enter amount above to see total value</div>' +
        '</div>' +
        '<button class="btn primary lg" onclick="submitBid(\'' + escapeHtml(listing.id) + '\',' + listing.min_price + ',' + listing.quantity + ')">Place Bid</button>' +
      '</div>' +
    '</div>';

  // Bids list (sorted by price desc  reverse auction means highest bid wins)
  var bidsHtml = '';
  if (!listing.bids || listing.bids.length === 0) {
    bidsHtml = '<div style="text-align:center;padding:16px;color:var(--gray-400);font-size:13px;">No bids yet. Be the first!</div>';
  } else {
    var rankEmoji = ['01','02','03'];
    bidsHtml = listing.bids.map(function(bid, i) {
      var isMe = bid.merchant_id === (AppState.user && AppState.user.id);
      return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--gray-100);">' +
        '<span style="font-size:18px;width:24px;">' + (rankEmoji[i] || '#' + (i+1)) + '</span>' +
        '<div style="flex:1;">' +
          '<span style="font-size:13.5px;font-weight:500;color:var(--gray-900);">' +
            (isMe ? 'You' : escapeHtml(bid.buyer_name)) +
          '</span>' +
          '<span style="font-size:11px;color:var(--gray-400);margin-left:8px;">' + timeAgo(bid.created_at) + '</span>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-family:var(--font-display);font-size:17px;font-weight:700;color:' + (i===0 ? 'var(--brand-main)':'var(--gray-500)') + '">' +
            '' + escapeHtml(String(bid.price_per_unit)) + '/' + escapeHtml(listing.unit) +
          '</div>' +
          '<div style="font-size:11.5px;color:var(--gray-400);">' + formatINR(bid.total_amount) + ' total</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  var body =
    '<div class="grid-2 mb-16">' +
      '<div class="detail-grid" style="margin-bottom:0;">' +
        '<div class="detail-field"><label>Total Quantity</label><div class="detail-value">' + formatQty(listing.quantity, listing.unit) + '</div></div>' +
        '<div class="detail-field"><label>Min Price</label><div class="detail-value">' + listing.min_price + '/' + listing.unit + '</div></div>' +
        '<div class="detail-field"><label>Location</label><div class="detail-value">' + escapeHtml(listing.city || '') + ', ' + escapeHtml(listing.state || '') + '</div></div>' +
        '<div class="detail-field"><label>Auction Ends In</label><div class="detail-value" style="color:var(--warning)">' + countdownTo(listing.expires_at) + '</div></div>' +
      '</div>' +
      '<div>' +
        '<div style="background:var(--gray-50);border-radius:var(--r);padding:14px;font-size:13px;color:var(--gray-600);line-height:1.6;">' +
          '<strong style="display:block;margin-bottom:4px;">About this listing:</strong>' +
          escapeHtml(listing.description || '') +
        '</div>' +
      '</div>' +
    '</div>' +
    bidFormHtml +
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--gray-100);">' +
      'All Bids (' + (listing.bids ? listing.bids.length : 0) + ') - Highest First' +
    '</div>' +
    bidsHtml;

  openModal({
    title: listing.title,
    sub: 'by ' + escapeHtml(listing.seller_name || '') + '  #' + listing.id,
    badge: listing.status, badgeClass: listing.status === 'active' ? 'active' : 'inactive',
    bodyHTML: body,
    footerHTML:
      '<button class="btn" onclick="toggleWatchlist(\'' + listing.id + '\',this)">' +
        (listing.in_watchlist ? 'Watching' : 'Add to watchlist') +
      '</button>' +
      '<button class="btn" onclick="closeModalDirect()">Close</button>',
    wide: true
  });
}

/**
 * updateBidCalc  shows total value as user types
 */
function updateBidCalc(unit, quantity) {
  var price  = parseFloat(document.getElementById('modal-bid-price').value) || 0;
  var total  = price * quantity;
  var calcEl = document.getElementById('bid-calc-display');
  if (calcEl) {
    calcEl.innerHTML = price > 0
      ? 'Total value: <strong>' + formatINR(total) + '</strong> for ' + formatQty(quantity, unit)
      : 'Enter amount above to see total value';
  }
}

/**
 * submitBid  validates and sends bid to API
 * Button is disabled immediately on click to prevent duplicate submissions.
 */
function submitBid(listingId, minPrice, quantity) {
  var priceEl = document.getElementById('modal-bid-price');
  var price   = parseFloat(priceEl && priceEl.value);

  // Find and disable the bid button immediately to prevent double-click
  var bidBtn = document.querySelector('.modal-footer .btn.primary, #modal-body .btn.primary');
  // Try to find by text content
  var allBtns = document.querySelectorAll('#modal-body button, #modal-footer button');
  var placeBidBtn = null;
  allBtns.forEach(function(b) {
    if (b.textContent.trim().indexOf('Place Bid') !== -1 ||
        b.textContent.trim().indexOf('Placing') !== -1) {
      placeBidBtn = b;
    }
  });

  if (!price || price <= 0) {
    toast('Enter a valid bid price.', 'warning'); return;
  }
  if (price < minPrice) {
    toast('Bid must be at least ' + minPrice + ' per unit (seller\'s minimum).', 'warning'); return;
  }

  // Disable button right away  prevents clicking twice
  if (placeBidBtn) {
    placeBidBtn.disabled    = true;
    placeBidBtn.textContent = 'Placing bid...';
  }

  apiPost('bid/place', {
    listing_id:     listingId,
    merchant_id:    AppState.user && AppState.user.id,
    price_per_unit: price,
    total_amount:   price * quantity   // INR value  NOT paise. Backend converts to paise.
  }).then(function(res) {
    if (res.data && res.data.success) {
      toast('Bid placed at ' + price + '/unit. Total value ' + formatINR(price * quantity) + '.', 'success');
      closeModalDirect();
      loadMarketplace();
      loadDashboardStats();
    } else {
      // Re-enable on failure so user can try again
      if (placeBidBtn) {
        placeBidBtn.disabled    = false;
        placeBidBtn.textContent = 'Place Bid';
      }
      toast((res.data && res.data.detail) || (res.data && res.data.message) || 'Bid failed. Try again.', 'danger');
    }
  }).catch(function() {
    if (placeBidBtn) {
      placeBidBtn.disabled    = false;
      placeBidBtn.textContent = 'Place Bid';
    }
    toast('Network error. Check if server is running.', 'danger');
  });
}

/* 
   WATCHLIST
    */

function toggleWatchlist(listingId, btn) {
  var isWatching = btn.textContent.indexOf('Watching') !== -1;

  apiPost('watchlist/toggle', {
    merchant_id: AppState.user && AppState.user.id,
    listing_id: listingId,
    action: isWatching ? 'remove' : 'add'
  }).then(function(res) {
    if (res.data && res.data.success) {
      btn.textContent = isWatching ? 'Add to watchlist' : 'Watching';
      toast(isWatching ? 'Removed from watchlist.' : 'Added to watchlist. We will alert you when the bid position changes.', 'success');
    }
  });
}

function loadWatchlist() {
  var grid = document.getElementById('watchlist-grid');
  if (grid) grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="spinner"></div></div>';

  apiGet('merchant/watchlist', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!grid) return;
      if (!res.data || !res.data.rows || res.data.rows.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;"><div class="empty-state">' +
          '<div class="empty-icon"></div>' +
          '<div class="empty-title">' + (!res.data ? 'Backend not connected' : 'Watchlist empty') + '</div>' +
          '<div class="empty-sub">' + (!res.data ? 'Complete Step 2.' : 'Click  Watch on any listing to add it here.') + '</div>' +
          '</div></div>';
        return;
      }
      grid.innerHTML = res.data.rows.map(buildListingCard).join('');
      grid.querySelectorAll('.listing-card').forEach(function(card) {
        var id = card.dataset.listingId;
        if (id) card.addEventListener('click', function() { openListingModal(id); });
      });
    });
}

/* 
   MY BIDS SCREEN
    */

function loadMyBids(page) {
  if (page) AppState.myBidsPage = page;
  showLoadingRows('my-bids-tbody', 8, 5);

  apiGet('merchant/bids', {
    merchant_id: AppState.user && AppState.user.id,
    page:   AppState.myBidsPage,
    limit:  AppState.TABLE_SIZE,
    status: document.getElementById('bids-status-filter').value
  }).then(function(res) {
    var tbody = document.getElementById('my-bids-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">Backend not connected</div>' +
        '<div class="empty-sub">Complete Step 2.</div></div></td></tr>';
      return;
    }

    if (res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">No bids yet</div>' +
        '<div class="empty-sub">Browse the marketplace to place your first bid.</div></div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(bid) {
      var bidStatus = bid.bid_status || bid.status || 'live';
      var rowClass = { won:'bid-won', outbid:'bid-outbid', live:'bid-live' }[bidStatus] || '';
      var isLeading = bidStatus === 'live' && !!bid.is_top_bid;
      var productTitle = bid.product_title || bid.listing_title || 'Listing unavailable';
      var sellerName = bid.seller_name || 'Seller pending';
      var unit = bid.unit || bid.listing_unit || 'unit';
      var totalAmount = bid.total_amount || bid.amount || 0;
      var topBid = bid.top_bid || bid.price_per_unit || '--';
      var expiresLabel = bid.expires_at ? countdownTo(bid.expires_at) : 'Closed';
      var openAction = bidStatus === 'won' && bid.deal_id
        ? 'openDealModal(\'' + escapeHtml(bid.deal_id) + '\')'
        : 'openListingModal(\'' + escapeHtml(bid.listing_id) + '\')';
      var actionBtn = '';

      if (bidStatus === 'live') {
        actionBtn = '<button class="btn primary sm" onclick="event.stopPropagation();openListingModal(\'' + escapeHtml(bid.listing_id) + '\')">Update Bid</button>';
      } else if (bidStatus === 'won' && bid.payment_status === 'pay_pending') {
        actionBtn = '<button class="btn danger sm" onclick="event.stopPropagation();initiatePayment(\'' + escapeHtml(bid.deal_id) + '\',' + totalAmount + ')">Pay now</button>';
      } else if (bidStatus === 'won' && bid.deal_id) {
        actionBtn = '<button class="btn sm" onclick="event.stopPropagation();openDealModal(\'' + escapeHtml(bid.deal_id) + '\')">View deal</button>';
      } else {
        actionBtn = '<button class="btn sm" onclick="event.stopPropagation();openListingModal(\'' + escapeHtml(bid.listing_id) + '\')">View listing</button>';
      }

      return '<tr class="' + rowClass + '" onclick="' + openAction + '">' +
        '<td><span class="td-primary">' + escapeHtml(productTitle) + '</span></td>' +
        '<td>' + escapeHtml(sellerName) + '</td>' +
        '<td><strong>' + escapeHtml(String(bid.price_per_unit || '--')) + '/' + escapeHtml(unit) + '</strong></td>' +
        '<td>' + formatINR(totalAmount) + '</td>' +
        '<td>' + (isLeading
          ? '<strong style="color:var(--success)">' + escapeHtml(String(topBid)) + ' (You)</strong>'
          : escapeHtml(String(topBid))) + '</td>' +
        '<td style="color:var(--warning)">' + escapeHtml(String(expiresLabel)) + '</td>' +
        '<td>' + statusBadge(bidStatus) + '</td>' +
        '<td>' + actionBtn + '</td>' +
      '</tr>';
    }).join('');

    var pager = createPager(AppState.TABLE_SIZE, loadMyBids);
    pager.render('my-bids-pagination', AppState.myBidsPage, res.data.total);
  });
}

/* 
   MY DEALS SCREEN
    */

function loadMyDeals(page) {
  if (page) AppState.myDealsPage = page;
  showLoadingRows('my-deals-tbody', 8, 5);

  apiGet('merchant/deals', {
    merchant_id: AppState.user && AppState.user.id,
    page:   AppState.myDealsPage,
    limit:  AppState.TABLE_SIZE,
    status: document.getElementById('deals-status-filter').value
  }).then(function(res) {
    var tbody = document.getElementById('my-deals-tbody');
    if (!tbody) return;

    if (!res.data || !res.data.rows) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">Backend not connected</div>' +
        '</div></td></tr>';
      return;
    }

    if (res.data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">No deals yet</div>' +
        '<div class="empty-sub">Win an auction to see your first deal here.</div></div></td></tr>';
      return;
    }

    tbody.innerHTML = res.data.rows.map(function(deal) {
      var productTitle = deal.product_title || deal.listing_title || 'Deal item';
      var sellerName = deal.seller_name || 'Seller pending';
      var pickupCity = deal.pickup_city || '--';
      var actionBtn = '';
      if (deal.payment_status === 'pay_pending') {
        actionBtn = '<button class="btn danger sm" onclick="event.stopPropagation();initiatePayment(\'' + deal.id + '\',' + deal.amount + ')"> Pay Now</button>';
      } else if (deal.delivery_status === 'delivered' && !deal.buyer_confirmed) {
        actionBtn = '<button class="btn success sm" onclick="event.stopPropagation();confirmDelivery(\'' + deal.id + '\')"> Confirm</button>';
      } else {
        actionBtn = '<button class="btn sm" onclick="event.stopPropagation();openDealModal(\'' + deal.id + '\')">View</button>';
      }

      return '<tr onclick="openDealModal(\'' + escapeHtml(deal.id) + '\')">' +
        '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(deal.id) + '</td>' +
        '<td><span class="td-primary">' + escapeHtml(productTitle) + '</span></td>' +
        '<td>' + escapeHtml(sellerName) + '</td>' +
        '<td><strong>' + formatINR(deal.amount || 0) + '</strong></td>' +
        '<td>' + escapeHtml(pickupCity) + '</td>' +
        '<td>' + statusBadge(deal.delivery_status || 'confirmed') + '</td>' +
        '<td>' + statusBadge(deal.payment_status || 'pay_pending') + '</td>' +
        '<td>' + actionBtn + '</td>' +
      '</tr>';
    }).join('');

    var pager = createPager(AppState.TABLE_SIZE, loadMyDeals);
    pager.render('my-deals-pagination', AppState.myDealsPage, res.data.total);
  });
}

function openDealModal(dealId) {
  openModal({
    title: 'Loading...', sub: 'Deal #' + dealId, badge: '...', badgeClass: 'brand',
    bodyHTML: '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>',
    wide: true
  });

  apiGet('deal/' + dealId).then(function(res) {
    if (!res.data) {
      openModal({ title: 'Deal #' + dealId, sub: 'Error', badge: 'Error', badgeClass: 'danger',
        bodyHTML: '<p>Could not load deal details.</p>', wide: true });
      return;
    }

    var deal = res.data;
    var statusOrder = ['confirmed','paid','in_transit','delivered'];
    var currentIdx  = statusOrder.indexOf(deal.timeline_status);
    if (currentIdx < 0) currentIdx = 0;
    var sellerName = deal.seller_name || 'Seller pending';
    var productTitle = deal.product_title || deal.listing_title || 'Deal item';
    var amountValue = deal.amount || 0;
    var quantityText = deal.quantity ? formatQty(deal.quantity, deal.unit || 'unit') : '--';
    var pickupCity = deal.pickup_city || '--';
    var deliveryCity = deal.delivery_city || deal.deliver_to || '--';
    var paymentId = deal.razorpay_payment_id || 'Not generated yet';
    var transporter = deal.transporter_name || (deal.has_transport ? 'TradeLink Logistics' : 'Not assigned');
    var paymentBanner = deal.payment_status === 'pay_pending'
      ? 'Payment is still pending for this deal. Complete payment to move the order into escrow.'
      : 'Your payment is held in escrow. It will be released to the seller only after you confirm delivery.';

    var tlSteps = [
      { label:'Deal Confirmed',    sub: formatDate(deal.confirmed_at) || 'Pending' },
      { label:'Payment Completed', sub: deal.paid_at ? formatINR(amountValue) + ' in escrow' : 'Awaiting payment' },
      { label:'In Transit',        sub: deal.pickup_at ? 'Dispatched: ' + formatDate(deal.pickup_at) : 'Pending dispatch' },
      { label:'Delivered',         sub: deal.delivered_at ? formatDate(deal.delivered_at) : 'Pending' },
    ];

    var tlHtml = tlSteps.map(function(step, i) {
      var dotClass = i < currentIdx ? 'done' : (i === currentIdx ? 'active' : '');
      return '<div class="timeline-step">' +
        '<div class="tl-dot ' + dotClass + '"></div>' +
        '<div class="tl-title">' + step.label + '</div>' +
        '<div class="tl-sub">' + step.sub + '</div>' +
      '</div>';
    }).join('');

    var body =
      '<div class="detail-grid">' +
        '<div class="detail-field"><label>Deal Amount</label><div class="detail-value">' + formatINR(amountValue) + '</div></div>' +
        '<div class="detail-field"><label>Quantity</label><div class="detail-value">' + escapeHtml(quantityText) + '</div></div>' +
        '<div class="detail-field"><label>Pickup City</label><div class="detail-value">' + escapeHtml(pickupCity) + '</div></div>' +
        '<div class="detail-field"><label>Delivery City</label><div class="detail-value">' + escapeHtml(deliveryCity) + '</div></div>' +
        '<div class="detail-field"><label>Payment Status</label><div class="detail-value">' + statusBadge(deal.payment_status || 'pay_pending') + '</div></div>' +
        '<div class="detail-field"><label>Delivery Status</label><div class="detail-value">' + statusBadge(deal.delivery_status || 'confirmed') + '</div></div>' +
        '<div class="detail-field"><label>Payment ID</label><div class="detail-value" style="font-size:12px;">' + escapeHtml(paymentId) + '</div></div>' +
        '<div class="detail-field"><label>Transporter</label><div class="detail-value">' + escapeHtml(transporter) + '</div></div>' +
      '</div>' +
      '<div class="banner info" style="margin-bottom:16px;">' +
        '<span class="banner-icon"></span>' +
        '<span class="banner-text">' + escapeHtml(paymentBanner) + '</span>' +
      '</div>' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-bottom:10px;">Delivery Timeline</div>' +
      '<div class="timeline">' + tlHtml + '</div>' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-400);font-weight:600;margin-top:16px;margin-bottom:8px;">Live Transport Map Tracking</div>' +
      '<div id="merchant-deal-map" style="height:450px;width:100%;border-radius:16px;margin-bottom:16px;background:#0f172a;border:1px solid rgba(255,255,255,0.18);position:relative;z-index:1;overflow:hidden;"></div>';

    var footerHtml = '<button class="btn" onclick="closeModalDirect()">Close</button>';
    if (deal.payment_status === 'pay_pending') {
      footerHtml += '<button class="btn danger" onclick="initiatePayment(\'' + deal.id + '\',' + amountValue + ')">Complete payment</button>';
    } else if (deal.delivery_status === 'delivered' && !deal.buyer_confirmed) {
      footerHtml += '<button class="btn success" onclick="confirmDelivery(\'' + deal.id + '\')"> Confirm Delivery &amp; Release Payment</button>';
    }

    openModal({
      title: productTitle,
      sub: '#' + deal.id + '  Seller: ' + escapeHtml(sellerName),
      badge: deal.delivery_status || 'confirmed', badgeClass: deal.delivery_status === 'delivered' ? 'active' : 'pending',
      bodyHTML: body, footerHTML: footerHtml, wide: true
    });

    setTimeout(function() {
      var mapEl = document.getElementById('merchant-deal-map');
      if (!mapEl || !window.L) return;

      apiGet('shipping/track-by-deal/' + dealId).then(function(res) {
        if (!res.data || !res.data.tracking) return;
        var t = res.data.tracking;
        var pLat = t.pickup_lat || 19.0760;
        var pLng = t.pickup_lng || 72.8777;
        var dLat = t.delivery_lat || 28.6139;
        var dLng = t.delivery_lng || 77.2090;
        var cLat = t.current_lat || ((pLat + dLat)/2);
        var cLng = t.current_lng || ((pLng + dLng)/2);

        var map = L.map('merchant-deal-map').setView([cLat, cLng], 5);
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

/* 
   PAYMENTS  RAZORPAY TEST MODE
    */

/**
 * initiatePayment(dealId, amount)
 *
 * In Step 7, this will:
 * 1. Call backend to create a Razorpay order
 * 2. Open Razorpay checkout modal (TEST mode)
 * 3. On success, call backend to verify HMAC-SHA256 signature
 * 4. Mark deal as paid_at, move to escrow
 *
 * For now, shows the payment flow structure.
 */
function initiatePayment(dealId, amount) {
  openModal({
    title: 'Complete Payment', sub: 'Deal #' + dealId,
    badge: 'Razorpay (TEST)', badgeClass: 'warning',
    bodyHTML:
      '<div class="pay-card mb-16">' +
        '<div class="bid-label">AMOUNT TO PAY</div>' +
        '<div class="pay-amount">' + formatINR(amount) + '</div>' +
        '<div style="font-size:13px;color:var(--gray-500);margin-top:4px;">Held in escrow  released to seller after delivery confirmation</div>' +
        '<div class="escrow-badge" style="margin-top:10px;"> Protected by Escrow</div>' +
      '</div>' +
      '<div class="banner info">' +
        '<span class="banner-icon">i</span>' +
        '<span class="banner-text">Razorpay TEST mode is active. Use test card: <strong>4111 1111 1111 1111</strong>  Exp: any future  CVV: any</span>' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" onclick="openRazorpay(\'' + dealId + '\',' + amount + ')">Pay ' + formatINR(amount) + ' </button>',
    small: false
  });
}

/**
 * openRazorpay  integrates Razorpay Checkout SDK
 * Full integration in Step 7. Structure shown here.
 */
function openRazorpay(dealId, amount) {
  /**
   * STEP 5: Real Razorpay payment flow.
   *
   * Step 1: Call backend to create a Razorpay order
   * Step 2: Load Razorpay SDK if not already loaded
   * Step 3: Open the Razorpay checkout popup
   * Step 4: On payment success, verify signature with our backend
   * Step 5: Backend marks deal as paid, money goes into escrow
   */

  // Disable the Pay button to prevent double-clicking
  var payBtn = document.querySelector('.modal-footer .btn.primary');
  if (payBtn) { payBtn.disabled = true; payBtn.textContent = 'Opening payment...'; }

  // Step 1: Create Razorpay order on our backend
  apiPost('payment/create-order', {
    deal_id:     dealId,
    amount:      amount,
    merchant_id: AppState.user && AppState.user.id
  }).then(function(res) {
    if (!res.data || !res.data.order_id) {
      toast('Could not create payment order. Is the server running?', 'danger');
      if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Pay ' + formatINR(amount) + ' '; }
      return;
    }

    // Step 2: Load Razorpay SDK dynamically if not already loaded
    function loadRazorpaySDK(callback) {
      if (window.Razorpay) {
        callback(); // already loaded
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = callback;
      script.onerror = function() {
        toast('Could not load payment SDK. Check your internet connection.', 'danger');
      };
      document.head.appendChild(script);
    }

    loadRazorpaySDK(function() {
      // Step 3: Configure and open Razorpay checkout popup
      var options = {
        key:         res.data.razorpay_key_id,  // TEST key from backend
        amount:      res.data.amount_paise,      // already in paise from backend
        currency:    'INR',
        name:        'TradeLink',
        description: 'Deal #' + dealId,
        image:       'https://i.imgur.com/n5tjHFD.png',  // TradeLink logo
        order_id:    res.data.order_id,
        prefill: {
          name:    AppState.user ? AppState.user.name  : '',
          email:   AppState.user ? AppState.user.email : '',
          contact: AppState.user ? AppState.user.phone : ''
        },
        notes: { deal_id: dealId },
        theme: { color: '#1d4ed8' },

        // Step 4: Called by Razorpay after payment succeeds
        handler: function(paymentResponse) {
          // paymentResponse contains:
          //   razorpay_payment_id   the actual payment ID
          //   razorpay_order_id     our order ID
          //   razorpay_signature    HMAC-SHA256 signature to verify
          closeModalDirect();
          toast('Verifying payment...', 'info', 2000);
          verifyPayment(dealId, paymentResponse);
        },

        // Called if user closes the popup without paying
        modal: {
          ondismiss: function() {
            toast('Payment cancelled.', 'warning');
            if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Pay ' + formatINR(amount) + ' '; }
          }
        }
      };

      var rzp = new window.Razorpay(options);

      // Handle payment failure (card declined, etc.)
      rzp.on('payment.failed', function(response) {
        toast('Payment failed: ' + (response.error.description || 'Please try again.'), 'danger');
        if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Pay ' + formatINR(amount) + ' '; }
      });

      closeModalDirect();
      rzp.open();
    });
  }).catch(function() {
    toast('Payment error. Check if backend server is running.', 'danger');
    if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Pay ' + formatINR(amount) + ' '; }
  });
}

function verifyPayment(dealId, paymentResponse) {
  apiPost('payment/verify', {
    deal_id:              dealId,
    razorpay_payment_id:  paymentResponse.razorpay_payment_id,
    razorpay_order_id:    paymentResponse.razorpay_order_id,
    razorpay_signature:   paymentResponse.razorpay_signature
  }).then(function(res) {
    if (res.data && res.data.success) {
      toast('Payment successful!  Money held in escrow until delivery.', 'success');
      loadMyDeals();
      loadDashboardStats();
    } else {
      toast('Payment verification failed. Contact support with your payment ID.', 'danger');
    }
  });
}

/**
 * confirmDelivery  buyer confirms they received the goods
 * This triggers payout release to seller.
 */
function confirmDelivery(dealId) {
  openModal({
    title: 'Confirm Delivery ? ',
    sub: 'Deal #' + dealId,
    badge: 'Action Required', badgeClass: 'warning',
    bodyHTML: '<div style="text-align:center;padding:8px;">' +
      '<div style="font-size:38px;margin-bottom:12px;"></div>' +
      '<p style="font-size:15px;color:var(--gray-700);">Confirming delivery will <strong>release the payment to the seller</strong>. Only confirm if you have received the goods and they match the listing description.</p>' +
      '</div>',
    footerHTML: '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn success" onclick="submitDeliveryConfirm(\'' + dealId + '\')"> Yes, I received it</button>'
  });
}

function submitDeliveryConfirm(dealId) {
  apiPost('deal/confirm-delivery', {
    deal_id: dealId,
    merchant_id: AppState.user && AppState.user.id
  }).then(function(res) {
    if (res.data && res.data.success) {
      closeModalDirect();
      toast('Delivery confirmed! Payment released to seller.', 'success');
      loadMyDeals();
    } else {
      toast('Could not confirm delivery. Try again.', 'danger');
    }
  });
}

/* 
   PAYMENTS SCREEN
    */

function loadPayments(page) {
  if (page) AppState.paymentsPage = page;
  setStatLoading('pay-total-spent');
  setStatLoading('pay-in-escrow');
  setStatLoading('pay-pending');
  showLoadingRows('payments-tbody', 6, 5);

  apiGet('merchant/payments', {
    merchant_id: AppState.user && AppState.user.id,
    page: AppState.paymentsPage,
    limit: AppState.TABLE_SIZE
  }).then(function(res) {
    if (!res.data) {
      setStatValue('pay-total-spent', '');
      setStatValue('pay-in-escrow', '');
      setStatValue('pay-pending', '');
      return;
    }

    setStatValue('pay-total-spent',  formatINRShort(res.data.total_spent || 0));
    setStatValue('pay-in-escrow',    formatINRShort(res.data.in_escrow   || 0));
    setStatValue('pay-pending',      res.data.pending_count || '0');

    // Show pending section if there are unpaid deals
    var pendingSection = document.getElementById('pending-payments-section');
    var pendingList    = document.getElementById('pending-payments-list');
    if (res.data.pending_deals && res.data.pending_deals.length > 0) {
      if (pendingSection) pendingSection.style.display = 'block';
      if (pendingList) {
        pendingList.innerHTML = res.data.pending_deals.map(function(deal) {
          var deadline = new Date(deal.confirmed_at);
          deadline.setHours(deadline.getHours() + 24);
          return '<div class="pay-card" style="display:flex;align-items:center;gap:16px;margin-bottom:10px;">' +
            '<div style="flex:1;">' +
              '<div style="font-weight:500;">' + escapeHtml(deal.product_title) + '</div>' +
              '<div style="font-size:12px;color:var(--gray-500);">Pay before: ' + deadline.toLocaleString('en-IN') + '</div>' +
            '</div>' +
            '<div style="font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--brand-main);">' + formatINR(deal.amount) + '</div>' +
            '<button class="btn danger" onclick="initiatePayment(\'' + deal.id + '\',' + deal.amount + ')"> Pay Now</button>' +
          '</div>';
        }).join('');
      }
    } else {
      if (pendingSection) pendingSection.style.display = 'none';
    }

    var tbody = document.getElementById('payments-tbody');
    if (res.data.rows && res.data.rows.length > 0) {
      tbody.innerHTML = res.data.rows.map(function(pay) {
        return '<tr>' +
          '<td>' + formatDate(pay.created_at) + '</td>' +
          '<td style="font-size:11px;color:var(--gray-400)">#' + escapeHtml(pay.deal_id) + '</td>' +
          '<td>' + escapeHtml(pay.product_title) + '</td>' +
          '<td><strong>' + formatINR(pay.amount) + '</strong></td>' +
          '<td style="font-size:11px;color:var(--gray-500)">' + escapeHtml(pay.razorpay_payment_id || '') + '</td>' +
          '<td>' + statusBadge(pay.status) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">' +
        '<div class="empty-icon"></div><div class="empty-title">No payments yet</div></div></td></tr>';
    }
  });
}

/* 
   INVOICES
    */

function loadInvoices() {
  showLoadingRows('invoices-tbody', 7, 4);

  apiGet('merchant/invoices', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      var tbody = document.getElementById('invoices-tbody');
      if (!tbody) return;

      var rows = res.data && res.data.rows;
      if (!rows || rows.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="7"><div class="empty-state">' +
          '<div class="empty-icon"></div>' +
          '<div class="empty-title">' + (!res.data ? 'Backend not connected' : 'No invoices yet') + '</div>' +
          '<div class="empty-sub">Invoices appear after you complete a payment for a deal.</div>' +
          '</div></td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(function(inv) {
        return '<tr>' +
          '<td style="font-weight:600;color:var(--brand-main);">' + escapeHtml(inv.invoice_number) + '</td>' +
          '<td>' + (inv.created_at ? inv.created_at.substring(0,10) : '') + '</td>' +
          '<td style="font-size:11px;color:var(--gray-400);">#' + escapeHtml(inv.deal_id.substring(0,8)) + '</td>' +
          '<td style="font-weight:500;">' + escapeHtml(inv.product_title || '') + '</td>' +
          '<td style="font-weight:700;color:var(--brand-main);">' + formatINR(inv.amount) + '</td>' +
          '<td style="color:var(--gray-500);">' + formatINR(inv.gst_amount) + '</td>' +
          '<td>' +
            '<button class="btn sm" onclick="downloadInvoice(' + JSON.stringify(inv).replace(/"/g, '&quot;') + ')">' +
              ' Download PDF' +
            '</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    });
}

function downloadInvoice(inv) {
  // If called with old string id, show message
  if (typeof inv === 'string') {
    toast('Please refresh the page and try again.', 'info');
    return;
  }

  var user      = AppState.user || {};
  var printDate = new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  var dueDate   = inv.created_at ? inv.created_at.substring(0,10) : printDate;

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
  '<title>Invoice ' + inv.invoice_number + '</title>' +
  '<style>' +
    'body{font-family:Arial,sans-serif;margin:0;padding:32px;color:var(--text-0);font-size:13px;}' +
    '.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #1a6b3a;}' +
    '.brand{font-size:22px;font-weight:800;color:#1a6b3a;}' +
    '.brand-sub{font-size:11px;color:var(--text-3);margin-top:2px;}' +
    '.inv-title{font-size:28px;font-weight:800;color:#1a6b3a;text-align:right;}' +
    '.inv-meta{font-size:12px;color:var(--text-3);text-align:right;margin-top:4px;}' +
    '.section{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px;}' +
    '.box{background:rgba(255,255,255,0.04);border:1px solid var(--bg-border);border-radius:8px;padding:16px;}' +
    '.box-title{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:700;margin-bottom:8px;}' +
    '.box-name{font-size:15px;font-weight:700;color:var(--text-0);margin-bottom:4px;}' +
    '.box-detail{font-size:12px;color:var(--text-3);line-height:1.6;}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:20px;}' +
    'thead tr{background:#1a6b3a;color:white;}' +
    'th{padding:10px 12px;text-align:left;font-size:12px;font-weight:600;}' +
    'tbody tr{border-bottom:1px solid var(--bg-border);}' +
    'tbody tr:nth-child(even){background:rgba(255,255,255,0.04);}' +
    'td{padding:10px 12px;font-size:13px;}' +
    '.totals{margin-left:auto;width:280px;}' +
    '.total-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid var(--bg-border);}' +
    '.total-final{display:flex;justify-content:space-between;padding:10px 0;font-size:16px;font-weight:800;color:#1a6b3a;border-top:2px solid #1a6b3a;margin-top:4px;}' +
    '.badge{display:inline-block;background:#dcfce7;color:#15803d;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:20px;}' +
    '.footer{margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:var(--text-3);text-align:center;}' +
    '@media print{body{padding:16px;}button{display:none!important;}}' +
  '</style></head><body>' +

  // Header
  '<div class="header">' +
    '<div>' +
      '<div class="brand">TL TradeLink</div>' +
      '<div class="brand-sub">B2B Marketplace  India</div>' +
      '<div class="brand-sub" style="margin-top:6px;">GSTIN: 29AABCT1332L1ZN (Demo)</div>' +
    '</div>' +
    '<div>' +
      '<div class="inv-title">TA ? INVOICE</div>' +
      '<div class="inv-meta">' + inv.invoice_number + '</div>' +
      '<div class="inv-meta">Date: ' + dueDate + '</div>' +
      '<div class="inv-meta">Razorpay: ' + (inv.razorpay_id || '') + '</div>' +
    '</div>' +
  '</div>' +

  // Paid badge
  '<div><span class="badge"> PAID</span></div>' +

  // Billed To / Sold By
  '<div class="section">' +
    '<div class="box">' +
      '<div class="box-title">Billed To (Buyer)</div>' +
      '<div class="box-name">' + escapeHtml(user.name || 'Merchant') + '</div>' +
      '<div class="box-detail">' +
        escapeHtml(user.company_name || '') + '<br>' +
        escapeHtml(user.city || '') + ', India<br>' +
        escapeHtml(user.email || '') +
      '</div>' +
    '</div>' +
    '<div class="box">' +
      '<div class="box-title">Sold By (Seller)</div>' +
      '<div class="box-name">' + escapeHtml(inv.seller_name || 'TradeLink Seller') + '</div>' +
      '<div class="box-detail">' +
        escapeHtml(inv.seller_city || 'India') + '<br>' +
        'Verified TradeLink Seller' +
      '</div>' +
    '</div>' +
  '</div>' +

  // Items table
  '<table>' +
    '<thead><tr>' +
      '<th>#</th><th>Product / Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Base Amount</th><th>GST (18%)</th><th>Total</th>' +
    '</tr></thead>' +
    '<tbody><tr>' +
      '<td>1</td>' +
      '<td style="font-weight:600;">' + escapeHtml(inv.product_title || 'Agricultural Goods') + '</td>' +
      '<td>' + escapeHtml(String(inv.quantity || '')) + '</td>' +
      '<td>' + escapeHtml(inv.unit || '') + '</td>' +
      '<td>' + (inv.price_per_unit ? 'Rs ' + Number(inv.price_per_unit).toLocaleString('en-IN') : '') + '</td>' +
      '<td>' + formatINR(Number(inv.base_amount || 0).toFixed(2)) + '</td>' +
      '<td>' + formatINR(Number(inv.gst_amount  || 0).toFixed(2)) + '</td>' +
      '<td style="font-weight:700;">' + formatINR(Number(inv.amount || 0).toFixed(2)) + '</td>' +
    '</tr></tbody>' +
  '</table>' +

  // Totals
  '<div class="totals">' +
    '<div class="total-row"><span>Subtotal (Base)</span><span>' + Number(inv.base_amount||0).toLocaleString('en-IN',{minimumFractionDigits:2}) + '</span></div>' +
    '<div class="total-row"><span>CGST (9%)</span><span>' + Number((inv.gst_amount||0)/2).toLocaleString('en-IN',{minimumFractionDigits:2}) + '</span></div>' +
    '<div class="total-row"><span>SGST (9%)</span><span>' + Number((inv.gst_amount||0)/2).toLocaleString('en-IN',{minimumFractionDigits:2}) + '</span></div>' +
    '<div class="total-final"><span>Total Amount</span><span>' + Number(inv.amount||0).toLocaleString('en-IN',{minimumFractionDigits:2}) + '</span></div>' +
  '</div>' +

  // Footer
  '<div class="footer">' +
    'This is a computer-generated invoice.  TradeLink B2B Marketplace  support@tradelink.in<br>' +
    'Generated on ' + printDate + '  Deal #' + inv.deal_id +
  '</div>' +

  // Print button (hidden when printing)
  '<div style="text-align:center;margin-top:24px;">' +
    '<button onclick="window.print()" style="background:#1a6b3a;color:white;border:none;padding:12px 32px;' +
      'border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;"> Print / Save as PDF</button>' +
  '</div>' +

  '</body></html>';

  // Open in new tab and trigger print
  var w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  setTimeout(function() { w.print(); }, 500);
}

/* 
   PROFILE & KYC
    */

function loadProfile() {
  apiGet('merchant/profile', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!res.data) return;
      var p = res.data;
      var set = function(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
      set('p-name',     p.name);
      set('p-biz-name', p.company_name);
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
    { label:'Phone Verified',    status: kyc && kyc.phone_verified ? 'verified' : 'pending' },
    { label:'Email Verified',    status: kyc && kyc.email_verified ? 'verified' : 'pending' },
    { label:'GST Uploaded',      status: kyc && kyc.gst_uploaded   ? 'verified' : 'pending' },
    { label:'PAN Uploaded',      status: kyc && kyc.pan_uploaded   ? 'verified' : 'pending' },
    { label:'KYC Approved',      status: kyc && kyc.approved       ? 'verified' : 'pending' },
  ];
  container.innerHTML = steps.map(function(step) {
    return '<div class="kyc-step">' +
      '<span class="kyc-step-name">' + step.label + '</span>' +
      '<span>' + (step.status === 'verified' ? '' : '') + '</span>' +
    '</div>';
  }).join('');
}

function saveProfile() {
  var data = {
    merchant_id:  AppState.user && AppState.user.id,
    name:         document.getElementById('p-name').value.trim(),
    company_name: document.getElementById('p-biz-name').value.trim(),
    city:         document.getElementById('p-city').value.trim(),
    state:        document.getElementById('p-state').value,
  };
  if (!data.name) { toast('Name is required.', 'warning'); return; }

  apiPost('merchant/profile/update', data).then(function(res) {
    if (res.data && res.data.success) {
      toast('Profile saved!', 'success');
    } else {
      toast('Failed to save.', 'danger');
    }
  });
}

function submitKYC() {
  // Block if any document is still uploading
  var uploadZones = document.querySelectorAll('.upload-zone .upload-label');
  for (var i = 0; i < uploadZones.length; i++) {
    if (uploadZones[i].textContent.indexOf('') !== -1) {
      toast(' Please wait  a document is still uploading.', 'warning', 4000);
      return;
    }
  }

  // Block if required docs not uploaded
  var panZone = document.getElementById('pan-zone');
  var panUploaded = panZone && panZone.querySelector('.upload-label') &&
    panZone.querySelector('.upload-label').textContent.indexOf('') !== -1;

  if (!panUploaded) {
    toast('Please upload your PAN card before submitting.', 'warning', 4000);
    return;
  }

  var data = {
    merchant_id: AppState.user && AppState.user.id,
    gst:         document.getElementById('kyc-gst').value.trim(),
    pan:         document.getElementById('kyc-pan').value.trim(),
  };

  if (!data.pan) { toast('PAN number is required.', 'warning'); return; }

  var btn = document.querySelector('button[onclick="submitKYC()"]');
  if (btn) { btn.disabled = true; btn.textContent = ' Submitting...'; }

  apiPost('merchant/kyc/submit', data).then(function(res) {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit KYC Documents'; }
    if (res.data && res.data.success) {
      toast(' KYC submitted successfully! Review takes 12 business days.', 'success', 5000);
    } else {
      var errMsg = (res.data && res.data.detail) || 'KYC submission failed.';
      toast(' ' + errMsg, 'danger', 5000);
    }
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit KYC Documents'; }
    toast(' Submission error: ' + err.message, 'danger', 5000);
  });
}

/* 
   NOTIFICATIONS
    */

function loadNotifications() {
  var container = document.getElementById('notifications-list');
  if (container) container.innerHTML = '<div style="text-align:center;padding:30px;"><div class="spinner"></div></div>';

  apiGet('merchant/notifications', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (!container) return;
      if (!res.data || !res.data.items || res.data.items.length === 0) {
        container.innerHTML = '<div class="empty-state">' +
          '<div class="empty-icon"></div>' +
          '<div class="empty-title">' + (!res.data ? 'Backend not connected' : 'No notifications') + '</div>' +
          '</div>';
        return;
      }
      var typeMap = { outbid:'danger', won:'success', payment:'info', deal:'brand', system:'info' };
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

function markAllRead() {
  apiPost('notifications/mark-read', { merchant_id: AppState.user && AppState.user.id })
    .then(function(res) {
      if (res.data && res.data.success) {
        toast('All notifications marked as read.', 'success');
        loadNotifications();
      }
    });
}

/* 
   UTILITIES
    */

function triggerUpload(inputId) {
  var el = document.getElementById(inputId);
  if (el) el.click();
}

/**
 * handleFileUpload  Step 3: uploads to GCS via backend
 */
function handleFileUpload(inputId, zoneId) {
  var input = document.getElementById(inputId);
  var zone  = document.getElementById(zoneId);
  if (!input || !zone || !input.files[0]) return;

  var file = input.files[0];

  if (file.size > 5 * 1024 * 1024) {
    toast('File too large. Max 5MB.', 'warning');
    return;
  }

  var labelEl = zone.querySelector('.upload-label');
  var subEl   = zone.querySelector('.upload-sub');

  // Disable Submit KYC button while uploading
  var kycBtn = document.querySelector('button[onclick="submitKYC()"]');
  if (kycBtn) { kycBtn.disabled = true; kycBtn.textContent = ' Uploading doc...'; }

  if (labelEl) labelEl.textContent = ' Uploading...';
  if (subEl)   subEl.textContent   = file.name;
  zone.style.borderColor = '#f59e0b';

  var docTypeMap = {
    'gst-cert-file': 'gst_certificate',
    'pan-file':      'pan',
    'aadhaar-file':  'aadhaar',
  };
  var docType = docTypeMap[inputId] || 'document';

  var reader = new FileReader();
  reader.onload = function(e) {
    apiPost('kyc/upload-doc', {
      user_id:     AppState.user && AppState.user.id,
      doc_type:    docType,
      file_base64: e.target.result,
      filename:    file.name,
    }).then(function(res) {
      if (kycBtn) { kycBtn.disabled = false; kycBtn.textContent = 'Submit KYC Documents'; }

      if (res.data && res.data.success) {
        if (labelEl) labelEl.textContent = ' ' + file.name;
        if (subEl)   subEl.textContent   = 'Uploaded successfully';
        zone.style.borderColor = '#1d4ed8';
        toast(' ' + docType + ' uploaded successfully!', 'success', 3000);
        _tl_log('[KYC] Uploaded:', docType, res.data.url);
      } else {
        if (labelEl) labelEl.textContent = ' Upload failed  try again';
        if (subEl)   subEl.textContent   = (res.data && res.data.detail) || 'Try again';
        zone.style.borderColor = '#dc2626';
        var errMsg = (res.data && res.data.detail) || res.error || 'Upload failed.';
        _tl_log('[KYC] Upload failed:', errMsg, res);
        toast(' ' + docType + ' upload failed: ' + errMsg, 'danger', 6000);
      }
    }).catch(function(err) {
      if (kycBtn) { kycBtn.disabled = false; kycBtn.textContent = 'Submit KYC Documents'; }
      if (labelEl) labelEl.textContent = ' Upload error';
      zone.style.borderColor = '#dc2626';
      _tl_log('[KYC] Upload error:', err);
      toast(' Upload error: ' + err.message, 'danger', 6000);
    });
  };
  reader.onerror = function() {
    if (kycBtn) { kycBtn.disabled = false; kycBtn.textContent = 'Submit KYC Documents'; }
    if (labelEl) labelEl.textContent = ' Could not read file';
    toast('Could not read file. Try a different file.', 'danger');
  };
  reader.readAsDataURL(file);
}

// 
// FORGOT PASSWORD  (Step 3)
// 

function showForgotPassword() {
  openModal({
    title: 'Reset Password',
    sub: 'We\'ll email you a reset link.',
    badge: 'Secure', badgeClass: 'info',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Your registered email</label>' +
        '<input class="form-control" type="email" id="forgot-email" placeholder="you@company.com">' +
      '</div>' +
      '<div id="forgot-msg" style="display:none;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:8px;"></div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" id="forgot-btn" onclick="submitForgotPassword()">Send Reset Link </button>',
    small: true,
  });
}

function submitForgotPassword() {
  var email = document.getElementById('forgot-email').value.trim();
  var msgEl = document.getElementById('forgot-msg');
  var btn   = document.getElementById('forgot-btn');

  if (!email) {
    msgEl.style.display = 'block';
    msgEl.style.background = 'var(--danger-light)';
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = 'Please enter your email.';
    return;
  }

  btn.textContent = 'Sending...';
  btn.disabled = true;

  apiPost('auth/forgot-password', { email: email }).then(function() {
    msgEl.style.display    = 'block';
    msgEl.style.background = 'var(--success-light)';
    msgEl.style.color      = 'var(--success)';
    msgEl.textContent      = ' Reset link sent! Check your inbox.';
    btn.textContent        = 'Sent ';
  });
}

/* 
   SCREEN NAVIGATION HOOKS
    */
var _originalNavigate = navigate;
navigate = function(screenId, navEl) {
  _originalNavigate(screenId, navEl);
  switch (screenId) {
    case 'marketplace':    loadMarketplace();     loadDashboardStats(); break;
    case 'my-bids':        loadMyBids();          break;
    case 'my-deals':       loadMyDeals();         break;
    case 'watchlist':      loadWatchlist();       break;
    case 'payments':       loadPayments();        break;
    case 'invoices':       loadInvoices();        break;
    case 'profile':        loadProfile();         break;
    case 'notifications':  loadNotifications();   break;
    case 'transport':      loadTransportMarketplace();  break;
    case 'my-deliveries':  loadMyDeliveries();    break;
    case 'my-vehicles':    loadMyVehicles();      break;
  }
};
/* 
   STEP 6+7  TRANSPORT & DELIVERY (Merchant/Transporter side)
    */

/* 
   TRANSPORT MARKETPLACE
   Transporter browses open requests from sellers
    */

function loadTransportMarketplace() {
  var container = document.getElementById('transport-market-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  // Get filter values
  var fromCity = document.getElementById('tr-filter-from') ? document.getElementById('tr-filter-from').value.trim() : '';
  var toCity   = document.getElementById('tr-filter-to')   ? document.getElementById('tr-filter-to').value.trim()   : '';

  apiGet('transport/requests', { status: 'open', pickup_city: fromCity, delivery_city: toCity, limit: 30 })
    .then(function(res) {
      if (!res.data || !res.data.rows || !res.data.rows.length) {
        container.innerHTML =
          '<div class="empty-state" style="padding:40px 20px;">' +
            '<div class="empty-icon"></div>' +
            '<div class="empty-title">No open requests' + (fromCity||toCity ? ' matching your route':'') + '</div>' +
            '<div class="empty-sub">Check back soon  sellers post requests after closing deals.</div>' +
          '</div>';
        return;
      }

      container.innerHTML = res.data.rows.map(function(req) {
        var qtyFmt = req.quantity_kg ? req.quantity_kg + ' kg' : '';
        var budgetFmt = req.budget_inr ? formatINR(req.budget_inr) + ' max' : 'Open to quotes';
        return '<div class="card" style="margin-bottom:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">' +
            '<div>' +
              '<div style="font-family:var(--font-display);font-size:15px;font-weight:700;">' + escapeHtml(req.title||'Goods') + '</div>' +
              '<div style="font-size:12px;color:var(--gray-500);margin-top:2px;">' +
                'By ' + escapeHtml(req.seller_name||'') + '  ' + escapeHtml((req.created_at||'').substring(0,10)) +
              '</div>' +
            '</div>' +
            '<span style="background:var(--success-light,#dcfce7);color:var(--success);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">OPEN</span>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px;">' +
            '<div style="background:var(--gray-50);border-radius:8px;padding:10px;">' +
              '<div style="font-size:10px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.05em;">From</div>' +
              '<div style="font-weight:600;margin-top:2px;"> ' + escapeHtml(req.pickup_city||'') + '</div>' +
            '</div>' +
            '<div style="background:var(--gray-50);border-radius:8px;padding:10px;">' +
              '<div style="font-size:10px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.05em;">To</div>' +
              '<div style="font-weight:600;margin-top:2px;"> ' + escapeHtml(req.delivery_city||'') + '</div>' +
            '</div>' +
            '<div style="background:var(--gray-50);border-radius:8px;padding:10px;">' +
              '<div style="font-size:10px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.05em;">Weight</div>' +
              '<div style="font-weight:600;margin-top:2px;"> ' + escapeHtml(qtyFmt) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-size:13px;color:var(--gray-600);">' +
              ' Pickup: ' + escapeHtml(req.pickup_date||'Flexible') +
              '  Budget: <strong>' + budgetFmt + '</strong>' +
            '</div>' +
            '<button class="btn primary sm" onclick="openPlaceBidModal(\'' + escapeHtml(req.id) + '\',\'' + escapeHtml(req.title||'') + '\',\'' + escapeHtml(req.pickup_city||'') + '\',\'' + escapeHtml(req.delivery_city||'') + '\')">' +
              ' Quote Price' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    });
}

/* 
   PLACE TRANSPORT BID (Quote price)
    */

function openPlaceBidModal(requestId, title, fromCity, toCity) {
  // First load user's vehicles
  apiGet('transport/my-vehicles').then(function(res) {
    var vehicles = res.data && res.data.rows ? res.data.rows : [];

    var vehicleOptions = vehicles.length
      ? vehicles.map(function(v) {
          return '<option value="' + escapeHtml(v.id) + '">' +
            escapeHtml(v.vehicle_number) + '  ' + escapeHtml(v.vehicle_type) +
            '  ' + escapeHtml(v.capacity_kg) + ' kg cap' +
          '</option>';
        }).join('')
      : '<option value="">No vehicles registered yet</option>';

    openModal({
      title: ' Submit Your Quote',
      sub: escapeHtml(fromCity) + '  ' + escapeHtml(toCity),
      badge: 'Transport Request', badgeClass: 'info',
      bodyHTML:
        '<div style="background:var(--gray-50);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;">' +
          '<strong>' + escapeHtml(title) + '</strong><br>' +
          '<span style="color:var(--gray-500);">' + escapeHtml(fromCity) + '  ' + escapeHtml(toCity) + '</span>' +
        '</div>' +

        (vehicles.length === 0 ? '<div style="background:var(--warning-light,#fef3c7);border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#92400e;">' +
            ' Register a vehicle first to place bids. <a href="#" onclick="navigate(\'my-vehicles\',null);closeModalDirect();" style="color:var(--brand-main);font-weight:600;">Register Vehicle </a>' +
          '</div>' : '') +

        '<div class="form-group">' +
          '<label class="login-label">Select Your Vehicle <span style="color:var(--danger)">*</span></label>' +
          '<select class="form-control" id="bid-vehicle-id">' + vehicleOptions + '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="login-label">Your Price () <span style="color:var(--danger)">*</span></label>' +
          '<input class="form-control" type="number" id="bid-price" placeholder="e.g. 4500" min="1">' +
          '<p style="font-size:12px;color:var(--gray-400);margin:4px 0 0;">Competitive pricing wins more bookings</p>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="login-label">Message to Seller (optional)</label>' +
          '<input class="form-control" type="text" id="bid-message" placeholder="e.g. Can pickup same day, AC vehicle, experienced driver...">' +
        '</div>',
      footerHTML:
        '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
        (vehicles.length ? '<button class="btn primary" onclick="submitTransportBid(\'' + escapeHtml(requestId) + '\')">Submit Quote </button>' :
          '')
    });
  });
}

function submitTransportBid(requestId) {
  var vehicleId = document.getElementById('bid-vehicle-id') ? document.getElementById('bid-vehicle-id').value : '';
  var price     = document.getElementById('bid-price')     ? parseFloat(document.getElementById('bid-price').value) : 0;
  var message   = document.getElementById('bid-message')   ? document.getElementById('bid-message').value.trim() : '';

  if (!vehicleId) { toast('Please select a vehicle.', 'warning'); return; }
  if (!price || price <= 0) { toast('Please enter a valid price.', 'warning'); return; }

  var btn = document.querySelector('#modal-overlay .btn.primary');
  if (btn) { btn.textContent = 'Submitting...'; btn.disabled = true; }

  apiPost('transport/bid/place', {
    request_id: requestId,
    vehicle_id: vehicleId,
    price_inr:  price,
    message:    message,
  }).then(function(res) {
    if (btn) { btn.textContent = 'Submit Quote '; btn.disabled = false; }
    if (res.data && res.data.success) {
      closeModalDirect();
      toast(' Quote submitted! You\'ll be notified if selected.', 'success', 5000);
      loadTransportMarketplace();
    } else {
      toast((res.data && res.data.detail) || 'Failed to submit quote.', 'danger');
    }
  });
}

/* 
   MY DELIVERIES (active + completed)
    */

function loadMyDeliveries() {
  var container = document.getElementById('my-deliveries-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  // Get all transport requests where I am the transporter
  apiGet('transport/requests', { status: '', limit: 100 })
    .then(function(res) {
      if (!res.data) return;
      var myId = AppState.user && AppState.user.id;
      var mine = (res.data.rows || []).filter(function(r) {
        return r.transporter_id === myId;
      });

      if (!mine.length) {
        container.innerHTML =
          '<div class="empty-state" style="padding:40px 20px;">' +
            '<div class="empty-icon"></div>' +
            '<div class="empty-title">No deliveries yet</div>' +
            '<div class="empty-sub">Browse transport requests and submit quotes to get bookings.</div>' +
            '<button class="btn primary" style="margin-top:16px;" onclick="navigate(\'transport\',null)">Browse Requests </button>' +
          '</div>';
        return;
      }

      var active    = mine.filter(function(r) { return !['delivered','cancelled'].includes(r.status); });
      var completed = mine.filter(function(r) { return  ['delivered','cancelled'].includes(r.status); });

      function renderDelivery(r) {
        var statusColors = {
          accepted:   '#d97706',
          paid:       '#0284c7',
          picked_up:  '#7c3aed',
          in_transit: '#1d4ed8',
          delivered:  '#16a34a',
        };
        var color = statusColors[r.status] || 'var(--gray-500)';
        var canUpdate = ['accepted','paid','picked_up','in_transit'].includes(r.status);

        return '<div class="card" style="margin-bottom:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">' +
            '<div>' +
              '<div style="font-family:var(--font-display);font-size:15px;font-weight:700;">' + escapeHtml(r.title||'Goods') + '</div>' +
              '<div style="font-size:12px;color:var(--gray-500);margin-top:2px;">' +
                escapeHtml(r.pickup_city||'') + '  ' + escapeHtml(r.delivery_city||'') + '  ' + escapeHtml(String(r.quantity_kg||'')) + ' kg' +
              '</div>' +
            '</div>' +
            '<span style="background:' + color + ';color:white;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">' +
              escapeHtml((r.status||'').replace('_',' ').toUpperCase()) +
            '</span>' +
          '</div>' +

          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-size:13px;color:var(--gray-600);">' +
              'Agreed: <strong style="color:var(--success);">' + escapeHtml(String(r.agreed_price_inr||'')) + '</strong>' +
              '  Payment: ' + escapeHtml(r.payment_status||'unpaid') +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
              (canUpdate ? '<button class="btn sm" onclick="openUpdateStatusModal(\'' + escapeHtml(r.id) + '\',\'' + escapeHtml(r.status) + '\')">' +
                  ' Update Status' +
                '</button>' : '') +
              '<button class="btn sm" onclick="openTrackingMapMerchant(\'' + escapeHtml(r.id) + '\')">' +
                ' Track' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      container.innerHTML =
        (active.length ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-400);font-weight:600;margin-bottom:10px;">Active Deliveries (' + active.length + ')</div>' +
          active.map(renderDelivery).join('') : '') +
        (completed.length ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-400);font-weight:600;margin:20px 0 10px;">Completed (' + completed.length + ')</div>' +
          completed.map(renderDelivery).join('') : '');
    });
}

/* 
   UPDATE DELIVERY STATUS (transporter sends GPS)
    */

function openUpdateStatusModal(requestId, currentStatus) {
  var nextStatuses = {
    accepted:   [{ val:'picked_up',  label:' Picked Up  Goods loaded' }],
    paid:       [{ val:'picked_up',  label:' Picked Up  Goods loaded' }],
    picked_up:  [{ val:'in_transit', label:' In Transit  On the road' }],
    in_transit: [{ val:'delivered',  label:' Delivered  Goods handed over' }],
  };
  var options = nextStatuses[currentStatus] || [];

  openModal({
    title: ' Update Delivery Status',
    sub: 'Your GPS will be captured automatically',
    badge: 'Live Update', badgeClass: 'info',
    bodyHTML:
      '<div style="background:var(--info-light,#e0f2fe);border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:var(--info,#0284c7);">' +
        'i Your device GPS will be used to show your live location on the map.' +
      '</div>' +
      (options.length ? options.map(function(opt) {
        return '<div style="margin-bottom:10px;">' +
          '<button class="btn" style="width:100%;justify-content:flex-start;padding:14px 16px;font-size:14px;" ' +
            'onclick="sendStatusUpdate(\'' + requestId + '\',\'' + opt.val + '\')">' +
            opt.label +
          '</button>' +
        '</div>';
      }).join('') : '<p style="color:var(--gray-500);">No further status updates available.</p>') +
      '<div class="form-group" style="margin-top:8px;">' +
        '<label class="login-label">Add a note (optional)</label>' +
        '<input class="form-control" type="text" id="status-note" placeholder="e.g. Reached Pune toll, delayed by 1hr...">' +
      '</div>',
    footerHTML: '<button class="btn" onclick="closeModalDirect()">Cancel</button>'
  });
}

function sendStatusUpdate(requestId, status) {
  var note = document.getElementById('status-note') ? document.getElementById('status-note').value.trim() : '';
  var btn  = document.querySelector('#modal-overlay .btn');

  // Get GPS
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        _doStatusUpdate(requestId, status, pos.coords.latitude, pos.coords.longitude, note);
      },
      function() {
        // GPS denied  send without coords (still updates status)
        _doStatusUpdate(requestId, status, '', '', note);
      }
    );
  } else {
    _doStatusUpdate(requestId, status, '', '', note);
  }
}

function _doStatusUpdate(requestId, status, lat, lng, note) {
  closeModalDirect();
  toast('Sending update...', 'info', 2000);

  apiPost('transport/tracking/update', {
    request_id: requestId,
    status:     status,
    lat:        lat,
    lng:        lng,
    note:       note,
  }).then(function(res) {
    if (res.data && res.data.success) {
      var msgs = {
        picked_up:  ' Pickup confirmed! Seller has been notified.',
        in_transit: ' Status updated  In Transit!',
        delivered:  ' Delivery complete! Payout will be released by admin.',
      };
      toast(msgs[status] || 'Status updated!', 'success', 5000);
      loadMyDeliveries();
    } else {
      toast('Failed to update status.', 'danger');
    }
  });
}

/* 
   MY VEHICLES  Register & Manage
    */

function loadMyVehicles() {
  var container = document.getElementById('my-vehicles-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  apiGet('transport/my-vehicles').then(function(res) {
    var vehicles = res.data && res.data.rows ? res.data.rows : [];

    if (!vehicles.length) {
      container.innerHTML =
        '<div class="empty-state" style="padding:40px 20px;">' +
          '<div class="empty-icon"></div>' +
          '<div class="empty-title">No vehicles registered</div>' +
          '<div class="empty-sub">Register your vehicle to start accepting transport bookings.</div>' +
          '<button class="btn primary" style="margin-top:16px;" onclick="openRegisterVehicleModal()">+ Register Vehicle</button>' +
        '</div>';
      return;
    }

    container.innerHTML = vehicles.map(function(v) {
      var available = v.available !== 'false';
      return '<div class="card" style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
          '<div>' +
            '<div style="font-family:var(--font-display);font-size:16px;font-weight:800;">' + escapeHtml(v.vehicle_number||'') + '</div>' +
            '<div style="font-size:13px;color:var(--gray-600);margin-top:3px;">' +
              escapeHtml(v.vehicle_type||'') + '  ' + escapeHtml(String(v.capacity_kg||'')) + ' kg  ' +
              escapeHtml(String(v.capacity_volume_cft||'')) + ' cft' +
            '</div>' +
            '<div style="font-size:12px;color:var(--gray-400);margin-top:2px;">' +
              ' Currently in ' + escapeHtml(v.current_city||'') +
              (v.rating && v.rating !== '0' ? '   ' + escapeHtml(String(v.rating)) + ' (' + escapeHtml(String(v.rating_count||0)) + ' trips)' : '') +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<span style="background:' + (available ? 'var(--success)':'var(--gray-400)') + ';color:white;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;">' +
              (available ? 'AVAILABLE' : 'BUSY') +
            '</span>' +
            '<br>' +
            '<button class="btn sm" style="margin-top:8px;" onclick="toggleVehicleAvailability(\'' + escapeHtml(v.id) + '\',\'' + escapeHtml(v.vehicle_number||'') + '\')">' +
              (available ? 'Mark Busy' : 'Mark Available') +
            '</button>' +
          '</div>' +
        '</div>' +
        (v.description ? '<div style="font-size:13px;color:var(--gray-600);margin-top:10px;padding-top:10px;border-top:1px solid var(--gray-100);">' +
            escapeHtml(v.description) +
          '</div>' : '') +
      '</div>';
    }).join('') +
    '<button class="btn primary" style="margin-top:8px;" onclick="openRegisterVehicleModal()">+ Add Another Vehicle</button>';
  });
}

function toggleVehicleAvailability(vehicleId, vehicleNumber) {
  apiPost('transport/vehicle/toggle-availability', { vehicle_id: vehicleId })
    .then(function(res) {
      if (res.data && res.data.success) {
        var status = res.data.available ? 'Available' : 'Busy';
        toast(escapeHtml(vehicleNumber) + ' marked as ' + status, 'success');
        loadMyVehicles();
      }
    });
}

function openRegisterVehicleModal() {
  openModal({
    title: ' Register Your Vehicle',
    sub: 'Start accepting transport requests',
    badge: 'New Vehicle', badgeClass: 'brand',
    bodyHTML:
      '<div class="form-group">' +
        '<label class="login-label">Vehicle Number <span style="color:var(--danger)">*</span></label>' +
        '<input class="form-control" type="text" id="v-number" placeholder="KA01AB1234" style="text-transform:uppercase;">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Vehicle Type <span style="color:var(--danger)">*</span></label>' +
        '<select class="form-control" id="v-type">' +
          '<option value="mini_truck">Mini Truck (up to 1 ton)</option>' +
          '<option value="pickup">Pickup Van</option>' +
          '<option value="medium_truck" selected>Medium Truck (15 ton)</option>' +
          '<option value="large_truck">Large Truck (515 ton)</option>' +
          '<option value="trailer">Trailer / 20-ton+</option>' +
        '</select>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-group">' +
          '<label class="login-label">Capacity (kg) <span style="color:var(--danger)">*</span></label>' +
          '<input class="form-control" type="number" id="v-capacity-kg" placeholder="e.g. 5000" min="1">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="login-label">Current City <span style="color:var(--danger)">*</span></label>' +
          '<input class="form-control" type="text" id="v-city" placeholder="e.g. Bengaluru">' +
        '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--gray-400);margin-bottom:6px;">Vehicle dimensions (to calculate volume  optional)</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
        '<div class="form-group">' +
          '<label class="login-label">Length (ft)</label>' +
          '<input class="form-control" type="number" id="v-length" placeholder="18">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="login-label">Width (ft)</label>' +
          '<input class="form-control" type="number" id="v-width" placeholder="6">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="login-label">Height (ft)</label>' +
          '<input class="form-control" type="number" id="v-height" placeholder="5">' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="login-label">Description (optional)</label>' +
        '<input class="form-control" type="text" id="v-desc" placeholder="AC cabin, GPS tracking, 5 years exp, handles fragile goods...">' +
      '</div>',
    footerHTML:
      '<button class="btn" onclick="closeModalDirect()">Cancel</button>' +
      '<button class="btn primary" onclick="submitVehicleRegistration()">Register Vehicle </button>'
  });
}

function submitVehicleRegistration() {
  var number   = document.getElementById('v-number')      ? document.getElementById('v-number').value.trim().toUpperCase() : '';
  var type     = document.getElementById('v-type')        ? document.getElementById('v-type').value : '';
  var capacity = document.getElementById('v-capacity-kg') ? parseFloat(document.getElementById('v-capacity-kg').value) : 0;
  var city     = document.getElementById('v-city')        ? document.getElementById('v-city').value.trim() : '';
  var length   = document.getElementById('v-length')      ? parseFloat(document.getElementById('v-length').value) || 0 : 0;
  var width    = document.getElementById('v-width')       ? parseFloat(document.getElementById('v-width').value)  || 0 : 0;
  var height   = document.getElementById('v-height')      ? parseFloat(document.getElementById('v-height').value) || 0 : 0;
  var desc     = document.getElementById('v-desc')        ? document.getElementById('v-desc').value.trim() : '';

  if (!number)   { toast('Please enter the vehicle number.', 'warning'); return; }
  if (!type)     { toast('Please select vehicle type.', 'warning'); return; }
  if (!capacity) { toast('Please enter load capacity in kg.', 'warning'); return; }
  if (!city)     { toast('Please enter your current city.', 'warning'); return; }

  var btn = document.querySelector('#modal-overlay .btn.primary');
  if (btn) { btn.textContent = 'Registering...'; btn.disabled = true; }

  apiPost('transport/vehicle/register', {
    vehicle_number: number,
    vehicle_type:   type,
    capacity_kg:    capacity,
    current_city:   city,
    current_state:  AppState.user ? AppState.user.state || '' : '',
    length_ft:      length,
    width_ft:       width,
    height_ft:      height,
    description:    desc,
  }).then(function(res) {
    if (btn) { btn.textContent = 'Register Vehicle '; btn.disabled = false; }
    if (res.data && res.data.success) {
      closeModalDirect();
      toast(' Vehicle registered! You can now accept transport bookings.', 'success', 5000);
      loadMyVehicles();
    } else {
      toast((res.data && res.data.detail) || 'Registration failed.', 'danger');
    }
  });
}

/* 
   TRACKING MAP (transporter side)
    */

function openTrackingMapMerchant(requestId) {
  apiGet('transport/tracking/' + requestId).then(function(res) {
    if (!res.data) { toast('Could not load tracking data.', 'danger'); return; }
    var data = res.data;

    openModal({
      title: ' Tracking  ' + escapeHtml(data.pickup_city||'') + '  ' + escapeHtml(data.delivery_city||''),
      sub: 'Vehicle: ' + escapeHtml(data.vehicle||''),
      badge: data.status, badgeClass: 'info',
      bodyHTML:
        '<div id="tracking-map-t" style="height:300px;border-radius:10px;overflow:hidden;margin-bottom:12px;"></div>' +
        '<div style="max-height:100px;overflow-y:auto;">' +
          (data.tracking_notes||[]).slice().reverse().map(function(n) {
            return '<div style="font-size:12px;color:var(--gray-600);padding:4px 0;border-bottom:1px solid var(--gray-100);">' +
              '<span style="color:var(--gray-400);">' + escapeHtml((n.time||'').substring(11,16)) + '</span> ' +
              ' ' + escapeHtml(n.note||n.status||'') +
            '</div>';
          }).join('') +
        '</div>',
      footerHTML: '<button class="btn" onclick="closeModalDirect()">Close</button>',
      wide: true
    });

    setTimeout(function() {
      if (typeof L === 'undefined') {
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        s.onload = function() { _drawTrackingMapM('tracking-map-t', data); };
        document.head.appendChild(s);
      } else {
        _drawTrackingMapM('tracking-map-t', data);
      }
    }, 200);
  });
}

function _drawTrackingMapM(containerId, data) {
  var el = document.getElementById(containerId);
  if (!el) return;
  if (el._leaflet_id) { el._leaflet_id = null; el.innerHTML = ''; }

  var lat = parseFloat(data.current_lat) || 20.5937;
  var lng = parseFloat(data.current_lng) || 78.9629;

  var map = L.map(containerId).setView([lat, lng], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 20
  }).addTo(map);

  var mk = function(icon, lat, lng, popup) {
    L.marker([parseFloat(lat), parseFloat(lng)], {
      icon: L.divIcon({ html: icon, iconSize:[32,32], iconAnchor:[16,16], className:'' })
    }).addTo(map).bindPopup(popup);
  };

  if (data.pickup_lat && data.pickup_lng)
    mk('<div style="background:#1a6b3a;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>',
       data.pickup_lat, data.pickup_lng, '<strong>Pickup:</strong> ' + escapeHtml(data.pickup_city||''));

  if (data.delivery_lat && data.delivery_lng)
    mk('<div style="background:#dc2626;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>',
       data.delivery_lat, data.delivery_lng, '<strong>Delivery:</strong> ' + escapeHtml(data.delivery_city||''));

  if (data.current_lat && data.current_lng)
    mk('<div style="background:#1d4ed8;color:white;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:20px;border:3px solid white;box-shadow:0 3px 8px rgba(0,0,0,.4);"></div>',
       data.current_lat, data.current_lng, '<strong>Your vehicle</strong>');

  if (data.pickup_lat && data.delivery_lat)
    L.polyline([
      [parseFloat(data.pickup_lat),   parseFloat(data.pickup_lng)],
      [parseFloat(data.delivery_lat), parseFloat(data.delivery_lng)]
    ], { color:'#1d4ed8', weight:3, dashArray:'6 6', opacity:.7 }).addTo(map);
}

function toggleSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('active');
}

function closeSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
}

var _merchantNavigate = window.navigate;
window.navigate = function(screenId, navEl) {
  if (typeof closeSidebar === 'function') closeSidebar();
  if (_merchantNavigate) _merchantNavigate(screenId, navEl);
  var screen = document.getElementById('screen-' + screenId);
  if (screen) {
    screen.style.animation = 'none';
    void screen.offsetWidth;
    screen.style.animation = 'screen-in .35s ease both';
  }
};

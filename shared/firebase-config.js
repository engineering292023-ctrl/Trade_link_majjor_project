/**
 * TRADELINK — Firebase Config  (shared/firebase-config.js)
 *
 * FIXED VERSION:
 * - Uses Firebase signInWithPopup (works on localhost AND any hosted URL)
 * - No Google Identity Services (GIS) script needed at all
 * - No GOOGLE_CLIENT_ID needed
 * - Works on file:// too for testing (but full login needs http://)
 *
 * HOW TO GET YOUR VALUES:
 * 1. Go to https://console.firebase.google.com
 * 2. Click your project (tradelink-1c55b)
 * 3. Click the gear ⚙️ → Project Settings
 * 4. Scroll down to "Your apps" → click the </> Web app
 * 5. Copy the firebaseConfig values below
 *
 * FOR GOOGLE LOGIN TO WORK:
 * 1. Firebase Console → Authentication → Sign-in method → Google → Enable it
 * 2. Add your domain in Firebase Console → Authentication → Settings → Authorized domains
 *    - localhost is already there
 *    - Add your Netlify/hosted URL when you deploy (e.g. tradelink.netlify.app)
 * That's it — signInWithPopup handles everything automatically.
 */

var FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBiQeRWx-ibJLesZBDjJzx0uJYO--xZGeA",
  authDomain:        "tradelink-1c55b.firebaseapp.com",
  projectId:         "tradelink-1c55b",
  storageBucket:     "tradelink-1c55b.firebasestorage.app",
  messagingSenderId: "754429221126",
  appId:             "1:754429221126:web:ebc8a762148bdfdbfba687"
};



var GOOGLE_CLIENT_ID = '193992290612-nrjh5krpk4ffp94umht822in6j2gpmp1.apps.googleusercontent.com';




// ─────────────────────────────────────────────────────────────────
// DO NOT EDIT BELOW THIS LINE
// ─────────────────────────────────────────────────────────────────
 
(function () {
  function _tl_log(msg) {
    if (window.console && console.log) console.log('[Firebase]', msg);
  }
 
  // ── Check 1: Opened via file:// — Firebase won't work ──────────
  if (window.location.protocol === 'file:') {
    window._firebaseError = 'Open via Live Server (http://), not by double-clicking the HTML file.';
    _showErrorBanner(
      'Open via Live Server in VS Code — Right-click index.html → Open with Live Server. ' +
      'URL must start with http://, not file://'
    );
    // Still continue so the page renders — just auth won't work
  }
 
  // ── Check 2: Is Firebase SDK loaded? ───────────────────────────
  if (typeof firebase === 'undefined') {
    window._firebaseError = 'Firebase SDK not loaded. Check your internet connection and refresh.';
    _showErrorBanner('Firebase SDK failed to load. Check internet connection and refresh the page.');
    return;
  }
 
  // ── Check 3: Are config values filled in? ──────────────────────
  if (!FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY_HERE') {
    window._firebaseError = 'Fill in your Firebase keys in shared/firebase-config.js';
    _showErrorBanner('Firebase keys not filled in. Open shared/firebase-config.js and add your values.');
    return;
  }
 
  // ── Initialize Firebase ─────────────────────────────────────────
  try {
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
 
    // Auth instance — used by seller.js and merchant.js
    window.firebaseAuth = firebase.auth();
 
    // Google provider — used by signInWithPopup
    // This replaces the old GIS (Google Identity Services) approach
    // signInWithPopup works on localhost AND any hosted domain automatically
    window.googleProvider = new firebase.auth.GoogleAuthProvider();
    window.googleProvider.addScope('email');
    window.googleProvider.addScope('profile');
 
    // Force account selection every time (so user can switch accounts)
    window.googleProvider.setCustomParameters({
      prompt: 'select_account'
    });
 
    _tl_log('✅ App ready.');
 
  } catch (e) {
    _tl_log('App init error.');
    window._firebaseError = 'Firebase init error: ' + e.message;
    _showErrorBanner('Firebase init failed: ' + e.message);
  }
 
  // ── Helper: show a red banner on screen ────────────────────────
  function _showErrorBanner(message) {
    var show = function() {
      if (document.getElementById('tl-firebase-error-banner')) return;
      var banner = document.createElement('div');
      banner.id = 'tl-firebase-error-banner';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#dc2626', 'color:white', 'padding:14px 20px',
        'font-size:13px', 'font-family:sans-serif', 'line-height:1.6',
        'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
      ].join(';');
      banner.innerHTML =
        '❌ <strong>Firebase Error:</strong> ' + message +
        ' &nbsp;|&nbsp; <a href="https://console.firebase.google.com" target="_blank" ' +
        'style="color:white;font-weight:bold;text-decoration:underline;">Firebase Console →</a>';
      if (document.body) {
        document.body.prepend(banner);
      } else {
        document.addEventListener('DOMContentLoaded', function() {
          document.body.prepend(banner);
        });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', show);
    } else {
      show();
    }
  }
 
})();
/**
 * TRADELINK — Netlify Frontend Build Script (build-frontend.js)
 * 
 * 1. Reads process.env.BACKEND_URL from Netlify Environment Variables.
 * 2. Injects runtime config into env-config.js.
 * 3. Builds a secure 'dist/' directory containing ONLY frontend files.
 *    (The 'backend/' folder is NEVER included or published).
 */

const fs = require('fs');
const path = require('path');

const backendUrl = (process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
console.log('Building TradeLink frontend...');
if (backendUrl) {
  console.log('Injected BACKEND_URL from environment:', backendUrl);
} else {
  console.log('No BACKEND_URL provided — frontend will use relative /api or localhost.');
}

const configCode = `/**
 * TRADELINK — Runtime Environment Config (Generated at build time)
 */
window.ENV_CONFIG = {
  BACKEND_URL: '${backendUrl}'
};
`;

const configTargets = [
  'shared/env-config.js',
  'TradeLink/shared/env-config.js',
  'TradeLink/seller-portal/shared/env-config.js',
  'TradeLink/merchant-portal/shared/env-config.js',
  'admin-portal/env-config.js'
];

configTargets.forEach(t => {
  const dir = path.dirname(t);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(t, configCode);
});

// Assemble clean dist folder (ZERO backend files)
const dist = 'dist';
if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

function copyFolderSync(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    const src = path.join(from, element);
    const dest = path.join(to, element);
    if (fs.lstatSync(src).isDirectory()) {
      copyFolderSync(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  });
}

// Copy only frontend portal directories
copyFolderSync('TradeLink', path.join(dist, 'TradeLink'));
copyFolderSync('admin-portal', path.join(dist, 'admin-portal'));
copyFolderSync('shared', path.join(dist, 'shared'));

// Create redirect rules
const redirects = [
  '/ /TradeLink/seller-portal/index.html 302',
  '/seller /TradeLink/seller-portal/index.html 302',
  '/merchant /TradeLink/merchant-portal/index.html 302',
  '/admin /admin-portal/index.html 302',
  '/backend/* /404.html 404'
].join('\n') + '\n';

fs.writeFileSync(path.join(dist, '_redirects'), redirects);

// Clean landing index page
const landingHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=/TradeLink/seller-portal/index.html">
  <title>TradeLink</title>
</head>
<body>
  <p>Redirecting to <a href="/TradeLink/seller-portal/index.html">TradeLink Marketplace</a>...</p>
</body>
</html>
`;
fs.writeFileSync(path.join(dist, 'index.html'), landingHtml);

console.log('✅ TradeLink frontend build complete! Published directory: dist/');

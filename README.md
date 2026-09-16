# TradeLink — Offline Quick Start Guide
## How to run the project locally after downloading from GitHub

> **When to use this:** If the deployed/hosted version is not working during demo,
> download the project from GitHub, follow these steps, and run everything locally
> in under 10 minutes.

---

## What You Need Installed on Your Computer

Before starting, make sure these are installed:

| Tool | Check if installed | Download |
|------|--------------------|---------|
| **Python 3.11** | Open PowerShell → type `python --version` | python.org/downloads |
| **VS Code** | Should already be there | code.visualstudio.com |
| **Live Server extension** | VS Code → Extensions → search "Live Server" | Inside VS Code |
| **Git** | `git --version` in PowerShell | git-scm.com |

---

## Step 1 — Download the Project

```bash
# Open PowerShell in the folder where you want the project
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

# Go into the project folder
cd YOUR_REPO_NAME
```

Or: Download as ZIP from GitHub → Extract → open in VS Code.

---

## Step 2 — Add the Secret Files

These files are NOT in GitHub (they contain private keys). You must add them manually.

Copy these files into the backend/ folder:

```
backend/
├── service-account.json      ← Google Sheets credentials
├── firebase-adminsdk.json    ← Firebase Admin credentials
└── .env                      ← All your API keys
```

You already have all 3 of these from when you first set up the project.
They are on your computer in your old project folder — just copy them over.

**If you cannot find them:**
- service-account.json → Download again from GCP Console → IAM → Service Accounts
- firebase-adminsdk.json → Download again from Firebase Console → Project Settings → Service Accounts
- .env → Recreate using the template below

### .env Template

```
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_JSON=service-account.json
FIREBASE_ADMIN_SDK_JSON=firebase-adminsdk.json
RAZORPAY_KEY_ID=rzp_test_SSvp1sMHGiSbsq
RAZORPAY_KEY_SECRET=C8SfFmtSiK2FnNnNLAqwdHY5
RAZORPAY_WEBHOOK_SECRET=
GDRIVE_FOLDER_ID=your_drive_folder_id_here
GMAIL_ADDRESS=your_gmail@gmail.com
GMAIL_APP_PASSWORD=your_app_password_here
ADMIN_SECRET_KEY=admin123
APP_ENV=development
ALLOWED_HOSTS=*
AFTERSHIP_API_KEY=
```

---

## Step 3 — Set Up Python Virtual Environment

Open PowerShell. Navigate to the backend folder:

```bash
cd backend
```

Create the virtual environment using Python 3.11:

```bash
py -3.11 -m venv venv
```

Activate it:

```bash
venv\Scripts\activate
```

You will see (venv) appear at the start of your prompt. This means it is active.

Install all packages:

```bash
pip install -r requirements.txt
```

This takes 2-3 minutes the first time.

---

## Step 4 — Start the Backend Server

Make sure you are in the backend/ folder with venv active, then run:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

You should see:

```
INFO:     Uvicorn running on http://0.0.0.0:8000
INFO:     Application startup complete.
✅ Firebase Admin SDK initialized
```

**Keep this PowerShell window open the entire time you use the project.**

---

## Step 5 — Open the Portals via Live Server

**CRITICAL: You MUST open the portals using Live Server.**
Never double-click the HTML files to open them.
Double-clicking opens them via file:// which completely breaks Firebase login and Google sign-in.
The URL must always start with http://

### Method A — VS Code Live Server (easiest, recommended)

```
1. Open VS Code
2. Open your project folder: File → Open Folder → select MY_MAJOR_PROJECT
3. In the Explorer panel on the left, find the HTML file you want
4. RIGHT-CLICK on the file
5. Click "Open with Live Server"
6. Browser opens automatically with http:// URL
```

**Install Live Server if you do not have it:**
```
VS Code → Click Extensions icon (left sidebar, 4 squares icon)
Search: Live Server
Click Install on the one by Ritwick Dey
Takes 30 seconds to install
```

### Method B — Terminal command (if VS Code Live Server is not available)

```bash
# Install live-server globally — only needed once
npm install -g live-server

# Run from your project root folder
cd D:\My_Major_project
live-server --port=5500
```

Browser opens at http://127.0.0.1:5500 automatically.

---

### Which files to open and their URLs

| Portal | File to right-click | URL after opening |
|--------|--------------------|--------------------|
| **Seller Portal** | TradeLink/seller-portal/index.html | http://127.0.0.1:5500/TradeLink/seller-portal/index.html |
| **Merchant Portal** | TradeLink/merchant-portal/index.html | http://127.0.0.1:5500/TradeLink/merchant-portal/index.html |
| **Admin Panel** | admin-portal/index.html | http://127.0.0.1:5500/admin-portal/index.html |

---

### Does Google Sign-In work on Live Server?

**Yes — Google login works on Live Server automatically.**

localhost and 127.0.0.1 are pre-authorized in Firebase by default. No setup needed.
Just open via Live Server and click "Continue with Google" — it works.

If Google login shows "unauthorized domain" error, do this once:
```
1. Go to: https://console.firebase.google.com
2. Click your project: tradelink-1c55b
3. Left menu → Authentication → click the Settings tab
4. Scroll down to "Authorized domains"
5. Check if localhost is listed — it should already be there
6. If not → click Add domain → type: localhost → click Add
7. Also add: 127.0.0.1
```

---

## Step 6 — Verify Everything is Working

Open these URLs in your browser:

| URL | Expected result |
|-----|----------------|
| http://localhost:8000 | {"status":"ok","app":"TradeLink API"} |
| http://localhost:8000/docs | Swagger UI showing all API routes |
| http://127.0.0.1:5500/TradeLink/seller-portal/index.html | Login screen with green theme |
| http://127.0.0.1:5500/TradeLink/merchant-portal/index.html | Login screen with blue theme |
| http://127.0.0.1:5500/admin-portal/index.html | Admin login screen |

---

## Quick Summary — What to Do Every Time

```
1. Open PowerShell
2. cd path\to\YOUR_REPO_NAME\backend
3. venv\Scripts\activate
4. uvicorn main:app --reload --host 0.0.0.0 --port 8000
5. Open VS Code → right-click index.html → Open with Live Server
```

That is it. Everything else (Firebase, Google Sheets, Razorpay) is online and stays connected automatically as long as you have internet.

---

## Folder Structure (what is in the project)

```
MY_MAJOR_PROJECT/
│
├── admin-portal/
│   ├── index.html                  ← Admin panel (KYC review, transport, stats)
│   └── admin.js                    ← Admin panel logic
│
├── backend/                        ← Python FastAPI server
│   ├── main.py                     ← Main API server (all routes)
│   ├── sheets.py                   ← Google Sheets database layer
│   ├── auth.py                     ← Firebase token verification
│   ├── config.py                   ← Loads .env settings
│   ├── models.py                   ← Request body validation
│   ├── admin.py                    ← Admin routes (KYC approve/reject)
│   ├── realtime.py                 ← Socket.IO WebSocket server
│   ├── shipping.py                 ← Shipping rate + tracking simulation
│   ├── shipping_router.py          ← Shipping API routes
│   ├── storage.py                  ← Google Drive file upload
│   ├── email_service.py            ← Gmail SMTP email sender
│   ├── setup_sheets.py             ← One-time: creates all Sheet tabs
│   ├── setup_sheets_shipping.py    ← One-time: adds shipping columns
│   ├── requirements.txt            ← All Python packages
│   ├── start-server.bat            ← Windows: double-click to start
│   ├── .env                        ← Secret keys (NOT in GitHub)
│   ├── service-account.json        ← GCP credentials (NOT in GitHub)
│   └── firebase-adminsdk.json      ← Firebase credentials (NOT in GitHub)
│
└── TradeLink/
    ├── seller-portal/
    │   ├── index.html              ← Seller portal (green theme)
    │   ├── seller.js               ← All seller portal logic
    │   ├── seller.css              ← Green theme styles
    │   ├── shipping.js             ← Shipping booking + tracking
    │   └── transport.js            ← Transport request form + payment
    ├── merchant-portal/
    │   ├── index.html              ← Merchant portal (blue theme)
    │   ├── merchant.js             ← All merchant portal logic
    │   └── merchant.css            ← Blue theme styles
    └── shared/
        ├── firebase-config.js      ← Firebase keys for browser
        ├── realtime.js             ← WebSocket client
        ├── utils.js                ← API helper functions
        └── style.css               ← Shared styles
```

---

## What Stays Online (you do not touch these)

| Service | What it does | Where to manage |
|---------|-------------|----------------|
| **Firebase Auth** | User login, Google OAuth, OTP | console.firebase.google.com |
| **Google Sheets** | Database — all users, listings, bids, deals | docs.google.com/spreadsheets |
| **Google Drive** | Stores uploaded images and KYC docs | drive.google.com |
| **Razorpay** | Test payment processing | dashboard.razorpay.com |
| **Gmail SMTP** | Sends confirmation emails | Already configured |

None of these need to be restarted or reconfigured. They just work as long as you have internet.

---

## Admin Panel Login

The admin panel asks for an admin key when you open it.

```
Admin URL:  http://127.0.0.1:5500/admin-portal/index.html
Admin Key:  admin123   (or whatever you set as ADMIN_SECRET_KEY in .env)
```

---

## Common Problems

| Problem | Fix |
|---------|-----|
| PowerShell says venv\Scripts\activate is not recognized | Run: Set-ExecutionPolicy RemoteSigned then try again |
| ModuleNotFoundError when starting server | Run pip install -r requirements.txt again |
| Browser shows file:// instead of http:// | Use Live Server — right-click index.html → Open with Live Server |
| Login shows red "Open via Live Server" banner | Same as above — you opened via file://, not Live Server |
| Google login says "unauthorized domain" | Firebase Console → Authentication → Settings → Authorized domains → add localhost |
| Google login popup closes immediately | Allow popups for 127.0.0.1 in your browser settings |
| 500 Internal Server Error on image upload | Check GDRIVE_FOLDER_ID is set correctly in .env |
| Server starts but Google Sheets gives error | Check service-account.json is in backend/ folder |
| Port 8000 already in use | Close the old PowerShell window running the server |
| (venv) not showing in prompt | Re-run venv\Scripts\activate from inside backend/ folder |
| Admin panel shows blank or no data | Check server is running at localhost:8000 and admin key matches .env |

---

*TradeLink — Local Quick Start. Backend on localhost:8000 · Frontend via Live Server on port 5500.*

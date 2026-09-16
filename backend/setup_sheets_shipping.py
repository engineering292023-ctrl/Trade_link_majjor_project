"""
TRADELINK — Shipping Sheet Migration  (backend/setup_sheets_shipping.py)

Run this ONCE to add the 3 new columns needed for AfterShip shipping
to your existing Transport_Requests tab in Google Sheets.

Usage:
  python setup_sheets_shipping.py

What it does:
  Checks if Transport_Requests tab already has these 3 columns.
  If not, adds them at the end of the header row:
    - courier_slug           (which courier: "bluedart", "delhivery" etc.)
    - tracking_number        (e.g. "123456789012")
    - aftership_tracking_url (e.g. "https://track.aftership.com/bluedart/123...")

Safe to run multiple times — skips columns that already exist.
Run AFTER setup_sheets.py (which creates the base Transport_Requests tab).
"""

import gspread
from google.oauth2.service_account import Credentials
from config import settings
import os

SCOPES = [
    "https://spreadsheets.google.com/feeds",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# The 3 columns this script adds
NEW_COLUMNS = ["courier_slug", "tracking_number", "aftership_tracking_url"]


def migrate():
    print("=" * 55)
    print("TradeLink -- Shipping Sheet Migration")
    print("Adds 3 AfterShip columns to Transport_Requests")
    print("=" * 55)

    # Check service account file exists
    if not os.path.exists(settings.GOOGLE_SERVICE_ACCOUNT_JSON):
        print("\nERROR: service-account.json not found at: " + settings.GOOGLE_SERVICE_ACCOUNT_JSON)
        print("   Run setup_sheets.py first to set that up.\n")
        return

    # Connect to Google Sheets
    try:
        creds  = Credentials.from_service_account_file(
            settings.GOOGLE_SERVICE_ACCOUNT_JSON, scopes=SCOPES
        )
        client = gspread.authorize(creds)
        sheet  = client.open_by_key(settings.GOOGLE_SHEET_ID)
        print("\nConnected to Google Sheets!")
    except Exception as e:
        print("\nConnection failed: " + str(e))
        print("   Make sure service-account.json is correct and sheet is shared.\n")
        return

    # Check Transport_Requests tab exists
    existing_tabs = [ws.title for ws in sheet.worksheets()]
    if "Transport_Requests" not in existing_tabs:
        print("\nERROR: Transport_Requests tab not found in your spreadsheet.")
        print("   Run: python setup_sheets.py first to create all base tabs.\n")
        return

    ws = sheet.worksheet("Transport_Requests")

    # Read current headers from row 1
    current_headers = ws.row_values(1)
    print("\n   Current column count: " + str(len(current_headers)))
    print("   Checking for: " + str(NEW_COLUMNS) + "\n")

    added = 0
    for col_name in NEW_COLUMNS:
        if col_name in current_headers:
            print("   OK  '" + col_name + "' already exists -- skipped")
        else:
            # Next empty column index (1-based)
            next_col_num  = len(current_headers) + 1
            col_letter    = _col_num_to_letter(next_col_num)
            # Write the header
            ws.update(col_letter + "1", [[col_name]])
            current_headers.append(col_name)
            print("   ADDED column '" + col_name + "' at column " + col_letter)
            added += 1

    print("\n" + ("=" * 55))
    if added > 0:
        print("Done! Added " + str(added) + " new column(s) to Transport_Requests.")
    else:
        print("All 3 columns already exist -- nothing to add.")

    print("""
Next steps:
  1. Copy shipping.py          -> backend/shipping.py
  2. Copy shipping_router.py   -> backend/shipping_router.py
  3. Copy shipping.js          -> TradeLink/seller-portal/shipping.js
  4. Edit backend/main.py      -> add shipping router (see README-STEP6-7.md)
  5. Edit backend/config.py    -> add AFTERSHIP_API_KEY setting
  6. Edit backend/.env         -> add your AfterShip API key
  7. Restart server: uvicorn main:app --reload
""")
    print("=" * 55 + "\n")


def _col_num_to_letter(n: int) -> str:
    """
    Converts a 1-based column number to Excel/Sheets column letters.
    Examples: 1->A, 26->Z, 27->AA, 28->AB
    Used to find the next empty column to write the header into.
    """
    result = ""
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result


if __name__ == "__main__":
    migrate()
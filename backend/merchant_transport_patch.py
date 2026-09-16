"""
Apply this script to your merchant-portal/index.html to add transport screens.
Run: python3 merchant_transport_patch.py
"""
import os, sys

html_path = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'TradeLink', 'merchant-portal', 'index.html')
)
if not os.path.exists(html_path):
    print("ERROR: merchant-portal/index.html not found at", html_path)
    sys.exit(1)

with open(html_path, 'rb') as f:
    content = f.read().decode('utf-8', errors='replace')

TRANSPORT_NAV = """        <div class="nav-item" onclick="navigate('transport', this)">
          <span class="nav-icon">🚛</span> Transport Requests
        </div>
        <div class="nav-item" onclick="navigate('my-deliveries', this)">
          <span class="nav-icon">📦</span> My Deliveries
        </div>
        <div class="nav-item" onclick="navigate('my-vehicles', this)">
          <span class="nav-icon">🔧</span> My Vehicles
        </div>"""

TRANSPORT_SCREENS = """
      <!-- TRANSPORT MARKETPLACE SCREEN -->
      <div id="screen-transport" class="screen">
        <div class="topbar">
          <div class="topbar-title">🚛 Transport Requests</div>
          <div class="topbar-sub">Browse open requests from sellers · Submit your best quote · Win bookings</div>
        </div>
        <div class="screen-body">
          <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;margin-bottom:16px;">
            <input class="form-control" type="text" id="tr-filter-from"
              placeholder="📦 From city (e.g. Bengaluru)" style="margin:0;">
            <input class="form-control" type="text" id="tr-filter-to"
              placeholder="🏪 To city (e.g. Mumbai)" style="margin:0;">
            <button class="btn primary" onclick="loadTransportMarketplace()">Search</button>
          </div>
          <div id="transport-market-list"></div>
        </div>
      </div>

      <!-- MY DELIVERIES SCREEN -->
      <div id="screen-my-deliveries" class="screen">
        <div class="topbar">
          <div class="topbar-title">📦 My Deliveries</div>
          <div class="topbar-sub">Active bookings · Update delivery status · Track on map</div>
        </div>
        <div class="screen-body">
          <div id="my-deliveries-list"></div>
        </div>
      </div>

      <!-- MY VEHICLES SCREEN -->
      <div id="screen-my-vehicles" class="screen">
        <div class="topbar">
          <div class="topbar-title">🔧 My Vehicles</div>
          <div class="topbar-sub">Register vehicles · Manage availability · View ratings</div>
        </div>
        <div class="screen-body">
          <div id="my-vehicles-list"></div>
        </div>
      </div>
"""

changed = 0

# Find nav section and add transport nav items before closing FINANCE section or before ACCOUNT section
for marker in ["<div class=\"nav-section\">ACCOUNT", "<div class='nav-section'>ACCOUNT",
               "nav-section\">Account", "nav-section'>Account"]:
    if marker in content:
        content = content.replace(marker, TRANSPORT_NAV + "\n\n      " + marker, 1)
        changed += 1
        print("Nav added before Account section")
        break

if not changed:
    # Find My Deals nav item and insert after it
    for marker in ["My Deals\n        </div>", "My Deals</div>"]:
        idx = content.find(marker)
        if idx != -1:
            insert_at = idx + len(marker)
            content = content[:insert_at] + "\n" + TRANSPORT_NAV + content[insert_at:]
            changed += 1
            print("Nav added after My Deals")
            break

if not changed:
    print("WARNING: Could not find nav insertion point. Add manually.")

# Add screens before closing app-shell
for marker in ["      </main>\n    </div><!-- end app-shell", "      </main>\n  </div>",
               "</main>", "    </div> <!-- app-shell"]:
    idx = content.find(marker)
    if idx != -1:
        content = content[:idx] + TRANSPORT_SCREENS + "\n" + content[idx:]
        print("Screens added before", repr(marker[:30]))
        changed += 1
        break

if changed >= 2:
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("\n✅ merchant-portal/index.html updated successfully!")
else:
    print("\n⚠️  Could not auto-patch. Copy screens manually into your HTML.")
    print("\n--- PASTE THIS NAV HTML after 'My Deals' nav item ---")
    print(TRANSPORT_NAV)
    print("\n--- PASTE THESE SCREENS before </main> ---")
    print(TRANSPORT_SCREENS)
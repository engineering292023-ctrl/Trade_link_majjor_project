"""
TRADELINK — Real-Time Engine  (backend/realtime.py)

WebSocket (Socket.IO) support for real-time bidding.

PACKAGE: python-socketio[asyncio_client]
INSTALL: pip install "python-socketio[asyncio_client]" python-engineio

HOW IT WORKS:
- Browser connects via Socket.IO (a WebSocket library)
- Users join "rooms" (channels) when they open the app
- When a bid is placed, server pushes to everyone in the relevant room
- No page refresh needed — updates appear instantly
"""

import socketio
import asyncio

# ─────────────────────────────────────────
# CREATE SOCKET.IO SERVER
# ─────────────────────────────────────────

# AsyncServer works with FastAPI (ASGI framework)
# cors_allowed_origins="*" allows browser to connect from localhost:5500
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)


# Wrap so it can be mounted inside FastAPI with app.mount()
# IMPORTANT: socketio_path must be "" here because FastAPI mount("/ws") already
# strips the "/ws" prefix — if we set socketio_path="socket.io" the full path
# becomes /ws/socket.io/socket.io which causes the WebSocket to fail.
socket_app = socketio.ASGIApp(
    sio,
    socketio_path=""  # path handled entirely by app.mount("/ws") in main.py
)


# ─────────────────────────────────────────
# CONNECTION / DISCONNECTION
# ─────────────────────────────────────────

@sio.event
async def connect(sid, environ, auth):
    """
    Called when a browser opens a WebSocket connection.
    sid  = unique session ID for this connection
    auth = { user_id: "..." } sent by browser on connect
    """
    user_id = ""
    if isinstance(auth, dict):
        user_id = auth.get("user_id", "")

    if user_id:
        await sio.enter_room(sid, f"user_{user_id}")
        print(f"✅ WS connected  user={user_id}  sid={sid[:8]}")
    else:
        print(f"WS connected (no auth) sid={sid[:8]}")


@sio.event
async def disconnect(sid):
    print(f"WS disconnected sid={sid[:8]}")


# ─────────────────────────────────────────
# ROOM JOIN / LEAVE  (called by browser)
# ─────────────────────────────────────────

@sio.event
async def join_listing(sid, data):
    """Browser calls when opening a listing modal."""
    if isinstance(data, dict):
        lid = data.get("listing_id", "")
        if lid:
            await sio.enter_room(sid, f"listing_{lid}")


@sio.event
async def leave_listing(sid, data):
    """Browser calls when closing a listing modal."""
    if isinstance(data, dict):
        lid = data.get("listing_id", "")
        if lid:
            await sio.leave_room(sid, f"listing_{lid}")


@sio.event
async def join_seller(sid, data):
    """Seller browser calls on login — gets bid notifications for all their listings."""
    if isinstance(data, dict):
        sid_val = data.get("seller_id", "")
        if sid_val:
            await sio.enter_room(sid, f"seller_{sid_val}")


@sio.event
async def join_transport(sid, data):
    """Browser joins a transport request room to get live GPS updates."""
    if isinstance(data, dict):
        req_id = data.get("request_id", "")
        if req_id:
            await sio.enter_room(sid, f"transport_{req_id}")


@sio.event
async def leave_transport(sid, data):
    if isinstance(data, dict):
        req_id = data.get("request_id", "")
        if req_id:
            await sio.leave_room(sid, f"transport_{req_id}")


# ─────────────────────────────────────────
# EMIT FUNCTIONS  (called by main.py)
# ─────────────────────────────────────────

async def emit_new_bid(listing_id: str, seller_id: str, bid_data: dict):
    """Push new bid to seller's Live Bids screen + everyone watching that listing."""
    payload = {"event": "new_bid", **bid_data}
    await sio.emit("new_bid", payload, room=f"listing_{listing_id}")
    await sio.emit("new_bid", payload, room=f"seller_{seller_id}")


async def emit_outbid(merchant_id: str, listing_data: dict):
    """Push 'You were outbid!' to the merchant who just lost top spot."""
    await sio.emit("outbid", {"event": "outbid", **listing_data},
                   room=f"user_{merchant_id}")


async def emit_bid_accepted(merchant_id: str, deal_data: dict):
    """Push 'You won!' to the winning merchant."""
    await sio.emit("bid_accepted", {"event": "bid_accepted", **deal_data},
                   room=f"user_{merchant_id}")


async def emit_auction_closed(listing_id: str, seller_id: str, data: dict):
    """Notify everyone the auction has ended."""
    payload = {"event": "auction_closed", **data}
    await sio.emit("auction_closed", payload, room=f"listing_{listing_id}")
    await sio.emit("auction_closed", payload, room=f"seller_{seller_id}")


async def emit_notification(user_id: str, notification: dict):
    """Push a notification so the badge count updates live."""
    await sio.emit("notification", {"event": "notification", **notification},
                   room=f"user_{user_id}")


async def emit_kyc_status_update(user_id: str, status: str):
    """Push KYC approval/rejection so the banner updates live."""
    await sio.emit("kyc_update", {"event": "kyc_update", "status": status},
                   room=f"user_{user_id}")

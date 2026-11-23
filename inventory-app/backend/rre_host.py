"""
RRE host for the ORIGINAL StockPilot inventory application.

This file is the only thing RRE adds around your inventory app; everything under app/ (the API) and ../frontend (the UI) is your
original code, unchanged. It does three things:

  1. serves the original, already-built web interface (../frontend/dist) from the same process as the API, so the UI is exactly
     the original one;
  2. lets RRE sign its administrator into the inventory app without a second password (a short-lived, single-use, signed token
     that only RRE's own server can create);
  3. lets RRE read a few facts it needs for accounting (see /api/rre/* below, all restricted to that same signed token).

Run:   python -m uvicorn rre_host:app --host 127.0.0.1 --port <port>      (RRE does this for you)
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from sqlalchemy import select

from app.main import app  # the original API, with all its routers
from app.core import SessionLocal
from app.models import User
from app.api import _issue, user_out

BRIDGE_SECRET = os.getenv("RRE_BRIDGE_SECRET", "").encode()
DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist")
_used: dict[str, float] = {}
_lock = threading.Lock()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify(token: str) -> dict:
    """A token is  base64url(json).base64url(hmac-sha256)  made by RRE with the shared secret. Valid for a minute, usable once."""
    if not BRIDGE_SECRET:
        raise HTTPException(404, "Not found")
    try:
        body, sig = token.split(".", 1)
        want = hmac.new(BRIDGE_SECRET, body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, _b64d(sig)):
            raise ValueError("signature")
        data = json.loads(_b64d(body))
    except Exception:
        raise HTTPException(401, "This sign-in link is not valid.")
    now = time.time()
    if not isinstance(data.get("exp"), (int, float)) or data["exp"] < now or data["exp"] > now + 300:
        raise HTTPException(401, "This sign-in link has expired. Open Inventory again from RRE.")
    jti = str(data.get("jti") or "")
    with _lock:
        for k in [k for k, v in _used.items() if v < now]:
            del _used[k]
        if not jti or jti in _used:
            raise HTTPException(401, "This sign-in link was already used.")
        _used[jti] = data["exp"]
    return data


@app.post("/api/rre/sso", tags=["rre"])
def rre_sso(body: dict, request: Request):
    """Signs in the inventory ADMINISTRATOR (the original owner account) on behalf of RRE's administrator."""
    data = _verify(str(body.get("token") or ""))
    if data.get("as") != "admin":
        raise HTTPException(403, "Only the administrator can be signed in this way.")
    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.role == "owner", User.is_active == True).order_by(User.id)).first()  # noqa: E712
        if user is None:
            raise HTTPException(409, "The inventory app has no owner account yet. Open it once and create the first administrator.")
        return {**_issue(db, user, True, request=request), "user": user_out(user, db)}


@app.get("/api/rre/ping", tags=["rre"])
def rre_ping():
    return {"ok": True, "app": "stockpilot", "version": app.version}


# ---- the original web interface ----------------------------------------------------------------------------------------
_BOOT = """<script>/* RRE: (1) sign in with the one-time link RRE opened this page with, or (2) start clean when RRE asks (?fresh=1). Nothing else here touches the original app */
(function(){try{var p=new URLSearchParams(location.search),t=p.get('sso'),f=p.get('fresh');if(!t&&!f)return;
function clear(){['sp_access','sp_refresh'].forEach(function(k){localStorage.removeItem(k);sessionStorage.removeItem(k);});}
if(f)clear();
if(t){var x=new XMLHttpRequest();x.open('POST','/api/rre/sso',false);x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify({token:t}));
if(x.status===200){var d=JSON.parse(x.responseText);clear();localStorage.setItem('sp_access',d.access_token);localStorage.setItem('sp_refresh',d.refresh_token);}else{clear();}}
p.delete('sso');p.delete('fresh');var q=p.toString();history.replaceState(null,'',location.pathname+(q?'?'+q:'')+location.hash);}catch(e){}})();</script>"""


def _index() -> HTMLResponse:
    with open(os.path.join(DIST, "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace("<head>", "<head>" + _BOOT, 1) if "<head>" in html else _BOOT + html
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    file = os.path.normpath(os.path.join(DIST, path))
    if path and file.startswith(os.path.normpath(DIST) + os.sep) and os.path.isfile(file):
        headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
        return FileResponse(file, headers=headers)
    return _index()

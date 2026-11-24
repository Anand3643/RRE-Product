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
from app.models import User, Organization, Warehouse
from app.api import _issue, user_out
from app.core import hash_password
import secrets
from datetime import datetime, timezone

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


ALLOWED_ROLES = {"accountant", "manager", "warehouse", "sales", "viewer"}  # what RRE may assign to an employee: never an administrator


def _project(db, data: dict, owner_login: bool):
    """Finds or creates the inventory-side record of an RRE account. It exists only so this application can attribute work to a person;
    it has no usable password (RRE is the only way in). RRE decides name, role and whether the person is active."""
    email = str(data.get("email") or "").strip().lower()
    org = db.scalars(select(Organization).order_by(Organization.id)).first()
    if owner_login:
        user = None
        if email:
            user = db.scalars(select(User).where(User.email == email)).first()
        if user is None or user.role != "owner":
            user = db.scalars(select(User).where(User.role == "owner", User.is_active == True).order_by(User.id)).first()  # noqa: E712
        if user is None:  # no owner yet: the RRE administrator is the owner
            email = email or "owner@rre-entries.app"
            if org is None:
                org = Organization(name="RRE Entries")
                db.add(org)
                db.flush()
                db.add(Warehouse(org_id=org.id, code="MAIN", name="Main Warehouse"))
            user = User(org_id=org.id, email=email, name=str(data.get("name") or "Administrator")[:120], role="owner", password_hash=hash_password(secrets.token_urlsafe(32)))
            db.add(user)
            db.flush()
        if user is None:
            raise HTTPException(409, "The inventory app has no owner account yet.")
        return user
    if not email or org is None:
        raise HTTPException(409, "Inventory is not ready for this account yet. Ask your administrator.")
    role = str(data.get("role") or "viewer")
    if role not in ALLOWED_ROLES:
        role = "viewer"
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is None:
        user = User(org_id=org.id, email=email, name=str(data.get("name") or email)[:120], role=role, password_hash=hash_password(secrets.token_urlsafe(32)))
        db.add(user)
        db.flush()
    elif user.role in ("owner", "admin") or user.role == "user":
        # an RRE employee is never merged into an inventory administrator or a portal customer by e-mail match
        raise HTTPException(409, "This e-mail address belongs to a different kind of inventory account. Ask your administrator.")
    else:
        user.name = str(data.get("name") or user.name)[:120]
        user.role = role
    user.is_active = bool(data.get("active", True))
    user.must_change_password = False
    user.failed_logins = 0
    user.locked_until = None
    return user


@app.post("/api/rre/sso", tags=["rre"])
def rre_sso(body: dict, request: Request):
    """Signs a person in to Inventory on behalf of RRE (their RRE session is the only credential). The signed link says who they are and
    which inventory role RRE gives them; an administrator in RRE is the inventory owner, nobody else is ever promoted."""
    data = _verify(str(body.get("token") or ""))
    kind = data.get("as")
    if kind not in ("admin", "user"):
        raise HTTPException(403, "This link cannot be used to sign in.")
    with SessionLocal() as db:
        user = _project(db, data, kind == "admin")
        if not user.is_active:
            raise HTTPException(403, "This account is deactivated. Contact your administrator.")
        user.last_login = datetime.now(timezone.utc)
        db.commit()
        return {**_issue(db, user, True, request=request), "user": user_out(user, db)}


@app.post("/api/rre/sync", tags=["rre"])
def rre_sync(body: dict):
    """RRE tells Inventory that an account changed (role, name, deactivated, signed out). The person's inventory sessions end at once."""
    data = _verify(str(body.get("token") or ""))
    if data.get("as") != "sync":
        raise HTTPException(403, "Not allowed.")
    email = str(data.get("email") or "").strip().lower()
    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.email == email)).first() if email else None
        if user is None:
            return {"ok": True, "found": False}
        role = str(data.get("role") or "")
        if user.role not in ("owner", "admin", "user") and role in ALLOWED_ROLES:
            user.role = role
        if user.role != "owner" or data.get("active") is False:
            user.is_active = bool(data.get("active", True))
        user.name = str(data.get("name") or user.name)[:120]
        user.tokens_valid_after = datetime.now(timezone.utc)
        db.commit()
        return {"ok": True, "found": True}


# The inventory application has no sign-in, registration, password or user administration of its own any more: people, roles and
# passwords live in RRE Entries (one login, one user list). These routes stay closed even if someone calls the API directly.
_CLOSED = ("/api/auth/login", "/api/auth/signup", "/api/auth/forgot", "/api/auth/reset", "/api/auth/change-password")


_LAST = [time.time()]


@app.middleware("http")
async def _one_identity(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/rre/"):
        _LAST[0] = time.time()  # real use (not RRE's own checks): lets RRE stop an idle customer inventory
    if path in _CLOSED or path == "/api/users" or path.startswith("/api/users/") and not path.startswith("/api/users/directory"):
        return JSONResponse({"detail": "Accounts are managed in RRE Entries. Sign in there."}, status_code=410)
    return await call_next(request)


@app.get("/api/rre/ping", tags=["rre"])
def rre_ping():
    return {"ok": True, "app": "stockpilot", "version": app.version, "idle_seconds": int(time.time() - _LAST[0])}


# ---- the original web interface ----------------------------------------------------------------------------------------
_BOOT = r"""<script>/* RRE: (1) sign in with the one-time link RRE opened this page with (there is no separate inventory login), (2) follow RRE's Light / Dark choice, (3) if the session ends, return to RRE. Nothing else here touches the original app */
(function(){try{var d0=document.documentElement;function mode(m){if(m==='dark'||m==='light'){d0.classList.toggle('dark',m==='dark');try{localStorage.setItem('sp_theme',m);}catch(e){}}}
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(d&&d.rre==='theme')mode(d.mode);});
var p=new URLSearchParams(location.search),t=p.get('sso'),m=p.get('mode');if(m)mode(m);
function clear(){['sp_access','sp_refresh'].forEach(function(k){localStorage.removeItem(k);sessionStorage.removeItem(k);});}
var NOLOGIN=/^\/(login|signup|register|forgot-password|reset-password)(\/|$)/;
function guard(){if(NOLOGIN.test(location.pathname))location.replace('/rre-signin');}
guard();setInterval(guard,400);
if(t){var x=new XMLHttpRequest();x.open('POST','/api/rre/sso',false);x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify({token:t}));
if(x.status===200){var d=JSON.parse(x.responseText);clear();localStorage.setItem('sp_access',d.access_token);localStorage.setItem('sp_refresh',d.refresh_token);}else{clear();location.replace('/rre-signin?e='+x.status);}}
else if(!localStorage.getItem('sp_access')&&!localStorage.getItem('sp_refresh')&&location.pathname!=='/rre-signin'){location.replace('/rre-signin');}
p.delete('sso');p.delete('mode');var q=p.toString();history.replaceState(null,'',location.pathname+(q?'?'+q:'')+location.hash);}catch(e){}})();</script>"""

_SIGNIN_PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inventory</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#0b1424;color:#eef3ff}
.c{max-width:380px;padding:30px;text-align:center;border:1px solid rgba(150,175,255,.25);border-radius:18px;background:rgba(20,30,56,.7)}h1{font-size:20px;margin:0 0 8px}p{color:#a9b6d3;font-size:14px;line-height:1.5}
a{display:inline-block;margin-top:14px;padding:11px 20px;border-radius:12px;background:linear-gradient(135deg,#f59e0b,#fcd34d);color:#1a1305;font-weight:700;text-decoration:none}</style></head>
<body><div class="c"><h1>Sign in to RRE Entries</h1><p>Inventory is part of RRE Entries and uses your RRE sign-in. Open it from RRE Entries and you will be signed in automatically.</p><a href="__HOME__" target="_top">Go to RRE Entries</a></div>
<script>try{window.parent!==window&&window.parent.postMessage({rre:'inventory-signed-out'},'*');}catch(e){}</script></body></html>"""
RRE_HOME = os.getenv("RRE_HOME_URL", "http://127.0.0.1:4000").rstrip("/") + "/login.html"


@app.get("/rre-signin", include_in_schema=False)
def rre_signin():
    return HTMLResponse(_SIGNIN_PAGE.replace("__HOME__", RRE_HOME), headers={"Cache-Control": "no-store"})


# RRE look for the inventory screens (colours and shapes only), loaded after the application's own style sheet
_THEME_LINK = '<link rel="stylesheet" href="/rre-theme.css"><style>a[href="/team"],a[href="/login-activity"],a[href="/users"],a[href="/sessions"]{display:none!important}</style>'  # users are managed in RRE: its own user screens are hidden
THEME_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rre_theme.css")


@app.get("/rre-theme.css", include_in_schema=False)
def rre_theme():
    return FileResponse(THEME_FILE, media_type="text/css", headers={"Cache-Control": "no-cache"})


def _index() -> HTMLResponse:
    with open(os.path.join(DIST, "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace("<head>", "<head>" + _BOOT, 1) if "<head>" in html else _BOOT + html
    html = html.replace("</head>", _THEME_LINK + "</head>", 1) if "</head>" in html else html
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

"""Phase 1 REST API: auth, users, products, warehouses, inventory, dashboard, notifications, audit."""
import csv
import functools
import hashlib
import io
import os
import random
import secrets
import time
from datetime import date, timedelta, timezone
from decimal import Decimal
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .sequences import next_number
from .core import (ROLES, REFRESH_DAYS, ACCESS_MINUTES, can, decode_token, effective_permissions, get_db, hash_password,
                   is_admin, legacy_permissions, make_token, now, verify_password)
from .models import (AuditLog, Category, Customer, Notification, Organization, PasswordReset, Product, RefreshToken, StockBalance,
                     StockMovement, User, Warehouse)
from . import monitor as mon
from . import stock as stk
from . import whlogic as whl
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
router = APIRouter(prefix="/api")
D = Decimal


# ---------- dependencies ----------
ALLOW_SIGNUP = lambda: os.getenv("ALLOW_SIGNUP", "1").lower() in ("1", "true", "yes")  # noqa: E731 (read per call)
MAX_FAILS = int(os.getenv("LOGIN_MAX_FAILS", "5"))
LOCK_MINUTES = int(os.getenv("LOGIN_LOCK_MINUTES", "15"))
REMEMBER_DAYS = REFRESH_DAYS
SESSION_DAYS = 1                     # refresh lifetime when "remember me" is off
_PW_CHANGE_OK = ("/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/refresh")
_ip_fails: dict[str, list[float]] = {}
_email_fails: dict[str, list[float]] = {}   # unknown / unlockable accounts are throttled here too
_DUMMY_HASH = hash_password("not-a-real-password")  # equalises timing for unknown e-mails


def aware(dt):
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


def _recent(bucket: dict, key: str, window: int = 900) -> list[float]:
    cut = time.time() - window
    bucket[key] = [t for t in bucket.get(key, []) if t > cut]
    return bucket[key]


def check_password_strength(pw: str):
    if len(pw) < 8 or not any(c.isalpha() for c in pw) or not any(c.isdigit() for c in pw):
        raise HTTPException(422, "Password must be at least 8 characters and contain a letter and a number")
    if len(pw.encode()) > 72:
        raise HTTPException(422, "Password is too long (72 bytes maximum)")


def current_user(request: Request, token: str = Depends(oauth2), db: Session = Depends(get_db)) -> User:
    try:
        data = decode_token(token, "access")
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    user = db.get(User, int(data["sub"]))
    if not user or not user.is_active:
        raise HTTPException(401, "User disabled")
    tva = aware(user.tokens_valid_after)
    if tva is not None and float(data.get("iat", 0)) < tva.timestamp():
        raise HTTPException(401, "Session expired - please sign in again", headers={"WWW-Authenticate": "Bearer"})
    # server-side session: revoked (logout / admin termination / deactivation) or idle-expired sessions are dead
    sess = mon.get_session(db, data.get("sid"))
    if sess is None or sess.user_id != user.id or not mon.is_valid(sess):
        if sess is not None and sess.session_status == "active":
            sess.session_status, sess.end_reason = "expired", "timeout"
            mon.log_event(db, event_type="session_expired", user=user, session_id=sess.id)
            db.commit()
        raise HTTPException(401, "Session ended - please sign in again", headers={"WWW-Authenticate": "Bearer"})
    if request.headers.get("x-background") != "1":   # automatic polling must not keep a session "active"
        mon.touch(db, sess)
    request.state.session = sess
    if user.must_change_password and request.url.path not in _PW_CHANGE_OK:
        raise HTTPException(403, "You must change your password before continuing")
    return user


_APPROVE = {"confirm", "approve", "issue"}
_REMOVE = {"cancel", "void"}


def action_for(request: Request, level: str) -> str:
    """Granular action a request represents. Read routes are 'view' (or 'export'); write routes map from the
    HTTP method / verb in the path."""
    path = request.url.path
    last = path.rstrip("/").rsplit("/", 1)[-1]
    if level == "r":
        return "export" if "/export" in path or last.startswith("export") else "view"
    if request.method == "DELETE" or last in _REMOVE:
        return "delete"
    if last in _APPROVE:
        return "approve"
    if request.method in ("PATCH", "PUT"):
        return "edit"
    return "create"


def require(module: str, level: str = "r"):
    def dep(request: Request, user: User = Depends(current_user)) -> User:
        action = action_for(request, level)
        if not can(user, module, level, action=action):
            raise HTTPException(403, f"You don't have permission to {action} {module}")
        return user
    return dep


def require_admin(user: User = Depends(current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(403, "Administrator access required")
    return user


def org_of(db: Session, user: User) -> Organization:
    return db.get(Organization, user.org_id)


def audit(db, user, action, entity, entity_id=None, detail=None):
    db.add(AuditLog(org_id=user.org_id, user_id=user.id, action=action, entity=entity,
                    entity_id=str(entity_id) if entity_id is not None else None, detail=detail))


def stock_guard(fn):
    """Translate StockError into HTTP errors."""
    @functools.wraps(fn)  # keeps the signature visible to FastAPI
    def wrap(*a, **k):
        try:
            return fn(*a, **k)
        except stk.StockError as e:
            k["db"].rollback()
            raise HTTPException(e.status, str(e))
    return wrap


# ---------- auth ----------
class SignupIn(BaseModel):
    org_name: Optional[str] = Field(default=None, max_length=200)   # only used by the very first (administrator) registration
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)


class RefreshIn(BaseModel):
    refresh_token: str


def revoke_sessions(db, user, reason: str = "credentials_changed", by: int | None = None, keep_sid_hash: str | None = None):
    """Kill every refresh token, every access token issued before now, and every monitored session."""
    for rt in db.scalars(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked.is_(False))):
        rt.revoked = True
    user.tokens_valid_after = now()
    mon.end_user_sessions(db, user.id, "terminated", reason, by, keep_sid_hash)


def _issue(db, user, remember: bool = True, request: Request | None = None, sid: str | None = None):
    """Mints a token pair. With no `sid` a new monitored session (one signed-in device) is started."""
    days = REMEMBER_DAYS if remember else SESSION_DAYS
    ref_tmp_sid = sid or mon.new_sid()
    acc, _, _ = make_token(user.id, "access", minutes=ACCESS_MINUTES, sid=ref_tmp_sid)
    ref, jti, exp = make_token(user.id, "refresh", days=days, sid=ref_tmp_sid)
    db.add(RefreshToken(user_id=user.id, jti=jti, expires_at=exp))
    if sid is None:
        mon.start_session(db, user, request, exp, ref_tmp_sid)
    else:
        s = mon.get_session(db, sid)
        if s is not None:
            s.expires_at = exp
    db.commit()
    return {"access_token": acc, "refresh_token": ref, "token_type": "bearer"}


def _no_users(db) -> bool:
    return (db.scalar(select(func.count(User.id))) or 0) == 0


@router.get("/auth/config", tags=["auth"])
def auth_config(db: Session = Depends(get_db)):
    first = _no_users(db)
    return {"first_run": first, "signup_enabled": first or ALLOW_SIGNUP(), "lockout_attempts": MAX_FAILS, "lockout_minutes": LOCK_MINUTES}


@router.post("/auth/signup", tags=["auth"], status_code=201)
def signup(request: Request, body: SignupIn, db: Session = Depends(get_db)):
    """Registration never grants administrator rights to an ordinary registrant:
      * the very first account in an empty system becomes the administrator (it creates the organisation);
      * every later registration becomes a USER (portal account) attached to the existing organisation, with its
        own customer record so it only ever sees its own orders.
    ALLOW_ORG_SIGNUP=1 restores one-organisation-per-signup and exists only for the automated test suites."""
    first = _no_users(db)
    org_mode = first or os.getenv("ALLOW_ORG_SIGNUP", "0") == "1"
    if not first and not ALLOW_SIGNUP():
        raise HTTPException(403, "Self-registration is disabled. Ask your administrator for an account.")
    if db.scalars(select(User).where(User.email == body.email.lower())).first():
        raise HTTPException(409, "Email already registered")
    if org_mode:
        if not body.org_name or len(body.org_name.strip()) < 2:
            raise HTTPException(422, "Organisation name is required")
        org = Organization(name=body.org_name.strip())
        db.add(org)
        db.flush()
        user = User(org_id=org.id, email=body.email.lower(), name=body.name, role="owner",
                    password_hash=hash_password(body.password), last_login=now())
        db.add(user)
        db.flush()
        db.add(Warehouse(org_id=org.id, code="MAIN", name="Main Warehouse"))
        audit(db, user, "signup", "organization", org.id, {"role": "owner", "first_account": first})
    else:
        org = db.scalars(select(Organization).order_by(Organization.id)).first()
        cust = Customer(org_id=org.id, code=next_number(db, org.id, "CUS"), name=body.name.strip(), email=body.email.lower(), customer_type="individual", payment_terms=0)
        db.add(cust)
        db.flush()
        user = User(org_id=org.id, email=body.email.lower(), name=body.name.strip(), role="user", customer_id=cust.id,
                    password_hash=hash_password(body.password), last_login=now())
        db.add(user)
        db.flush()
        audit(db, user, "signup", "user", user.id, {"role": "user", "customer_id": cust.id})
    return _issue(db, user, request=request)


def _fail(db, request, email, category, user=None, status=401, msg="Incorrect email or password", detail=None):
    mon.log_event(db, event_type="login_failed", request=request, user=user, email=email, failure=category, detail=detail)
    db.commit()
    raise HTTPException(status, msg)


@router.post("/auth/login", tags=["auth"])
def login(request: Request, remember: bool = Query(True), form: OAuth2PasswordRequestForm = Depends(),
          db: Session = Depends(get_db)):
    email = form.username.strip().lower()
    ip = mon.client_ip(request) or "?"
    if len(_recent(_ip_fails, ip, 300)) >= 30:
        _fail(db, request, email, "throttled", status=429, msg="Too many failed attempts from this address. Try again in a few minutes.")
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is None:  # unknown e-mail: same work, same message, same throttling as a wrong password
        verify_password(form.password, _DUMMY_HASH)
        if len(_recent(_email_fails, email)) >= MAX_FAILS:
            _fail(db, request, email, "throttled", status=429, msg=f"Too many failed attempts. Try again in {LOCK_MINUTES} minutes.")
        _ip_fails.setdefault(ip, []).append(time.time())
        _email_fails.setdefault(email, []).append(time.time())
        _fail(db, request, email, "unknown_account")
    locked = aware(user.locked_until)
    if locked and locked > now():
        mins = max(1, int((locked - now()).total_seconds() // 60) + 1)
        _fail(db, request, email, "account_locked", user=user, status=429,
              msg=f"Too many failed attempts. Try again in {mins} minute{'s' if mins != 1 else ''}.")
    if not verify_password(form.password, user.password_hash):
        user.failed_logins = (user.failed_logins or 0) + 1
        _ip_fails.setdefault(ip, []).append(time.time())
        detail = {"ip": ip}
        if user.failed_logins >= MAX_FAILS:
            user.locked_until = now() + timedelta(minutes=LOCK_MINUTES)
            user.failed_logins = 0
            detail["locked_minutes"] = LOCK_MINUTES
        audit(db, user, "login_failed", "user", user.id, detail)
        _fail(db, request, email, "wrong_password", user=user)
    if not user.is_active:  # only reveals the reason once the password is proven correct
        audit(db, user, "login_blocked", "user", user.id, {"reason": "deactivated"})
        _fail(db, request, email, "account_deactivated", user=user, status=403,
              msg="This account has been deactivated. Contact your administrator.")
    user.failed_logins = 0
    user.locked_until = None
    user.last_login = now()
    audit(db, user, "login", "user", user.id, {"ip": ip})
    return {**_issue(db, user, remember, request=request), "user": user_out(user, db)}


@router.post("/auth/refresh", tags=["auth"])
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        data = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid refresh token")
    rt = db.scalars(select(RefreshToken).where(RefreshToken.jti == data["jti"])).first()
    if not rt or rt.revoked:
        raise HTTPException(401, "Refresh token revoked")
    rt.revoked = True  # rotation: each refresh token is single-use
    user = db.get(User, rt.user_id)
    if not user or not user.is_active:
        raise HTTPException(401, "User disabled")
    tva = aware(user.tokens_valid_after)
    if tva is not None and float(data.get("iat", 0)) < tva.timestamp():
        db.commit()
        raise HTTPException(401, "Session expired - please sign in again")
    sess = mon.get_session(db, data.get("sid"))
    if sess is None or sess.user_id != user.id or not mon.is_valid(sess):  # logged out, terminated or idle too long
        if sess is not None and sess.session_status == "active":
            sess.session_status, sess.end_reason = "expired", "timeout"
            mon.log_event(db, event_type="session_expired", user=user, session_id=sess.id)
        db.commit()
        raise HTTPException(401, "Session ended - please sign in again")
    remaining = aware(rt.expires_at) - now()
    return _issue(db, user, remember=remaining > timedelta(days=SESSION_DAYS, hours=1), sid=data["sid"])


@router.post("/auth/logout", tags=["auth"], status_code=204)
def logout(request: Request, body: RefreshIn, db: Session = Depends(get_db)):
    try:
        data = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        return
    rt = db.scalars(select(RefreshToken).where(RefreshToken.jti == data["jti"])).first()
    if rt:
        rt.revoked = True
        u = db.get(User, rt.user_id)
        if u:
            audit(db, u, "logout", "user", u.id)
            s = mon.get_session(db, data.get("sid"))
            if s is not None and s.session_status == "active":
                s.session_status, s.logout_at, s.end_reason = "logged_out", now(), "user_logout"
                mon.log_event(db, event_type="logout", request=request, user=u, session_id=s.id)
        db.commit()


def user_out(u: User, db: Session):
    org = db.get(Organization, u.org_id)
    adm = is_admin(u)
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "is_admin": adm,
            "home": "/admin/dashboard" if adm else "/user/dashboard", "customer_id": u.customer_id, "department": u.department, "phone": u.phone,
            "must_change_password": bool(u.must_change_password),
            "org": {"id": org.id, "name": org.name, "currency": org.currency,
                    "allow_negative_stock": org.allow_negative_stock, "gstin": org.gstin, "state": org.state},
            "permissions": legacy_permissions(u), "actions": effective_permissions(u)}


@router.get("/auth/me", tags=["auth"])
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return user_out(user, db)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


@router.post("/auth/change-password", tags=["auth"])
def change_password(request: Request, body: ChangePasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(403, "Current password is incorrect")
    check_password_strength(body.new_password)
    if body.new_password == body.current_password:
        raise HTTPException(422, "Choose a password different from the current one")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    revoke_sessions(db, user, "password_changed")
    audit(db, user, "password_changed", "user", user.id)
    db.flush()
    return _issue(db, user, request=request)  # fresh session for this device; every other session is signed out


class ForgotIn(BaseModel):
    email: EmailStr


@router.post("/auth/forgot", tags=["auth"])
def forgot(body: ForgotIn, db: Session = Depends(get_db)):
    """Flags the request for administrators, who issue a one-time reset link or temporary password.
    The reply never reveals whether the e-mail exists."""
    u = db.scalars(select(User).where(User.email == body.email.lower())).first()
    if u and u.is_active:
        u.reset_requested_at = now()
        audit(db, u, "password_reset_requested", "user", u.id)
        db.commit()
    return {"message": "If that e-mail belongs to an active account, your request has been sent to the administrator for approval. Once approved, they will send you a one-time reset link."}


class ResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=8, max_length=72)


@router.post("/auth/reset", tags=["auth"])
def reset_password(body: ResetIn, db: Session = Depends(get_db)):
    th = hashlib.sha256(body.token.encode()).hexdigest()
    pr = db.scalars(select(PasswordReset).where(PasswordReset.token_hash == th)).first()
    if not pr or pr.used_at or aware(pr.expires_at) < now():
        raise HTTPException(400, "This reset link is invalid or has expired")
    user = db.get(User, pr.user_id)
    if not user or not user.is_active:
        raise HTTPException(400, "This reset link is invalid or has expired")
    check_password_strength(body.new_password)
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.failed_logins, user.locked_until, user.reset_requested_at = 0, None, None
    pr.used_at = now()
    revoke_sessions(db, user)
    audit(db, user, "password_reset", "user", user.id)
    db.commit()
    return {"ok": True}


# ---------- categories ----------
@router.get("/categories", tags=["products"])
def categories(user: User = Depends(require("products")), db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name} for c in
            db.scalars(select(Category).where(Category.org_id == user.org_id).order_by(Category.name))]


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/categories", tags=["products"], status_code=201)
def create_category(body: CategoryIn, user: User = Depends(require("products", "w")), db: Session = Depends(get_db)):
    c = Category(org_id=user.org_id, name=body.name.strip())
    db.add(c)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Category already exists")
    return {"id": c.id, "name": c.name}


# ---------- products ----------
def ean13(seed: int) -> str:
    digits = f"200{seed:09d}"[:12]
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(digits))
    return digits + str((10 - s % 10) % 10)


def _totals(db, org_id):
    rows = db.execute(select(StockBalance.product_id, func.sum(StockBalance.on_hand), func.sum(StockBalance.reserved),
                             func.sum(StockBalance.damaged)).where(StockBalance.org_id == org_id)
                      .group_by(StockBalance.product_id)).all()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


# NOTE: items/products endpoints live in items_api.py

# ---------- inventory ----------
class AdjustIn(BaseModel):
    product_id: int
    warehouse_id: int
    mode: str = Field(pattern="^(increase|decrease|set|damage)$")
    quantity: Decimal = Field(ge=0)
    unit_cost: Optional[Decimal] = Field(default=None, ge=0)
    reason: str = Field(min_length=3, max_length=300)
    idempotency_key: Optional[str] = Field(default=None, max_length=80)


class TransferIn(BaseModel):
    product_id: int
    from_warehouse_id: int
    to_warehouse_id: int
    quantity: Decimal = Field(gt=0)
    reason: Optional[str] = None
    idempotency_key: Optional[str] = Field(default=None, max_length=80)


def mv_out(m: StockMovement, names=None):
    return {"id": m.id, "product_id": m.product_id, "warehouse_id": m.warehouse_id, "type": m.type,
            "qty_delta": float(m.qty_delta), "reserved_delta": float(m.reserved_delta),
            "on_hand_after": float(m.on_hand_after), "reserved_after": float(m.reserved_after),
            "unit_cost": float(m.unit_cost) if m.unit_cost is not None else None, "ref_type": m.ref_type,
            "ref_id": m.ref_id, "reason": m.reason, "user_id": m.user_id, "created_at": m.created_at,
            **(names(m) if names else {})}


@router.post("/inventory/adjust", tags=["inventory"], status_code=201)
@stock_guard
def adjust(body: AdjustIn, user: User = Depends(require("inventory", "w")), db: Session = Depends(get_db)):
    org = org_of(db, user)
    q = body.quantity
    m = stk.adjust_stock(db, org, product_id=body.product_id, warehouse_id=body.warehouse_id, mode=body.mode, quantity=q, reason=body.reason,
                         user_id=user.id, unit_cost=body.unit_cost, idempotency_key=body.idempotency_key)
    audit(db, user, "adjust", "stock", m.id, {"mode": body.mode, "qty": str(q), "reason": body.reason})
    db.commit()
    return mv_out(m)


@router.post("/inventory/transfer", tags=["inventory"], status_code=201)
@stock_guard
def do_transfer(body: TransferIn, user: User = Depends(require("inventory", "w")), db: Session = Depends(get_db)):
    org = org_of(db, user)
    out, inn = stk.transfer(db, org, product_id=body.product_id, from_wh=body.from_warehouse_id,
                            to_wh=body.to_warehouse_id, qty=body.quantity, user_id=user.id, reason=body.reason,
                            idempotency_key=body.idempotency_key)
    audit(db, user, "transfer", "stock", out.id, {"qty": str(body.quantity), "from": body.from_warehouse_id,
                                                  "to": body.to_warehouse_id})
    db.commit()
    return {"out": mv_out(out), "in": mv_out(inn)}


@router.post("/inventory/receive", tags=["inventory"], status_code=201)
@stock_guard
def receive(body: AdjustIn, user: User = Depends(require("inventory", "w")), db: Session = Depends(get_db)):
    """Goods receipt (manual until purchase orders arrive in Phase 2)."""
    if body.quantity <= 0:
        raise HTTPException(422, "Quantity must be greater than zero")
    org = org_of(db, user)
    m = stk.apply_movement(db, org, product_id=body.product_id, warehouse_id=body.warehouse_id, type="receipt",
                           qty_delta=body.quantity, unit_cost=body.unit_cost, reason=body.reason, user_id=user.id,
                           idempotency_key=body.idempotency_key)
    audit(db, user, "receive", "stock", m.id, {"qty": str(body.quantity)})
    db.commit()
    return mv_out(m)


@router.get("/inventory/stock", tags=["inventory"])
def stock_levels(warehouse_id: Optional[int] = None, q: Optional[str] = None,
                 user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    stmt = (select(StockBalance, Product, Warehouse).join(Product, Product.id == StockBalance.product_id)
            .join(Warehouse, Warehouse.id == StockBalance.warehouse_id).where(StockBalance.org_id == user.org_id))
    if warehouse_id:
        stmt = stmt.where(StockBalance.warehouse_id == warehouse_id)
    if q:
        stmt = stmt.where(or_(Product.name.ilike(f"%{q}%"), Product.sku.ilike(f"%{q}%")))
    return [{"product_id": p.id, "sku": p.sku, "name": p.name, "warehouse_id": w.id, "warehouse": w.code,
             "on_hand": float(b.on_hand), "reserved": float(b.reserved), "damaged": float(b.damaged),
             "available": float(b.on_hand - b.reserved), "value": float(b.on_hand * (p.avg_cost or 0))}
            for b, p, w in db.execute(stmt.order_by(Product.name, Warehouse.code))]


@router.get("/inventory/movements", tags=["inventory"])
def movements(product_id: Optional[int] = None, warehouse_id: Optional[int] = None, type: Optional[str] = None,
              page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
              user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    stmt = select(StockMovement).where(StockMovement.org_id == user.org_id)
    if product_id:
        stmt = stmt.where(StockMovement.product_id == product_id)
    if warehouse_id:
        stmt = stmt.where(StockMovement.warehouse_id == warehouse_id)
    if type:
        stmt = stmt.where(StockMovement.type == type)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(StockMovement.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    pn = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_({m.product_id for m in rows} or {0})))}
    wn = {w.id: w for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    names = lambda m: {"sku": pn[m.product_id].sku, "product": pn[m.product_id].name,
                       "warehouse": wn[m.warehouse_id].code}
    return {"total": total, "items": [mv_out(m, names) for m in rows]}


# ---------- dashboard / notifications / audit ----------
@router.get("/dashboard", tags=["dashboard"])
def dashboard(date_from: Optional[date] = None, date_to: Optional[date] = None, warehouse_id: Optional[int] = None,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    oid = user.org_id
    if warehouse_id and not db.scalars(select(Warehouse.id).where(Warehouse.id == warehouse_id, Warehouse.org_id == oid)).first():
        raise HTTPException(422, "Unknown warehouse")
    prods = db.scalars(select(Product).where(Product.org_id == oid, Product.is_archived.is_(False))).all()
    totals = _totals(db, oid)
    on_hand = sum(float(t[0] or 0) for t in totals.values())
    reserved = sum(float(t[1] or 0) for t in totals.values())
    value = db.scalar(select(func.coalesce(func.sum(StockBalance.on_hand * Product.avg_cost), 0))
                      .join(Product, Product.id == StockBalance.product_id).where(StockBalance.org_id == oid))
    low, out = [], []
    for p in prods:
        t = totals.get(p.id, (0, 0, 0))
        avail = float((t[0] or 0) - (t[1] or 0))
        row = {"id": p.id, "sku": p.sku, "name": p.name, "available": avail, "reorder_point": float(p.reorder_point)}
        if avail <= 0:
            out.append(row)
        elif p.reorder_point and avail <= p.reorder_point:
            low.append(row)
    wh = [{"name": w["name"], "code": w["code"], "on_hand": w["on_hand"]} for w in
          whl.warehouse_summaries(db, oid) if w["is_active"]] if can(user, "warehouses", "r") else []
    since = now() - timedelta(days=30)
    trend: dict[str, dict] = {}
    for m in db.scalars(select(StockMovement).where(StockMovement.org_id == oid, StockMovement.created_at >= since,
                                                    StockMovement.qty_delta != 0,
                                                    StockMovement.type.notin_(["transfer_in", "transfer_out"]))):
        d = m.created_at.date().isoformat()
        e = trend.setdefault(d, {"date": d, "inbound": 0.0, "outbound": 0.0})
        e["inbound" if m.qty_delta > 0 else "outbound"] += abs(float(m.qty_delta))
    recent = db.scalars(select(StockMovement).where(StockMovement.org_id == oid).order_by(StockMovement.id.desc())
                        .limit(8)).all()
    pn = {p.id: p for p in prods}
    if warehouse_id:  # stock figures for a single warehouse
        rows = whl.item_rows(db, oid, warehouse_id)
        on_hand, reserved, value = sum(r["on_hand"] for r in rows), sum(r["reserved"] for r in rows), sum(r["value"] for r in rows)
        low = [{"id": r["product_id"], "sku": r["sku"], "name": r["name"], "available": r["available"], "reorder_point": r["reorder_point"]} for r in rows if r["status"] == "low"]
        out = [{"id": r["product_id"], "sku": r["sku"], "name": r["name"], "available": r["available"], "reorder_point": r["reorder_point"]} for r in rows if r["status"] == "out"]
        wh = [w for w in wh if w["code"] == next((r["warehouse"] for r in rows), None)] or wh[:0]
    from .reports_api import dashboard_extras
    extras = dashboard_extras(db, user, date_from, date_to, warehouse_id)
    res = {**extras, "products": len(prods), "variants": sum(1 for p in prods if p.parent_id), "on_hand": on_hand,
           "reserved": reserved, "available": on_hand - reserved, "inventory_value": float(value or 0),
           "low_stock": low, "out_of_stock": out, "warehouses": wh,
           "movement_trend": sorted(trend.values(), key=lambda x: x["date"]),
           "recent": [{"id": m.id, "type": m.type, "qty_delta": float(m.qty_delta), "created_at": m.created_at,
                       "product": pn[m.product_id].name if m.product_id in pn else str(m.product_id)}
                      for m in recent]}
    # only reveal what the caller may see
    if not can(user, "products", "r"):
        res["products"] = res["variants"] = None
    if not can(user, "inventory", "r"):
        res.update(on_hand=None, reserved=None, available=None, inventory_value=None, low_stock=[], out_of_stock=[],
                   movement_trend=[], recent=[])
    res["visible"] = {m: can(user, m, "r") for m in ("products", "inventory", "warehouses", "sales", "purchases", "fulfilment", "reports", "users")}
    return res


@router.get("/notifications", tags=["notifications"])
def notifications(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.org_id == user.org_id)
                      .order_by(Notification.id.desc()).limit(50)).all()
    return {"unread": sum(1 for n in rows if not n.is_read),
            "items": [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "is_read": n.is_read,
                       "created_at": n.created_at} for n in rows]}


@router.post("/notifications/read-all", tags=["notifications"], status_code=204)
def read_all(user: User = Depends(current_user), db: Session = Depends(get_db)):
    for n in db.scalars(select(Notification).where(Notification.org_id == user.org_id,
                                                   Notification.is_read.is_(False))):
        n.is_read = True
    db.commit()


@router.get("/audit-logs", tags=["audit"])
def audit_logs(page: int = Query(1, ge=1), user: User = Depends(require("users")), db: Session = Depends(get_db)):
    rows = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id).order_by(AuditLog.id.desc())
                      .offset((page - 1) * 50).limit(50)).all()
    return [{"id": a.id, "user_id": a.user_id, "action": a.action, "entity": a.entity, "entity_id": a.entity_id,
             "detail": a.detail, "created_at": a.created_at} for a in rows]




"""Login/session monitoring helpers (no HTTP routes here; see monitor_api.py).

Session identity: every access/refresh token carries a random `sid`. Only sha256(sid) is stored, so a database
leak cannot be replayed. A session is *valid* when its status is 'active', it has not passed expires_at and it has
had activity within SESSION_IDLE_MINUTES. It is shown as *Active* only when it also had activity within
SESSION_ACTIVE_MINUTES; otherwise *Inactive*. Nothing is ever shown as online just because a record exists.
"""
import hashlib
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from .core import now
from .models import LoginAuditLog, UserSession

TOUCH_EVERY_SECONDS = 20


def idle_minutes() -> int:
    return int(os.getenv("SESSION_IDLE_MINUTES", "30"))


def active_minutes() -> int:
    return int(os.getenv("SESSION_ACTIVE_MINUTES", "5"))


def ip_retention_days() -> int:
    return int(os.getenv("IP_RETENTION_DAYS", "30"))


def alert_threshold() -> int:
    return int(os.getenv("LOGIN_ALERT_THRESHOLD", "5"))


def alert_window_minutes() -> int:
    return int(os.getenv("LOGIN_ALERT_WINDOW_MINUTES", "15"))


def aware(dt: datetime | None):
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


def sid_hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def new_sid() -> str:
    return uuid.uuid4().hex


def client_ip(request) -> str | None:
    if request is None:
        return None
    if os.getenv("TRUST_PROXY", "0") == "1":
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()[:45]
    return request.client.host[:45] if request.client else None


def parse_ua(ua: str | None) -> dict:
    """Small, dependency-free user-agent classifier. Good enough for Desktop/Mobile/Tablet + common browsers."""
    ua = ua or ""
    low = ua.lower()
    if "ipad" in low or "tablet" in low or ("android" in low and "mobile" not in low):
        device = "Tablet"
    elif any(k in low for k in ("iphone", "ipod", "mobile", "android")):
        device = "Mobile"
    elif ua:
        device = "Desktop"
    else:
        device = "Unknown"
    browser = "Unknown"
    for name, pat in (("Edge", r"edg(?:e|a|ios)?/([\d.]+)"), ("Opera", r"(?:opr|opera)/([\d.]+)"), ("Firefox", r"(?:firefox|fxios)/([\d.]+)"),
                      ("Chrome", r"(?:chrome|crios)/([\d.]+)"), ("Safari", r"version/([\d.]+).*safari")):
        m = re.search(pat, low)
        if m:
            browser = f"{name} {m.group(1).split('.')[0]}"
            break
    if browser == "Unknown" and ua and ("curl" in low or "python" in low or "httpx" in low or "testclient" in low):
        browser = "API client"
    os_ = "Unknown"
    for name, key in (("Windows", "windows"), ("Android", "android"), ("iOS", "iphone"), ("iOS", "ipad"), ("macOS", "mac os"), ("Linux", "linux")):
        if key in low:
            os_ = name
            break
    return {"device_type": device, "browser": browser, "os": os_}


def log_event(db, *, event_type: str, request=None, user=None, email: str | None = None, org_id: int | None = None,
              failure: str | None = None, session_id: int | None = None, detail: dict | None = None):
    """Appends to login_audit_logs. Never receives passwords or tokens."""
    ua = parse_ua(request.headers.get("user-agent") if request is not None else None)
    db.add(LoginAuditLog(org_id=user.org_id if user is not None else org_id, user_id=user.id if user is not None else None,
                         email_attempted=(email or (user.email if user is not None else "") or "")[:255].lower(),
                         event_type=event_type, event_timestamp=now(), ip_address=client_ip(request),
                         device_information=f"{ua['device_type']} · {ua['browser']} · {ua['os']}",
                         failure_category=failure, session_id=session_id, detail=detail))


def recent_failures(db, email: str, minutes: int | None = None) -> int:
    since = now() - timedelta(minutes=minutes or alert_window_minutes())
    rows = db.scalars(select(LoginAuditLog.id).where(LoginAuditLog.email_attempted == email.lower(), LoginAuditLog.event_type == "login_failed",
                                                   LoginAuditLog.event_timestamp >= since)).all()
    return len(rows)


def start_session(db, user, request, refresh_exp, sid: str) -> UserSession:
    ua = parse_ua(request.headers.get("user-agent") if request is not None else None)
    prior = recent_failures(db, user.email, 30)
    s = UserSession(org_id=user.org_id, user_id=user.id, session_id_hash=sid_hash(sid), login_at=now(), last_activity_at=now(),
                    expires_at=refresh_exp, ip_address=client_ip(request), device_type=ua["device_type"],
                    browser=ua["browser"], os=ua["os"], session_status="active",
                    suspicious=prior >= 3, suspicious_reason=f"{prior} failed attempts in the 30 minutes before this sign-in" if prior >= 3 else None)
    db.add(s)
    db.flush()
    log_event(db, event_type="login_success", request=request, user=user, session_id=s.id,
              detail={"suspicious": True, "prior_failures": prior} if s.suspicious else None)
    return s


def effective_state(s: UserSession, at: datetime | None = None) -> str:
    """active | inactive | expired | logged_out | terminated (derived from facts, never assumed)."""
    at = at or now()
    if s.session_status in ("logged_out", "terminated"):
        return s.session_status
    if s.session_status == "expired" or aware(s.expires_at) <= at or aware(s.last_activity_at) < at - timedelta(minutes=idle_minutes()):
        return "expired"
    if aware(s.last_activity_at) >= at - timedelta(minutes=active_minutes()):
        return "active"
    return "inactive"


def is_valid(s: UserSession | None, at: datetime | None = None) -> bool:
    return s is not None and effective_state(s, at) in ("active", "inactive")


def get_session(db, sid: str | None) -> UserSession | None:
    if not sid:
        return None
    return db.scalars(select(UserSession).where(UserSession.session_id_hash == sid_hash(sid))).first()


def touch(db, s: UserSession):
    t = now()
    if (t - aware(s.last_activity_at)).total_seconds() >= TOUCH_EVERY_SECONDS:
        s.last_activity_at = t
        db.commit()


def expire_stale(db, org_id: int | None = None) -> int:
    """Persist 'expired' on sessions that timed out so history shows the truth (also used before reporting)."""
    t = now()
    q = update(UserSession).where(UserSession.session_status == "active",
                                  (UserSession.expires_at <= t) | (UserSession.last_activity_at < t - timedelta(minutes=idle_minutes())))
    if org_id is not None:
        q = q.where(UserSession.org_id == org_id)
    res = db.execute(q.values(session_status="expired", end_reason="timeout").execution_options(synchronize_session=False))
    db.commit()
    db.expire_all()
    return res.rowcount or 0


def end_user_sessions(db, user_id: int, status: str, reason: str, by: int | None = None, except_sid_hash: str | None = None) -> int:
    t = now()
    n = 0
    for s in db.scalars(select(UserSession).where(UserSession.user_id == user_id, UserSession.session_status == "active")):
        if except_sid_hash and s.session_id_hash == except_sid_hash:
            continue
        s.session_status, s.logout_at, s.end_reason, s.terminated_by = status, t, reason, by
        n += 1
    return n


def purge_old_ips(db) -> int:
    """Privacy: drop IP addresses older than IP_RETENTION_DAYS (the rows stay for the audit trail)."""
    cut = now() - timedelta(days=ip_retention_days())
    a = db.execute(update(UserSession).where(UserSession.login_at < cut, UserSession.ip_address.isnot(None)).values(ip_address=None).execution_options(synchronize_session=False)).rowcount or 0
    b = db.execute(update(LoginAuditLog).where(LoginAuditLog.event_timestamp < cut, LoginAuditLog.ip_address.isnot(None)).values(ip_address=None).execution_options(synchronize_session=False)).rowcount or 0
    db.commit()
    db.expire_all()
    return a + b

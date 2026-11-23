"""Administrator-only login monitoring: live session activity, history, failed attempts, exports, termination."""
import csv
import io
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from . import monitor as mon
from .api import audit, require_admin
from .core import effective_permissions, get_db, now
from .models import AuditLog, LoginAuditLog, User, UserSession

router = APIRouter(prefix="/api/monitor", tags=["login-monitoring"])
LOCATION_NOTE = "Not available: StockPilot does not resolve IP addresses to locations."


def _day_start(tz_offset: int, days_ago: int = 0) -> datetime:
    local = now() + timedelta(minutes=tz_offset)
    mid = datetime(local.year, local.month, local.day, tzinfo=timezone.utc) - timedelta(days=days_ago)
    return mid - timedelta(minutes=tz_offset)


def _range(preset: Optional[str], d_from: Optional[date], d_to: Optional[date], tz: int):
    if preset == "today":
        return _day_start(tz), None
    if preset == "yesterday":
        return _day_start(tz, 1), _day_start(tz)
    if preset == "7d":
        return _day_start(tz, 6), None
    if preset == "30d":
        return _day_start(tz, 29), None
    if preset == "custom" or d_from or d_to:
        if d_from and d_to and d_from > d_to:
            raise HTTPException(422, "'From' date is after 'To' date")
        s = datetime(d_from.year, d_from.month, d_from.day, tzinfo=timezone.utc) - timedelta(minutes=tz) if d_from else None
        e = datetime(d_to.year, d_to.month, d_to.day, tzinfo=timezone.utc) + timedelta(days=1) - timedelta(minutes=tz) if d_to else None
        return s, e
    return None, None


def _state_clause(state: str):
    t = now()
    idle_cut, act_cut = t - timedelta(minutes=mon.idle_minutes()), t - timedelta(minutes=mon.active_minutes())
    live = and_(UserSession.session_status == "active", UserSession.expires_at > t, UserSession.last_activity_at >= idle_cut)
    return {"active": and_(live, UserSession.last_activity_at >= act_cut), "inactive": and_(live, UserSession.last_activity_at < act_cut),
            "logged_out": UserSession.session_status == "logged_out", "terminated": UserSession.session_status == "terminated",
            "expired": or_(UserSession.session_status == "expired", and_(UserSession.session_status == "active", ~live))}.get(state)


def _session_row(s: UserSession, u: User, t: datetime):
    st = mon.effective_state(s, t)
    end = mon.aware(s.logout_at) or (t if st in ("active", "inactive") else mon.aware(s.last_activity_at))
    return {"id": s.id, "user_id": u.id, "name": u.name, "email": u.email, "role": u.role, "is_admin": u.role in ("owner", "admin"),
            "login_at": s.login_at, "last_activity_at": s.last_activity_at, "logout_at": s.logout_at,
            "duration_seconds": max(0, int((end - mon.aware(s.login_at)).total_seconds())),
            "ip_address": s.ip_address, "device_type": s.device_type, "browser": s.browser, "os": s.os, "location": None,
            "state": st, "end_reason": s.end_reason, "suspicious": s.suspicious, "suspicious_reason": s.suspicious_reason}


def _failed_row(a: LoginAuditLog):
    return {"id": a.id, "email": a.email_attempted, "user_id": a.user_id, "timestamp": a.event_timestamp, "category": a.failure_category,
            "ip_address": a.ip_address, "device": a.device_information, "known_account": a.user_id is not None}


def _session_query(admin: User, state, user_id, role, q, start, end):
    qy = select(UserSession, User).join(User, User.id == UserSession.user_id).where(UserSession.org_id == admin.org_id)
    if start:
        qy = qy.where(UserSession.login_at >= start)
    if end:
        qy = qy.where(UserSession.login_at < end)
    if user_id:
        qy = qy.where(UserSession.user_id == user_id)
    if role:
        qy = qy.where(User.role.in_(("owner", "admin")) if role == "admin_type" else ~User.role.in_(("owner", "admin")) if role == "user_type" else User.role == role)
    if q:
        like = f"%{q.lower()}%"
        qy = qy.where(or_(func.lower(User.name).like(like), func.lower(User.email).like(like)))
    if state:
        c = _state_clause(state)
        if c is None:
            raise HTTPException(422, "Unknown session status")
        qy = qy.where(c)
    return qy.order_by(UserSession.login_at.desc())


def _failed_query(admin: User, start, end, q, category, user_id=None):
    qy = select(LoginAuditLog).where(LoginAuditLog.event_type == "login_failed",
                                     or_(LoginAuditLog.org_id == admin.org_id, LoginAuditLog.org_id.is_(None)))
    if start:
        qy = qy.where(LoginAuditLog.event_timestamp >= start)
    if end:
        qy = qy.where(LoginAuditLog.event_timestamp < end)
    if q:
        qy = qy.where(func.lower(LoginAuditLog.email_attempted).like(f"%{q.lower()}%"))
    if category:
        qy = qy.where(LoginAuditLog.failure_category == category)
    if user_id:
        qy = qy.where(LoginAuditLog.user_id == user_id)
    return qy.order_by(LoginAuditLog.id.desc())


# ---------- dashboard ----------
@router.get("/summary")
def summary(tz: int = Query(0, ge=-840, le=840), admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    mon.expire_stale(db, admin.org_id)
    mon.purge_old_ips(db)
    oid, t = admin.org_id, now()
    today = _day_start(tz)
    users = db.scalars(select(User).where(User.org_id == oid)).all()
    sessions = db.scalars(select(UserSession).where(UserSession.org_id == oid, or_(UserSession.login_at >= today, UserSession.session_status == "active"))).all()
    state = {s.id: mon.effective_state(s, t) for s in sessions}
    ever = set(db.scalars(select(UserSession.user_id).where(UserSession.org_id == oid).distinct()).all())
    today_s = [s for s in sessions if mon.aware(s.login_at) >= today]
    win = t - timedelta(minutes=mon.alert_window_minutes())
    fails = db.execute(select(LoginAuditLog.email_attempted, func.count(), func.max(LoginAuditLog.event_timestamp))
                       .where(LoginAuditLog.event_type == "login_failed", LoginAuditLog.event_timestamp >= win,
                              or_(LoginAuditLog.org_id == oid, LoginAuditLog.org_id.is_(None)))
                       .group_by(LoginAuditLog.email_attempted).having(func.count() >= mon.alert_threshold())).all()
    return {
        "total_users": len(users), "inactive_accounts": sum(not u.is_active for u in users),
        "active_users": len({s.user_id for s in sessions if state[s.id] == "active"}),
        "logged_in_today": len({s.user_id for s in today_s}),
        "never_logged_in": sum(1 for u in users if u.last_login is None and u.id not in ever),
        "sessions_today": len(today_s),
        "open_sessions": sum(1 for s in sessions if state[s.id] in ("active", "inactive")),
        "suspicious_today": sum(1 for s in today_s if s.suspicious),
        "failed_24h": db.scalar(select(func.count()).select_from(LoginAuditLog).where(
            LoginAuditLog.event_type == "login_failed", LoginAuditLog.event_timestamp >= t - timedelta(hours=24),
            or_(LoginAuditLog.org_id == oid, LoginAuditLog.org_id.is_(None)))) or 0,
        "alerts": [{"email": e, "count": c, "last_at": l} for e, c, l in fails],
        "policy": {"active_minutes": mon.active_minutes(), "idle_minutes": mon.idle_minutes(), "alert_threshold": mon.alert_threshold(),
                   "alert_window_minutes": mon.alert_window_minutes(), "ip_retention_days": mon.ip_retention_days()},
        "location_note": LOCATION_NOTE, "generated_at": t,
    }


@router.get("/sessions")
def live_sessions(limit: int = Query(30, ge=1, le=200), admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Recent activity table: every session from the last 24h plus any still-valid older one, newest activity first."""
    mon.expire_stale(db, admin.org_id)
    t = now()
    rows = db.execute(select(UserSession, User).join(User, User.id == UserSession.user_id).where(
        UserSession.org_id == admin.org_id, or_(UserSession.login_at >= t - timedelta(hours=24), UserSession.session_status == "active"))
        .order_by(UserSession.last_activity_at.desc()).limit(limit)).all()
    return {"items": [_session_row(s, u, t) for s, u in rows], "generated_at": t, "location_note": LOCATION_NOTE}


# ---------- history ----------
@router.get("/history")
def history(preset: Optional[str] = None, date_from: Optional[date] = None, date_to: Optional[date] = None, user_id: Optional[int] = None,
            role: Optional[str] = None, state: Optional[str] = None, q: Optional[str] = None, tz: int = Query(0, ge=-840, le=840),
            page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
            admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    mon.expire_stale(db, admin.org_id)
    start, end = _range(preset, date_from, date_to, tz)
    qy = _session_query(admin, state, user_id, role, q, start, end)
    total = db.scalar(select(func.count()).select_from(qy.order_by(None).subquery()))
    rows = db.execute(qy.offset((page - 1) * page_size).limit(page_size)).all()
    t = now()
    fq = select(LoginAuditLog.user_id, func.count()).where(LoginAuditLog.event_type == "login_failed", LoginAuditLog.user_id.in_([u.id for _, u in rows] or [0]))
    if start:
        fq = fq.where(LoginAuditLog.event_timestamp >= start)
    if end:
        fq = fq.where(LoginAuditLog.event_timestamp < end)
    failed = dict(db.execute(fq.group_by(LoginAuditLog.user_id)).all())
    return {"total": total, "page": page, "page_size": page_size,
            "items": [{**_session_row(s, u, t), "failed_attempts": failed.get(u.id, 0)} for s, u in rows]}


@router.get("/failed")
def failed(preset: Optional[str] = None, date_from: Optional[date] = None, date_to: Optional[date] = None, q: Optional[str] = None,
           category: Optional[str] = None, user_id: Optional[int] = None, tz: int = Query(0, ge=-840, le=840),
           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
           admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    start, end = _range(preset, date_from, date_to, tz)
    qy = _failed_query(admin, start, end, q, category, user_id)
    total = db.scalar(select(func.count()).select_from(qy.order_by(None).subquery()))
    rows = db.scalars(qy.offset((page - 1) * page_size).limit(page_size)).all()
    return {"total": total, "page": page, "page_size": page_size, "items": [_failed_row(a) for a in rows]}


def _safe(v):
    """Neutralise spreadsheet formula injection in exported text (e-mails of failed attempts are attacker-controlled)."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


@router.get("/export")
def export(kind: str = Query("history", pattern="^(history|failed)$"), fmt: str = Query("csv", pattern="^(csv|xlsx)$"),
           preset: Optional[str] = None, date_from: Optional[date] = None, date_to: Optional[date] = None, user_id: Optional[int] = None,
           role: Optional[str] = None, state: Optional[str] = None, q: Optional[str] = None, category: Optional[str] = None,
           tz: int = Query(0, ge=-840, le=840), admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    mon.expire_stale(db, admin.org_id)
    start, end = _range(preset, date_from, date_to, tz)
    t = now()
    if kind == "history":
        heads = ["User", "Email", "Role", "Login at (UTC)", "Last activity (UTC)", "Logout at (UTC)", "Duration (min)", "Device", "Browser", "OS", "IP address", "Status", "Ended by", "Suspicious"]
        out = [[u.name, u.email, u.role, _f(s.login_at), _f(s.last_activity_at), _f(s.logout_at), round(r["duration_seconds"] / 60, 1), s.device_type, s.browser, s.os,
                s.ip_address or "", r["state"], s.end_reason or "", "yes" if s.suspicious else ""]
               for (s, u) in db.execute(_session_query(admin, state, user_id, role, q, start, end).limit(50000)).all() for r in [_session_row(s, u, t)]]
    else:
        heads = ["Email entered", "Time (UTC)", "Reason", "Known account", "IP address", "Device"]
        out = [[a.email_attempted, _f(a.event_timestamp), a.failure_category, "yes" if a.user_id else "no", a.ip_address or "", a.device_information or ""]
               for a in db.scalars(_failed_query(admin, start, end, q, category, user_id).limit(50000))]
    audit(db, admin, "export", "login_monitoring", None, {"kind": kind, "fmt": fmt, "rows": len(out)})
    db.commit()
    name = f"login-{kind}-{t:%Y%m%d-%H%M}"
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(heads)
        w.writerows([[_safe(c) for c in r] for r in out])
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Login activity"[:31]
    ws.append(heads)
    for r in out:
        ws.append([_safe(c) for c in r])
    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    return StreamingResponse(bio, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})


def _f(d):
    return d.strftime("%Y-%m-%d %H:%M:%S") if d else ""


# ---------- user detail + termination ----------
@router.get("/users/{uid}")
def user_detail(uid: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = db.get(User, uid)
    if not u or u.org_id != admin.org_id:
        raise HTTPException(404, "User not found")
    mon.expire_stale(db, admin.org_id)
    t = now()
    sess = db.scalars(select(UserSession).where(UserSession.user_id == uid).order_by(UserSession.login_at.desc()).limit(30)).all()
    rows = [_session_row(s, u, t) for s in sess]
    devices: dict = {}
    for s in db.scalars(select(UserSession).where(UserSession.user_id == uid).order_by(UserSession.login_at)):
        d = devices.setdefault((s.device_type, s.browser, s.os), {"device_type": s.device_type, "browser": s.browser, "os": s.os, "logins": 0, "last_used": None})
        d["logins"] += 1
        d["last_used"] = s.login_at
    acts = db.scalars(select(AuditLog).where(AuditLog.user_id == uid).order_by(AuditLog.id.desc()).limit(15)).all()
    fails = db.scalars(select(LoginAuditLog).where(LoginAuditLog.event_type == "login_failed",
                                                   or_(LoginAuditLog.user_id == uid, LoginAuditLog.email_attempted == u.email)).order_by(LoginAuditLog.id.desc()).limit(10)).all()
    return {"profile": {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "is_admin": u.role in ("owner", "admin"), "is_active": u.is_active,
                        "department": u.department, "phone": u.phone, "created_at": u.created_at, "last_login": u.last_login,
                        "locked": bool(mon.aware(u.locked_until) and mon.aware(u.locked_until) > t)},
            "total_logins": db.scalar(select(func.count()).select_from(LoginAuditLog).where(LoginAuditLog.user_id == uid, LoginAuditLog.event_type == "login_success")) or 0,
            "failed_total": db.scalar(select(func.count()).select_from(LoginAuditLog).where(LoginAuditLog.event_type == "login_failed", or_(LoginAuditLog.user_id == uid, LoginAuditLog.email_attempted == u.email))) or 0,
            "active_sessions": [r for r in rows if r["state"] in ("active", "inactive")], "history": rows,
            "devices": sorted(devices.values(), key=lambda d: d["last_used"], reverse=True),
            "recent_activity": [{"id": a.id, "action": a.action, "entity": a.entity, "entity_id": a.entity_id, "when": a.created_at} for a in acts],
            "failed_recent": [_failed_row(a) for a in fails],
            "permissions": effective_permissions(u)}


@router.post("/sessions/{sid}/terminate")
def terminate(sid: int, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    s = db.get(UserSession, sid)
    if not s or s.org_id != admin.org_id:
        raise HTTPException(404, "Session not found")
    cur = getattr(request.state, "session", None)
    if cur is not None and cur.id == s.id:
        raise HTTPException(422, "This is your current session. Use Sign out instead.")
    if not mon.is_valid(s):
        raise HTTPException(409, "This session has already ended")
    target = db.get(User, s.user_id)
    s.session_status, s.logout_at, s.end_reason, s.terminated_by = "terminated", now(), "admin_terminated", admin.id
    mon.log_event(db, event_type="session_terminated", request=request, user=target, session_id=s.id, detail={"by": admin.id, "by_email": admin.email})
    audit(db, admin, "session_terminated", "user", target.id, {"session_id": s.id, "device": f"{s.device_type} {s.browser}", "ip": s.ip_address})
    db.commit()
    return {"ok": True, "session_id": s.id}

"""Login monitoring: real session records, activity states, failed attempts, admin-only access."""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core import Base, SessionLocal, engine, now
from app.main import app
from app.models import AuditLog, LoginAuditLog, UserSession

UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
PW = "Passw0rd123"


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c


def login(c, email, pw=PW, ua=UA_DESKTOP):
    return c.post("/api/auth/login", data={"username": email, "password": pw}, headers={"User-Agent": ua})


def auth(r):
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    r = client.post("/api/auth/signup", json={"org_name": "MonCo", "name": "Boss", "email": "boss@mon.com", "password": PW},
                    headers={"User-Agent": UA_DESKTOP})
    assert r.status_code == 201
    return auth(r)


def mk(client, admin, email, role="sales"):
    r = client.post("/api/users", headers=admin, json={"name": email.split("@")[0].title(), "email": email, "password": PW, "role": role})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def sessions(client, admin, **q):
    return client.get("/api/monitor/history", headers=admin, params={"page_size": 100, **q}).json()


def by_email(rows, email):
    return [r for r in rows if r["email"] == email]


# 1 + 2 : logins (user and admin) create records visible to the admin
def test_logins_create_session_records(client, admin):
    mk(client, admin, "u1@mon.com")
    r = login(client, "u1@mon.com")
    assert r.status_code == 200
    rows = by_email(sessions(client, admin)["items"], "u1@mon.com")
    assert len(rows) == 1
    s = rows[0]
    assert s["state"] == "active" and s["device_type"] == "Desktop" and s["browser"].startswith("Edge") and s["os"] == "Windows"
    assert s["role"] == "sales" and s["is_admin"] is False and s["ip_address"] and s["location"] is None
    adm = login(client, "boss@mon.com")
    assert adm.status_code == 200
    arows = by_email(sessions(client, admin)["items"], "boss@mon.com")
    assert len(arows) >= 2 and all(a["is_admin"] for a in arows)               # signup session + this login
    live = client.get("/api/monitor/sessions", headers=admin).json()
    assert any(x["email"] == "u1@mon.com" and x["state"] == "active" for x in live["items"])
    with SessionLocal() as db:   # nothing sensitive is stored: only a SHA-256 hash of the session id
        tok = r.json()["refresh_token"]
        for s in db.scalars(select(UserSession)):
            assert len(s.session_id_hash) == 64 and s.session_id_hash not in tok


# 3 : logout
def test_logout_marks_logged_out(client, admin):
    mk(client, admin, "u2@mon.com")
    r = login(client, "u2@mon.com")
    h = auth(r)
    assert client.get("/api/auth/me", headers=h).status_code == 200
    assert client.post("/api/auth/logout", json={"refresh_token": r.json()["refresh_token"]}).status_code == 204
    row = by_email(sessions(client, admin)["items"], "u2@mon.com")[0]
    assert row["state"] == "logged_out" and row["logout_at"] and row["end_reason"] == "user_logout"
    assert client.get("/api/auth/me", headers=h).status_code == 401           # the access token died with the session
    assert client.post("/api/auth/refresh", json={"refresh_token": r.json()["refresh_token"]}).status_code == 401


# 4 : idle expiry and the active/inactive distinction
def test_inactivity_expires_session(client, admin):
    mk(client, admin, "u3@mon.com")
    r = login(client, "u3@mon.com")
    h = auth(r)
    def age(minutes):
        with SessionLocal() as db:
            s = db.scalars(select(UserSession).join(UserSession.__table__, UserSession.id == UserSession.id).where(UserSession.user_id == uid3)).first() if False else None
    uid3 = next(u["id"] for u in client.get("/api/users", headers=admin).json() if u["email"] == "u3@mon.com")
    def set_idle(minutes):
        with SessionLocal() as db:
            s = db.scalars(select(UserSession).where(UserSession.user_id == uid3)).first()
            s.last_activity_at = now() - timedelta(minutes=minutes)
            db.commit()
    set_idle(10)                                         # past the 5-minute "active" window, inside the 30-minute timeout
    assert by_email(sessions(client, admin)["items"], "u3@mon.com")[0]["state"] == "inactive"
    assert client.get("/api/auth/me", headers=h).status_code == 200            # still valid ...
    assert by_email(sessions(client, admin)["items"], "u3@mon.com")[0]["state"] == "active"   # ... and the request counted as activity
    set_idle(45)                                         # beyond the idle timeout
    assert by_email(sessions(client, admin)["items"], "u3@mon.com")[0]["state"] == "expired"
    assert client.get("/api/auth/me", headers=h).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh_token": r.json()["refresh_token"]}).status_code == 401
    assert sessions(client, admin, state="expired")["total"] >= 1


def test_background_polling_does_not_count_as_activity(client, admin):
    mk(client, admin, "u3b@mon.com")
    h = auth(login(client, "u3b@mon.com"))
    uid = next(u["id"] for u in client.get("/api/users", headers=admin).json() if u["email"] == "u3b@mon.com")
    with SessionLocal() as db:
        s = db.scalars(select(UserSession).where(UserSession.user_id == uid)).first()
        s.last_activity_at = now() - timedelta(minutes=10)
        db.commit()
    assert client.get("/api/auth/me", headers={**h, "X-Background": "1"}).status_code == 200
    assert by_email(sessions(client, admin)["items"], "u3b@mon.com")[0]["state"] == "inactive"


# 5 : second device -> separate session
def test_second_device_is_separate_session(client, admin):
    mk(client, admin, "u4@mon.com")
    a = login(client, "u4@mon.com", ua=UA_DESKTOP)
    b = login(client, "u4@mon.com", ua=UA_PHONE)
    rows = by_email(sessions(client, admin)["items"], "u4@mon.com")
    assert len(rows) == 2 and {r["device_type"] for r in rows} == {"Desktop", "Mobile"}
    assert all(r["state"] == "active" for r in rows)
    assert client.get("/api/auth/me", headers=auth(a)).status_code == 200 and client.get("/api/auth/me", headers=auth(b)).status_code == 200
    uid = rows[0]["user_id"]
    d = client.get(f"/api/monitor/users/{uid}", headers=admin).json()
    assert len(d["active_sessions"]) == 2 and len(d["devices"]) == 2 and d["total_logins"] == 2
    assert d["profile"]["email"] == "u4@mon.com" and "sales" in d["permissions"]
    # logging out one device leaves the other signed in
    client.post("/api/auth/logout", json={"refresh_token": a.json()["refresh_token"]})
    assert client.get("/api/auth/me", headers=auth(a)).status_code == 401 and client.get("/api/auth/me", headers=auth(b)).status_code == 200


# 6 : admin terminates a session
def test_admin_terminates_session(client, admin):
    mk(client, admin, "u5@mon.com")
    r = login(client, "u5@mon.com")
    h = auth(r)
    row = by_email(sessions(client, admin)["items"], "u5@mon.com")[0]
    assert client.post(f"/api/monitor/sessions/{row['id']}/terminate", headers=admin).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh_token": r.json()["refresh_token"]}).status_code == 401
    assert by_email(sessions(client, admin)["items"], "u5@mon.com")[0]["state"] == "terminated"
    assert client.post(f"/api/monitor/sessions/{row['id']}/terminate", headers=admin).status_code == 409
    with SessionLocal() as db:
        assert db.scalars(select(AuditLog).where(AuditLog.action == "session_terminated", AuditLog.entity_id == str(row["user_id"]))).first()
        assert db.scalars(select(LoginAuditLog).where(LoginAuditLog.event_type == "session_terminated", LoginAuditLog.user_id == row["user_id"])).first()
    assert login(client, "u5@mon.com").status_code == 200                       # the account itself is not blocked
    mine = by_email(sessions(client, admin)["items"], "boss@mon.com")[0]
    assert client.post(f"/api/monitor/sessions/{mine['id']}/terminate", headers=admin).status_code in (404, 422, 200)   # never crashes
    assert client.post("/api/monitor/sessions/999999/terminate", headers=admin).status_code == 404


def test_cannot_terminate_own_current_session(client, admin):
    cur = auth(login(client, "boss@mon.com"))
    row = max(by_email(sessions(client, admin)["items"], "boss@mon.com"), key=lambda r: r["id"])
    assert client.post(f"/api/monitor/sessions/{row['id']}/terminate", headers=cur).status_code == 422


# 7 + 8 : users cannot reach monitoring
def test_users_denied_monitoring(client, admin):
    mk(client, admin, "u6@mon.com", role="manager")
    h = auth(login(client, "u6@mon.com"))
    for path in ("/summary", "/sessions", "/history", "/failed", "/export?kind=history&fmt=csv", "/users/1"):
        assert client.get("/api/monitor" + path, headers=h).status_code == 403, path
    assert client.post("/api/monitor/sessions/1/terminate", headers=h).status_code == 403
    assert client.get("/api/monitor/summary").status_code == 401
    assert "sessions" not in client.get("/api/auth/me", headers=h).text                  # not leaked through user APIs
    assert "ip_address" not in client.get("/api/users", headers=h).text


# 9 : failed logins without passwords
def test_failed_logins_recorded_without_passwords(client, admin):
    mk(client, admin, "u7@mon.com")
    assert login(client, "u7@mon.com", "Wrong-secret-9").status_code == 401
    assert login(client, "ghost@mon.com", "Another-secret-9", ua=UA_PHONE).status_code == 401
    f = client.get("/api/monitor/failed", headers=admin, params={"preset": "today"}).json()
    known = [x for x in f["items"] if x["email"] == "u7@mon.com"][0]
    ghost = [x for x in f["items"] if x["email"] == "ghost@mon.com"][0]
    assert known["category"] == "wrong_password" and known["known_account"] and ghost["category"] == "unknown_account" and not ghost["known_account"]
    assert "Mobile" in ghost["device"] and ghost["ip_address"]
    with SessionLocal() as db:
        blob = " ".join(str(v) for r in db.scalars(select(LoginAuditLog)) for v in (r.email_attempted, r.detail, r.device_information, r.failure_category))
        assert "Wrong-secret-9" not in blob and "Another-secret-9" not in blob
    assert [x for x in client.get("/api/monitor/failed", headers=admin, params={"category": "unknown_account"}).json()["items"] if x["email"] == "u7@mon.com"] == []
    mk(client, admin, "u8@mon.com")
    uid = next(u["id"] for u in client.get("/api/users", headers=admin).json() if u["email"] == "u8@mon.com")
    client.post(f"/api/users/{uid}/unlock", headers=admin)
    client.patch(f"/api/users/{uid}", headers=admin, json={"is_active": False})
    assert login(client, "u8@mon.com").status_code == 403
    cats = [x["category"] for x in client.get("/api/monitor/failed", headers=admin, params={"q": "u8@"}).json()["items"]]
    assert "account_deactivated" in cats


def test_repeated_failures_raise_alert_and_flag_suspicious_login(client, admin, monkeypatch):
    monkeypatch.setenv("LOGIN_ALERT_THRESHOLD", "3")
    mk(client, admin, "u9@mon.com")
    for _ in range(3):
        login(client, "u9@mon.com", "bad-pass-123")
    s = client.get("/api/monitor/summary", headers=admin).json()
    assert any(a["email"] == "u9@mon.com" and a["count"] >= 3 for a in s["alerts"])
    assert login(client, "u9@mon.com").status_code == 200
    row = by_email(sessions(client, admin)["items"], "u9@mon.com")[0]
    assert row["suspicious"] and "failed attempts" in row["suspicious_reason"]
    assert row["failed_attempts"] >= 3


# deactivation invalidates sessions
def test_deactivation_ends_sessions(client, admin):
    uid = mk(client, admin, "u10@mon.com")
    h = auth(login(client, "u10@mon.com"))
    client.patch(f"/api/users/{uid}", headers=admin, json={"is_active": False})
    assert client.get("/api/auth/me", headers=h).status_code == 401
    row = by_email(sessions(client, admin)["items"], "u10@mon.com")[0]
    assert row["state"] == "terminated" and row["end_reason"] == "account_deactivated"


# 10 : dashboard statistics match the records
def test_summary_matches_records(client, admin):
    s = client.get("/api/monitor/summary", headers=admin).json()
    users = client.get("/api/users", headers=admin).json()
    assert s["total_users"] == len(users) and s["inactive_accounts"] == sum(not u["is_active"] for u in users)
    today = sessions(client, admin, preset="today")
    assert s["sessions_today"] == today["total"]
    assert s["logged_in_today"] == len({r["user_id"] for r in today["items"]})
    live = [r for r in today["items"] if r["state"] == "active"]
    assert s["active_users"] == len({r["user_id"] for r in live})
    mk(client, admin, "neverin@mon.com")
    s2 = client.get("/api/monitor/summary", headers=admin).json()
    assert s2["never_logged_in"] == s["never_logged_in"] + 1
    assert s2["policy"]["idle_minutes"] == 30 and "location" in s2["location_note"].lower()


def test_filters_pagination_and_exports(client, admin):
    all_ = sessions(client, admin)
    assert all_["total"] >= 8
    p1 = client.get("/api/monitor/history", headers=admin, params={"page_size": 3, "page": 1}).json()
    p2 = client.get("/api/monitor/history", headers=admin, params={"page_size": 3, "page": 2}).json()
    assert len(p1["items"]) == 3 and {r["id"] for r in p1["items"]}.isdisjoint({r["id"] for r in p2["items"]})
    assert all(r["email"] == "u4@mon.com" for r in sessions(client, admin, q="u4@")["items"])
    uid = by_email(all_["items"], "u4@mon.com")[0]["user_id"]
    assert sessions(client, admin, user_id=uid)["total"] == 2
    assert all(r["state"] == "terminated" for r in sessions(client, admin, state="terminated")["items"])
    assert all(r["is_admin"] for r in sessions(client, admin, role="admin_type")["items"])
    assert sessions(client, admin, preset="yesterday")["total"] == 0
    assert sessions(client, admin, preset="custom", date_from="2000-01-01", date_to="2000-01-02")["total"] == 0
    assert client.get("/api/monitor/history", headers=admin, params={"preset": "custom", "date_from": "2026-02-02", "date_to": "2026-01-01"}).status_code == 422
    assert client.get("/api/monitor/history", headers=admin, params={"state": "bogus"}).status_code == 422
    csv_ = client.get("/api/monitor/export", headers=admin, params={"kind": "history", "fmt": "csv"})
    assert csv_.status_code == 200 and csv_.headers["content-type"].startswith("text/csv") and "u4@mon.com" in csv_.text
    xl = client.get("/api/monitor/export", headers=admin, params={"kind": "failed", "fmt": "xlsx"})
    assert xl.status_code == 200 and xl.content[:2] == b"PK"
    client.post("/api/auth/login", data={"username": "=HYPERLINK(\"http://x\")@evil.com", "password": "bad-pass-123"})
    f = client.get("/api/monitor/export", headers=admin, params={"kind": "failed", "fmt": "csv"}).text
    assert "'=hyperlink" in f.lower() and "\n=hyperlink" not in f.lower()                      # formula injection neutralised
    assert client.get("/api/monitor/export?fmt=exe", headers=admin).status_code == 422


def test_ip_retention_purges_old_addresses(client, admin):
    from app.monitor import purge_old_ips
    with SessionLocal() as db:
        s = db.scalars(select(UserSession)).first()
        s.login_at = now() - timedelta(days=60)
        db.commit()
        sid = s.id
        assert purge_old_ips(db) >= 1
        assert db.get(UserSession, sid).ip_address is None


def test_other_org_cannot_see_sessions(client, admin):
    o = client.post("/api/auth/signup", json={"org_name": "Other", "name": "O", "email": "o@other-mon.com", "password": PW})
    h = auth(o)
    assert client.get("/api/monitor/history", headers=h).json()["total"] == 1                # only its own signup session
    uid = by_email(sessions(client, admin)["items"], "u4@mon.com")[0]["user_id"]
    assert client.get(f"/api/monitor/users/{uid}", headers=h).status_code == 404
    sid = by_email(sessions(client, admin)["items"], "u4@mon.com")[0]["id"]
    assert client.post(f"/api/monitor/sessions/{sid}/terminate", headers=h).status_code == 404

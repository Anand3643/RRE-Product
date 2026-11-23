"""Admin / User authentication and role-based access control."""
import pytest
from fastapi.testclient import TestClient

from app.core import Base, SessionLocal, engine
from app.main import app
from app.models import User
from app.bootstrap import provision_initial_admin


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c


def login(c, email, pw, remember=True):
    return c.post(f"/api/auth/login?remember={'true' if remember else 'false'}", data={"username": email, "password": pw})


def hdr(c, email, pw):
    r = login(c, email, pw)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    r = client.post("/api/auth/signup", json={"org_name": "AuthCo", "name": "Boss", "email": "boss@auth.com", "password": "password123"})
    assert r.status_code == 201
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def mk_user(c, admin, email, **kw):
    body = {"name": "Staff " + email.split("@")[0], "email": email, "password": "Passw0rd123", "role": "viewer", **kw}
    r = c.post("/api/users", json=body, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()["id"]


# 1 + 4 : role comes from the database; dashboards differ
def test_admin_login_returns_admin_home(client, admin):
    r = login(client, "boss@auth.com", "password123")
    assert r.status_code == 200
    u = r.json()["user"]
    assert u["is_admin"] is True and u["home"] == "/admin/dashboard" and u["role"] == "owner"
    assert set(u["actions"]["users"]) >= {"view", "create", "edit", "delete"}


def test_user_login_returns_user_home(client, admin):
    mk_user(client, admin, "emp1@auth.com", role="sales")
    r = login(client, "emp1@auth.com", "Passw0rd123")
    assert r.status_code == 200
    u = r.json()["user"]
    assert u["is_admin"] is False and u["home"] == "/user/dashboard" and "users" not in u["permissions"]


# 3 / 4 : users cannot reach admin APIs
def test_user_cannot_call_admin_apis(client, admin):
    mk_user(client, admin, "emp2@auth.com", role="manager")  # manager can *read* users but never administer
    h = hdr(client, "emp2@auth.com", "Passw0rd123")
    assert client.get("/api/admin/overview", headers=h).status_code == 403
    assert client.get("/api/permissions/meta", headers=h).status_code == 403
    assert client.post("/api/users", headers=h, json={"name": "X", "email": "x@auth.com", "role": "admin"}).status_code == 403
    assert client.patch("/api/users/1", headers=h, json={"role": "admin"}).status_code == 403
    assert client.get("/api/users/1/activity", headers=h).status_code == 403
    assert client.post("/api/users/1/reset-password", headers=h, json={"mode": "link"}).status_code == 403
    me = client.get("/api/auth/me", headers=h).json()
    assert me["is_admin"] is False


# 5 : admin creates user -> can log in; password is hashed; duplicate/invalid e-mail rejected; audited
def test_admin_creates_user_and_audit(client, admin):
    uid = mk_user(client, admin, "emp3@auth.com", role="warehouse", phone="999", department="Stores")
    assert login(client, "emp3@auth.com", "Passw0rd123").status_code == 200
    with SessionLocal() as db:
        u = db.get(User, uid)
        assert u.password_hash.startswith("$2") and "Passw0rd123" not in u.password_hash
        assert (u.phone, u.department) == ("999", "Stores")
    assert client.post("/api/users", headers=admin, json={"name": "D", "email": "EMP3@auth.com", "password": "Passw0rd123"}).status_code == 409
    assert client.post("/api/users", headers=admin, json={"name": "D", "email": "not-an-email", "password": "Passw0rd123"}).status_code == 422
    assert client.post("/api/users", headers=admin, json={"name": "D", "email": "w@auth.com", "password": "short"}).status_code == 422
    logs = client.get("/api/audit-logs", headers=admin).json()
    assert any(a["action"] == "create" and a["entity"] == "user" and a["entity_id"] == str(uid) for a in logs)


def test_generated_temporary_password_forces_change(client, admin):
    r = client.post("/api/users", headers=admin, json={"name": "Temp", "email": "temp@auth.com", "role": "viewer"})
    assert r.status_code == 201
    tmp = r.json()["temporary_password"]
    assert tmp and len(tmp) >= 12
    h = hdr(client, "temp@auth.com", tmp)
    assert client.get("/api/products", headers=h).status_code == 403          # blocked until the password is changed
    assert client.get("/api/auth/me", headers=h).json()["must_change_password"] is True
    assert client.post("/api/auth/change-password", headers=h, json={"current_password": tmp, "new_password": "weakpass"}).status_code == 422
    r = client.post("/api/auth/change-password", headers=h, json={"current_password": tmp, "new_password": "BrandNew123"})
    assert r.status_code == 200
    h2 = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/api/products", headers=h2).status_code == 200
    assert client.get("/api/products", headers=h).status_code == 401           # the old session was invalidated
    assert login(client, "temp@auth.com", tmp).status_code == 401


# 6 : deactivation blocks login and kills the live session
def test_deactivate_user(client, admin):
    uid = mk_user(client, admin, "emp4@auth.com", role="sales")
    h = hdr(client, "emp4@auth.com", "Passw0rd123")
    assert client.get("/api/products", headers=h).status_code == 200
    assert client.patch(f"/api/users/{uid}", headers=admin, json={"is_active": False}).status_code == 200
    assert client.get("/api/products", headers=h).status_code == 401
    r = login(client, "emp4@auth.com", "Passw0rd123")
    assert r.status_code == 403 and "deactivated" in r.json()["detail"]
    assert login(client, "emp4@auth.com", "wrong-password1").status_code == 401   # no status leak with a wrong password
    assert client.patch(f"/api/users/{uid}", headers=admin, json={"is_active": True}).status_code == 200
    assert login(client, "emp4@auth.com", "Passw0rd123").status_code == 200


# 7 : per-user permissions are enforced on the backend and take effect immediately
def test_custom_permissions_take_effect(client, admin):
    uid = mk_user(client, admin, "emp5@auth.com", role="viewer")
    h = hdr(client, "emp5@auth.com", "Passw0rd123")
    assert client.get("/api/customers", headers=h).status_code == 200                  # viewer template can read sales
    assert client.post("/api/customers", headers=h, json={"name": "Nope"}).status_code == 403
    r = client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"products": ["view"], "sales": ["view", "create"]}})
    assert r.status_code == 200 and r.json()["effective"]["sales"] == ["view", "create"]
    assert client.get("/api/purchase-orders", headers=h).status_code == 403            # purchases removed
    assert client.get("/api/customers", headers=h).status_code == 200
    assert client.post("/api/customers", headers=h, json={"name": "Allowed Co"}).status_code == 201   # create granted
    cid = client.get("/api/customers", headers=h).json()
    cid = (cid["items"] if isinstance(cid, dict) else cid)[0]["id"]
    assert client.patch(f"/api/customers/{cid}", headers=h, json={"name": "Renamed"}).status_code == 403   # edit NOT granted
    assert client.delete(f"/api/customers/{cid}", headers=h).status_code == 403                          # delete NOT granted
    me = client.get("/api/auth/me", headers=h).json()
    assert me["permissions"] == {"products": "r", "sales": "w"}
    d = client.get("/api/dashboard", headers=h).json()
    assert d["visible"]["sales"] and not d["visible"]["purchases"] and "vendors" not in d and d["on_hand"] is None
    # grant edit, then reset to the role template
    client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"sales": ["view", "edit"]}})
    assert client.patch(f"/api/customers/{cid}", headers=h, json={"name": "Renamed"}).status_code == 200
    client.patch(f"/api/users/{uid}", headers=admin, json={"reset_permissions": True})
    assert client.get("/api/purchase-orders", headers=h).status_code == 200
    # validation
    assert client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"nope": ["view"]}}).status_code == 422
    assert client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"sales": ["fly"]}}).status_code == 422
    assert client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"users": ["edit"]}}).status_code == 422


def test_export_and_approve_actions(client, admin):
    uid = mk_user(client, admin, "emp6@auth.com", role="viewer")
    client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"reports": ["view"], "sales": ["view", "create", "edit"]}})
    h = hdr(client, "emp6@auth.com", "Passw0rd123")
    assert client.get("/api/reports/sales_summary", headers=h).status_code == 200
    assert client.get("/api/reports/sales_summary/export.csv", headers=h).status_code == 403   # export not granted
    client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"reports": ["view", "export"], "sales": ["view", "create", "edit"]}})
    assert client.get("/api/reports/sales_summary/export.csv", headers=h).status_code == 200
    # confirming a sales order is an "approve" action
    pr = client.post("/api/products", headers=admin, json={"name": "P", "selling_price": 10}).json()
    cu = client.post("/api/customers", headers=admin, json={"name": "C"}).json()
    so = client.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": client.get("/api/warehouses", headers=admin).json()[0]["id"], "lines": [{"product_id": pr["id"], "quantity": 1}]})
    assert so.status_code == 201, so.text
    assert client.post(f"/api/sales-orders/{so.json()['id']}/confirm", headers=h).status_code == 403
    client.patch(f"/api/users/{uid}", headers=admin, json={"permissions": {"sales": ["view", "approve"]}})
    assert client.post(f"/api/sales-orders/{so.json()['id']}/confirm", headers=h).status_code != 403


# 8 + 9 : bad credentials
def test_bad_credentials(client, admin):
    assert login(client, "boss@auth.com", "wrong-password1").status_code == 401
    r = login(client, "nobody@auth.com", "whatever123")
    assert r.status_code == 401 and r.json()["detail"] == "Incorrect email or password"
    assert login(client, "boss@auth.com", "wrong-password1").json()["detail"] == r.json()["detail"]   # no enumeration


# 10 : nobody changes their own role / status / permissions
def test_cannot_change_own_role(client, admin):
    uid = mk_user(client, admin, "emp7@auth.com", role="sales")
    h = hdr(client, "emp7@auth.com", "Passw0rd123")
    assert client.patch(f"/api/users/{uid}", headers=h, json={"role": "admin"}).status_code == 403
    assert client.patch(f"/api/users/{uid}", headers=h, json={"permissions": {"users": ["view"]}}).status_code == 403
    assert client.post("/api/auth/signup", json={"org_name": "Evil", "name": "E", "email": "evil@x.com", "password": "password123"}).status_code == 201  # enabled in tests only
    me = client.get("/api/auth/me", headers=hdr(client, "boss@auth.com", "password123")).json()
    assert client.patch(f"/api/users/{me['id']}", headers=admin, json={"role": "viewer"}).status_code == 403   # admin can't demote self
    assert client.patch(f"/api/users/{me['id']}", headers=admin, json={"is_active": False}).status_code == 403


def test_last_admin_protected_and_org_isolation(client, admin):
    a2 = mk_user(client, admin, "adm2@auth.com", role="admin")
    h2 = hdr(client, "adm2@auth.com", "Passw0rd123")
    assert client.get("/api/admin/overview", headers=h2).status_code == 200           # role 'admin' = ADMIN type
    me2 = client.get("/api/auth/me", headers=h2).json()
    assert client.patch(f"/api/users/{a2}", headers=admin, json={"permissions": {"sales": ["view"]}}).status_code == 422  # admins always full
    # a second org's admin cannot see or touch our users
    other = client.post("/api/auth/signup", json={"org_name": "Other", "name": "O", "email": "o@other.com", "password": "password123"}).json()
    ho = {"Authorization": f"Bearer {other['access_token']}"}
    assert client.get(f"/api/users/{a2}", headers=ho).status_code == 404
    assert client.patch(f"/api/users/{a2}", headers=ho, json={"is_active": False}).status_code == 404
    assert me2["is_admin"]
    ov = client.get("/api/admin/overview", headers=admin).json()
    assert ov["users"]["total"] >= 5 and ov["users"]["active"] + ov["users"]["inactive"] == ov["users"]["total"]


# lockout
def test_lockout_after_repeated_failures(client, admin):
    mk_user(client, admin, "lock@auth.com", role="viewer")
    for _ in range(5):
        assert login(client, "lock@auth.com", "bad-password1").status_code == 401
    r = login(client, "lock@auth.com", "Passw0rd123")      # even the right password is refused while locked
    assert r.status_code == 429
    uid = next(u["id"] for u in client.get("/api/users", headers=admin).json() if u["email"] == "lock@auth.com")
    assert next(u for u in client.get("/api/users", headers=admin).json() if u["id"] == uid)["locked"] is True
    assert client.post(f"/api/users/{uid}/unlock", headers=admin).status_code == 200
    assert login(client, "lock@auth.com", "Passw0rd123").status_code == 200
    # unknown e-mails are throttled the same way
    for _ in range(5):
        assert login(client, "ghost@auth.com", "bad-password1").status_code == 401
    assert login(client, "ghost@auth.com", "bad-password1").status_code == 429


# password reset workflow
def test_forgot_and_admin_reset_link(client, admin):
    uid = mk_user(client, admin, "forgot@auth.com", role="viewer")
    r = client.post("/api/auth/forgot", json={"email": "forgot@auth.com"})
    r2 = client.post("/api/auth/forgot", json={"email": "unknown@auth.com"})
    assert r.status_code == r2.status_code == 200 and r.json() == r2.json()                 # no enumeration
    assert next(u for u in client.get("/api/users", headers=admin).json() if u["id"] == uid)["reset_requested_at"]
    reqs = client.get("/api/password-requests", headers=admin).json()
    assert any(r["email"] == "forgot@auth.com" for r in reqs)                                # visible to the administrator for approval
    mgr = mk_user(client, admin, "mgr2@auth.com", role="manager")
    assert client.get("/api/password-requests", headers=hdr(client, "mgr2@auth.com", "Passw0rd123")).status_code == 403
    old = hdr(client, "forgot@auth.com", "Passw0rd123")
    link = client.post(f"/api/users/{uid}/reset-password", headers=admin, json={"mode": "link"}).json()
    assert not any(r["email"] == "forgot@auth.com" for r in client.get("/api/password-requests", headers=admin).json())   # approving clears the request
    assert client.post("/api/auth/reset", json={"token": "x" * 40, "new_password": "NewPassw0rd1"}).status_code == 400
    assert client.post("/api/auth/reset", json={"token": link["token"], "new_password": "weakpass"}).status_code == 422
    assert client.post("/api/auth/reset", json={"token": link["token"], "new_password": "NewPassw0rd1"}).status_code == 200
    assert client.post("/api/auth/reset", json={"token": link["token"], "new_password": "NewPassw0rd2"}).status_code == 400   # single use
    assert login(client, "forgot@auth.com", "Passw0rd123").status_code == 401
    assert login(client, "forgot@auth.com", "NewPassw0rd1").status_code == 200
    assert client.get("/api/products", headers=old).status_code == 401                      # old sessions revoked
    acts = client.get(f"/api/users/{uid}/activity", headers=admin).json()
    assert {"password_reset_issued", "password_reset", "login"} <= {a["action"] for a in acts}
    tmp = client.post(f"/api/users/{uid}/reset-password", headers=admin, json={"mode": "temporary"}).json()["temporary_password"]
    h = hdr(client, "forgot@auth.com", tmp)
    assert client.get("/api/products", headers=h).status_code == 403   # must change it first


# initial admin provisioning
def test_initial_admin_provisioning(client, admin, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMIN_EMAIL", "first.admin@auth.com")
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "ConfiguredPw1")
    assert provision_initial_admin() == "created"
    assert provision_initial_admin() == "kept"                          # idempotent, never overwrites
    r = login(client, "first.admin@auth.com", "ConfiguredPw1")
    assert r.status_code == 200 and r.json()["user"]["is_admin"] and r.json()["user"]["home"] == "/admin/dashboard"
    # an existing non-admin with that e-mail is promoted only because the operator configured it
    mk_user(client, admin, "promote@auth.com", role="viewer")
    monkeypatch.setenv("INITIAL_ADMIN_EMAIL", "promote@auth.com")
    assert provision_initial_admin() == "promoted"
    assert client.get("/api/auth/me", headers=hdr(client, "promote@auth.com", "Passw0rd123")).json()["is_admin"] is True
    # placeholder / unset does nothing
    monkeypatch.setenv("INITIAL_ADMIN_EMAIL", "your-email@example.com")
    assert provision_initial_admin() is None
    monkeypatch.setenv("INITIAL_ADMIN_EMAIL", "generated@auth.com")
    monkeypatch.delenv("INITIAL_ADMIN_PASSWORD")
    assert provision_initial_admin() == "created"
    with SessionLocal() as db:
        from sqlalchemy import select
        assert db.scalars(select(User).where(User.email == "generated@auth.com")).first().must_change_password is True


def test_signup_disabled_by_default(client, monkeypatch):
    monkeypatch.setenv("ALLOW_SIGNUP", "0")
    assert client.get("/api/auth/config").json()["signup_enabled"] is False
    assert client.post("/api/auth/signup", json={"org_name": "ZZ", "name": "ZZ", "email": "z@z.com", "password": "password123"}).status_code == 403


def test_non_remembered_session_is_shorter(client, admin):
    import jwt as pyjwt
    from app.core import SECRET_KEY
    exp = lambda t: pyjwt.decode(t, SECRET_KEY, algorithms=["HS256"])["exp"] - pyjwt.decode(t, SECRET_KEY, algorithms=["HS256"])["iat"]
    long_ = login(client, "boss@auth.com", "password123", remember=True).json()["refresh_token"]
    short = login(client, "boss@auth.com", "password123", remember=False).json()["refresh_token"]
    assert abs(exp(short) - 86400) < 2 and exp(long_) > 86400 * 10
    new = client.post("/api/auth/refresh", json={"refresh_token": short}).json()["refresh_token"]
    assert abs(exp(new) - 86400) < 2                                                       # stays short after rotation


def test_logout_revokes_refresh_token(client, admin):
    t = login(client, "boss@auth.com", "password123").json()
    assert client.post("/api/auth/logout", json={"refresh_token": t["refresh_token"]}).status_code == 204
    assert client.post("/api/auth/refresh", json={"refresh_token": t["refresh_token"]}).status_code == 401


def test_dismiss_password_request(client, admin):
    uid = mk_user(client, admin, "dismiss@auth.com", role="viewer")
    assert client.post(f"/api/password-requests/{uid}/dismiss", headers=admin).status_code == 409      # nothing pending yet
    client.post("/api/auth/forgot", json={"email": "dismiss@auth.com"})
    assert any(r["id"] == uid for r in client.get("/api/password-requests", headers=admin).json())
    assert client.post(f"/api/password-requests/{uid}/dismiss", headers=admin).status_code == 200
    assert not any(r["id"] == uid for r in client.get("/api/password-requests", headers=admin).json())
    assert client.get("/api/admin/overview", headers=admin).json()["users"]["reset_requests"] >= 0

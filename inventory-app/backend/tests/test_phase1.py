import os
import tempfile
import threading


import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c


def signup(c, org, email):
    r = c.post("/api/auth/signup", json={"org_name": org, "name": "Own", "email": email, "password": "password123"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, r.json()


@pytest.fixture(scope="module")
def A(client):
    return signup(client, "Org A", "a@x.com")


@pytest.fixture(scope="module")
def B(client):
    return signup(client, "Org B", "b@x.com")


def mk_product(c, h, **kw):
    r = c.post("/api/products", json={"name": "Widget", **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def wh(c, h):
    return c.get("/api/warehouses", headers=h).json()[0]["id"]


def test_auth_flow(client, A):
    h, tokens = A
    assert client.get("/api/auth/me", headers=h).json()["role"] == "owner"
    assert client.get("/api/products").status_code == 401
    r = client.post("/api/auth/login", data={"username": "a@x.com", "password": "wrong"})
    assert r.status_code == 401
    r = client.post("/api/auth/login", data={"username": "a@x.com", "password": "password123"})
    assert r.status_code == 200
    ref = r.json()["refresh_token"]
    r2 = client.post("/api/auth/refresh", json={"refresh_token": ref})
    assert r2.status_code == 200
    assert client.post("/api/auth/refresh", json={"refresh_token": ref}).status_code == 401  # single-use
    assert client.post("/api/auth/signup", json={"org_name": "Zed", "name": "z", "email": "a@x.com",
                                                 "password": "password123"}).status_code == 409


def test_product_crud_validation(client, A):
    h, _ = A
    p = mk_product(client, h, sku="W-1", selling_price=100, purchase_price=60)
    assert p["barcode"] and len(p["barcode"]) == 13
    assert client.post("/api/products", json={"name": "Dup", "sku": "W-1"}, headers=h).status_code == 409
    assert client.post("/api/products", json={"name": "Neg", "selling_price": -1}, headers=h).status_code == 422
    auto = mk_product(client, h, name="Auto")
    assert auto["sku"].startswith("SKU-")
    assert client.get(f"/api/products/lookup/{p['barcode']}", headers=h).json()["id"] == p["id"]
    assert client.patch(f"/api/products/{p['id']}", json={"selling_price": 120}, headers=h).json()["selling_price"] == 120
    assert client.get("/api/products?q=auto", headers=h).json()["total"] == 1


def test_tenant_isolation(client, A, B):
    ha, hb = A[0], B[0]
    p = mk_product(client, ha, sku="ISO-1")
    assert client.get(f"/api/products/{p['id']}", headers=hb).status_code == 404
    assert client.patch(f"/api/products/{p['id']}", json={"name": "x"}, headers=hb).status_code == 404
    r = client.post("/api/inventory/receive", headers=hb, json={"product_id": p["id"], "warehouse_id": wh(client, hb),
                                                                "mode": "increase", "quantity": 5, "reason": "hack"})
    assert r.status_code == 404
    assert all(i["sku"] != "ISO-1" for i in client.get("/api/products", headers=hb).json()["items"])


def test_stock_rules(client, A):
    h, _ = A
    w1 = wh(client, h)
    w2 = client.post("/api/warehouses", json={"code": "W2", "name": "Second"}, headers=h).json()["id"]
    p = mk_product(client, h, sku="ST-1", reorder_point=15)
    body = {"product_id": p["id"], "warehouse_id": w1, "mode": "increase", "reason": "opening"}
    assert client.post("/api/inventory/receive", headers=h, json={**body, "quantity": 10, "unit_cost": 50}).status_code == 201
    assert client.post("/api/inventory/receive", headers=h, json={**body, "quantity": 10, "unit_cost": 70}).status_code == 201
    prod = client.get(f"/api/products/{p['id']}", headers=h).json()
    assert prod["on_hand"] == 20 and prod["avg_cost"] == 60  # weighted average
    # no negative stock
    r = client.post("/api/inventory/adjust", headers=h, json={**body, "mode": "decrease", "quantity": 25})
    assert r.status_code == 409 and "Insufficient" in r.json()["detail"]
    # transfer
    r = client.post("/api/inventory/transfer", headers=h, json={"product_id": p["id"], "from_warehouse_id": w1,
                                                               "to_warehouse_id": w2, "quantity": 8})
    assert r.status_code == 201
    st = {s["warehouse"]: s for s in client.get(f"/api/inventory/stock?q=ST-1", headers=h).json()}
    assert st["MAIN"]["on_hand"] == 12 and st["W2"]["on_hand"] == 8
    # failed transfer is atomic (nothing moves)
    r = client.post("/api/inventory/transfer", headers=h, json={"product_id": p["id"], "from_warehouse_id": w2,
                                                               "to_warehouse_id": w1, "quantity": 99})
    assert r.status_code == 409
    assert client.get(f"/api/products/{p['id']}", headers=h).json()["on_hand"] == 20
    # set-count adjustment and low stock notification
    r = client.post("/api/inventory/adjust", headers=h, json={**body, "mode": "set", "quantity": 3, "reason": "cycle count"})
    assert r.status_code == 201 and r.json()["qty_delta"] == -9
    notes = client.get("/api/notifications", headers=h).json()
    assert any("ST-1" in (n["body"] or "") for n in notes["items"])
    # ledger is complete and running balance is consistent
    mv = client.get(f"/api/inventory/movements?product_id={p['id']}", headers=h).json()
    assert mv["total"] == 5  # 2 receipts, transfer out+in, 1 count adjustment; failed ops left no trace
    assert sum(m["qty_delta"] for m in mv["items"]) == 11  # 20 total - 9 adjustment
    # products with history cannot be deleted
    assert client.delete(f"/api/products/{p['id']}", headers=h).status_code == 409


def test_idempotency(client, A):
    h, _ = A
    p = mk_product(client, h, sku="IDEM-1")
    body = {"product_id": p["id"], "warehouse_id": wh(client, h), "mode": "increase", "quantity": 5,
            "reason": "dup test", "idempotency_key": "k-123"}
    a = client.post("/api/inventory/receive", headers=h, json=body).json()
    b = client.post("/api/inventory/receive", headers=h, json=body).json()
    assert a["id"] == b["id"]
    assert client.get(f"/api/products/{p['id']}", headers=h).json()["on_hand"] == 5


def test_concurrent_issues_never_go_negative(client, A):
    h, _ = A
    p = mk_product(client, h, sku="RACE-1")
    w = wh(client, h)
    client.post("/api/inventory/receive", headers=h, json={"product_id": p["id"], "warehouse_id": w,
                                                          "mode": "increase", "quantity": 10, "reason": "seed"})
    results = []

    def go():
        r = client.post("/api/inventory/adjust", headers=h, json={"product_id": p["id"], "warehouse_id": w,
                                                                 "mode": "decrease", "quantity": 1, "reason": "race"})
        results.append(r.status_code)

    ts = [threading.Thread(target=go) for _ in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results.count(201) == 10 and results.count(409) == 10
    assert client.get(f"/api/products/{p['id']}", headers=h).json()["on_hand"] == 0


def test_reservations(client, A):
    from app import stock
    from app.core import SessionLocal
    from app.models import Organization, User
    h, _ = A
    p = mk_product(client, h, sku="RES-1")
    w = wh(client, h)
    client.post("/api/inventory/receive", headers=h, json={"product_id": p["id"], "warehouse_id": w,
                                                          "mode": "increase", "quantity": 10, "reason": "seed"})
    with SessionLocal() as db:
        org = db.get(Organization, db.scalars(__import__("sqlalchemy").select(User).where(User.email == "a@x.com")).first().org_id)
        stock.reserve(db, org, product_id=p["id"], warehouse_id=w, qty=7, ref_type="SO", ref_id="1")
        stock.reserve(db, org, product_id=p["id"], warehouse_id=w, qty=7, ref_type="SO", ref_id="1")  # duplicate, ignored
        db.commit()
        with pytest.raises(stock.StockError):
            stock.reserve(db, org, product_id=p["id"], warehouse_id=w, qty=4, ref_type="SO", ref_id="2")
        db.rollback()
        stock.release(db, org, product_id=p["id"], warehouse_id=w, qty=7, ref_type="SO", ref_id="1")
        db.commit()
    prod = client.get(f"/api/products/{p['id']}", headers=h).json()
    assert prod["reserved"] == 0 and prod["on_hand"] == 10


def test_rbac(client, A):
    h, _ = A
    r = client.post("/api/users", headers=h, json={"email": "v@x.com", "name": "V", "password": "password123", "role": "viewer"})
    assert r.status_code == 201
    tok = client.post("/api/auth/login", data={"username": "v@x.com", "password": "password123"}).json()["access_token"]
    hv = {"Authorization": f"Bearer {tok}"}
    assert client.get("/api/products", headers=hv).status_code == 200
    assert client.post("/api/products", json={"name": "x"}, headers=hv).status_code == 403
    assert client.get("/api/users", headers=hv).status_code == 403
    assert client.post("/api/inventory/receive", headers=hv, json={"product_id": 1, "warehouse_id": 1, "mode": "increase",
                                                                  "quantity": 1, "reason": "nope"}).status_code == 403


def test_csv_roundtrip_and_dashboard(client, A):
    h, _ = A
    csv_in = "name,sku,category,purchase_price,selling_price,tax_rate\nCSV One,CSV-1,Tools,10,20,12\n,,,,,\nBad,CSV-1,,1,1,18\n"
    r = client.post("/api/products-import", headers=h, files={"file": ("p.csv", csv_in, "text/csv")}).json()
    assert r["created"] == 1 and len(r["errors"]) == 2
    assert "CSV-1" in client.get("/api/products-export.csv", headers=h).text
    d = client.get("/api/dashboard", headers=h).json()
    assert d["products"] >= 5 and d["inventory_value"] > 0 and d["recent"]

import threading

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as cl:
        yield cl


def signup(c, email, org):
    r = c.post("/api/auth/signup", json={"org_name": org, "name": "Owner", "email": email, "password": "password123"})
    assert r.status_code == 201
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def staff(c, h, email, role):
    assert c.post("/api/users", headers=h, json={"email": email, "name": role, "password": "password123", "role": role}).status_code == 201
    return {"Authorization": f"Bearer {c.post('/api/auth/login', data={'username': email, 'password': 'password123'}).json()['access_token']}"}


@pytest.fixture(scope="module")
def W(c):
    h = signup(c, "adj-owner@x.com", "Adj Org")
    wh = c.get("/api/warehouses", headers=h).json()[0]["id"]
    mk = lambda sku, stock, cost=10: c.post("/api/products", headers=h, json={"name": f"Item {sku}", "sku": sku, "purchase_price": cost, "opening_stock": stock}).json()  # noqa: E731
    return {"h": h, "wh": wh, "mk": mk}


def adj(c, W, typ, lines, **kw):
    return c.post("/api/adjustments", headers=W["h"], json={"adj_type": typ, "warehouse_id": W["wh"], "reason": kw.pop("reason", "Stock take"), "lines": lines, **kw})


def stock(c, W, pid):
    return c.get(f"/api/products/{pid}", headers=W["h"]).json()


def recon(c, W):
    r = c.get("/api/inventory/reconcile", headers=W["h"]).json()
    assert r["ok"], r


def test_increase_decrease_and_movements(c, W):
    p = W["mk"]("A-1", 10, cost=10)
    r = adj(c, W, "increase", [{"product_id": p["id"], "quantity": 5, "unit_cost": 20}])
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["number"] == "ADJ-00001" and d["net_units"] == 5 and d["lines"][0]["qty_before"] == 10 and d["lines"][0]["qty_after"] == 15
    assert stock(c, W, p["id"])["on_hand"] == 15 and abs(stock(c, W, p["id"])["avg_cost"] - 13.3333) < 0.001  # (10*10 + 5*20) / 15
    mv = c.get(f"/api/inventory/movements?product_id={p['id']}&type=adjustment", headers=W["h"]).json()["items"][0]
    assert "ADJ-00001" in mv["reason"] and mv["user_id"]
    r = adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 3}], reason="Sample used in demo")
    assert r.status_code == 201 and r.json()["net_units"] == -3 and r.json()["value_impact"] < 0
    assert stock(c, W, p["id"])["on_hand"] == 12
    recon(c, W)


def test_all_or_nothing_and_no_negative_stock(c, W):
    a, b = W["mk"]("B-A", 10), W["mk"]("B-B", 2)
    r = adj(c, W, "decrease", [{"product_id": a["id"], "quantity": 4}, {"product_id": b["id"], "quantity": 5}])
    assert r.status_code == 409 and "Insufficient" in r.json()["detail"] and "Item B-B" in r.json()["detail"]
    assert stock(c, W, a["id"])["on_hand"] == 10  # the valid first line was rolled back too
    before = c.get("/api/adjustments", headers=W["h"]).json()["total"]
    assert c.get("/api/adjustments", headers=W["h"]).json()["total"] == before  # nothing recorded
    bad = lambda **k: c.post("/api/adjustments", headers=W["h"], json={"adj_type": "decrease", "warehouse_id": W["wh"], "reason": "x yz", "lines": [{"product_id": a["id"], "quantity": 1}], **k}).status_code  # noqa: E731
    assert bad(reason="ab") == 422 and bad(adj_type="weird") == 422 and bad(lines=[]) == 422 and bad(lines=[{"product_id": a["id"], "quantity": 0}]) == 422
    assert bad(lines=[{"product_id": a["id"], "quantity": -2}]) == 422 and bad(warehouse_id=999999) == 422 and bad(lines=[{"product_id": 999999, "quantity": 1}]) == 422
    recon(c, W)


def test_damage_and_missing(c, W):
    p = W["mk"]("D-1", 20)
    r = adj(c, W, "damage", [{"product_id": p["id"], "quantity": 4}], reason="Water damage in racking")
    assert r.status_code == 201
    s = stock(c, W, p["id"])
    assert s["on_hand"] == 16 and s["damaged"] == 4 and s["available"] == 16  # damaged units leave sellable stock
    m = adj(c, W, "missing", [{"product_id": p["id"], "quantity": 2}], reason="Not found during count")
    assert m.status_code == 201 and m.json()["type_label"] == "Missing stock" and stock(c, W, p["id"])["on_hand"] == 14 and stock(c, W, p["id"])["damaged"] == 4
    assert c.get("/api/adjustments", headers=W["h"], params={"adj_type": "damage"}).json()["items"][0]["reason"] == "Water damage in racking"
    recon(c, W)


def test_correction_sets_the_counted_quantity(c, W):
    p, q = W["mk"]("C-1", 10), W["mk"]("C-2", 7)
    r = adj(c, W, "correction", [{"product_id": p["id"], "quantity": 13}, {"product_id": q["id"], "quantity": 0}], reason="Cycle count aisle 4")
    assert r.status_code == 201, r.text
    lines = {l["sku"]: l for l in r.json()["lines"]}
    assert (lines["C-1"]["qty_before"], lines["C-1"]["qty_delta"], lines["C-1"]["qty_after"]) == (10, 3, 13)
    assert (lines["C-2"]["qty_before"], lines["C-2"]["qty_delta"], lines["C-2"]["qty_after"]) == (7, -7, 0)  # counted zero is valid
    assert stock(c, W, p["id"])["on_hand"] == 13 and stock(c, W, q["id"])["on_hand"] == 0
    same = adj(c, W, "correction", [{"product_id": p["id"], "quantity": 13}])
    assert same.status_code == 422 and "nothing to adjust" in same.json()["detail"]
    dup = adj(c, W, "correction", [{"product_id": p["id"], "quantity": 5}, {"product_id": p["id"], "quantity": 6}])
    assert dup.status_code == 422
    recon(c, W)


def test_idempotency_and_duplicate_lines(c, W):
    p = W["mk"]("I-1", 10)
    k = {"idempotency_key": "adj-dbl-1"}
    a = adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 2}], **k)
    b = adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 2}], **k)
    assert a.status_code == 201 and b.json()["number"] == a.json()["number"]
    assert stock(c, W, p["id"])["on_hand"] == 8  # applied once
    m = adj(c, W, "increase", [{"product_id": p["id"], "quantity": 1}, {"product_id": p["id"], "quantity": 2}])
    assert m.json()["line_count"] == 1 and m.json()["net_units"] == 3  # repeated item lines are merged
    recon(c, W)


def test_cannot_adjust_below_reserved_stock(c, W):
    h = W["h"]
    p = W["mk"]("R-1", 10)
    cu = c.post("/api/customers", headers=h, json={"name": "Holder"}).json()
    so = c.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": W["wh"], "lines": [{"product_id": p["id"], "quantity": 8}]}).json()
    assert c.post(f"/api/sales-orders/{so['id']}/confirm", headers=h).status_code == 200  # 8 reserved, 2 free
    r = adj(c, W, "damage", [{"product_id": p["id"], "quantity": 5}])
    assert r.status_code == 409 and "Insufficient" in r.json()["detail"]  # would eat into stock promised to a customer
    assert adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 2}]).status_code == 201
    corr = adj(c, W, "correction", [{"product_id": p["id"], "quantity": 5}])  # a count below what is reserved
    assert corr.status_code == 409
    recon(c, W)


def test_concurrent_adjustments_never_go_negative(c, W):
    p = W["mk"]("RACE-A", 5)
    res = []

    def go(i):
        res.append(adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 1}], idempotency_key=f"race-{i}").status_code)

    ts = [threading.Thread(target=go, args=(i,)) for i in range(10)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert res.count(201) == 5 and res.count(409) == 5, res
    assert stock(c, W, p["id"])["on_hand"] == 0
    recon(c, W)


def test_list_filters_detail_export_and_security(c, W):
    h = W["h"]
    p = W["mk"]("L-1", 30)
    adj(c, W, "increase", [{"product_id": p["id"], "quantity": 4}], reason="Found in returns bin")
    adj(c, W, "decrease", [{"product_id": p["id"], "quantity": 1}], reason="Staff sample")
    assert c.get("/api/adjustments", headers=h, params={"product_id": p["id"]}).json()["total"] == 2
    assert c.get("/api/adjustments", headers=h, params={"q": "returns bin"}).json()["total"] == 1
    assert c.get("/api/adjustments", headers=h, params={"date_from": "2999-01-01"}).json()["total"] == 0
    assert c.get("/api/adjustments", headers=h, params={"warehouse_id": 999999}).json()["total"] == 0
    first = c.get("/api/adjustments", headers=h, params={"product_id": p["id"]}).json()["items"][-1]
    d = c.get(f"/api/adjustments/{first['id']}", headers=h).json()
    assert d["lines"][0]["movement_id"] and d["created_by"] == "Owner" and d["lines"][0]["qty_after"] == 34
    assert "Found in returns bin" in c.get("/api/adjustments-export.csv", headers=h).text
    other = signup(c, "adj-other@x.com", "Other Adj Org")
    assert c.get(f"/api/adjustments/{first['id']}", headers=other).status_code == 404 and c.get("/api/adjustments").status_code == 401
    wh_staff, viewer, sales, acct = staff(c, h, "adj-w@x.com", "warehouse"), staff(c, h, "adj-v@x.com", "viewer"), staff(c, h, "adj-s@x.com", "sales"), staff(c, h, "adj-a@x.com", "accountant")
    body = {"adj_type": "increase", "warehouse_id": W["wh"], "reason": "Delivery top-up", "lines": [{"product_id": p["id"], "quantity": 1}]}
    assert c.post("/api/adjustments", headers=wh_staff, json=body).status_code == 201  # warehouse staff adjust stock
    assert c.post("/api/adjustments", headers=viewer, json=body).status_code == 403 and c.get("/api/adjustments", headers=viewer).status_code == 200
    assert c.post("/api/adjustments", headers=sales, json=body).status_code == 403 and c.post("/api/adjustments", headers=acct, json=body).status_code == 403
    assert c.post("/api/adjustments", headers=other, json=body).status_code == 422  # another tenant's warehouse/items don't exist for it
    recon(c, W)

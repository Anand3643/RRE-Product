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
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def staff(c, h, email, role):
    assert c.post("/api/users", headers=h, json={"email": email, "name": role, "password": "password123", "role": role}).status_code == 201
    return {"Authorization": f"Bearer {c.post('/api/auth/login', data={'username': email, 'password': 'password123'}).json()['access_token']}"}


@pytest.fixture(scope="module")
def W(c):
    h = signup(c, "sales-owner@x.com", "Sales Org")
    c.patch("/api/organization", headers=h, json={"gstin": "27ABCDE1234F1Z5", "state": "Maharashtra"})
    wh1 = c.get("/api/warehouses", headers=h).json()[0]["id"]
    wh2 = c.post("/api/warehouses", headers=h, json={"code": "W2", "name": "Second"}).json()["id"]
    cust = c.post("/api/customers", headers=h, json={"name": "Local Buyer", "gstin": "27AABCL1111A1Z1", "ship_state": "Maharashtra"}).json()
    far = c.post("/api/customers", headers=h, json={"name": "Far Buyer", "gstin": "29AABCF2222B1Z3", "ship_state": "Karnataka"}).json()
    mk = lambda sku, price, stock, tax=18, wh=wh1: c.post("/api/products", headers=h, json={"name": f"Item {sku}", "sku": sku, "selling_price": price, "purchase_price": price / 2, "tax_rate": tax, "opening_stock": stock, "opening_warehouse_id": wh}).json()  # noqa: E731
    return {"h": h, "wh1": wh1, "wh2": wh2, "cust": cust, "far": far, "mk": mk}


def so(c, W, lines, customer="cust", **kw):
    r = c.post("/api/sales-orders", headers=W["h"], json={"customer_id": W[customer]["id"], "warehouse_id": W["wh1"], "lines": lines, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def prod(c, W, pid):
    return c.get(f"/api/products/{pid}", headers=W["h"]).json()


def ok_recon(c, W):
    r = c.get("/api/inventory/reconcile", headers=W["h"]).json()
    assert r["ok"], r
    return r


# ------------------------------------------------------------------ create & totals
def test_prices_totals_and_gst_split(c, W):
    p = W["mk"]("S-1", 200, 50)
    o = so(c, W, [{"product_id": p["id"], "quantity": 5, "discount_pct": 10}], shipping_charge=100)
    assert o["number"] == "SO-00001" and o["status"] == "draft" and o["gst_mode"] == "intra"
    l = o["lines"][0]
    assert (l["rate"], l["taxable"], l["tax_amount"], l["amount"]) == (200, 900, 162, 1062)  # price fetched from the item
    assert (o["subtotal"], o["discount_total"], o["cgst"], o["sgst"], o["shipping_charge"], o["total"]) == (1000, 100, 81, 81, 100, 1162)
    far = so(c, W, [{"product_id": p["id"], "quantity": 1}], customer="far")
    assert far["gst_mode"] == "inter" and far["igst"] == 36 and far["cgst"] == 0
    assert "Far Buyer" in far["ship_to"]
    assert c.get("/api/inventory/reconcile", headers=W["h"]).json()["ok"] and prod(c, W, p["id"])["reserved"] == 0  # drafts reserve nothing


def test_order_validation_and_draft_rules(c, W):
    p = W["mk"]("S-2", 10, 5)
    h = W["h"]
    post = lambda **k: c.post("/api/sales-orders", headers=h, json={"customer_id": W["cust"]["id"], "warehouse_id": W["wh1"], "lines": [{"product_id": p["id"], "quantity": 1}], **k}).status_code  # noqa: E731
    assert post(lines=[]) == 422 and post(lines=[{"product_id": p["id"], "quantity": 0}]) == 422 and post(lines=[{"product_id": p["id"], "quantity": 1, "discount_pct": 120}]) == 422
    assert post(customer_id=999999) == 422 and post(warehouse_id=999999) == 422 and post(shipping_charge=-5) == 422
    assert post(order_date="2026-01-10", expected_date="2026-01-01") == 422
    o = so(c, W, [{"product_id": p["id"], "quantity": 2}])
    upd = {"customer_id": W["cust"]["id"], "warehouse_id": W["wh1"], "lines": [{"product_id": p["id"], "quantity": 3}]}
    assert c.put(f"/api/sales-orders/{o['id']}", headers=h, json=upd).json()["lines"][0]["quantity"] == 3
    assert c.post(f"/api/sales-orders/{o['id']}/confirm", headers=h).json()["status"] == "confirmed"
    assert c.put(f"/api/sales-orders/{o['id']}", headers=h, json=upd).status_code == 409
    assert c.delete(f"/api/sales-orders/{o['id']}", headers=h).status_code == 409
    d = so(c, W, [{"product_id": p["id"], "quantity": 1}])
    assert c.delete(f"/api/sales-orders/{d['id']}", headers=h).status_code == 204


# ------------------------------------------------------------------ reservation
def test_confirm_reserves_and_is_all_or_nothing(c, W):
    a, b = W["mk"]("R-A", 10, 10), W["mk"]("R-B", 10, 2)
    h = W["h"]
    o = so(c, W, [{"product_id": a["id"], "quantity": 4}, {"product_id": b["id"], "quantity": 5}])  # B has only 2
    r = c.post(f"/api/sales-orders/{o['id']}/confirm", headers=h)
    assert r.status_code == 409 and "Insufficient stock" in r.json()["detail"]
    assert prod(c, W, a["id"])["reserved"] == 0  # line A was NOT left reserved
    ok = so(c, W, [{"product_id": a["id"], "quantity": 4}, {"product_id": b["id"], "quantity": 2}])
    r = c.post(f"/api/sales-orders/{ok['id']}/confirm", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "confirmed"
    pa = prod(c, W, a["id"])
    assert (pa["on_hand"], pa["reserved"], pa["available"]) == (10, 4, 6)
    mv = c.get(f"/api/inventory/movements?product_id={a['id']}&type=reserve", headers=h).json()["items"][0]
    assert mv["ref_type"] == "SO" and mv["reserved_delta"] == 4 and mv["qty_delta"] == 0
    assert c.post(f"/api/sales-orders/{ok['id']}/confirm", headers=h).status_code == 409  # no double reservation
    assert prod(c, W, a["id"])["reserved"] == 4
    ok_recon(c, W)
    # a second order can only take what's still available
    big = so(c, W, [{"product_id": a["id"], "quantity": 7}])
    assert c.post(f"/api/sales-orders/{big['id']}/confirm", headers=h).status_code == 409
    small = so(c, W, [{"product_id": a["id"], "quantity": 6}])
    assert c.post(f"/api/sales-orders/{small['id']}/confirm", headers=h).status_code == 200
    assert prod(c, W, a["id"])["available"] == 0
    ok_recon(c, W)


def test_concurrent_confirmations_never_oversell(c, W):
    p = W["mk"]("RACE-1", 10, 10)
    orders = [so(c, W, [{"product_id": p["id"], "quantity": 3}]) for _ in range(8)]
    res = []

    def go(o):
        res.append(c.post(f"/api/sales-orders/{o['id']}/confirm", headers=W["h"]).status_code)

    ts = [threading.Thread(target=go, args=(o,)) for o in orders]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert res.count(200) == 3 and res.count(409) == 5, res  # 3 x 3 = 9 <= 10; a 4th would oversell
    pr = prod(c, W, p["id"])
    assert pr["reserved"] == 9 and pr["on_hand"] == 10 and pr["available"] == 1
    assert sum(1 for o in c.get("/api/sales-orders", headers=W["h"], params={"status": "confirmed", "page_size": 200}).json()["items"] if o["total"] == 3 * 10 * 1.18) >= 3
    ok_recon(c, W)


def test_cancel_releases_reservation(c, W):
    p = W["mk"]("CAN-1", 10, 10)
    h = W["h"]
    o = so(c, W, [{"product_id": p["id"], "quantity": 6}])
    c.post(f"/api/sales-orders/{o['id']}/confirm", headers=h)
    assert prod(c, W, p["id"])["available"] == 4
    r = c.post(f"/api/sales-orders/{o['id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert prod(c, W, p["id"])["reserved"] == 0 and prod(c, W, p["id"])["available"] == 10
    assert c.post(f"/api/sales-orders/{o['id']}/cancel", headers=h).status_code == 409  # not released twice
    assert prod(c, W, p["id"])["reserved"] == 0
    d = so(c, W, [{"product_id": p["id"], "quantity": 1}])  # cancelling a draft needs no release
    assert c.post(f"/api/sales-orders/{d['id']}/cancel", headers=h).json()["status"] == "cancelled"
    ok_recon(c, W)


# ------------------------------------------------------------------ packing & shipping
_n = [0]


def full_flow_setup(c, W, qty_a=10, qty_b=5):
    _n[0] += 1
    a, b = W["mk"](f"F-A{_n[0]}", 100, 50), W["mk"](f"F-B{_n[0]}", 40, 50)
    o = so(c, W, [{"product_id": a["id"], "quantity": qty_a}, {"product_id": b["id"], "quantity": qty_b}])
    assert c.post(f"/api/sales-orders/{o['id']}/confirm", headers=W["h"]).status_code == 200
    return a, b, c.get(f"/api/sales-orders/{o['id']}", headers=W["h"]).json()


def test_packing_rules_and_no_stock_movement(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 10, 5)
    la, lb = o["lines"][0]["id"], o["lines"][1]["id"]
    draft = so(c, W, [{"product_id": a["id"], "quantity": 1}])
    assert c.post(f"/api/sales-orders/{draft['id']}/packages", headers=h, json={"lines": [{"so_line_id": draft["lines"][0]["id"], "quantity": 1}]}).status_code == 409
    pk = lambda lines, **k: c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": lines, **k})  # noqa: E731
    assert pk([{"so_line_id": la, "quantity": 11}]).status_code == 422  # more than ordered
    assert pk([{"so_line_id": 99999, "quantity": 1}]).status_code == 422
    r = pk([{"so_line_id": la, "quantity": 4}], weight_kg=2.5, idempotency_key="pk-1")
    assert r.status_code == 201 and r.json()["number"].startswith("PKG-") and r.json()["status"] == "packed"
    assert pk([{"so_line_id": la, "quantity": 4}], idempotency_key="pk-1").json()["number"] == r.json()["number"]  # double-submit is a no-op
    d = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()
    assert d["lines"][0]["qty_packed"] == 4 and d["status"] == "confirmed"  # not fully packed yet
    assert pk([{"so_line_id": la, "quantity": 7}]).status_code == 422  # only 6 left
    pa = prod(c, W, a["id"])
    assert (pa["on_hand"], pa["reserved"]) == (50, 10)  # packing moved no stock
    r2 = pk([{"so_line_id": la, "quantity": 6}, {"so_line_id": lb, "quantity": 5}])
    assert r2.status_code == 201
    assert c.get(f"/api/sales-orders/{o['id']}", headers=h).json()["status"] == "packed"
    assert pk([{"so_line_id": lb, "quantity": 1}]).status_code == 422
    # void returns the quantity to "unpacked"
    assert c.post(f"/api/packages/{r2.json()['id']}/void", headers=h).json()["status"] == "void"
    d = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()
    assert d["status"] == "confirmed" and d["lines"][0]["qty_packed"] == 4 and d["lines"][1]["qty_packed"] == 0
    assert c.post(f"/api/packages/{r2.json()['id']}/void", headers=h).status_code == 409
    ok_recon(c, W)


def test_package_must_come_from_one_warehouse(c, W):
    a, b = W["mk"]("MW-A", 10, 5), W["mk"]("MW-B", 10, 5, wh=W["wh2"])
    o = so(c, W, [{"product_id": a["id"], "quantity": 1}, {"product_id": b["id"], "quantity": 1, "warehouse_id": W["wh2"]}])
    assert c.post(f"/api/sales-orders/{o['id']}/confirm", headers=W["h"]).status_code == 200
    d = c.get(f"/api/sales-orders/{o['id']}", headers=W["h"]).json()
    both = c.post(f"/api/sales-orders/{o['id']}/packages", headers=W["h"], json={"lines": [{"so_line_id": l["id"], "quantity": 1} for l in d["lines"]]})
    assert both.status_code == 422 and "one warehouse" in both.json()["detail"]
    assert c.post(f"/api/sales-orders/{o['id']}/packages", headers=W["h"], json={"lines": [{"so_line_id": d["lines"][1]["id"], "quantity": 1}]}).status_code == 201
    assert prod(c, W, b["id"])["balances"][0]["reserved"] == 1  # reserved in the line's own warehouse
    ok_recon(c, W)


def test_shipping_deducts_stock_once_and_full_delivery(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 10, 5)
    pk = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in o["lines"]]}).json()
    assert c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "X", "expected_delivery": "2020-01-01", "shipping_date": "2021-01-01"}).status_code == 422
    s = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "BlueDart", "tracking_number": "TRK123"})
    assert s.status_code == 201 and s.json()["status"] == "ready_to_ship" and s.json()["number"].startswith("SHP-")
    sid = s.json()["id"]
    assert c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "Again"}).status_code == 409
    assert prod(c, W, a["id"])["on_hand"] == 50  # still in the warehouse
    st = lambda to, **k: c.post(f"/api/shipments/{sid}/status", headers=h, json={"status": to, **k})  # noqa: E731
    assert st("delivered").status_code == 409  # can't skip shipping
    # five clients try to mark it shipped at the same moment: stock must leave exactly once
    res = []
    ts = [threading.Thread(target=lambda: res.append(st("shipped").status_code)) for _ in range(5)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert res.count(200) == 1 and res.count(409) == 4, res
    pa, pb = prod(c, W, a["id"]), prod(c, W, b["id"])
    assert (pa["on_hand"], pa["reserved"]) == (40, 0) and (pb["on_hand"], pb["reserved"]) == (45, 0)
    mv = c.get(f"/api/inventory/movements?product_id={a['id']}&type=issue", headers=h).json()["items"]
    assert len(mv) == 1 and mv[0]["qty_delta"] == -10 and mv[0]["reserved_delta"] == -10 and mv[0]["ref_type"] == "SHP"
    d = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()
    assert d["status"] == "shipped" and d["shipped_pct"] == 100 and d["delivered_pct"] == 0
    assert c.post(f"/api/sales-orders/{o['id']}/cancel", headers=h).status_code == 409  # already shipped
    assert st("in_transit", location="Hub").status_code == 200 and st("out_for_delivery").status_code == 200
    f = st("failed_delivery")
    assert f.status_code == 422  # needs a reason
    assert st("failed_delivery", failure_reason="Customer unavailable").json()["failure_reason"] == "Customer unavailable"
    assert any("Failed delivery" in n["title"] for n in c.get("/api/notifications", headers=h).json()["items"])
    assert st("out_for_delivery").status_code == 200  # retry
    done = st("delivered", delivered_to="Ravi")
    assert done.status_code == 200 and done.json()["delivered_to"] == "Ravi" and done.json()["delivered_at"]
    assert st("shipped").status_code == 409 and st("in_transit").status_code == 409  # delivered is final
    d = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()
    assert d["status"] == "delivered" and d["delivered_pct"] == 100
    ev = c.get(f"/api/shipments/{sid}", headers=h).json()["events"]
    assert [e["status"] for e in ev] == ["ready_to_ship", "shipped", "in_transit", "out_for_delivery", "failed_delivery", "out_for_delivery", "delivered"]
    assert prod(c, W, a["id"])["on_hand"] == 40  # delivery moved no stock
    ok_recon(c, W)


def test_partial_shipments_keep_remaining_reservation(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 10, 4)
    la, lb = o["lines"][0]["id"], o["lines"][1]["id"]
    p1 = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": la, "quantity": 6}]}).json()
    p2 = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": la, "quantity": 4}, {"so_line_id": lb, "quantity": 4}]}).json()
    assert c.get(f"/api/sales-orders/{o['id']}", headers=h).json()["status"] == "packed"
    s1 = c.post(f"/api/packages/{p1['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
    s2 = c.post(f"/api/packages/{p2['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
    assert c.post(f"/api/shipments/{s1['id']}/status", headers=h, json={"status": "shipped"}).status_code == 200
    pa = prod(c, W, a["id"])
    assert (pa["on_hand"], pa["reserved"]) == (44, 4)  # 6 left, 4 still held for the second package
    d = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()
    assert d["status"] == "packed" and d["lines"][0]["qty_shipped"] == 6
    ok_recon(c, W)  # reservation invariant holds mid-fulfilment
    assert c.post(f"/api/sales-orders/{o['id']}/cancel", headers=h).status_code == 409  # part has shipped
    assert c.post(f"/api/packages/{p1['id']}/void", headers=h).status_code == 409  # shipped packages can't be voided
    assert c.post(f"/api/shipments/{s2['id']}/status", headers=h, json={"status": "shipped"}).status_code == 200
    assert c.get(f"/api/sales-orders/{o['id']}", headers=h).json()["status"] == "shipped"
    assert prod(c, W, a["id"])["reserved"] == 0 and prod(c, W, b["id"])["on_hand"] == 46
    ok_recon(c, W)


def test_cancelling_a_packed_order_voids_packages_and_releases(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 3, 2)
    pk = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in o["lines"]]}).json()
    shp = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
    r = c.post(f"/api/sales-orders/{o['id']}/cancel", headers=h)
    assert r.status_code == 200 and prod(c, W, a["id"])["reserved"] == 0 and prod(c, W, a["id"])["on_hand"] == 50
    assert c.get(f"/api/packages/{pk['id']}", headers=h).json()["status"] == "void"
    assert c.get(f"/api/shipments/{shp['id']}", headers=h).json()["status"] == "cancelled"
    ok_recon(c, W)


def test_simulated_tracking_is_labelled_and_carriers_are_honest(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 1, 1)
    pk = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": 1} for l in o["lines"]]}).json()
    sid = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "Local"}).json()["id"]
    assert c.post(f"/api/shipments/{sid}/simulate-advance", headers=h).status_code == 409  # nothing to simulate before it ships
    c.post(f"/api/shipments/{sid}/status", headers=h, json={"status": "shipped"})
    for expect in ("in_transit", "out_for_delivery", "delivered"):
        assert c.post(f"/api/shipments/{sid}/simulate-advance", headers=h).json()["status"] == expect
    ev = c.get(f"/api/shipments/{sid}", headers=h).json()["events"]
    assert [e["source"] for e in ev] == ["manual", "manual", "simulated", "simulated", "simulated"]
    assert c.post(f"/api/shipments/{sid}/simulate-advance", headers=h).status_code == 409
    car = {x["id"]: x for x in c.get("/api/integrations/carriers", headers=h).json()}
    assert car["manual"]["configured"] and not car["manual"]["live"] and not car["delhivery"]["configured"] and not any(x["live"] for x in car.values())
    assert c.get(f"/api/shipments/{sid}", headers=h).json()["tracking_mode"] == "manual"


# ------------------------------------------------------------------ credit, money, documents
def test_credit_limit_and_override(c, W):
    h = W["h"]
    cu = c.post("/api/customers", headers=h, json={"name": "Limited", "credit_limit": 1000}).json()
    p = W["mk"]("CR-1", 100, 100, tax=0)
    mk = lambda q: so(c, W, [{"product_id": p["id"], "quantity": q}], customer="cust") | {}  # noqa: E731
    W["lim"] = cu
    o1 = c.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": W["wh1"], "lines": [{"product_id": p["id"], "quantity": 6}]}).json()  # 600
    assert c.post(f"/api/sales-orders/{o1['id']}/confirm", headers=h).status_code == 200
    o2 = c.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": W["wh1"], "lines": [{"product_id": p["id"], "quantity": 5}]}).json()  # 500 -> 1100
    r = c.post(f"/api/sales-orders/{o2['id']}/confirm", headers=h)
    assert r.status_code == 409 and "Credit limit exceeded" in r.json()["detail"]
    assert prod(c, W, p["id"])["reserved"] == 6  # the blocked order reserved nothing
    sales = staff(c, h, "cr-sales@x.com", "sales")
    assert c.post(f"/api/sales-orders/{o2['id']}/confirm", headers=sales, params={"override_credit": True}).status_code == 403
    mgr = staff(c, h, "cr-mgr@x.com", "manager")
    r = c.post(f"/api/sales-orders/{o2['id']}/confirm", headers=mgr, params={"override_credit": True})
    assert r.status_code == 200 and r.json()["credit_override"] is True
    assert c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()["credit_used_pct"] == 110.0
    assert mk is not None
    ok_recon(c, W)


def test_customer_billing_payments_and_stats(c, W):
    h = W["h"]
    cu = c.post("/api/customers", headers=h, json={"name": "Pays Late", "gstin": "27AABCP3333C1Z7"}).json()
    p = W["mk"]("PAY-1", 100, 100, tax=18)
    o = c.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": W["wh1"], "shipping_charge": 100, "lines": [{"product_id": p["id"], "quantity": 10}]}).json()  # 1000 + 180 tax + 100 = 1280
    c.post(f"/api/sales-orders/{o['id']}/confirm", headers=h)
    s0 = c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()
    assert s0["total_sales"] == 1280 and s0["billed"] == 0 and s0["outstanding"] == 0 and s0["open_orders"] == 1
    pay = lambda amt, hh=None: c.post("/api/payments", headers=hh or h, json={"party_type": "customer", "party_id": cu["id"], "amount": amt, "method": "upi"})  # noqa: E731
    assert pay(10).status_code == 422  # nothing shipped, nothing billed
    l = c.get(f"/api/sales-orders/{o['id']}", headers=h).json()["lines"][0]
    p1 = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": 5}]}).json()
    p2 = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": 5}]}).json()
    s1 = c.post(f"/api/packages/{p1['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
    s2 = c.post(f"/api/packages/{p2['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
    c.post(f"/api/shipments/{s1['id']}/status", headers=h, json={"status": "shipped"})
    st = c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()
    assert st["billed"] == 640 and st["outstanding"] == 640  # half of 1,280 incl. proportional shipping
    c.post(f"/api/shipments/{s2['id']}/status", headers=h, json={"status": "shipped"})
    assert c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()["outstanding"] == 1280
    assert pay(2000).status_code == 422 and pay(0).status_code == 422 and pay(-1).status_code == 422
    wh_staff = staff(c, h, "pay-wh@x.com", "warehouse")
    assert pay(100, wh_staff).status_code == 403  # warehouse staff can't take money
    sales = staff(c, h, "pay-sales@x.com", "sales")
    ok = pay(500, sales)
    assert ok.status_code == 201 and ok.json()["outstanding"] == 780
    st = c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()
    assert st["paid"] == 500 and st["outstanding"] == 780 and st["top_items"][0]["sku"] == "PAY-1" and st["last_order_date"]
    kinds = {e["kind"] for e in c.get(f"/api/customers/{cu['id']}/transactions", headers=h).json()}
    assert {"sales_order", "payment", "shipment"} <= kinds
    assert c.delete(f"/api/customers/{cu['id']}", headers=h).status_code == 409  # has orders
    vendor_pay = c.post("/api/payments", headers=sales, json={"party_type": "vendor", "party_id": 1, "amount": 1})
    assert vendor_pay.status_code == 403  # sales staff can't pay vendors
    assert c.post(f"/api/payments/{ok.json()['id']}/void", headers=sales).status_code == 200
    assert c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()["outstanding"] == 1280
    assert [t["number"] for t in c.get(f"/api/products/{p['id']}/sales-transactions", headers=h).json()] == [o["number"]]


def test_pdfs_listing_export_and_security(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 2, 1)
    pk = c.post(f"/api/sales-orders/{o['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in o["lines"]]}).json()
    shp = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "BlueDart", "tracking_number": "BD998877"}).json()
    for path in (f"/api/sales-orders/{o['id']}/pdf", f"/api/packages/{pk['id']}/slip.pdf", f"/api/shipments/{shp['id']}/label.pdf"):
        r = c.get(path, headers=h)
        assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF") and len(r.content) > 1000, path
    assert o["number"] in c.get("/api/sales-orders-export.csv", headers=h).text and shp["number"] in c.get("/api/shipments-export.csv", headers=h).text
    lst = c.get("/api/shipments", headers=h, params={"q": "BD998877"}).json()
    assert lst["total"] == 1 and lst["items"][0]["status"] == "ready_to_ship"
    assert c.get("/api/packages", headers=h, params={"status": "packed", "q": o["number"]}).json()["total"] >= 1
    lo = c.get("/api/sales-orders", headers=h, params={"status": "packed", "page_size": 200}).json()
    assert lo["items"] and all(i["status"] == "packed" for i in lo["items"]) and {"draft", "confirmed"} <= set(lo["counts"])
    other = signup(c, "sales-other@x.com", "Other Sales Org")
    for path in (f"/api/sales-orders/{o['id']}", f"/api/packages/{pk['id']}", f"/api/shipments/{shp['id']}", f"/api/sales-orders/{o['id']}/pdf", f"/api/shipments/{shp['id']}/label.pdf"):
        assert c.get(path, headers=other).status_code == 404, path
    assert c.post(f"/api/shipments/{shp['id']}/status", headers=other, json={"status": "shipped"}).status_code == 404
    assert c.get("/api/sales-orders").status_code == 401


def test_role_permissions(c, W):
    h = W["h"]
    a, b, o = full_flow_setup(c, W, 2, 1)
    wh_staff, sales, viewer, acct = staff(c, h, "rp-wh@x.com", "warehouse"), staff(c, h, "rp-s@x.com", "sales"), staff(c, h, "rp-v@x.com", "viewer"), staff(c, h, "rp-a@x.com", "accountant")
    lines = [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in o["lines"]]
    assert c.post(f"/api/sales-orders/{o['id']}/packages", headers=sales, json={"lines": lines}).status_code == 403  # sales staff sell, they don't pack
    assert c.post(f"/api/sales-orders/{o['id']}/packages", headers=viewer, json={"lines": lines}).status_code == 403
    assert c.post(f"/api/sales-orders/{o['id']}/packages", headers=wh_staff, json={"lines": lines}).status_code == 201  # warehouse staff pack
    new = {"customer_id": W["cust"]["id"], "warehouse_id": W["wh1"], "lines": [{"product_id": a["id"], "quantity": 1}]}
    assert c.post("/api/sales-orders", headers=wh_staff, json=new).status_code == 403 and c.post("/api/sales-orders", headers=viewer, json=new).status_code == 403
    assert c.post("/api/sales-orders", headers=sales, json=new).status_code == 201
    assert c.get("/api/sales-orders", headers=acct).status_code == 200 and c.get("/api/shipments", headers=acct).status_code == 200
    pid = c.get("/api/packages", headers=h).json()["items"][0]["id"]
    assert c.post(f"/api/packages/{pid}/shipment", headers=acct, json={"carrier": "X1"}).status_code == 403
    assert c.post(f"/api/sales-orders/{o['id']}/cancel", headers=wh_staff).status_code == 403
    ok_recon(c, W)

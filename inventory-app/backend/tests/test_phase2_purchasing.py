import threading
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import stock
from app.core import SessionLocal
from app.main import app
from app.models import Organization, User
from app.tax import document_totals, gst_mode, line_amounts


# ---------------------------------------------------------------- pure tax maths
def test_line_amounts_round_half_up_and_totals_add_up():
    a = line_amounts(10, 100, 10, 18)
    assert (a["gross"], a["discount"], a["taxable"], a["tax"], a["amount"]) == tuple(Decimal(x) for x in ("1000.00", "100.00", "900.00", "162.00", "1062.00"))
    odd = line_amounts(3, "33.33", 0, 5)  # 99.99 -> tax 4.9995 rounds up to 5.00
    assert odd["tax"] == Decimal("5.00")
    lines = [line_amounts(1, "10.03", 0, 5), line_amounts(1, "10.03", 0, 5)]  # each tax 0.5015 -> 0.50, total tax 1.00
    intra = document_totals(lines, "intra")
    assert intra["cgst"] + intra["sgst"] == Decimal("1.00") and intra["total"] == intra["taxable_total"] + Decimal("1.00")
    one = document_totals([line_amounts(1, "10.03", 0, 5)], "intra")  # odd paisa: 0.50 -> 0.25 + 0.25
    assert one["cgst"] + one["sgst"] == Decimal("0.50")
    odd_paisa = document_totals([line_amounts(1, "10.20", 0, 5)], "intra")  # tax 0.51 -> 0.26 + 0.25, never 0.51 + 0.02
    assert odd_paisa["cgst"] + odd_paisa["sgst"] == Decimal("0.51") and abs(odd_paisa["cgst"] - odd_paisa["sgst"]) <= Decimal("0.01")
    inter = document_totals(lines, "inter")
    assert inter["igst"] == Decimal("1.00") and inter["cgst"] == inter["sgst"] == 0


def test_gst_mode_rules():
    class O:  # noqa: D401
        gstin, state = "27ABCDE1234F1Z5", "Maharashtra"
    assert gst_mode(O, "27AAACB1234C1Z5", None) == "intra" and gst_mode(O, "29AABCP5678D1Z2", None) == "inter"
    O2 = type("O2", (), {"gstin": None, "state": "Karnataka"})
    assert gst_mode(O2, None, "karnataka ") == "intra" and gst_mode(O2, None, "Kerala") == "inter"
    assert gst_mode(type("O3", (), {"gstin": None, "state": None}), None, None) == "intra"


# ---------------------------------------------------------------- fixtures
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
    h = signup(c, "po-owner@x.com", "PO Org")
    assert c.patch("/api/organization", headers=h, json={"gstin": "27ABCDE1234F1Z5", "state": "Maharashtra", "address": "1 HQ Road"}).status_code == 200
    wh = c.get("/api/warehouses", headers=h).json()[0]["id"]
    wh2 = c.post("/api/warehouses", headers=h, json={"code": "W2", "name": "Second"}).json()["id"]
    v_in = c.post("/api/vendors", headers=h, json={"name": "Local Vendor", "gstin": "27AAACB1234C1Z5", "bill_state": "Maharashtra"}).json()
    v_out = c.post("/api/vendors", headers=h, json={"name": "Far Vendor", "gstin": "29AABCP5678D1Z2", "bill_state": "Karnataka"}).json()
    p1 = c.post("/api/products", headers=h, json={"name": "Bolt", "sku": "B-1", "purchase_price": 100, "tax_rate": 18}).json()
    p2 = c.post("/api/products", headers=h, json={"name": "Nut", "sku": "N-1", "purchase_price": 50, "tax_rate": 12}).json()
    return {"h": h, "wh": wh, "wh2": wh2, "v": v_in, "vo": v_out, "p1": p1, "p2": p2}


def mkpo(c, W, vendor="v", lines=None, **kw):
    lines = lines or [{"product_id": W["p1"]["id"], "quantity": 10, "discount_pct": 10}]
    r = c.post("/api/purchase-orders", headers=W["h"], json={"vendor_id": W[vendor]["id"], "warehouse_id": W["wh"], "lines": lines, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def on_hand(c, W, pid):
    return c.get(f"/api/products/{pid}", headers=W["h"]).json()["on_hand"]


# ---------------------------------------------------------------- create / validate
def test_server_side_prices_tax_and_gst_split(c, W):
    po = mkpo(c, W)  # rate/tax omitted -> taken from the item
    assert po["number"] == "PO-00001" and po["status"] == "draft" and po["gst_mode"] == "intra"
    l = po["lines"][0]
    assert (l["rate"], l["tax_rate"], l["taxable"], l["tax_amount"], l["amount"]) == (100, 18, 900, 162, 1062)
    assert (po["subtotal"], po["discount_total"], po["cgst"], po["sgst"], po["igst"], po["total"]) == (1000, 100, 81, 81, 0, 1062)
    far = mkpo(c, W, vendor="vo")
    assert far["gst_mode"] == "inter" and (far["igst"], far["cgst"], far["sgst"]) == (162, 0, 0)
    override = mkpo(c, W, lines=[{"product_id": W["p2"]["id"], "quantity": 4, "rate": 60, "tax_rate": 5}])
    assert override["lines"][0]["amount"] == 252 and override["total"] == 252  # 240 + 5%


def test_po_validation(c, W):
    h = W["h"]
    base = {"vendor_id": W["v"]["id"], "warehouse_id": W["wh"], "lines": [{"product_id": W["p1"]["id"], "quantity": 1}]}
    post = lambda **k: c.post("/api/purchase-orders", headers=h, json={**base, **k}).status_code  # noqa: E731
    assert post(lines=[]) == 422 and post(lines=[{"product_id": W["p1"]["id"], "quantity": 0}]) == 422
    assert post(lines=[{"product_id": W["p1"]["id"], "quantity": -3}]) == 422
    assert post(lines=[{"product_id": W["p1"]["id"], "quantity": 1, "discount_pct": 101}]) == 422
    assert post(lines=[{"product_id": W["p1"]["id"], "quantity": 1, "rate": -1}]) == 422
    assert post(lines=[{"product_id": 999999, "quantity": 1}]) == 422 and post(vendor_id=999999) == 422 and post(warehouse_id=999999) == 422
    assert post(order_date=str(date.today()), expected_date=str(date.today() - timedelta(days=1))) == 422
    arch = c.post("/api/products", headers=h, json={"name": "Old", "sku": "OLD-1"}).json()["id"]
    c.patch(f"/api/products/{arch}", headers=h, json={"is_archived": True})
    r = c.post("/api/purchase-orders", headers=h, json={**base, "lines": [{"product_id": arch, "quantity": 1}]})
    assert r.status_code == 422 and "archived" in r.json()["detail"]


def test_lifecycle_rules(c, W):
    h = W["h"]
    po = mkpo(c, W)
    upd = {"vendor_id": W["v"]["id"], "warehouse_id": W["wh"], "lines": [{"product_id": W["p2"]["id"], "quantity": 2}]}
    r = c.put(f"/api/purchase-orders/{po['id']}", headers=h, json=upd)
    assert r.status_code == 200 and r.json()["lines"][0]["sku"] == "N-1" and r.json()["total"] == 112  # 100 + 12%
    assert c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h).json()["status"] == "issued"
    assert c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h).status_code == 409  # no double issue
    assert c.put(f"/api/purchase-orders/{po['id']}", headers=h, json=upd).status_code == 409  # issued orders are frozen
    assert c.delete(f"/api/purchase-orders/{po['id']}", headers=h).status_code == 409
    assert c.post(f"/api/purchase-orders/{po['id']}/cancel", headers=h).json()["status"] == "cancelled"
    assert c.post(f"/api/purchase-orders/{po['id']}/cancel", headers=h).status_code == 409
    d = mkpo(c, W)
    assert c.delete(f"/api/purchase-orders/{d['id']}", headers=h).status_code == 204
    assert c.get(f"/api/purchase-orders/{d['id']}", headers=h).status_code == 404
    inactive = c.post("/api/vendors", headers=h, json={"name": "Sleeping", "status": "inactive"}).json()
    dd = c.post("/api/purchase-orders", headers=h, json={"vendor_id": inactive["id"], "warehouse_id": W["wh"], "lines": [{"product_id": W["p1"]["id"], "quantity": 1}]}).json()
    r = c.post(f"/api/purchase-orders/{dd['id']}/issue", headers=h)
    assert r.status_code == 422 and "inactive" in r.json()["detail"]


# ---------------------------------------------------------------- receiving
def test_partial_receipts_update_stock_status_and_cost(c, W):
    h = W["h"]
    po = mkpo(c, W, lines=[{"product_id": W["p1"]["id"], "quantity": 10, "rate": 100, "tax_rate": 18}, {"product_id": W["p2"]["id"], "quantity": 20, "rate": 50, "tax_rate": 12}])
    pid, l1, l2 = po["id"], po["lines"][0]["id"], po["lines"][1]["id"]
    recv = lambda lines, wh=None, **k: c.post(f"/api/purchase-orders/{pid}/receive", headers=h, json={"warehouse_id": wh or W["wh"], "lines": lines, **k})  # noqa: E731
    assert recv([{"po_line_id": l1, "quantity": 1}]).status_code == 409  # not issued yet
    c.post(f"/api/purchase-orders/{pid}/issue", headers=h)
    before1, before2 = on_hand(c, W, W["p1"]["id"]), on_hand(c, W, W["p2"]["id"])
    r = recv([{"po_line_id": l1, "quantity": 4}])
    assert r.status_code == 201 and r.json()["number"].startswith("GRN-")
    d = c.get(f"/api/purchase-orders/{pid}", headers=h).json()
    assert d["status"] == "partially_received" and d["lines"][0]["qty_received"] == 4 and d["lines"][0]["outstanding"] == 6 and d["received_pct"] == round(4 / 30 * 100, 1)
    assert on_hand(c, W, W["p1"]["id"]) == before1 + 4 and on_hand(c, W, W["p2"]["id"]) == before2
    mv = c.get(f"/api/inventory/movements?product_id={W['p1']['id']}&type=receipt", headers=h).json()["items"][0]
    assert mv["ref_type"] == "GRN" and mv["qty_delta"] == 4 and mv["unit_cost"] == 100
    over = recv([{"po_line_id": l1, "quantity": 7}])
    assert over.status_code == 422 and "outstanding" in over.json()["detail"]
    assert on_hand(c, W, W["p1"]["id"]) == before1 + 4  # the rejected receipt changed nothing
    assert recv([{"po_line_id": 987654, "quantity": 1}]).status_code == 422
    assert recv([{"po_line_id": l1, "quantity": 1}], wh=999999).status_code == 422
    assert c.post(f"/api/purchase-orders/{pid}/cancel", headers=h).status_code == 409  # goods already received
    assert recv([{"po_line_id": l1, "quantity": 6}, {"po_line_id": l2, "quantity": 20}], wh=W["wh2"]).status_code == 201  # rest, into another warehouse
    d = c.get(f"/api/purchase-orders/{pid}", headers=h).json()
    assert d["status"] == "received" and len(d["receipts"]) == 2 and d["received_pct"] == 100
    assert recv([{"po_line_id": l1, "quantity": 1}]).status_code == 409  # fully received
    bal = {b["warehouse"]: b["on_hand"] for b in c.get(f"/api/products/{W['p1']['id']}", headers=h).json()["balances"]}
    assert bal.get("W2") == 6
    assert c.get("/api/inventory/reconcile", headers=h).json()["ok"]


def test_weighted_average_cost_from_receipts(c, W):
    h = W["h"]
    p = c.post("/api/products", headers=h, json={"name": "Costed", "sku": "CST-1", "purchase_price": 10}).json()["id"]
    for qty, rate in ((10, 10), (10, 20)):
        po = mkpo(c, W, lines=[{"product_id": p, "quantity": qty, "rate": rate, "tax_rate": 0}])
        c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h)
        assert c.post(f"/api/purchase-orders/{po['id']}/receive", headers=h, json={"warehouse_id": W["wh"], "lines": [{"po_line_id": po["lines"][0]["id"], "quantity": qty}]}).status_code == 201
    got = c.get(f"/api/products/{p}", headers=h).json()
    assert got["on_hand"] == 20 and got["avg_cost"] == 15  # (10*10 + 10*20) / 20


def test_idempotent_receipt_and_concurrent_over_receipt(c, W):
    h = W["h"]
    po = mkpo(c, W, lines=[{"product_id": W["p2"]["id"], "quantity": 10, "rate": 50, "tax_rate": 0}])
    pid, lid = po["id"], po["lines"][0]["id"]
    c.post(f"/api/purchase-orders/{pid}/issue", headers=h)
    start = on_hand(c, W, W["p2"]["id"])
    body = {"warehouse_id": W["wh"], "lines": [{"po_line_id": lid, "quantity": 3}], "idempotency_key": "dbl-click-1"}
    a = c.post(f"/api/purchase-orders/{pid}/receive", headers=h, json=body)
    b = c.post(f"/api/purchase-orders/{pid}/receive", headers=h, json=body)
    assert a.status_code == 201 and b.json()["number"] == a.json()["number"]
    assert on_hand(c, W, W["p2"]["id"]) == start + 3  # received once
    results = []

    def go(i):
        r = c.post(f"/api/purchase-orders/{pid}/receive", headers=h, json={"warehouse_id": W["wh"], "lines": [{"po_line_id": lid, "quantity": 7}], "idempotency_key": f"race-{i}"})
        results.append(r.status_code)

    ts = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results.count(201) == 1, results  # exactly one of the racing receipts wins
    assert on_hand(c, W, W["p2"]["id"]) == start + 10
    d = c.get(f"/api/purchase-orders/{pid}", headers=h).json()
    assert d["lines"][0]["qty_received"] == 10 and d["status"] == "received"
    assert c.get("/api/inventory/reconcile", headers=h).json()["ok"]


def test_po_numbers_unique_under_concurrency(c, W):
    nums, bad = [], []

    def go():
        r = c.post("/api/purchase-orders", headers=W["h"], json={"vendor_id": W["v"]["id"], "warehouse_id": W["wh"], "lines": [{"product_id": W["p1"]["id"], "quantity": 1}]})
        (nums if r.status_code == 201 else bad).append(r.json().get("number") or r.text)

    ts = [threading.Thread(target=go) for _ in range(10)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not bad, bad
    assert len(set(nums)) == 10


# ---------------------------------------------------------------- security
def test_permissions_and_tenant_isolation(c, W):
    h = W["h"]
    po = mkpo(c, W)
    c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h)
    wh_staff, acct, viewer, sales = staff(c, h, "po-w@x.com", "warehouse"), staff(c, h, "po-a@x.com", "accountant"), staff(c, h, "po-v@x.com", "viewer"), staff(c, h, "po-s@x.com", "sales")
    line = {"warehouse_id": W["wh"], "lines": [{"po_line_id": po["lines"][0]["id"], "quantity": 1}]}
    assert c.get("/api/purchase-orders", headers=wh_staff).status_code == 200
    assert c.post("/api/purchase-orders", headers=wh_staff, json={"vendor_id": W["v"]["id"], "warehouse_id": W["wh"], "lines": [{"product_id": W["p1"]["id"], "quantity": 1}]}).status_code == 403
    assert c.post(f"/api/purchase-orders/{po['id']}/receive", headers=acct, json=line).status_code == 403  # accountants can't touch stock
    assert c.post(f"/api/purchase-orders/{po['id']}/receive", headers=viewer, json=line).status_code == 403
    assert c.get("/api/purchase-orders", headers=sales).status_code == 403  # sales staff have no purchasing access
    assert c.post(f"/api/purchase-orders/{po['id']}/receive", headers=wh_staff, json=line).status_code == 201  # warehouse staff receive goods
    assert c.post(f"/api/purchase-orders/{po['id']}/issue", headers=wh_staff).status_code == 403
    assert c.get("/api/purchase-orders").status_code == 401
    other = signup(c, "po-other@x.com", "Other PO Org")
    assert c.get(f"/api/purchase-orders/{po['id']}", headers=other).status_code == 404
    assert c.post(f"/api/purchase-orders/{po['id']}/receive", headers=other, json=line).status_code == 404
    assert c.get(f"/api/purchase-orders/{po['id']}/pdf", headers=other).status_code == 404
    assert c.post("/api/purchase-orders", headers=other, json={"vendor_id": W["v"]["id"], "warehouse_id": 1, "lines": [{"product_id": W["p1"]["id"], "quantity": 1}]}).status_code == 422
    assert c.patch("/api/organization", headers=wh_staff, json={"name": "Hacked"}).status_code == 403


def test_pdf_and_csv_export(c, W):
    po = mkpo(c, W)
    r = c.get(f"/api/purchase-orders/{po['id']}/pdf", headers=W["h"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF") and len(r.content) > 1500
    assert po["number"] in c.get("/api/purchase-orders-export.csv", headers=W["h"]).text


def test_list_filters_and_counts(c, W):
    h = W["h"]
    all_ = c.get("/api/purchase-orders", headers=h, params={"page_size": 200}).json()
    assert all_["total"] >= 8 and {"draft", "received", "cancelled"} <= set(all_["counts"])
    only = c.get("/api/purchase-orders", headers=h, params={"status": "received"}).json()
    assert only["items"] and all(i["status"] == "received" for i in only["items"])
    assert c.get("/api/purchase-orders", headers=h, params={"vendor_id": W["vo"]["id"]}).json()["total"] >= 1
    assert c.get("/api/purchase-orders", headers=h, params={"q": "far vendor"}).json()["total"] >= 1
    future = str(date.today() + timedelta(days=5))
    assert c.get("/api/purchase-orders", headers=h, params={"date_from": future}).json()["total"] == 0
    t = [i["total"] for i in c.get("/api/purchase-orders", headers=h, params={"sort": "total", "desc": False, "page_size": 200}).json()["items"]]
    assert t == sorted(t)


# ---------------------------------------------------------------- vendor financials & suggestions
def test_vendor_outstanding_payments_and_performance(c, W):
    h = W["h"]
    v = c.post("/api/vendors", headers=h, json={"name": "Finance Vendor", "gstin": "27AAACF1234C1Z5"}).json()
    p = c.post("/api/products", headers=h, json={"name": "FinItem", "sku": "FIN-1"}).json()["id"]
    exp = str(date.today() + timedelta(days=3))
    po = c.post("/api/purchase-orders", headers=h, json={"vendor_id": v["id"], "warehouse_id": W["wh"], "expected_date": exp, "lines": [{"product_id": p, "quantity": 10, "rate": 100, "tax_rate": 18}]}).json()
    c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h)
    s = c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()
    assert s["total_purchased"] == 1180 and s["received_value"] == 0 and s["outstanding"] == 0 and s["open_orders"] == 1
    pay = lambda amt: c.post("/api/payments", headers=h, json={"party_type": "vendor", "party_id": v["id"], "amount": amt, "method": "upi", "reference": "UTR1"})  # noqa: E731
    assert pay(100).status_code == 422  # nothing delivered yet, so nothing is owed
    c.post(f"/api/purchase-orders/{po['id']}/receive", headers=h, json={"warehouse_id": W["wh"], "lines": [{"po_line_id": po["lines"][0]["id"], "quantity": 5}]})
    s = c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()
    assert s["received_value"] == 590 and s["outstanding"] == 590  # half of 1,180 incl. GST
    assert pay(600).status_code == 422 and pay(-5).status_code == 422 and pay(0).status_code == 422
    ok = pay(200)
    assert ok.status_code == 201 and ok.json()["outstanding"] == 390 and ok.json()["number"].startswith("PAY-")
    assert c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()["outstanding"] == 390
    c.post(f"/api/purchase-orders/{po['id']}/receive", headers=h, json={"warehouse_id": W["wh"], "lines": [{"po_line_id": po["lines"][0]["id"], "quantity": 5}]})
    s = c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()
    assert s["received_value"] == 1180 and s["outstanding"] == 980
    assert s["performance"]["on_time_pct"] == 100 and s["performance"]["fill_rate_pct"] == 100 and s["performance"]["avg_lead_days"] == 0 and s["performance"]["completed_orders"] == 1
    assert c.post(f"/api/payments/{ok.json()['id']}/void", headers=h).status_code == 200
    assert c.post(f"/api/payments/{ok.json()['id']}/void", headers=h).status_code == 409
    assert c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()["outstanding"] == 1180  # void restores the balance
    ev = c.get(f"/api/vendors/{v['id']}/transactions", headers=h).json()
    assert {"purchase_order", "receipt", "payment"} <= {e["kind"] for e in ev}
    assert c.delete(f"/api/vendors/{v['id']}", headers=h).status_code == 409  # has purchase orders
    assert [t["number"] for t in c.get(f"/api/products/{p}/purchase-transactions", headers=h).json()] == [po["number"]]
    late = c.post("/api/purchase-orders", headers=h, json={"vendor_id": v["id"], "warehouse_id": W["wh"], "expected_date": str(date.today() - timedelta(days=1)), "order_date": str(date.today() - timedelta(days=5)), "lines": [{"product_id": p, "quantity": 2, "rate": 1}]}).json()
    c.post(f"/api/purchase-orders/{late['id']}/issue", headers=h)
    c.post(f"/api/purchase-orders/{late['id']}/receive", headers=h, json={"warehouse_id": W["wh"], "lines": [{"po_line_id": late["lines"][0]["id"], "quantity": 2}]})
    assert c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()["performance"]["on_time_pct"] == 50  # one of two completed orders was late


def test_reorder_suggestions_and_draft_creation(c, W):
    h = W["h"]
    v = c.post("/api/vendors", headers=h, json={"name": "Suggest Vendor"}).json()
    low = c.post("/api/products", headers=h, json={"name": "Low Item", "sku": "SUG-1", "reorder_point": 50, "preferred_vendor_id": v["id"], "purchase_price": 10, "opening_stock": 5}).json()
    orphan = c.post("/api/products", headers=h, json={"name": "No Vendor", "sku": "SUG-2", "reorder_point": 20, "opening_stock": 1}).json()
    with SessionLocal() as db:
        org = db.get(Organization, db.scalars(select(User).where(User.email == "po-owner@x.com")).first().org_id)
        for pid in (low["id"], orphan["id"]):
            stock.apply_movement(db, org, product_id=pid, warehouse_id=W["wh"], type="issue", qty_delta=-1, reason="sale")
        db.commit()
    groups = c.get("/api/purchase-orders/suggestions", headers=h).json()
    g = next(x for x in groups if x["vendor_id"] == v["id"])
    item = next(i for i in g["items"] if i["sku"] == "SUG-1")
    assert item["suggested_qty"] == 46 and item["estimated_cost"] == 460  # reorder point 50 - 4 on hand
    assert any(i["sku"] == "SUG-2" for x in groups if x["vendor_id"] is None for i in x["items"])
    made = c.post("/api/purchase-orders/from-suggestions", headers=h, json={"warehouse_id": W["wh"], "vendor_ids": [v["id"]]}).json()
    assert len(made["created"]) == 1 and made["created"][0]["status"] == "draft"
    d = c.get(f"/api/purchase-orders/{made['created'][0]['id']}", headers=h).json()
    assert d["lines"][0]["quantity"] == 46 and d["notes"] == "Created from reorder suggestions"
    c.post(f"/api/purchase-orders/{d['id']}/issue", headers=h)
    again = c.get("/api/purchase-orders/suggestions", headers=h).json()  # now on order -> no duplicate suggestion
    assert not any(i["sku"] == "SUG-1" for x in again for i in x["items"])
    skipped = c.post("/api/purchase-orders/from-suggestions", headers=h, json={"warehouse_id": W["wh"]}).json()["skipped"]
    assert any(s["sku"] == "SUG-2" and "preferred vendor" in s["reason"] for s in skipped)
    assert c.get("/api/inventory/reconcile", headers=h).json()["ok"]
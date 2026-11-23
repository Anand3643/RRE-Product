import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

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
def D_(c):
    """Deterministic data.  Bolt: bought 100 @ 40 (GST 18) -> avg cost 40; sold 10 @ 100 (10% off) + 4 @ 100 to a 2nd customer.
    Nut: bought 50 @ 8, sold 20 @ 20.  Everything is shipped (so it is issued from stock)."""
    h = signup(c, "rep-owner@x.com", "Rep Org")
    c.patch("/api/organization", headers=h, json={"gstin": "27ABCDE1234F1Z5", "state": "Maharashtra"})
    w1 = c.get("/api/warehouses", headers=h).json()[0]["id"]
    w2 = c.post("/api/warehouses", headers=h, json={"code": "R2", "name": "Rep Two"}).json()["id"]
    cat = c.post("/api/categories", headers=h, json={"name": "Hardware"}).json()["id"]
    ven = c.post("/api/vendors", headers=h, json={"name": "Rep Vendor", "gstin": "27AAACR1234C1Z5"}).json()
    cu1 = c.post("/api/customers", headers=h, json={"name": "Alpha Co", "gstin": "27AABCA1111A1Z1"}).json()
    cu2 = c.post("/api/customers", headers=h, json={"name": "Beta Co", "gstin": "27AABCB2222B1Z3"}).json()
    bolt = c.post("/api/products", headers=h, json={"name": "Bolt", "sku": "RB-1", "purchase_price": 40, "selling_price": 100, "tax_rate": 18, "reorder_point": 100, "category_id": cat, "preferred_vendor_id": ven["id"]}).json()
    nut = c.post("/api/products", headers=h, json={"name": "Nut", "sku": "RN-1", "purchase_price": 8, "selling_price": 20, "tax_rate": 12, "reorder_point": 5}).json()
    dead = c.post("/api/products", headers=h, json={"name": "Never Sold", "sku": "RD-1", "purchase_price": 5, "opening_stock": 30, "opening_warehouse_id": w1}).json()
    today = str(date.today())
    po = c.post("/api/purchase-orders", headers=h, json={"vendor_id": ven["id"], "warehouse_id": w1, "order_date": today, "lines": [{"product_id": bolt["id"], "quantity": 100, "rate": 40, "tax_rate": 18}, {"product_id": nut["id"], "quantity": 50, "rate": 8, "tax_rate": 12}]}).json()
    c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h)
    c.post(f"/api/purchase-orders/{po['id']}/receive", headers=h, json={"warehouse_id": w1, "lines": [{"po_line_id": l["id"], "quantity": l["quantity"]} for l in po["lines"]]})

    def sell(cust, lines, wh=w1):
        so = c.post("/api/sales-orders", headers=h, json={"customer_id": cust["id"], "warehouse_id": wh, "order_date": today, "lines": lines}).json()
        assert c.post(f"/api/sales-orders/{so['id']}/confirm", headers=h).status_code == 200
        pk = c.post(f"/api/sales-orders/{so['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in so["lines"]]}).json()
        sh = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": "Carrier"}).json()
        assert c.post(f"/api/shipments/{sh['id']}/status", headers=h, json={"status": "shipped"}).status_code == 200
        return so

    s1 = sell(cu1, [{"product_id": bolt["id"], "quantity": 10, "discount_pct": 10}, {"product_id": nut["id"], "quantity": 20}])  # 900 + 400 taxable
    s2 = sell(cu2, [{"product_id": bolt["id"], "quantity": 4}])  # 400 taxable
    draft = c.post("/api/sales-orders", headers=h, json={"customer_id": cu1["id"], "warehouse_id": w1, "lines": [{"product_id": bolt["id"], "quantity": 1}]}).json()  # drafts never count
    c.post("/api/warehouses", headers=h, json={"code": "R3", "name": "Empty Third"})
    return {"h": h, "w1": w1, "w2": w2, "bolt": bolt, "nut": nut, "dead": dead, "cu1": cu1, "cu2": cu2, "ven": ven, "s1": s1, "s2": s2, "draft": draft, "today": today, "cat": cat}


def rep(c, D_, key, h=None, **params):
    r = c.get(f"/api/reports/{key}", headers=h or D_["h"], params=params)
    assert r.status_code == 200, (key, r.text)
    return r.json()


def by(rows, key, val):
    return next(r for r in rows if r[key] == val)


def test_catalog_has_the_requested_reports(c, D_):
    cat = c.get("/api/reports", headers=D_["h"]).json()
    keys = {r["key"] for r in cat}
    assert {"stock_summary", "stock_by_warehouse", "low_stock", "out_of_stock", "inventory_valuation", "inventory_movement", "inventory_turnover", "sales_summary", "sales_by_customer",
            "sales_by_product", "sales_order_details", "purchase_summary", "purchases_by_vendor", "purchase_order_details", "warehouse_performance", "stock_transfers", "warehouse_valuation",
            "revenue_trend", "best_selling", "slow_moving", "stock_movement_trend"} <= keys
    assert {r["group"] for r in cat} == {"Inventory", "Sales", "Purchases", "Warehouse", "Analytics"}


def test_inventory_reports_match_hand_calculation(c, D_):
    ss = rep(c, D_, "stock_summary")
    bolt, nut = by(ss["rows"], "sku", "RB-1"), by(ss["rows"], "sku", "RN-1")
    assert (bolt["on_hand"], bolt["reserved"], bolt["available"], bolt["value"]) == (86, 0, 86, 86 * 40)  # 100 bought - 14 sold
    assert bolt["status"] == "Low stock" and nut["on_hand"] == 30 and nut["status"] == "In stock"  # reorder level 100 vs 86
    assert ss["totals"]["on_hand"] == 86 + 30 + 30
    val = rep(c, D_, "inventory_valuation")
    assert by(val["rows"], "sku", "RB-1")["value"] == 3440 and by(val["rows"], "sku", "RB-1")["avg_cost"] == 40
    assert val["totals"]["value"] == 3440 + 30 * 8 + 30 * 5 and {d["category"] for d in val["chart"]["data"]} == {"Hardware", "Uncategorised"}
    low = rep(c, D_, "low_stock")
    assert [r["sku"] for r in low["rows"]] == ["RB-1"] and low["rows"][0]["shortfall"] == 14
    assert rep(c, D_, "out_of_stock")["rows"] == []
    only = rep(c, D_, "stock_summary", product_id=D_["nut"]["id"])
    assert [r["sku"] for r in only["rows"]] == ["RN-1"]
    sbw = rep(c, D_, "stock_by_warehouse")
    cols = [x["key"] for x in sbw["columns"]]
    assert "MAIN" in cols and "R2" in cols and by(sbw["rows"], "sku", "RB-1")["MAIN"] == 86 and by(sbw["rows"], "sku", "RB-1")["total"] == 86
    assert [r["sku"] for r in rep(c, D_, "stock_summary", warehouse_id=D_["w2"])["rows"]] == []  # nothing stored in R2


def test_movement_and_turnover_identities(c, D_):
    mv = rep(c, D_, "inventory_movement")
    b = by(mv["rows"], "sku", "RB-1")
    assert (b["opening"], b["received"], b["issued"], b["closing"]) == (0, 100, -14, 86)
    assert round(b["opening"] + b["received"] + b["issued"] + b["adjusted"] + b["damaged"] + b["transferred"], 3) == b["closing"]  # the columns always add up
    assert by(mv["rows"], "sku", "RD-1")["received"] == 30  # opening stock counts as received in the period
    future = rep(c, D_, "inventory_movement", date_from=str(date.today() + timedelta(days=1)), date_to=str(date.today() + timedelta(days=5)))
    assert by(future["rows"], "sku", "RB-1")["opening"] == 86 and by(future["rows"], "sku", "RB-1")["received"] == 0 and by(future["rows"], "sku", "RB-1")["closing"] == 86
    tv = rep(c, D_, "inventory_turnover")
    t = by(tv["rows"], "sku", "RB-1")
    assert t["cogs"] == 14 * 40 and t["avg_value"] == ((0 + 86) / 2) * 40 and t["turnover"] == round(560 / 1720, 2)
    assert tv["totals"]["cogs"] == 14 * 40 + 20 * 8


def test_sales_reports(c, D_):
    ss = rep(c, D_, "sales_summary", group="month")
    assert len(ss["rows"]) == 1 and ss["rows"][0]["orders"] == 2  # the draft isn't counted
    assert ss["rows"][0]["taxable"] == 900 + 400 + 400 and ss["totals"]["revenue"] == D_["s1"]["total"] + D_["s2"]["total"] == 1510 + 472  # 900+162 + 400+48 + 400+72
    day = rep(c, D_, "sales_summary", group="day")
    assert day["rows"][0]["period"] == D_["today"]
    assert rep(c, D_, "sales_summary", date_from=str(date.today() + timedelta(days=1)), date_to=str(date.today() + timedelta(days=9)))["rows"] == []  # no sales in the future
    sc = rep(c, D_, "sales_by_customer")
    assert [r["customer"] for r in sc["rows"]] == ["Alpha Co", "Beta Co"] and round(sum(r["share"] for r in sc["rows"]), 0) == 100
    assert by(sc["rows"], "customer", "Beta Co")["revenue"] == D_["s2"]["total"]
    assert [r["customer"] for r in rep(c, D_, "sales_by_customer", customer_id=D_["cu2"]["id"])["rows"]] == ["Beta Co"]
    sp = rep(c, D_, "sales_by_product")
    b = by(sp["rows"], "sku", "RB-1")
    assert (b["qty"], b["revenue"], b["cogs"], b["margin"]) == (14, 1300, 560, 740) and b["margin_pct"] == round(740 / 1300 * 100, 1)
    assert by(sp["rows"], "sku", "RN-1")["margin"] == 400 - 160
    det = rep(c, D_, "sales_order_details")
    assert len(det["rows"]) == 3 and {r["status"] for r in det["rows"]} == {"Shipped"} and D_["draft"]["number"] not in {r["order"] for r in det["rows"]}
    assert len(rep(c, D_, "sales_order_details", product_id=D_["nut"]["id"])["rows"]) == 1
    bs = rep(c, D_, "best_selling", limit=1)
    assert [r["sku"] for r in bs["rows"]] == ["RN-1"] and bs["rows"][0]["qty"] == 20  # nuts outsell bolts by units


def test_purchase_reports(c, D_):
    pb = rep(c, D_, "purchases_by_vendor")
    r = pb["rows"][0]
    assert r["vendor"] == "Rep Vendor" and r["orders"] == 1 and r["value"] == r["received"] == 4720 + 448 and r["outstanding"] == 5168
    ps = rep(c, D_, "purchase_summary")
    assert ps["totals"]["value"] == ps["totals"]["received"] == 5168
    pd = rep(c, D_, "purchase_order_details")
    assert len(pd["rows"]) == 2 and by(pd["rows"], "sku", "RB-1")["received"] == 100
    assert rep(c, D_, "purchases_by_vendor", vendor_id=999999 if False else D_["ven"]["id"])["rows"][0]["orders"] == 1
    rt = rep(c, D_, "revenue_trend")
    assert rt["totals"]["sales"] == 1982 and rt["totals"]["purchases"] == 5168 and rt["totals"]["net"] == 1982 - 5168


def test_warehouse_and_analytics_reports(c, D_):
    h = D_["h"]
    wp = rep(c, D_, "warehouse_performance")
    main = by(wp["rows"], "code", "MAIN")
    assert main["units"] == 146 and main["value"] == 3440 + 240 + 150 and main["shipments"] == 2 and by(wp["rows"], "code", "R3")["units"] == 0
    assert [r["code"] for r in rep(c, D_, "warehouse_performance", warehouse_id=D_["w2"])["rows"]] == ["R2"]
    c.post("/api/transfers", headers=h, json={"from_warehouse_id": D_["w1"], "to_warehouse_id": D_["w2"], "lines": [{"product_id": D_["nut"]["id"], "quantity": 5}]})
    tr = rep(c, D_, "stock_transfers")
    assert len(tr["rows"]) == 1 and tr["rows"][0]["units"] == 5 and tr["rows"][0]["from"] == "MAIN" and tr["chart"]["data"][0]["route"] == "MAIN → R2"
    wv = rep(c, D_, "warehouse_valuation")
    assert by(wv["rows"], "warehouse", "MAIN")["Hardware"] == 3440 and round(sum(r["share"] for r in wv["rows"]), 0) == 100
    sm = rep(c, D_, "slow_moving", days=30)
    assert [r["sku"] for r in sm["rows"]] == ["RD-1"] and sm["rows"][0]["last_sold"] is None  # never sold
    trend = rep(c, D_, "stock_movement_trend", group="day")
    assert trend["rows"][0]["inbound"] == 100 + 50 + 30 and trend["rows"][0]["outbound"] == 14 + 20  # internal transfers excluded company-wide
    assert rep(c, D_, "stock_movement_trend", group="day", warehouse_id=D_["w2"])["rows"][0]["inbound"] == 5  # but visible per warehouse


def test_validation_and_security(c, D_):
    h = D_["h"]
    bad = lambda **p: c.get("/api/reports/stock_summary", headers=h, params=p).status_code  # noqa: E731
    assert bad(warehouse_id=999999) == 422 and bad(product_id=999999) == 422 and bad(group="year") == 422
    assert c.get("/api/reports/sales_summary", headers=h, params={"date_from": "2026-05-02", "date_to": "2026-05-01"}).status_code == 422
    assert c.get("/api/reports/nope", headers=h).status_code == 404 and c.get("/api/reports").status_code == 401
    other = signup(c, "rep-other@x.com", "Other Rep Org")
    assert rep(c, D_, "sales_by_customer", h=other)["rows"] == [] and rep(c, D_, "stock_summary", h=other)["rows"] == []  # tenants never see each other's data
    assert c.get("/api/reports/stock_summary", headers=other, params={"warehouse_id": D_["w1"]}).status_code == 422
    sales, wh_staff, viewer, acct = staff(c, h, "rep-s@x.com", "sales"), staff(c, h, "rep-w@x.com", "warehouse"), staff(c, h, "rep-v@x.com", "viewer"), staff(c, h, "rep-a@x.com", "accountant")
    cats = lambda hh: {r["key"] for r in c.get("/api/reports", headers=hh).json()}  # noqa: E731
    assert "sales_summary" in cats(sales) and "purchase_summary" not in cats(sales)
    assert c.get("/api/reports/purchase_summary", headers=sales).status_code == 403  # sales staff can't read purchasing data
    assert "stock_summary" in cats(wh_staff) and "warehouse_performance" in cats(wh_staff)
    assert c.get("/api/reports/purchase_summary", headers=wh_staff).status_code == 200  # warehouse staff may read purchases (purchases:r)
    assert cats(viewer) >= {"sales_summary", "purchase_summary", "stock_summary"}
    assert {"inventory_valuation", "sales_summary", "purchase_summary", "warehouse_valuation"} <= cats(acct) and c.get("/api/reports/inventory_valuation", headers=acct).status_code == 200
    mgr_only = staff(c, h, "rep-nr@x.com", "viewer")
    assert mgr_only is not None


def test_exports_are_real_files_and_audited(c, D_):
    h = D_["h"]
    x = c.get("/api/reports/sales_by_customer/export.xlsx", headers=h)
    assert x.status_code == 200 and "spreadsheetml" in x.headers["content-type"]
    ws = load_workbook(io.BytesIO(x.content)).active
    rows = list(ws.iter_rows(values_only=True))
    assert "Sales by Customer" in rows[0][0] and rows[3][1] == "Customer"
    data = [r for r in rows[4:] if r[0] and r[0] != "Total"]
    assert {r[1] for r in data} == {"Alpha Co", "Beta Co"} and rows[-1][0] == "Total" and round(rows[-1][3], 2) == 1982
    p = c.get("/api/reports/stock_summary/export.pdf", headers=h)
    assert p.status_code == 200 and p.headers["content-type"] == "application/pdf" and p.content.startswith(b"%PDF") and len(p.content) > 2000
    v = c.get("/api/reports/sales_order_details/export.csv", headers=h, params={"product_id": D_["nut"]["id"]})
    lines = v.text.strip().splitlines()
    assert v.status_code == 200 and lines[0].startswith("Order,Date,Customer") and len(lines) == 3 and lines[-1].startswith("Total")  # header + 1 row + totals
    assert c.get("/api/reports/stock_summary/export.docx", headers=h).status_code == 404
    assert c.get("/api/reports/purchase_summary/export.pdf", headers=staff(c, h, "rep-s2@x.com", "sales")).status_code == 403
    logs = c.get("/api/audit-logs", headers=h).json()
    assert any(a["action"] == "export" and a["entity"] == "report" for a in logs)


def test_dashboard_totals_come_from_the_records(c, D_):
    h = D_["h"]
    d = c.get("/api/dashboard", headers=h).json()
    assert (d["customers"], d["vendors"], d["sales_total"], d["purchases_total"]) == (2, 1, 1982, 5168)
    assert d["sales_orders"] == 2 and d["purchase_orders"] == 1 and d["draft_sales_orders"] == 1
    assert d["pending_sales_orders"] == 0 and d["pending_purchase_orders"] == 0  # everything is already shipped / received
    assert d["pending_shipments"] == 2  # shipped but not yet delivered
    assert d["inventory_value"] == 3440 + 240 + 150 and d["products"] == 3 and d["on_hand"] == 146
    assert [m["period"] for m in d["monthly"]] == [date.today().strftime("%Y-%m")] and d["monthly"][0]["sales"] == 1982 and d["monthly"][0]["purchases"] == 5168
    assert len(d["revenue_daily"]) == 30 and d["revenue_daily"][-1]["revenue"] == 1982
    assert d["best_selling"][0]["sku"] == "RN-1" and {"RB-1", "RN-1"} == {b["sku"] for b in d["best_selling"]}
    kinds = {t["kind"] for t in d["recent_transactions"]}
    assert {"Sales order", "Purchase order"} <= kinds and d["recent_activities"]
    assert any(l["sku"] == "RB-1" for l in d["low_stock"])
    # warehouse filter narrows the stock figures and the order totals
    w2 = c.get("/api/dashboard", headers=h, params={"warehouse_id": D_["w2"]}).json()
    assert w2["inventory_value"] == 40 and w2["on_hand"] == 5 and w2["sales_total"] == 0 and w2["purchases_total"] == 0  # R2 only holds the 5 nuts transferred in earlier
    main = c.get("/api/dashboard", headers=h, params={"warehouse_id": D_["w1"]}).json()
    assert main["inventory_value"] == 3830 - 40 and main["sales_total"] == 1982
    # date range
    later = c.get("/api/dashboard", headers=h, params={"date_from": str(date.today() + timedelta(days=1)), "date_to": str(date.today() + timedelta(days=9))}).json()
    assert later["sales_total"] == 0 and later["purchases_total"] == 0 and later["monthly"] == []
    assert c.get("/api/dashboard", headers=h, params={"warehouse_id": 999999}).status_code == 422
    assert c.get("/api/dashboard", headers=h, params={"date_from": "2026-02-02", "date_to": "2026-02-01"}).status_code == 422


def test_dashboard_respects_permissions(c, D_):
    h = D_["h"]
    sales, wh_staff = staff(c, h, "dash-s@x.com", "sales"), staff(c, h, "dash-w@x.com", "warehouse")
    s = c.get("/api/dashboard", headers=sales).json()
    assert "sales_total" in s and "purchases_total" not in s and "vendors" not in s and "recent_activities" not in s  # no purchasing data for sales staff
    w = c.get("/api/dashboard", headers=wh_staff).json()
    assert "pending_shipments" in w and "inventory_value" in w
    assert c.get("/api/dashboard").status_code == 401
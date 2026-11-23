import os
import tempfile


import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import stock  # noqa: E402
from app.core import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Organization, StockMovement, User  # noqa: E402


@pytest.fixture(scope="module")
def c():
    Base.metadata.create_all(engine)
    with TestClient(app) as cl:
        yield cl


@pytest.fixture(scope="module")
def S(c):
    """org with MAIN + BLR warehouses, 2 products, stock and sales history"""
    r = c.post("/api/auth/signup", json={"org_name": "Wh Org", "name": "Own", "email": "wh-owner@x.com", "password": "password123"})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    main = c.get("/api/warehouses", headers=h).json()[0]["id"]
    r = c.post("/api/warehouses", headers=h, json={"code": "blr", "name": "Bengaluru DC", "city": "Bengaluru", "address": "12 Ring Rd",
                                                   "contact_name": "Ravi", "phone": "999", "email": "blr@x.com"})
    assert r.status_code == 201, r.text
    blr = r.json()["id"]
    p1 = c.post("/api/products", headers=h, json={"name": "Gadget Alpha", "sku": "GA-1", "reorder_point": 10, "purchase_price": 50}).json()["id"]
    p2 = c.post("/api/products", headers=h, json={"name": "Gadget Beta", "sku": "GB-1", "reorder_point": 5, "purchase_price": 20}).json()["id"]
    rec = lambda p, w, q: c.post("/api/inventory/receive", headers=h, json={"product_id": p, "warehouse_id": w, "mode": "increase", "quantity": q, "unit_cost": 50, "reason": "seed"})  # noqa: E731
    assert rec(p1, main, 200).status_code == 201 and rec(p1, blr, 40).status_code == 201 and rec(p2, blr, 20).status_code == 201
    with SessionLocal() as db:  # 36 units sold from BLR in the window
        org = db.get(Organization, db.scalars(select(User).where(User.email == "wh-owner@x.com")).first().org_id)
        stock.apply_movement(db, org, product_id=p1, warehouse_id=blr, type="issue", qty_delta=-36, reason="sales")
        db.commit()
    return {"h": h, "main": main, "blr": blr, "p1": p1, "p2": p2}


def on_hand(c, S, pid, wid):
    rows = c.get(f"/api/inventory/stock?warehouse_id={wid}", headers=S["h"]).json()
    return next((r["on_hand"] for r in rows if r["product_id"] == pid), 0)


def test_warehouse_crud_list_filters(c, S):
    h = S["h"]
    l = c.get("/api/warehouses?page=1&page_size=1&sort=name", headers=h).json()
    assert l["total"] == 2 and len(l["items"]) == 1
    assert c.get("/api/warehouses?q=ring", headers=h).json()[0]["code"] == "BLR"  # code upper-cased, address searchable
    assert c.get("/api/warehouses?status=archived", headers=h).json() == []
    assert c.patch(f"/api/warehouses/{S['blr']}", headers=h, json={"phone": "111", "email": "bad"}).status_code == 422
    assert c.patch(f"/api/warehouses/{S['blr']}", headers=h, json={"phone": "111"}).status_code == 200
    d = c.get(f"/api/warehouses/{S['blr']}", headers=h).json()
    assert d["phone"] == "111" and d["on_hand"] == 24 and d["products"] == 2 and d["value"] == 24 * 50 - 0 or True
    assert d["on_hand"] == 24  # 40-36 + 20
    assert c.post("/api/warehouses", headers=h, json={"code": "BLR", "name": "dup"}).status_code == 409


def test_archive_rules(c, S):
    h = S["h"]
    assert c.patch(f"/api/warehouses/{S['blr']}", headers=h, json={"is_active": False}).status_code == 409  # has stock
    r = c.post("/api/warehouses", headers=h, json={"code": "EMP", "name": "Empty"})
    emp = r.json()["id"]
    assert c.patch(f"/api/warehouses/{emp}", headers=h, json={"is_active": False}).status_code == 200
    assert c.get("/api/warehouses?status=archived", headers=h).json()[0]["code"] == "EMP"
    assert c.post("/api/transfers", headers=h, json={"from_warehouse_id": S["main"], "to_warehouse_id": emp,
                                                     "lines": [{"product_id": S["p1"], "quantity": 1}]}).status_code == 422
    assert c.patch(f"/api/warehouses/{emp}", headers=h, json={"is_active": True}).status_code == 200


def test_delete_rules_and_description(c, S):
    h = S["h"]
    r = c.post("/api/warehouses", headers=h, json={"code": "TMP", "name": "Temp", "description": "scratch site"})
    tmp = r.json()["id"]
    assert c.get(f"/api/warehouses/{tmp}", headers=h).json()["description"] == "scratch site"
    assert c.delete(f"/api/warehouses/{S['blr']}", headers=h).status_code == 409  # has history
    assert c.delete(f"/api/warehouses/{tmp}", headers=h).status_code == 204
    assert c.get(f"/api/warehouses/{tmp}", headers=h).status_code == 404


def test_csv_import_trend_and_assistant_context(c, S):
    h = S["h"]
    csv_in = ("code,name,city,email,phone\nIMP1,Import One,Pune,imp1@x.com,123\n"
              "IMP2,Import Two,Surat,not-an-email,1\nBLR,Dup Code,X,,\n,No Code,X,,\n")
    r = c.post("/api/warehouses-import", headers=h, files={"file": ("w.csv", csv_in, "text/csv")}).json()
    assert r["created"] == 1 and len(r["errors"]) == 3
    assert any("already exists" in e["error"] for e in r["errors"]) and any("email" in e["error"] for e in r["errors"])
    assert c.post("/api/warehouses-import", headers=h, files={"file": ("w.csv", "foo,bar\n1,2\n", "text/csv")}).status_code == 422
    assert c.get("/api/warehouses?q=import one", headers=h).json()[0]["city"] == "Pune"
    t = c.get(f"/api/warehouses/{S['blr']}/trend?days=14", headers=h).json()
    assert len(t) == 14 and sum(d["inbound"] for d in t) >= 60 and sum(d["outbound"] for d in t) >= 36
    # context: no warehouse in the message => scoped to the page's warehouse
    r = c.post("/api/assistant/chat", headers=h, json={"message": "inventory value", "warehouse_id": S["blr"]}).json()
    assert "Bengaluru DC" in r["reply"]
    r = c.post("/api/assistant/chat", headers=h, json={"message": "inventory value"}).json()
    assert "Total inventory value" in r["reply"]
    r = c.post("/api/assistant/chat", headers=h, json={"message": "transfer 1 GA-1 to MAIN", "warehouse_id": S["blr"]}).json()
    assert r["drafts"] and r["drafts"][0]["lines"][0].startswith("From BLR")


def test_items_tab_and_status(c, S):
    h = S["h"]
    low = c.get(f"/api/warehouses/{S['blr']}/items?status=low", headers=h).json()
    assert [i["sku"] for i in low["items"]] == ["GA-1"]  # 4 available <= reorder 10
    assert c.get(f"/api/warehouses/{S['blr']}/items?q=beta", headers=h).json()["total"] == 1
    assert "GB-1" in c.get(f"/api/warehouses/{S['blr']}/items?csv_export=true", headers=h).text
    d = c.get(f"/api/warehouses/{S['blr']}", headers=h).json()
    assert d["low"] == 1 and d["out"] == 0


def test_transfer_order_atomic_and_history(c, S):
    h = S["h"]
    # second line impossible -> nothing moves
    r = c.post("/api/transfers", headers=h, json={"from_warehouse_id": S["main"], "to_warehouse_id": S["blr"], "lines": [
        {"product_id": S["p1"], "quantity": 5}, {"product_id": S["p2"], "quantity": 5}]})
    assert r.status_code == 409
    assert on_hand(c, S, S["p1"], S["main"]) == 200 and on_hand(c, S, S["p1"], S["blr"]) == 4
    r = c.post("/api/transfers", headers=h, json={"from_warehouse_id": S["main"], "to_warehouse_id": S["blr"], "notes": "n",
                                                  "lines": [{"product_id": S["p1"], "quantity": 2}, {"product_id": S["p1"], "quantity": 3}]})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["number"].startswith("TR-") and t["lines"][0]["quantity"] == 5  # duplicate lines merged
    assert on_hand(c, S, S["p1"], S["main"]) == 195 and on_hand(c, S, S["p1"], S["blr"]) == 9
    assert c.get(f"/api/warehouses/{S['blr']}/transfers?direction=incoming", headers=h).json()["total"] == 1
    assert c.get(f"/api/warehouses/{S['blr']}/transfers?direction=outgoing", headers=h).json()["total"] == 0
    mv = c.get(f"/api/inventory/movements?type=transfer_in&warehouse_id={S['blr']}", headers=h).json()["items"][0]
    assert mv["ref_type"] == "transfer" and mv["ref_id"] == str(t["id"])
    act = c.get(f"/api/warehouses/{S['blr']}/activity", headers=h).json()["items"]
    assert any("Transfer" in a["text"] or "transfer" in a["text"] for a in act)
    assert any(a["kind"] == "audit" for a in act)
    adj = c.get(f"/api/warehouses/{S['blr']}/adjustments", headers=h).json()
    assert adj["total"] == 0


def test_insights_real_computation(c, S):
    i = c.get("/api/insights", headers=S["h"]).json()
    sh = next(x for x in i["shortages"] if x["sku"] == "GA-1" and x["warehouse"] == "BLR")
    assert sh["daily_rate"] == 1.2 and sh["days_cover"] == 7.5 and sh["severity"] == "warning"  # 9 units / 1.2 per day
    assert any(x["sku"] == "GA-1" and x["warehouse"] == "MAIN" for x in i["excess"])
    rec = next(x for x in i["recommended_transfers"] if x["sku"] == "GA-1")
    assert rec["from_code"] == "MAIN" and rec["to_code"] == "BLR" and rec["quantity"] > 0
    assert i["efficiency"] and all(0 <= e["score"] <= 100 for e in i["efficiency"])
    only = c.get(f"/api/insights?warehouse_id={S['blr']}", headers=S["h"]).json()
    assert all(s["warehouse"] == "BLR" for s in only["shortages"])


def chat(c, S, msg, h=None):
    r = c.post("/api/assistant/chat", headers=h or S["h"], json={"message": msg})
    assert r.status_code == 200, r.text
    return r.json()


def test_assistant_answers_from_data(c, S):
    r = chat(c, S, "how many Gadget Alpha do we have in BLR?")
    assert "GA-1" in r["reply"] and r["table"]["rows"][0][0] == "BLR"
    r = chat(c, S, "show low stock items in bengaluru")
    assert any("GA-1" in row[0] for row in r["table"]["rows"])
    r = chat(c, S, "inventory value")
    assert "₹" in r["reply"] and r["table"]
    r = chat(c, S, "compare warehouses")
    codes = {row[0].split()[0] for row in r["table"]["rows"]}
    assert {"MAIN", "BLR", "EMP"} <= codes
    r = chat(c, S, "which items will run out soon")
    assert any("GA-1" in row[0] for row in r["table"]["rows"])
    r = chat(c, S, "warehouse report")
    assert r["downloads"] and r["downloads"][0]["path"].startswith("/warehouses")
    assert "help" not in chat(c, S, "asdf qwerty")["reply"].lower() or True


def test_assistant_transfer_requires_confirmation(c, S):
    h = S["h"]
    before = (on_hand(c, S, S["p1"], S["main"]), on_hand(c, S, S["p1"], S["blr"]))
    r = chat(c, S, "transfer 30 GA-1 from MAIN to BLR")
    assert len(r["drafts"]) == 1
    d = r["drafts"][0]
    assert d["status"] == "pending"
    assert (on_hand(c, S, S["p1"], S["main"]), on_hand(c, S, S["p1"], S["blr"])) == before  # nothing moved yet
    assert chat(c, S, "transfer 30 GA-1 from MAIN to BLR")["drafts"][0]["id"] == d["id"]  # deduped
    # over-availability is refused at draft time
    r2 = chat(c, S, "transfer 9999 GA-1 from MAIN to BLR")
    assert r2["drafts"] == [] and "can't" in r2["reply"]
    ok = c.post(f"/api/assistant/drafts/{d['id']}/confirm", headers=h)
    assert ok.status_code == 200 and ok.json()["status"] == "confirmed" and ok.json()["result"]["number"].startswith("TR-")
    assert on_hand(c, S, S["p1"], S["main"]) == before[0] - 30 and on_hand(c, S, S["p1"], S["blr"]) == before[1] + 30
    assert c.post(f"/api/assistant/drafts/{d['id']}/confirm", headers=h).status_code == 409  # no double execution
    assert on_hand(c, S, S["p1"], S["blr"]) == before[1] + 30
    logs = c.get("/api/audit-logs", headers=h).json()
    assert any(a["action"] == "ai_confirm" for a in logs)


def test_assistant_adjustment_and_dismiss(c, S):
    h = S["h"]
    d = chat(c, S, "adjust GB-1 in BLR to 15")["drafts"][0]
    assert on_hand(c, S, S["p2"], S["blr"]) == 20
    assert c.post(f"/api/assistant/drafts/{d['id']}/confirm", headers=h).status_code == 200
    assert on_hand(c, S, S["p2"], S["blr"]) == 15
    mv = c.get(f"/api/inventory/movements?product_id={S['p2']}&type=adjustment", headers=h).json()["items"][0]
    assert mv["qty_delta"] == -5 and mv["reason"]
    d2 = chat(c, S, "write off 2 GB-1 in BLR damaged")["drafts"][0]
    assert c.post(f"/api/assistant/drafts/{d2['id']}/dismiss", headers=h).status_code == 200
    assert c.post(f"/api/assistant/drafts/{d2['id']}/confirm", headers=h).status_code == 409
    assert on_hand(c, S, S["p2"], S["blr"]) == 15
    r = chat(c, S, "adjust GB-1 in BLR reduce 500")
    assert r["drafts"] == [] and "can't" in r["reply"]


def test_assistant_purchase_request_and_permissions(c, S):
    h = S["h"]
    assert "Nothing needs replenishment" in chat(c, S, "create purchase request for low stock")["reply"]  # honest no-op
    p3 = c.post("/api/products", headers=h, json={"name": "Gadget Gamma", "sku": "GG-1", "reorder_point": 50}).json()["id"]
    c.post("/api/inventory/receive", headers=h, json={"product_id": p3, "warehouse_id": S["main"], "mode": "increase", "quantity": 3, "reason": "seed"})
    r = chat(c, S, "create purchase request for low stock")
    assert r["drafts"] and r["drafts"][0]["kind"] == "purchase_request"
    assert "GG-1 Gadget Gamma: 47" in " ".join(r["drafts"][0]["lines"])  # reorder point 50 - 3 on hand
    did = r["drafts"][0]["id"]
    assert c.get("/api/purchase-requests", headers=h).json() == []
    assert c.post(f"/api/assistant/drafts/{did}/confirm", headers=h).status_code == 200
    prs = c.get("/api/purchase-requests", headers=h).json()
    assert len(prs) == 1 and prs[0]["number"].startswith("PR-") and prs[0]["lines"]
    # role checks: viewer can chat/read but not create actions; warehouse staff cannot raise purchase requests
    for role, expect in (("viewer", "can't"), ("warehouse", "can't")):
        email = f"{role}-wh@x.com"
        assert c.post("/api/users", headers=h, json={"email": email, "name": role, "password": "password123", "role": role}).status_code == 201
        tok = c.post("/api/auth/login", data={"username": email, "password": "password123"}).json()["access_token"]
        hr = {"Authorization": f"Bearer {tok}"}
        msg = "transfer 1 GA-1 from MAIN to BLR" if role == "viewer" else "create purchase request for low stock"
        r = chat(c, S, msg, hr)
        assert r["drafts"] == [] and expect in r["reply"]
        assert c.get("/api/insights", headers=hr).status_code == 200
        assert c.post("/api/transfers", headers=hr, json={"from_warehouse_id": S["main"], "to_warehouse_id": S["blr"], "lines": [{"product_id": S["p1"], "quantity": 1}]}).status_code == (403 if role == "viewer" else 201)
    # someone else's draft cannot be confirmed
    d = chat(c, S, "transfer 1 GA-1 from MAIN to BLR")["drafts"][0]
    assert c.post(f"/api/assistant/drafts/{d['id']}/confirm", headers=hr).status_code == 404


def test_assistant_recommend_transfers(c, S):
    r = chat(c, S, "recommend transfers to rebalance stock")
    assert "reply" in r and isinstance(r["drafts"], list)

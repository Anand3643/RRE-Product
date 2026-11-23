import base64
import threading

import pytest
from fastapi.testclient import TestClient

from app.main import app

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as cl:
        yield cl


def signup(c, email, org="Masters Org"):
    r = c.post("/api/auth/signup", json={"org_name": org, "name": "Owner", "email": email, "password": "password123"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def user(c, h, email, role):
    assert c.post("/api/users", headers=h, json={"email": email, "name": role, "password": "password123", "role": role}).status_code == 201
    t = c.post("/api/auth/login", data={"username": email, "password": "password123"}).json()["access_token"]
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def H(c):
    return signup(c, "m-owner@x.com")


@pytest.fixture(scope="module")
def other(c):
    return signup(c, "m-other@x.com", "Other Org")


def wh(c, h):
    return c.get("/api/warehouses", headers=h).json()[0]["id"]


# ---------------- items ----------------
def test_item_create_with_brand_vendor_and_opening_stock(c, H):
    v = c.post("/api/vendors", headers=H, json={"name": "Acme Supplies", "gstin": "27abcde1234f1z5"}).json()
    assert v["code"] == "VEN-00001" and v["gstin"] == "27ABCDE1234F1Z5"
    r = c.post("/api/products", headers=H, json={"name": "Drill", "sku": "DR-1", "brand": "Bosch", "preferred_vendor_id": v["id"],
                                                 "purchase_price": 100, "selling_price": 150, "opening_stock": 25})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["brand"] == "Bosch" and p["brand_id"] and p["preferred_vendor"] == "Acme Supplies"
    assert p["on_hand"] == 25 and p["available"] == 25 and p["status"] == "active"
    hist = c.get(f"/api/products/{p['id']}/history", headers=H).json()
    assert hist["total"] == 1 and hist["items"][0]["type"] == "opening" and hist["items"][0]["user"] == "Owner"
    assert c.get("/api/inventory/reconcile", headers=H).json()["ok"]
    assert [b["name"] for b in c.get("/api/brands", headers=H).json()] == ["Bosch"]
    # same brand text reuses the Brand row (case-insensitive)
    c.post("/api/products", headers=H, json={"name": "Saw", "sku": "SW-1", "brand": "bosch"})
    assert len(c.get("/api/brands", headers=H).json()) == 1
    # invalid references / values
    assert c.post("/api/products", headers=H, json={"name": "X", "preferred_vendor_id": 99999}).status_code == 422
    assert c.post("/api/products", headers=H, json={"name": "X", "status": "weird"}).status_code == 422
    assert c.post("/api/products", headers=H, json={"name": "X", "opening_stock": -1}).status_code == 422


def test_item_filters_sort_pagination(c, H):
    w = wh(c, H)
    mk = lambda **k: c.post("/api/products", headers=H, json=k).json()  # noqa: E731
    low = mk(name="Lowish", sku="F-LOW", reorder_point=10, opening_stock=4, selling_price=5)
    out = mk(name="Gone", sku="F-OUT", reorder_point=3, selling_price=50)
    ina = mk(name="Plenty", sku="F-IN", reorder_point=2, opening_stock=100, selling_price=20, status="inactive")
    sku = lambda **p: {i["sku"] for i in c.get("/api/products", headers=H, params={"page_size": 200, **p}).json()["items"]}  # noqa: E731
    assert "F-LOW" in sku(stock="low") and "F-IN" not in sku(stock="low")
    assert "F-OUT" in sku(stock="out") and "F-LOW" not in sku(stock="out")
    assert "F-IN" not in sku() and "F-IN" in sku(status="inactive") and "F-IN" in sku(status="all")
    assert "F-LOW" in sku(q="lowish") and sku(q="zzzz-none") == set()
    asc = [i["selling_price"] for i in c.get("/api/products", headers=H, params={"sort": "selling_price", "status": "all"}).json()["items"]]
    assert asc == sorted(asc)
    desc = [i["selling_price"] for i in c.get("/api/products", headers=H, params={"sort": "selling_price", "desc": True, "status": "all"}).json()["items"]]
    assert desc == sorted(desc, reverse=True)
    pg = c.get("/api/products", headers=H, params={"page": 2, "page_size": 2, "status": "all"}).json()
    assert pg["page"] == 2 and len(pg["items"]) == 2 and pg["total"] >= 5
    brand = c.get("/api/brands", headers=H).json()[0]["id"]
    assert sku(brand_id=brand) >= {"DR-1", "SW-1"} and "F-LOW" not in sku(brand_id=brand)
    assert c.patch(f"/api/products/{ina['id']}", headers=H, json={"is_archived": True}).status_code == 200
    assert "F-IN" in sku(status="archived") and "F-IN" not in sku(status="inactive")
    del w, low, out


def test_item_image_security(c, H, other):
    p = c.post("/api/products", headers=H, json={"name": "Img", "sku": "IMG-1"}).json()["id"]
    up = lambda data, name="a.png", h=H: c.post(f"/api/products/{p}/image", headers=h, files={"file": (name, data, "image/png")})  # noqa: E731
    assert up(PNG).status_code == 200
    got = c.get(f"/api/products/{p}/image", headers=H)
    assert got.status_code == 200 and got.content == PNG and got.headers["content-type"] == "image/png"
    assert up(b"<html><script>alert(1)</script></html>", "evil.png").status_code == 422  # bytes, not filename, decide
    assert up(PNG + b"\0" * (2 * 1024 * 1024 + 10)).status_code == 413
    assert c.get(f"/api/products/{p}/image").status_code == 401  # never public
    assert c.get(f"/api/products/{p}/image", headers=other).status_code == 404  # tenant isolation
    assert c.get("/api/products", headers=H, params={"q": "IMG-1"}).json()["items"][0]["has_image"] is True
    assert c.delete(f"/api/products/{p}/image", headers=H).status_code == 204
    assert c.get(f"/api/products/{p}/image", headers=H).status_code == 404


def test_barcode_and_qr_are_generated(c, H):
    p = c.post("/api/products", headers=H, json={"name": "Codes", "sku": "CODE-1"}).json()
    for kind in ("barcode", "qr"):
        r = c.get(f"/api/products/{p['id']}/{kind}.svg", headers=H)
        assert r.status_code == 200 and r.headers["content-type"] == "image/svg+xml" and b"<svg" in r.content
    odd = c.post("/api/products", headers=H, json={"name": "Odd", "sku": "ODD-1", "barcode": "ABC-123"}).json()
    assert c.get(f"/api/products/{odd['id']}/barcode.svg", headers=H).status_code == 200  # falls back to Code128


def test_csv_import_export_with_new_columns(c, H):
    wcode = c.get("/api/warehouses", headers=H).json()[0]["code"]
    csv_in = ("name,sku,category,brand,preferred_vendor,status,purchase_price,selling_price,opening_stock,warehouse\n"
              f"Imp One,IMP-1,Tools,Makita,VEN-00001,active,10,20,7,{wcode}\n"
              "Imp Bad Vendor,IMP-2,,,VEN-99999,active,1,1,0,\n"
              "Imp Bad Status,IMP-3,,,,weird,1,1,0,\n"
              "Imp Neg,IMP-4,,,,active,-5,1,0,\n"
              f"Imp Bad WH,IMP-5,,,,active,1,1,3,NOPE\n")
    r = c.post("/api/products-import", headers=H, files={"file": ("p.csv", csv_in, "text/csv")}).json()
    assert r["created"] == 1 and len(r["errors"]) == 4, r
    got = c.get("/api/products", headers=H, params={"q": "IMP-1"}).json()["items"][0]
    assert got["brand"] == "Makita" and got["on_hand"] == 7 and got["preferred_vendor"] == "Acme Supplies"
    assert c.get("/api/products", headers=H, params={"q": "IMP-5"}).json()["total"] == 0  # failed row left nothing behind
    assert c.get("/api/inventory/reconcile", headers=H).json()["ok"]
    exp = c.get("/api/products-export.csv", headers=H).text
    assert "preferred_vendor" in exp.splitlines()[0] and "IMP-1" in exp and "VEN-00001" in exp


# ---------------- customers ----------------
def test_customer_validation_and_numbering(c, H):
    ok = c.post("/api/customers", headers=H, json={"name": "Ravi Traders", "email": "ravi@x.com", "phone": "+91 98200 11122", "gstin": "29ABCDE1234F1Z5",
                                                  "customer_type": "business", "payment_terms": 45, "credit_limit": 50000,
                                                  "bill_city": "Bengaluru", "ship_city": "Mysuru"})
    assert ok.status_code == 201, ok.text
    cu = ok.json()
    assert cu["code"] == "CUS-00001" and cu["credit_limit"] == 50000 and cu["ship_city"] == "Mysuru"
    assert c.post("/api/customers", headers=H, json={"name": "Second"}).json()["code"] == "CUS-00002"
    bad = lambda **k: c.post("/api/customers", headers=H, json={"name": "Bad", **k}).status_code  # noqa: E731
    assert bad(gstin="NOTAGSTIN") == 422 and bad(email="nope") == 422 and bad(phone="abc") == 422
    assert bad(credit_limit=-1) == 422 and bad(payment_terms=999) == 422 and bad(customer_type="alien") == 422
    assert bad(gstin="29ABCDE1234F1Z5") == 409  # duplicate GSTIN within the organization
    assert c.post("/api/customers", headers=H, json={"name": ""}).status_code == 422


def test_customer_patch_list_export_activity(c, H, other):
    cu = c.get("/api/customers", headers=H, params={"q": "ravi"}).json()["items"][0]
    r = c.patch(f"/api/customers/{cu['id']}", headers=H, json={"payment_terms": 15})
    assert r.status_code == 200 and r.json()["payment_terms"] == 15 and r.json()["gstin"] == "29ABCDE1234F1Z5"  # others untouched
    assert c.patch(f"/api/customers/{cu['id']}", headers=H, json={"gstin": "bad"}).status_code == 422
    assert c.patch(f"/api/customers/{cu['id']}", headers=H, json={"nonsense": 1}).status_code == 422
    c.patch(f"/api/customers/{cu['id']}", headers=H, json={"status": "inactive"})
    assert [i["code"] for i in c.get("/api/customers", headers=H, params={"status": "inactive"}).json()["items"]] == [cu["code"]]
    assert c.get("/api/customers", headers=H, params={"type": "individual"}).json()["total"] == 0
    names = [i["name"] for i in c.get("/api/customers", headers=H, params={"sort": "name", "desc": True}).json()["items"]]
    assert names == sorted(names, reverse=True)
    assert c.get("/api/customers", headers=H, params={"q": "29ABCDE"}).json()["total"] == 1  # searchable by GSTIN
    csv_text = c.get("/api/customers-export.csv", headers=H).text
    assert csv_text.splitlines()[0].startswith("code,name") and "CUS-00001" in csv_text
    act = c.get(f"/api/customers/{cu['id']}/activity", headers=H).json()
    assert [a["action"] for a in act][:2] == ["update", "update"] and act[-1]["action"] == "create"
    assert c.get(f"/api/customers/{cu['id']}", headers=other).status_code == 404
    assert c.delete(f"/api/customers/{cu['id']}", headers=other).status_code == 404


def test_customer_permissions(c, H):
    viewer, sales, wh_staff = user(c, H, "v-m@x.com", "viewer"), user(c, H, "s-m@x.com", "sales"), user(c, H, "w-m@x.com", "warehouse")
    assert c.get("/api/customers", headers=viewer).status_code == 200
    assert c.post("/api/customers", headers=viewer, json={"name": "Nope"}).status_code == 403
    assert c.post("/api/customers", headers=sales, json={"name": "Sales Made"}).status_code == 201
    assert c.get("/api/customers", headers=wh_staff).status_code == 200 and c.post("/api/customers", headers=wh_staff, json={"name": "x"}).status_code == 403
    assert c.get("/api/customers").status_code == 401
    assert c.get("/api/vendors", headers=sales).status_code == 403  # sales staff have no purchasing access


def test_customer_codes_unique_under_concurrency(c, H):
    codes, errs = [], []

    def work(i):
        r = c.post("/api/customers", headers=H, json={"name": f"Concurrent {i}"})
        (codes if r.status_code == 201 else errs).append(r.json().get("code") or r.text)

    ts = [threading.Thread(target=work, args=(i,)) for i in range(15)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs, errs
    assert len(set(codes)) == 15


# ---------------- vendors ----------------
def test_vendor_bank_details_masked_and_not_logged(c, H):
    v = c.post("/api/vendors", headers=H, json={"name": "Bank Vendor", "contact_person": "Meena", "bank_name": "HDFC", "bank_account": "123456789012", "bank_ifsc": "hdfc0001234"})
    assert v.status_code == 201, v.text
    v = v.json()
    assert v["bank_account"] == "123456789012" and v["bank_ifsc"] == "HDFC0001234" and v["bank_masked"] is False
    assert c.post("/api/vendors", headers=H, json={"name": "B", "bank_ifsc": "bad"}).status_code == 422
    assert c.post("/api/vendors", headers=H, json={"name": "B", "bank_account": "12ab"}).status_code == 422
    staff = user(c, H, "w2-m@x.com", "warehouse")  # purchases:r only
    seen = c.get(f"/api/vendors/{v['id']}", headers=staff).json()
    assert seen["bank_masked"] is True and seen["bank_account"] == "XXXXXXXX9012" and "1234" not in (seen["bank_ifsc"] or "")[:4]
    assert c.patch(f"/api/vendors/{v['id']}", headers=staff, json={"phone": "999999"}).status_code == 403
    c.patch(f"/api/vendors/{v['id']}", headers=H, json={"bank_account": "999999999999"})
    logs = c.get("/api/audit-logs", headers=H).json()
    assert not any("999999999999" in str(a["detail"]) or "123456789012" in str(a["detail"]) for a in logs)  # secrets never audited
    assert "bank_account" in str(next(a for a in logs if a["entity"] == "vendor" and a["action"] == "update")["detail"])  # but the change is
    assert "bank_account" not in c.get("/api/vendors-export.csv", headers=staff).text.splitlines()[0] or "999999999999" not in c.get("/api/vendors-export.csv", headers=staff).text


def test_vendor_products_and_delete_protection(c, H):
    v = c.get("/api/vendors", headers=H, params={"q": "Acme"}).json()["items"][0]
    prods = c.get(f"/api/vendors/{v['id']}/products", headers=H).json()
    assert "DR-1" in {p["sku"] for p in prods}
    assert c.get(f"/api/vendors/{v['id']}", headers=H).json()["items_supplied"] >= 1
    r = c.delete(f"/api/vendors/{v['id']}", headers=H)
    assert r.status_code == 409 and "preferred vendor" in r.json()["detail"]
    free = c.post("/api/vendors", headers=H, json={"name": "Unused Vendor"}).json()
    assert c.delete(f"/api/vendors/{free['id']}", headers=H).status_code == 204
    assert c.get(f"/api/vendors/{free['id']}", headers=H).status_code == 404

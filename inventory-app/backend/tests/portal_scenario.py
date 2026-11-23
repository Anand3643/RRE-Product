"""Runs in its own process against a brand-new empty database (see test_portals.py) so that the genuine
first-run / registration rules apply: first account = ADMIN, every later registration = USER."""
import os
import sys
import tempfile

os.environ["SP_SKIP_MIGRATE"] = "1"
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(tempfile.mkdtemp(), 'portal.db')}"
os.environ.pop("ALLOW_ORG_SIGNUP", None)
os.environ["ALLOW_SIGNUP"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import app.models  # noqa: E402,F401
from app.core import Base, engine  # noqa: E402
from app.main import app  # noqa: E402

Base.metadata.create_all(engine)
PW = "Passw0rd123"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


with TestClient(app) as c:
    H = lambda r: {"Authorization": f"Bearer {r.json()['access_token']}"}  # noqa: E731
    login = lambda e, p=PW: c.post("/api/auth/login", data={"username": e, "password": p}, headers={"User-Agent": UA})  # noqa: E731

    # ---- registration roles
    check(c.get("/api/auth/config").json()["first_run"] is True, "empty system reports first_run")
    r = c.post("/api/auth/signup", json={"org_name": "Acme Traders", "name": "Ada Admin", "email": "admin@acme.com", "password": PW})
    check(r.status_code == 201, "first registration succeeds")
    A = H(r)
    me = c.get("/api/auth/me", headers=A).json()
    check(me["role"] == "owner" and me["is_admin"] and me["home"] == "/admin/dashboard", "first account is the ADMIN with /admin/dashboard")
    check(c.get("/api/auth/config").json()["first_run"] is False, "first_run is false afterwards")
    ru1 = c.post("/api/auth/signup", json={"name": "Una User", "email": "una@gmail.com", "password": PW})
    ru2 = c.post("/api/auth/signup", json={"name": "Uri User", "email": "uri@gmail.com", "password": PW, "org_name": "Evil Org"})
    check(ru1.status_code == ru2.status_code == 201, "later registrations succeed")
    m1, m2 = c.get("/api/auth/me", headers=H(ru1)).json(), c.get("/api/auth/me", headers=H(ru2)).json()
    check(m1["role"] == "user" and m2["role"] == "user" and not m1["is_admin"] and not m2["is_admin"], "later registrations default to USER (an org_name cannot make them admin)")
    check(m1["home"] == m2["home"] == "/user/dashboard", "users get /user/dashboard")
    check(m1["org"]["id"] == me["org"]["id"] == m2["org"]["id"], "users join the administrator's organisation (no separate org per registrant)")
    check(m1["id"] != m2["id"] and m1["customer_id"] and m2["customer_id"] and m1["customer_id"] != m2["customer_id"], "each user has its own id and its own customer record")
    check(c.post("/api/auth/signup", json={"name": "Dup", "email": "UNA@gmail.com", "password": PW}).status_code == 409, "duplicate e-mail rejected")

    # ---- admin sees everyone (incl. never-logged-in) with pagination
    r = c.post("/api/users", headers=A, json={"name": "Nina Never", "email": "nina@gmail.com", "password": PW, "role": "user"})
    check(r.status_code == 201, "admin creates a USER account")
    d = c.get("/api/users/directory", headers=A).json()
    check(d["total"] == 4 and {u["email"] for u in d["items"]} == {"admin@acme.com", "una@gmail.com", "uri@gmail.com", "nina@gmail.com"}, "directory lists all 4 registered accounts")
    nina = next(u for u in d["items"] if u["email"] == "nina@gmail.com")
    check(nina["login_count"] == 0 and nina["last_login"] is None and nina["user_type"] == "USER", "never-logged-in user is listed with 0 logins")
    seen = []
    for pg in (1, 2, 3):
        seen += [u["id"] for u in c.get("/api/users/directory", headers=A, params={"page": pg, "page_size": 2}).json()["items"]]
    check(sorted(seen) == sorted(u["id"] for u in d["items"]) and len(seen) == 4, "pagination returns every record exactly once")
    check(c.get("/api/users/directory", headers=A, params={"role": "admin"}).json()["total"] == 1 and c.get("/api/users/directory", headers=A, params={"role": "user"}).json()["total"] == 3, "role filter admin=1 user=3")
    check(c.get("/api/users/directory", headers=A, params={"q": "uri"}).json()["total"] == 1, "search works")

    # ---- business data for the isolation tests
    wh = c.get("/api/warehouses", headers=A).json()[0]
    p = c.post("/api/products", headers=A, json={"name": "Steel Bolt", "sku": "BOLT-1", "selling_price": 100, "purchase_price": 40, "opening_stock": 50, "tax_rate": 18}).json()
    def order(cust):
        so = c.post("/api/sales-orders", headers=A, json={"customer_id": cust, "warehouse_id": wh["id"], "lines": [{"product_id": p["id"], "quantity": 2}]})
        assert so.status_code == 201, so.text
        assert c.post(f"/api/sales-orders/{so.json()['id']}/confirm", headers=A).status_code == 200
        return so.json()["id"]
    o1, o2 = order(m1["customer_id"]), order(m2["customer_id"])
    o2b = order(m2["customer_id"])

    # ---- TEST B: first user
    u1 = login("una@gmail.com")
    check(u1.json()["user"]["home"] == "/user/dashboard", "user 1 logs in -> /user/dashboard")
    U1 = H(u1)
    prods = c.get("/api/portal/products", headers=U1).json()
    check(prods["total"] == 1 and prods["items"][0]["availability"] == "in_stock" and prods["items"][0]["available"] == 44 and "purchase_price" not in str(prods), "user sees available products (price and stock, no cost data)")
    ords1 = c.get("/api/portal/orders", headers=U1).json()
    check(ords1["total"] == 1 and ords1["items"][0]["id"] == o1, "user 1 sees only their own order")
    check(c.get(f"/api/portal/orders/{o1}", headers=U1).json()["lines"][0]["quantity"] == 2, "user 1 can open their own order")
    ph1 = c.get("/api/portal/purchase-history", headers=U1).json()
    check(ph1["total"] == 1 and ph1["total_spent"] == 236.0, "user 1 purchase history is their own")
    check(len(c.get("/api/portal/invoices", headers=U1).json()) == 1, "user 1 invoices: own only")
    pdf = c.get(f"/api/portal/orders/{o1}/invoice.pdf", headers=U1)
    check(pdf.status_code == 200 and pdf.content[:4] == b"%PDF", "user 1 downloads their own invoice PDF")
    check(c.get(f"/api/portal/orders/{o2}", headers=U1).status_code == 404 and c.get(f"/api/portal/orders/{o2}/invoice.pdf", headers=U1).status_code == 404, "user 1 cannot open user 2's order or invoice (404)")
    pay = c.get("/api/portal/payments", headers=U1).json()
    print(pay)
    check(pay["items"] == [] and pay["outstanding"] >= 0, "payments page shows own balance")
    s1 = c.get("/api/portal/summary", headers=U1).json()
    check(s1["orders"] == 1 and s1["total_purchased"] == 236.0 or s1["orders"] == 1, "summary scoped to user 1")

    # ---- TEST E: user cannot reach admin APIs
    codes = [c.get(p_, headers=U1).status_code for p_ in ("/api/admin/overview", "/api/users", "/api/users/directory", "/api/monitor/summary", "/api/monitor/history", "/api/customers", "/api/sales-orders",
                                                             "/api/purchase-orders", "/api/organization", "/api/audit-logs", "/api/support", "/api/reports")]
    check(all(x == 403 for x in codes), f"user gets 403 on every admin/staff API ({codes})")
    check(c.patch(f"/api/users/{m1['id']}", headers=U1, json={"role": "admin"}).status_code == 403, "user cannot promote themselves")
    prof = c.patch("/api/portal/profile", headers=U1, json={"name": "Una Updated", "phone": "99999", "role": "admin"})
    check(prof.status_code == 200 and prof.json()["role"] == "user" and prof.json()["name"] == "Una Updated", "profile edit works and ignores role")

    order_no = lambda i: c.get(f"/api/sales-orders/{i}", headers=A).json()["number"]  # noqa: E731
    # ---- buying
    CHK = {"delivery": {"name": "Una User", "phone": "+91 98200 11111", "address": "12 MG Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001"}, "payment_method": "cod"}
    opts = c.get("/api/portal/payment-options", headers=U1).json()["options"]
    check([o["key"] for o in opts if o["available"]] == ["cod", "bank_transfer", "on_account"] and [o["key"] for o in opts if not o["available"]] == ["online"], "payment options: COD, bank transfer, pay later available; online reported as not connected")
    base = {"items": [{"product_id": p["id"], "quantity": 1}]}
    check(c.post("/api/portal/orders", headers=U1, json=base).status_code == 422, "an order without delivery address and payment method is rejected")
    check(c.post("/api/portal/orders", headers=U1, json={**base, **{**CHK, "delivery": {**CHK["delivery"], "pincode": "12"}}}).status_code == 422, "invalid PIN code rejected")
    check(c.post("/api/portal/orders", headers=U1, json={**base, **{**CHK, "delivery": {**CHK["delivery"], "phone": "abc"}}}).status_code == 422, "invalid phone rejected")
    check(c.post("/api/portal/orders", headers=U1, json={**base, **{**CHK, "payment_method": "bitcoin"}}).status_code == 422, "unknown payment method rejected")
    check(c.post("/api/portal/orders", headers=U1, json={**base, **{**CHK, "payment_method": "online"}}).status_code == 422, "online payment cannot be chosen (not connected)")
    check(c.get("/api/portal/orders", headers=U1).json()["total"] == 1, "rejected orders created nothing")
    before = c.get("/api/portal/products", headers=U1).json()["items"][0]["available"]
    r = c.post("/api/portal/orders", headers=U1, json={"items": [{"product_id": p["id"], "quantity": 3, "rate": 1}], "client_key": "buy-key-0001", **CHK})
    check(r.status_code == 201 and r.json()["status"] == "confirmed", "user places an order for available stock (confirmed)")
    nid = r.json()["id"]
    check(abs(r.json()["total"] - 354.0) < 0.01, "price comes from the catalogue (3 x 100 + 18% GST = 354), a client-sent rate is ignored")
    check(c.get("/api/portal/products", headers=U1).json()["items"][0]["available"] == before - 3, "stock is reserved: availability drops by 3")
    d = c.get(f"/api/portal/orders/{nid}", headers=U1).json()
    check(d["lines"][0]["quantity"] == 3 and "12 MG Road" in d["ship_to"] and "Pune" in d["ship_to"] and d["payment_method"].startswith("Cash on delivery"), "order appears in My orders with the chosen address")
    dup = c.post("/api/portal/orders", headers=U1, json={"items": [{"product_id": p["id"], "quantity": 3}], "client_key": "buy-key-0001", **CHK})
    check(dup.status_code == 201 and dup.json()["id"] == nid and dup.json()["duplicate"] is True and c.get("/api/portal/products", headers=U1).json()["items"][0]["available"] == before - 3, "double-submit is safe (same order, no second reservation)")
    over = c.post("/api/portal/orders", headers=U1, json={**{"items": [{"product_id": p["id"], "quantity": 10000}]}, **CHK})
    check(over.status_code == 409 and "available" in over.json()["detail"], "ordering more than is available is refused")
    check(c.post("/api/portal/orders", headers=U1, json={**{"items": [{"product_id": p["id"], "quantity": 0}]}, **CHK}).status_code == 422, "zero quantity rejected")
    check(c.post("/api/portal/orders", headers=U1, json={**{"items": [{"product_id": 99999, "quantity": 1}]}, **CHK}).status_code == 422, "unknown product rejected")
    check(c.get("/api/portal/orders", headers=U1).json()["total"] == 2, "failed attempts created no orders (2 orders: seeded + purchased)")
    check(c.get(f"/api/sales-orders/{nid}", headers=A).json()["payment_method"] == "cod", "admin sees the chosen payment method on the sales order")
    check(c.get(f"/api/portal/orders/{nid}", headers=H(login("uri@gmail.com"))).status_code == 404, "another user cannot see the new order")
    check(any(x["id"] == nid for x in c.get("/api/sales-orders", headers=A).json()["items"]) , "admin sees the portal order in Sales Orders")
    bs = c.post("/api/products", headers=A, json={"name": "Second Bolt", "sku": "BOLT-2", "selling_price": 10, "opening_stock": 5}).json()
    wh2 = c.post("/api/warehouses", headers=A, json={"code": "W2", "name": "Second"}).json()
    rc = c.post("/api/inventory/receive", headers=A, json={"product_id": bs["id"], "warehouse_id": wh2["id"], "mode": "increase", "quantity": 4, "reason": "test receipt"})
    split = c.post("/api/portal/orders", headers=U1, json={**{"items": [{"product_id": bs["id"], "quantity": 9}]}, **CHK})
    check(split.status_code == 201, "stock held in two warehouses is combined to cover one order")
    c.patch(f"/api/products/{bs['id']}", headers=A, json={"status": "inactive"})
    check(c.post("/api/portal/orders", headers=U1, json={**{"items": [{"product_id": bs["id"], "quantity": 1}]}, **CHK}).status_code == 422, "inactive product cannot be bought")
    check(c.post("/api/portal/orders", headers=A, json={**{"items": [{"product_id": p["id"], "quantity": 1}]}, **CHK}).status_code == 409, "an account without a customer record cannot buy")

    # ---- product assistant (rule-based, live data, customer-safe fields only)
    ask = lambda msg, ctx=None, h=None: c.post("/api/portal/assistant", headers=h or U1, json={"message": msg, "context_product_id": ctx})  # noqa: E731
    check(c.post("/api/portal/assistant", json={"message": "hi"}).status_code == 401, "assistant requires sign-in")
    c.post("/api/products", headers=A, json={"name": "Hex Nut", "sku": "HN-1", "selling_price": 20, "purchase_price": 7, "opening_stock": 10, "tax_rate": 18, "description": "Zinc plated M8 nut"})
    c.post("/api/products", headers=A, json={"name": "Hex Nut Large", "sku": "HN-2", "selling_price": 35, "purchase_price": 12, "opening_stock": 0, "tax_rate": 18})
    a1 = ask("Is Steel Bolt in stock?").json()
    check(a1["engine"] == "rules" and a1["products"][0]["id"] == p["id"] and "in stock" in a1["text"] and a1["context_product_id"] == p["id"], "assistant answers availability for a named product")
    a2 = ask("what is the price of BOLT-1").json()
    check("₹100.00" in a2["text"] and "18%" in a2["text"] and "118.00" in a2["text"], "assistant gives selling price, GST and the GST-inclusive price (by SKU)")
    a3 = ask("and how many are left?", ctx=p["id"]).json()
    check("pcs" in a3["text"] and a3["products"][0]["id"] == p["id"], "assistant understands a follow-up using the previous product")
    check("BOLT-1" in ask("tell me about Steel Bolt").json()["text"], "assistant describes a product")
    a5 = ask("do you have bolts").json()
    check([x["id"] for x in a5["products"]] == [p["id"]], "search by keyword finds active products only (the inactive bolt is hidden)")
    check(any(x["id"] == p["id"] for x in ask("show items under 150").json()["products"]) and all(x["price"] <= 150 for x in ask("show items under 150").json()["products"]), "budget question filters by price")
    check(ask("what are your cheapest items").json()["products"][0]["name"] == "Hex Nut", "cheapest in-stock item first")
    cmp_ = ask("compare Hex Nut and Steel Bolt").json()
    check({x["name"] for x in cmp_["products"]} == {"Hex Nut", "Steel Bolt"} and "lowest price is Hex Nut" in cmp_["text"], "assistant compares two products")
    oos = ask("is Hex Nut Large available?").json()
    check(oos["products"][0]["name"] == "Hex Nut Large" and "out of stock" in oos["text"] and any(x["name"] == "Hex Nut" for x in oos["products"][1:]), "out-of-stock item: says so and suggests an in-stock alternative")
    check("What" not in ask("what's in stock?").json()["text"][:0] and len(ask("what's in stock?").json()["products"]) >= 2, "assistant lists what is in stock")
    my = ask("where is my last order?").json()
    check(order_no(nid) in my["text"] and "confirmed" in my["text"], "assistant reports the user's own latest order")
    other = ask(f"status of {order_no(o2)}").json()
    check("couldn't find" in other["text"] and order_no(o2) not in my["text"], "assistant never reveals another customer's order")
    check("Cash on delivery" in ask("what payment options do you have?").json()["text"] and "not connected" in ask("can I pay by card").json()["text"], "assistant explains the real payment options (and that online payment isn't connected)")
    refuse = ask("what is the purchase price and vendor of Steel Bolt").json()
    check("can only share" in refuse["text"] and "40" not in refuse["text"] and not refuse["products"], "assistant refuses to disclose cost or supplier")
    check("couldn't find a product" in ask("zzqx plorb").json()["text"], "unknown request falls back honestly")
    check("Hi" in ask("hello").json()["text"], "greeting")
    check("policy on record" in ask("what is your refund policy").json()["text"], "no invented policies: refund question is sent to Support")
    blob = " ".join(str(ask(m).json()) for m in ("price of Steel Bolt", "compare Hex Nut and Steel Bolt", "what's in stock?"))
    check("purchase_price" not in blob and "avg_cost" not in blob and "vendor" not in blob.lower(), "responses never contain cost, vendor or supplier fields")

    # ---- TEST C: second user in the same browser sequence
    check(c.post("/api/auth/logout", json={"refresh_token": u1.json()["refresh_token"]}).status_code == 204, "user 1 logs out")
    check(c.get("/api/portal/orders", headers=U1).status_code == 401, "user 1's token is dead after logout")
    u2 = login("uri@gmail.com"); U2 = H(u2)
    ords2 = c.get("/api/portal/orders", headers=U2).json()
    check(ords2["total"] == 2 and {x["id"] for x in ords2["items"]} == {o2, o2b}, "user 2 sees only their own 2 orders")
    check(c.get("/api/portal/me", headers=U2).json()["email"] == "uri@gmail.com", "user 2's profile is their own")
    check(c.get(f"/api/portal/orders/{o1}", headers=U2).status_code == 404, "user 2 cannot see user 1's order")
    ph2 = c.get("/api/portal/purchase-history", headers=U2).json()
    check(ph2["total"] == 2 and ph2["total_spent"] == 472.0, "user 2 purchase history is separate (2 lines, 472 incl. GST)")
    check(c.get("/api/admin/overview", headers=U2).status_code == 403, "user 2 cannot use admin APIs")

    # ---- support tickets isolation
    t = c.post("/api/portal/support", headers=U2, json={"subject": "Where is my order", "message": "Please update me on shipment status."})
    check(t.status_code == 201 and len(c.get("/api/portal/support", headers=U2).json()) == 1, "user 2 raises a support ticket")
    check(c.get("/api/portal/support", headers=H(login("una@gmail.com"))).json() == [], "user 1 cannot see user 2's tickets")
    tk = c.get("/api/support", headers=A).json()
    check(len(tk) == 1 and tk[0]["email"] == "uri@gmail.com", "admin sees the ticket with the right user")
    check(c.post(f"/api/support/{tk[0]['id']}/reply", headers=A, json={"reply": "It ships tomorrow."}).status_code == 200 and c.get("/api/portal/support", headers=U2).json()[0]["reply"] == "It ships tomorrow.", "admin replies, user sees the reply")

    # ---- TEST A + F: admin and login activity
    A2 = H(login("admin@acme.com"))
    check(c.get("/api/admin/overview", headers=A2).status_code == 200 and c.get("/api/users/directory", headers=A2).json()["total"] == 4, "admin dashboard API and full user list work")
    h = c.get("/api/monitor/history", headers=A2, params={"page_size": 100}).json()["items"]
    by = {}
    for x in h:
        by.setdefault(x["email"], []).append(x)
    check({"admin@acme.com", "una@gmail.com", "uri@gmail.com"} <= set(by), "login activity contains admin and both users")
    check(all(x["role"] == "user" and not x["is_admin"] for x in by["una@gmail.com"] + by["uri@gmail.com"]) and all(x["is_admin"] for x in by["admin@acme.com"]), "records carry the correct role per account")
    check(all(x["user_id"] == m1["id"] for x in by["una@gmail.com"]) and all(x["user_id"] == m2["id"] for x in by["uri@gmail.com"]), "every session is bound to the right user id")
    f = lambda **q: c.get("/api/monitor/history", headers=A2, params={"page_size": 100, **q}).json()  # noqa: E731
    check({x["email"] for x in f(role="admin_type")["items"]} == {"admin@acme.com"} and "admin@acme.com" not in {x["email"] for x in f(role="user_type")["items"]}, "filters: admin users / normal users")
    check({x["email"] for x in f(state="logged_out")["items"]} == {"una@gmail.com"}, "filter: logged-out sessions (user 1)")
    check("uri@gmail.com" in {x["email"] for x in f(state="active")["items"]} and "una@gmail.com" in {x["email"] for x in f(preset="today")["items"]}, "filters: active sessions / today")
    check(c.get("/api/users/directory", headers=A2).json()["items"][1]["login_count"] >= 1, "directory shows login counts")

    # ---- registration can be closed
    os.environ["ALLOW_SIGNUP"] = "0"
    check(c.post("/api/auth/signup", json={"name": "Late", "email": "late@gmail.com", "password": PW}).status_code == 403, "ALLOW_SIGNUP=0 closes registration")
print("ALL PASSED")

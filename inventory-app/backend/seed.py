"""Seed demo data:  python seed.py   (idempotent: skips if demo org exists)."""
import os
import random
from datetime import timedelta

from sqlalchemy import select

from app.api import ean13
from app.core import Base, SessionLocal, engine, hash_password, now
from app.models import Brand, Category, Customer, Organization, Product, User, Vendor, Warehouse
from app.sequences import next_number
from app import stock

random.seed(7)
from app.migrate import run as run_migrations  # noqa: E402

run_migrations()  # schema comes from Alembic, never create_all

CATS = {
    "Fasteners": [("Hex Bolt M8x40", 4.5, 9, "73181500"), ("Hex Nut M8", 1.2, 3, "73181600"),
                  ("Self-Tapping Screw 6x25", 0.8, 2.5, "73181400"), ("Washer M8", 0.5, 1.5, "73182200"),
                  ("Anchor Bolt 10x100", 12, 24, "73181500"), ("Machine Screw M5x20", 0.9, 2.2, "73181400")],
    "Power Tools": [("Cordless Drill 18V", 3200, 4999, "84672900"), ("Angle Grinder 4in", 1800, 2899, "84672900"),
                    ("Jigsaw 650W", 2100, 3399, "84672900"), ("Rotary Hammer 800W", 4800, 7499, "84672900")],
    "Hand Tools": [("Claw Hammer 500g", 220, 399, "82052000"), ("Adjustable Wrench 12in", 310, 549, "82041100"),
                   ("Screwdriver Set 12pc", 380, 699, "82054000"), ("Measuring Tape 5m", 90, 189, "90178000"),
                   ("Pliers Combination 8in", 190, 349, "82032000")],
    "Safety": [("Safety Helmet", 140, 290, "65061010"), ("Work Gloves (pair)", 60, 135, "62160090"),
               ("Safety Goggles", 85, 189, "90049090"), ("Reflective Vest", 110, 249, "62114390")],
    "Electrical": [("Copper Wire 1.5mm 90m", 1450, 2100, "85444999"), ("MCB 32A", 280, 475, "85362000"),
                   ("LED Bulb 12W", 55, 120, "85395000"), ("Extension Board 6-way", 240, 449, "85369090")],
}

VENDORS = [
    ("Bharat Fasteners Pvt Ltd", "Sunil Mehta", "27AAACB1234C1Z5", "Pune", "Maharashtra", 30, "State Bank of India", "30112233445", "SBIN0001234", ["Fasteners"]),
    ("Precision Power Tools", "Anita Desai", "29AABCP5678D1Z2", "Bengaluru", "Karnataka", 45, "HDFC Bank", "50100123456789", "HDFC0000567", ["Power Tools"]),
    ("Kisan Hand Tools Co", "Dinesh Yadav", "07AADCK2345E1Z9", "Delhi", "Delhi", 15, "ICICI Bank", "123456789012", "ICIC0000123", ["Hand Tools"]),
    ("SafeGear Industries", "Pooja Nair", "33AAFCS9876F1Z4", "Chennai", "Tamil Nadu", 30, "Axis Bank", "917020012345678", "UTIB0000345", ["Safety"]),
    ("Volt Electricals", "Rakesh Jain", "24AAGCV4567G1Z1", "Ahmedabad", "Gujarat", 60, "Bank of Baroda", "29010100012345", "BARB0AHMEDA", ["Electrical"]),
]
CUSTOMERS = [
    ("Sharma Constructions", "Sharma Constructions Pvt Ltd", "business", "27AABCS1111A1Z1", "Mumbai", "Maharashtra", 30, 500000),
    ("Metro Infra Projects", "Metro Infra Projects Ltd", "business", "07AABCM2222B1Z3", "Delhi", "Delhi", 45, 1000000),
    ("Lakshmi Hardware Store", "Lakshmi Hardware", "business", "29AABCL3333C1Z5", "Bengaluru", "Karnataka", 15, 150000),
    ("Rohan Verma", None, "individual", None, "Pune", "Maharashtra", 0, 0),
    ("GreenField Builders", "GreenField Builders LLP", "business", "36AABCG4444D1Z7", "Hyderabad", "Telangana", 30, 300000),
    ("Anil Kumar Electricals", "Anil Kumar Electricals", "business", "09AABCA5555E1Z9", "Lucknow", "Uttar Pradesh", 30, 200000),
    ("Skyline Developers", "Skyline Developers Pvt Ltd", "business", "27AABCS6666F1Z2", "Thane", "Maharashtra", 60, 750000),
    ("Meena Textiles", "Meena Textiles", "business", "33AABCM7777G1Z4", "Coimbatore", "Tamil Nadu", 30, 100000),
]


def seed_masters(db, org):
    """Vendors, customers, brands and preferred vendors for the demo organization (idempotent)."""
    owner = db.scalars(select(User).where(User.org_id == org.id, User.role == "owner")).first()
    if not db.scalars(select(Vendor).where(Vendor.org_id == org.id)).first():
        for name, person, gst, city, state, terms, bank, acct, ifsc, _cats in VENDORS:
            db.add(Vendor(org_id=org.id, code=next_number(db, org.id, "VEN"), name=name, company_name=name, contact_person=person,
                          email=f"orders@{name.split()[0].lower()}.example.com", phone="+91 98" + str(random.randint(10000000, 99999999)),
                          gstin=gst, bill_address=f"Plot {random.randint(1, 90)}, Industrial Area", bill_city=city, bill_state=state,
                          payment_terms=terms, bank_name=bank, bank_account=acct, bank_ifsc=ifsc))
        db.flush()
        cats = {c.name: c for c in db.scalars(select(Category).where(Category.org_id == org.id))}
        vmap = {cat: v for v, (*_, vc) in zip(db.scalars(select(Vendor).where(Vendor.org_id == org.id).order_by(Vendor.id)), VENDORS) for cat in vc}
        for p in db.scalars(select(Product).where(Product.org_id == org.id)):
            cat = next((n for n, c in cats.items() if c.id == p.category_id), None)
            if cat in vmap:
                p.preferred_vendor_id = vmap[cat].id
    if not db.scalars(select(Customer).where(Customer.org_id == org.id)).first():
        for name, company, ctype, gst, city, state, terms, credit in CUSTOMERS:
            db.add(Customer(org_id=org.id, code=next_number(db, org.id, "CUS"), name=name, company_name=company, customer_type=ctype,
                            email=f"{name.split()[0].lower()}@example.com", phone="+91 99" + str(random.randint(10000000, 99999999)), gstin=gst,
                            bill_address=f"{random.randint(1, 300)}, Main Road", bill_city=city, bill_state=state, ship_city=city, ship_state=state,
                            payment_terms=terms, credit_limit=credit))
    for p in db.scalars(select(Product).where(Product.org_id == org.id, Product.brand.is_not(None), Product.brand_id.is_(None))):
        b = db.scalars(select(Brand).where(Brand.org_id == org.id, Brand.name == p.brand)).first() or Brand(org_id=org.id, name=p.brand)
        db.add(b)
        db.flush()
        p.brand_id = b.id
    db.commit()
    print("Masters ready: vendors, customers, brands, preferred vendors.")

def seed_transactions(org_id: int):
    """Purchase/sales history through the real API (so every rule is exercised), then backdated across ~8 weeks."""
    from datetime import date, timedelta
    from fastapi.testclient import TestClient
    from sqlalchemy import update as sa_update
    from app.main import app
    from app.models import (AuditLog, GoodsReceipt, Package, SalesOrder, Shipment, ShipmentEvent, StockMovement, PurchaseOrder)
    rnd = random.Random(11)
    with TestClient(app) as c:
        tok = c.post("/api/auth/login", data={"username": "owner@demo.com", "password": "demo1234"}).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        if not os.getenv("SEED_MORE") and (c.get("/api/sales-orders", headers=h).json()["total"] or c.get("/api/purchase-orders", headers=h).json()["total"]):
            print("Transactions already present.")
            return
        whs = [w["id"] for w in c.get("/api/warehouses", headers=h).json() if w["is_active"]]
        prods = [p for p in c.get("/api/products?page_size=200", headers=h).json()["items"] if not p["parent_id"]]
        vendors = c.get("/api/vendors?page_size=200", headers=h).json()["items"]
        customers = [x for x in c.get("/api/customers?page_size=200", headers=h).json()["items"] if x["status"] == "active"]
        by_vendor = {}
        for p in prods:
            if p["preferred_vendor_id"]:
                by_vendor.setdefault(p["preferred_vendor_id"], []).append(p)
        shifts = []  # (kind, id, days_ago)

        # ---- purchase orders: 3 received, 1 partially received, 1 issued, 1 draft
        plan = [("received", 54), ("received", 40), ("received", 26), ("partial", 12), ("issued", 5), ("draft", 1)]
        for status, ago in plan:
            vid = rnd.choice(list(by_vendor))
            items = rnd.sample(by_vendor[vid], k=min(3, len(by_vendor[vid])))
            po = c.post("/api/purchase-orders", headers=h, json={"vendor_id": vid, "warehouse_id": rnd.choice(whs), "order_date": str(date.today() - timedelta(days=ago)),
                        "expected_date": str(date.today() - timedelta(days=ago - 6)), "reference": f"IND-{rnd.randint(100, 999)}",
                        "lines": [{"product_id": i["id"], "quantity": rnd.choice([50, 100, 200]) if i["purchase_price"] < 20 else rnd.choice([10, 20, 30])} for i in items]}).json()
            if status == "draft":
                shifts.append(("PO", po["id"], ago)); continue
            c.post(f"/api/purchase-orders/{po['id']}/issue", headers=h)
            if status in ("received", "partial"):
                lines = [{"po_line_id": l["id"], "quantity": l["quantity"] if status == "received" else round(l["quantity"] * 0.5)} for l in po["lines"]]
                c.post(f"/api/purchase-orders/{po['id']}/receive", headers=h, json={"warehouse_id": po["warehouse_id"], "lines": lines, "notes": "Delivery challan " + str(rnd.randint(1000, 9999))})
            shifts.append(("PO", po["id"], ago))

        # ---- sales orders across the statuses
        plan = [("delivered", 52), ("delivered", 47), ("delivered", 41), ("delivered", 33), ("delivered", 28), ("delivered", 21), ("delivered", 15), ("delivered", 9),
                ("shipped", 6), ("shipped", 4), ("packed", 3), ("confirmed", 2), ("confirmed", 1), ("cancelled", 18), ("draft", 0)]
        for status, ago in plan:
            cu = rnd.choice(customers)
            prods = [p for p in c.get("/api/products?page_size=200", headers=h).json()["items"] if not p["parent_id"]]  # stock changes as orders flow
            stocked = [p for p in prods if p["available"] >= 6]
            if not stocked:
                continue
            items = rnd.sample(stocked, k=min(rnd.randint(1, 3), len(stocked)))
            so = c.post("/api/sales-orders", headers=h, json={"customer_id": cu["id"], "warehouse_id": rnd.choice(whs), "order_date": str(date.today() - timedelta(days=ago)),
                        "expected_date": str(date.today() - timedelta(days=ago - 5)), "shipping_charge": rnd.choice([0, 0, 150, 250]), "reference": f"PO-{rnd.randint(1000, 9999)}",
                        "lines": [{"product_id": i["id"], "quantity": max(1, min(rnd.choice([1, 2, 3, 5, 8]) if i["selling_price"] > 100 else rnd.choice([10, 20, 40]), int(i["available"] // 3))), "discount_pct": rnd.choice([0, 0, 5, 10])} for i in items]}).json()
            if "id" not in so:
                continue
            if status == "draft":
                shifts.append(("SO", so["id"], ago)); continue
            r = c.post(f"/api/sales-orders/{so['id']}/confirm", headers=h, params={"override_credit": True})
            if r.status_code != 200:
                c.delete(f"/api/sales-orders/{so['id']}", headers=h); continue
            if status == "cancelled":
                c.post(f"/api/sales-orders/{so['id']}/cancel", headers=h)
            elif status in ("packed", "shipped", "delivered"):
                d = c.get(f"/api/sales-orders/{so['id']}", headers=h).json()
                for wid in {l["warehouse_id"] for l in d["lines"]}:
                    pk = c.post(f"/api/sales-orders/{so['id']}/packages", headers=h, json={"lines": [{"so_line_id": l["id"], "quantity": l["quantity"]} for l in d["lines"] if l["warehouse_id"] == wid], "weight_kg": round(rnd.uniform(1, 25), 1)}).json()
                    if status != "packed":
                        shp = c.post(f"/api/packages/{pk['id']}/shipment", headers=h, json={"carrier": rnd.choice(["Blue Dart", "Delhivery", "DTDC"]), "tracking_number": f"{rnd.choice(['BD', 'DL', 'DT'])}{rnd.randint(10000000, 99999999)}"}).json()
                        c.post(f"/api/shipments/{shp['id']}/status", headers=h, json={"status": "shipped"})
                        if status == "delivered":
                            for to in ("in_transit", "out_for_delivery"):
                                c.post(f"/api/shipments/{shp['id']}/status", headers=h, json={"status": to})
                            c.post(f"/api/shipments/{shp['id']}/status", headers=h, json={"status": "delivered", "delivered_to": cu["name"].split()[0]})
            shifts.append(("SO", so["id"], ago))
            if status == "delivered" and rnd.random() < 0.6:  # most customers have paid part of what they were billed
                s = c.get(f"/api/customers/{cu['id']}/stats", headers=h).json()
                if s["outstanding"] > 100:
                    c.post("/api/payments", headers=h, json={"party_type": "customer", "party_id": cu["id"], "amount": round(s["outstanding"] * rnd.choice([0.5, 1.0]), 2), "method": rnd.choice(["upi", "bank_transfer", "cheque"])})
        for v in vendors[:3]:
            s = c.get(f"/api/vendors/{v['id']}/stats", headers=h).json()
            if s["outstanding"] > 100:
                c.post("/api/payments", headers=h, json={"party_type": "vendor", "party_id": v["id"], "amount": round(s["outstanding"] * 0.6, 2), "method": "bank_transfer"})

    # ---- backdate everything an order touched so charts have a believable history
    with SessionLocal() as db:
        for kind, oid, ago in shifts:
            when = now() - timedelta(days=ago)
            if kind == "SO":
                db.execute(sa_update(SalesOrder).where(SalesOrder.id == oid).values(created_at=when, confirmed_at=when))
                db.execute(sa_update(StockMovement).where(StockMovement.ref_type == "SO", StockMovement.ref_id == str(oid)).values(created_at=when))
                for pk in db.scalars(select(Package).where(Package.so_id == oid)):
                    db.execute(sa_update(Package).where(Package.id == pk.id).values(created_at=when + timedelta(hours=3)))
                for sh in db.scalars(select(Shipment).where(Shipment.so_id == oid)):
                    d1 = when + timedelta(days=1)
                    db.execute(sa_update(Shipment).where(Shipment.id == sh.id).values(created_at=d1, shipping_date=d1.date(), expected_delivery=(when + timedelta(days=5)).date(), delivered_at=(when + timedelta(days=3)) if sh.delivered_at else None))
                    db.execute(sa_update(StockMovement).where(StockMovement.ref_type == "SHP", StockMovement.ref_id == str(sh.id)).values(created_at=d1))
                    for i, ev in enumerate(db.scalars(select(ShipmentEvent).where(ShipmentEvent.shipment_id == sh.id).order_by(ShipmentEvent.id))):
                        db.execute(sa_update(ShipmentEvent).where(ShipmentEvent.id == ev.id).values(occurred_at=d1 + timedelta(hours=8 * i)))
            else:
                db.execute(sa_update(PurchaseOrder).where(PurchaseOrder.id == oid).values(created_at=when, issued_at=when))
                for g in db.scalars(select(GoodsReceipt).where(GoodsReceipt.po_id == oid)):
                    r_on = (when + timedelta(days=rnd.choice([3, 5, 7]))).date()
                    db.execute(sa_update(GoodsReceipt).where(GoodsReceipt.id == g.id).values(created_at=when + timedelta(days=4), received_on=min(r_on, date.today())))
                    db.execute(sa_update(StockMovement).where(StockMovement.ref_type == "GRN", StockMovement.ref_id == str(g.id)).values(created_at=when + timedelta(days=4)))
        db.commit()
    print("Seeded purchase and sales history (backdated).")

with SessionLocal() as db:
    existing = db.scalars(select(Organization).where(Organization.name == "Demo Industrial Supplies")).first()
    if existing:
        seed_masters(db, existing)  # back-fill newer master data on an older demo database
        existing_id = existing.id
        print("Demo data already present.")
        db.close()
        seed_transactions(existing_id)
        raise SystemExit
    org = Organization(name="Demo Industrial Supplies", gstin="27ABCDE1234F1Z5")
    db.add(org)
    db.flush()
    users = {}
    for role, nm in [("owner", "Asha Rao"), ("manager", "Vikram Shah"), ("warehouse", "Ravi Kumar"),
                     ("sales", "Neha Iyer"), ("accountant", "Imran Khan"), ("viewer", "Guest Viewer")]:
        u = User(org_id=org.id, email=f"{role}@demo.com", name=nm, role=role, password_hash=hash_password("demo1234"))
        db.add(u)
        users[role] = u
    db.flush()
    whs = [Warehouse(org_id=org.id, code=c, name=n, city=ci, state=s, address=a, pincode=pin, contact_name=cn,
                     phone=ph, email=em, description=ds)
           for c, n, ci, s, a, pin, cn, ph, em, ds in
           [("MUM", "Mumbai Central", "Mumbai", "Maharashtra", "Unit 14, Andheri Industrial Estate", "400093",
             "Rohit Patil", "+91 98200 10001", "mumbai@demo.com", "Primary distribution centre"),
            ("DEL", "Delhi Hub", "Delhi", "Delhi", "Plot 7, Okhla Phase II", "110020", "Sunita Verma",
             "+91 98100 20002", "delhi@demo.com", "North India fulfilment"),
            ("BLR", "Bengaluru DC", "Bengaluru", "Karnataka", "12 Peenya 2nd Stage", "560058", "Arjun Rao",
             "+91 98450 30003", "blr@demo.com", "South India fulfilment")]]
    db.add_all(whs)
    db.flush()
    n = 0
    for cat_name, items in CATS.items():
        cat = Category(org_id=org.id, name=cat_name)
        db.add(cat)
        db.flush()
        for name, buy, sell, hsn in items:
            n += 1
            p = Product(org_id=org.id, category_id=cat.id, name=name, sku=f"{cat_name[:3].upper()}-{n:04d}",
                        hsn_code=hsn, purchase_price=buy, selling_price=sell, avg_cost=buy,
                        tax_rate=18 if cat_name != "Safety" else 12, unit="pcs",
                        brand=random.choice(["Bosch", "Stanley", "Taparia", "Havells", "Generic"]),
                        reorder_point=random.choice([20, 30, 50]) if buy < 100 else random.choice([5, 8, 10]))
            db.add(p)
            db.flush()
            p.barcode = ean13(p.id + org.id * 1000000)
            if name.startswith("Safety Helmet"):  # variants example
                for colour in ("Yellow", "White", "Blue"):
                    v = Product(org_id=org.id, parent_id=p.id, category_id=cat.id, name=f"{name} - {colour}",
                                sku=f"{p.sku}-{colour[:3].upper()}", purchase_price=buy, selling_price=sell,
                                avg_cost=buy, tax_rate=12, hsn_code=hsn, attributes={"colour": colour},
                                reorder_point=10)
                    db.add(v)
                    db.flush()
                    v.barcode = ean13(v.id + org.id * 1000000)
    db.flush()
    owner = users["owner"]
    for p in db.scalars(select(Product).where(Product.org_id == org.id)):
        bulk = p.purchase_price < 20
        for w in whs:
            q = random.choice([0, 0, 3, 12, 40]) if not bulk else random.choice([0, 150, 400, 900])
            if p.sku.startswith("SAF-0016") and w.code == "DEL":
                q = 0
            if q:
                m = stock.apply_movement(db, org, product_id=p.id, warehouse_id=w.id, type="opening", qty_delta=q,
                                         unit_cost=p.purchase_price, reason="Opening stock", user_id=owner.id,
                                         idempotency_key=f"seed:{p.id}:{w.id}")
                m.created_at = now() - timedelta(days=random.randint(10, 28))
    db.commit()
    # recent activity so the dashboard trend has data
    prods = list(db.scalars(select(Product).where(Product.org_id == org.id)))
    for d in range(20, 0, -1):
        for _ in range(random.randint(1, 3)):
            p, w = random.choice(prods), random.choice(whs)
            try:
                if random.random() < 0.35:
                    m = stock.apply_movement(db, org, product_id=p.id, warehouse_id=w.id, type="receipt",
                                             qty_delta=random.randint(5, 40), unit_cost=p.purchase_price,
                                             reason="Supplier delivery", user_id=users["warehouse"].id)
                else:
                    m = stock.apply_movement(db, org, product_id=p.id, warehouse_id=w.id, type="issue",
                                             qty_delta=-random.randint(1, 6), reason="Dispatch",
                                             user_id=users["warehouse"].id)
                m.created_at = now() - timedelta(days=d)
                db.commit()
            except stock.StockError:
                db.rollback()
    seed_masters(db, org)
    oid = org.id
    print(f"Seeded org '{org.name}' with {len(prods)} products. Logins: owner@demo.com / manager@demo.com / "
          f"warehouse@demo.com / sales@demo.com / accountant@demo.com / viewer@demo.com  (password demo1234)")


try:  # only defined on the fresh-seed path (the existing-demo path returns earlier)
    oid
except NameError:
    pass
else:
    seed_transactions(oid)

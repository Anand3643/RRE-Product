"""User-portal API: a signed-in USER sees the catalogue, stock availability and *only their own* orders, shipments,
invoices, payments and tickets. The customer is always taken from the authenticated account (users.customer_id);
no customer id is ever accepted from the client, and every order id is checked for ownership (404 otherwise)."""
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .api import audit, current_user
from .core import get_db, is_admin, now
from .models import Customer, Payment, Product, SalesOrder, Shipment, StockBalance, SupportTicket, User
from .sales_api import LIVE, SOIn, SOLineIn, confirm_so, create_so, customer_stats, so_pdf

router = APIRouter(prefix="/api/portal", tags=["portal"])


def _f(v):
    return float(v) if v is not None else None


def _customer(db, user: User) -> Optional[Customer]:
    c = db.get(Customer, user.customer_id) if user.customer_id else None
    return c if c is not None and c.org_id == user.org_id else None


def _own_order(db, user: User, oid: int) -> SalesOrder:
    c = _customer(db, user)
    so = db.scalars(select(SalesOrder).where(SalesOrder.id == oid, SalesOrder.org_id == user.org_id).options(selectinload(SalesOrder.lines))).first()
    if not c or not so or so.customer_id != c.id or so.status == "draft":
        raise HTTPException(404, "Order not found")          # same answer for "not yours" and "does not exist"
    return so


def _own_orders_q(db, user: User, *statuses):
    c = _customer(db, user)
    q = select(SalesOrder).where(SalesOrder.org_id == user.org_id, SalesOrder.customer_id == (c.id if c else -1), SalesOrder.status != "draft")
    return q.where(SalesOrder.status.in_(statuses)) if statuses else q


@router.get("/me")
def portal_me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = _customer(db, user)
    return {"id": user.id, "name": user.name, "email": user.email, "phone": user.phone, "role": user.role, "is_admin": is_admin(user),
            "member_since": user.created_at, "last_login": user.last_login,
            "customer": {"code": c.code, "name": c.name, "company": c.company_name, "gstin": c.gstin, "address": c.bill_address, "city": c.bill_city,
                         "state": c.bill_state, "pincode": c.bill_pincode, "payment_terms": c.payment_terms} if c else None}


class ProfileIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=30)
    address: Optional[str] = Field(default=None, max_length=300)
    city: Optional[str] = Field(default=None, max_length=100)
    state: Optional[str] = Field(default=None, max_length=100)
    pincode: Optional[str] = Field(default=None, max_length=10)


@router.patch("/profile")
def update_profile(body: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Edits only the caller's own profile (role, e-mail and permissions cannot be changed here)."""
    c = _customer(db, user)
    if body.name:
        user.name = body.name.strip()
        if c:
            c.name = user.name
    if body.phone is not None:
        user.phone = body.phone.strip() or None
        if c:
            c.phone = user.phone
    if c:
        for f, a in (("address", "bill_address"), ("city", "bill_city"), ("state", "bill_state"), ("pincode", "bill_pincode")):
            v = getattr(body, f)
            if v is not None:
                setattr(c, a, v.strip() or None)
                if a == "bill_address":
                    c.ship_address = c.ship_address or c.bill_address
    audit(db, user, "profile_updated", "user", user.id)
    db.commit()
    return portal_me(user, db)


@router.get("/summary")
def summary(user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = _customer(db, user)
    if not c:
        return {"linked": False}
    st = customer_stats(c.id, user, db)
    recent = db.scalars(_own_orders_q(db, user).order_by(SalesOrder.id.desc()).limit(5)).all()
    ship = db.scalar(select(func.count(Shipment.id)).join(SalesOrder, SalesOrder.id == Shipment.so_id).where(
        SalesOrder.customer_id == c.id, Shipment.status.in_(("ready_to_ship", "shipped", "in_transit", "out_for_delivery", "failed_delivery")))) or 0
    return {"linked": True, "orders": st["orders"], "open_orders": st["open_orders"], "total_purchased": st["total_sales"], "billed": st["billed"], "paid": st["paid"],
            "outstanding": st["outstanding"], "last_order_date": st["last_order_date"], "active_shipments": ship,
            "recent_orders": [{"id": s.id, "number": s.number, "date": s.order_date, "status": s.status, "total": _f(s.total)} for s in recent]}


def _availability(db, org_id):
    rows = db.execute(select(StockBalance.product_id, func.sum(StockBalance.on_hand - StockBalance.reserved)).where(StockBalance.org_id == org_id).group_by(StockBalance.product_id)).all()
    return {r[0]: float(r[1] or 0) for r in rows}


@router.get("/products")
def catalogue(q: Optional[str] = None, availability: Optional[str] = Query(None, pattern="^(in_stock|low_stock|out_of_stock)$"),
              page: int = Query(1, ge=1), page_size: int = Query(24, ge=1, le=100), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Active, non-archived items with selling price and availability. No costs, vendors or warehouse detail."""
    qy = select(Product).where(Product.org_id == user.org_id, Product.is_archived.is_(False), Product.status == "active")
    if q:
        like = f"%{q.lower()}%"
        qy = qy.where(or_(func.lower(Product.name).like(like), func.lower(Product.sku).like(like)))
    rows = db.scalars(qy.order_by(Product.name)).all()
    avail = _availability(db, user.org_id)
    out = []
    for p in rows:
        a = avail.get(p.id, 0.0)
        s = "out_of_stock" if a <= 0 else "low_stock" if p.reorder_point and a <= float(p.reorder_point) else "in_stock"
        if availability and s != availability:
            continue
        out.append({"id": p.id, "sku": p.sku, "name": p.name, "description": p.description, "unit": p.unit, "price": _f(p.selling_price), "tax_rate": _f(p.tax_rate),
                    "available": max(a, 0.0), "availability": s})
    total = len(out)
    return {"total": total, "page": page, "page_size": page_size, "items": out[(page - 1) * page_size: page * page_size]}


@router.get("/orders")
def orders(status: Optional[str] = None, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
           user: User = Depends(current_user), db: Session = Depends(get_db)):
    qy = _own_orders_q(db, user, status) if status else _own_orders_q(db, user)
    total = db.scalar(select(func.count()).select_from(qy.subquery()))
    rows = db.scalars(qy.order_by(SalesOrder.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return {"total": total, "page": page, "page_size": page_size, "items": [
        {"id": s.id, "number": s.number, "date": s.order_date, "expected": s.expected_date, "status": s.status, "total": _f(s.total), "items": len(s.lines)} for s in rows]}


@router.get("/orders/{oid}")
def order_detail(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    so = _own_order(db, user, oid)
    ships = db.scalars(select(Shipment).where(Shipment.so_id == so.id).order_by(Shipment.id)).all()
    return {"id": so.id, "number": so.number, "date": so.order_date, "expected": so.expected_date, "status": so.status, "reference": so.reference,
            "ship_to": so.ship_to, "payment_method": PAYMENT_METHODS.get(so.payment_method or "", None), "subtotal": _f(so.subtotal), "discount": _f(so.discount_total), "tax": _f(so.cgst + so.sgst + so.igst), "shipping": _f(so.shipping_charge), "total": _f(so.total),
            "lines": [{"sku": l.product.sku, "name": l.product.name, "unit": l.product.unit, "quantity": _f(l.quantity), "shipped": _f(l.qty_shipped), "delivered": _f(l.qty_delivered),
                       "rate": _f(l.rate), "amount": _f(l.amount)} for l in so.lines],
            "shipments": [{"number": s.number, "carrier": s.carrier, "tracking_number": s.tracking_number, "status": s.status, "shipped_on": s.shipping_date, "expected_delivery": s.expected_delivery} for s in ships]}


@router.get("/orders/{oid}/invoice.pdf")
def order_invoice(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    so = _own_order(db, user, oid)
    if so.status not in LIVE:
        raise HTTPException(409, "An invoice is available once the order is confirmed")
    audit(db, user, "invoice_downloaded", "sales_order", so.id)
    db.commit()
    return so_pdf(so.id, user, db)


@router.get("/purchase-history")
def purchase_history(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(_own_orders_q(db, user, *LIVE).options(selectinload(SalesOrder.lines)).order_by(SalesOrder.id.desc())).all()
    lines = [{"order_id": s.id, "order": s.number, "date": s.order_date, "status": s.status, "sku": l.product.sku, "name": l.product.name, "quantity": _f(l.quantity),
              "unit": l.product.unit, "rate": _f(l.rate), "amount": _f(l.amount)} for s in rows for l in s.lines]
    return {"total": len(lines), "page": page, "page_size": page_size, "items": lines[(page - 1) * page_size: page * page_size],
            "total_spent": round(sum(x["amount"] for x in lines), 2)}


@router.get("/invoices")
def invoices(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """StockPilot keeps no separate invoice entity: a confirmed order's tax document (GST breakdown) is the invoice."""
    rows = db.scalars(_own_orders_q(db, user, *LIVE).order_by(SalesOrder.id.desc())).all()
    return [{"id": s.id, "number": s.number, "date": s.order_date, "status": s.status, "taxable": _f(s.taxable_total), "tax": _f(s.cgst + s.sgst + s.igst), "total": _f(s.total)} for s in rows]


@router.get("/payments")
def payments(user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = _customer(db, user)
    if not c:
        return {"items": [], "paid": 0, "outstanding": 0}
    rows = db.scalars(select(Payment).where(Payment.org_id == user.org_id, Payment.party_type == "customer", Payment.party_id == c.id).order_by(Payment.id.desc())).all()
    st = customer_stats(c.id, user, db)
    return {"items": [{"number": p.number, "date": p.paid_on, "amount": _f(p.amount), "method": p.method, "reference": p.reference, "status": p.status} for p in rows],
            "paid": st["paid"], "billed": st["billed"], "outstanding": st["outstanding"]}


class TicketIn(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    message: str = Field(min_length=5, max_length=2000)


@router.get("/support")
def my_tickets(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(SupportTicket).where(SupportTicket.user_id == user.id).order_by(SupportTicket.id.desc())).all()
    return [{"id": t.id, "subject": t.subject, "message": t.message, "status": t.status, "reply": t.reply, "created_at": t.created_at, "replied_at": t.replied_at} for t in rows]


@router.post("/support", status_code=201)
def new_ticket(body: TicketIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = SupportTicket(org_id=user.org_id, user_id=user.id, subject=body.subject.strip(), message=body.message.strip())
    db.add(t)
    db.flush()
    audit(db, user, "support_ticket_created", "support_ticket", t.id)
    db.commit()
    return {"id": t.id}


# ---------------------------------------------------------------- buying
class CartLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0, le=Decimal("10000"))


PAYMENT_METHODS = {"cod": "Cash on delivery", "bank_transfer": "Bank transfer (NEFT / IMPS / UPI to our account)", "on_account": "Pay later on invoice (your payment terms)"}


class Delivery(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(pattern=r"^\+?[\d][\d\s-]{7,14}$")
    address: str = Field(min_length=5, max_length=200)
    city: str = Field(min_length=2, max_length=100)
    state: str = Field(min_length=2, max_length=100)
    pincode: str = Field(pattern=r"^\d{6}$")


class PlaceOrderIn(BaseModel):
    items: list[CartLine] = Field(min_length=1, max_length=50)
    delivery: Delivery                                         # a delivery address is mandatory
    payment_method: str = Field(pattern="^(cod|bank_transfer|on_account)$")
    save_address: bool = False                                 # remember it as the customer's default delivery address
    notes: Optional[str] = Field(default=None, max_length=300)
    client_key: Optional[str] = Field(default=None, min_length=8, max_length=60)   # makes a double-click / retry safe


@router.get("/payment-options")
def payment_options(user: User = Depends(current_user)):
    """What a customer can choose at checkout. Online card/UPI/net-banking is not connected, and is reported as such."""
    return {"options": [{"key": "cod", "label": PAYMENT_METHODS["cod"], "available": True, "hint": "Pay the delivery person in cash (or UPI) when the goods arrive."},
                        {"key": "bank_transfer", "label": PAYMENT_METHODS["bank_transfer"], "available": True, "hint": "Pay by bank transfer quoting the order number. Ask Support for our account details; the order ships once the payment is recorded."},
                        {"key": "on_account", "label": PAYMENT_METHODS["on_account"], "available": True, "hint": "We invoice you and you pay within your agreed payment terms."},
                        {"key": "online", "label": "Card / UPI / Net banking", "available": False, "hint": "Online payment is not connected yet."}]}


@router.post("/orders", status_code=201)
def place_order(body: PlaceOrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Buy available products. Prices come from the item master (never from the client). Stock is reserved at once,
    split across warehouses when no single one holds enough; if any line cannot be covered nothing is ordered."""
    c = _customer(db, user)
    if not c or c.status != "active":
        raise HTTPException(409, "Your account is not linked to an active customer record. Please contact support.")
    ref = f"WEB-{body.client_key}" if body.client_key else None
    if ref:
        prev = db.scalars(select(SalesOrder).where(SalesOrder.org_id == user.org_id, SalesOrder.customer_id == c.id, SalesOrder.reference == ref)).first()
        if prev:
            return {"id": prev.id, "number": prev.number, "status": prev.status, "total": _f(prev.total), "duplicate": True}
    wanted: dict[int, Decimal] = {}
    for l in body.items:
        wanted[l.product_id] = wanted.get(l.product_id, Decimal(0)) + l.quantity
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.org_id == user.org_id, Product.id.in_(list(wanted))))}
    lines: list[SOLineIn] = []
    for pid, qty in wanted.items():
        p = prods.get(pid)
        if not p or p.is_archived or p.status != "active":
            raise HTTPException(422, "One of the items is no longer available" if not p else f"{p.name} is no longer available")
        bal = db.execute(select(StockBalance.warehouse_id, StockBalance.on_hand - StockBalance.reserved).where(
            StockBalance.org_id == user.org_id, StockBalance.product_id == pid, StockBalance.on_hand - StockBalance.reserved > 0)
            .order_by((StockBalance.on_hand - StockBalance.reserved).desc())).all()
        have = sum((Decimal(b[1]) for b in bal), Decimal(0))
        if have < qty:
            raise HTTPException(409, f"{p.name}: only {have:g} {p.unit} available, you asked for {qty:g}")
        left = qty
        for wid, free in bal:
            take = min(left, Decimal(free))
            if take > 0:
                lines.append(SOLineIn(product_id=pid, quantity=take, warehouse_id=wid))
                left -= take
            if left <= 0:
                break
    dv = body.delivery
    saved = (c.ship_address, c.ship_city, c.ship_state, c.ship_pincode)
    c.ship_address, c.ship_city, c.ship_state, c.ship_pincode = dv.address.strip(), dv.city.strip(), dv.state.strip(), dv.pincode   # GST place of supply = delivery state
    order_in = SOIn(customer_id=c.id, warehouse_id=lines[0].warehouse_id, reference=ref or "WEB", notes=body.notes, lines=lines)
    so = create_so(order_in, user, db)
    sid = so["id"]
    placed0 = db.get(SalesOrder, sid)
    placed0.ship_to = f"{dv.name.strip()}, {dv.address.strip()}, {dv.city.strip()}, {dv.state.strip()} - {dv.pincode}. Phone: {dv.phone.strip()}"
    placed0.payment_method = body.payment_method
    if not body.save_address:
        c.ship_address, c.ship_city, c.ship_state, c.ship_pincode = saved
    db.commit()
    try:
        confirm_so(sid, False, user, db)
    except HTTPException:
        db.rollback()
        draft = db.get(SalesOrder, sid)       # nothing half-placed is left behind
        if draft is not None and draft.status == "draft":
            db.delete(draft)
            db.commit()
        raise
    placed = db.get(SalesOrder, sid)
    audit(db, user, "portal_order_placed", "sales_order", sid, {"number": placed.number, "total": str(placed.total), "lines": len(lines)})
    db.commit()
    return {"id": placed.id, "number": placed.number, "status": placed.status, "total": _f(placed.total), "payment_method": body.payment_method, "duplicate": False}

"""Sales orders and customer financials.

Stock rules (all through the shared stock service, so everything is in the ledger):
  * Confirming an order RESERVES stock per line (atomic: concurrent orders can never reserve the same units).
  * Cancelling before anything ships RELEASES the reservation.
  * Stock is DEDUCTED only when goods are shipped (see fulfilment_api): one movement lowers on-hand and the reservation.
  * Delivery changes no stock.
"""
import csv
import io
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from . import stock as stk
from . import whlogic as whl
from .api import audit, org_of, require
from .core import can, get_db, now
from .models import (AuditLog, Customer, Payment, Product, SalesOrder, SalesOrderLine, User, Warehouse)
from .pdfdoc import build_pdf, inr
from .sequences import next_number
from .tax import document_totals, gst_mode, line_amounts, q2

router = APIRouter(prefix="/api")
D = Decimal
STATUSES = ("draft", "confirmed", "packed", "shipped", "delivered", "cancelled")
LIVE = ("confirmed", "packed", "shipped", "delivered")


class SOLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0, le=D("1000000"))
    rate: Optional[Decimal] = Field(default=None, ge=0, le=D("100000000"))
    discount_pct: Decimal = Field(default=D(0), ge=0, le=100)
    tax_rate: Optional[Decimal] = Field(default=None, ge=0, le=100)
    warehouse_id: Optional[int] = None  # defaults to the order's warehouse


class SOIn(BaseModel):
    customer_id: int
    warehouse_id: int
    order_date: Optional[date] = None
    expected_date: Optional[date] = None
    reference: Optional[str] = Field(default=None, max_length=60)
    notes: Optional[str] = Field(default=None, max_length=500)
    shipping_charge: Decimal = Field(default=D(0), ge=0, le=D("10000000"))
    lines: list[SOLineIn] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _dates(self):
        if self.order_date and self.expected_date and self.expected_date < self.order_date:
            raise ValueError("Expected delivery can't be before the order date")
        return self


def _f(x):
    return float(x) if x is not None else None


def _so(db, user, sid, lock=False) -> SalesOrder:
    stmt = select(SalesOrder).where(SalesOrder.id == sid, SalesOrder.org_id == user.org_id)
    if lock:
        stmt = stmt.with_for_update()
    so = db.scalars(stmt).first()
    if not so:
        raise HTTPException(404, "Sales order not found")
    return so


def _addr(parts) -> Optional[str]:
    s = ", ".join(x for x in parts if x)
    return s or None


def _apply_lines(db, user, so: SalesOrder, body: SOIn):
    cust = db.get(Customer, body.customer_id)
    if not cust or cust.org_id != user.org_id:
        raise HTTPException(422, "Unknown customer")
    whs = {w.id: w for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    if body.warehouse_id not in whs:
        raise HTTPException(422, "Unknown warehouse")
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.org_id == user.org_id, Product.id.in_({l.product_id for l in body.lines})))}
    built, calcs = [], []
    for i, l in enumerate(body.lines, start=1):
        p = prods.get(l.product_id)
        if not p:
            raise HTTPException(422, f"Line {i}: unknown item")
        if p.is_archived or p.status != "active":
            raise HTTPException(422, f"Line {i}: {p.name} is {'archived' if p.is_archived else 'inactive'} and can't be sold")
        wid = l.warehouse_id or body.warehouse_id
        if wid not in whs:
            raise HTTPException(422, f"Line {i}: unknown warehouse")
        rate = l.rate if l.rate is not None else p.selling_price  # price is fetched from the item unless overridden
        tax = l.tax_rate if l.tax_rate is not None else p.tax_rate
        a = line_amounts(l.quantity, rate, l.discount_pct, tax)
        calcs.append(a)
        built.append(SalesOrderLine(product_id=p.id, warehouse_id=wid, quantity=l.quantity, rate=rate, discount_pct=l.discount_pct,
                                    tax_rate=tax, discount_amount=a["discount"], taxable=a["taxable"], tax_amount=a["tax"], amount=a["amount"]))
    org = org_of(db, user)
    so.customer_id, so.warehouse_id = cust.id, body.warehouse_id
    so.order_date, so.expected_date = body.order_date or date.today(), body.expected_date
    so.reference, so.notes, so.shipping_charge = body.reference, body.notes, q2(body.shipping_charge)
    so.bill_to = _addr([cust.name, cust.bill_address, cust.bill_city, cust.bill_state, cust.bill_pincode])
    so.ship_to = _addr([cust.name, cust.ship_address or cust.bill_address, cust.ship_city or cust.bill_city, cust.ship_state or cust.bill_state, cust.ship_pincode or cust.bill_pincode])
    so.gst_mode = gst_mode(org, cust.gstin, cust.ship_state or cust.bill_state)
    for k, v in document_totals(calcs, so.gst_mode, so.shipping_charge).items():
        setattr(so, k, v)
    so.lines.clear()
    db.flush()
    so.lines.extend(built)


def refresh_status(so: SalesOrder):
    """Derives the order status from fulfilment progress (never moves draft/cancelled)."""
    if so.status in ("draft", "cancelled") or not so.lines:
        return
    if all(l.qty_delivered >= l.quantity for l in so.lines):
        so.status = "delivered"
    elif all(l.qty_shipped >= l.quantity for l in so.lines):
        so.status = "shipped"
    elif all(l.qty_packed >= l.quantity for l in so.lines):
        so.status = "packed"
    else:
        so.status = "confirmed"


def _line_out(l: SalesOrderLine, names: dict):
    return {"id": l.id, "product_id": l.product_id, "sku": l.product.sku, "name": l.product.name, "unit": l.product.unit,
            "hsn_code": l.product.hsn_code, "warehouse_id": l.warehouse_id, "warehouse": names.get(l.warehouse_id),
            "quantity": _f(l.quantity), "qty_packed": _f(l.qty_packed), "qty_shipped": _f(l.qty_shipped),
            "qty_delivered": _f(l.qty_delivered), "unpacked": _f(l.quantity - l.qty_packed), "rate": _f(l.rate),
            "discount_pct": _f(l.discount_pct), "tax_rate": _f(l.tax_rate), "discount_amount": _f(l.discount_amount),
            "taxable": _f(l.taxable), "tax_amount": _f(l.tax_amount), "amount": _f(l.amount)}


def _so_out(so: SalesOrder, names: dict, detail=False):
    q = sum((l.quantity for l in so.lines), D(0))
    pct = lambda attr: round(float(sum((getattr(l, attr) for l in so.lines), D(0)) / q * 100), 1) if q else 0  # noqa: E731
    out = {"id": so.id, "number": so.number, "status": so.status, "customer_id": so.customer_id, "customer": so.customer.name,
           "customer_code": so.customer.code, "warehouse_id": so.warehouse_id, "warehouse": names.get(so.warehouse_id), "order_date": so.order_date,
           "expected_date": so.expected_date, "reference": so.reference, "payment_method": so.payment_method, "notes": so.notes, "gst_mode": so.gst_mode,
           "subtotal": _f(so.subtotal), "discount_total": _f(so.discount_total), "taxable_total": _f(so.taxable_total), "cgst": _f(so.cgst),
           "sgst": _f(so.sgst), "igst": _f(so.igst), "shipping_charge": _f(so.shipping_charge), "total": _f(so.total),
           "item_count": len(so.lines), "packed_pct": pct("qty_packed"), "shipped_pct": pct("qty_shipped"), "delivered_pct": pct("qty_delivered"),
           "overdue": bool(so.expected_date and so.expected_date < date.today() and so.status in ("confirmed", "packed", "shipped")),
           "confirmed_at": so.confirmed_at, "created_at": so.created_at, "credit_override": so.credit_override}
    if detail:
        out["lines"] = [_line_out(l, names) for l in so.lines]
        out["bill_to"], out["ship_to"] = so.bill_to, so.ship_to
        out["customer_info"] = {"gstin": so.customer.gstin, "email": so.customer.email, "phone": so.customer.phone,
                                "payment_terms": so.customer.payment_terms, "credit_limit": _f(so.customer.credit_limit)}
    return out


def _names(db, org_id):
    return {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == org_id))}


# ------------------------------------------------------------ customer money
def _shipped_value(so: SalesOrder) -> Decimal:
    """Value billed so far: shipped share of each line plus shipping charge in proportion to goods shipped."""
    lines_total = sum((l.amount for l in so.lines), D(0))
    got = sum((q2(l.amount * l.qty_shipped / l.quantity) for l in so.lines), D(0))
    ship = q2(so.shipping_charge * got / lines_total) if lines_total else D(0)
    return got + ship


def customer_receivable(db, org_id, customer_id) -> Decimal:
    sos = db.scalars(select(SalesOrder).where(SalesOrder.org_id == org_id, SalesOrder.customer_id == customer_id,
                                              SalesOrder.status.in_(LIVE)).options(selectinload(SalesOrder.lines))).all()
    return sum((_shipped_value(s) for s in sos), D(0))


def _paid(db, org_id, customer_id) -> Decimal:
    return D(db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.org_id == org_id, Payment.party_type == "customer", Payment.party_id == customer_id, Payment.status == "posted")))


def customer_exposure(db, org_id, customer_id, exclude_id=None) -> Decimal:
    """Unpaid billed amount + value of open orders not yet shipped (what the customer could owe us)."""
    sos = db.scalars(select(SalesOrder).where(SalesOrder.org_id == org_id, SalesOrder.customer_id == customer_id,
                                              SalesOrder.status.in_(LIVE)).options(selectinload(SalesOrder.lines))).all()
    unbilled = sum((s.total - _shipped_value(s) for s in sos if s.id != exclude_id and s.status in ("confirmed", "packed")), D(0))
    return customer_receivable(db, org_id, customer_id) - _paid(db, org_id, customer_id) + unbilled


# ------------------------------------------------------------ list / create / read
SORTS = {"number": SalesOrder.number, "order_date": SalesOrder.order_date, "expected_date": SalesOrder.expected_date,
         "total": SalesOrder.total, "status": SalesOrder.status}


@router.get("/sales-orders", tags=["sales-orders"])
def list_sos(q: Optional[str] = None, status: str = "all", customer_id: Optional[int] = None, warehouse_id: Optional[int] = None,
             date_from: Optional[date] = None, date_to: Optional[date] = None, sort: str = "order_date", desc: bool = True,
             page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200), user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    """status: all | open (confirmed + packed + shipped) | draft | confirmed | packed | shipped | delivered | cancelled."""
    stmt = select(SalesOrder).where(SalesOrder.org_id == user.org_id).join(Customer, Customer.id == SalesOrder.customer_id)
    if status == "open":
        stmt = stmt.where(SalesOrder.status.in_(("confirmed", "packed", "shipped")))
    elif status in STATUSES:
        stmt = stmt.where(SalesOrder.status == status)
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    if warehouse_id:
        stmt = stmt.where(SalesOrder.warehouse_id == warehouse_id)
    if date_from:
        stmt = stmt.where(SalesOrder.order_date >= date_from)
    if date_to:
        stmt = stmt.where(SalesOrder.order_date <= date_to)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(SalesOrder.number.ilike(like), SalesOrder.reference.ilike(like), Customer.name.ilike(like)))
    col = SORTS.get(sort, SalesOrder.order_date)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(SalesOrder.lines), selectinload(SalesOrder.customer)).order_by(
        col.desc() if desc else col.asc(), SalesOrder.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    summary = db.execute(select(SalesOrder.status, func.count(), func.coalesce(func.sum(SalesOrder.total), 0))
                         .where(SalesOrder.org_id == user.org_id).group_by(SalesOrder.status)).all()
    names = _names(db, user.org_id)
    return {"total": total, "page": page, "page_size": page_size, "items": [_so_out(s, names) for s in rows],
            "counts": {s: {"count": c, "value": float(v)} for s, c, v in summary}}


@router.post("/sales-orders", tags=["sales-orders"], status_code=201)
def create_so(body: SOIn, user: User = Depends(require("sales", "w")), db: Session = Depends(get_db)):
    so = SalesOrder(org_id=user.org_id, number=next_number(db, user.org_id, "SO"), status="draft", created_by=user.id,
                    customer_id=body.customer_id, warehouse_id=body.warehouse_id, order_date=body.order_date or date.today())
    db.add(so)
    _apply_lines(db, user, so, body)
    db.flush()
    audit(db, user, "create", "sales_order", so.id, {"number": so.number, "total": str(so.total)})
    db.commit()
    return _so_out(so, _names(db, user.org_id), True)


@router.get("/sales-orders-export.csv", tags=["sales-orders"])
def export_sos(user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["number", "date", "customer", "status", "expected", "subtotal", "discount", "taxable", "cgst", "sgst", "igst", "shipping", "total", "shipped_pct", "delivered_pct"])
    names = _names(db, user.org_id)
    for s in db.scalars(select(SalesOrder).where(SalesOrder.org_id == user.org_id).options(selectinload(SalesOrder.lines), selectinload(SalesOrder.customer)).order_by(SalesOrder.id)):
        o = _so_out(s, names)
        w.writerow([o["number"], o["order_date"], o["customer"], o["status"], o["expected_date"] or "", o["subtotal"], o["discount_total"], o["taxable_total"],
                    o["cgst"], o["sgst"], o["igst"], o["shipping_charge"], o["total"], o["shipped_pct"], o["delivered_pct"]])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=sales-orders.csv"})


@router.get("/sales-orders/{sid}", tags=["sales-orders"])
def get_so(sid: int, user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    so = _so(db, user, sid)
    names = _names(db, user.org_id)
    out = _so_out(so, names, True)
    from .models import StockBalance
    bal = {(b.product_id, b.warehouse_id): float(b.on_hand - b.reserved) for b in db.scalars(select(StockBalance).where(
        StockBalance.org_id == user.org_id, StockBalance.product_id.in_({l.product_id for l in so.lines} or {0})))}
    for l in out["lines"]:
        l["available"] = bal.get((l["product_id"], l["warehouse_id"]), 0.0)
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    logs = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id, AuditLog.entity == "sales_order", AuditLog.entity_id == str(sid)).order_by(AuditLog.id.desc())).all()
    out["activity"] = [{"when": a.created_at, "user": users.get(a.user_id), "action": a.action, "detail": a.detail} for a in logs]
    out["created_by"] = users.get(so.created_by)
    from .fulfilment_api import so_fulfilment
    out["packages"] = so_fulfilment(db, so, names)
    return out


# ------------------------------------------------------------ lifecycle
@router.put("/sales-orders/{sid}", tags=["sales-orders"])
def update_so(sid: int, body: SOIn, user: User = Depends(require("sales", "w")), db: Session = Depends(get_db)):
    so = _so(db, user, sid, lock=True)
    if so.status != "draft":
        raise HTTPException(409, "Only draft sales orders can be edited")
    _apply_lines(db, user, so, body)
    audit(db, user, "update", "sales_order", sid, {"total": str(so.total)})
    db.commit()
    return _so_out(so, _names(db, user.org_id), True)


@router.post("/sales-orders/{sid}/confirm", tags=["sales-orders"])
def confirm_so(sid: int, override_credit: bool = False, user: User = Depends(require("sales", "w")), db: Session = Depends(get_db)):
    """Reserves stock for every line. All-or-nothing: if any line can't be covered, nothing is reserved."""
    so = _so(db, user, sid, lock=True)
    if so.status != "draft":
        raise HTTPException(409, f"Sales order is already {so.status}")
    cust = so.customer
    if cust.status != "active":
        raise HTTPException(422, "Customer is inactive")
    bad = [l.product.name for l in so.lines if l.product.is_archived or l.product.status != "active"]
    if bad:
        raise HTTPException(422, f"These items are no longer active: {', '.join(bad)}")
    limit = cust.credit_limit or D(0)
    if limit > 0:
        exposure = customer_exposure(db, user.org_id, cust.id, exclude_id=so.id) + so.total
        if exposure > limit:
            if not override_credit:
                raise HTTPException(409, f"Credit limit exceeded: {cust.name}'s exposure would be INR {exposure:,.2f} against a limit of INR {limit:,.2f}. A manager can confirm with a credit override.")
            if user.role not in ("owner", "admin", "manager"):
                raise HTTPException(403, "Only a manager, admin or owner can override a credit limit")
            so.credit_override = True
    org = org_of(db, user)
    for l in so.lines:
        try:
            stk.apply_movement(db, org, product_id=l.product_id, warehouse_id=l.warehouse_id, type="reserve", reserved_delta=l.quantity,
                               ref_type="SO", ref_id=so.id, reason=f"Reserved for {so.number}", user_id=user.id,
                               idempotency_key=f"reserve:SO:{so.id}:{l.id}")
        except stk.StockError as e:
            db.rollback()
            raise HTTPException(e.status, f"Can't confirm {so.number}: {e}")
    so.status, so.confirmed_at = "confirmed", now()
    audit(db, user, "confirm", "sales_order", sid, {"number": so.number, "credit_override": so.credit_override})
    db.commit()
    return _so_out(so, _names(db, user.org_id), True)


def release_reservations(db, org, user, so: SalesOrder):
    for l in so.lines:
        held = l.quantity - l.qty_shipped
        if held > 0:
            stk.apply_movement(db, org, product_id=l.product_id, warehouse_id=l.warehouse_id, type="release", reserved_delta=-held,
                               ref_type="SO", ref_id=so.id, reason=f"Released: {so.number} cancelled", user_id=user.id,
                               idempotency_key=f"release:SO:{so.id}:{l.id}")


@router.post("/sales-orders/{sid}/cancel", tags=["sales-orders"])
def cancel_so(sid: int, user: User = Depends(require("sales", "w")), db: Session = Depends(get_db)):
    so = _so(db, user, sid, lock=True)
    if so.status == "cancelled":
        raise HTTPException(409, "Sales order is already cancelled")
    if so.status in ("shipped", "delivered") or any(l.qty_shipped > 0 for l in so.lines):
        raise HTTPException(409, "Goods have already shipped, so the order can't be cancelled")
    if so.status in ("confirmed", "packed"):
        try:
            release_reservations(db, org_of(db, user), user, so)
        except stk.StockError as e:
            db.rollback()
            raise HTTPException(e.status, str(e))
        from .fulfilment_api import void_open_packages  # packages not yet shipped are voided with the order
        void_open_packages(db, so)
    so.status, so.cancelled_at = "cancelled", now()
    for l in so.lines:
        l.qty_packed = 0
    audit(db, user, "cancel", "sales_order", sid, {"number": so.number})
    db.commit()
    return _so_out(so, _names(db, user.org_id), True)


@router.delete("/sales-orders/{sid}", tags=["sales-orders"], status_code=204)
def delete_so(sid: int, user: User = Depends(require("sales", "w")), db: Session = Depends(get_db)):
    so = _so(db, user, sid, lock=True)
    if so.status != "draft":
        raise HTTPException(409, "Only draft sales orders can be deleted; cancel it instead")
    audit(db, user, "delete", "sales_order", sid, {"number": so.number})
    db.delete(so)
    db.commit()


@router.get("/sales-orders/{sid}/pdf", tags=["sales-orders"])
def so_pdf(sid: int, user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    so = _so(db, user, sid)
    org, c = org_of(db, user), so.customer
    wh = db.get(Warehouse, so.warehouse_id)
    rows = [[i, f"{l.product.name}\n{l.product.sku}", l.product.hsn_code or "", f"{l.quantity:g} {l.product.unit}", inr(l.rate),
             f"{l.discount_pct:g}%" if l.discount_pct else "-", f"{l.tax_rate:g}%", inr(l.amount)] for i, l in enumerate(so.lines, start=1)]
    totals = [("Subtotal", inr(so.subtotal))]
    if so.discount_total:
        totals.append(("Discount", "-" + inr(so.discount_total)))
    totals.append(("Taxable amount", inr(so.taxable_total)))
    totals += [("IGST", inr(so.igst))] if so.gst_mode == "inter" else [("CGST", inr(so.cgst)), ("SGST", inr(so.sgst))]
    if so.shipping_charge:
        totals.append(("Shipping", inr(so.shipping_charge)))
    totals.append(("Total", inr(so.total)))
    pdf = build_pdf(title="Sales Order", org={"name": org.name, "gstin": org.gstin, "state": org.state, "address": org.address},
                    meta=[("Order number", so.number), ("Date", str(so.order_date)), ("Delivery by", str(so.expected_date or "-")), ("Reference", so.reference or "-"),
                          ("Status", so.status.title()), ("Ships from", f"{wh.code} {wh.name}" if wh else "-")],
                    parties=[("BILL TO", (so.bill_to or c.name).split(", ") + ([f"GSTIN: {c.gstin}"] if c.gstin else [])), ("SHIP TO", (so.ship_to or c.name).split(", "))],
                    columns=["#", "Item", "HSN", "Qty", "Rate", "Disc.", "GST", "Amount"], rows=rows, col_widths=[8, 62, 18, 24, 26, 14, 14, 26], right_cols=(3, 4, 5, 6, 7),
                    totals=totals, notes=so.notes, footer=f"{so.number} - {'IGST (inter-state)' if so.gst_mode == 'inter' else 'CGST + SGST (intra-state)'} - "
                                                             f"Payment terms: {'due on receipt' if c.payment_terms == 0 else f'Net {c.payment_terms} days'}")
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{so.number}.pdf"'})


# ------------------------------------------------------------ customer financials
@router.get("/customers/{cid}/stats", tags=["customers"])
def customer_stats(cid: int, user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    c = db.get(Customer, cid)
    if not c or c.org_id != user.org_id:
        raise HTTPException(404, "Customer not found")
    sos = db.scalars(select(SalesOrder).where(SalesOrder.org_id == user.org_id, SalesOrder.customer_id == cid).options(selectinload(SalesOrder.lines))).all()
    live = [s for s in sos if s.status in LIVE]
    billed, paid = customer_receivable(db, user.org_id, cid), _paid(db, user.org_id, cid)
    top: dict = {}
    for s in live:
        for l in s.lines:
            t = top.setdefault(l.product_id, {"product_id": l.product_id, "name": l.product.name, "sku": l.product.sku, "quantity": D(0), "amount": D(0)})
            t["quantity"] += l.quantity
            t["amount"] += l.amount
    limit = c.credit_limit or D(0)
    exposure = customer_exposure(db, user.org_id, cid)
    return {"orders": len(sos), "open_orders": sum(1 for s in sos if s.status in ("confirmed", "packed", "shipped")),
            "total_sales": _f(sum((s.total for s in live), D(0))), "billed": _f(billed), "paid": _f(paid), "outstanding": _f(billed - paid),
            "avg_order_value": _f(q2(sum((s.total for s in live), D(0)) / len(live))) if live else None,
            "last_order_date": max((s.order_date for s in live), default=None), "credit_limit": _f(limit), "exposure": _f(exposure),
            "credit_used_pct": round(float(exposure / limit * 100), 1) if limit > 0 else None,
            "top_items": [{**t, "quantity": _f(t["quantity"]), "amount": _f(t["amount"])} for t in sorted(top.values(), key=lambda x: -x["amount"])[:5]]}


@router.get("/customers/{cid}/transactions", tags=["customers"])
def customer_transactions(cid: int, user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    c = db.get(Customer, cid)
    if not c or c.org_id != user.org_id:
        raise HTTPException(404, "Customer not found")
    ev = []
    for s in db.scalars(select(SalesOrder).where(SalesOrder.org_id == user.org_id, SalesOrder.customer_id == cid)):
        ev.append({"kind": "sales_order", "id": s.id, "number": s.number, "date": s.order_date, "status": s.status, "amount": _f(s.total), "when": s.created_at})
    for p in db.scalars(select(Payment).where(Payment.org_id == user.org_id, Payment.party_type == "customer", Payment.party_id == cid)):
        ev.append({"kind": "payment", "id": p.id, "number": p.number, "date": p.paid_on, "status": p.status, "amount": _f(-p.amount), "when": p.created_at, "method": p.method, "reference": p.reference})
    from .fulfilment_api import shipment_events
    ev += shipment_events(db, user.org_id, cid)
    ev.sort(key=lambda e: whl.aware(e["when"]), reverse=True)
    return ev


@router.get("/products/{pid}/sales-transactions", tags=["products"])
def product_sales_transactions(pid: int, user: User = Depends(require("sales")), db: Session = Depends(get_db)):
    p = db.get(Product, pid)
    if not p or p.org_id != user.org_id:
        raise HTTPException(404, "Product not found")
    rows = db.execute(select(SalesOrderLine, SalesOrder, Customer).join(SalesOrder, SalesOrder.id == SalesOrderLine.so_id)
                      .join(Customer, Customer.id == SalesOrder.customer_id).where(SalesOrderLine.product_id == pid, SalesOrder.org_id == user.org_id)
                      .order_by(SalesOrder.id.desc()).limit(100)).all()
    return [{"so_id": so.id, "number": so.number, "date": so.order_date, "customer": c.name, "customer_id": c.id, "status": so.status,
             "quantity": _f(l.quantity), "shipped": _f(l.qty_shipped), "rate": _f(l.rate), "amount": _f(l.amount)} for l, so, c in rows]

"""Purchasing: purchase orders, goods receipts (partial deliveries), PDFs, reorder suggestions, vendor financials.

Stock rule: stock changes ONLY when goods are received (POST /purchase-orders/{id}/receive), through the shared
stock service, so every receipt is an auditable ledger movement and over-receipt is impossible.
"""
import csv
import io
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import stock as stk
from . import whlogic as whl
from .api import audit, current_user, org_of, require
from .core import can, get_db, now
from .models import (AuditLog, GoodsReceipt, GoodsReceiptLine, Payment, Product, PurchaseOrder, PurchaseOrderLine, User,
                     Vendor, Warehouse)
from .pdfdoc import build_pdf, inr
from .sequences import next_number
from .tax import document_totals, gst_mode, line_amounts, q2

router = APIRouter(prefix="/api")
D = Decimal
OPEN = ("issued", "partially_received")
STATUSES = ("draft", "issued", "partially_received", "received", "cancelled")


# ---------------------------------------------------------------- schemas
class POLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0, le=D("1000000"))
    rate: Optional[Decimal] = Field(default=None, ge=0, le=D("100000000"))
    discount_pct: Decimal = Field(default=D(0), ge=0, le=100)
    tax_rate: Optional[Decimal] = Field(default=None, ge=0, le=100)


class POIn(BaseModel):
    vendor_id: int
    warehouse_id: int
    order_date: Optional[date] = None
    expected_date: Optional[date] = None
    reference: Optional[str] = Field(default=None, max_length=60)
    notes: Optional[str] = Field(default=None, max_length=500)
    lines: list[POLineIn] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _dates(self):
        if self.order_date and self.expected_date and self.expected_date < self.order_date:
            raise ValueError("Expected delivery can't be before the order date")
        return self


class ReceiveLine(BaseModel):
    po_line_id: int
    quantity: Decimal = Field(gt=0)


class ReceiveIn(BaseModel):
    warehouse_id: int
    received_on: Optional[date] = None
    notes: Optional[str] = Field(default=None, max_length=300)
    idempotency_key: Optional[str] = Field(default=None, max_length=80)
    lines: list[ReceiveLine] = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------- helpers
def _f(x):
    return float(x) if x is not None else None


def _po(db, user, pid, lock=False) -> PurchaseOrder:
    stmt = select(PurchaseOrder).where(PurchaseOrder.id == pid, PurchaseOrder.org_id == user.org_id)
    if lock:
        stmt = stmt.with_for_update()  # serialises concurrent state changes on PostgreSQL
    po = db.scalars(stmt).first()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    return po


def _apply_lines(db, user, po: PurchaseOrder, body: POIn):
    """Validates vendor/warehouse/items and (re)builds lines + totals from server-side prices and tax."""
    vendor = db.get(Vendor, body.vendor_id)
    if not vendor or vendor.org_id != user.org_id:
        raise HTTPException(422, "Unknown vendor")
    wh = db.get(Warehouse, body.warehouse_id)
    if not wh or wh.org_id != user.org_id:
        raise HTTPException(422, "Unknown warehouse")
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.org_id == user.org_id,
                                                               Product.id.in_({l.product_id for l in body.lines})))}
    built, calcs = [], []
    for i, l in enumerate(body.lines, start=1):
        p = prods.get(l.product_id)
        if not p:
            raise HTTPException(422, f"Line {i}: unknown item")
        if p.is_archived or p.status != "active":
            raise HTTPException(422, f"Line {i}: {p.name} is {'archived' if p.is_archived else 'inactive'} and can't be ordered")
        rate = l.rate if l.rate is not None else p.purchase_price
        tax = l.tax_rate if l.tax_rate is not None else p.tax_rate
        a = line_amounts(l.quantity, rate, l.discount_pct, tax)
        calcs.append(a)
        built.append(PurchaseOrderLine(product_id=p.id, quantity=l.quantity, rate=rate, discount_pct=l.discount_pct,
                                       tax_rate=tax, discount_amount=a["discount"], taxable=a["taxable"],
                                       tax_amount=a["tax"], amount=a["amount"]))
    org = org_of(db, user)
    po.vendor_id, po.warehouse_id = vendor.id, wh.id
    po.order_date = body.order_date or date.today()
    po.expected_date, po.reference, po.notes = body.expected_date, body.reference, body.notes
    po.gst_mode = gst_mode(org, vendor.gstin, vendor.bill_state)
    for k, v in document_totals(calcs, po.gst_mode).items():
        setattr(po, k, v)
    po.lines.clear()
    db.flush()
    po.lines.extend(built)


def _line_out(l: PurchaseOrderLine):
    return {"id": l.id, "product_id": l.product_id, "sku": l.product.sku, "name": l.product.name, "unit": l.product.unit,
            "hsn_code": l.product.hsn_code, "quantity": _f(l.quantity), "qty_received": _f(l.qty_received),
            "outstanding": _f(l.quantity - l.qty_received), "rate": _f(l.rate), "discount_pct": _f(l.discount_pct),
            "tax_rate": _f(l.tax_rate), "discount_amount": _f(l.discount_amount), "taxable": _f(l.taxable),
            "tax_amount": _f(l.tax_amount), "amount": _f(l.amount)}


def _po_out(po: PurchaseOrder, detail=False):
    ordered = sum((l.quantity for l in po.lines), D(0))
    got = sum((l.qty_received for l in po.lines), D(0))
    out = {"id": po.id, "number": po.number, "status": po.status, "vendor_id": po.vendor_id, "vendor": po.vendor.name,
           "vendor_code": po.vendor.code, "warehouse_id": po.warehouse_id, "order_date": po.order_date,
           "expected_date": po.expected_date, "reference": po.reference, "notes": po.notes, "gst_mode": po.gst_mode,
           "subtotal": _f(po.subtotal), "discount_total": _f(po.discount_total), "taxable_total": _f(po.taxable_total),
           "cgst": _f(po.cgst), "sgst": _f(po.sgst), "igst": _f(po.igst), "total": _f(po.total), "item_count": len(po.lines),
           "received_pct": round(float(got / ordered * 100), 1) if ordered else 0, "issued_at": po.issued_at,
           "created_at": po.created_at, "overdue": bool(po.expected_date and po.expected_date < date.today() and po.status in OPEN)}
    if detail:
        out["lines"] = [_line_out(l) for l in po.lines]
        out["vendor_info"] = {"gstin": po.vendor.gstin, "email": po.vendor.email, "phone": po.vendor.phone,
                              "payment_terms": po.vendor.payment_terms}
    return out


def _grn_out(g: GoodsReceipt, names: dict, users: dict):
    return {"id": g.id, "number": g.number, "po_id": g.po_id, "warehouse": names.get(g.warehouse_id), "received_on": g.received_on,
            "notes": g.notes, "received_by": users.get(g.received_by), "created_at": g.created_at,
            "lines": [{"po_line_id": l.po_line_id, "product_id": l.product_id, "quantity": _f(l.quantity), "unit_cost": _f(l.unit_cost)} for l in g.lines]}


# ---------------------------------------------------------------- list / create / read
SORTS = {"number": PurchaseOrder.number, "order_date": PurchaseOrder.order_date, "expected_date": PurchaseOrder.expected_date,
         "total": PurchaseOrder.total, "status": PurchaseOrder.status}


@router.get("/purchase-orders", tags=["purchase-orders"])
def list_pos(q: Optional[str] = None, status: str = "all", vendor_id: Optional[int] = None, date_from: Optional[date] = None,
             date_to: Optional[date] = None, sort: str = "order_date", desc: bool = True, page: int = Query(1, ge=1),
             page_size: int = Query(25, ge=1, le=200), user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    """status: all | open (issued + partially received) | draft | issued | partially_received | received | cancelled."""
    stmt = select(PurchaseOrder).where(PurchaseOrder.org_id == user.org_id).join(Vendor, Vendor.id == PurchaseOrder.vendor_id)
    if status == "open":
        stmt = stmt.where(PurchaseOrder.status.in_(OPEN))
    elif status in STATUSES:
        stmt = stmt.where(PurchaseOrder.status == status)
    if vendor_id:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    if date_from:
        stmt = stmt.where(PurchaseOrder.order_date >= date_from)
    if date_to:
        stmt = stmt.where(PurchaseOrder.order_date <= date_to)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(PurchaseOrder.number.ilike(like), PurchaseOrder.reference.ilike(like), Vendor.name.ilike(like)))
    col = SORTS.get(sort, PurchaseOrder.order_date)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(PurchaseOrder.lines), selectinload(PurchaseOrder.vendor))
                      .order_by(col.desc() if desc else col.asc(), PurchaseOrder.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    summary = db.execute(select(PurchaseOrder.status, func.count(), func.coalesce(func.sum(PurchaseOrder.total), 0))
                         .where(PurchaseOrder.org_id == user.org_id).group_by(PurchaseOrder.status)).all()
    return {"total": total, "page": page, "page_size": page_size, "items": [_po_out(p) for p in rows],
            "counts": {s: {"count": c, "value": float(v)} for s, c, v in summary}}


@router.post("/purchase-orders", tags=["purchase-orders"], status_code=201)
def create_po(body: POIn, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    po = PurchaseOrder(org_id=user.org_id, number=next_number(db, user.org_id, "PO"), status="draft", created_by=user.id,
                       vendor_id=body.vendor_id, warehouse_id=body.warehouse_id, order_date=body.order_date or date.today())
    db.add(po)
    _apply_lines(db, user, po, body)
    db.flush()
    audit(db, user, "create", "purchase_order", po.id, {"number": po.number, "total": str(po.total)})
    db.commit()
    return _po_out(po, True)


@router.get("/purchase-orders/suggestions", tags=["purchase-orders"])
def suggestions(user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    """Reorder suggestions grouped by preferred vendor. Quantity already on open orders is deducted."""
    ins = whl.compute_insights(db, user.org_id)["requirements"]
    on_order = _on_order(db, user.org_id)
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_({r["product_id"] for r in ins} or {0})))}
    vend = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.org_id == user.org_id))}
    groups: dict = {}
    for r in ins:
        p = prods[r["product_id"]]
        net = D(r["suggested_order_qty"]) - on_order.get(p.id, D(0))
        if net <= 0:
            continue
        g = groups.setdefault(p.preferred_vendor_id, {"vendor_id": p.preferred_vendor_id, "vendor": vend[p.preferred_vendor_id].name if p.preferred_vendor_id in vend else None, "items": [], "estimated_cost": 0.0})
        cost = float(q2(net * p.purchase_price))
        g["items"].append({"product_id": p.id, "sku": p.sku, "name": p.name, "available": r["available"], "demand_30d": r["demand_30d"],
                           "on_order": _f(on_order.get(p.id, D(0))), "suggested_qty": _f(net), "rate": _f(p.purchase_price), "estimated_cost": cost})
        g["estimated_cost"] = round(g["estimated_cost"] + cost, 2)
    return sorted(groups.values(), key=lambda g: (g["vendor_id"] is None, g["vendor"] or ""))


class FromSuggestions(BaseModel):
    warehouse_id: int
    vendor_ids: Optional[list[int]] = None  # omit for every vendor that has suggestions


@router.post("/purchase-orders/from-suggestions", tags=["purchase-orders"], status_code=201)
def create_from_suggestions(body: FromSuggestions, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    made, skipped = [], []
    for g in suggestions(user, db):
        if g["vendor_id"] is None:
            skipped += [{"sku": i["sku"], "reason": "no preferred vendor"} for i in g["items"]]
            continue
        if body.vendor_ids is not None and g["vendor_id"] not in body.vendor_ids:
            continue
        po = PurchaseOrder(org_id=user.org_id, number=next_number(db, user.org_id, "PO"), status="draft", created_by=user.id,
                           vendor_id=g["vendor_id"], warehouse_id=body.warehouse_id, order_date=date.today(),
                           notes="Created from reorder suggestions")
        db.add(po)
        _apply_lines(db, user, po, POIn(vendor_id=g["vendor_id"], warehouse_id=body.warehouse_id, notes=po.notes,
                                        lines=[POLineIn(product_id=i["product_id"], quantity=D(str(i["suggested_qty"]))) for i in g["items"]]))
        db.flush()
        audit(db, user, "create", "purchase_order", po.id, {"number": po.number, "source": "suggestions"})
        made.append(po)
    db.commit()
    return {"created": [_po_out(p) for p in made], "skipped": skipped}


def _on_order(db, org_id) -> dict:
    rows = db.execute(select(PurchaseOrderLine.product_id, func.sum(PurchaseOrderLine.quantity - PurchaseOrderLine.qty_received))
                      .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
                      .where(PurchaseOrder.org_id == org_id, PurchaseOrder.status.in_(OPEN)).group_by(PurchaseOrderLine.product_id)).all()
    return {p: D(q or 0) for p, q in rows}


@router.get("/purchase-orders-export.csv", tags=["purchase-orders"])
def export_pos(user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["number", "date", "vendor", "status", "expected", "subtotal", "discount", "taxable", "cgst", "sgst", "igst", "total", "received_pct"])
    for p in db.scalars(select(PurchaseOrder).where(PurchaseOrder.org_id == user.org_id).options(selectinload(PurchaseOrder.lines), selectinload(PurchaseOrder.vendor)).order_by(PurchaseOrder.id)):
        o = _po_out(p)
        w.writerow([o["number"], o["order_date"], o["vendor"], o["status"], o["expected_date"] or "", o["subtotal"], o["discount_total"], o["taxable_total"], o["cgst"], o["sgst"], o["igst"], o["total"], o["received_pct"]])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=purchase-orders.csv"})


@router.get("/purchase-orders/{pid}", tags=["purchase-orders"])
def get_po(pid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    po = _po(db, user, pid)
    out = _po_out(po, True)
    names = {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    out["receipts"] = [_grn_out(g, names, users) for g in po.receipts]
    out["warehouse"] = names.get(po.warehouse_id)
    out["created_by"] = users.get(po.created_by)
    logs = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id, AuditLog.entity == "purchase_order",
                                             AuditLog.entity_id == str(pid)).order_by(AuditLog.id.desc())).all()
    out["activity"] = [{"when": a.created_at, "user": users.get(a.user_id), "action": a.action, "detail": a.detail} for a in logs]
    return out


# ---------------------------------------------------------------- lifecycle
@router.put("/purchase-orders/{pid}", tags=["purchase-orders"])
def update_po(pid: int, body: POIn, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    po = _po(db, user, pid, lock=True)
    if po.status != "draft":
        raise HTTPException(409, "Only draft purchase orders can be edited")
    _apply_lines(db, user, po, body)
    audit(db, user, "update", "purchase_order", pid, {"total": str(po.total)})
    db.commit()
    return _po_out(po, True)


@router.post("/purchase-orders/{pid}/issue", tags=["purchase-orders"])
def issue_po(pid: int, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    po = _po(db, user, pid, lock=True)
    if po.status != "draft":
        raise HTTPException(409, f"Purchase order is already {po.status.replace('_', ' ')}")
    if po.vendor.status != "active":
        raise HTTPException(422, "Vendor is inactive")
    if not po.lines:
        raise HTTPException(422, "Add at least one line before issuing")
    bad = [l.product.name for l in po.lines if l.product.is_archived or l.product.status != "active"]
    if bad:
        raise HTTPException(422, f"These items are no longer active: {', '.join(bad)}")
    po.status, po.issued_at = "issued", now()
    audit(db, user, "issue", "purchase_order", pid, {"number": po.number})
    db.commit()
    return _po_out(po, True)


@router.post("/purchase-orders/{pid}/cancel", tags=["purchase-orders"])
def cancel_po(pid: int, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    po = _po(db, user, pid, lock=True)
    if po.status == "cancelled":
        raise HTTPException(409, "Purchase order is already cancelled")
    if po.status == "received":
        raise HTTPException(409, "A fully received order can't be cancelled")
    if any(l.qty_received > 0 for l in po.lines):
        raise HTTPException(409, "Goods have already been received against this order, so it can't be cancelled")
    po.status, po.cancelled_at = "cancelled", now()
    audit(db, user, "cancel", "purchase_order", pid, {"number": po.number})
    db.commit()
    return _po_out(po, True)


@router.delete("/purchase-orders/{pid}", tags=["purchase-orders"], status_code=204)
def delete_po(pid: int, user: User = Depends(require("purchases", "w")), db: Session = Depends(get_db)):
    po = _po(db, user, pid, lock=True)
    if po.status != "draft":
        raise HTTPException(409, "Only draft purchase orders can be deleted; cancel it instead")
    audit(db, user, "delete", "purchase_order", pid, {"number": po.number})
    db.delete(po)
    db.commit()


@router.post("/purchase-orders/{pid}/receive", tags=["purchase-orders"], status_code=201)
def receive(pid: int, body: ReceiveIn, user: User = Depends(require("inventory", "w")), db: Session = Depends(get_db)):
    """Post a (partial) delivery: updates the PO lines and writes receipt movements into the stock ledger atomically."""
    if not can(user, "purchases", "r"):
        raise HTTPException(403, "Your role cannot view purchase orders")
    org = org_of(db, user)
    names = {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    if body.idempotency_key:  # a double-click / retried request returns the original receipt, never a second one
        prev = db.scalars(select(GoodsReceipt).where(GoodsReceipt.org_id == user.org_id, GoodsReceipt.client_key == body.idempotency_key)).first()
        if prev:
            return _grn_out(prev, names, users)
    po = _po(db, user, pid, lock=True)
    if po.status not in OPEN:
        raise HTTPException(409, "Goods can only be received against an issued or partially received order" if po.status != "draft" else "Issue the purchase order before receiving goods")
    wh = db.get(Warehouse, body.warehouse_id)
    if not wh or wh.org_id != user.org_id:
        raise HTTPException(422, "Unknown warehouse")
    if not wh.is_active:
        raise HTTPException(422, f"Warehouse {wh.code} is archived")
    merged: dict[int, Decimal] = {}
    for l in body.lines:
        merged[l.po_line_id] = merged.get(l.po_line_id, D(0)) + l.quantity
    by_id = {l.id: l for l in po.lines}
    for lid, qty in merged.items():
        line = by_id.get(lid)
        if not line:
            raise HTTPException(422, "A receipt line doesn't belong to this purchase order")
        if qty > line.quantity - line.qty_received:
            raise HTTPException(422, f"{line.product.name}: only {line.quantity - line.qty_received:g} still outstanding, you entered {qty:g}")
    grn = GoodsReceipt(org_id=user.org_id, number=next_number(db, user.org_id, "GRN"), po_id=po.id, warehouse_id=wh.id,
                       received_on=body.received_on or date.today(), notes=body.notes, client_key=body.idempotency_key, received_by=user.id)
    db.add(grn)
    try:
        db.flush()
    except IntegrityError:  # lost a race on the idempotency key
        db.rollback()
        prev = db.scalars(select(GoodsReceipt).where(GoodsReceipt.org_id == user.org_id, GoodsReceipt.client_key == body.idempotency_key)).first()
        if prev:
            return _grn_out(prev, names, users)
        raise
    for lid, qty in sorted(merged.items()):
        line = by_id[lid]
        # conditional UPDATE: two concurrent receipts can never push received above ordered
        res = db.execute(update(PurchaseOrderLine).where(PurchaseOrderLine.id == lid, PurchaseOrderLine.qty_received + qty <= PurchaseOrderLine.quantity)
                         .values(qty_received=PurchaseOrderLine.qty_received + qty).execution_options(synchronize_session=False))
        if res.rowcount != 1:
            db.rollback()
            raise HTTPException(409, f"{line.product.name}: the outstanding quantity changed, refresh and try again")
        unit_cost = (line.taxable / line.quantity).quantize(D("0.0001"))
        db.add(GoodsReceiptLine(receipt_id=grn.id, po_line_id=lid, product_id=line.product_id, quantity=qty, unit_cost=unit_cost))
        try:
            stk.apply_movement(db, org, product_id=line.product_id, warehouse_id=wh.id, type="receipt", qty_delta=qty, unit_cost=unit_cost,
                               ref_type="GRN", ref_id=grn.id, reason=f"Received against {po.number}", user_id=user.id,
                               idempotency_key=f"grn:{grn.id}:{lid}")
        except stk.StockError as e:
            db.rollback()
            raise HTTPException(e.status, str(e))
    db.expire(po)
    po = _po(db, user, pid)
    po.status = "received" if all(l.qty_received >= l.quantity for l in po.lines) else "partially_received"
    audit(db, user, "receive", "purchase_order", pid, {"grn": grn.number, "lines": len(merged), "status": po.status})
    db.commit()
    return _grn_out(grn, names, users)


# ---------------------------------------------------------------- PDF
@router.get("/purchase-orders/{pid}/pdf", tags=["purchase-orders"])
def po_pdf(pid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    po = _po(db, user, pid)
    org, v = org_of(db, user), po.vendor
    wh = db.get(Warehouse, po.warehouse_id)
    rows = [[i, f"{l.product.name}\n{l.product.sku}", l.product.hsn_code or "", f"{l.quantity:g} {l.product.unit}", inr(l.rate),
             f"{l.discount_pct:g}%" if l.discount_pct else "-", f"{l.tax_rate:g}%", inr(l.amount)] for i, l in enumerate(po.lines, start=1)]
    totals = [("Subtotal", inr(po.subtotal))]
    if po.discount_total:
        totals.append(("Discount", "-" + inr(po.discount_total)))
    totals.append(("Taxable amount", inr(po.taxable_total)))
    totals += [("IGST", inr(po.igst))] if po.gst_mode == "inter" else [("CGST", inr(po.cgst)), ("SGST", inr(po.sgst))]
    totals.append(("Total", inr(po.total)))
    pdf = build_pdf(title="Purchase Order", org={"name": org.name, "gstin": org.gstin, "state": org.state, "address": org.address},
                    meta=[("PO number", po.number), ("Date", str(po.order_date)), ("Expected", str(po.expected_date or "-")),
                          ("Reference", po.reference or "-"), ("Status", po.status.replace("_", " ").title()), ("Ship to", f"{wh.code} {wh.name}" if wh else "-")],
                    parties=[("VENDOR", [v.name, v.company_name or "", ", ".join(x for x in [v.bill_address, v.bill_city, v.bill_state, v.bill_pincode] if x),
                                         f"GSTIN: {v.gstin}" if v.gstin else "", f"Terms: {'Due on receipt' if v.payment_terms == 0 else f'Net {v.payment_terms} days'}"])],
                    columns=["#", "Item", "HSN", "Qty", "Rate", "Disc.", "GST", "Amount"], rows=rows, col_widths=[8, 62, 18, 24, 26, 14, 14, 26], right_cols=(3, 4, 5, 6, 7),
                    totals=totals, notes=po.notes, footer=f"{po.number} - {'IGST (inter-state)' if po.gst_mode == 'inter' else 'CGST + SGST (intra-state)'}")
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{po.number}.pdf"'})


# ---------------------------------------------------------------- vendor financials
def _received_value(db, org_id, vendor_id) -> Decimal:
    """Value of goods delivered so far (incl. GST): per line, amount x received share, rounded to paise."""
    total = D(0)
    for amount, qty, got in db.execute(select(PurchaseOrderLine.amount, PurchaseOrderLine.quantity, PurchaseOrderLine.qty_received)
                                       .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
                                       .where(PurchaseOrder.org_id == org_id, PurchaseOrder.vendor_id == vendor_id, PurchaseOrder.status != "cancelled")):
        total += q2(amount * got / qty)
    return total


def _paid(db, org_id, party_type, party_id) -> Decimal:
    return D(db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.org_id == org_id, Payment.party_type == party_type, Payment.party_id == party_id, Payment.status == "posted")))


def vendor_stats(db, org_id, vendor_id) -> dict:
    pos = db.scalars(select(PurchaseOrder).where(PurchaseOrder.org_id == org_id, PurchaseOrder.vendor_id == vendor_id)
                     .options(selectinload(PurchaseOrder.lines), selectinload(PurchaseOrder.receipts))).all()
    live = [p for p in pos if p.status in ("issued", "partially_received", "received")]
    received_value, paid = _received_value(db, org_id, vendor_id), _paid(db, org_id, "vendor", vendor_id)
    ordered = sum((l.quantity for p in live for l in p.lines), D(0))
    got = sum((l.qty_received for p in live for l in p.lines), D(0))
    done = [p for p in pos if p.status == "received" and p.expected_date and p.receipts]
    on_time = [p for p in done if max(g.received_on for g in p.receipts) <= p.expected_date]
    leads = [(min(g.received_on for g in p.receipts) - p.issued_at.date()).days for p in live if p.receipts and p.issued_at]
    return {"orders": len(pos), "open_orders": sum(1 for p in pos if p.status in OPEN), "draft_orders": sum(1 for p in pos if p.status == "draft"),
            "total_purchased": _f(sum((p.total for p in live), D(0))), "received_value": _f(received_value), "paid": _f(paid),
            "outstanding": _f(received_value - paid),
            "performance": {"completed_orders": len([p for p in pos if p.status == "received"]),
                            "on_time_pct": round(len(on_time) / len(done) * 100, 1) if done else None,
                            "fill_rate_pct": round(float(got / ordered * 100), 1) if ordered else None,
                            "avg_lead_days": round(sum(leads) / len(leads), 1) if leads else None}}


@router.get("/vendors/{vid}/stats", tags=["vendors"])
def vendor_stats_ep(vid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    v = db.get(Vendor, vid)
    if not v or v.org_id != user.org_id:
        raise HTTPException(404, "Vendor not found")
    return vendor_stats(db, user.org_id, vid)


@router.get("/vendors/{vid}/transactions", tags=["vendors"])
def vendor_transactions(vid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    v = db.get(Vendor, vid)
    if not v or v.org_id != user.org_id:
        raise HTTPException(404, "Vendor not found")
    ev = []
    for p in db.scalars(select(PurchaseOrder).where(PurchaseOrder.org_id == user.org_id, PurchaseOrder.vendor_id == vid).options(selectinload(PurchaseOrder.lines), selectinload(PurchaseOrder.receipts))):
        ev.append({"kind": "purchase_order", "id": p.id, "number": p.number, "date": p.order_date, "status": p.status, "amount": _f(p.total), "when": p.created_at})
        for g in p.receipts:
            ev.append({"kind": "receipt", "id": p.id, "number": g.number, "date": g.received_on, "status": f"for {p.number}", "amount": None, "when": g.created_at})
    for pay in db.scalars(select(Payment).where(Payment.org_id == user.org_id, Payment.party_type == "vendor", Payment.party_id == vid)):
        ev.append({"kind": "payment", "id": pay.id, "number": pay.number, "date": pay.paid_on, "status": pay.status, "amount": _f(-pay.amount), "when": pay.created_at,
                   "method": pay.method, "reference": pay.reference})
    ev.sort(key=lambda e: whl.aware(e["when"]), reverse=True)
    return ev


@router.get("/products/{pid}/purchase-transactions", tags=["products"])
def product_purchase_transactions(pid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    p = db.get(Product, pid)
    if not p or p.org_id != user.org_id:
        raise HTTPException(404, "Product not found")
    rows = db.execute(select(PurchaseOrderLine, PurchaseOrder, Vendor).join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
                      .join(Vendor, Vendor.id == PurchaseOrder.vendor_id).where(PurchaseOrderLine.product_id == pid, PurchaseOrder.org_id == user.org_id)
                      .order_by(PurchaseOrder.id.desc()).limit(100)).all()
    return [{"po_id": po.id, "number": po.number, "date": po.order_date, "vendor": v.name, "vendor_id": v.id, "status": po.status,
             "quantity": _f(l.quantity), "received": _f(l.qty_received), "rate": _f(l.rate), "amount": _f(l.amount)} for l, po, v in rows]


# ---------------------------------------------------------------- payments
class PaymentIn(BaseModel):
    party_type: str = Field(pattern="^(vendor|customer)$")
    party_id: int
    amount: Decimal = Field(gt=0, le=D("1000000000"))
    paid_on: Optional[date] = None
    method: str = Field(default="bank_transfer", pattern="^(cash|bank_transfer|upi|cheque|card|other)$")
    reference: Optional[str] = Field(default=None, max_length=80)
    notes: Optional[str] = Field(default=None, max_length=300)
    order_id: Optional[int] = None


def _outstanding(db, org_id, party_type, party_id) -> Decimal:
    if party_type == "vendor":
        return _received_value(db, org_id, party_id) - _paid(db, org_id, "vendor", party_id)
    from .sales_api import customer_receivable  # defined in Phase 3
    return customer_receivable(db, org_id, party_id) - _paid(db, org_id, "customer", party_id)


def _party(db, user, party_type, party_id):
    from .models import Customer
    Model = Vendor if party_type == "vendor" else Customer
    p = db.get(Model, party_id)
    if not p or p.org_id != user.org_id:
        raise HTTPException(404, f"{party_type.title()} not found")
    return p


def _pay_module(party_type):
    return "purchases" if party_type == "vendor" else "sales"


@router.post("/payments", tags=["payments"], status_code=201)
def record_payment(body: PaymentIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Vendor payments need purchasing write access; customer receipts need sales write access."""
    if not can(user, _pay_module(body.party_type), "w"):
        raise HTTPException(403, f"Your role cannot record {body.party_type} payments")
    party = _party(db, user, body.party_type, body.party_id)
    out = _outstanding(db, user.org_id, body.party_type, party.id)
    if body.amount > out:
        why = "Goods must be received before they can be paid for." if body.party_type == "vendor" else "Only goods that have shipped can be billed."
        raise HTTPException(422, f"Payment exceeds the outstanding balance of INR {out:,.2f}. {why}")
    pay = Payment(org_id=user.org_id, number=next_number(db, user.org_id, "PAY"), party_type=body.party_type, party_id=party.id,
                  order_type=("PO" if body.party_type == "vendor" else "SO") if body.order_id else None, order_id=body.order_id, amount=q2(body.amount),
                  paid_on=body.paid_on or date.today(), method=body.method, reference=body.reference, notes=body.notes, created_by=user.id)
    db.add(pay)
    db.flush()
    audit(db, user, "payment", body.party_type, party.id, {"number": pay.number, "amount": str(pay.amount)})
    db.commit()
    return {"id": pay.id, "number": pay.number, "amount": _f(pay.amount), "outstanding": _f(out - pay.amount)}


@router.post("/payments/{pay_id}/void", tags=["payments"])
def void_payment(pay_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    pay = db.get(Payment, pay_id)
    if not pay or pay.org_id != user.org_id:
        raise HTTPException(404, "Payment not found")
    if not can(user, _pay_module(pay.party_type), "w"):
        raise HTTPException(403, "Your role cannot void this payment")
    if pay.status == "void":
        raise HTTPException(409, "Payment is already void")
    pay.status = "void"
    audit(db, user, "void_payment", pay.party_type, pay.party_id, {"number": pay.number})
    db.commit()
    return {"ok": True}


@router.get("/payments", tags=["payments"])
def list_payments(party_type: str = "vendor", party_id: Optional[int] = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if party_type not in ("vendor", "customer") or not can(user, _pay_module(party_type), "r"):
        raise HTTPException(403, "Not allowed")
    stmt = select(Payment).where(Payment.org_id == user.org_id, Payment.party_type == party_type)
    if party_id:
        stmt = stmt.where(Payment.party_id == party_id)
    return [{"id": p.id, "number": p.number, "party_id": p.party_id, "amount": _f(p.amount), "paid_on": p.paid_on, "method": p.method,
             "reference": p.reference, "status": p.status, "notes": p.notes} for p in db.scalars(stmt.order_by(Payment.id.desc()).limit(200))]
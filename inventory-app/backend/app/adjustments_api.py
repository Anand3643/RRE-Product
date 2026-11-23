"""Inventory adjustments: increase, decrease, damaged, missing, corrections (cycle counts) as auditable documents."""
import csv
import io
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import stock as stk
from .api import audit, org_of, require
from .core import get_db
from .models import (InventoryAdjustment, InventoryAdjustmentLine, Product, StockBalance, StockMovement, User, Warehouse)
from .sequences import next_number
from .tax import q2

router = APIRouter(prefix="/api")
D = Decimal
TYPES = ("increase", "decrease", "damage", "missing", "correction")
MODE = {"increase": "increase", "decrease": "decrease", "damage": "damage", "missing": "decrease", "correction": "set"}
LABEL = {"increase": "Stock increase", "decrease": "Stock decrease", "damage": "Damaged goods", "missing": "Missing stock", "correction": "Correction (count)"}


class AdjLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(ge=0, le=D("1000000000"))  # for a correction: the counted quantity (0 is allowed)
    unit_cost: Optional[Decimal] = Field(default=None, ge=0)


class AdjIn(BaseModel):
    adj_type: str = Field(pattern="^(increase|decrease|damage|missing|correction)$")
    warehouse_id: int
    adj_date: Optional[date] = None
    reason: str = Field(min_length=3, max_length=300)
    notes: Optional[str] = Field(default=None, max_length=500)
    idempotency_key: Optional[str] = Field(default=None, max_length=80)
    lines: list[AdjLine] = Field(min_length=1, max_length=200)


def _f(x):
    return float(x) if x is not None else None


def _out(a: InventoryAdjustment, names: dict, users: dict, prods: dict, mv: dict, detail=False):
    net = sum((l.qty_delta for l in a.lines), D(0))
    value = sum((q2(l.qty_delta * (l.unit_cost or D(0))) for l in a.lines), D(0))
    out = {"id": a.id, "number": a.number, "adj_type": a.adj_type, "type_label": LABEL[a.adj_type], "warehouse_id": a.warehouse_id,
           "warehouse": names.get(a.warehouse_id), "adj_date": a.adj_date, "reason": a.reason, "notes": a.notes, "created_at": a.created_at,
           "created_by": users.get(a.created_by), "line_count": len(a.lines), "net_units": _f(net), "value_impact": _f(value)}
    if detail:
        out["lines"] = [{"id": l.id, "product_id": l.product_id, "sku": prods[l.product_id].sku, "name": prods[l.product_id].name, "unit": prods[l.product_id].unit,
                         "quantity": _f(l.quantity), "qty_before": _f(l.qty_before), "qty_delta": _f(l.qty_delta), "qty_after": _f(l.qty_before + l.qty_delta),
                         "unit_cost": _f(l.unit_cost), "value": _f(q2(l.qty_delta * (l.unit_cost or D(0)))), "movement_id": l.movement_id} for l in a.lines]
    return out


def _ctx(db, org_id, adjs):
    names = {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == org_id))}
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == org_id))}
    pids = {l.product_id for a in adjs for l in a.lines} or {0}
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(pids)))}
    return names, users, prods


@router.post("/adjustments", tags=["adjustments"], status_code=201)
def create_adjustment(body: AdjIn, user: User = Depends(require("inventory", "w")), db: Session = Depends(get_db)):
    """Posts every line atomically: if any line would break a stock rule, nothing is recorded."""
    org = org_of(db, user)
    wh = db.get(Warehouse, body.warehouse_id)
    if not wh or wh.org_id != user.org_id:
        raise HTTPException(422, "Unknown warehouse")
    if not wh.is_active:
        raise HTTPException(422, f"Warehouse {wh.code} is archived")
    if body.idempotency_key:
        prev = db.scalars(select(InventoryAdjustment).where(InventoryAdjustment.org_id == user.org_id, InventoryAdjustment.client_key == body.idempotency_key)).first()
        if prev:
            return _full(db, user, prev)
    merged: dict[int, AdjLine] = {}
    for l in body.lines:
        if l.product_id in merged:
            if body.adj_type == "correction":
                raise HTTPException(422, "Each item can appear only once in a correction")
            merged[l.product_id].quantity += l.quantity
        else:
            merged[l.product_id] = l.model_copy()
    if body.adj_type != "correction" and any(l.quantity <= 0 for l in merged.values()):
        raise HTTPException(422, "Quantities must be greater than zero")
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.org_id == user.org_id, Product.id.in_(set(merged))))}
    if set(merged) - set(prods):
        raise HTTPException(422, "A line refers to an unknown item")
    adj = InventoryAdjustment(org_id=user.org_id, number=next_number(db, user.org_id, "ADJ"), adj_type=body.adj_type, warehouse_id=wh.id,
                              adj_date=body.adj_date or date.today(), reason=body.reason.strip(), notes=body.notes, client_key=body.idempotency_key, created_by=user.id)
    db.add(adj)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        prev = db.scalars(select(InventoryAdjustment).where(InventoryAdjustment.org_id == user.org_id, InventoryAdjustment.client_key == body.idempotency_key)).first()
        if prev:
            return _full(db, user, prev)
        raise
    for pid, l in sorted(merged.items()):
        bal = db.scalars(select(StockBalance).where(StockBalance.product_id == pid, StockBalance.warehouse_id == wh.id)).first()
        before = bal.on_hand if bal else D(0)
        try:
            m = stk.adjust_stock(db, org, product_id=pid, warehouse_id=wh.id, mode=MODE[body.adj_type], quantity=l.quantity,
                                 reason=f"{adj.number}: {LABEL[body.adj_type]} - {adj.reason}", user_id=user.id, unit_cost=l.unit_cost,
                                 idempotency_key=f"adj:{adj.id}:{pid}")
        except stk.StockError as e:
            db.rollback()
            raise HTTPException(e.status, f"{prods[pid].name}: {e}")
        adj.lines.append(InventoryAdjustmentLine(product_id=pid, quantity=l.quantity, qty_before=before, qty_delta=m.qty_delta,
                                                 unit_cost=m.unit_cost, movement_id=m.id))
    audit(db, user, "adjustment", "stock", adj.id, {"number": adj.number, "type": adj.adj_type, "lines": len(merged)})
    db.commit()
    return _full(db, user, adj)


def _full(db, user, adj):
    db.refresh(adj)
    names, users, prods = _ctx(db, user.org_id, [adj])
    return _out(adj, names, users, prods, {}, True)


@router.get("/adjustments", tags=["adjustments"])
def list_adjustments(q: Optional[str] = None, adj_type: Optional[str] = None, warehouse_id: Optional[int] = None, product_id: Optional[int] = None,
                     user_id: Optional[int] = None, date_from: Optional[date] = None, date_to: Optional[date] = None, page: int = Query(1, ge=1),
                     page_size: int = Query(25, ge=1, le=200), user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    stmt = select(InventoryAdjustment).where(InventoryAdjustment.org_id == user.org_id)
    if adj_type in TYPES:
        stmt = stmt.where(InventoryAdjustment.adj_type == adj_type)
    if warehouse_id:
        stmt = stmt.where(InventoryAdjustment.warehouse_id == warehouse_id)
    if user_id:
        stmt = stmt.where(InventoryAdjustment.created_by == user_id)
    if date_from:
        stmt = stmt.where(InventoryAdjustment.adj_date >= date_from)
    if date_to:
        stmt = stmt.where(InventoryAdjustment.adj_date <= date_to)
    if product_id:
        stmt = stmt.where(InventoryAdjustment.id.in_(select(InventoryAdjustmentLine.adjustment_id).where(InventoryAdjustmentLine.product_id == product_id)))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(InventoryAdjustment.number.ilike(like), InventoryAdjustment.reason.ilike(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(InventoryAdjustment.lines)).order_by(InventoryAdjustment.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    names, users, prods = _ctx(db, user.org_id, rows)
    by_type = dict(db.execute(select(InventoryAdjustment.adj_type, func.count()).where(InventoryAdjustment.org_id == user.org_id).group_by(InventoryAdjustment.adj_type)).all())
    return {"total": total, "page": page, "page_size": page_size, "items": [_out(a, names, users, prods, {}) for a in rows], "counts": by_type}


@router.get("/adjustments-export.csv", tags=["adjustments"])
def export_adjustments(user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    rows = db.scalars(select(InventoryAdjustment).where(InventoryAdjustment.org_id == user.org_id).options(selectinload(InventoryAdjustment.lines)).order_by(InventoryAdjustment.id)).all()
    names, users, prods = _ctx(db, user.org_id, rows)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["number", "date", "type", "warehouse", "sku", "item", "before", "change", "after", "unit_cost", "value", "reason", "by"])
    for a in rows:
        for l in _out(a, names, users, prods, {}, True)["lines"]:
            w.writerow([a.number, a.adj_date, a.adj_type, names.get(a.warehouse_id), l["sku"], l["name"], l["qty_before"], l["qty_delta"], l["qty_after"], l["unit_cost"], l["value"], a.reason, users.get(a.created_by)])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=adjustments.csv"})


@router.get("/adjustments/{aid}", tags=["adjustments"])
def get_adjustment(aid: int, user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    a = db.scalars(select(InventoryAdjustment).where(InventoryAdjustment.id == aid, InventoryAdjustment.org_id == user.org_id)).first()
    if not a:
        raise HTTPException(404, "Adjustment not found")
    return _full(db, user, a)

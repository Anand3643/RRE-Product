"""Warehouse management API: list/detail, tabs, transfer orders, reports, insights."""
import csv
import io
import math
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import stock as stk
from . import whlogic as whl
from .api import audit, mv_out, org_of, require
from .core import get_db
from .models import (AuditLog, Product, StockBalance, StockMovement, TransferLine, TransferOrder, User, Warehouse)

router = APIRouter(prefix="/api")
D = Decimal


def _wh(db, user, wid) -> Warehouse:
    w = db.get(Warehouse, wid)
    if not w or w.org_id != user.org_id:
        raise HTTPException(404, "Warehouse not found")
    return w


def _page(items, page, size):
    return {"total": len(items), "page": page, "page_size": size, "items": items[(page - 1) * size: page * size]}


def _csv(rows: list[dict], cols: list[str], filename: str):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([r.get(c, "") for c in cols])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={filename}"})


# ---------- warehouses ----------
class WarehouseIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=120)
    city: Optional[str] = Field(default=None, max_length=100)
    state: Optional[str] = Field(default=None, max_length=100)
    address: Optional[str] = Field(default=None, max_length=300)
    pincode: Optional[str] = Field(default=None, max_length=10)
    contact_name: Optional[str] = Field(default=None, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=30)
    email: Optional[EmailStr] = None
    description: Optional[str] = Field(default=None, max_length=500)


class WarehousePatch(BaseModel):
    description: Optional[str] = Field(default=None, max_length=500)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    city: Optional[str] = None
    state: Optional[str] = None
    address: Optional[str] = None
    pincode: Optional[str] = None
    contact_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    is_active: Optional[bool] = None


@router.get("/warehouses", tags=["warehouses"])
def list_warehouses(q: Optional[str] = None, status: str = "all", sort: str = "code", desc: bool = False,
                    page: Optional[int] = Query(None, ge=1), page_size: int = Query(10, ge=1, le=100),
                    user: User = Depends(require("warehouses")), db: Session = Depends(get_db)):
    """Plain array when `page` is omitted (used by pickers); {total, items} when paginated."""
    rows = whl.warehouse_summaries(db, user.org_id)
    if status == "active":
        rows = [r for r in rows if r["is_active"]]
    elif status == "archived":
        rows = [r for r in rows if not r["is_active"]]
    if q:
        ql = q.lower()
        rows = [r for r in rows if any(ql in str(r.get(k) or "").lower() for k in
                                       ("code", "name", "city", "state", "address", "contact_name", "phone", "email"))]
    key = sort if sort in ("code", "name", "city", "products", "on_hand", "available", "low", "out", "value") else "code"
    rows.sort(key=lambda r: (r.get(key) is None, r.get(key) if not isinstance(r.get(key), str) else r[key].lower()),
              reverse=desc)
    return rows if page is None else _page(rows, page, page_size)


@router.get("/warehouses/overview", tags=["warehouses"])
def overview(user: User = Depends(require("warehouses")), db: Session = Depends(get_db)):
    ws = whl.warehouse_summaries(db, user.org_id)
    act = [w for w in ws if w["is_active"]]
    tr = db.scalar(select(func.count(TransferOrder.id)).where(TransferOrder.org_id == user.org_id))
    return {"warehouses": len(ws), "active": len(act), "archived": len(ws) - len(act),
            "on_hand": sum(w["on_hand"] for w in act), "reserved": sum(w["reserved"] for w in act),
            "available": sum(w["available"] for w in act), "value": sum(w["value"] for w in act),
            "low": sum(w["low"] for w in act), "out": sum(w["out"] for w in act), "transfers": tr}


@router.get("/warehouses/report.csv", tags=["warehouses"])
def warehouse_report(user: User = Depends(require("reports")), db: Session = Depends(get_db)):
    rows = whl.warehouse_summaries(db, user.org_id)
    for r in rows:
        r["status"] = "Active" if r["is_active"] else "Archived"
    return _csv(rows, ["code", "name", "city", "state", "contact_name", "phone", "status", "products", "on_hand",
                       "reserved", "available", "low", "out", "value"], "warehouse-report.csv")


@router.post("/warehouses", tags=["warehouses"], status_code=201)
def create_warehouse(body: WarehouseIn, user: User = Depends(require("warehouses", "w")),
                     db: Session = Depends(get_db)):
    data = body.model_dump()
    data["code"] = body.code.upper().strip()
    w = Warehouse(org_id=user.org_id, **data)
    db.add(w)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Warehouse code already exists")
    audit(db, user, "create", "warehouse", w.id, {"code": w.code})
    db.commit()
    return {"id": w.id}


@router.get("/warehouses/{wid}", tags=["warehouses"])
def warehouse_detail(wid: int, user: User = Depends(require("warehouses")), db: Session = Depends(get_db)):
    w = _wh(db, user, wid)
    s = next(x for x in whl.warehouse_summaries(db, user.org_id) if x["id"] == wid)
    since_in = db.scalar(select(func.count(TransferOrder.id)).where(TransferOrder.to_warehouse_id == wid))
    since_out = db.scalar(select(func.count(TransferOrder.id)).where(TransferOrder.from_warehouse_id == wid))
    rows = whl.item_rows(db, user.org_id, wid)
    return {**s, "incoming_transfers": since_in, "outgoing_transfers": since_out,
            "low_items": [r for r in rows if r["status"] == "low"][:10],
            "out_items": [r for r in rows if r["status"] == "out"][:10]}


@router.patch("/warehouses/{wid}", tags=["warehouses"])
def update_warehouse(wid: int, body: WarehousePatch, user: User = Depends(require("warehouses", "w")),
                     db: Session = Depends(get_db)):
    w = _wh(db, user, wid)
    ch = body.model_dump(exclude_unset=True)
    if ch.get("is_active") is False and w.is_active:
        on = db.scalar(select(func.coalesce(func.sum(StockBalance.on_hand), 0)).where(StockBalance.warehouse_id == wid))
        if on != 0:
            raise HTTPException(409, "Transfer all stock out of this warehouse before archiving it")
        others = db.scalar(select(func.count(Warehouse.id)).where(Warehouse.org_id == user.org_id,
                                                                  Warehouse.is_active.is_(True), Warehouse.id != wid))
        if not others:
            raise HTTPException(409, "You need at least one active warehouse")
    for k, v in ch.items():
        setattr(w, k, v)
    audit(db, user, "archive" if ch.get("is_active") is False else "restore" if ch.get("is_active") else "update",
          "warehouse", wid, {k: str(v) for k, v in ch.items()})
    db.commit()
    return {"ok": True}


IMPORT_COLS = ["code", "name", "address", "city", "state", "pincode", "contact_name", "phone", "email", "description"]


@router.post("/warehouses-import", tags=["warehouses"])
async def import_warehouses(file: UploadFile, user: User = Depends(require("warehouses", "w")),
                            db: Session = Depends(get_db)):
    """CSV with a header row using: code,name,address,city,state,pincode,contact_name,phone,email,description."""
    if len(raw := await file.read()) > 1_000_000:
        raise HTTPException(413, "File too large (max 1 MB)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(422, "File must be UTF-8 encoded CSV")
    reader = csv.DictReader(io.StringIO(text))
    cols = {(c or "").strip().lower() for c in (reader.fieldnames or [])}
    if not {"code", "name"} <= cols:
        raise HTTPException(422, "CSV needs at least 'code' and 'name' columns. Expected: " + ", ".join(IMPORT_COLS))
    created, errors = 0, []
    seen = {c for (c,) in db.execute(select(Warehouse.code).where(Warehouse.org_id == user.org_id))}
    for n, row in enumerate(reader, start=2):
        row = {(k or "").strip().lower(): (v or "").strip() or None for k, v in row.items()}
        try:
            data = WarehouseIn(**{k: row.get(k) for k in IMPORT_COLS if row.get(k) is not None})
        except Exception as e:  # pydantic validation message, trimmed to the first problem
            msg = getattr(e, "errors", lambda: [{"msg": str(e)}])()[0]
            errors.append({"row": n, "error": f"{'.'.join(map(str, msg.get('loc', [])))}: {msg['msg']}".strip(": ")})
            continue
        code = data.code.upper().strip()
        if code in seen:
            errors.append({"row": n, "error": f"Code {code} already exists"})
            continue
        db.add(Warehouse(org_id=user.org_id, **{**data.model_dump(), "code": code}))
        seen.add(code)
        created += 1
    audit(db, user, "import", "warehouse", None, {"created": created, "errors": len(errors)})
    db.commit()
    return {"created": created, "errors": errors}


@router.get("/warehouses/{wid}/trend", tags=["warehouses"])
def warehouse_trend(wid: int, days: int = Query(30, ge=7, le=90), user: User = Depends(require("inventory")),
                    db: Session = Depends(get_db)):
    """Daily units received (inbound) and issued (outbound), zero-filled, including transfers in/out."""
    from datetime import timedelta
    from .core import now
    _wh(db, user, wid)
    start = (now() - timedelta(days=days - 1)).date()
    buckets = {(start + timedelta(days=i)).isoformat(): {"date": (start + timedelta(days=i)).isoformat(),
                                                          "inbound": 0.0, "outbound": 0.0} for i in range(days)}
    for m in db.scalars(select(StockMovement).where(StockMovement.warehouse_id == wid, StockMovement.qty_delta != 0,
                                                    StockMovement.created_at >= now() - timedelta(days=days))):
        b = buckets.get(whl.aware(m.created_at).date().isoformat())
        if b:
            b["inbound" if m.qty_delta > 0 else "outbound"] += abs(float(m.qty_delta))
    return list(buckets.values())


@router.delete("/warehouses/{wid}", tags=["warehouses"], status_code=204)
def delete_warehouse(wid: int, user: User = Depends(require("warehouses", "w")), db: Session = Depends(get_db)):
    """Only a warehouse with no history can be deleted; otherwise it must be archived to keep the ledger intact."""
    w = _wh(db, user, wid)
    used = (db.scalars(select(StockMovement.id).where(StockMovement.warehouse_id == wid).limit(1)).first()
            or db.scalars(select(TransferOrder.id).where(or_(TransferOrder.from_warehouse_id == wid,
                                                             TransferOrder.to_warehouse_id == wid)).limit(1)).first())
    if used:
        raise HTTPException(409, "This warehouse has stock or transfer history and can't be deleted. Archive it instead.")
    others = db.scalar(select(func.count(Warehouse.id)).where(Warehouse.org_id == user.org_id, Warehouse.id != wid,
                                                              Warehouse.is_active.is_(True)))
    if w.is_active and not others:
        raise HTTPException(409, "You need at least one active warehouse")
    db.query(StockBalance).filter(StockBalance.warehouse_id == wid).delete()
    audit(db, user, "delete", "warehouse", wid, {"code": w.code})
    db.delete(w)
    db.commit()


@router.get("/warehouses/{wid}/items", tags=["warehouses"])
def warehouse_items(wid: int, q: Optional[str] = None, status: str = "all", sort: str = "name", desc: bool = False,
                    page: int = Query(1, ge=1), page_size: int = Query(15, ge=1, le=200), csv_export: bool = False,
                    user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    _wh(db, user, wid)
    rows = whl.item_rows(db, user.org_id, wid)
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r["name"].lower() or ql in r["sku"].lower()]
    if status in ("ok", "low", "out"):
        rows = [r for r in rows if r["status"] == status]
    key = sort if sort in ("name", "sku", "on_hand", "reserved", "available", "value", "status") else "name"
    rows.sort(key=lambda r: r[key].lower() if isinstance(r[key], str) else r[key], reverse=desc)
    if csv_export:
        return _csv(rows, ["sku", "name", "on_hand", "reserved", "available", "damaged", "reorder_point", "avg_cost",
                           "value", "status"], f"warehouse-{wid}-items.csv")
    return _page(rows, page, page_size)


def _transfer_out(db, t: TransferOrder, names):
    return {"id": t.id, "number": t.number, "from_warehouse_id": t.from_warehouse_id,
            "from_code": names.get(t.from_warehouse_id), "to_warehouse_id": t.to_warehouse_id,
            "to_code": names.get(t.to_warehouse_id), "status": t.status, "notes": t.notes, "source": t.source,
            "created_at": t.created_at, "user_id": t.user_id,
            "lines": [{"product_id": l.product_id, "sku": l.product.sku if hasattr(l, "product") else None,
                       "quantity": float(l.quantity)} for l in t.lines]}


def _names(db, org_id):
    return {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == org_id))}


def _decorate(db, org_id, orders):
    names = _names(db, org_id)
    pids = {l.product_id for t in orders for l in t.lines}
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(pids or {0})))}
    out = []
    for t in orders:
        o = _transfer_out(db, t, names)
        o["lines"] = [{"product_id": l.product_id, "sku": prods[l.product_id].sku, "name": prods[l.product_id].name,
                       "quantity": float(l.quantity)} for l in t.lines]
        o["total_qty"] = sum(l["quantity"] for l in o["lines"])
        out.append(o)
    return out


@router.get("/warehouses/{wid}/transfers", tags=["warehouses"])
def warehouse_transfers(wid: int, direction: str = "all", page: int = Query(1, ge=1),
                        user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    _wh(db, user, wid)
    stmt = select(TransferOrder).where(TransferOrder.org_id == user.org_id)
    if direction == "incoming":
        stmt = stmt.where(TransferOrder.to_warehouse_id == wid)
    elif direction == "outgoing":
        stmt = stmt.where(TransferOrder.from_warehouse_id == wid)
    else:
        stmt = stmt.where(or_(TransferOrder.to_warehouse_id == wid, TransferOrder.from_warehouse_id == wid))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(TransferOrder.id.desc()).offset((page - 1) * 15).limit(15)).all()
    return {"total": total, "page": page, "page_size": 15, "items": _decorate(db, user.org_id, rows)}


@router.get("/warehouses/{wid}/adjustments", tags=["warehouses"])
def warehouse_adjustments(wid: int, page: int = Query(1, ge=1), user: User = Depends(require("inventory")),
                          db: Session = Depends(get_db)):
    _wh(db, user, wid)
    stmt = select(StockMovement).where(StockMovement.org_id == user.org_id, StockMovement.warehouse_id == wid,
                                       StockMovement.type.in_(["adjustment", "damage", "opening"]))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(StockMovement.id.desc()).offset((page - 1) * 15).limit(15)).all()
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_({m.product_id for m in rows} or {0})))}
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    return {"total": total, "page": page, "page_size": 15, "items": [
        mv_out(m, lambda m: {"sku": prods[m.product_id].sku, "product": prods[m.product_id].name,
                             "user": users.get(m.user_id)}) for m in rows]}


@router.get("/warehouses/{wid}/activity", tags=["warehouses"])
def warehouse_activity(wid: int, page: int = Query(1, ge=1), user: User = Depends(require("inventory")),
                       db: Session = Depends(get_db)):
    """Merged timeline: stock movements in this warehouse + audit entries about the warehouse itself."""
    w = _wh(db, user, wid)
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    mvs = db.scalars(select(StockMovement).where(StockMovement.org_id == user.org_id, StockMovement.warehouse_id == wid)
                     .order_by(StockMovement.id.desc()).limit(page * 20)).all()
    prods = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_({m.product_id for m in mvs} or {0})))}
    logs = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id, AuditLog.entity == "warehouse",
                                             AuditLog.entity_id == str(wid)).order_by(AuditLog.id.desc())
                      .limit(page * 20)).all()
    ev = [{"kind": "movement", "type": m.type, "when": m.created_at, "user": users.get(m.user_id),
           "text": f"{m.type.replace('_', ' ').title()}: {prods[m.product_id].name} "
                   f"{'+' if m.qty_delta > 0 else ''}{float(m.qty_delta):g}"
                   + (f" ({m.reason})" if m.reason else "") if m.qty_delta != 0 else
                   f"{m.type.title()}: {prods[m.product_id].name} reserved {float(m.reserved_delta):+g}"} for m in mvs]
    ev += [{"kind": "audit", "type": "audit", "when": a.created_at, "user": users.get(a.user_id),
            "text": f"Warehouse {a.action}" + (f" {a.detail}" if a.detail else "")} for a in logs]
    if w.created_at:
        ev.append({"kind": "audit", "type": "audit", "when": w.created_at, "user": None, "text": "Warehouse created"})
    for e in ev:
        e["when"] = whl.aware(e["when"])
    ev.sort(key=lambda e: e["when"], reverse=True)
    return {"total": len(ev), "page": page, "items": ev[(page - 1) * 20: page * 20]}


# ---------- transfer orders ----------
class TLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)


class TransferOrderIn(BaseModel):
    from_warehouse_id: int
    to_warehouse_id: int
    lines: list[TLine] = Field(min_length=1, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=300)


def create_transfer_order(db: Session, user: User, body: TransferOrderIn, source="manual", key: Optional[str] = None):
    """Validates and executes every line atomically; raises on any failure (caller rolls back)."""
    org = org_of(db, user)
    if body.from_warehouse_id == body.to_warehouse_id:
        raise HTTPException(422, "Source and destination warehouses must differ")
    for wid in (body.from_warehouse_id, body.to_warehouse_id):
        w = db.get(Warehouse, wid)
        if not w or w.org_id != user.org_id:
            raise HTTPException(404, "Warehouse not found")
        if not w.is_active:
            raise HTTPException(422, f"Warehouse {w.code} is archived")
    merged: dict[int, Decimal] = {}
    for l in body.lines:
        merged[l.product_id] = merged.get(l.product_id, D(0)) + l.quantity
    order = TransferOrder(org_id=user.org_id, number="TMP", from_warehouse_id=body.from_warehouse_id,
                          to_warehouse_id=body.to_warehouse_id, notes=body.notes, source=source, user_id=user.id)
    db.add(order)
    db.flush()
    order.number = f"TR-{order.id:05d}"
    for pid, qty in sorted(merged.items()):
        db.add(TransferLine(order_id=order.id, product_id=pid, quantity=qty))
        try:
            stk.transfer(db, org, product_id=pid, from_wh=body.from_warehouse_id, to_wh=body.to_warehouse_id, qty=qty,
                         user_id=user.id, reason=body.notes or f"Transfer {order.number}", ref_id=order.id,
                         idempotency_key=f"{key or 'to'}:{order.id}:{pid}")
        except stk.StockError as e:
            raise HTTPException(e.status, str(e))
    audit(db, user, "transfer_order", "transfer", order.id, {"number": order.number, "lines": len(merged),
                                                            "source": source})
    audit(db, user, "transfer_out", "warehouse", body.from_warehouse_id, {"transfer": order.number})
    audit(db, user, "transfer_in", "warehouse", body.to_warehouse_id, {"transfer": order.number})
    db.flush()
    return order


@router.post("/transfers", tags=["transfers"], status_code=201)
def new_transfer(body: TransferOrderIn, user: User = Depends(require("inventory", "w")),
                 db: Session = Depends(get_db)):
    try:
        order = create_transfer_order(db, user, body)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(order)
    return _decorate(db, user.org_id, [order])[0]


@router.get("/transfers", tags=["transfers"])
def list_transfers(warehouse_id: Optional[int] = None, q: Optional[str] = None, page: int = Query(1, ge=1),
                   page_size: int = Query(15, ge=1, le=100), user: User = Depends(require("inventory")),
                   db: Session = Depends(get_db)):
    stmt = select(TransferOrder).where(TransferOrder.org_id == user.org_id)
    if warehouse_id:
        stmt = stmt.where(or_(TransferOrder.from_warehouse_id == warehouse_id,
                              TransferOrder.to_warehouse_id == warehouse_id))
    if q:
        stmt = stmt.where(TransferOrder.number.ilike(f"%{q}%"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(TransferOrder.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return {"total": total, "page": page, "page_size": page_size, "items": _decorate(db, user.org_id, rows)}


# ---------- reconciliation ----------
@router.get("/inventory/reconcile", tags=["inventory"])
def reconcile_ledger(user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    """Proves stock_balances == sum(stock_movements) for this organization (no drift, no negative stock)."""
    from .recon import reconcile
    return reconcile(db, user.org_id)


# ---------- insights ----------
@router.get("/insights", tags=["insights"])
def insights(warehouse_id: Optional[int] = None, user: User = Depends(require("inventory")),
             db: Session = Depends(get_db)):
    if warehouse_id:
        _wh(db, user, warehouse_id)
    return whl.compute_insights(db, user.org_id, warehouse_id)

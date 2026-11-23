"""Packages and shipments.

Flow: confirmed sales order -> package (pack quantities, no stock change) -> shipment (ready to ship) ->
mark SHIPPED (stock is deducted here, reservation released) -> in transit -> out for delivery -> delivered | failed.

Carrier tracking is SIMULATED/manual unless a real carrier integration is configured (see carriers.py); every
status change is recorded as an event with its source so simulated tracking is always clearly identified.
"""
import csv
import io
import os
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from reportlab.graphics.barcode import code128
from reportlab.lib.pagesizes import A6
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
import io as _io

from . import stock as stk
from .api import audit, org_of, require
from .core import get_db, now
from .models import (Customer, Notification, Package, PackageLine, SalesOrder, SalesOrderLine, Shipment, ShipmentEvent, User,
                     Warehouse)
from .pdfdoc import build_pdf
from .sales_api import _so, refresh_status
from .sequences import next_number

router = APIRouter(prefix="/api")
D = Decimal

# status -> allowed next statuses
FLOW = {"ready_to_ship": ["shipped", "cancelled"], "shipped": ["in_transit", "out_for_delivery", "delivered", "failed_delivery"],
        "in_transit": ["out_for_delivery", "delivered", "failed_delivery"], "out_for_delivery": ["delivered", "failed_delivery"],
        "failed_delivery": ["out_for_delivery", "in_transit", "delivered"], "delivered": [], "cancelled": []}
LABEL = {"ready_to_ship": "Ready to ship", "shipped": "Shipped", "in_transit": "In transit", "out_for_delivery": "Out for delivery",
         "delivered": "Delivered", "failed_delivery": "Failed delivery", "cancelled": "Cancelled"}
ADVANCE = {"shipped": "in_transit", "in_transit": "out_for_delivery", "out_for_delivery": "delivered", "failed_delivery": "out_for_delivery"}


def _f(x):
    return float(x) if x is not None else None


# ---------------------------------------------------------------- carriers (honest about what is real)
def carriers():
    """Real providers only count as configured when their credentials are present; none are implemented yet, so even
    a configured provider falls back to manual/simulated tracking and says so."""
    known = [("delhivery", "Delhivery", "DELHIVERY_API_KEY"), ("bluedart", "Blue Dart", "BLUEDART_LICENCE_KEY"), ("shiprocket", "Shiprocket", "SHIPROCKET_TOKEN")]
    out = [{"id": "manual", "name": "Manual / simulated tracking", "configured": True, "live": False,
            "note": "Statuses are entered by your team. 'Simulate' buttons are labelled as simulated."}]
    for cid, name, env in known:
        has = bool(os.getenv(env))
        out.append({"id": cid, "name": name, "configured": has, "live": False,
                    "note": f"Credentials found ({env}) but the live API adapter is not implemented in this build; tracking stays manual." if has
                    else f"Not configured. Set {env} to enable once the adapter is available."})
    return out


@router.get("/integrations/carriers", tags=["shipments"])
def list_carriers(user: User = Depends(require("fulfilment"))):
    return carriers()


# ---------------------------------------------------------------- helpers
def _pkg(db, user, pid, lock=False) -> Package:
    stmt = select(Package).where(Package.id == pid, Package.org_id == user.org_id)
    if lock:
        stmt = stmt.with_for_update()
    p = db.scalars(stmt).first()
    if not p:
        raise HTTPException(404, "Package not found")
    return p


def _shp(db, user, sid, lock=False) -> Shipment:
    stmt = select(Shipment).where(Shipment.id == sid, Shipment.org_id == user.org_id)
    if lock:
        stmt = stmt.with_for_update()
    s = db.scalars(stmt).first()
    if not s:
        raise HTTPException(404, "Shipment not found")
    return s


def _names(db, org_id):
    return {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == org_id))}


def _pkg_out(p: Package, so: SalesOrder, names: dict, detail=False):
    lines_by_id = {l.id: l for l in so.lines}
    out = {"id": p.id, "number": p.number, "so_id": p.so_id, "so_number": so.number, "customer": so.customer.name, "customer_id": so.customer_id,
           "warehouse_id": p.warehouse_id, "warehouse": names.get(p.warehouse_id), "status": p.status, "weight_kg": _f(p.weight_kg),
           "notes": p.notes, "created_at": p.created_at, "units": _f(sum((l.quantity for l in p.lines), D(0))), "item_count": len(p.lines),
           "shipment_id": p.shipment.id if p.shipment else None, "shipment_number": p.shipment.number if p.shipment else None,
           "shipment_status": p.shipment.status if p.shipment else None}
    if detail:
        out["lines"] = [{"id": l.id, "so_line_id": l.so_line_id, "product_id": l.product_id, "quantity": _f(l.quantity),
                         "sku": lines_by_id[l.so_line_id].product.sku, "name": lines_by_id[l.so_line_id].product.name,
                         "unit": lines_by_id[l.so_line_id].product.unit, "ordered": _f(lines_by_id[l.so_line_id].quantity)} for l in p.lines]
    return out


def _shp_out(s: Shipment, so: SalesOrder, detail=False):
    out = {"id": s.id, "number": s.number, "status": s.status, "status_label": LABEL[s.status], "package_id": s.package_id,
           "package_number": s.package.number, "so_id": s.so_id, "so_number": so.number, "customer": so.customer.name, "customer_id": so.customer_id,
           "carrier": s.carrier, "tracking_number": s.tracking_number, "shipping_date": s.shipping_date, "expected_delivery": s.expected_delivery,
           "ship_to": s.ship_to, "tracking_mode": s.tracking_mode, "delivered_at": s.delivered_at, "delivered_to": s.delivered_to,
           "failure_reason": s.failure_reason, "created_at": s.created_at,
           "overdue": bool(s.expected_delivery and s.expected_delivery < date.today() and s.status in ("shipped", "in_transit", "out_for_delivery", "failed_delivery")),
           "units": _f(sum((l.quantity for l in s.package.lines), D(0)))}
    if detail:
        out["events"] = [{"status": e.status, "label": LABEL.get(e.status, e.status), "note": e.note, "location": e.location, "source": e.source,
                          "when": e.occurred_at} for e in s.events]
        out["allowed_next"] = [{"status": n, "label": LABEL[n]} for n in FLOW[s.status]]
    return out


def so_fulfilment(db, so: SalesOrder, names: dict):
    pk = db.scalars(select(Package).where(Package.so_id == so.id).options(selectinload(Package.lines), selectinload(Package.shipment)).order_by(Package.id)).all()
    return [_pkg_out(p, so, names, True) for p in pk]


def void_open_packages(db, so: SalesOrder):
    """Called when a sales order is cancelled before anything shipped."""
    for p in db.scalars(select(Package).where(Package.so_id == so.id, Package.status == "packed").options(selectinload(Package.shipment))):
        p.status = "void"
        if p.shipment and p.shipment.status == "ready_to_ship":
            p.shipment.status = "cancelled"
            p.shipment.events.append(ShipmentEvent(status="cancelled", note="Sales order cancelled", source="manual"))


def shipment_events(db, org_id, customer_id):
    out = []
    for s in db.scalars(select(Shipment).join(SalesOrder, SalesOrder.id == Shipment.so_id).where(Shipment.org_id == org_id, SalesOrder.customer_id == customer_id)):
        out.append({"kind": "shipment", "id": s.so_id, "number": s.number, "date": s.shipping_date or s.created_at.date(), "status": LABEL[s.status], "amount": None, "when": s.created_at})
    return out


# ---------------------------------------------------------------- packages
class PackLine(BaseModel):
    so_line_id: int
    quantity: Decimal = Field(gt=0)


class PackIn(BaseModel):
    lines: list[PackLine] = Field(min_length=1, max_length=200)
    weight_kg: Optional[Decimal] = Field(default=None, ge=0, le=D("100000"))
    notes: Optional[str] = Field(default=None, max_length=300)
    idempotency_key: Optional[str] = Field(default=None, max_length=80)


@router.post("/sales-orders/{sid}/packages", tags=["packages"], status_code=201)
def create_package(sid: int, body: PackIn, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    """Pack quantities of a confirmed order. A package comes from ONE warehouse; no stock moves until it ships."""
    from .core import can
    if not can(user, "sales", "r"):
        raise HTTPException(403, "Your role cannot view sales orders")
    names = _names(db, user.org_id)
    if body.idempotency_key:
        prev = db.scalars(select(Package).where(Package.org_id == user.org_id, Package.client_key == body.idempotency_key)).first()
        if prev:
            return _pkg_out(prev, _so(db, user, prev.so_id), names, True)
    so = _so(db, user, sid, lock=True)
    if so.status not in ("confirmed", "packed"):
        raise HTTPException(409, "Only confirmed orders can be packed" if so.status == "draft" else f"Order is {so.status}; nothing left to pack")
    by_id = {l.id: l for l in so.lines}
    merged: dict[int, Decimal] = {}
    for l in body.lines:
        merged[l.so_line_id] = merged.get(l.so_line_id, D(0)) + l.quantity
    whs = set()
    for lid, qty in merged.items():
        line = by_id.get(lid)
        if not line:
            raise HTTPException(422, "A line doesn't belong to this sales order")
        if qty > line.quantity - line.qty_packed:
            raise HTTPException(422, f"{line.product.name}: only {line.quantity - line.qty_packed:g} left to pack, you entered {qty:g}")
        whs.add(line.warehouse_id)
    if len(whs) > 1:
        raise HTTPException(422, "A package can only contain items from one warehouse; create one package per warehouse")
    pkg = Package(org_id=user.org_id, number=next_number(db, user.org_id, "PKG"), so_id=so.id, warehouse_id=whs.pop(), status="packed",
                  weight_kg=body.weight_kg, notes=body.notes, client_key=body.idempotency_key, packed_by=user.id)
    db.add(pkg)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        prev = db.scalars(select(Package).where(Package.org_id == user.org_id, Package.client_key == body.idempotency_key)).first()
        if prev:
            return _pkg_out(prev, _so(db, user, prev.so_id), names, True)
        raise
    for lid, qty in sorted(merged.items()):
        res = db.execute(update(SalesOrderLine).where(SalesOrderLine.id == lid, SalesOrderLine.qty_packed + qty <= SalesOrderLine.quantity)
                         .values(qty_packed=SalesOrderLine.qty_packed + qty).execution_options(synchronize_session=False))
        if res.rowcount != 1:  # lost a race with another packer: never pack more than was ordered
            db.rollback()
            raise HTTPException(409, f"{by_id[lid].product.name}: the quantity left to pack changed, refresh and try again")
        pkg.lines.append(PackageLine(so_line_id=lid, product_id=by_id[lid].product_id, quantity=qty))
    db.flush()
    db.expire(so)
    so = _so(db, user, sid)
    refresh_status(so)
    audit(db, user, "package", "sales_order", sid, {"package": pkg.number, "lines": len(merged)})
    db.commit()
    return _pkg_out(pkg, so, names, True)


@router.get("/packages", tags=["packages"])
def list_packages(q: Optional[str] = None, status: str = "all", so_id: Optional[int] = None, page: int = Query(1, ge=1),
                  page_size: int = Query(25, ge=1, le=200), user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    stmt = select(Package).where(Package.org_id == user.org_id).join(SalesOrder, SalesOrder.id == Package.so_id).join(Customer, Customer.id == SalesOrder.customer_id)
    if status != "all":
        stmt = stmt.where(Package.status == status)
    if so_id:
        stmt = stmt.where(Package.so_id == so_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Package.number.ilike(like), SalesOrder.number.ilike(like), Customer.name.ilike(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(Package.lines), selectinload(Package.shipment)).order_by(Package.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    names = _names(db, user.org_id)
    sos = {s.id: s for s in db.scalars(select(SalesOrder).where(SalesOrder.id.in_({p.so_id for p in rows} or {0})).options(selectinload(SalesOrder.lines), selectinload(SalesOrder.customer)))}
    counts = dict(db.execute(select(Package.status, func.count()).where(Package.org_id == user.org_id).group_by(Package.status)).all())
    return {"total": total, "page": page, "page_size": page_size, "items": [_pkg_out(p, sos[p.so_id], names) for p in rows], "counts": counts}


@router.get("/packages/{pid}", tags=["packages"])
def get_package(pid: int, user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    p = _pkg(db, user, pid)
    return _pkg_out(p, p_so(db, user, p), _names(db, user.org_id), True)


def p_so(db, user, p):
    return _so(db, user, p.so_id)


@router.post("/packages/{pid}/void", tags=["packages"])
def void_package(pid: int, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    p = _pkg(db, user, pid, lock=True)
    if p.status != "packed":
        raise HTTPException(409, "Only a package that has not shipped can be voided")
    if p.shipment and p.shipment.status != "ready_to_ship":
        raise HTTPException(409, "This package's shipment has already left; it can't be voided")
    so = _so(db, user, p.so_id, lock=True)
    by_id = {l.id: l for l in so.lines}
    for pl in p.lines:
        res = db.execute(update(SalesOrderLine).where(SalesOrderLine.id == pl.so_line_id, SalesOrderLine.qty_packed - pl.quantity >= SalesOrderLine.qty_shipped)
                         .values(qty_packed=SalesOrderLine.qty_packed - pl.quantity).execution_options(synchronize_session=False))
        if res.rowcount != 1:
            db.rollback()
            raise HTTPException(409, f"{by_id[pl.so_line_id].product.name}: packed quantity no longer matches; refresh and try again")
    p.status = "void"
    if p.shipment:
        p.shipment.status = "cancelled"
        p.shipment.events.append(ShipmentEvent(status="cancelled", note="Package voided", source="manual", user_id=user.id))
    db.expire(so)
    so = _so(db, user, p.so_id)
    refresh_status(so)
    audit(db, user, "void_package", "sales_order", so.id, {"package": p.number})
    db.commit()
    return _pkg_out(p, so, _names(db, user.org_id), True)


@router.get("/packages/{pid}/slip.pdf", tags=["packages"])
def packing_slip(pid: int, user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    p = _pkg(db, user, pid)
    so = _so(db, user, p.so_id)
    org, wh = org_of(db, user), db.get(Warehouse, p.warehouse_id)
    by_id = {l.id: l for l in so.lines}
    rows = [[i, f"{by_id[l.so_line_id].product.name}", by_id[l.so_line_id].product.sku, f"{by_id[l.so_line_id].quantity:g}", f"{l.quantity:g} {by_id[l.so_line_id].product.unit}"] for i, l in enumerate(p.lines, start=1)]
    pdf = build_pdf(title="Packing Slip", org={"name": org.name, "gstin": org.gstin, "state": org.state, "address": org.address},
                    meta=[("Package", p.number), ("Order", so.number), ("Date", str(p.created_at.date())), ("Packed from", f"{wh.code} {wh.name}" if wh else "-"),
                          ("Weight", f"{p.weight_kg:g} kg" if p.weight_kg else "-")],
                    parties=[("SHIP TO", (so.ship_to or so.customer.name).split(", "))],
                    columns=["#", "Item", "SKU", "Ordered", "In this package"], rows=rows, col_widths=[8, 80, 36, 24, 36], right_cols=(3, 4), notes=p.notes,
                    footer=f"{p.number} - packing slip (no prices)")
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{p.number}-slip.pdf"'})


# ---------------------------------------------------------------- shipments
class ShipmentIn(BaseModel):
    carrier: str = Field(min_length=2, max_length=80)
    tracking_number: Optional[str] = Field(default=None, max_length=80)
    shipping_date: Optional[date] = None
    expected_delivery: Optional[date] = None


@router.post("/packages/{pid}/shipment", tags=["shipments"], status_code=201)
def create_shipment(pid: int, body: ShipmentIn, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    p = _pkg(db, user, pid, lock=True)
    if p.status != "packed":
        raise HTTPException(409, f"Package is {p.status}")
    if p.shipment:
        raise HTTPException(409, f"This package already has shipment {p.shipment.number}")
    so = _so(db, user, p.so_id)
    if body.shipping_date and body.expected_delivery and body.expected_delivery < body.shipping_date:
        raise HTTPException(422, "Expected delivery can't be before the shipping date")
    s = Shipment(org_id=user.org_id, number=next_number(db, user.org_id, "SHP"), package_id=p.id, so_id=so.id, carrier=body.carrier.strip(),
                 tracking_number=(body.tracking_number or "").strip() or None, shipping_date=body.shipping_date, expected_delivery=body.expected_delivery or so.expected_date,
                 ship_to=so.ship_to, tracking_mode="manual", created_by=user.id)
    s.events.append(ShipmentEvent(status="ready_to_ship", note="Shipment created", source="manual", user_id=user.id))
    db.add(s)
    db.flush()
    audit(db, user, "create", "shipment", s.id, {"number": s.number, "package": p.number})
    db.commit()
    return _shp_out(s, so, True)


@router.get("/shipments", tags=["shipments"])
def list_shipments(q: Optional[str] = None, status: str = "all", page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200),
                   user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    """status: all | active (shipped, in transit, out for delivery) | or any single status."""
    stmt = select(Shipment).where(Shipment.org_id == user.org_id).join(SalesOrder, SalesOrder.id == Shipment.so_id).join(Customer, Customer.id == SalesOrder.customer_id)
    if status == "active":
        stmt = stmt.where(Shipment.status.in_(("shipped", "in_transit", "out_for_delivery")))
    elif status != "all":
        stmt = stmt.where(Shipment.status == status)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Shipment.number.ilike(like), Shipment.tracking_number.ilike(like), SalesOrder.number.ilike(like), Customer.name.ilike(like), Shipment.carrier.ilike(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(Shipment.package).selectinload(Package.lines)).order_by(Shipment.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    sos = {s.id: s for s in db.scalars(select(SalesOrder).where(SalesOrder.id.in_({r.so_id for r in rows} or {0})).options(selectinload(SalesOrder.customer)))}
    counts = dict(db.execute(select(Shipment.status, func.count()).where(Shipment.org_id == user.org_id).group_by(Shipment.status)).all())
    return {"total": total, "page": page, "page_size": page_size, "items": [_shp_out(s, sos[s.so_id]) for s in rows], "counts": counts}


@router.get("/shipments-export.csv", tags=["shipments"])
def export_shipments(user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["number", "order", "customer", "carrier", "tracking", "status", "shipped_on", "expected", "delivered_at", "mode"])
    for s in db.scalars(select(Shipment).where(Shipment.org_id == user.org_id).order_by(Shipment.id)):
        so = db.get(SalesOrder, s.so_id)
        w.writerow([s.number, so.number, so.customer.name, s.carrier, s.tracking_number or "", s.status, s.shipping_date or "", s.expected_delivery or "", s.delivered_at or "", s.tracking_mode])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=shipments.csv"})


@router.get("/shipments/{sid}", tags=["shipments"])
def get_shipment(sid: int, user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    s = _shp(db, user, sid)
    out = _shp_out(s, _so(db, user, s.so_id), True)
    out["package"] = _pkg_out(s.package, _so(db, user, s.so_id), _names(db, user.org_id), True)
    out["carriers"] = carriers()
    return out


class ShipmentPatch(BaseModel):
    carrier: Optional[str] = Field(default=None, min_length=2, max_length=80)
    tracking_number: Optional[str] = Field(default=None, max_length=80)
    shipping_date: Optional[date] = None
    expected_delivery: Optional[date] = None


@router.patch("/shipments/{sid}", tags=["shipments"])
def patch_shipment(sid: int, body: ShipmentPatch, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    s = _shp(db, user, sid, lock=True)
    if s.status in ("delivered", "cancelled"):
        raise HTTPException(409, f"A {s.status} shipment can't be edited")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, (v.strip() or None) if isinstance(v, str) and k == "tracking_number" else v)
    audit(db, user, "update", "shipment", sid, {"fields": list(body.model_dump(exclude_unset=True))})
    db.commit()
    return _shp_out(s, _so(db, user, s.so_id), True)


class StatusIn(BaseModel):
    status: str
    note: Optional[str] = Field(default=None, max_length=300)
    location: Optional[str] = Field(default=None, max_length=120)
    delivered_to: Optional[str] = Field(default=None, max_length=120)
    failure_reason: Optional[str] = Field(default=None, max_length=200)


def _transition(db, user, s: Shipment, to: str, note=None, location=None, delivered_to=None, failure_reason=None, source="manual"):
    if to not in FLOW.get(s.status, []):
        raise HTTPException(409, f"Can't move a shipment from {LABEL[s.status]} to {LABEL.get(to, to)}")
    so = _so(db, user, s.so_id, lock=True)
    by_id = {l.id: l for l in so.lines}
    org = org_of(db, user)
    if to == "shipped":
        if not s.carrier:
            raise HTTPException(422, "Set a carrier before shipping")
        for pl in s.package.lines:  # THE stock deduction: on-hand and the reservation drop together, once per package line
            try:
                stk.apply_movement(db, org, product_id=pl.product_id, warehouse_id=s.package.warehouse_id, type="issue", qty_delta=-pl.quantity,
                                   reserved_delta=-pl.quantity, ref_type="SHP", ref_id=s.id, reason=f"Shipped {s.number} for {so.number}", user_id=user.id,
                                   idempotency_key=f"ship:{s.id}:{pl.id}")
            except stk.StockError as e:
                db.rollback()
                raise HTTPException(e.status, f"Can't ship {s.number}: {e}")
            res = db.execute(update(SalesOrderLine).where(SalesOrderLine.id == pl.so_line_id, SalesOrderLine.qty_shipped + pl.quantity <= SalesOrderLine.qty_packed)
                             .values(qty_shipped=SalesOrderLine.qty_shipped + pl.quantity).execution_options(synchronize_session=False))
            if res.rowcount != 1:
                db.rollback()
                raise HTTPException(409, f"{by_id[pl.so_line_id].product.name}: shipped quantity would exceed packed quantity")
        s.package.status = "shipped"
        s.shipping_date = s.shipping_date or date.today()
    elif to == "delivered":
        for pl in s.package.lines:
            res = db.execute(update(SalesOrderLine).where(SalesOrderLine.id == pl.so_line_id, SalesOrderLine.qty_delivered + pl.quantity <= SalesOrderLine.qty_shipped)
                             .values(qty_delivered=SalesOrderLine.qty_delivered + pl.quantity).execution_options(synchronize_session=False))
            if res.rowcount != 1:
                db.rollback()
                raise HTTPException(409, "Delivered quantity would exceed shipped quantity")
        s.package.status = "delivered"
        s.delivered_at, s.delivered_to = now(), (delivered_to or "").strip() or None
        s.failure_reason = None
    elif to == "failed_delivery":
        if not (failure_reason or note):
            raise HTTPException(422, "Give a reason for the failed delivery")
        s.failure_reason = failure_reason or note
        db.add(Notification(org_id=user.org_id, kind="failed_delivery", dedupe_key=f"shp:{s.id}:failed", title=f"Failed delivery: {s.number}",
                            body=f"{so.number} for {so.customer.name}: {s.failure_reason}"))
    elif to == "cancelled":
        s.package.status = "packed"
    s.status = to
    s.events.append(ShipmentEvent(status=to, note=note or failure_reason, location=location, source=source, user_id=user.id))
    db.flush()
    db.expire(so)
    refresh_status(_so(db, user, s.so_id))
    audit(db, user, "shipment_" + to, "shipment", s.id, {"number": s.number, "source": source})
    db.commit()


@router.post("/shipments/{sid}/status", tags=["shipments"])
def set_status(sid: int, body: StatusIn, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    s = _shp(db, user, sid, lock=True)
    _transition(db, user, s, body.status, body.note, body.location, body.delivered_to, body.failure_reason)
    return _shp_out(s, _so(db, user, s.so_id), True)


@router.post("/shipments/{sid}/simulate-advance", tags=["shipments"])
def simulate_advance(sid: int, user: User = Depends(require("fulfilment", "w")), db: Session = Depends(get_db)):
    """SIMULATED carrier tracking: moves the shipment to its next logical status and records the event as simulated."""
    s = _shp(db, user, sid, lock=True)
    nxt = ADVANCE.get(s.status)
    if not nxt:
        raise HTTPException(409, "There is nothing to simulate from the current status")
    _transition(db, user, s, nxt, note="Simulated tracking update (no carrier connected)", source="simulated", delivered_to="Simulated recipient" if nxt == "delivered" else None)
    return _shp_out(s, _so(db, user, s.so_id), True)


@router.get("/shipments/{sid}/label.pdf", tags=["shipments"])
def shipping_label(sid: int, user: User = Depends(require("fulfilment")), db: Session = Depends(get_db)):
    s = _shp(db, user, sid)
    so = _so(db, user, s.so_id)
    org, wh = org_of(db, user), db.get(Warehouse, s.package.warehouse_id)
    buf = _io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A6)
    w, h = A6
    c.setTitle(f"Label {s.number}")
    c.setFont("Helvetica-Bold", 11); c.drawString(8 * mm, h - 10 * mm, s.carrier.upper()[:30])
    c.setFont("Helvetica", 8); c.drawRightString(w - 8 * mm, h - 10 * mm, f"{s.number}  |  {so.number}")
    c.line(8 * mm, h - 13 * mm, w - 8 * mm, h - 13 * mm)
    c.setFont("Helvetica-Bold", 8); c.drawString(8 * mm, h - 19 * mm, "FROM")
    c.setFont("Helvetica", 9)
    y = h - 24 * mm
    for ln in [org.name, f"{wh.code} {wh.name}" if wh else "", org.address or "", f"GSTIN {org.gstin}" if org.gstin else ""]:
        if ln:
            c.drawString(8 * mm, y, ln[:52]); y -= 4.5 * mm
    c.setFont("Helvetica-Bold", 8); c.drawString(8 * mm, y - 2 * mm, "SHIP TO"); y -= 8 * mm
    c.setFont("Helvetica-Bold", 12)
    parts = (s.ship_to or so.customer.name).split(", ")
    c.drawString(8 * mm, y, parts[0][:34]); y -= 6 * mm
    c.setFont("Helvetica", 10)
    rest = ", ".join(parts[1:])
    for i in range(0, len(rest), 44):
        c.drawString(8 * mm, y, rest[i:i + 44]); y -= 5 * mm
    c.setFont("Helvetica", 8)
    c.drawString(8 * mm, 34 * mm, f"Package {s.package.number}  |  {sum(float(l.quantity) for l in s.package.lines):g} unit(s)" + (f"  |  {s.package.weight_kg:g} kg" if s.package.weight_kg else ""))
    value = s.tracking_number or s.number
    bc = code128.Code128(value, barHeight=14 * mm, barWidth=0.5 * mm)
    bc.drawOn(c, 8 * mm, 16 * mm)
    c.setFont("Helvetica-Bold", 9); c.drawString(8 * mm, 11 * mm, value)
    if s.tracking_mode == "manual":
        c.setFont("Helvetica-Oblique", 6.5); c.drawRightString(w - 8 * mm, 6 * mm, "Tracking entered manually - no live carrier connection")
    c.showPage(); c.save()
    return Response(buf.getvalue(), media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{s.number}-label.pdf"'})

"""Stock service: the ONLY code allowed to change stock_balances.

Every change is an atomic conditional UPDATE (safe under concurrent writers on PostgreSQL and SQLite) plus an
append-only StockMovement row. Callers own the transaction (commit/rollback), so multi-step operations such as
transfers are all-or-nothing.
"""
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from .models import Notification, Organization, Product, StockBalance, StockMovement, Warehouse

D = Decimal


class StockError(Exception):
    def __init__(self, msg: str, status: int = 409):
        super().__init__(msg)
        self.status = status


def _balance(db, org_id, product_id, warehouse_id) -> StockBalance:
    sel = select(StockBalance).where(StockBalance.product_id == product_id, StockBalance.warehouse_id == warehouse_id)
    bal = db.scalars(sel).first()
    if bal:
        return bal
    try:
        with db.begin_nested():
            db.add(StockBalance(org_id=org_id, product_id=product_id, warehouse_id=warehouse_id))
    except IntegrityError:  # concurrent creator won the race
        pass
    return db.scalars(sel).one()


def apply_movement(db, org: Organization, *, product_id: int, warehouse_id: int, type: str,
                   qty_delta=0, reserved_delta=0, unit_cost=None, ref_type=None, ref_id=None,
                   reason=None, idempotency_key=None, user_id=None) -> StockMovement:
    qd, rd = D(str(qty_delta)), D(str(reserved_delta))
    if qd == 0 and rd == 0:
        raise StockError("Quantity must be non-zero", 422)

    if idempotency_key:
        prev = db.scalars(select(StockMovement).where(
            StockMovement.org_id == org.id, StockMovement.idempotency_key == idempotency_key)).first()
        if prev:
            return prev  # duplicate request: no second effect

    prod = db.get(Product, product_id)
    wh = db.get(Warehouse, warehouse_id)
    if not prod or prod.org_id != org.id or not wh or wh.org_id != org.id:
        raise StockError("Product or warehouse not found", 404)
    if prod.is_archived and qd > 0:
        raise StockError("Archived products cannot receive stock", 422)
    if not wh.is_active:
        raise StockError("Warehouse is inactive", 422)

    bal = _balance(db, org.id, product_id, warehouse_id)
    total_before = db.scalar(select(func.coalesce(func.sum(StockBalance.on_hand), 0))
                             .where(StockBalance.product_id == product_id)) or D(0)

    B = StockBalance
    conds = [B.id == bal.id, B.reserved + rd >= 0]
    if not org.allow_negative_stock:
        conds.append(B.on_hand + qd >= 0)
        if qd - rd < 0:  # change lowers available stock
            conds.append(B.on_hand + qd - (B.reserved + rd) >= 0)
    res = db.execute(update(B).where(*conds).values(
        on_hand=B.on_hand + qd, reserved=B.reserved + rd, version=B.version + 1).execution_options(
        synchronize_session=False))
    if res.rowcount != 1:
        db.refresh(bal)
        avail = bal.on_hand - bal.reserved
        raise StockError(f"Insufficient stock for {prod.sku} in {wh.code}: available {avail:g}, requested "
                         f"{(-(qd - rd)):g}")
    db.refresh(bal)

    if qd > 0 and unit_cost is not None and type in ("receipt", "opening", "adjustment", "transfer_in"):
        cost = D(str(unit_cost))
        base = max(total_before, D(0))
        new_total = base + qd
        prod.avg_cost = ((base * (prod.avg_cost or 0)) + qd * cost) / new_total if new_total else cost

    mv = StockMovement(org_id=org.id, product_id=product_id, warehouse_id=warehouse_id, type=type, qty_delta=qd,
                       reserved_delta=rd, on_hand_after=bal.on_hand, reserved_after=bal.reserved,
                       unit_cost=unit_cost if unit_cost is not None else prod.avg_cost, ref_type=ref_type,
                       ref_id=str(ref_id) if ref_id is not None else None, reason=reason,
                       idempotency_key=idempotency_key, user_id=user_id)
    try:
        with db.begin_nested():
            db.add(mv)
    except IntegrityError:  # concurrent duplicate idempotency key
        prev = db.scalars(select(StockMovement).where(
            StockMovement.org_id == org.id, StockMovement.idempotency_key == idempotency_key)).first()
        if prev:
            raise StockError("Duplicate request in progress", 409)
        raise
    _check_low_stock(db, org, prod)
    return mv


def _check_low_stock(db, org, prod: Product):
    avail = db.scalar(select(func.coalesce(func.sum(StockBalance.on_hand - StockBalance.reserved), 0))
                      .where(StockBalance.product_id == prod.id)) or D(0)
    key = f"low:{prod.id}"
    open_n = db.scalars(select(Notification).where(
        Notification.org_id == org.id, Notification.dedupe_key == key, Notification.is_read.is_(False))).first()
    if prod.reorder_point and avail <= prod.reorder_point:
        if not open_n:
            kind = "out_of_stock" if avail <= 0 else "low_stock"
            db.add(Notification(org_id=org.id, kind=kind, dedupe_key=key,
                                title=f"{'Out of stock' if avail <= 0 else 'Low stock'}: {prod.name}",
                                body=f"{prod.sku}: {avail:g} available, reorder point {prod.reorder_point:g}"))
    elif open_n:
        open_n.is_read = True  # recovered above threshold


def transfer(db, org, *, product_id, from_wh, to_wh, qty, user_id=None, reason=None, idempotency_key=None,
             ref_id=None):
    q = D(str(qty))
    if q <= 0:
        raise StockError("Quantity must be positive", 422)
    if from_wh == to_wh:
        raise StockError("Source and destination must differ", 422)
    key = idempotency_key
    out = apply_movement(db, org, product_id=product_id, warehouse_id=from_wh, type="transfer_out", qty_delta=-q,
                         ref_type="transfer", ref_id=ref_id, reason=reason, user_id=user_id,
                         idempotency_key=f"{key}:out" if key else None)
    cost = db.get(Product, product_id).avg_cost
    inn = apply_movement(db, org, product_id=product_id, warehouse_id=to_wh, type="transfer_in", qty_delta=q,
                         unit_cost=cost, ref_type="transfer", ref_id=ref_id, reason=reason, user_id=user_id,
                         idempotency_key=f"{key}:in" if key else None)
    return out, inn


def reserve(db, org, *, product_id, warehouse_id, qty, ref_type, ref_id, user_id=None):
    return apply_movement(db, org, product_id=product_id, warehouse_id=warehouse_id, type="reserve",
                          reserved_delta=D(str(qty)), ref_type=ref_type, ref_id=ref_id, user_id=user_id,
                          idempotency_key=f"reserve:{ref_type}:{ref_id}:{product_id}:{warehouse_id}")


def release(db, org, *, product_id, warehouse_id, qty, ref_type, ref_id, user_id=None):
    return apply_movement(db, org, product_id=product_id, warehouse_id=warehouse_id, type="release",
                          reserved_delta=-D(str(qty)), ref_type=ref_type, ref_id=ref_id, user_id=user_id,
                          idempotency_key=f"release:{ref_type}:{ref_id}:{product_id}:{warehouse_id}")


def adjust_stock(db, org, *, product_id, warehouse_id, mode, quantity, reason, user_id, unit_cost=None, idempotency_key=None):
    """One implementation of manual stock changes. mode: increase | decrease | damage | set (counted quantity).
    Returns the ledger movement. Damaged units leave on-hand and are tracked in the balance's damaged bucket."""
    q = D(str(quantity))
    if mode == "set":
        bal = db.scalars(select(StockBalance).where(StockBalance.product_id == product_id, StockBalance.warehouse_id == warehouse_id,
                                                    StockBalance.org_id == org.id)).first()
        delta = q - (bal.on_hand if bal else D(0))
        if delta == 0:
            raise StockError("Counted quantity equals current stock; nothing to adjust", 422)
    else:
        if q <= 0:
            raise StockError("Quantity must be greater than zero", 422)
        delta = q if mode == "increase" else -q
    if mode == "damage":
        replay = idempotency_key and db.scalars(select(StockMovement.id).where(
            StockMovement.org_id == org.id, StockMovement.idempotency_key == idempotency_key)).first()
        m = apply_movement(db, org, product_id=product_id, warehouse_id=warehouse_id, type="damage", qty_delta=delta,
                           reason=reason, user_id=user_id, idempotency_key=idempotency_key)
        if not replay:
            db.execute(StockBalance.__table__.update().where(StockBalance.product_id == product_id, StockBalance.warehouse_id == warehouse_id)
                       .values(damaged=StockBalance.damaged + q))
        return m
    return apply_movement(db, org, product_id=product_id, warehouse_id=warehouse_id, type="adjustment", qty_delta=delta,
                          unit_cost=unit_cost if delta > 0 else None, reason=reason, user_id=user_id, idempotency_key=idempotency_key)
"""Ledger reconciliation: stock_balances must always equal the sum of stock_movements.

    python -m app.recon [org_id]      (exit code 1 when a mismatch is found)
"""
import sys
from decimal import Decimal

from sqlalchemy import case, func, select

from .models import SalesOrder, SalesOrderLine, StockBalance, StockMovement

D = Decimal


def reconcile(db, org_id: int) -> dict:
    M, B = StockMovement, StockBalance
    ledger = {(p, w): (D(o or 0), D(r or 0), D(d or 0)) for p, w, o, r, d in db.execute(
        select(M.product_id, M.warehouse_id, func.sum(M.qty_delta), func.sum(M.reserved_delta),
               func.sum(case((M.type == "damage", -M.qty_delta), else_=0))).where(M.org_id == org_id)
        .group_by(M.product_id, M.warehouse_id))}
    bal = {(b.product_id, b.warehouse_id): (b.on_hand, b.reserved, b.damaged) for b in
           db.scalars(select(B).where(B.org_id == org_id))}
    bad = []
    for key in sorted(set(ledger) | set(bal)):
        have, want = bal.get(key, (D(0),) * 3), ledger.get(key, (D(0),) * 3)
        if have != want:
            bad.append({"product_id": key[0], "warehouse_id": key[1],
                        "balance": {"on_hand": float(have[0]), "reserved": float(have[1]), "damaged": float(have[2])},
                        "ledger": {"on_hand": float(want[0]), "reserved": float(want[1]), "damaged": float(want[2])}})
    negative = [{"product_id": k[0], "warehouse_id": k[1]} for k, v in bal.items() if v[0] < 0 or v[1] < 0]
    # every reserved unit must belong to an open sales order line (confirmed/packed: quantity - shipped is still held)
    held = {}
    for p, w, q in db.execute(select(SalesOrderLine.product_id, SalesOrderLine.warehouse_id,
                                     func.sum(SalesOrderLine.quantity - SalesOrderLine.qty_shipped))
                              .join(SalesOrder, SalesOrder.id == SalesOrderLine.so_id)
                              .where(SalesOrder.org_id == org_id, SalesOrder.status.in_(["confirmed", "packed"]))
                              .group_by(SalesOrderLine.product_id, SalesOrderLine.warehouse_id)):
        held[(p, w)] = D(q or 0)
    reservation_bad = []
    for key in sorted(set(held) | {k for k, v in bal.items() if v[1] != 0}):
        have, want = bal.get(key, (D(0), D(0), D(0)))[1], held.get(key, D(0))
        if have != want:
            reservation_bad.append({"product_id": key[0], "warehouse_id": key[1], "reserved_in_stock": float(have), "held_by_open_orders": float(want)})
    return {"ok": not bad and not negative and not reservation_bad, "checked": len(set(ledger) | set(bal)), "mismatches": bad,
            "negative_balances": negative, "reservation_mismatches": reservation_bad}


if __name__ == "__main__":
    from .core import SessionLocal
    from .models import Organization
    with SessionLocal() as s:
        orgs = [int(sys.argv[1])] if len(sys.argv) > 1 else [o.id for o in s.scalars(select(Organization))]
        code = 0
        for oid in orgs:
            r = reconcile(s, oid)
            print(f"org {oid}: {'OK' if r['ok'] else 'MISMATCH'} ({r['checked']} product/warehouse pairs)")
            for m in r["mismatches"][:20]:
                print("  ", m)
            code |= 0 if r["ok"] else 1
        sys.exit(code)
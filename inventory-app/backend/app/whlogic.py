"""Read-side warehouse analytics shared by the API, dashboard, insights and the AI assistant.
Status rule (documented): per product+warehouse, available = on_hand - reserved;
  out  : available <= 0
  low  : 0 < available <= product.reorder_point (when a reorder point is set)
  ok   : otherwise
"""
import math
from datetime import timedelta

from sqlalchemy import func, select

from .core import now
from .models import Product, StockBalance, StockMovement, Warehouse

WINDOW_DAYS = 30


def aware(dt):
    """SQLite returns naive datetimes; treat them as UTC so comparisons and sorting are safe on every backend."""
    from datetime import timezone
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def item_rows(db, org_id, warehouse_id=None, include_archived_products=False):
    stmt = (select(StockBalance, Product, Warehouse).join(Product, Product.id == StockBalance.product_id)
            .join(Warehouse, Warehouse.id == StockBalance.warehouse_id).where(StockBalance.org_id == org_id))
    if not include_archived_products:
        stmt = stmt.where(Product.is_archived.is_(False))
    if warehouse_id:
        stmt = stmt.where(StockBalance.warehouse_id == warehouse_id)
    out = []
    for b, p, w in db.execute(stmt.order_by(Product.name)):
        on, res = float(b.on_hand), float(b.reserved)
        av, rp = on - res, float(p.reorder_point or 0)
        status = "out" if av <= 0 else "low" if rp and av <= rp else "ok"
        cost = float(p.avg_cost or 0)
        out.append({"product_id": p.id, "sku": p.sku, "name": p.name, "unit": p.unit, "warehouse_id": w.id,
                    "warehouse": w.code, "on_hand": on, "reserved": res, "damaged": float(b.damaged), "available": av,
                    "reorder_point": rp, "avg_cost": cost, "value": on * cost, "status": status,
                    "selling_price": float(p.selling_price)})
    return out


def summarize(rows):
    return {"products": len(rows), "on_hand": sum(r["on_hand"] for r in rows),
            "reserved": sum(r["reserved"] for r in rows), "available": sum(r["available"] for r in rows),
            "low": sum(1 for r in rows if r["status"] == "low"), "out": sum(1 for r in rows if r["status"] == "out"),
            "value": sum(r["value"] for r in rows)}


def warehouse_summaries(db, org_id):
    rows = item_rows(db, org_id)
    by: dict[int, list] = {}
    for r in rows:
        by.setdefault(r["warehouse_id"], []).append(r)
    res = []
    for w in db.scalars(select(Warehouse).where(Warehouse.org_id == org_id).order_by(Warehouse.code)):
        s = summarize(by.get(w.id, []))
        res.append({"id": w.id, "code": w.code, "name": w.name, "city": w.city, "state": w.state,
                    "address": w.address, "pincode": w.pincode, "contact_name": w.contact_name, "phone": w.phone,
                    "email": w.email, "description": w.description, "is_active": w.is_active, "created_at": w.created_at, **s})
    return res


def outflow(db, org_id, days=WINDOW_DAYS):
    """units sold/issued per (product, warehouse) over the window."""
    since = now() - timedelta(days=days)
    q = (select(StockMovement.product_id, StockMovement.warehouse_id, func.sum(-StockMovement.qty_delta))
         .where(StockMovement.org_id == org_id, StockMovement.type == "issue", StockMovement.created_at >= since)
         .group_by(StockMovement.product_id, StockMovement.warehouse_id))
    return {(p, w): float(t or 0) for p, w, t in db.execute(q)}


def compute_insights(db, org_id, warehouse_id=None):
    rows_all = item_rows(db, org_id)
    out = outflow(db, org_id)
    for r in rows_all:
        r["rate"] = out.get((r["product_id"], r["warehouse_id"]), 0) / WINDOW_DAYS  # units/day
        r["cover"] = r["available"] / r["rate"] if r["rate"] > 0 else None
    scope = lambda r: warehouse_id is None or r["warehouse_id"] == warehouse_id  # noqa: E731

    # --- shortages (days of cover < 14, or already at/under reorder with demand) ---
    shortages = []
    for r in rows_all:
        if not scope(r):
            continue
        if r["rate"] > 0 and (r["cover"] < 14 or r["status"] != "ok"):
            days = max(r["cover"], 0)
            shortages.append({**_ref(r), "available": r["available"], "daily_rate": round(r["rate"], 2),
                              "days_cover": round(days, 1), "severity": "critical" if days < 7 else "warning",
                              "stockout_date": (now() + timedelta(days=days)).date().isoformat()})
    shortages.sort(key=lambda x: x["days_cover"])

    # --- excess & slow ---
    excess, slow = [], []
    for r in rows_all:
        if r["on_hand"] <= 0:
            continue
        rp = r["reorder_point"]
        if r["rate"] > 0:
            target = r["rate"] * 60
            ex = r["available"] - target
            if r["cover"] is not None and r["cover"] > 90 and ex > 0:
                excess.append({**_ref(r), "available": r["available"], "target": round(target, 1),
                               "excess_qty": math.floor(ex), "excess_value": round(ex * r["avg_cost"], 2),
                               "days_cover": round(r["cover"], 0)})
        else:
            if rp and r["available"] > rp * 3:
                ex = r["available"] - rp * 2
                excess.append({**_ref(r), "available": r["available"], "target": rp * 2, "excess_qty": math.floor(ex),
                               "excess_value": round(ex * r["avg_cost"], 2), "days_cover": None})
            slow.append({**_ref(r), "on_hand": r["on_hand"], "value": round(r["value"], 2)})
    excess_all = excess
    excess = [x for x in excess if scope(x | {"warehouse_id": x["warehouse_id"]})]
    slow = [x for x in slow if scope(x)]
    excess.sort(key=lambda x: -x["excess_value"])
    slow.sort(key=lambda x: -x["value"])

    # --- recommended transfers: surplus in one warehouse -> shortage in another ---
    donors: dict[int, list] = {}
    for x in sorted(excess_all, key=lambda x: -x["excess_qty"]):
        donors.setdefault(x["product_id"], []).append(dict(x, left=x["excess_qty"]))
    recs = []
    for r in rows_all:
        pool = donors.get(r["product_id"])
        if not pool:
            continue
        need = max(r["rate"] * 30 - r["available"], r["reorder_point"] - r["available"], 0)
        if need <= 0 or not (r["status"] != "ok" or (r["cover"] is not None and r["cover"] < 14)):
            continue
        for d in pool:
            if d["warehouse_id"] == r["warehouse_id"] or d["left"] <= 0 or need <= 0:
                continue
            qty = math.ceil(min(need, d["left"]))
            if qty <= 0:
                continue
            d["left"] -= qty
            need -= qty
            reason = (f"{r['warehouse']} covers {r['cover']:.0f} days" if r["cover"] is not None
                      else f"{r['warehouse']} is {r['status']}") + f"; {d['warehouse']} holds {d['excess_qty']} surplus"
            recs.append({"product_id": r["product_id"], "sku": r["sku"], "name": r["name"],
                         "from_warehouse_id": d["warehouse_id"], "from_code": d["warehouse"],
                         "to_warehouse_id": r["warehouse_id"], "to_code": r["warehouse"], "quantity": qty,
                         "reason": reason})
    if warehouse_id:
        recs = [x for x in recs if warehouse_id in (x["from_warehouse_id"], x["to_warehouse_id"])]

    # --- predicted company-wide requirements (30 days) ---
    tot: dict[int, dict] = {}
    for r in rows_all:
        t = tot.setdefault(r["product_id"], {"product_id": r["product_id"], "sku": r["sku"], "name": r["name"],
                                              "available": 0.0, "rate": 0.0, "reorder_point": r["reorder_point"]})
        t["available"] += r["available"]
        t["rate"] += r["rate"]
    requirements = []
    for t in tot.values():
        need30 = t["rate"] * 30
        shortfall = max(need30 - t["available"], t["reorder_point"] - t["available"], 0)
        if shortfall > 0 and (t["rate"] > 0 or t["available"] <= t["reorder_point"]):
            requirements.append({"product_id": t["product_id"], "sku": t["sku"], "name": t["name"],
                                 "available": t["available"], "demand_30d": round(need30, 1),
                                 "suggested_order_qty": math.ceil(shortfall)})
    requirements.sort(key=lambda x: -x["suggested_order_qty"])

    # --- anomalies in the last 30 days ---
    anomalies = _anomalies(db, org_id, warehouse_id)

    # --- per-warehouse efficiency & distribution ---
    whs = warehouse_summaries(db, org_id)
    total_value = sum(w["value"] for w in whs) or 1
    total_units = sum(w["on_hand"] for w in whs) or 1
    slow_val: dict[int, float] = {}
    for r in rows_all:
        if r["on_hand"] > 0 and r["rate"] == 0:
            slow_val[r["warehouse_id"]] = slow_val.get(r["warehouse_id"], 0) + r["value"]
    eff = []
    for w in whs:
        if not w["is_active"] or (warehouse_id and w["id"] != warehouse_id):
            continue
        n = w["products"]
        health = (n - w["low"] - w["out"]) / n * 100 if n else 100
        idle = slow_val.get(w["id"], 0) / w["value"] * 100 if w["value"] else 0
        out30 = sum(v for (p, wid), v in out.items() if wid == w["id"])
        eff.append({"warehouse_id": w["id"], "code": w["code"], "name": w["name"], "skus": n,
                    "stock_health_pct": round(health, 1), "idle_value_pct": round(idle, 1),
                    "units_issued_30d": round(out30, 1), "turnover_30d": round(out30 / w["on_hand"], 2) if w["on_hand"] else 0,
                    "score": round(0.6 * health + 0.4 * (100 - idle)),
                    "value_share_pct": round(w["value"] / total_value * 100, 1),
                    "units_share_pct": round(w["on_hand"] / total_units * 100, 1)})
    return {"efficiency": eff, "shortages": shortages[:25], "excess": excess[:25], "slow_moving": slow[:25],
            "recommended_transfers": recs[:25], "requirements": requirements[:25], "anomalies": anomalies,
            "score_formula": "score = 60% stock health (SKUs neither low nor out) + 40% non-idle value (stock with no issues in 30 days counts as idle)",
            "window_days": WINDOW_DAYS}


def _ref(r):
    return {"product_id": r["product_id"], "sku": r["sku"], "name": r["name"], "warehouse_id": r["warehouse_id"],
            "warehouse": r["warehouse"]}


def _anomalies(db, org_id, warehouse_id):
    since = now() - timedelta(days=30)
    hist_since = now() - timedelta(days=90)
    rows = db.execute(select(StockMovement, Product.sku, Product.name, Warehouse.code)
                      .join(Product, Product.id == StockMovement.product_id)
                      .join(Warehouse, Warehouse.id == StockMovement.warehouse_id)
                      .where(StockMovement.org_id == org_id, StockMovement.created_at >= hist_since,
                             StockMovement.type.in_(["issue", "receipt", "adjustment", "damage"]))
                      .order_by(StockMovement.id.desc())).all()
    stats: dict[tuple, list] = {}
    for m, *_ in rows:
        stats.setdefault((m.product_id, m.type), []).append(abs(float(m.qty_delta)))
    flagged = []
    for m, sku, name, code in rows:
        if aware(m.created_at) < since or (warehouse_id and m.warehouse_id != warehouse_id):
            continue
        q = abs(float(m.qty_delta))
        sample = stats[(m.product_id, m.type)]
        why = None
        if len(sample) >= 5:
            mean = sum(sample) / len(sample)
            sd = (sum((x - mean) ** 2 for x in sample) / len(sample)) ** 0.5
            if sd > 0 and q > mean + 2.5 * sd and q > 2 * mean:
                why = f"{m.type} of {q:g} is {q / mean:.1f}x the usual {mean:.1f}"
        before = float(m.on_hand_after) - float(m.qty_delta)
        if not why and m.type in ("adjustment", "damage") and m.qty_delta < 0 and before > 0 and q / before >= 0.5 and q >= 5:
            why = f"{m.type} removed {q / before * 100:.0f}% of stock ({q:g} of {before:g})"
        if why:
            flagged.append({"movement_id": m.id, "sku": sku, "name": name, "warehouse": code, "type": m.type,
                            "qty_delta": float(m.qty_delta), "reason": m.reason, "when": m.created_at, "why": why})
    return flagged[:20]

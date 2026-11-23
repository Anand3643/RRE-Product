"""Reports & analytics. One engine, 20 reports. Every report returns the same shape so the UI, Excel, PDF and CSV
exports are generic:  {columns, rows, totals, chart, ...}.

Definitions (also shown in the UI):
  * Sales    = sales orders in status confirmed/packed/shipped/delivered, by order date.
  * Purchases= purchase orders in status issued/partially_received/received, by order date.
  * Inventory value = on-hand quantity x weighted-average cost.
  * Turnover = cost of goods issued in the period / average inventory value (opening and closing quantity valued at
    current average cost); days of inventory = period days / turnover.
"""
import csv
import io
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import whlogic as whl
from .api import audit, org_of, require
from .core import can, get_db
from .models import (Category, Customer, GoodsReceipt, Payment, Product, PurchaseOrder, PurchaseOrderLine, SalesOrder, SalesOrderLine,
                     Shipment, StockBalance, StockMovement, TransferLine, TransferOrder, User, Vendor, Warehouse)
from .pdfdoc import build_pdf, inr

router = APIRouter(prefix="/api")
D = Decimal
SO_LIVE = ("confirmed", "packed", "shipped", "delivered")
PO_LIVE = ("issued", "partially_received", "received")


class Ctx:
    """Resolved filters + helpers shared by every report."""

    def __init__(self, db, user, date_from, date_to, warehouse_id, product_id, customer_id, vendor_id, group, days, limit):
        self.db, self.user, self.org_id = db, user, user.org_id
        self.date_to = date_to or date.today()
        self.date_from = date_from or (self.date_to - timedelta(days=89))
        if self.date_from > self.date_to:
            raise HTTPException(422, "'From' date is after 'To' date")
        self.warehouse_id, self.product_id, self.customer_id, self.vendor_id = warehouse_id, product_id, customer_id, vendor_id
        self.group, self.days, self.limit = group, days, limit
        self.t0 = datetime.combine(self.date_from, time.min, tzinfo=timezone.utc)
        self.t1 = datetime.combine(self.date_to, time.max, tzinfo=timezone.utc)

    @property
    def period_days(self):
        return (self.date_to - self.date_from).days + 1

    def items(self):  # snapshot rows (product x warehouse) honouring the filters
        rows = whl.item_rows(self.db, self.org_id, self.warehouse_id)
        return [r for r in rows if not self.product_id or r["product_id"] == self.product_id]

    def bucket(self, d) -> str:
        d = d.date() if isinstance(d, datetime) else d
        if self.group == "day":
            return d.isoformat()
        if self.group == "week":
            return (d - timedelta(days=d.weekday())).isoformat()
        return d.strftime("%Y-%m")


def C(key, label, type="text", align=None):
    return {"key": key, "label": label, "type": type, "align": align or ("right" if type in ("number", "money", "percent") else "left")}


def f(x):
    return float(x) if x is not None else 0.0


def totals_of(rows, keys):
    return {k: round(sum(r.get(k) or 0 for r in rows), 2) for k in keys}


# ------------------------------------------------------------------ inventory reports
def stock_summary(x: Ctx):
    agg: dict = {}
    for r in x.items():
        a = agg.setdefault(r["product_id"], {"sku": r["sku"], "name": r["name"], "unit": r["unit"], "on_hand": 0, "reserved": 0, "available": 0, "reorder_point": r["reorder_point"], "value": 0.0})
        for k in ("on_hand", "reserved", "available", "value"):
            a[k] += r[k]
    rows = sorted(agg.values(), key=lambda a: a["name"])
    for a in rows:
        a["status"] = "Out of stock" if a["available"] <= 0 else "Low stock" if a["reorder_point"] and a["available"] <= a["reorder_point"] else "In stock"
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("unit", "Unit"), C("on_hand", "On hand", "number"), C("reserved", "Reserved", "number"), C("available", "Available", "number"), C("reorder_point", "Reorder level", "number"), C("status", "Status", "badge"), C("value", "Value", "money")],
            "rows": rows, "totals": totals_of(rows, ["on_hand", "reserved", "available", "value"]),
            "chart": {"kind": "bar", "x": "name", "series": [{"key": "available", "label": "Available"}, {"key": "reserved", "label": "Reserved"}], "limit": 12}}


def stock_by_warehouse(x: Ctx):
    whs = list(x.db.scalars(select(Warehouse).where(Warehouse.org_id == x.org_id, Warehouse.is_active.is_(True)).order_by(Warehouse.code)))
    if x.warehouse_id:
        whs = [w for w in whs if w.id == x.warehouse_id]
    agg: dict = {}
    for r in x.items():
        a = agg.setdefault(r["product_id"], {"sku": r["sku"], "name": r["name"], "total": 0.0})
        a[r["warehouse"]] = a.get(r["warehouse"], 0) + r["available"]
        a["total"] += r["available"]
    rows = sorted(agg.values(), key=lambda a: a["name"])
    cols = [C("sku", "SKU"), C("name", "Item")] + [C(w.code, w.code, "number") for w in whs] + [C("total", "Total available", "number")]
    return {"columns": cols, "rows": rows, "totals": totals_of(rows, [w.code for w in whs] + ["total"]),
            "chart": {"kind": "stacked", "x": "name", "series": [{"key": w.code, "label": w.code} for w in whs], "limit": 12}}


def low_stock(x: Ctx):
    rows = []
    for r in x.items():
        if r["status"] == "low":
            rows.append({"sku": r["sku"], "name": r["name"], "warehouse": r["warehouse"], "available": r["available"], "reorder_point": r["reorder_point"],
                         "shortfall": round(r["reorder_point"] - r["available"], 3), "value": r["value"]})
    rows.sort(key=lambda a: -a["shortfall"])
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("warehouse", "Warehouse"), C("available", "Available", "number"), C("reorder_point", "Reorder level", "number"), C("shortfall", "Below level by", "number"), C("value", "Stock value", "money")],
            "rows": rows, "totals": totals_of(rows, ["shortfall", "value"]), "chart": {"kind": "bar", "x": "name", "series": [{"key": "available", "label": "Available"}, {"key": "reorder_point", "label": "Reorder level"}], "limit": 12}}


def out_of_stock(x: Ctx):
    last = dict(x.db.execute(select(StockMovement.product_id, func.max(StockMovement.created_at)).where(StockMovement.org_id == x.org_id, StockMovement.type == "issue").group_by(StockMovement.product_id)).all())
    rows = [{"sku": r["sku"], "name": r["name"], "warehouse": r["warehouse"], "reorder_point": r["reorder_point"], "reserved": r["reserved"], "last_sold": (last.get(r["product_id"]).date().isoformat() if last.get(r["product_id"]) else None)}
            for r in x.items() if r["status"] == "out"]
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("warehouse", "Warehouse"), C("reorder_point", "Reorder level", "number"), C("reserved", "Reserved", "number"), C("last_sold", "Last sold", "date")], "rows": rows, "totals": {}, "chart": None}


def inventory_valuation(x: Ctx):
    cats = {c.id: c.name for c in x.db.scalars(select(Category).where(Category.org_id == x.org_id))}
    pc = {p.id: (cats.get(p.category_id) or "Uncategorised", float(p.avg_cost or 0)) for p in x.db.scalars(select(Product).where(Product.org_id == x.org_id))}
    agg: dict = {}
    for r in x.items():
        a = agg.setdefault(r["product_id"], {"sku": r["sku"], "name": r["name"], "category": pc[r["product_id"]][0], "on_hand": 0, "avg_cost": pc[r["product_id"]][1], "value": 0.0})
        a["on_hand"] += r["on_hand"]
        a["value"] += r["value"]
    rows = sorted(agg.values(), key=lambda a: -a["value"])
    bycat: dict = {}
    for a in rows:
        bycat[a["category"]] = bycat.get(a["category"], 0) + a["value"]
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("category", "Category"), C("on_hand", "On hand", "number"), C("avg_cost", "Avg. cost", "money"), C("value", "Value", "money")],
            "rows": rows, "totals": totals_of(rows, ["on_hand", "value"]), "chart": {"kind": "pie", "x": "category", "series": [{"key": "value", "label": "Value"}], "data": [{"category": k, "value": round(v, 2)} for k, v in sorted(bycat.items(), key=lambda kv: -kv[1])]}}


def _movement_agg(x: Ctx):
    q = select(StockMovement).where(StockMovement.org_id == x.org_id, StockMovement.qty_delta != 0)
    if x.warehouse_id:
        q = q.where(StockMovement.warehouse_id == x.warehouse_id)
    if x.product_id:
        q = q.where(StockMovement.product_id == x.product_id)
    opening: dict = {}
    per: dict = {}
    for m in x.db.scalars(q.where(StockMovement.created_at <= x.t1)):
        ca = whl.aware(m.created_at)
        if ca < x.t0:
            opening[m.product_id] = opening.get(m.product_id, 0) + float(m.qty_delta)
        else:
            p = per.setdefault(m.product_id, {k: 0.0 for k in ("received", "issued", "adjusted", "transferred", "damaged")})
            d = float(m.qty_delta)
            key = {"issue": "issued", "receipt": "received", "opening": "received", "adjustment": "adjusted", "damage": "damaged", "transfer_in": "transferred", "transfer_out": "transferred"}.get(m.type, "adjusted")
            p[key] += d
    return opening, per


def inventory_movement(x: Ctx):
    opening, per = _movement_agg(x)
    prods = {p.id: p for p in x.db.scalars(select(Product).where(Product.org_id == x.org_id))}
    rows = []
    for pid in sorted(set(opening) | set(per), key=lambda i: prods[i].name):
        p, o, m = prods[pid], opening.get(pid, 0), per.get(pid, {k: 0.0 for k in ("received", "issued", "adjusted", "transferred", "damaged")})
        close = o + sum(m.values())
        rows.append({"sku": p.sku, "name": p.name, "opening": round(o, 3), "received": round(m["received"], 3), "issued": round(m["issued"], 3), "adjusted": round(m["adjusted"], 3),
                     "damaged": round(m["damaged"], 3), "transferred": round(m["transferred"], 3), "closing": round(close, 3)})
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("opening", "Opening", "number"), C("received", "Received", "number"), C("issued", "Issued (sold)", "number"), C("adjusted", "Adjustments", "number"), C("damaged", "Damaged", "number"), C("transferred", "Transfers (net)", "number"), C("closing", "Closing", "number")],
            "rows": rows, "totals": totals_of(rows, ["opening", "received", "issued", "adjusted", "damaged", "transferred", "closing"]),
            "chart": {"kind": "bar", "x": "name", "series": [{"key": "received", "label": "Received"}, {"key": "issued", "label": "Issued"}], "limit": 12}}


def inventory_turnover(x: Ctx):
    opening, per = _movement_agg(x)
    prods = {p.id: p for p in x.db.scalars(select(Product).where(Product.org_id == x.org_id))}
    cogs: dict = {}
    q = select(StockMovement.product_id, func.sum(-StockMovement.qty_delta * func.coalesce(StockMovement.unit_cost, 0))).where(
        StockMovement.org_id == x.org_id, StockMovement.type == "issue", StockMovement.created_at >= x.t0, StockMovement.created_at <= x.t1)
    if x.warehouse_id:
        q = q.where(StockMovement.warehouse_id == x.warehouse_id)
    for pid, v in x.db.execute(q.group_by(StockMovement.product_id)):
        cogs[pid] = float(v or 0)
    rows = []
    for pid in sorted(set(opening) | set(per) | set(cogs), key=lambda i: prods[i].name):
        p = prods[pid]
        o = opening.get(pid, 0)
        close = o + sum((per.get(pid) or {}).values())
        avg_val = ((o + close) / 2) * float(p.avg_cost or 0)
        ratio = cogs.get(pid, 0) / avg_val if avg_val > 0 else None
        rows.append({"sku": p.sku, "name": p.name, "cogs": round(cogs.get(pid, 0), 2), "avg_value": round(avg_val, 2), "turnover": round(ratio, 2) if ratio is not None else None,
                     "days": round(x.period_days / ratio, 1) if ratio else None})
    rows.sort(key=lambda r: -(r["turnover"] or 0))
    tot_c, tot_v = sum(r["cogs"] for r in rows), sum(r["avg_value"] for r in rows)
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("cogs", "Cost of goods sold", "money"), C("avg_value", "Avg. inventory value", "money"), C("turnover", "Turnover ratio", "number"), C("days", "Days of inventory", "number")],
            "rows": rows, "totals": {"cogs": round(tot_c, 2), "avg_value": round(tot_v, 2), "turnover": round(tot_c / tot_v, 2) if tot_v else 0},
            "chart": {"kind": "bar", "x": "name", "series": [{"key": "turnover", "label": "Turnover"}], "limit": 12},
            "note": f"Turnover = cost of goods issued ÷ average inventory value over {x.period_days} days."}


# ------------------------------------------------------------------ sales
def _sos(x: Ctx):
    q = select(SalesOrder).where(SalesOrder.org_id == x.org_id, SalesOrder.status.in_(SO_LIVE), SalesOrder.order_date >= x.date_from, SalesOrder.order_date <= x.date_to)
    if x.warehouse_id:
        q = q.where(SalesOrder.warehouse_id == x.warehouse_id)
    if x.customer_id:
        q = q.where(SalesOrder.customer_id == x.customer_id)
    return list(x.db.scalars(q))


def _lines(x: Ctx, kind: str):
    if kind == "so":
        q = select(SalesOrderLine, SalesOrder).join(SalesOrder, SalesOrder.id == SalesOrderLine.so_id).where(SalesOrder.org_id == x.org_id, SalesOrder.status.in_(SO_LIVE), SalesOrder.order_date >= x.date_from, SalesOrder.order_date <= x.date_to)
        if x.warehouse_id:
            q = q.where(SalesOrderLine.warehouse_id == x.warehouse_id)
        if x.customer_id:
            q = q.where(SalesOrder.customer_id == x.customer_id)
        if x.product_id:
            q = q.where(SalesOrderLine.product_id == x.product_id)
    else:
        q = select(PurchaseOrderLine, PurchaseOrder).join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id).where(PurchaseOrder.org_id == x.org_id, PurchaseOrder.status.in_(PO_LIVE), PurchaseOrder.order_date >= x.date_from, PurchaseOrder.order_date <= x.date_to)
        if x.warehouse_id:
            q = q.where(PurchaseOrder.warehouse_id == x.warehouse_id)
        if x.vendor_id:
            q = q.where(PurchaseOrder.vendor_id == x.vendor_id)
        if x.product_id:
            q = q.where(PurchaseOrderLine.product_id == x.product_id)
    return x.db.execute(q).all()


def sales_summary(x: Ctx):
    agg: dict = {}
    for s in _sos(x):
        b = agg.setdefault(x.bucket(s.order_date), {"period": x.bucket(s.order_date), "orders": 0, "taxable": 0.0, "tax": 0.0, "shipping": 0.0, "revenue": 0.0})
        b["orders"] += 1
        b["taxable"] += f(s.taxable_total); b["tax"] += f(s.cgst + s.sgst + s.igst); b["shipping"] += f(s.shipping_charge); b["revenue"] += f(s.total)
    rows = [dict(v, avg_order=round(v["revenue"] / v["orders"], 2)) for k, v in sorted(agg.items())]
    for r in rows:
        for k in ("taxable", "tax", "shipping", "revenue"):
            r[k] = round(r[k], 2)
    return {"columns": [C("period", "Period"), C("orders", "Orders", "number"), C("taxable", "Taxable value", "money"), C("tax", "GST", "money"), C("shipping", "Shipping", "money"), C("revenue", "Total sales", "money"), C("avg_order", "Avg. order", "money")],
            "rows": rows, "totals": totals_of(rows, ["orders", "taxable", "tax", "shipping", "revenue"]), "chart": {"kind": "area", "x": "period", "series": [{"key": "revenue", "label": "Total sales"}]}}


def sales_by_customer(x: Ctx):
    custs = {c.id: c for c in x.db.scalars(select(Customer).where(Customer.org_id == x.org_id))}
    agg: dict = {}
    for s in _sos(x):
        a = agg.setdefault(s.customer_id, {"customer": custs[s.customer_id].name, "code": custs[s.customer_id].code, "orders": 0, "revenue": 0.0, "last": s.order_date})
        a["orders"] += 1; a["revenue"] += f(s.total); a["last"] = max(a["last"], s.order_date)
    rows = sorted(({**a, "revenue": round(a["revenue"], 2), "avg_order": round(a["revenue"] / a["orders"], 2), "last": a["last"].isoformat()} for a in agg.values()), key=lambda a: -a["revenue"])
    tot = sum(r["revenue"] for r in rows) or 1
    for r in rows:
        r["share"] = round(r["revenue"] / tot * 100, 1)
    return {"columns": [C("code", "ID"), C("customer", "Customer"), C("orders", "Orders", "number"), C("revenue", "Sales", "money"), C("avg_order", "Avg. order", "money"), C("share", "Share", "percent"), C("last", "Last order", "date")],
            "rows": rows, "totals": totals_of(rows, ["orders", "revenue"]), "chart": {"kind": "bar", "x": "customer", "series": [{"key": "revenue", "label": "Sales"}], "limit": 10}}


def sales_by_product(x: Ctx):
    cost = {p.id: float(p.avg_cost or 0) for p in x.db.scalars(select(Product).where(Product.org_id == x.org_id))}
    agg: dict = {}
    for l, s in _lines(x, "so"):
        a = agg.setdefault(l.product_id, {"sku": l.product.sku, "name": l.product.name, "qty": 0.0, "revenue": 0.0, "cogs": 0.0})
        a["qty"] += f(l.quantity); a["revenue"] += f(l.taxable); a["cogs"] += f(l.quantity) * cost[l.product_id]
    rows = sorted(({**a, "revenue": round(a["revenue"], 2), "cogs": round(a["cogs"], 2), "margin": round(a["revenue"] - a["cogs"], 2), "margin_pct": round((a["revenue"] - a["cogs"]) / a["revenue"] * 100, 1) if a["revenue"] else 0, "avg_price": round(a["revenue"] / a["qty"], 2)} for a in agg.values()), key=lambda a: -a["revenue"])
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("qty", "Units sold", "number"), C("avg_price", "Avg. price", "money"), C("revenue", "Revenue (excl. tax)", "money"), C("cogs", "Cost", "money"), C("margin", "Margin", "money"), C("margin_pct", "Margin %", "percent")],
            "rows": rows, "totals": totals_of(rows, ["qty", "revenue", "cogs", "margin"]), "chart": {"kind": "bar", "x": "name", "series": [{"key": "revenue", "label": "Revenue"}, {"key": "margin", "label": "Margin"}], "limit": 10},
            "note": "Cost uses each item's current weighted-average cost."}


def sales_order_details(x: Ctx):
    rows = [{"order": s.number, "date": s.order_date.isoformat(), "customer": s.customer.name, "status": s.status.title(), "sku": l.product.sku, "item": l.product.name, "qty": f(l.quantity), "shipped": f(l.qty_shipped),
             "rate": f(l.rate), "discount": f(l.discount_amount), "tax": f(l.tax_amount), "amount": f(l.amount)} for l, s in sorted(_lines(x, "so"), key=lambda t: (t[1].order_date, t[1].id), reverse=True)]
    return {"columns": [C("order", "Order"), C("date", "Date", "date"), C("customer", "Customer"), C("status", "Status", "badge"), C("sku", "SKU"), C("item", "Item"), C("qty", "Qty", "number"), C("shipped", "Shipped", "number"), C("rate", "Rate", "money"), C("discount", "Discount", "money"), C("tax", "GST", "money"), C("amount", "Amount", "money")],
            "rows": rows, "totals": totals_of(rows, ["qty", "shipped", "discount", "tax", "amount"]), "chart": None}


# ------------------------------------------------------------------ purchases
def _pos(x: Ctx):
    q = select(PurchaseOrder).where(PurchaseOrder.org_id == x.org_id, PurchaseOrder.status.in_(PO_LIVE), PurchaseOrder.order_date >= x.date_from, PurchaseOrder.order_date <= x.date_to)
    if x.warehouse_id:
        q = q.where(PurchaseOrder.warehouse_id == x.warehouse_id)
    if x.vendor_id:
        q = q.where(PurchaseOrder.vendor_id == x.vendor_id)
    return list(x.db.scalars(q))


def _received_val(po: PurchaseOrder):
    return sum(float(l.amount * l.qty_received / l.quantity) for l in po.lines)


def purchase_summary(x: Ctx):
    agg: dict = {}
    for p in _pos(x):
        b = agg.setdefault(x.bucket(p.order_date), {"period": x.bucket(p.order_date), "orders": 0, "taxable": 0.0, "tax": 0.0, "value": 0.0, "received": 0.0})
        b["orders"] += 1; b["taxable"] += f(p.taxable_total); b["tax"] += f(p.cgst + p.sgst + p.igst); b["value"] += f(p.total); b["received"] += _received_val(p)
    rows = [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in b.items()} for _, b in sorted(agg.items())]
    return {"columns": [C("period", "Period"), C("orders", "Orders", "number"), C("taxable", "Taxable value", "money"), C("tax", "GST", "money"), C("value", "Ordered value", "money"), C("received", "Received value", "money")],
            "rows": rows, "totals": totals_of(rows, ["orders", "taxable", "tax", "value", "received"]), "chart": {"kind": "area", "x": "period", "series": [{"key": "value", "label": "Ordered"}, {"key": "received", "label": "Received"}]}}


def purchases_by_vendor(x: Ctx):
    vends = {v.id: v for v in x.db.scalars(select(Vendor).where(Vendor.org_id == x.org_id))}
    from .purchases_api import _paid, _received_value
    agg: dict = {}
    for p in _pos(x):
        a = agg.setdefault(p.vendor_id, {"vendor": vends[p.vendor_id].name, "code": vends[p.vendor_id].code, "orders": 0, "value": 0.0, "received": 0.0})
        a["orders"] += 1; a["value"] += f(p.total); a["received"] += _received_val(p)
    rows = []
    for vid, a in agg.items():
        rows.append({**a, "value": round(a["value"], 2), "received": round(a["received"], 2), "outstanding": round(float(_received_value(x.db, x.org_id, vid) - _paid(x.db, x.org_id, "vendor", vid)), 2)})
    rows.sort(key=lambda a: -a["value"])
    return {"columns": [C("code", "ID"), C("vendor", "Vendor"), C("orders", "Orders", "number"), C("value", "Ordered value", "money"), C("received", "Received value", "money"), C("outstanding", "Outstanding payable (all time)", "money")],
            "rows": rows, "totals": totals_of(rows, ["orders", "value", "received"]), "chart": {"kind": "bar", "x": "vendor", "series": [{"key": "value", "label": "Ordered"}], "limit": 10}}


def purchase_order_details(x: Ctx):
    rows = [{"order": p.number, "date": p.order_date.isoformat(), "vendor": p.vendor.name, "status": p.status.replace("_", " ").title(), "sku": l.product.sku, "item": l.product.name, "qty": f(l.quantity), "received": f(l.qty_received),
             "rate": f(l.rate), "tax": f(l.tax_amount), "amount": f(l.amount)} for l, p in sorted(_lines(x, "po"), key=lambda t: (t[1].order_date, t[1].id), reverse=True)]
    return {"columns": [C("order", "Order"), C("date", "Date", "date"), C("vendor", "Vendor"), C("status", "Status", "badge"), C("sku", "SKU"), C("item", "Item"), C("qty", "Qty", "number"), C("received", "Received", "number"), C("rate", "Rate", "money"), C("tax", "GST", "money"), C("amount", "Amount", "money")],
            "rows": rows, "totals": totals_of(rows, ["qty", "received", "tax", "amount"]), "chart": None}


# ------------------------------------------------------------------ warehouse
def warehouse_performance(x: Ctx):
    summ = {w["id"]: w for w in whl.warehouse_summaries(x.db, x.org_id) if w["is_active"] and (not x.warehouse_id or w["id"] == x.warehouse_id)}
    inb, out = {}, {}
    for m in x.db.scalars(select(StockMovement).where(StockMovement.org_id == x.org_id, StockMovement.qty_delta != 0, StockMovement.created_at >= x.t0, StockMovement.created_at <= x.t1)):
        d = float(m.qty_delta)
        (inb if d > 0 else out)[m.warehouse_id] = (inb if d > 0 else out).get(m.warehouse_id, 0) + abs(d)
    issued = {}
    for wid, v in x.db.execute(select(StockMovement.warehouse_id, func.sum(-StockMovement.qty_delta)).where(StockMovement.org_id == x.org_id, StockMovement.type == "issue", StockMovement.created_at >= x.t0, StockMovement.created_at <= x.t1).group_by(StockMovement.warehouse_id)):
        issued[wid] = float(v or 0)
    ships = dict(x.db.execute(select(StockMovement.warehouse_id, func.count(func.distinct(StockMovement.ref_id))).where(StockMovement.org_id == x.org_id, StockMovement.ref_type == "SHP", StockMovement.created_at >= x.t0, StockMovement.created_at <= x.t1).group_by(StockMovement.warehouse_id)).all())
    rows = []
    for wid, w in summ.items():
        n = w["products"]
        rows.append({"code": w["code"], "name": w["name"], "skus": n, "units": w["on_hand"], "value": round(w["value"], 2), "health": round((n - w["low"] - w["out"]) / n * 100, 1) if n else 100.0,
                     "low": w["low"], "out": w["out"], "inbound": round(inb.get(wid, 0), 2), "outbound": round(out.get(wid, 0), 2), "shipments": ships.get(wid, 0),
                     "turnover": round(issued.get(wid, 0) / w["on_hand"], 2) if w["on_hand"] else 0})
    return {"columns": [C("code", "Code"), C("name", "Warehouse"), C("skus", "SKUs", "number"), C("units", "Units", "number"), C("value", "Stock value", "money"), C("health", "Stock health", "percent"), C("low", "Low", "number"), C("out", "Out", "number"), C("inbound", "Units in", "number"), C("outbound", "Units out", "number"), C("shipments", "Shipments", "number"), C("turnover", "Units issued ÷ stock", "number")],
            "rows": rows, "totals": totals_of(rows, ["skus", "units", "value", "low", "out", "inbound", "outbound", "shipments"]), "chart": {"kind": "bar", "x": "code", "series": [{"key": "inbound", "label": "Units in"}, {"key": "outbound", "label": "Units out"}]},
            "note": "Stock health = share of SKUs that are neither low nor out of stock."}


def stock_transfer_report(x: Ctx):
    whs = {w.id: w.code for w in x.db.scalars(select(Warehouse).where(Warehouse.org_id == x.org_id))}
    q = select(TransferOrder).where(TransferOrder.org_id == x.org_id, TransferOrder.created_at >= x.t0, TransferOrder.created_at <= x.t1)
    if x.warehouse_id:
        q = q.where((TransferOrder.from_warehouse_id == x.warehouse_id) | (TransferOrder.to_warehouse_id == x.warehouse_id))
    rows = []
    for t in x.db.scalars(q.order_by(TransferOrder.id.desc())):
        lines = [l for l in t.lines if not x.product_id or l.product_id == x.product_id]
        if x.product_id and not lines:
            continue
        rows.append({"number": t.number, "date": whl.aware(t.created_at).date().isoformat(), "from": whs.get(t.from_warehouse_id), "to": whs.get(t.to_warehouse_id), "items": len(lines), "units": round(sum(float(l.quantity) for l in lines), 3), "status": t.status.title(), "source": "AI-prepared" if t.source == "assistant" else "Manual"})
    flow: dict = {}
    for r in rows:
        k = f"{r['from']} → {r['to']}"
        flow[k] = flow.get(k, 0) + r["units"]
    return {"columns": [C("number", "Transfer"), C("date", "Date", "date"), C("from", "From"), C("to", "To"), C("items", "Items", "number"), C("units", "Units", "number"), C("status", "Status", "badge"), C("source", "Source")],
            "rows": rows, "totals": totals_of(rows, ["items", "units"]), "chart": {"kind": "bar", "x": "route", "series": [{"key": "units", "label": "Units moved"}], "data": [{"route": k, "units": v} for k, v in sorted(flow.items(), key=lambda kv: -kv[1])]}}


def warehouse_valuation(x: Ctx):
    cats = {c.id: c.name for c in x.db.scalars(select(Category).where(Category.org_id == x.org_id))}
    pcat = {p.id: cats.get(p.category_id) or "Uncategorised" for p in x.db.scalars(select(Product).where(Product.org_id == x.org_id))}
    names = sorted({pcat[r["product_id"]] for r in x.items()})
    agg: dict = {}
    for r in x.items():
        a = agg.setdefault(r["warehouse"], {"warehouse": r["warehouse"], "units": 0.0, "value": 0.0})
        a["units"] += r["on_hand"]; a["value"] += r["value"]
        a[pcat[r["product_id"]]] = a.get(pcat[r["product_id"]], 0) + r["value"]
    rows = sorted(agg.values(), key=lambda a: -a["value"])
    tot = sum(a["value"] for a in rows) or 1
    for a in rows:
        a["share"] = round(a["value"] / tot * 100, 1)
        for k in list(a):
            if isinstance(a[k], float):
                a[k] = round(a[k], 2)
    return {"columns": [C("warehouse", "Warehouse"), C("units", "Units", "number")] + [C(n, n, "money") for n in names] + [C("value", "Total value", "money"), C("share", "Share", "percent")],
            "rows": rows, "totals": totals_of(rows, ["units", "value"] + names), "chart": {"kind": "stacked", "x": "warehouse", "series": [{"key": n, "label": n} for n in names]}}


# ------------------------------------------------------------------ analytics
def revenue_trend(x: Ctx):
    agg: dict = {}
    for s in _sos(x):
        agg.setdefault(x.bucket(s.order_date), {"period": x.bucket(s.order_date), "sales": 0.0, "purchases": 0.0})["sales"] += f(s.total)
    for p in _pos(x):
        agg.setdefault(x.bucket(p.order_date), {"period": x.bucket(p.order_date), "sales": 0.0, "purchases": 0.0})["purchases"] += f(p.total)
    rows = []
    for k, v in sorted(agg.items()):
        rows.append({"period": k, "sales": round(v["sales"], 2), "purchases": round(v["purchases"], 2), "net": round(v["sales"] - v["purchases"], 2)})
    return {"columns": [C("period", "Period"), C("sales", "Sales", "money"), C("purchases", "Purchases", "money"), C("net", "Sales − purchases", "money")], "rows": rows, "totals": totals_of(rows, ["sales", "purchases", "net"]),
            "chart": {"kind": "line", "x": "period", "series": [{"key": "sales", "label": "Sales"}, {"key": "purchases", "label": "Purchases"}]}}


def best_selling(x: Ctx):
    agg: dict = {}
    for l, s in _lines(x, "so"):
        a = agg.setdefault(l.product_id, {"sku": l.product.sku, "name": l.product.name, "qty": 0.0, "revenue": 0.0, "orders": set()})
        a["qty"] += f(l.quantity); a["revenue"] += f(l.taxable); a["orders"].add(s.id)
    rows = sorted(({"rank": 0, "sku": a["sku"], "name": a["name"], "qty": round(a["qty"], 3), "revenue": round(a["revenue"], 2), "orders": len(a["orders"])} for a in agg.values()), key=lambda r: -r["qty"])[: x.limit]
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return {"columns": [C("rank", "#", "number"), C("sku", "SKU"), C("name", "Item"), C("qty", "Units sold", "number"), C("revenue", "Revenue (excl. tax)", "money"), C("orders", "Orders", "number")], "rows": rows, "totals": totals_of(rows, ["qty", "revenue"]),
            "chart": {"kind": "bar", "x": "name", "series": [{"key": "qty", "label": "Units sold"}], "limit": 10}}


def slow_moving(x: Ctx):
    since = datetime.now(timezone.utc) - timedelta(days=x.days)
    last = dict(x.db.execute(select(StockMovement.product_id, func.max(StockMovement.created_at)).where(StockMovement.org_id == x.org_id, StockMovement.type == "issue").group_by(StockMovement.product_id)).all())
    agg: dict = {}
    for r in x.items():
        if r["on_hand"] <= 0:
            continue
        a = agg.setdefault(r["product_id"], {"sku": r["sku"], "name": r["name"], "on_hand": 0.0, "value": 0.0})
        a["on_hand"] += r["on_hand"]; a["value"] += r["value"]
    rows = []
    for pid, a in agg.items():
        lm = last.get(pid)
        if lm is None or whl.aware(lm) < since:
            rows.append({**a, "value": round(a["value"], 2), "last_sold": whl.aware(lm).date().isoformat() if lm else None, "days_idle": (datetime.now(timezone.utc) - whl.aware(lm)).days if lm else None})
    rows.sort(key=lambda r: -r["value"])
    return {"columns": [C("sku", "SKU"), C("name", "Item"), C("on_hand", "On hand", "number"), C("value", "Stock value", "money"), C("last_sold", "Last sold", "date"), C("days_idle", "Days idle", "number")], "rows": rows, "totals": totals_of(rows, ["on_hand", "value"]),
            "chart": {"kind": "bar", "x": "name", "series": [{"key": "value", "label": "Value tied up"}], "limit": 10}, "note": f"Items in stock with no sale in the last {x.days} days (or never sold)."}


def stock_movement_trend(x: Ctx):
    q = select(StockMovement).where(StockMovement.org_id == x.org_id, StockMovement.qty_delta != 0, StockMovement.created_at >= x.t0, StockMovement.created_at <= x.t1)
    if x.warehouse_id:
        q = q.where(StockMovement.warehouse_id == x.warehouse_id)
    if x.product_id:
        q = q.where(StockMovement.product_id == x.product_id)
    agg: dict = {}
    for m in x.db.scalars(q):
        if m.type in ("transfer_in", "transfer_out") and not x.warehouse_id:
            continue  # internal moves cancel out company-wide
        b = agg.setdefault(x.bucket(m.created_at), {"period": x.bucket(m.created_at), "inbound": 0.0, "outbound": 0.0})
        b["inbound" if m.qty_delta > 0 else "outbound"] += abs(float(m.qty_delta))
    rows = [{"period": k, "inbound": round(v["inbound"], 2), "outbound": round(v["outbound"], 2), "net": round(v["inbound"] - v["outbound"], 2)} for k, v in sorted(agg.items())]
    return {"columns": [C("period", "Period"), C("inbound", "Units in", "number"), C("outbound", "Units out", "number"), C("net", "Net", "number")], "rows": rows, "totals": totals_of(rows, ["inbound", "outbound", "net"]),
            "chart": {"kind": "area", "x": "period", "series": [{"key": "inbound", "label": "Units in"}, {"key": "outbound", "label": "Units out"}]}}


# ------------------------------------------------------------------ catalog
REPORTS: dict[str, dict] = {}


def reg(key, title, group, desc, fn: Callable, needs: list[str], filters: list[str]):
    REPORTS[key] = {"key": key, "title": title, "group": group, "description": desc, "fn": fn, "needs": needs, "filters": filters}


INV = ["products", "inventory"]
reg("stock_summary", "Stock Summary", "Inventory", "On hand, reserved and available stock per item.", stock_summary, INV, ["warehouse", "product"])
reg("stock_by_warehouse", "Stock by Warehouse", "Inventory", "Available quantity of each item in every warehouse.", stock_by_warehouse, INV, ["warehouse", "product"])
reg("low_stock", "Low Stock", "Inventory", "Items at or below their reorder level.", low_stock, INV, ["warehouse", "product"])
reg("out_of_stock", "Out of Stock", "Inventory", "Items with nothing available to sell.", out_of_stock, INV, ["warehouse", "product"])
reg("inventory_valuation", "Inventory Valuation", "Inventory", "Stock value at weighted-average cost, by item and category.", inventory_valuation, INV, ["warehouse", "product"])
reg("inventory_movement", "Inventory Movement", "Inventory", "Opening, received, issued, adjusted and closing quantities for the period.", inventory_movement, INV, ["date", "warehouse", "product"])
reg("inventory_turnover", "Inventory Turnover", "Inventory", "How fast stock turns over: cost of goods sold ÷ average inventory.", inventory_turnover, INV, ["date", "warehouse"])
reg("sales_summary", "Sales Summary", "Sales", "Orders and sales value by day, week or month.", sales_summary, ["sales"], ["date", "warehouse", "customer", "group"])
reg("sales_by_customer", "Sales by Customer", "Sales", "Who buys the most.", sales_by_customer, ["sales"], ["date", "warehouse", "customer"])
reg("sales_by_product", "Sales by Product", "Sales", "Units, revenue and margin per item.", sales_by_product, ["sales"], ["date", "warehouse", "customer", "product"])
reg("sales_order_details", "Sales Order Details", "Sales", "Every sales order line in the period.", sales_order_details, ["sales"], ["date", "warehouse", "customer", "product"])
reg("purchase_summary", "Purchase Summary", "Purchases", "Orders and purchase value by day, week or month.", purchase_summary, ["purchases"], ["date", "warehouse", "vendor", "group"])
reg("purchases_by_vendor", "Purchases by Vendor", "Purchases", "Spend, receipts and outstanding payables per vendor.", purchases_by_vendor, ["purchases"], ["date", "warehouse", "vendor"])
reg("purchase_order_details", "Purchase Order Details", "Purchases", "Every purchase order line in the period.", purchase_order_details, ["purchases"], ["date", "warehouse", "vendor", "product"])
reg("warehouse_performance", "Warehouse Performance", "Warehouse", "Stock health, throughput and turnover per warehouse.", warehouse_performance, ["warehouses", "inventory"], ["date", "warehouse"])
reg("stock_transfers", "Stock Transfer Report", "Warehouse", "Transfers between warehouses in the period.", stock_transfer_report, ["warehouses", "inventory"], ["date", "warehouse", "product"])
reg("warehouse_valuation", "Warehouse Valuation", "Warehouse", "Inventory value per warehouse, split by category.", warehouse_valuation, ["warehouses", "products"], ["warehouse", "product"])
reg("revenue_trend", "Revenue & Purchase Trends", "Analytics", "Sales against purchases over time.", revenue_trend, ["sales", "purchases"], ["date", "warehouse", "group"])
reg("best_selling", "Best-Selling Products", "Analytics", "Top items by units sold.", best_selling, ["sales"], ["date", "warehouse", "customer"])
reg("slow_moving", "Slow-Moving Products", "Analytics", "Stock that has not sold recently.", slow_moving, INV, ["warehouse", "days"])
reg("stock_movement_trend", "Stock Movement Trends", "Analytics", "Units coming in and going out over time.", stock_movement_trend, INV, ["date", "warehouse", "product", "group"])


def _allowed(user: User, rep) -> bool:
    return can(user, "reports", "r") and any(can(user, m, "r") for m in rep["needs"])


@router.get("/reports", tags=["reports"])
def catalog(user: User = Depends(require("reports"))):
    return [{k: r[k] for k in ("key", "title", "group", "description", "filters")} for r in REPORTS.values() if _allowed(user, r)]


def run_report(db, user, key, date_from=None, date_to=None, warehouse_id=None, product_id=None, customer_id=None, vendor_id=None, group="month", days=30, limit=10):
    rep = REPORTS.get(key)
    if not rep:
        raise HTTPException(404, "Unknown report")
    if not _allowed(user, rep):
        raise HTTPException(403, "Your role cannot view this report")
    if group not in ("day", "week", "month"):
        raise HTTPException(422, "group must be day, week or month")
    for model, val, label in ((Warehouse, warehouse_id, "warehouse"), (Product, product_id, "product"), (Customer, customer_id, "customer"), (Vendor, vendor_id, "vendor")):
        if val:
            o = db.get(model, val)
            if not o or o.org_id != user.org_id:
                raise HTTPException(422, f"Unknown {label}")
    x = Ctx(db, user, date_from, date_to, warehouse_id, product_id, customer_id, vendor_id, group, days, limit)
    out = rep["fn"](x)
    out.setdefault("totals", {})
    out.update({"key": key, "title": rep["title"], "group": rep["group"], "description": rep["description"], "filters": rep["filters"],
                "applied": {"date_from": x.date_from.isoformat(), "date_to": x.date_to.isoformat(), "warehouse_id": warehouse_id, "product_id": product_id, "customer_id": customer_id, "vendor_id": vendor_id, "group": group, "days": days},
                "row_count": len(out["rows"]), "generated_at": datetime.now(timezone.utc).isoformat()})
    return out


Q = dict(date_from=Query(None), date_to=Query(None), warehouse_id=Query(None), product_id=Query(None), customer_id=Query(None), vendor_id=Query(None), group=Query("month"), days=Query(30, ge=1, le=730), limit=Query(10, ge=1, le=100))


@router.get("/reports/{key}", tags=["reports"])
def get_report(key: str, date_from: Optional[date] = None, date_to: Optional[date] = None, warehouse_id: Optional[int] = None, product_id: Optional[int] = None,
               customer_id: Optional[int] = None, vendor_id: Optional[int] = None, group: str = "month", days: int = Query(30, ge=1, le=730), limit: int = Query(10, ge=1, le=100),
               user: User = Depends(require("reports")), db: Session = Depends(get_db)):
    return run_report(db, user, key, date_from, date_to, warehouse_id, product_id, customer_id, vendor_id, group, days, limit)


# ------------------------------------------------------------------ exports
def _fmt(col, v):
    if v is None or v == "":
        return "-"
    if col["type"] == "money":
        return inr(v)
    if col["type"] == "percent":
        return f"{v:g}%"
    if col["type"] == "number":
        return f"{v:,.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else f"{v:,}"
    return str(v)


@router.get("/reports/{key}/export.{fmt}", tags=["reports"])
def export_report(key: str, fmt: str, date_from: Optional[date] = None, date_to: Optional[date] = None, warehouse_id: Optional[int] = None, product_id: Optional[int] = None,
                  customer_id: Optional[int] = None, vendor_id: Optional[int] = None, group: str = "month", days: int = Query(30, ge=1, le=730), limit: int = Query(10, ge=1, le=100),
                  user: User = Depends(require("reports")), db: Session = Depends(get_db)):
    if fmt not in ("xlsx", "pdf", "csv"):
        raise HTTPException(404, "Format must be xlsx, pdf or csv")
    r = run_report(db, user, key, date_from, date_to, warehouse_id, product_id, customer_id, vendor_id, group, days, limit)
    cols, rows, tot, ap = r["columns"], r["rows"], r["totals"], r["applied"]
    name = f"{key}-{ap['date_from']}-{ap['date_to']}"
    audit(db, user, "export", "report", key, {"format": fmt, "rows": len(rows)})
    db.commit()
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow([c["label"] for c in cols])
        for row in rows:
            w.writerow([row.get(c["key"], "") if row.get(c["key"]) is not None else "" for c in cols])
        if tot:
            w.writerow(["Total"] + [tot.get(c["key"], "") for c in cols[1:]])
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    if fmt == "xlsx":
        wb = Workbook()
        ws = wb.active
        ws.title = r["title"][:31]
        org = org_of(db, user)
        ws.append([f"{org.name} — {r['title']}"]); ws["A1"].font = Font(bold=True, size=14)
        ws.append([f"Period {ap['date_from']} to {ap['date_to']}" + (f" · {r['note']}" if r.get("note") else "")]); ws["A2"].font = Font(italic=True, color="666666")
        ws.append([])
        ws.append([c["label"] for c in cols])
        for c in ws[4]:
            c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="0F766E"); c.alignment = Alignment(horizontal="center", wrap_text=True)
        for row in rows:
            ws.append([row.get(c["key"]) for c in cols])
        if tot:
            ws.append(["Total"] + [tot.get(c["key"]) for c in cols[1:]])
            for c in ws[ws.max_row]:
                c.font = Font(bold=True)
        for i, c in enumerate(cols, start=1):
            fmt_code = {"money": '#,##0.00', "number": '#,##0.###', "percent": '0.0"%"'}.get(c["type"])
            width = max([len(str(c["label"]))] + [len(str(row.get(c["key"]) if row.get(c["key"]) is not None else "")) for row in rows[:200]]) + 2
            ws.column_dimensions[get_column_letter(i)].width = min(48, max(10, width))
            if fmt_code:
                for cell in ws[get_column_letter(i)][4:]:
                    cell.number_format = fmt_code
        ws.freeze_panes = "A5"
        buf = io.BytesIO()
        wb.save(buf)
        return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
    org = org_of(db, user)
    usable = 267 if len(cols) > 6 else 180
    widths = [max(14, usable / len(cols))] * len(cols)
    pdf = build_pdf(title=r["title"], org={"name": org.name, "gstin": org.gstin, "state": org.state, "address": org.address},
                    meta=[("Period", f"{ap['date_from']} to {ap['date_to']}"), ("Rows", str(len(rows))), ("Generated", r["generated_at"][:16].replace("T", " "))], parties=[],
                    columns=[c["label"] for c in cols], rows=[[_fmt(c, row.get(c["key"])) for c in cols] for row in rows[:1500]], col_widths=widths,
                    right_cols=[i for i, c in enumerate(cols) if c["align"] == "right"], totals=[(k, _fmt(next((c for c in cols if c["key"] == k), {"type": "number"}), v)) for k, v in list(tot.items())[:4]],
                    notes=r.get("note"), footer=f"{r['title']} - generated by StockPilot", landscape_mode=len(cols) > 6)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{name}.pdf"'})


# ------------------------------------------------------------------ dashboard
def dashboard_extras(db, user, date_from, date_to, warehouse_id):
    """Business totals for the dashboard. Everything is computed from live records and filtered by the user's permissions."""
    from .models import AuditLog
    oid = user.org_id
    d_to = date_to or date.today()
    d_from = date_from or (d_to - timedelta(days=179))
    if d_from > d_to:
        raise HTTPException(422, "'From' date is after 'To' date")
    out: dict = {"range": {"date_from": d_from.isoformat(), "date_to": d_to.isoformat(), "warehouse_id": warehouse_id}}
    x = Ctx(db, user, d_from, d_to, warehouse_id, None, None, None, "month", 30, 5)
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == oid))}
    feed = []
    if can(user, "sales", "r"):
        sos = _sos(x)
        out["customers"] = db.scalar(select(func.count(Customer.id)).where(Customer.org_id == oid, Customer.status == "active"))
        out["sales_total"] = round(sum(f(s.total) for s in sos), 2)
        out["sales_orders"] = len(sos)
        pending = db.execute(select(SalesOrder.status, func.count()).where(SalesOrder.org_id == oid).group_by(SalesOrder.status)).all()
        pm = dict(pending)
        out["pending_sales_orders"] = pm.get("confirmed", 0) + pm.get("packed", 0)
        out["draft_sales_orders"] = pm.get("draft", 0)
        top: dict = {}
        for l, s in _lines(x, "so"):
            t = top.setdefault(l.product_id, {"product_id": l.product_id, "name": l.product.name, "sku": l.product.sku, "qty": 0.0, "revenue": 0.0})
            t["qty"] += f(l.quantity); t["revenue"] += f(l.taxable)
        out["best_selling"] = [{**t, "qty": round(t["qty"], 2), "revenue": round(t["revenue"], 2)} for t in sorted(top.values(), key=lambda t: -t["qty"])[:5]]
        for s in db.scalars(select(SalesOrder).where(SalesOrder.org_id == oid).order_by(SalesOrder.id.desc()).limit(6)):
            feed.append({"kind": "Sales order", "number": s.number, "who": s.customer.name, "status": s.status, "amount": f(s.total), "when": s.created_at, "link": f"/sales-orders/{s.id}"})
    if can(user, "purchases", "r"):
        pos = _pos(x)
        out["vendors"] = db.scalar(select(func.count(Vendor.id)).where(Vendor.org_id == oid, Vendor.status == "active"))
        out["purchases_total"] = round(sum(f(p.total) for p in pos), 2)
        out["purchase_orders"] = len(pos)
        pm = dict(db.execute(select(PurchaseOrder.status, func.count()).where(PurchaseOrder.org_id == oid).group_by(PurchaseOrder.status)).all())
        out["pending_purchase_orders"] = pm.get("issued", 0) + pm.get("partially_received", 0)
        for p in db.scalars(select(PurchaseOrder).where(PurchaseOrder.org_id == oid).order_by(PurchaseOrder.id.desc()).limit(6)):
            feed.append({"kind": "Purchase order", "number": p.number, "who": p.vendor.name, "status": p.status, "amount": f(p.total), "when": p.created_at, "link": f"/purchase-orders/{p.id}"})
    if can(user, "fulfilment", "r"):
        out["pending_shipments"] = db.scalar(select(func.count(Shipment.id)).where(Shipment.org_id == oid, Shipment.status.in_(("ready_to_ship", "shipped", "in_transit", "out_for_delivery", "failed_delivery"))))
    if can(user, "sales", "r") or can(user, "purchases", "r"):
        months: dict = {}
        if can(user, "sales", "r"):
            for s in _sos(x):
                months.setdefault(s.order_date.strftime("%Y-%m"), {"period": s.order_date.strftime("%Y-%m"), "sales": 0.0, "purchases": 0.0})["sales"] += f(s.total)
        if can(user, "purchases", "r"):
            for p in _pos(x):
                months.setdefault(p.order_date.strftime("%Y-%m"), {"period": p.order_date.strftime("%Y-%m"), "sales": 0.0, "purchases": 0.0})["purchases"] += f(p.total)
        out["monthly"] = [{**m, "sales": round(m["sales"], 2), "purchases": round(m["purchases"], 2)} for _, m in sorted(months.items())]
        x30 = Ctx(db, user, d_to - timedelta(days=29), d_to, warehouse_id, None, None, None, "day", 30, 5)
        days: dict = {}
        if can(user, "sales", "r"):
            for s in _sos(x30):
                days.setdefault(s.order_date.isoformat(), 0.0)
                days[s.order_date.isoformat()] += f(s.total)
        out["revenue_daily"] = [{"date": (x30.date_from + timedelta(days=i)).isoformat(), "revenue": round(days.get((x30.date_from + timedelta(days=i)).isoformat(), 0.0), 2)} for i in range(30)]
        for pay in db.scalars(select(Payment).where(Payment.org_id == oid, Payment.status == "posted").order_by(Payment.id.desc()).limit(4)):
            if can(user, "purchases" if pay.party_type == "vendor" else "sales", "r"):
                feed.append({"kind": "Payment " + ("made" if pay.party_type == "vendor" else "received"), "number": pay.number, "who": pay.method.replace("_", " "), "status": "posted", "amount": f(pay.amount), "when": pay.created_at, "link": None})
    feed.sort(key=lambda e: whl.aware(e["when"]), reverse=True)
    out["recent_transactions"] = feed[:10]
    if can(user, "users", "r"):
        out["recent_activities"] = [{"id": a.id, "who": users.get(a.user_id), "action": a.action, "entity": a.entity, "entity_id": a.entity_id, "when": a.created_at}
                                    for a in db.scalars(select(AuditLog).where(AuditLog.org_id == oid).order_by(AuditLog.id.desc()).limit(10))]
    return out
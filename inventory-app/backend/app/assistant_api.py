"""AI Warehouse Assistant.

How it works (no LLM is called, nothing is invented):
  1. The message is matched against intents with keyword/pattern rules and product/warehouse names from the DB.
  2. Answers are computed by queries/analytics over live records (whlogic.compute_insights etc.).
  3. Anything that would change data is returned as a *draft* (assistant_drafts, status=pending). Drafts are applied
     only when the user confirms, through the same validated services and permission checks as the manual screens.
"""
import re
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from . import whlogic as whl
from .api import AdjustIn, adjust, audit, require
from .core import can, get_db
from .models import (AssistantDraft, Product, PurchaseRequest, PurchaseRequestLine, StockBalance, StockMovement, User,
                     Warehouse)
from .warehouse_api import TLine, TransferOrderIn, create_transfer_order

router = APIRouter(prefix="/api")
D = Decimal
STOP = {"the", "a", "an", "of", "in", "at", "to", "from", "for", "stock", "units", "unit", "pcs", "how", "many", "much",
        "is", "are", "do", "we", "have", "me", "show", "what", "which", "transfer", "move", "adjust", "and", "on", "my"}


def g(x):
    return f"{x:,.0f}" if abs(x - round(x)) < 1e-9 else f"{x:,.2f}"


def inr(x):
    return "₹" + f"{x:,.0f}"


class Ctx:
    def __init__(self, db: Session, user: User, ctx_wh_id: Optional[int] = None):
        self.db, self.user = db, user
        self.whs = list(db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id, Warehouse.is_active.is_(True))
                                   .order_by(Warehouse.code)))
        self.prods = list(db.scalars(select(Product).where(Product.org_id == user.org_id,
                                                           Product.is_archived.is_(False))))
        # warehouse the user is currently looking at; used as the default scope when the message names none
        self.ctx_wh = next((w for w in self.whs if w.id == ctx_wh_id), None)

    # ---- entity resolution ----
    def find_whs(self, text: str) -> list[Warehouse]:
        hits = []
        for w in self.whs:
            pos = []
            for term in filter(None, [w.code, w.name, w.city]):
                m = re.search(rf"(?<![\w]){re.escape(term.lower())}(?![\w])", text)
                if m:
                    pos.append(m.start())
            if pos:
                hits.append((min(pos), w))
        return [w for _, w in sorted(hits, key=lambda x: x[0])]

    def find_product(self, text: str):
        """returns (product | None, ambiguous_candidates)"""
        for p in sorted(self.prods, key=lambda p: -len(p.sku)):
            if re.search(rf"(?<![\w-]){re.escape(p.sku.lower())}(?![\w-])", text):
                return p, []
        for p in sorted(self.prods, key=lambda p: -len(p.name)):
            if p.name.lower() in text:
                return p, []
        toks = set(re.findall(r"[a-z0-9]+", text)) - STOP
        best, cands = 0.0, []
        for p in self.prods:
            nt = set(re.findall(r"[a-z0-9]+", p.name.lower()))
            inter = len(nt & toks)
            if not inter:
                continue
            sc = inter / len(nt)
            if sc >= 0.5 and sc > best + 1e-9:
                best, cands = sc, [p]
            elif sc >= 0.5 and abs(sc - best) < 1e-9:
                cands.append(p)
        if len(cands) == 1:
            return cands[0], []
        return None, cands[:5]


def qty_in(text: str) -> Optional[float]:
    m = re.search(r"(?<![\w.\-])(\d+(?:\.\d+)?)(?![\w.\-])", text)
    return float(m.group(1)) if m else None


def avail(db, pid, wid) -> tuple[float, float]:
    b = db.scalars(select(StockBalance).where(StockBalance.product_id == pid, StockBalance.warehouse_id == wid)).first()
    return (float(b.on_hand), float(b.reserved)) if b else (0.0, 0.0)


# ---------- drafts ----------
def draft_out(d: AssistantDraft, db=None):
    p = d.payload
    lines, warns = [], []
    names = {}
    if db is not None:
        ws = {w.id: w for w in db.scalars(select(Warehouse).where(Warehouse.org_id == d.org_id))}
        pids = [l["product_id"] for l in p.get("lines", [])] + ([p["product_id"]] if "product_id" in p else [])
        names = {x.id: x for x in db.scalars(select(Product).where(Product.id.in_(pids or [0])))}
    if db is not None and d.kind == "transfer":
        lines = [f"{names[l['product_id']].sku} {names[l['product_id']].name}: {g(float(l['quantity']))}" for l in p["lines"]]
        lines.insert(0, f"From {ws[p['from_warehouse_id']].code} → To {ws[p['to_warehouse_id']].code}")
    elif db is not None and d.kind == "adjustment":
        pr, w = names[p["product_id"]], ws[p["warehouse_id"]]
        oh, rs = avail(db, pr.id, w.id)
        lines = [f"{pr.sku} {pr.name} at {w.code}", f"Mode: {p['mode']}, quantity {g(float(p['quantity']))} "
                 f"(currently {g(oh)} on hand, {g(rs)} reserved)", f"Reason: {p['reason']}"]
    elif db is not None and d.kind == "purchase_request":
        lines = [f"{names[l['product_id']].sku} {names[l['product_id']].name}: {g(float(l['quantity']))}" for l in p["lines"]]
    return {"id": d.id, "kind": d.kind, "title": d.title, "status": d.status, "lines": lines, "warnings": warns,
            "result": d.result}


def make_draft(db, user, kind, title, payload):
    for d in db.scalars(select(AssistantDraft).where(AssistantDraft.user_id == user.id, AssistantDraft.kind == kind,
                                                     AssistantDraft.status == "pending").order_by(AssistantDraft.id.desc())
                        .limit(30)):
        if d.payload == payload:
            return d  # identical pending draft already exists
    d = AssistantDraft(org_id=user.org_id, user_id=user.id, kind=kind, title=title, payload=payload)
    db.add(d)
    db.flush()
    return d


def table(columns, rows):
    return {"columns": columns, "rows": rows}


# ---------- intent handlers ----------
def reply(text, **kw):
    return {"reply": text, "table": kw.get("table"), "drafts": kw.get("drafts", []), "downloads": kw.get("downloads", []),
            "suggestions": kw.get("suggestions", [])}


HELP = ("I answer from your live warehouse data. Try: \"low stock in Mumbai\", \"inventory value by warehouse\", "
        "\"stock of Hex Bolt\", \"compare warehouses\", \"slow moving items\", \"which items will run out soon?\", "
        "\"recommend transfers\", \"transfer 20 Hex Nut M8 from MUM to DEL\", \"adjust Safety Helmet in DEL to 12\", "
        "\"create purchase request for low stock\", \"warehouse report\".")


def handle(c: Ctx, message: str):
    db, user = c.db, c.user
    tl = message.lower().strip()
    if not tl:
        return reply(HELP)
    whs = c.find_whs(tl)
    prod, amb = c.find_product(tl)
    has = lambda *ws: any(re.search(rf"\b{w}", tl) for w in ws)  # noqa: E731
    scope_wh = whs[0] if whs else c.ctx_wh
    sfx = f" in {scope_wh.code}" if scope_wh else ""
    ins = lambda: whl.compute_insights(db, user.org_id, scope_wh.id if scope_wh else None)  # noqa: E731

    # ---- actions (drafts) ----
    if has("transfer", "move", "send", "shift") and not has("recommend", "suggest", "redistribut", "rebalanc", "should", "history", "report", "recent", "pending"):
        return transfer_draft(c, tl, whs, prod, amb)
    if has("adjust", "write.?off", "damaged", "correct", "recount") and not has("history", "recent", "report"):
        return adjust_draft(c, tl, whs, prod, amb)
    if has("purchase request", "purchase req", "raise (a )?request", "reorder", "restock", "order more", "buy more") or \
            (has("create", "make", "prepare") and has("pr\\b", "purchase")):
        return pr_draft(c, tl, prod, amb, ins)

    # ---- reports ----
    if has("report", "export", "csv", "download", "spreadsheet"):
        if not can(user, "reports", "r"):
            return reply(f"Your role ({user.role}) doesn't have access to reports.")
        dl = [{"label": "Warehouse summary report (CSV)", "path": "/warehouses/report.csv", "filename": "warehouse-report.csv"}]
        if scope_wh:
            dl.insert(0, {"label": f"{scope_wh.code} items report (CSV)", "path": f"/warehouses/{scope_wh.id}/items?csv_export=true&page_size=200",
                          "filename": f"{scope_wh.code}-items.csv"})
        return reply("I've prepared these reports from current data. Click to download.", downloads=dl)

    # ---- analytics ----
    if has("recommend", "suggest", "redistribut", "rebalanc", "should (i|we) (move|transfer)") and not has("purchase", "reorder"):
        r = ins()["recommended_transfers"]
        if not r:
            return reply(f"No transfers needed{sfx}: no warehouse has a surplus of an item that another is short of.")
        drafts = []
        for x in r[:5]:
            if can(user, "inventory", "w"):
                pl = {"from_warehouse_id": x["from_warehouse_id"], "to_warehouse_id": x["to_warehouse_id"],
                      "lines": [{"product_id": x["product_id"], "quantity": x["quantity"]}], "notes": "AI-recommended rebalancing"}
                d = make_draft(db, user, "transfer", f"Transfer {x['quantity']} × {x['sku']} {x['from_code']}→{x['to_code']}", pl)
                drafts.append(d)
        db.commit()
        return reply(f"{len(r)} redistribution{'s' if len(r) != 1 else ''} recommended{sfx}. I prepared the top {len(drafts)} as drafts below — nothing moves until you confirm.",
                     table=table(["Product", "From", "To", "Qty", "Why"], [[f"{x['sku']} {x['name']}", x["from_code"], x["to_code"], x["quantity"], x["reason"]] for x in r[:10]]),
                     drafts=[draft_out(d, db) for d in drafts])
    if has("excess", "overstock", "surplus", "too much", "over.?stock"):
        r = ins()["excess"]
        if not r:
            return reply(f"No excess inventory detected{sfx}.")
        tot = sum(x["excess_value"] for x in r)
        return reply(f"{len(r)} items carry excess stock{sfx}, about {inr(tot)} above target. Ask me to \"recommend transfers\" to redistribute.",
                     table=table(["Product", "Warehouse", "Available", "Target", "Excess", "Excess value"], [[f"{x['sku']} {x['name']}", x["warehouse"], g(x["available"]), g(x["target"]), x["excess_qty"], inr(x["excess_value"])] for x in r[:10]]),
                     suggestions=["Recommend transfers"])
    if has("slow", "inactive", "dead", "not moving", "no sales", "idle", "stagnant"):
        r = ins()["slow_moving"]
        if not r:
            return reply(f"Every stocked item{sfx} has had outbound movement in the last {whl.WINDOW_DAYS} days.")
        return reply(f"{len(r)} stocked items{sfx} had no sales/issues in the last {whl.WINDOW_DAYS} days, tying up {inr(sum(x['value'] for x in r))}.",
                     table=table(["Product", "Warehouse", "On hand", "Value"], [[f"{x['sku']} {x['name']}", x["warehouse"], g(x["on_hand"]), inr(x["value"])] for x in r[:12]]))
    if has("run out", "stock.?out", "shortage", "predict", "forecast", "will need", "requirement", "demand", "going to"):
        i = ins()
        s, rq = i["shortages"], i["requirements"]
        if not s and not rq:
            return reply(f"No shortages predicted{sfx} based on the last {whl.WINDOW_DAYS} days of sales.")
        txt = f"{len(s)} item-warehouse combinations{sfx} are predicted to run short (days of cover under 14 at the recent sales rate)."
        if rq:
            txt += f" Company-wide, {len(rq)} products need replenishment within 30 days."
        return reply(txt, table=table(["Product", "Warehouse", "Available", "Per day", "Days left", "Runs out"], [[f"{x['sku']} {x['name']}", x["warehouse"], g(x["available"]), x["daily_rate"], x["days_cover"], x["stockout_date"]] for x in s[:10]]),
                     suggestions=["Create purchase request for low stock", "Recommend transfers"])
    if has("anomal", "unusual", "suspicious", "strange", "odd"):
        r = ins()["anomalies"]
        if not r:
            return reply(f"No unusual stock movements found{sfx} in the last 30 days.")
        return reply(f"{len(r)} unusual movements{sfx} in the last 30 days:",
                     table=table(["Product", "Warehouse", "Type", "Change", "Why flagged"], [[f"{x['sku']} {x['name']}", x["warehouse"], x["type"], g(x["qty_delta"]), x["why"]] for x in r[:10]]))
    if has("compar", "versus", r"\bvs\b", "each warehouse", "all warehouses", "by warehouse", "per warehouse", "across"):
        rows = [w for w in whl.warehouse_summaries(db, user.org_id) if w["is_active"]]
        return reply("Warehouse comparison (live):", table=table(["Warehouse", "Products", "On hand", "Available", "Low", "Out", "Value"], [[f"{w['code']} {w['name']}", w["products"], g(w["on_hand"]), g(w["available"]), w["low"], w["out"], inr(w["value"])] for w in rows]))
    if has("low", "out of stock", "running low", "below reorder", "shortfall") and not prod:
        rows = [r for r in whl.item_rows(db, user.org_id, scope_wh.id if scope_wh else None) if r["status"] != "ok"]
        if not rows:
            return reply(f"No low or out-of-stock items{sfx}. 🎉" if False else f"No low or out-of-stock items{sfx}.")
        rows.sort(key=lambda r: (r["status"] != "out", r["available"]))
        return reply(f"{len(rows)} items are low or out of stock{sfx} ({sum(1 for r in rows if r['status'] == 'out')} out).",
                     table=table(["Product", "Warehouse", "Available", "Reorder pt", "Status"], [[f"{r['sku']} {r['name']}", r["warehouse"], g(r["available"]), g(r["reorder_point"]), r["status"]] for r in rows[:15]]),
                     suggestions=["Create purchase request for low stock", "Recommend transfers"])
    if has("value", "valuation", "worth", "inventory cost"):
        ws = [w for w in whl.warehouse_summaries(db, user.org_id) if w["is_active"]]
        if scope_wh:
            w = next(x for x in ws if x["id"] == scope_wh.id)
            return reply(f"{w['name']} ({w['code']}) holds {g(w['on_hand'])} units valued at {inr(w['value'])} (weighted average cost).")
        return reply(f"Total inventory value is {inr(sum(w['value'] for w in ws))} (weighted average cost) across {len(ws)} warehouses.",
                     table=table(["Warehouse", "Units", "Value"], [[w["code"], g(w["on_hand"]), inr(w["value"])] for w in ws]))
    if has("movement", "activity", "recent", "history", "happened", "latest"):
        stmt = select(StockMovement).where(StockMovement.org_id == user.org_id)
        if scope_wh:
            stmt = stmt.where(StockMovement.warehouse_id == scope_wh.id)
        if prod:
            stmt = stmt.where(StockMovement.product_id == prod.id)
        ms = db.scalars(stmt.order_by(StockMovement.id.desc()).limit(10)).all()
        if not ms:
            return reply("No stock movements match.")
        pn = {p.id: p for p in c.prods}
        wn = {w.id: w for w in c.whs}
        return reply(f"Last {len(ms)} stock movements{sfx}{' for ' + prod.name if prod else ''}:",
                     table=table(["When", "Product", "Warehouse", "Type", "Change"], [[m.created_at.strftime("%d %b %H:%M"), pn[m.product_id].name if m.product_id in pn else m.product_id, wn[m.warehouse_id].code if m.warehouse_id in wn else "", m.type.replace("_", " "), g(float(m.qty_delta)) if m.qty_delta else f"reserved {g(float(m.reserved_delta))}"] for m in ms]))
    if prod or amb:
        if not prod:
            return reply("Which product do you mean?", suggestions=[f"Stock of {p.name}" for p in amb])
        rows = [r for r in whl.item_rows(db, user.org_id) if r["product_id"] == prod.id]
        if scope_wh:
            rows = [r for r in rows if r["warehouse_id"] == scope_wh.id]
        if not rows:
            return reply(f"{prod.name} ({prod.sku}) has no stock recorded{sfx}.")
        return reply(f"{prod.name} ({prod.sku}): {g(sum(r['available'] for r in rows))} available, {g(sum(r['on_hand'] for r in rows))} on hand, {g(sum(r['reserved'] for r in rows))} reserved{sfx}. Reorder point {g(prod.reorder_point)}.",
                     table=table(["Warehouse", "On hand", "Reserved", "Available", "Status"], [[r["warehouse"], g(r["on_hand"]), g(r["reserved"]), g(r["available"]), r["status"]] for r in rows]))
    if has("efficien", "health", "insight", "summary", "overview", "performance", "distribution", "how are we"):
        i = ins()
        e = i["efficiency"]
        txt = (f"Warehouse efficiency (30-day window): " + "; ".join(f"{x['code']} scores {x['score']}/100" for x in e) +
               f". {len(i['shortages'])} shortage risks, {len(i['excess'])} excess items, {len(i['slow_moving'])} slow-moving, {len(i['anomalies'])} anomalies. {i['score_formula']}.")
        return reply(txt, table=table(["Warehouse", "Score", "Stock health %", "Idle value %", "Turnover 30d", "Value share %"], [[x["code"], x["score"], x["stock_health_pct"], x["idle_value_pct"], x["turnover_30d"], x["value_share_pct"]] for x in e]),
                     suggestions=["Recommend transfers", "Slow moving items"])
    if scope_wh:
        w = next(x for x in whl.warehouse_summaries(db, user.org_id) if x["id"] == scope_wh.id)
        return reply(f"{w['name']} ({w['code']}): {w['products']} products, {g(w['on_hand'])} units on hand, {g(w['reserved'])} reserved, {w['low']} low, {w['out']} out of stock, value {inr(w['value'])}.")
    return reply(HELP)


def transfer_draft(c: Ctx, tl, whs, prod, amb):
    db, user = c.db, c.user
    if not can(user, "inventory", "w"):
        return reply(f"Your role ({user.role}) can't create stock transfers.")
    m = re.search(r"\bfrom\b(.*?)\bto\b(.*)", tl)
    src = dst = None
    if m:
        a, b = c.find_whs(m.group(1)), c.find_whs(m.group(2))
        src, dst = (a[0] if a else None), (b[0] if b else None)
    elif len(whs) >= 2:
        src, dst = whs[0], whs[1]
    elif len(whs) == 1 and c.ctx_wh and whs[0].id != c.ctx_wh.id and re.search(r"\bto\b", tl):
        src, dst = c.ctx_wh, whs[0]  # "transfer 10 X to DEL" while viewing BLR => from BLR
    if amb and not prod:
        return reply("Which product should I transfer?", suggestions=[f"Transfer {p.name}" for p in amb])
    qty = qty_in(tl)
    missing = [n for n, v in (("product", prod), ("quantity", qty), ("source warehouse", src), ("destination warehouse", dst)) if not v]
    if missing:
        return reply("To prepare a transfer I still need: " + ", ".join(missing) + ". Example: \"transfer 20 Hex Nut M8 from MUM to DEL\".")
    if src.id == dst.id:
        return reply("Source and destination must be different warehouses.")
    if qty <= 0:
        return reply("Quantity must be greater than zero.")
    oh, rs = avail(db, prod.id, src.id)
    if qty > oh - rs:
        return reply(f"I can't prepare that: {src.code} has only {g(oh - rs)} available of {prod.name} ({g(oh)} on hand, {g(rs)} reserved), but you asked for {g(qty)}.")
    d = make_draft(db, user, "transfer", f"Transfer {g(qty)} × {prod.sku} {src.code}→{dst.code}",
                   {"from_warehouse_id": src.id, "to_warehouse_id": dst.id, "lines": [{"product_id": prod.id, "quantity": qty}], "notes": "Prepared by AI assistant"})
    db.commit()
    return reply(f"Transfer drafted. {src.code} has {g(oh - rs)} available, so this is possible. Review and confirm to apply — until then no stock changes.", drafts=[draft_out(d, db)])


def adjust_draft(c: Ctx, tl, whs, prod, amb):
    db, user = c.db, c.user
    if not can(user, "inventory", "w"):
        return reply(f"Your role ({user.role}) can't adjust stock.")
    if amb and not prod:
        return reply("Which product should I adjust?", suggestions=[f"Adjust {p.name}" for p in amb])
    qty = qty_in(tl)
    wh = whs[0] if whs else c.ctx_wh
    missing = [n for n, v in (("product", prod), ("quantity", qty), ("warehouse", wh)) if v is None]
    if missing:
        return reply("To draft an adjustment I still need: " + ", ".join(missing) + ". Example: \"adjust Safety Helmet in DEL to 12\" or \"write off 3 Hex Nut M8 in MUM damaged\".")
    if re.search(r"\bdamag", tl):
        mode = "damage"
    elif re.search(r"\b(to|set|count(ed)?|recount)\b", tl) and not re.search(r"\b(reduce|decrease|remove|add|increase)\b", tl):
        mode = "set"
    elif re.search(r"\b(increase|add|found|plus|\+)\b", tl):
        mode = "increase"
    else:
        mode = "decrease"
    oh, rs = avail(db, prod.id, wh.id)
    if mode in ("decrease", "damage") and qty > oh - rs:
        return reply(f"I can't prepare that: only {g(oh - rs)} of {prod.name} is available in {wh.code} ({g(rs)} reserved).")
    if mode == "set" and qty < rs:
        return reply(f"Counted quantity {g(qty)} is below the {g(rs)} units reserved in {wh.code}.")
    if mode == "set" and qty == oh:
        return reply(f"{prod.name} in {wh.code} already shows {g(oh)}; nothing to adjust.")
    reason = {"damage": "Marked damaged (AI-assisted)", "set": "Cycle count (AI-assisted)", "increase": "Stock increase (AI-assisted)", "decrease": "Stock decrease (AI-assisted)"}[mode]
    d = make_draft(db, user, "adjustment", f"Adjust {prod.sku} in {wh.code} ({mode} {g(qty)})",
                   {"product_id": prod.id, "warehouse_id": wh.id, "mode": mode, "quantity": qty, "reason": reason})
    db.commit()
    return reply("Adjustment drafted. Review the details and confirm to apply.", drafts=[draft_out(d, db)])


def pr_draft(c: Ctx, tl, prod, amb, ins):
    db, user = c.db, c.user
    if not can(user, "purchases", "w"):
        return reply(f"Your role ({user.role}) can't raise purchase requests. A manager or admin can.")
    qty = qty_in(tl)
    if prod and qty:
        lines = [{"product_id": prod.id, "quantity": qty}]
    elif amb and not prod:
        return reply("Which product is the request for?", suggestions=[f"Purchase request {p.name}" for p in amb])
    else:
        req = ins()["requirements"]
        if not req:
            return reply("Nothing needs replenishment right now — no product is below its reorder point or forecast to run short in 30 days.")
        lines = [{"product_id": x["product_id"], "quantity": x["suggested_order_qty"]} for x in req[:15]]
    d = make_draft(db, user, "purchase_request", f"Purchase request ({len(lines)} item{'s' if len(lines) != 1 else ''})",
                   {"lines": lines, "notes": "Prepared by AI assistant"})
    db.commit()
    return reply(f"Purchase request drafted with {len(lines)} line(s), sized from the 30-day demand forecast and reorder points. Confirm to create it.", drafts=[draft_out(d, db)])


# ---------- endpoints ----------
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    warehouse_id: Optional[int] = None  # the warehouse page the user is on, if any


@router.post("/assistant/chat", tags=["assistant"])
def chat(body: ChatIn, user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    return handle(Ctx(db, user, body.warehouse_id), body.message)


@router.get("/assistant/drafts", tags=["assistant"])
def drafts(user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    rows = db.scalars(select(AssistantDraft).where(AssistantDraft.user_id == user.id, AssistantDraft.status == "pending")
                      .order_by(AssistantDraft.id.desc()).limit(20)).all()
    return [draft_out(d, db) for d in rows]


def _own_draft(db, user, did) -> AssistantDraft:
    d = db.get(AssistantDraft, did)
    if not d or d.org_id != user.org_id or d.user_id != user.id:
        raise HTTPException(404, "Draft not found")
    return d


@router.post("/assistant/drafts/{did}/dismiss", tags=["assistant"])
def dismiss(did: int, user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    d = _own_draft(db, user, did)
    if d.status != "pending":
        raise HTTPException(409, f"Draft already {d.status}")
    d.status = "dismissed"
    db.commit()
    return draft_out(d, db)


@router.post("/assistant/drafts/{did}/confirm", tags=["assistant"])
def confirm(did: int, user: User = Depends(require("inventory")), db: Session = Depends(get_db)):
    d = _own_draft(db, user, did)
    need = "purchases" if d.kind == "purchase_request" else "inventory"
    if not can(user, need, "w"):
        raise HTTPException(403, f"Your role ({user.role}) cannot confirm this action")
    claimed = db.execute(update(AssistantDraft).where(AssistantDraft.id == did, AssistantDraft.status == "pending")
                         .values(status="confirmed").execution_options(synchronize_session=False))
    if claimed.rowcount != 1:  # double-click / second tab: never run twice
        db.rollback()
        raise HTTPException(409, "This draft was already handled")
    try:
        p = d.payload
        if d.kind == "transfer":
            order = create_transfer_order(db, user, TransferOrderIn(
                from_warehouse_id=p["from_warehouse_id"], to_warehouse_id=p["to_warehouse_id"],
                lines=[TLine(**l) for l in p["lines"]], notes=p.get("notes")), source="assistant", key=f"draft{did}")
            result = {"number": order.number, "id": order.id}
            audit(db, user, "ai_confirm", "draft", did, {"kind": d.kind, "result": result})
            db.commit()
        elif d.kind == "adjustment":
            m = adjust(body=AdjustIn(product_id=p["product_id"], warehouse_id=p["warehouse_id"], mode=p["mode"],
                                     quantity=D(str(p["quantity"])), reason=p["reason"], idempotency_key=f"draft:{did}"),
                       user=user, db=db)  # commits internally after audit
            result = {"movement_id": m["id"]}
        elif d.kind == "purchase_request":
            pr = PurchaseRequest(org_id=user.org_id, number="TMP", notes=p.get("notes"), source="assistant", user_id=user.id)
            db.add(pr)
            db.flush()
            pr.number = f"PR-{pr.id:05d}"
            for l in p["lines"]:
                prod = db.get(Product, l["product_id"])
                if not prod or prod.org_id != user.org_id or float(l["quantity"]) <= 0:
                    raise HTTPException(422, "Invalid line in purchase request")
                db.add(PurchaseRequestLine(request_id=pr.id, product_id=prod.id, quantity=D(str(l["quantity"]))))
            audit(db, user, "ai_confirm", "draft", did, {"kind": d.kind, "number": pr.number})
            result = {"number": pr.number, "id": pr.id}
            db.commit()
        else:
            raise HTTPException(422, "Unknown draft type")
    except Exception:
        db.rollback()  # also un-claims the draft so it can be retried after fixing the cause
        raise
    d = db.get(AssistantDraft, did)
    d.status, d.result = "confirmed", result
    db.commit()
    return draft_out(d, db)


@router.get("/purchase-requests", tags=["assistant"])
def purchase_requests(user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    rows = db.scalars(select(PurchaseRequest).where(PurchaseRequest.org_id == user.org_id)
                      .order_by(PurchaseRequest.id.desc()).limit(50)).all()
    pn = {p.id: p for p in db.scalars(select(Product).where(Product.org_id == user.org_id))}
    return [{"id": r.id, "number": r.number, "status": r.status, "source": r.source, "created_at": r.created_at,
             "lines": [{"sku": pn[l.product_id].sku, "name": pn[l.product_id].name, "quantity": float(l.quantity)} for l in r.lines]}
            for r in rows]

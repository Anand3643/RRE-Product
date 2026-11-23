"""Product assistant for portal users.

It is a rule-based assistant, NOT a language model: it understands a fixed set of question types (availability, price,
details, comparison, budget / cheapest, "what do you have", order status, payment / delivery questions) and answers them
from live StockPilot data. It only ever uses customer-safe fields (selling price, GST rate, availability, description) and
the caller's own orders - never costs, vendors, margins, other customers or staff-only data.
"""
import re
import time
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .api import current_user
from .core import get_db
from .models import Category, Customer, Product, SalesOrder, Shipment, StockBalance, User

router = APIRouter(prefix="/api/portal/assistant", tags=["portal-assistant"])
STOP = set("""a an the is are was were be do does did can could would should will you your yours i me my we our us it its this that these those
of for to in on at by with from and or but if so as about any some all there here what which who whom how why when where whats what's
please tell show give find get want need looking look search have has had having got available availability stock instock price prices cost costs
much many cheap cheapest expensive compare compared vs versus difference between details detail info information describe description buy
purchase order orders add cart list items item product products catalogue catalog sell selling sold left quantity qty piece pieces pcs unit units
under below less than within budget rupees rs inr over above more most least lowest highest best good hello hi hey thanks thank ok okay yes no""".split())
_RATE: dict[int, list[float]] = {}


def _tokens(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9][a-z0-9\-\.]*", s.lower().replace("₹", " ")) if w]


def _stem(w: str) -> str:
    w = w.strip(".-")
    return w[:-2] if w.endswith("es") and len(w) > 4 else w[:-1] if w.endswith("s") and len(w) > 3 else w


def _money(v) -> str:
    return "₹" + f"{float(v):,.2f}"


def _qty(v: float, unit: str) -> str:
    return f"{v:g} {unit}"


class AskIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    context_product_id: Optional[int] = None      # the product discussed last, for follow-ups such as "and its price?"


def _catalogue(db, org_id):
    cats = {c.id: c.name for c in db.scalars(select(Category).where(Category.org_id == org_id))}
    avail = {r[0]: float(r[1] or 0) for r in db.execute(select(StockBalance.product_id, func.sum(StockBalance.on_hand - StockBalance.reserved))
                                                           .where(StockBalance.org_id == org_id).group_by(StockBalance.product_id)).all()}
    out = []
    for p in db.scalars(select(Product).where(Product.org_id == org_id, Product.is_archived.is_(False), Product.status == "active").limit(5000)):
        a = max(avail.get(p.id, 0.0), 0.0)
        name_t = {_stem(t) for t in _tokens(p.name) if t not in STOP}
        extra_t = {_stem(t) for t in _tokens(" ".join(filter(None, [p.brand, cats.get(p.category_id)]))) if t not in STOP}
        desc_t = {_stem(t) for t in _tokens(p.description or "") if t not in STOP}
        out.append({"id": p.id, "sku": p.sku, "name": p.name, "description": p.description or "", "brand": p.brand, "category": cats.get(p.category_id), "unit": p.unit,
                    "price": float(p.selling_price), "tax_rate": float(p.tax_rate), "hsn": p.hsn_code, "available": a, "reorder": float(p.reorder_point or 0),
                    "name_t": name_t, "extra_t": extra_t, "desc_t": desc_t})
    return out


def _state(p) -> str:
    return "out_of_stock" if p["available"] <= 0 else "low_stock" if p["reorder"] and p["available"] <= p["reorder"] else "in_stock"


def _card(p) -> dict:
    return {"id": p["id"], "sku": p["sku"], "name": p["name"], "price": p["price"], "tax_rate": p["tax_rate"], "unit": p["unit"], "available": p["available"],
            "availability": _state(p), "description": p["description"][:140]}


def _match(msg: str, cat: list[dict], limit=5) -> list[dict]:
    low = msg.lower()
    q = {_stem(t) for t in _tokens(msg) if t not in STOP and not re.fullmatch(r"[\d\.]+", t)}
    scored = []
    for p in cat:
        if re.search(rf"(?<![a-z0-9]){re.escape(p['sku'].lower())}(?![a-z0-9])", low):
            scored.append((100.0, p))
            continue
        hit = q & (p["name_t"] | p["extra_t"])
        hit_d = q & p["desc_t"]
        if not hit and not hit_d:
            continue
        name_cov = len(q & p["name_t"]) / max(len(p["name_t"]), 1)
        query_cov = (len(hit) + 0.5 * len(hit_d - hit)) / max(len(q), 1)
        s = max(name_cov * 10, query_cov * 8) + 2 * query_cov + 0.3 * len(hit_d)
        if s >= 4.0:
            scored.append((s, p))
    scored.sort(key=lambda x: (-x[0], x[1]["name"]))
    return [p for _, p in scored[:limit]]


def _line(p, price=True, stock=True) -> str:
    bits = [f"{p['name']} ({p['sku']})"]
    if price:
        bits.append(f"{_money(p['price'])} per {p['unit']} + {p['tax_rate']:g}% GST")
    if stock:
        st = _state(p)
        bits.append("out of stock" if st == "out_of_stock" else f"{'only ' if st == 'low_stock' else ''}{_qty(p['available'], p['unit'])} available")
    return " — ".join(bits)


def _alternatives(p, cat) -> list[dict]:
    alt = [(len(p["name_t"] & o["name_t"]) + (2 if p["category"] and p["category"] == o["category"] else 0), o) for o in cat
           if o["id"] != p["id"] and o["available"] > 0]
    alt = [(s, o) for s, o in alt if s > 0]
    alt.sort(key=lambda x: (-x[0], x[1]["price"]))
    return [o for _, o in alt[:3]]


def _price_limit(msg: str) -> Optional[float]:
    m = re.search(r"(?:under|below|less than|within|upto|up to|max(?:imum)?|budget(?: of)?)\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)", msg.lower()) or re.search(r"(?:₹|rs\.?\s*)([\d,]+(?:\.\d+)?)", msg.lower())
    return float(m.group(1).replace(",", "")) if m else None


def _orders_answer(db, user, msg) -> Optional[dict]:
    c = db.get(Customer, user.customer_id) if user.customer_id else None
    if not c:
        return {"text": "Your account isn't linked to a customer record yet, so I can't look up orders. Please raise a request under Support."}
    mnum = re.search(r"\b(SO-?\d+)\b", msg, re.I)
    q = select(SalesOrder).where(SalesOrder.org_id == user.org_id, SalesOrder.customer_id == c.id, SalesOrder.status != "draft")
    if mnum:
        num = mnum.group(1).upper()
        num = num if "-" in num else num[:2] + "-" + num[2:]
        rows = db.scalars(q.where(SalesOrder.number == num)).all()
        if not rows:
            return {"text": f"I couldn't find order {num} on your account. Open My orders to see all your orders."}
    else:
        rows = db.scalars(q.order_by(SalesOrder.id.desc()).limit(3)).all()
        if not rows:
            return {"text": "You haven't placed any orders yet. Add products to your cart and check out whenever you're ready."}
    lines = []
    for o in rows:
        ships = db.scalars(select(Shipment).where(Shipment.so_id == o.id).order_by(Shipment.id)).all()
        s = f"{o.number}: {o.status}, {_money(o.total)}, placed {o.order_date:%d %b %Y}"
        if o.expected_date:
            s += f", expected {o.expected_date:%d %b}"
        if ships:
            s += ". " + "; ".join(f"Shipment {x.number} via {x.carrier} is {x.status.replace('_', ' ')}" + (f" (tracking {x.tracking_number})" if x.tracking_number else "") for x in ships)
        elif o.status in ("confirmed", "packed"):
            s += ". Being prepared; no shipment yet."
        lines.append(s)
    return {"text": ("Here is your order:" if len(rows) == 1 else "Your latest orders:") + "\n" + "\n".join("• " + l for l in lines)}


@router.post("")
def ask(body: AskIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    now = time.time()
    hist = [t for t in _RATE.get(user.id, []) if t > now - 60]
    if len(hist) >= 30:
        raise HTTPException(429, "You're asking very quickly. Please wait a moment.")
    _RATE[user.id] = hist + [now]
    msg = body.message.strip()
    low = msg.lower()
    cat = _catalogue(db, user.org_id)
    byid = {p["id"]: p for p in cat}
    sugg_default = ["What's in stock?", "Show the cheapest items", "What payment options do you have?", "Where is my last order?"]

    def reply(text, products=None, suggestions=None, ctx=None):
        return {"text": text, "products": [_card(p) for p in (products or [])], "suggestions": suggestions if suggestions is not None else sugg_default,
                "context_product_id": ctx, "engine": "rules"}

    # --- things I will not share
    if re.search(r"purchase price|cost price|buying price|wholesale|vendor|supplier|margin|profit|markup|who (?:makes|supplies)", low):
        return reply("I can only share what we sell to you: selling price, GST and availability. Supplier and cost details aren't available here.")
    # --- small talk
    if re.fullmatch(r"\s*(hi|hello|hey|good (morning|afternoon|evening)|help|\?|what can you do)[\s!.?]*", low):
        return reply(f"Hi {user.name.split()[0]}! I can check stock and prices, find products, compare items, suggest alternatives, and look up your orders. Try one of these:")
    if re.fullmatch(r"\s*(thanks?|thank you|ok(ay)?|great|cool|bye)[\s!.]*", low):
        return reply("You're welcome! Ask me anything else about our products.")
    # --- own orders
    if re.search(r"\bso-?\d+\b|my (last |latest |recent )?orders?|order status|track(ing)?|where is my|has my order|status of (my )?order|my shipment|my delivery", low):
        r = _orders_answer(db, user, msg)
        return reply(r["text"], suggestions=["What's in stock?", "Show the cheapest items", "What payment options do you have?"])
    # --- policy / how-to questions
    if re.search(r"\bpay(ment|ing)?\b|\bcod\b|cash on delivery|\bupi\b|\bcard\b|net ?banking|how (do|can) i pay", low):
        return reply("At checkout you can choose: Cash on delivery (pay when the goods arrive), Bank transfer (quote your order number; ask Support for our account details), or Pay later on invoice (within your payment terms). Card / UPI / Net banking online payment is not connected yet.")
    if re.search(r"invoice|bill\b|receipt|gst invoice", low):
        return reply("Your tax invoice is available once an order is confirmed: open Invoices (or an order's details) and download the PDF. It shows the GST breakdown.")
    if re.search(r"deliver(y|ed)? (time|date|charge|fee|cost)|how long|shipping (cost|charge|fee)|when will .* (arrive|ship|deliver)|free shipping", low):
        return reply("Delivery depends on stock and the carrier. Once your order is confirmed it is packed and shipped, and you can follow the shipment status and tracking number under My orders. I don't have fixed delivery times or shipping fees on record, so for a promise on a specific order please raise a Support request.", suggestions=["Where is my last order?", "What payment options do you have?"])
    if re.search(r"return|refund|exchange|replace(ment)?|warranty|cancel", low):
        return reply("I don't have a returns, refund or warranty policy on record, so I can't promise anything about it. Please raise a request under Support and our team will answer.", suggestions=["Where is my last order?", "What's in stock?"])
    if re.search(r"\bgst\b|\btax\b", low) and not _match(msg, cat):
        return reply("Prices shown are before GST. GST is added per product at checkout (the rate is shown with every price) and itemised on your invoice.")

    matches = _match(msg, cat)
    ctx = byid.get(body.context_product_id) if body.context_product_id else None
    pronoun = bool(re.search(r"\b(it|its|this|that|them|those|these|one)\b", low))
    want_price = bool(re.search(r"price|how much|rate|\bcost|₹|\brs\b|expensive", low))
    want_stock = bool(re.search(r"stock|available|availability|how many|\bleft\b|quantity|\bqty\b|\bin hand\b|do you have|have you got|can i get|can i buy|ready", low))
    want_detail = bool(re.search(r"tell me about|details?|describe|description|what is|specs?|specification|info|about|brand|unit|hsn|gst|tax", low))

    # --- compare
    if re.search(r"compare|\bvs\b|versus|difference between|better", low):
        parts = [x for x in re.split(r"\bvs\.?\b|\bversus\b|\band\b|,|\bwith\b|\bor\b|\bbetween\b", low) if x.strip()]
        picked: list[dict] = []
        for part in parts:
            m = _match(part, cat, 1)
            if m and m[0]["id"] not in {x["id"] for x in picked}:
                picked.append(m[0])
        if len(picked) < 2 and matches:
            picked = matches[:3] if len(matches) >= 2 else picked + matches
        if len(picked) < 2:
            return reply("Tell me two products to compare, for example “compare Steel Bolt and Hex Nut”.")
        rows = "\n".join("• " + _line(p) for p in picked[:3])
        cheapest = min(picked[:3], key=lambda p: p["price"])
        return reply(f"Here is how they compare:\n{rows}\nThe lowest price is {cheapest['name']}.", picked[:3], ["What's in stock?", "Show the cheapest items"])
    # --- cheapest / budget / best stocked
    lim = _price_limit(msg) if re.search(r"under|below|less than|within|upto|up to|max|budget|₹|\brs\b", low) else None
    if re.search(r"cheap|lowest price|least expensive|affordable|budget", low) or lim is not None:
        pool = matches or [p for p in cat]
        pool = [p for p in pool if p["available"] > 0 and (lim is None or p["price"] <= lim)]
        pool.sort(key=lambda p: (p["price"], p["name"]))
        if not pool:
            return reply("I couldn't find in-stock items that fit that" + (f" (under {_money(lim)})." if lim else "."))
        head = f"In-stock items under {_money(lim)}" if lim is not None else "The most affordable items in stock"
        return reply(f"{head}:\n" + "\n".join("• " + _line(p) for p in pool[:6]), pool[:6])
    if re.search(r"most (available|stock)|best stocked|highest stock|plenty", low):
        pool = sorted([p for p in cat if p["available"] > 0], key=lambda p: -p["available"])[:5]
        return reply("Items with the most stock right now:\n" + "\n".join("• " + _line(p) for p in pool), pool) if pool else reply("Nothing is in stock at the moment.")
    if re.search(r"what (do|can) (you|i)|show (me )?(all|the|your)|catalog|list (of )?(all )?(products|items)|in stock\b|available (products|items)|what's (in stock|available)|whats (in stock|available)", low) and not matches:
        pool = sorted([p for p in cat if p["available"] > 0], key=lambda p: p["name"])
        if not pool:
            return reply("Nothing is in stock at the moment. Please check back soon.")
        return reply(f"We have {len(pool)} product{'s' if len(pool) != 1 else ''} in stock. Here are some:\n" + "\n".join("• " + _line(p) for p in pool[:8]) + ("\nOpen Products to see them all." if len(pool) > 8 else ""), pool[:8])

    # --- product questions
    target = matches or ([ctx] if ctx and (pronoun or not _tokens(msg)) else [])
    if not target and ctx and (want_price or want_stock or want_detail):
        target = [ctx]
    if target:
        if len(target) > 1 and not pronoun:
            head = f"I found {len(target)} matching products:" if matches else "Here you go:"
            return reply(head + "\n" + "\n".join("• " + _line(p, price=want_price or not want_stock, stock=want_stock or not want_price) for p in target), target, ctx=target[0]["id"])
        p = target[0]
        if not (want_price or want_stock):
            bits = [f"{p['name']} ({p['sku']})"]
            if p["description"]:
                bits.append(p["description"].strip())
            facts = [f"{_money(p['price'])} per {p['unit']} + {p['tax_rate']:g}% GST"]
            if p["brand"]:
                facts.append(f"brand {p['brand']}")
            if p["category"]:
                facts.append(f"category {p['category']}")
            if p["hsn"]:
                facts.append(f"HSN {p['hsn']}")
            st = _state(p)
            facts.append("currently out of stock" if st == "out_of_stock" else f"{'only ' if st == 'low_stock' else ''}{_qty(p['available'], p['unit'])} available")
            text = "\n".join([bits[0]] + bits[1:] + [" · ".join(facts)])
        else:
            parts = []
            if want_price:
                parts.append(f"{p['name']} costs {_money(p['price'])} per {p['unit']} plus {p['tax_rate']:g}% GST ({_money(p['price'] * (1 + p['tax_rate'] / 100))} with GST).")
            if want_stock:
                st = _state(p)
                parts.append(f"{p['name']} is out of stock right now." if st == "out_of_stock" else f"{p['name']} is {'running low: only ' if st == 'low_stock' else 'in stock: '}{_qty(p['available'], p['unit'])} available.")
            text = " ".join(parts)
        alts = _alternatives(p, cat) if p["available"] <= 0 else []
        if alts:
            text += "\nIn-stock alternatives:\n" + "\n".join("• " + _line(a) for a in alts)
        return reply(text, [p] + alts, ["Compare with another product", "What's in stock?", "Show the cheapest items"], ctx=p["id"])

    if want_price or want_stock or want_detail or len(_tokens(msg)) > 0:
        return reply("I couldn't find a product matching that. Try the product name or SKU (for example “price of BOLT-1”), or ask “What's in stock?”. For anything else, raise a request under Support.")
    return reply("Ask me about a product's price or availability, or try one of these:")

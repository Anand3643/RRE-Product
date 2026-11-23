"""Order maths shared by purchase and sales documents. All money is Decimal, rounded half-up to 2 places per line,
and document totals are sums of the rounded line values so printed documents always add up exactly."""
from decimal import ROUND_HALF_UP, Decimal

D = Decimal
TWO = D("0.01")


def q2(x) -> Decimal:
    return D(x).quantize(TWO, rounding=ROUND_HALF_UP)


def line_amounts(qty, rate, discount_pct, tax_rate) -> dict:
    gross = q2(D(qty) * D(rate))
    discount = q2(gross * D(discount_pct) / 100)
    taxable = gross - discount
    tax = q2(taxable * D(tax_rate) / 100)
    return {"gross": gross, "discount": discount, "taxable": taxable, "tax": tax, "amount": taxable + tax}


def document_totals(lines: list[dict], mode: str, extra: Decimal = D(0)) -> dict:
    """lines: dicts from line_amounts(). mode: 'intra' (CGST+SGST) or 'inter' (IGST). extra: e.g. shipping charge (untaxed)."""
    subtotal = sum((l["gross"] for l in lines), D(0))
    discount = sum((l["discount"] for l in lines), D(0))
    taxable = sum((l["taxable"] for l in lines), D(0))
    tax = sum((l["tax"] for l in lines), D(0))
    if mode == "inter":
        cgst = sgst = D(0)
        igst = tax
    else:
        cgst = q2(tax / 2)
        sgst = tax - cgst  # absorbs the odd paisa so cgst + sgst == tax exactly
        igst = D(0)
    return {"subtotal": subtotal, "discount_total": discount, "taxable_total": taxable, "cgst": cgst, "sgst": sgst,
            "igst": igst, "total": taxable + tax + q2(extra)}


def state_code(gstin) -> str | None:
    return gstin[:2] if gstin and len(gstin) >= 2 and gstin[:2].isdigit() else None


def gst_mode(org, party_gstin, party_state) -> str:
    """Intra-state supply -> CGST + SGST; inter-state -> IGST. GSTIN state codes decide when both are known, else the
    state names; with nothing to compare it defaults to intra-state."""
    a, b = state_code(org.gstin), state_code(party_gstin)
    if a and b:
        return "intra" if a == b else "inter"
    if org.state and party_state:
        return "intra" if org.state.strip().casefold() == party_state.strip().casefold() else "inter"
    return "intra"

// Client-side preview of the server's order maths (the server is authoritative and re-computes on save).
export const q2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
export type Line = { quantity: number; rate: number; discount_pct: number; tax_rate: number };
export function lineAmounts(l: Line) {
  const gross = q2(l.quantity * l.rate), discount = q2((gross * l.discount_pct) / 100), taxable = q2(gross - discount), tax = q2((taxable * l.tax_rate) / 100);
  return { gross, discount, taxable, tax, amount: q2(taxable + tax) };
}
export const stateCode = (g?: string | null) => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);
/** intra = CGST+SGST, inter = IGST (GSTIN state codes first, then state names; default intra) */
export function gstMode(org: { gstin?: string | null; state?: string | null }, party: { gstin?: string | null; bill_state?: string | null }) {
  const a = stateCode(org.gstin), b = stateCode(party.gstin);
  if (a && b) return a === b ? "intra" : "inter";
  if (org.state && party.bill_state) return org.state.trim().toLowerCase() === party.bill_state.trim().toLowerCase() ? "intra" : "inter";
  return "intra";
}
export function totals(lines: Line[], mode: string, extra = 0) {
  const ls = lines.map(lineAmounts); const sum = (k: "gross" | "discount" | "taxable" | "tax") => q2(ls.reduce((a, l) => a + l[k], 0));
  const tax = sum("tax"), cgst = mode === "inter" ? 0 : q2(tax / 2);
  return { subtotal: sum("gross"), discount: sum("discount"), taxable: sum("taxable"), tax, cgst, sgst: mode === "inter" ? 0 : q2(tax - cgst), igst: mode === "inter" ? tax : 0, total: q2(sum("taxable") + tax + extra), lines: ls };
}
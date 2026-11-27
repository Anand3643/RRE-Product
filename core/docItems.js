/**
 * RRE Tally — the item lines of an imported invoice or quotation (item / HSN / qty / unit / rate / discount / amount / GST rate),
 * and the header of a quotation. Used by core/docImport.js; the voucher itself is still posted by core/voucherService.postVoucher,
 * whose stock lines update stock quantities, stock valuation (weighted average) and so cost of goods sold.
 */
const { get, all } = require('./db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

/**
 * The item rows of a document: rows of the item table that have a quantity and a rate or an amount.
 * `rows` are the records from docImport.tableRows(doc, 'stock_statement') (columns already aligned, item/qty/rate/... fields).
 */
function itemsFromRows(rows, num) {
  const items = [];
  for (const r of rows) {
    const name = String(r.item || '').trim();
    if (!name || /^(sub ?total|total|grand total|taxable|cgst|sgst|igst|round|less|add|amount in words)\b/i.test(name)) continue;
    const qty = num(r.qty);
    if (qty == null || Number.isNaN(qty) || qty <= 0) continue;
    let rate = num(r.rate);
    const discPct = num(r.discount_pct);
    const discAmt = num(r.discount);
    let amt = num(r.amount != null ? r.amount : r.value);
    if ((rate == null || Number.isNaN(rate)) && amt != null && !Number.isNaN(amt)) rate = r2(amt / qty);
    if (rate == null || Number.isNaN(rate)) continue;
    const gross = qty * rate;
    let pct = discPct != null && !Number.isNaN(discPct) ? discPct : 0;
    if (!pct && discAmt && !Number.isNaN(discAmt) && gross > 0) pct = r2(discAmt / gross * 100);
    if (amt == null || Number.isNaN(amt)) amt = r2(gross * (1 - pct / 100));
    const gst = num(r.gst_rate);
    items.push({ name, code: r.code ? String(r.code).trim() : '', hsn: r.hsn ? String(r.hsn).trim() : '', qty, unit: r.unit ? String(r.unit).trim() : '',
      rate: r2(rate), discount_pct: r2(pct), amount: r2(amt), gst_rate: gst != null && !Number.isNaN(gst) ? gst : null, row: r._row });
  }
  return items;
}

/** stock items by name and by code (SKU), with the quantity on hand */
async function stockIndex() {
  const rows = await all(`SELECT s.id, s.name, s.sku, s.hsn_code, s.gst_rate,
      s.opening_qty + COALESCE((SELECT SUM(CASE WHEN e.direction = 'IN' THEN e.quantity ELSE -e.quantity END) FROM inventory_entries e WHERE e.stock_item_id = s.id), 0) AS on_hand
    FROM stock_items s`);
  const byName = new Map(), byCode = new Map();
  for (const s of rows) { byName.set(norm(s.name), s); if (s.sku) byCode.set(norm(s.sku), s); }
  return { rows, find: (name, code) => (code && byCode.get(norm(code))) || byName.get(norm(name)) || null };
}

// ------------------------------------------------------------------------------------------------ quotation header
const DATE_RE = '(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ -](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ -]\\d{2,4})';
function quotationHeader(text) {
  const t = String(text || '');
  const pick = (re) => { const m = re.exec(t); return m ? m[m.length - 1].trim() : null; };
  const quote_no = pick(/\b(?:quotation|quote|estimate|proforma(?: invoice)?|qtn)\s*(?:no|number|#|ref)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-.]*)/i);
  const valid = pick(new RegExp(`\\b(?:valid\\s*(?:till|until|up\\s*to|upto)|expiry(?:\\s*date)?|validity)\\s*[:\\-]?\\s*${DATE_RE}`, 'i'));
  const date = pick(new RegExp(`\\b(?:quotation\\s*date|quote\\s*date|estimate\\s*date|date)\\s*[:\\-]?\\s*${DATE_RE}`, 'i'));
  const status = pick(/\bstatus\s*[:\-]\s*([A-Za-z ]+?)\s*(?:$|\n|\s{2,})/im);
  // the customer: "To: X", "Customer: X", "Bill To: X", "Quoted to: X", or the line after a lone "To," / "Bill To"
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let customer = null;
  for (let i = 0; i < lines.length && !customer; i++) {
    const m = /^(?:to|bill\s*to|billed\s*to|customer(?:\s*name)?|quoted\s*to|buyer|client|m\/s\.?)\s*[:,\-]\s*(.+)$/i.exec(lines[i]);
    if (m && /[a-z]{3}/i.test(m[1])) customer = m[1].split(/\s{3,}/)[0].trim();
    else if (/^(?:to|bill\s*to|billed\s*to|customer|quoted\s*to|buyer)\s*[:,]?$/i.test(lines[i]) && lines[i + 1]) customer = lines[i + 1].split(/\s{3,}/)[0].trim();
  }
  const gstins = (t.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g) || []);
  return { quote_no, date, valid_till: valid, status, customer, gstins };
}

const QUOTE_STATUS = (s) => {
  const v = norm(s);
  if (/accept|approv|confirm|won/.test(v)) return 'Accepted';
  if (/declin|reject|lost|cancel/.test(v)) return 'Declined';
  if (/sent|pending|submit|open|await/.test(v)) return 'Sent';
  if (/expir/.test(v)) return 'Expired';
  return 'Draft';
};

/** "Paid" / "Unpaid" / "Partly paid" from a register's status column */
const PAYMENT_STATUS = (s) => {
  const v = norm(s);
  if (!v) return null;
  if (/partial|part paid|partly/.test(v)) return 'partial';
  if (/unpaid|not paid|due|pending|outstanding|open|credit/.test(v)) return 'unpaid';
  if (/paid|settled|received|cleared|closed|cash/.test(v)) return 'paid';
  return null;
};

module.exports = { itemsFromRows, stockIndex, quotationHeader, QUOTE_STATUS, PAYMENT_STATUS, norm };

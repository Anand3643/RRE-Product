/**
 * RRE Tally — printable invoice (A4 HTML). The user prints it or chooses "Save as PDF"
 * in the print dialog. Read-only: builds the document from existing voucher data.
 */
const { get, all } = require('./db');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
function below1000(n) {
  return (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? below100(n % 100) : '');
}
/** Indian numbering (lakh / crore). */
function amountInWords(amount) {
  let rupees = Math.floor(Math.abs(amount) + 1e-9);
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  if (paise === 100) { rupees += 1; }
  const p = paise === 100 ? 0 : paise;
  if (rupees === 0 && p === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(below1000(crore) + ' Crore');
  if (lakh) parts.push(below100(lakh) + ' Lakh');
  if (thousand) parts.push(below100(thousand) + ' Thousand');
  if (rupees) parts.push(below1000(rupees));
  let words = (parts.join(' ') || 'Zero') + ' Rupees';
  if (p) words += ' and ' + below100(p) + ' Paise';
  return words + ' Only';
}

const TITLES = { Sales: 'TAX INVOICE', Purchase: 'PURCHASE VOUCHER', 'Credit Note': 'CREDIT NOTE', 'Debit Note': 'DEBIT NOTE' };

async function buildInvoiceHtml(voucherId) {
  const v = await get(`
    SELECT v.*, p.name AS party_name, p.gstin AS party_gstin, p.address AS party_address, p.state AS party_state
    FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id WHERE v.id = ?`, [voucherId]);
  if (!v) return null;
  const company = (await get('SELECT * FROM company_info LIMIT 1')) || {};
  const items = await all(`
    SELECT i.*, s.name AS item_name, s.hsn_code, u.symbol AS uom
    FROM inventory_entries i JOIN stock_items s ON i.stock_item_id = s.id JOIN units_of_measure u ON s.uom_id = u.id
    WHERE i.voucher_id = ? ORDER BY i.id`, [voucherId]);
  const entries = await all(`
    SELECT e.*, l.name AS ledger_name, g.name AS group_name
    FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id JOIN account_groups g ON l.group_id = g.id
    WHERE e.voucher_id = ? ORDER BY e.id`, [voucherId]);

  const taxLines = entries.filter((e) => e.group_name === 'Duties & Taxes');
  const taxTotal = taxLines.reduce((s, e) => s + (e.debit_amount || e.credit_amount), 0);
  const itemTotal = items.reduce((s, i) => s + i.amount, 0);
  const grand = v.total_amount;
  const title = TITLES[v.voucher_type] || `${v.voucher_type.toUpperCase()} VOUCHER`;

  const itemRows = items.length
    ? items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.item_name)}</td><td>${esc(i.hsn_code)}</td>
        <td class="r">${i.quantity} ${esc(i.uom)}</td><td class="r">${money(i.rate)}</td>
        <td class="r">${i.discount_pct ? i.discount_pct + '%' : ''}</td><td class="r">${money(i.amount)}</td></tr>`).join('')
    : entries.map((e, n) => `<tr><td>${n + 1}</td><td colspan="5">${esc(e.ledger_name)} (${e.entry_type})</td>
        <td class="r">${money(e.debit_amount || e.credit_amount)}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} ${esc(v.voucher_no)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0; text-align: center; letter-spacing: 1px; }
  .box { border: 1px solid #333; padding: 8px; margin-top: 8px; }
  .grid { display: flex; gap: 8px; } .grid > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #333; padding: 4px 6px; text-align: left; } th { background: #eee; }
  .r { text-align: right; } .tot td { font-weight: bold; } .small { font-size: 10px; color: #444; }
</style></head><body>
  <h1>${esc(title)}</h1>
  <div class="box"><strong>${esc(company.formal_name || company.name)}</strong><br>
    ${esc(company.address)} ${esc(company.state)} ${esc(company.pin_code)}<br>
    ${company.gstin ? 'GSTIN: ' + esc(company.gstin) : ''} ${company.pan ? ' · PAN: ' + esc(company.pan) : ''}</div>
  <div class="grid">
    <div class="box"><strong>Billed to</strong><br>${esc(v.party_name || '—')}<br>${esc(v.party_address)}<br>
      ${esc(v.party_state)}${v.party_gstin ? '<br>GSTIN: ' + esc(v.party_gstin) : ''}</div>
    <div class="box">Voucher No: <strong>${esc(v.voucher_no)}</strong><br>Date: ${esc(v.date)}<br>
      ${v.reference_no ? 'Reference: ' + esc(v.reference_no) + '<br>' : ''}Type: ${esc(v.voucher_type)}</div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">Amount (₹)</th></tr></thead>
    <tbody>${itemRows}</tbody>
    ${items.length ? `<tr class="tot"><td colspan="6" class="r">Taxable value</td><td class="r">${money(itemTotal)}</td></tr>` : ''}
    ${taxLines.map((t) => `<tr><td colspan="6" class="r">${esc(t.ledger_name)}</td><td class="r">${money(t.debit_amount || t.credit_amount)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="6" class="r">Total${taxTotal ? ' (incl. tax)' : ''}</td><td class="r">${money(grand)}</td></tr>
  </table>
  <div class="box"><strong>Amount in words:</strong> ${esc(amountInWords(grand))}</div>
  ${v.narration ? `<div class="box small">Narration: ${esc(v.narration)}</div>` : ''}
  <p class="small">Computer-generated document from RRE Tally.</p>
</body></html>`;
}

module.exports = { buildInvoiceHtml, amountInWords };

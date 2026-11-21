// ========================================================
// Zoho Books-style printable document templates (A4)
// Quotation, Tax Invoice and tabular Report layouts.
// Rendered as self-contained HTML; pdfEngine turns them into PDF.
// ========================================================

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n, symbol = '₹') {
  const v = parseFloat(n) || 0;
  return `${symbol}${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(n, dp = 2) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  if (isNaN(dt.getTime())) return esc(d);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(dt.getDate()).padStart(2, '0')} ${m[dt.getMonth()]} ${dt.getFullYear()}`;
}

// Indian numbering system (Lakh / Crore)
function amountInWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`);
  const three = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return [h ? `${ones[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
  };
  const words = (n) => {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (n) parts.push(three(n));
    return parts.join(' ');
  };
  const v = Math.abs(parseFloat(amount) || 0);
  const rupees = Math.floor(v);
  const paise = Math.round((v - rupees) * 100);
  return `Indian Rupee ${words(rupees)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

const BASE_CSS = `
  @page { size: A4; margin: 12mm 0 14mm 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Segoe UI", -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #1f2937; font-size: 12px; background: #e5e7eb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; padding: 14mm 14mm 16mm; position: relative; box-shadow: 0 4px 24px rgba(0,0,0,.12); }
  .ribbon { position: absolute; top: 0; left: 0; overflow: hidden; width: 120px; height: 120px; }
  .ribbon span { position: absolute; top: 26px; left: -34px; width: 160px; transform: rotate(-45deg); text-align: center; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .08em; padding: 4px 0; text-transform: uppercase; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .org-name { font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 4px; }
  .org-meta { color: #4b5563; line-height: 1.55; white-space: pre-line; }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 28px; font-weight: 400; letter-spacing: .04em; color: #111827; text-transform: uppercase; }
  .doc-title .no { margin-top: 2px; font-weight: 700; color: #111827; }
  .doc-title .bal-label { margin-top: 14px; color: #6b7280; font-size: 11px; }
  .doc-title .bal { font-size: 18px; font-weight: 700; color: #111827; }
  .meta { display: flex; justify-content: space-between; margin-top: 26px; gap: 24px; }
  .bill-to .lbl { color: #6b7280; margin-bottom: 4px; }
  .bill-to .name { font-weight: 700; color: #2563eb; font-size: 13px; }
  .bill-to .addr { color: #374151; line-height: 1.5; white-space: pre-line; }
  table.kv { border-collapse: collapse; }
  table.kv td { padding: 3px 0 3px 18px; text-align: right; }
  table.kv td:first-child { color: #6b7280; }
  .subject { margin-top: 18px; }
  .subject .lbl { color: #6b7280; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 18px; }
  table.items thead th { background: #3c3d3a; color: #fff; font-weight: 600; font-size: 11px; padding: 8px 8px; text-align: left; }
  table.items thead th.r, table.items td.r { text-align: right; }
  table.items thead th.c, table.items td.c { text-align: center; }
  table.items td { padding: 9px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.items td .desc { color: #6b7280; font-size: 11px; margin-top: 2px; white-space: pre-line; }
  table.items td .hsn { color: #9ca3af; font-size: 10px; margin-top: 2px; }
  .totals-wrap { display: flex; justify-content: space-between; margin-top: 10px; gap: 24px; }
  .words { flex: 1; padding-top: 8px; }
  .words .lbl { color: #6b7280; }
  .words .val { font-weight: 600; font-style: italic; margin-top: 2px; }
  table.totals { width: 300px; border-collapse: collapse; }
  table.totals td { padding: 6px 8px; text-align: right; }
  table.totals td:first-child { color: #4b5563; }
  table.totals tr.grand td { font-weight: 700; font-size: 13px; color: #111827; background: #f3f4f6; border-top: 1px solid #d1d5db; }
  .notes { margin-top: 26px; }
  .notes h4 { margin: 0 0 4px; font-size: 12px; color: #111827; }
  .notes p { margin: 0 0 14px; color: #4b5563; line-height: 1.55; white-space: pre-line; }
  .sign { margin-top: 40px; display: flex; justify-content: flex-end; }
  .sign div { width: 220px; border-top: 1px solid #9ca3af; text-align: center; padding-top: 6px; color: #4b5563; }
  .foot { margin-top: 28px; text-align: center; color: #9ca3af; font-size: 10px; }
  table.tax { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 11px; }
  table.tax th { background: #f3f4f6; color: #374151; padding: 6px; border: 1px solid #e5e7eb; font-weight: 600; }
  table.tax td { padding: 6px; border: 1px solid #e5e7eb; text-align: right; }
  table.tax td:first-child { text-align: left; }
  .toolbar { position: sticky; top: 0; z-index: 10; background: #1f3a52; color: #fff; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .toolbar .btns { display: flex; gap: 8px; }
  .toolbar a, .toolbar button { background: #fff; color: #1f3a52; border: 0; border-radius: 4px; padding: 6px 12px; font-weight: 600; font-size: 12px; cursor: pointer; text-decoration: none; font-family: inherit; }
  .toolbar a.primary { background: #f59e0b; color: #111827; }
  /* Report layout */
  .rpt-hdr { border-bottom: 2px solid #1f3a52; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: flex-end; }
  .rpt-hdr h1 { margin: 0; font-size: 20px; color: #1f3a52; }
  .rpt-hdr .sub { color: #6b7280; margin-top: 3px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .kpi { flex: 1 1 120px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; }
  .kpi .k { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
  .kpi .v { font-size: 15px; font-weight: 700; color: #111827; margin-top: 2px; }
  table.rpt { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 11px; }
  table.rpt th { background: #1f3a52; color: #fff; padding: 7px 6px; text-align: left; font-weight: 600; }
  table.rpt td { padding: 6px; border-bottom: 1px solid #e5e7eb; }
  table.rpt tr:nth-child(even) td { background: #f9fafb; }
  table.rpt .r { text-align: right; font-variant-numeric: tabular-nums; }
  table.rpt tfoot td { font-weight: 700; background: #f3f4f6 !important; border-top: 2px solid #1f3a52; }
  @media print {
    body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; width: auto; min-height: 0; padding: 0 14mm; }
    .toolbar { display: none; }
    .rpt-sheet { padding: 0 10mm; }
    .ribbon { display: none; }
    table.items tr, table.rpt tr { page-break-inside: avoid; }
  }
`;

const STATUS_COLORS = {
  Draft: '#6b7280', Sent: '#2563eb', Accepted: '#059669', Declined: '#dc2626',
  Expired: '#d97706', Revised: '#7c3aed', Invoiced: '#0f766e', Paid: '#059669', Due: '#d97706'
};

function toolbar(title, pdfHref) {
  return `<div class="toolbar"><span>${esc(title)}</span><div class="btns">
    ${pdfHref ? `<a class="primary" href="${esc(pdfHref)}">Download PDF</a>` : ''}
    <button onclick="window.print()">Print</button></div></div>`;
}

function wrap(title, body, { toolbarHtml = '' } = {}) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS}</style></head><body>${toolbarHtml}${body}</body></html>`;
}

function orgBlock(company) {
  const lines = [
    company.address,
    [company.state, company.pin_code].filter(Boolean).join(' - '),
    company.gstin ? `GSTIN ${company.gstin}` : '',
    company.pan ? `PAN ${company.pan}` : ''
  ].filter(Boolean).join('\n');
  return `<div><div class="org-name">${esc(company.formal_name || company.name || 'Company')}</div><div class="org-meta">${esc(lines)}</div></div>`;
}

function itemsTable(items, { showDisc }) {
  const rows = items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td><div>${esc(it.item_name)}</div>${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}${it.hsn_code ? `<div class="hsn">HSN/SAC: ${esc(it.hsn_code)}</div>` : ''}</td>
      <td class="r">${num(it.quantity, Number.isInteger(+it.quantity) ? 0 : 2)}${it.uom ? `<div class="hsn">${esc(it.uom)}</div>` : ''}</td>
      <td class="r">${num(it.rate)}</td>
      ${showDisc ? `<td class="r">${it.discount_pct ? num(it.discount_pct, 1) + '%' : '-'}</td>` : ''}
      <td class="r">${it.gst_rate !== undefined && it.gst_rate !== null ? num(it.gst_rate, 0) + '%' : '-'}</td>
      <td class="r">${num(it.amount)}</td>
    </tr>`).join('');
  return `<table class="items"><thead><tr>
    <th class="c" style="width:32px">#</th><th>Item &amp; Description</th><th class="r" style="width:70px">Qty</th>
    <th class="r" style="width:90px">Rate</th>${showDisc ? '<th class="r" style="width:60px">Disc</th>' : ''}
    <th class="r" style="width:56px">GST</th><th class="r" style="width:100px">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function taxSummary(items, { interState, discountPct = 0 }) {
  const groups = {};
  for (const it of items) {
    const rate = parseFloat(it.gst_rate) || 0;
    const taxable = (parseFloat(it.amount) || 0) * (1 - (parseFloat(discountPct) || 0) / 100);
    groups[rate] = groups[rate] || { taxable: 0 };
    groups[rate].taxable += taxable;
  }
  const rates = Object.keys(groups).map(Number).sort((a, b) => a - b);
  if (!rates.length) return '';
  const rows = rates.map((r) => {
    const t = groups[r].taxable;
    const tax = (t * r) / 100;
    return interState
      ? `<tr><td>GST ${r}%</td><td>${num(t)}</td><td>${r}%</td><td>${num(tax)}</td><td>${num(tax)}</td></tr>`
      : `<tr><td>GST ${r}%</td><td>${num(t)}</td><td>${r / 2}%</td><td>${num(tax / 2)}</td><td>${r / 2}%</td><td>${num(tax / 2)}</td><td>${num(tax)}</td></tr>`;
  }).join('');
  const head = interState
    ? '<tr><th>Tax Slab</th><th>Taxable Value</th><th>IGST Rate</th><th>IGST Amount</th><th>Total Tax</th></tr>'
    : '<tr><th>Tax Slab</th><th>Taxable Value</th><th>CGST Rate</th><th>CGST Amount</th><th>SGST Rate</th><th>SGST Amount</th><th>Total Tax</th></tr>';
  return `<table class="tax"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function totalsTable(d, { balanceLabel }) {
  const rows = [];
  rows.push(['Sub Total', num(d.subtotal)]);
  if (d.discount_amount > 0) rows.push([`Discount${d.discount_pct ? ` (${num(d.discount_pct, 1)}%)` : ''}`, `(-) ${num(d.discount_amount)}`]);
  if (d.cgst > 0) rows.push(['CGST', num(d.cgst)]);
  if (d.sgst > 0) rows.push(['SGST', num(d.sgst)]);
  if (d.igst > 0) rows.push(['IGST', num(d.igst)]);
  if (d.shipping_charges > 0) rows.push(['Shipping Charges', num(d.shipping_charges)]);
  if (Math.abs(d.round_off || 0) > 0.001) rows.push(['Rounding', num(d.round_off)]);
  return `<table class="totals">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
    <tr class="grand"><td>${balanceLabel}</td><td>${money(d.total)}</td></tr></table>`;
}

// ---------------------------------------------------------------
// QUOTATION / ESTIMATE
// ---------------------------------------------------------------
function renderQuotation(q, company, { withToolbar = false, pdfHref = '' } = {}) {
  const interState = String(q.place_of_supply_code || '') !== String(company.state_code || '33');
  const showDisc = q.items.some((i) => i.discount_pct > 0);
  const color = STATUS_COLORS[q.status] || '#6b7280';
  const billAddr = [q.billing_address, q.customer_gstin ? `GSTIN ${q.customer_gstin}` : '', q.customer_phone, q.customer_email].filter(Boolean).join('\n');

  const body = `
  <div class="sheet">
    <div class="ribbon"><span style="background:${color}">${esc(q.status)}</span></div>
    <div class="hdr">
      ${orgBlock(company)}
      <div class="doc-title"><h1>Quote</h1><div class="no"># ${esc(q.quote_no)}</div></div>
    </div>
    <div class="meta">
      <div class="bill-to"><div class="lbl">Bill To</div><div class="name">${esc(q.display_customer || q.customer_name)}</div><div class="addr">${esc(billAddr)}</div></div>
      <table class="kv">
        <tr><td>Quote Date :</td><td>${fmtDate(q.date)}</td></tr>
        ${q.expiry_date ? `<tr><td>Expiry Date :</td><td>${fmtDate(q.expiry_date)}</td></tr>` : ''}
        ${q.reference_no ? `<tr><td>Reference# :</td><td>${esc(q.reference_no)}</td></tr>` : ''}
        ${q.salesperson ? `<tr><td>Sales Person :</td><td>${esc(q.salesperson)}</td></tr>` : ''}
        ${q.place_of_supply ? `<tr><td>Place Of Supply :</td><td>${esc(q.place_of_supply)} (${esc(q.place_of_supply_code)})</td></tr>` : ''}
      </table>
    </div>
    ${q.subject ? `<div class="subject"><div class="lbl">Subject :</div><div>${esc(q.subject)}</div></div>` : ''}
    ${itemsTable(q.items, { showDisc })}
    <div class="totals-wrap">
      <div class="words"><div class="lbl">Total In Words</div><div class="val">${esc(amountInWords(q.total))}</div></div>
      ${totalsTable(q, { balanceLabel: 'Total' })}
    </div>
    ${taxSummary(q.items, { interState, discountPct: q.discount_pct })}
    <div class="notes">
      ${q.customer_notes ? `<h4>Notes</h4><p>${esc(q.customer_notes)}</p>` : ''}
      ${q.terms ? `<h4>Terms &amp; Conditions</h4><p>${esc(q.terms)}</p>` : ''}
    </div>
    <div class="sign"><div>Authorized Signature<br><small>for ${esc(company.formal_name || company.name || '')}</small></div></div>
    <div class="foot">This is a computer-generated quotation.</div>
  </div>`;

  return wrap(`Quote ${q.quote_no}`, body, { toolbarHtml: withToolbar ? toolbar(`Quote ${q.quote_no} — ${q.display_customer || ''}`, pdfHref) : '' });
}

// ---------------------------------------------------------------
// TAX INVOICE (from a posted Sales voucher)
// ---------------------------------------------------------------
function renderInvoice(inv, company, { withToolbar = false, pdfHref = '' } = {}) {
  const interState = inv.igst > 0;
  const showDisc = inv.items.some((i) => i.discount_pct > 0);
  const status = inv.balance_due <= 0.01 ? 'Paid' : 'Due';
  const billAddr = [inv.party_address, inv.party_gstin ? `GSTIN ${inv.party_gstin}` : ''].filter(Boolean).join('\n');
  const title = inv.voucher_type === 'Sales' ? 'Tax Invoice' : inv.voucher_type;

  const body = `
  <div class="sheet">
    <div class="ribbon"><span style="background:${STATUS_COLORS[status]}">${status}</span></div>
    <div class="hdr">
      ${orgBlock(company)}
      <div class="doc-title"><h1>${esc(title)}</h1><div class="no"># ${esc(inv.voucher_no)}</div>
        <div class="bal-label">Balance Due</div><div class="bal">${money(inv.balance_due)}</div></div>
    </div>
    <div class="meta">
      <div class="bill-to"><div class="lbl">Bill To</div><div class="name">${esc(inv.party_name || '')}</div><div class="addr">${esc(billAddr)}</div></div>
      <table class="kv">
        <tr><td>Invoice Date :</td><td>${fmtDate(inv.date)}</td></tr>
        ${inv.due_date ? `<tr><td>Due Date :</td><td>${fmtDate(inv.due_date)}</td></tr>` : ''}
        ${inv.reference_no ? `<tr><td>Reference# :</td><td>${esc(inv.reference_no)}</td></tr>` : ''}
        ${inv.party_state ? `<tr><td>Place Of Supply :</td><td>${esc(inv.party_state)}${inv.party_state_code ? ` (${esc(inv.party_state_code)})` : ''}</td></tr>` : ''}
      </table>
    </div>
    ${itemsTable(inv.items, { showDisc })}
    <div class="totals-wrap">
      <div class="words"><div class="lbl">Total In Words</div><div class="val">${esc(amountInWords(inv.total))}</div></div>
      <div>${totalsTable(inv, { balanceLabel: 'Total' })}
        ${inv.paid > 0 ? `<table class="totals"><tr><td>Payment Made</td><td style="color:#dc2626">(-) ${num(inv.paid)}</td></tr><tr class="grand"><td>Balance Due</td><td>${money(inv.balance_due)}</td></tr></table>` : ''}
      </div>
    </div>
    ${taxSummary(inv.items, { interState })}
    <div class="notes">
      ${inv.narration ? `<h4>Notes</h4><p>${esc(inv.narration)}</p>` : ''}
      <h4>Terms &amp; Conditions</h4><p>Goods once sold will not be taken back. Interest @18% p.a. will be charged on payments delayed beyond the due date. Subject to local jurisdiction.</p>
    </div>
    <div class="sign"><div>Authorized Signature<br><small>for ${esc(company.formal_name || company.name || '')}</small></div></div>
    <div class="foot">This is a computer-generated invoice.</div>
  </div>`;

  return wrap(`${title} ${inv.voucher_no}`, body, { toolbarHtml: withToolbar ? toolbar(`${title} ${inv.voucher_no} — ${inv.party_name || ''}`, pdfHref) : '' });
}

// ---------------------------------------------------------------
// GENERIC REPORT (Report Center)
// report = { title, subtitle, columns:[{key,label,type}], rows, totals, kpis:[{label,value}] }
// ---------------------------------------------------------------
function formatCell(value, type) {
  if (type === 'money') return num(value);
  if (type === 'number') return num(value, 0);
  if (type === 'percent') return `${num(value, 1)}%`;
  if (type === 'date') return fmtDate(value);
  return esc(value ?? '');
}

function renderReport(report, company, { withToolbar = false, pdfHref = '' } = {}) {
  const cols = report.columns;
  const isNum = (c) => ['money', 'number', 'percent'].includes(c.type);
  const head = cols.map((c) => `<th class="${isNum(c) ? 'r' : ''}">${esc(c.label)}</th>`).join('');
  const body = report.rows.length
    ? report.rows.map((r) => `<tr>${cols.map((c) => `<td class="${isNum(c) ? 'r' : ''}">${formatCell(r[c.key], c.type)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" style="text-align:center;color:#9ca3af;padding:18px">No records for the selected period.</td></tr>`;
  const foot = report.totals
    ? `<tfoot><tr>${cols.map((c, i) => `<td class="${isNum(c) ? 'r' : ''}">${i === 0 ? 'Total' : (report.totals[c.key] !== undefined ? formatCell(report.totals[c.key], c.type) : '')}</td>`).join('')}</tr></tfoot>`
    : '';
  const kpis = (report.kpis || []).length
    ? `<div class="kpis">${report.kpis.map((k) => `<div class="kpi"><div class="k">${esc(k.label)}</div><div class="v">${esc(k.value)}</div></div>`).join('')}</div>`
    : '';

  const html = `
  <div class="sheet rpt-sheet">
    <div class="rpt-hdr">
      <div><div class="org-name">${esc(company.formal_name || company.name || '')}</div><h1>${esc(report.title)}</h1><div class="sub">${esc(report.subtitle || '')}</div></div>
      <div style="text-align:right;color:#6b7280">Generated ${fmtDate(new Date().toISOString())}<br>${report.rows.length} record(s)</div>
    </div>
    ${kpis}
    <table class="rpt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>
    <div class="foot">${esc(company.name || '')} · ${esc(report.title)}</div>
  </div>`;
  return wrap(report.title, html, { toolbarHtml: withToolbar ? toolbar(report.title, pdfHref) : '' });
}

function reportToCsv(report) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [report.columns.map((c) => q(c.label)).join(',')];
  for (const r of report.rows) lines.push(report.columns.map((c) => q(r[c.key])).join(','));
  if (report.totals) lines.push(report.columns.map((c, i) => q(i === 0 ? 'Total' : report.totals[c.key] ?? '')).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { renderQuotation, renderInvoice, renderReport, reportToCsv, amountInWords, esc, fmtDate };

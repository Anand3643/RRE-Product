/**
 * RRE Tally — import accounting documents (PDF, Excel, CSV, scans) into the right place, through the SAME engines as manual entry.
 *
 *   upload  -> the original file is kept (import_document_data) and read (core/docRead.js)
 *   classify-> what kind of document is it: sales / purchase invoice or register, payments, receipts, day book / journal list,
 *              bank statement, customer / supplier list, stock statement - or a REPORT (trial balance, balance sheet, P&L, ledger,
 *              GST report) that is compared with the books and never turned into vouchers
 *   preview -> every record with its checks (dates, amounts, Dr = Cr, invoice total = taxable + GST, GST split, ledgers, duplicates in
 *              the file and in the books). NOTHING is written to the books. The person can change the type, the columns, the
 *              default ledgers, map or create missing ledgers, and fix individual values.
 *   commit  -> the valid records the person kept, in ONE transaction (all or nothing). Vouchers go through postVoucher (the one posting
 *              engine), so ledgers, Day Book, stock, GST and reports all follow. A document is imported once: retrying returns the
 *              first result; a re-uploaded copy of an imported file is flagged, and every voucher already in the books is a duplicate.
 *
 * Nothing uncertain is posted: a record with an error is rejected with the reason; it is never "fixed" by guessing.
 * The "intelligence" is offline: OCR + rules for document types and column names (no document leaves this server).
 */
const crypto = require('crypto');
const { get, all, run } = require('./db');
const { readDocument } = require('./docRead');
const { parseAmount: csvAmount, parseDate: csvDate } = require('./csv');

const bad = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\ba\/c\b/g, 'account').replace(/[^a-z0-9%]+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ document types
const CATEGORIES = {
  sales_invoice: { label: 'Sales invoice', kind: 'post' },
  purchase_invoice: { label: 'Purchase invoice', kind: 'post' },
  sales_register: { label: 'Sales register / sales statement', kind: 'post' },
  purchase_register: { label: 'Purchase register / purchase statement', kind: 'post' },
  payments: { label: 'Payment records', kind: 'post' },
  receipts: { label: 'Receipt records', kind: 'post' },
  transactions: { label: 'Day Book / journal / voucher list', kind: 'post' },
  bank_statement: { label: 'Bank statement', kind: 'bank' },
  party_list: { label: 'Customer / supplier list', kind: 'master' },
  stock_statement: { label: 'Stock / inventory statement', kind: 'master' },
  trial_balance: { label: 'Trial balance (report: compared, not posted)', kind: 'report' },
  balance_sheet: { label: 'Balance sheet (report: compared, not posted)', kind: 'report' },
  profit_loss: { label: 'Profit & loss (report: compared, not posted)', kind: 'report' },
  ledger_report: { label: 'Ledger report (report: compared, not posted)', kind: 'report' },
  gst_report: { label: 'GST report (report: compared, not posted)', kind: 'report' }
};

// column names people use, per field (lower case, punctuation removed by norm())
const FIELDS = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'voucher date', 'invoice date', 'bill date', 'posting date', 'dt', 'tran date', 'doc date'],
  voucher_no: ['voucher no', 'vch no', 'voucher number', 'voucher', 'entry no', 'journal no', 'voucher ref', 'vch number', 'jv no'],
  invoice_no: ['invoice no', 'invoice number', 'inv no', 'bill no', 'bill number', 'invoice', 'document no', 'doc no', 'supplier invoice no', 'invoice ref'],
  voucher_type: ['voucher type', 'vch type', 'type', 'transaction type', 'entry type'],
  party: ['party', 'party name', 'customer', 'customer name', 'supplier', 'supplier name', 'vendor', 'vendor name', 'name of party', 'buyer', 'buyer name', 'seller', 'paid to', 'received from', 'name', 'billed to', 'party account'],
  ledger: ['ledger', 'ledger name', 'account', 'account head', 'particulars', 'head of account', 'gl account', 'account name', 'ledger account'],
  debit: ['debit', 'dr', 'debit amount', 'dr amount', 'withdrawal', 'withdrawals', 'withdrawal amt', 'withdrawal amount', 'paid out', 'debit rs', 'debits'],
  credit: ['credit', 'cr', 'credit amount', 'cr amount', 'deposit', 'deposits', 'deposit amt', 'deposit amount', 'paid in', 'credit rs', 'credits'],
  amount: ['amount', 'net amount', 'amt', 'amount rs', 'paid amount', 'received amount', 'payment amount', 'receipt amount'],
  taxable: ['taxable', 'taxable value', 'taxable amount', 'assessable value', 'basic amount', 'sub total', 'subtotal', 'net value', 'value before tax'],
  cgst: ['cgst', 'cgst amount', 'central tax', 'cgst amt'],
  sgst: ['sgst', 'sgst amount', 'state tax', 'sgst amt', 'utgst', 'sgst utgst'],
  igst: ['igst', 'igst amount', 'integrated tax', 'igst amt'],
  gst_rate: ['gst rate', 'gst %', 'tax rate', 'rate of tax', 'gst', 'tax %', 'gst rate %'],
  total: ['total', 'invoice total', 'invoice value', 'grand total', 'total amount', 'bill amount', 'net payable', 'total value', 'invoice amount'],
  narration: ['narration', 'description', 'remarks', 'details', 'memo', 'transaction details', 'narrative', 'transaction remarks'],
  reference: ['reference', 'ref', 'cheque no', 'chq no', 'utr', 'reference no', 'chq ref no', 'instrument no', 'ref no', 'cheque number'],
  balance: ['balance', 'closing balance', 'running balance', 'balance rs'],
  gstin: ['gstin', 'gst no', 'gstin uin', 'gst number', 'gstin of supplier', 'supplier gstin', 'customer gstin', 'gstin of customer'],
  item: ['item', 'item name', 'product', 'product name', 'stock item', 'description of goods', 'goods', 'item description', 'name of item'],
  qty: ['qty', 'quantity', 'closing qty', 'closing quantity', 'stock qty', 'qty in hand', 'quantity in hand', 'stock'],
  unit: ['unit', 'uom', 'units', 'per'],
  rate: ['rate', 'price', 'unit price', 'unit rate', 'cost', 'rate per unit', 'purchase rate', 'selling price'],
  value: ['value', 'stock value', 'closing value'],
  hsn: ['hsn', 'hsn sac', 'hsn code', 'sac'],
  phone: ['phone', 'mobile', 'contact no', 'phone no', 'mobile no', 'contact', 'mobile number', 'phone number'],
  email: ['email', 'e mail', 'email id', 'email address'],
  city: ['city', 'town', 'place'],
  address: ['address', 'billing address'],
  state: ['state', 'place of supply', 'state name'],
  group: ['group', 'under', 'account group', 'ledger group', 'category', 'group name'],
  mode: ['mode', 'payment mode', 'paid by', 'received in', 'bank', 'cash bank', 'paid through', 'mode of payment', 'bank cash']
};
const FIELD_LOOKUP = new Map();
for (const [f, names] of Object.entries(FIELDS)) for (const n of names) if (!FIELD_LOOKUP.has(norm(n))) FIELD_LOOKUP.set(norm(n), f);
// a word that means different things in different documents
const CONTEXT_FIELD = {
  particulars: { bank_statement: 'narration', stock_statement: 'item', default: 'ledger' },
  description: { stock_statement: 'item', default: 'narration' },
  name: { party_list: 'party', stock_statement: 'item', default: 'party' },
  amount: { trial_balance: 'amount', default: 'amount' },
  value: { stock_statement: 'value', default: 'amount' },
  type: { party_list: 'kind', default: 'voucher_type' },
  rate: { sales_register: 'gst_rate', purchase_register: 'gst_rate', default: 'rate' }
};
function fieldOf(header, category) {
  const h = norm(header);
  if (!h) return null;
  if (CONTEXT_FIELD[h]) return CONTEXT_FIELD[h][category] || CONTEXT_FIELD[h].default;
  if (FIELD_LOOKUP.has(h)) return FIELD_LOOKUP.get(h);
  const noUnit = h.replace(/\b(rs|inr|in rs)\b/g, '').replace(/\s+/g, ' ').trim();
  if (FIELD_LOOKUP.has(noUnit)) return FIELD_LOOKUP.get(noUnit);
  return null;
}

const amount = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-' ) return null;
  const n = csvAmount(s.replace(/\b(dr|cr)\b\.?/ig, '').trim()); // csv.parseAmount: ₹ / Rs / commas removed; (500) = -500
  return Number.isNaN(n) ? NaN : n;
};
const drcrOf = (v) => (/\bcr\b/i.test(String(v)) ? 'Cr' : /\bdr\b/i.test(String(v)) ? 'Dr' : null);
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = require('xlsx').SSF.parse_date_code(v); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
  const s = String(v).trim().replace(/\s+/g, ' ');
  let m;
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s))) return csvDate(`${m[1]}-${m[2]}-20${m[3]}`);
  return csvDate(s);
}

// ------------------------------------------------------------------------------------------------ classification
const KEYWORDS = [
  ['trial_balance', /\btrial balance\b/], ['balance_sheet', /\bbalance sheet\b/], ['profit_loss', /\bprofit\s*(&|and)\s*loss\b|\bincome statement\b|\bp\s*&\s*l\b/],
  ['gst_report', /\bgstr[- ]?(1|2a|2b|3b|9)\b|\bgst (summary|report|return)\b/], ['bank_statement', /\b(bank statement|statement of account|account statement)\b|\bifsc\b/],
  ['transactions', /\bday ?book\b|\bjournal (register|book)\b|\bvoucher register\b/], ['ledger_report', /\bledger (account|statement|report)\b|\bledger:/],
  ['stock_statement', /\bstock (summary|statement|report|register)\b|\binventory (statement|report|summary)\b|\bclosing stock\b/],
  ['party_list', /\b(customer|supplier|vendor|party|debtor|creditor)s? (list|master|details|directory)\b/],
  ['sales_register', /\bsales (register|report|book|statement|summary)\b/], ['purchase_register', /\bpurchase (register|report|book|statement|summary)\b/],
  ['payments', /\bpayments? (register|made|report|list|records?)\b/], ['receipts', /\breceipts? (register|report|list|records?)\b|\bcollections? (report|register)\b/]
];

/** Finds the header row of each sheet: the row with the most recognised column names (at least 2). */
function findTable(rows, category) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const fields = rows[i].map((h) => (typeof h === 'string' ? fieldOf(h, category) : null));
    const n = new Set(fields.filter(Boolean)).size;
    if (n >= 2 && (!best || n > best.n)) best = { row: i, n, fields, headers: rows[i].map((h) => String(h)) };
  }
  return best;
}

function classify(doc, company) {
  const head = `${doc.sheets.map((s) => s.name).join(' ')}\n${doc.text.slice(0, 4000)}`.toLowerCase();
  const reasons = [];
  let category = null;
  for (const [c, re] of KEYWORDS) if (re.test(head)) { category = c; reasons.push(`title / words: "${(head.match(re) || [''])[0]}"`); break; }
  const t = doc.sheets.map((s) => findTable(s.rows, category)).find(Boolean);
  const f = new Set(t ? t.fields.filter(Boolean) : []);
  if (!category) {
    if (f.has('debit') && f.has('credit') && (f.has('balance') && (f.has('narration') || f.has('reference')))) category = 'bank_statement';
    else if (f.has('ledger') && f.has('debit') && f.has('credit')) category = f.has('date') ? 'transactions' : 'trial_balance';
    else if ((f.has('taxable') || f.has('cgst') || f.has('igst')) && (f.has('invoice_no') || f.has('party'))) category = /purchase|supplier|vendor|bill/.test(head) ? 'purchase_register' : 'sales_register';
    else if (f.has('item') && f.has('qty')) category = 'stock_statement';
    else if (f.has('party') && (f.has('gstin') || f.has('phone') || f.has('email')) && !f.has('amount') && !f.has('total')) category = 'party_list';
    else if (f.has('party') && (f.has('amount') || f.has('total')) && f.has('date')) category = /receipt|received|collection/.test(head) ? 'receipts' : /payment|paid/.test(head) ? 'payments' : (/purchase|supplier|vendor/.test(head) ? 'purchase_register' : 'sales_register');
    if (category) reasons.push(`columns: ${[...f].join(', ')}`);
  }
  // a single invoice (not a register): an invoice title, invoice fields in the text, and no register-style table of many invoices.
  // Its item table (item / qty / rate / amount) must not make it a "stock statement"; a titled report (trial balance ...) stays a report.
  const titled = reasons.length && reasons[0].startsWith('title') && !['sales_register', 'purchase_register'].includes(category);
  const single = /\b(tax invoice|invoice no|bill of supply|invoice number|invoice #)\b/.test(head) && (!t || !(t.fields.includes('invoice_no') && t.fields.includes('party')));
  if (!titled && single) {
    reasons.length = 0;
    const g = (head.match(/\b\d{2}[a-z]{5}\d{4}[a-z][1-9a-z]z[0-9a-z]\b/g) || []).map((x) => x.toUpperCase());
    const ours = company && company.gstin ? String(company.gstin).toUpperCase() : null;
    category = ours && g[0] === ours ? 'sales_invoice' : ours && g.includes(ours) ? 'purchase_invoice' : /\b(sold by|supplier|vendor)\b/.test(head) || !ours ? 'purchase_invoice' : 'purchase_invoice';
    reasons.push(ours ? (category === 'sales_invoice' ? 'your GSTIN is the seller\'s' : 'your GSTIN is the buyer\'s (or not on it)') : 'your company GSTIN is not set: treated as a purchase (change it if this is your sales invoice)');
  }
  const confidence = category ? (reasons.length > 1 || (reasons[0] && reasons[0].startsWith('title')) ? 'high' : 'medium') : 'low';
  return { category, confidence, reasons };
}

// ------------------------------------------------------------------------------------------------ rows -> records
function tableRows(doc, category, mapping) {
  const out = []; let headers = null, fields = null;
  for (const s of doc.sheets) {
    const t = findTable(s.rows, category);
    if (!t) continue;
    if (!headers) { headers = t.headers; fields = t.fields.map((f, i) => (mapping && mapping[i] !== undefined ? mapping[i] || null : f)); }
    const sig = norm(t.headers.join('|'));
    const hx = s.xpos && s.xpos[t.row];
    for (let i = t.row + 1; i < s.rows.length; i++) {
      let row = s.rows[i];
      if (norm(row.join('|')) === sig) continue; // the header repeated on the next page
      // PDF / scan: put every value under the column header it lines up with (numbers are right-aligned under their header,
      // text left-aligned), so an empty cell does not shift the next value into the wrong column
      if (hx && s.xpos[i] && row.length !== t.headers.length) {
        const aligned = new Array(t.headers.length).fill('');
        row.forEach((v, c) => {
          const [l, r] = s.xpos[i][c] || [0, 0];
          const numeric = /^[-(]?[₹\d][\d,.]*\)?\s*(dr|cr)?$/i.test(String(v).trim());
          let best = 0, bestD = Infinity;
          hx.forEach(([hl, hr], j) => { const dd = numeric ? Math.abs(r - hr) : Math.abs(l - hl); if (dd < bestD) { bestD = dd; best = j; } });
          aligned[best] = aligned[best] === '' ? v : `${aligned[best]} ${v}`;
        });
        row = aligned;
      }
      const rec = { _sheet: s.name, _row: i + 1, _cells: row };
      t.fields.forEach((_, c) => { const f = fields[c]; if (f && row[c] !== '' && row[c] != null && rec[f] === undefined) rec[f] = row[c]; });
      out.push(rec);
    }
  }
  return { rows: out, headers: headers || [], fields: fields || [] };
}

const isTotalRow = (r) => /^(grand )?total\b|^sub ?total\b|^closing balance\b|^opening balance\b|^balance (b\/f|c\/f|carried|brought)/i.test(String(r.ledger || r.party || r.narration || r.item || r._cells.find((c) => typeof c === 'string' && c) || '').trim());
const TYPE_ALIASES = { sale: 'Sales', sales: 'Sales', 'sales invoice': 'Sales', purchase: 'Purchase', purchases: 'Purchase', payment: 'Payment', pymt: 'Payment', pmt: 'Payment', receipt: 'Receipt', rcpt: 'Receipt', contra: 'Contra', journal: 'Journal', jrnl: 'Journal', jv: 'Journal', 'credit note': 'Credit Note', 'debit note': 'Debit Note', cn: 'Credit Note', dn: 'Debit Note' };
const voucherType = (v) => TYPE_ALIASES[norm(v)] || null;

function buildRecords(doc, category, mapping) {
  const { rows, headers, fields } = tableRows(doc, category, mapping);
  const records = [];
  const meta = { headers, fields, totals_in_file: [] };
  const push = (r, data, problems = []) => records.push({ n: records.length + 1, sheet: r ? r._sheet : null, row: r ? r._row : null, data, problems });

  if (category === 'transactions') {
    let cur = null;
    const flush = () => { if (cur) { push(cur.src, { voucher_type: cur.type, voucher_no: cur.no, date: cur.date, narration: cur.narration, lines: cur.lines }, cur.problems); cur = null; } };
    for (const r of rows) {
      if (isTotalRow(r)) { meta.totals_in_file.push({ row: r._row, debit: amount(r.debit), credit: amount(r.credit) }); continue; }
      const date = r.date != null ? toDate(r.date) : null;
      const no = r.voucher_no != null ? String(r.voucher_no).trim() : null;
      const starts = !cur || (no && no !== cur.no) || (!no && date && cur.balanced);
      if (starts) { flush(); cur = { src: r, date, no, type: r.voucher_type ? voucherType(r.voucher_type) : null, narration: r.narration ? String(r.narration) : '', lines: [], problems: [], dr: 0, cr: 0, balanced: false }; if (r.voucher_type && !cur.type) cur.problems.push(`Unknown voucher type "${r.voucher_type}"`); if (r.date != null && !date) cur.problems.push(`Invalid date "${r.date}"`); }
      if (!cur.narration && r.narration) cur.narration = String(r.narration);
      const dr = r.debit != null ? amount(r.debit) : null, cr = r.credit != null ? amount(r.credit) : null;
      if (!r.ledger) { if (dr || cr) cur.problems.push(`Row ${r._row}: an amount without a ledger name`); continue; }
      if (Number.isNaN(dr) || Number.isNaN(cr)) { cur.problems.push(`Row ${r._row}: amount is not a number`); continue; }
      cur.lines.push({ ledger: String(r.ledger).trim(), debit: r2(dr || 0), credit: r2(cr || 0), row: r._row });
      cur.dr += dr || 0; cur.cr += cr || 0; cur.balanced = Math.round(cur.dr * 100) === Math.round(cur.cr * 100) && cur.dr > 0;
    }
    flush();
  } else if (['sales_register', 'purchase_register'].includes(category)) {
    for (const r of rows) {
      if (isTotalRow(r)) { meta.totals_in_file.push({ row: r._row, total: amount(r.total) }); continue; }
      const p = [];
      const date = toDate(r.date); if (!date) p.push(r.date ? `Invalid date "${r.date}"` : 'Date is missing');
      const party = r.party ? String(r.party).trim() : ''; if (!party) p.push('Party name is missing');
      const num = (k) => (r[k] == null || r[k] === '' ? null : amount(r[k]));
      let taxable = num('taxable'), cgst = num('cgst'), sgst = num('sgst'), igst = num('igst'), total = num('total'), rate = num('gst_rate'), amt = num('amount');
      for (const [k, v] of Object.entries({ taxable, cgst, sgst, igst, total, rate, amount: amt })) if (Number.isNaN(v)) p.push(`${k} is not a number ("${r[k]}")`);
      if (taxable == null && amt != null && total == null) taxable = amt;
      if (taxable == null && total != null && rate != null && cgst == null && igst == null) { taxable = r2(total / (1 + rate / 100)); }
      if (cgst == null && sgst == null && igst == null && rate != null && taxable != null) { cgst = r2(taxable * rate / 200); sgst = cgst; }
      if (total == null && taxable != null) total = r2(taxable + (cgst || 0) + (sgst || 0) + (igst || 0));
      if (taxable == null && total != null && cgst == null && sgst == null && igst == null) { taxable = total; }
      if (taxable == null) p.push('Taxable value / amount is missing');
      push(r, { date, invoice_no: r.invoice_no != null ? String(r.invoice_no).trim() : (r.voucher_no != null ? String(r.voucher_no).trim() : ''), party, gstin: r.gstin ? String(r.gstin).trim().toUpperCase() : '', taxable, cgst: cgst || 0, sgst: sgst || 0, igst: igst || 0, total, gst_rate: rate, narration: r.narration ? String(r.narration) : '' }, p);
    }
  } else if (['payments', 'receipts'].includes(category)) {
    for (const r of rows) {
      if (isTotalRow(r)) continue;
      const p = [];
      const date = toDate(r.date); if (!date) p.push(r.date ? `Invalid date "${r.date}"` : 'Date is missing');
      const party = String(r.party || r.ledger || '').trim(); if (!party) p.push('Party / ledger is missing');
      let amt = r.amount != null ? amount(r.amount) : r.debit != null || r.credit != null ? (amount(r.debit) || 0) + (amount(r.credit) || 0) : r.total != null ? amount(r.total) : null;
      if (amt == null) p.push('Amount is missing'); else if (Number.isNaN(amt) || amt <= 0) p.push(`Amount is not a positive number ("${r.amount ?? r.total ?? r.debit ?? r.credit}")`);
      push(r, { date, party, amount: amt != null && !Number.isNaN(amt) ? r2(amt) : null, mode: r.mode ? String(r.mode).trim() : '', reference: r.reference != null ? String(r.reference) : '', narration: r.narration ? String(r.narration) : '' }, p);
    }
  } else if (category === 'bank_statement') {
    for (const r of rows) {
      if (isTotalRow(r)) continue;
      const p = [];
      const date = toDate(r.date); if (!date) { if (!r.date && !r.debit && !r.credit) continue; p.push(r.date ? `Invalid date "${r.date}"` : 'Date is missing'); }
      const wd = r.debit != null && r.debit !== '' ? amount(r.debit) : null, dep = r.credit != null && r.credit !== '' ? amount(r.credit) : null;
      if (Number.isNaN(wd) || Number.isNaN(dep)) p.push('Withdrawal / deposit is not a number');
      if (!wd && !dep && !Number.isNaN(wd) && !Number.isNaN(dep)) p.push('No withdrawal or deposit amount');
      push(r, { date, description: String(r.narration || r.ledger || '').trim(), withdrawal: wd && !Number.isNaN(wd) ? r2(wd) : 0, deposit: dep && !Number.isNaN(dep) ? r2(dep) : 0, reference: r.reference != null ? String(r.reference) : '', balance: r.balance != null ? amount(r.balance) : null }, p);
    }
  } else if (category === 'party_list') {
    for (const r of rows) {
      const p = [];
      const name = String(r.party || r.ledger || '').trim(); if (!name) { if (r._cells.some((c) => c !== '')) p.push('Name is missing'); else continue; }
      const gstin = r.gstin ? String(r.gstin).trim().toUpperCase() : '';
      if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) p.push(`GSTIN "${gstin}" is not valid`);
      const kind = /supplier|vendor|creditor/i.test(String(r.kind || r.group || '')) ? 'supplier' : /customer|debtor|buyer/i.test(String(r.kind || r.group || '')) ? 'customer' : null;
      push(r, { name, kind, gstin, phone: r.phone ? String(r.phone).trim() : '', email: r.email ? String(r.email).trim() : '', city: r.city ? String(r.city).trim() : '', address: r.address ? String(r.address).trim() : '', state: r.state ? String(r.state).trim() : '' }, p);
    }
  } else if (category === 'stock_statement') {
    for (const r of rows) {
      if (isTotalRow(r)) continue;
      const p = [];
      const name = String(r.item || r.party || r.ledger || '').trim(); if (!name) continue;
      const qty = r.qty != null && r.qty !== '' ? amount(r.qty) : null; if (qty == null) p.push('Quantity is missing'); else if (Number.isNaN(qty) || qty < 0) p.push(`Quantity "${r.qty}" is not valid`);
      let rate = r.rate != null && r.rate !== '' ? amount(r.rate) : null; const value = r.value != null && r.value !== '' ? amount(r.value) : r.amount != null ? amount(r.amount) : null;
      if (rate == null && value != null && qty) rate = r2(value / qty);
      push(r, { name, qty: qty != null && !Number.isNaN(qty) ? qty : null, unit: r.unit ? String(r.unit).trim() : '', rate: rate != null && !Number.isNaN(rate) ? rate : null, value, hsn: r.hsn ? String(r.hsn).trim() : '', gst_rate: r.gst_rate != null ? amount(r.gst_rate) : null }, p);
    }
  } else if (CATEGORIES[category] && CATEGORIES[category].kind === 'report') {
    for (const r of rows) {
      const name = String(r.ledger || r.party || r.item || r._cells.find((c) => typeof c === 'string' && c && !/^\d/.test(c)) || '').trim();
      if (!name) continue;
      let dr = r.debit != null && r.debit !== '' ? amount(r.debit) : null, cr = r.credit != null && r.credit !== '' ? amount(r.credit) : null;
      if (dr == null && cr == null && (r.amount != null || r.balance != null)) { const v = r.amount ?? r.balance; const a = amount(v); const side = drcrOf(v); if (side === 'Cr') cr = a; else dr = a; }
      push(r, { name, debit: dr != null && !Number.isNaN(dr) ? r2(dr) : 0, credit: cr != null && !Number.isNaN(cr) ? r2(cr) : 0, total_row: isTotalRow(r) }, []);
    }
  }
  return { records, meta };
}

// a single invoice (PDF / scan): header fields from the invoice reader, amounts from it
async function singleInvoice(doc, category) {
  const { extractInvoice } = require('./invoiceExtract');
  const ex = await extractInvoice(doc.text, { ocrConfidence: doc.ocr_confidence });
  const f = ex.fields || {};
  const val = (k) => (f[k] && typeof f[k] === 'object' && 'value' in f[k] ? f[k].value : null);
  const p = [];
  const tax = f.tax || {};
  const taxable = val('taxable_value'), cgst = tax.cgst || 0, sgst = tax.sgst || 0, igst = tax.igst || 0, total = val('total');
  const party = (ex.supplier && ex.supplier.name) || ex.detected_supplier_name || '';
  if (!party) p.push('The party (supplier / customer) could not be read: choose or type it');
  if (taxable == null) p.push('Taxable value could not be read');
  const date = val('date') || null;
  if (!date) p.push('Invoice date could not be read');
  return { records: [{ n: 1, sheet: 'Document', row: null, data: { date, invoice_no: val('invoice_no') || '', party, gstin: (category === 'sales_invoice' ? val('buyer_gstin') : val('supplier_gstin')) || '', taxable: taxable != null ? r2(taxable) : null, cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), total: total != null ? r2(total) : null, narration: '' }, problems: p, warnings: ex.warnings || [] }], meta: { headers: [], fields: [], invoice_reader: { warnings: ex.warnings || [] } } };
}

// ------------------------------------------------------------------------------------------------ ledgers
async function ledgerIndex() {
  const rows = await all('SELECT l.id, l.name, l.gstin, l.state_code, g.name AS group_name, g.nature FROM ledgers l JOIN account_groups g ON g.id = l.group_id');
  const byName = new Map(), byGstin = new Map();
  for (const l of rows) { byName.set(norm(l.name), l); if (l.gstin) byGstin.set(String(l.gstin).toUpperCase(), l); }
  return { rows, byName, byGstin, find: (name, gstin) => (gstin && byGstin.get(String(gstin).toUpperCase())) || byName.get(norm(name)) || null };
}
function taxLedger(idx, out, part, rate) {
  const pre = out ? 'output' : 'input';
  const want = rate != null ? `${pre} ${part} ${String(+(rate / 2).toFixed(2)).replace(/\.0+$/, '')}%` : null;
  const all0 = idx.rows.filter((l) => new RegExp(`^${pre}\\s+${part}\\b`, 'i').test(l.name));
  const exact = part === 'igst' ? all0.find((l) => norm(l.name) === norm(`${pre} igst ${rate}%`)) : all0.find((l) => want && norm(l.name) === norm(want));
  return exact || all0.find((l) => !/\d\s*%/.test(l.name)) || null; // never another rate's ledger (12% GST must not land in "9%")
}

const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

/** Builds the voucher for each record and checks it. Returns the preview (nothing written). */
async function evaluate(docRow, extraction, settings = {}) {
  const category = settings.category || extraction.classification.category;
  if (!category || !CATEGORIES[category]) return { category: null, needs_category: true, records: [], summary: {} };
  const built = category.endsWith('_invoice') && !extraction.tableLike ? await singleInvoice(extraction.doc, category) : buildRecords(extraction.doc, category.replace(/_invoice$/, '_register'), settings.mapping);
  // the person's corrections to individual values (record number -> fields)
  // a corrected value replaces the one read from the file, and the problems that value caused are re-checked from scratch
  const FIELD_PROBLEM = { date: /date/i, party: /party|name/i, taxable: /taxable/i, total: /total/i, cgst: /cgst/i, sgst: /sgst/i, igst: /igst/i, amount: /amount/i, invoice_no: /invoice/i, qty: /quantity/i, gst_rate: /rate/i };
  for (const [n, patch] of Object.entries(settings.edits || {})) {
    const rec = built.records.find((x) => String(x.n) === String(n));
    if (!rec || !patch || typeof patch !== 'object') continue;
    for (const [k, v] of Object.entries(patch)) {
      let val = v;
      if (k === 'date') { val = toDate(v); if (!val) { rec.problems.push(`Invalid date "${v}"`); continue; } }
      else if (['taxable', 'cgst', 'sgst', 'igst', 'total', 'amount', 'qty', 'rate', 'gst_rate', 'withdrawal', 'deposit'].includes(k)) { val = v === '' || v == null ? null : amount(v); if (Number.isNaN(val)) { rec.problems.push(`${k} is not a number ("${v}")`); continue; } }
      else val = v == null ? '' : String(v).trim();
      rec.data[k] = val;
      if (FIELD_PROBLEM[k]) rec.problems = rec.problems.filter((pr) => !FIELD_PROBLEM[k].test(pr));
    }
    rec.edited = true;
  }
  const idx = await ledgerIndex();
  const company = (await get('SELECT gstin, state_code, financial_year_from, books_beginning_from FROM company_info LIMIT 1')) || {};
  const groups = await all('SELECT id, name, nature FROM account_groups');
  const gid = (n) => (groups.find((g) => g.name === n) || {}).id;
  const map = settings.ledger_map || {};               // "name as in the file" -> ledger id | 'create:<group id>'
  const unknown = new Map();                            // name -> { suggested group, used by }
  const resolve = (name, gstin, suggest) => {
    const m = map[name];
    // "create it" chosen earlier, but the ledger exists by now (created by an earlier import of this file): it is that ledger
    if (m && /^create:\d+$/.test(String(m))) return idx.find(name, gstin) || { create: true, group_id: parseInt(String(m).slice(7), 10), name };
    if (m && /^\d+$/.test(String(m))) { const l = idx.rows.find((x) => x.id === parseInt(m, 10)); if (l) return l; }
    const l = idx.find(name, gstin);
    if (l) return l;
    const willCreate = !!(suggest && settings.create_missing_parties !== false && gid(suggest));
    if (!unknown.has(name)) unknown.set(name, { name, suggest, records: 0, will_create: willCreate }); unknown.get(name).records++;
    // a customer / supplier on an invoice, payment or receipt is created when missing (unless switched off); any other ledger never
    // without the person deciding
    return willCreate ? { create: true, group_id: gid(suggest), name } : null;
  };
  const today = new Date().toISOString().slice(0, 10);
  const fyStart = company.books_beginning_from || company.financial_year_from || null;
  const seen = new Set();
  const out = [];
  const pickDefault = (id, nature) => (id && idx.rows.find((l) => l.id === parseInt(id, 10))) || null;
  const salesL = pickDefault(settings.sales_ledger_id) || idx.rows.find((l) => l.group_name === 'Sales Accounts');
  const purchL = pickDefault(settings.purchase_ledger_id) || idx.rows.find((l) => l.group_name === 'Purchase Accounts');
  const bankL = pickDefault(settings.bank_ledger_id) || idx.rows.find((l) => l.group_name === 'Bank Accounts') || idx.rows.find((l) => l.group_name === 'Cash-in-hand');
  const roundL = idx.rows.find((l) => /^round off/i.test(l.name));

  for (const rec of built.records) {
    const d = rec.data;
    const errors = [...rec.problems], warnings = [...(rec.warnings || [])];
    let voucher = null, action = null;
    const checkDate = (date) => {
      if (!date) return;
      if (date > today) errors.push(`Date ${date} is in the future`);
      else if (date < '2000-01-01') errors.push(`Date ${date} is not plausible`);
      else if (fyStart && date < fyStart) warnings.push(`Date ${date} is before the books begin (${fyStart})`);
    };
    if (['sales_register', 'purchase_register', 'sales_invoice', 'purchase_invoice'].includes(category)) {
      const sales = category.startsWith('sales');
      checkDate(d.date);
      const taxes = r2((d.cgst || 0) + (d.sgst || 0) + (d.igst || 0));
      if (d.taxable != null && d.taxable <= 0) errors.push('Taxable value must be more than zero');
      if (d.cgst && d.igst) errors.push('An invoice has either CGST + SGST or IGST, not both');
      if (Math.abs((d.cgst || 0) - (d.sgst || 0)) > 0.011) errors.push(`CGST (${d.cgst}) and SGST (${d.sgst}) must be equal`);
      const calc = d.taxable != null ? r2(d.taxable + taxes) : null;
      const diff = d.total != null && calc != null ? r2(d.total - calc) : 0;
      if (Math.abs(diff) > 1) errors.push(`Invoice total ₹${d.total} does not equal taxable ₹${d.taxable} + GST ₹${taxes} = ₹${calc}`);
      const rate = d.taxable ? r2(taxes / d.taxable * 100) : 0;
      if (d.taxable && taxes && !GST_RATES.some((g) => Math.abs(g - rate) <= 0.15)) warnings.push(`GST works out to ${rate}% of the taxable value, which is not a standard rate`);
      if (d.gst_rate != null && d.taxable && Math.abs(d.gst_rate - rate) > 0.15 && taxes) errors.push(`GST rate ${d.gst_rate}% does not match the tax amounts (${rate}%)`);
      if (!d.invoice_no) warnings.push('No invoice number: duplicates of this invoice cannot be detected');
      const party = d.party ? resolve(d.party, d.gstin, sales ? 'Sundry Debtors' : 'Sundry Creditors') : null;
      const main = sales ? salesL : purchL;
      if (!main) errors.push(`No ${sales ? 'Sales' : 'Purchase'} account ledger: choose one`);
      const tax = (part, amt) => { if (!amt) return null; const l = taxLedger(idx, sales, part, part === 'igst' ? rate : rate); if (!l) errors.push(`No ${sales ? 'Output' : 'Input'} ${part.toUpperCase()} ledger for ${part === 'igst' ? rate : rate / 2}%: create it in Masters first`); return l; };
      const lc = tax('cgst', d.cgst), ls = tax('sgst', d.sgst), li = tax('igst', d.igst);
      if (Math.abs(diff) > 0.004 && Math.abs(diff) <= 1 && !roundL) errors.push('A Round Off ledger is needed for the paise difference');
      if (!errors.length && d.party && (party || map[d.party])) {
        const lines = [];
        const total = d.total != null ? d.total : calc;
        const pName = party ? party.name : d.party;
        if (sales) {
          lines.push({ ledger: pName, ledger_id: party && party.id, debit: total, credit: 0 }, { ledger: main.name, ledger_id: main.id, debit: 0, credit: d.taxable });
          if (lc) lines.push({ ledger: lc.name, ledger_id: lc.id, debit: 0, credit: d.cgst }); if (ls) lines.push({ ledger: ls.name, ledger_id: ls.id, debit: 0, credit: d.sgst }); if (li) lines.push({ ledger: li.name, ledger_id: li.id, debit: 0, credit: d.igst });
          if (Math.abs(diff) > 0.004) lines.push({ ledger: roundL.name, ledger_id: roundL.id, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0 });
        } else {
          lines.push({ ledger: main.name, ledger_id: main.id, debit: d.taxable, credit: 0 });
          if (lc) lines.push({ ledger: lc.name, ledger_id: lc.id, debit: d.cgst, credit: 0 }); if (ls) lines.push({ ledger: ls.name, ledger_id: ls.id, debit: d.sgst, credit: 0 }); if (li) lines.push({ ledger: li.name, ledger_id: li.id, debit: d.igst, credit: 0 });
          if (Math.abs(diff) > 0.004) lines.push({ ledger: roundL.name, ledger_id: roundL.id, debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0 });
          lines.push({ ledger: pName, ledger_id: party && party.id, debit: 0, credit: total });
        }
        voucher = { voucher_type: sales ? 'Sales' : 'Purchase', date: d.date, reference_no: d.invoice_no || '', narration: d.narration || `${sales ? 'Sales' : 'Purchase'} invoice ${d.invoice_no || ''} (imported from ${docRow.file_name})`.trim(), party: pName, party_create: party && party.create ? party : null, party_gstin: d.gstin, lines, bill: { ref: d.invoice_no || null, amount: total } };
      } else if (!errors.length && d.party && !party) errors.push(`"${d.party}" is not a ledger yet: choose an existing ledger or let it be created`);
      // duplicates: in this file, and in the books (same invoice number for the same party, or the same voucher number)
      const key = `${sales}|${norm(d.party)}|${norm(d.invoice_no)}`;
      if (d.invoice_no) {
        if (seen.has(key)) { action = 'duplicate'; warnings.push(`Invoice ${d.invoice_no} of ${d.party} appears twice in this file: only the first is imported`); }
        seen.add(key);
        const inBooks = party && party.id ? await get('SELECT voucher_no FROM vouchers WHERE voucher_type = ? AND reference_no = ? AND party_ledger_id = ? LIMIT 1', [sales ? 'Sales' : 'Purchase', d.invoice_no, party.id]) : null;
        if (inBooks) { action = 'duplicate'; warnings.push(`Already in the books as ${inBooks.voucher_no}`); }
      }
    } else if (['payments', 'receipts'].includes(category)) {
      checkDate(d.date);
      const pay = category === 'payments';
      const party = d.party ? resolve(d.party, null, pay ? 'Sundry Creditors' : 'Sundry Debtors') : null;
      const via = d.mode ? (idx.find(d.mode) || null) : null;
      const cashbank = via && ['Bank Accounts', 'Cash-in-hand', 'Bank OD A/c'].includes(via.group_name) ? via : /cash/i.test(d.mode || '') ? idx.rows.find((l) => l.group_name === 'Cash-in-hand') : bankL;
      if (!cashbank) errors.push('Choose the bank / cash ledger the money went through');
      if (!errors.length && party) {
        const pName = party.name;
        const lines = pay ? [{ ledger: pName, ledger_id: party.id, debit: d.amount, credit: 0 }, { ledger: cashbank.name, ledger_id: cashbank.id, debit: 0, credit: d.amount }]
          : [{ ledger: cashbank.name, ledger_id: cashbank.id, debit: d.amount, credit: 0 }, { ledger: pName, ledger_id: party.id, debit: 0, credit: d.amount }];
        voucher = { voucher_type: pay ? 'Payment' : 'Receipt', date: d.date, reference_no: d.reference || '', narration: d.narration || `${pay ? 'Payment to' : 'Receipt from'} ${pName} (imported from ${docRow.file_name})`, party: pName, party_create: party.create ? party : null, lines };
      } else if (!errors.length && !party) errors.push(`"${d.party}" is not a ledger yet: choose an existing ledger or let it be created`);
      const key = `${category}|${d.date}|${norm(d.party)}|${d.amount}|${norm(d.reference)}`;
      if (seen.has(key)) { action = 'duplicate'; warnings.push('The same payment / receipt appears twice in this file: only the first is imported'); }
      seen.add(key);
      if (party && party.id && d.reference) {
        const inBooks = await get('SELECT v.voucher_no FROM vouchers v WHERE v.voucher_type = ? AND v.reference_no = ? AND v.date = ? AND ABS(v.total_amount - ?) < 0.01 LIMIT 1', [pay ? 'Payment' : 'Receipt', d.reference, d.date, d.amount]);
        if (inBooks) { action = 'duplicate'; warnings.push(`Already in the books as ${inBooks.voucher_no}`); }
      }
    } else if (category === 'transactions') {
      checkDate(d.date);
      if (!d.date) errors.push('Date is missing');
      if (!d.lines.length) errors.push('No ledger lines');
      const type = d.voucher_type || settings.default_voucher_type || 'Journal';
      if (!d.voucher_type) warnings.push(`No voucher type in the file: posted as ${type}`);
      const dr = r2(d.lines.reduce((t, l) => t + l.debit, 0)), cr = r2(d.lines.reduce((t, l) => t + l.credit, 0));
      if (dr !== cr) errors.push(`Debits ₹${dr} and credits ₹${cr} are not equal`);
      if (d.lines.length < 2) errors.push('A voucher needs at least two ledger lines');
      const lines = d.lines.map((l) => { const led = resolve(l.ledger, null, null); return { ledger: led ? led.name : l.ledger, ledger_id: led && led.id, create: led && led.create ? led : null, debit: l.debit, credit: l.credit, missing: !led }; });
      for (const l of lines) if (l.missing) errors.push(`Ledger "${l.ledger}" does not exist: choose an existing ledger or create it`);
      if (!errors.length) voucher = { voucher_type: type, voucher_no: d.voucher_no || null, date: d.date, reference_no: d.voucher_no || '', narration: d.narration || `Imported from ${docRow.file_name}`, lines };
      if (d.voucher_no) {
        if (seen.has(d.voucher_no)) { action = 'duplicate'; warnings.push(`Voucher ${d.voucher_no} appears twice in this file`); }
        seen.add(d.voucher_no);
        if (await get('SELECT id FROM vouchers WHERE voucher_no = ?', [d.voucher_no])) { action = 'duplicate'; warnings.push(`Voucher number ${d.voucher_no} is already in the books`); }
      }
    } else if (category === 'party_list') {
      const kind = d.kind || settings.party_kind || 'customer';
      const ex = idx.find(d.name, d.gstin);
      if (ex) { action = 'exists'; warnings.push(`Already a ledger (${ex.name}, ${ex.group_name}): left unchanged`); }
      if (seen.has(norm(d.name))) { action = 'duplicate'; warnings.push('Appears twice in this file'); }
      seen.add(norm(d.name));
      voucher = null; rec.master = { kind, ...d };
    } else if (category === 'stock_statement') {
      const ex = await get('SELECT id, name, opening_qty FROM stock_items WHERE LOWER(name) = LOWER(?)', [d.name]);
      if (ex) { action = 'exists'; warnings.push(`Already a stock item (${ex.name}): quantity not changed. Use a stock adjustment to correct stock.`); }
      if (d.rate == null && !errors.length) warnings.push('No rate: opening value is 0');
      if (seen.has(norm(d.name))) { action = 'duplicate'; warnings.push('Appears twice in this file'); }
      seen.add(norm(d.name));
      rec.master = d;
    } else if (category === 'bank_statement') {
      checkDate(d.date);
    } else if (CATEGORIES[category].kind === 'report') {
      // compared with the books (closing balance of the ledger of the same name), never posted
      const l = idx.find(d.name);
      if (!d.total_row && l) {
        const b = await get("SELECT (CASE WHEN l.opening_balance_type = 'Cr' THEN -1 ELSE 1 END) * COALESCE(l.opening_balance, 0) + COALESCE((SELECT SUM(debit_amount - credit_amount) FROM ledger_entries e WHERE e.ledger_id = l.id), 0) AS b FROM ledgers l WHERE l.id = ?", [l.id]);
        const mine = r2(b.b), theirs = r2((d.debit || 0) - (d.credit || 0));
        rec.compare = { ledger: l.name, in_books: mine, in_file: theirs, difference: r2(theirs - mine) };
      } else if (!d.total_row) rec.compare = { ledger: null, in_file: r2((d.debit || 0) - (d.credit || 0)), note: 'no ledger of this name in the books' };
    }
    const status = errors.length ? 'error' : action === 'duplicate' ? 'duplicate' : action === 'exists' ? 'exists' : CATEGORIES[category].kind === 'report' ? 'reference' : 'ok';
    out.push({ n: rec.n, sheet: rec.sheet, row: rec.row, data: d, edited: !!rec.edited, status, errors, warnings, voucher, master: rec.master || null, compare: rec.compare || null });
  }

  // summary for the preview
  const kind = CATEGORIES[category].kind;
  const ok = out.filter((r) => r.status === 'ok');
  const sumLines = (rs, k) => r2(rs.reduce((t, r) => t + (r.voucher ? r.voucher.lines.reduce((s, l) => s + (l[k] || 0), 0) : 0), 0));
  const inv = out.filter((r) => r.data && r.data.total != null);
  const summary = {
    records: out.length, valid: ok.length, errors: out.filter((r) => r.status === 'error').length, duplicates: out.filter((r) => r.status === 'duplicate').length, existing: out.filter((r) => r.status === 'exists').length,
    total_debit: sumLines(ok, 'debit'), total_credit: sumLines(ok, 'credit'),
    gst: r2(out.reduce((t, r) => t + (r.data ? (r.data.cgst || 0) + (r.data.sgst || 0) + (r.data.igst || 0) : 0), 0)),
    invoice_total: r2(inv.reduce((t, r) => t + (r.data.total || 0), 0)),
    missing_fields: [...new Set(out.flatMap((r) => r.errors.filter((e) => /missing|could not be read/i.test(e)).map((e) => e.replace(/ \(.*$/, ''))))],
    report_debit: kind === 'report' ? r2(out.filter((r) => !r.data.total_row).reduce((t, r) => t + (r.data.debit || 0), 0)) : undefined,
    report_credit: kind === 'report' ? r2(out.filter((r) => !r.data.total_row).reduce((t, r) => t + (r.data.credit || 0), 0)) : undefined,
    differences: kind === 'report' ? out.filter((r) => r.compare && r.compare.difference && Math.abs(r.compare.difference) >= 0.01).length : undefined
  };
  if (kind === 'bank_statement' || category === 'bank_statement') { summary.withdrawals = r2(out.reduce((t, r) => t + (r.data.withdrawal || 0), 0)); summary.deposits = r2(out.reduce((t, r) => t + (r.data.deposit || 0), 0)); }
  return {
    category, category_label: CATEGORIES[category].label, kind, summary, records: out,
    unknown_ledgers: [...unknown.values()].map((u) => ({ ...u, suggest_group_id: gid(u.suggest) || null })),
    columns: built.meta.headers.map((h, i) => ({ index: i, header: h, field: built.meta.fields[i] || null })),
    totals_in_file: built.meta.totals_in_file || [],
    defaults: { sales_ledger: salesL ? { id: salesL.id, name: salesL.name } : null, purchase_ledger: purchL ? { id: purchL.id, name: purchL.name } : null, bank_ledger: bankL ? { id: bankL.id, name: bankL.name } : null }
  };
}

// ------------------------------------------------------------------------------------------------ storage, preview, commit
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const userName = (u) => (u && (u.username || u.full_name)) || 'unknown';

async function upload({ buffer, fileName, mime }, user) {
  if (!buffer || !buffer.length) throw bad(400, 'The file is empty.');
  const name = String(fileName || 'document').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180);
  const doc = await readDocument(buffer, name); // throws a readable error for an unsupported / damaged file
  const company = (await get('SELECT gstin FROM company_info LIMIT 1')) || {};
  const classification = classify(doc, company);
  const hash = sha256(buffer);
  const prior = await get("SELECT id, status, imported_at FROM import_documents WHERE sha256 = ? ORDER BY id DESC LIMIT 1", [hash]);
  const extraction = { doc, classification, tableLike: !!doc.sheets.find((s) => findTable(s.rows, classification.category)) && !/_invoice$/.test(classification.category || '') };
  const status = doc.needs_ocr ? 'needs_ocr' : 'read';
  const id = await require('./tx').withTransaction(async () => {
    const r = await run(`INSERT INTO import_documents (file_name, mime, kind, size, sha256, category, status, extraction, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, String(mime || '').slice(0, 100) || null, doc.kind, buffer.length, hash, classification.category, status, JSON.stringify(extraction), userName(user)]);
    await run('INSERT INTO import_document_data (document_id, data) VALUES (?, ?)', [r.lastID, buffer]);
    return r.lastID;
  });
  return { id, file_name: name, kind: doc.kind, pages: doc.pages, needs_ocr: doc.needs_ocr, status, classification, warnings: doc.warnings, already_imported: prior && prior.status === 'imported' ? { id: prior.id, at: prior.imported_at } : null };
}

async function loadDoc(id) {
  const d = await get('SELECT * FROM import_documents WHERE id = ?', [id]);
  if (!d) throw bad(404, 'Import document not found.');
  return d;
}

/** Scanned PDF: the text of one page, read by the OCR (the browser renders the page; core/ocr.js reads the image). */
async function addOcrPage(id, page, imageBuffer) {
  const d = await loadDoc(id);
  if (d.status === 'imported') throw bad(409, 'This document was already imported.');
  const ocr = require('./ocr');
  const r = await ocr.recognise(imageBuffer);
  const ex = JSON.parse(d.extraction);
  if (page > ex.doc.pages) throw bad(400, `This document has ${ex.doc.pages} page(s).`);
  ex.doc.sheets[page - 1] = require('./docRead').ocrSheet(`Page ${page} (OCR)`, r);
  ex.doc.ocr_pages = Object.assign(ex.doc.ocr_pages || {}, { [page]: Math.round(r.confidence || 0) });
  const done = Object.keys(ex.doc.ocr_pages).length;
  if (done >= ex.doc.pages) {
    ex.doc.text = ex.doc.sheets.map((s) => (s.rows || []).map((rw) => rw.join('  ')).join('\n')).join('\n');
    ex.doc.ocr_confidence = Math.round(Object.values(ex.doc.ocr_pages).reduce((a, b) => a + b, 0) / done);
    const company = (await get('SELECT gstin FROM company_info LIMIT 1')) || {};
    ex.classification = classify(ex.doc, company);
    ex.tableLike = !!ex.doc.sheets.find((s) => findTable(s.rows || [], ex.classification.category)) && !/_invoice$/.test(ex.classification.category || '');
    ex.doc.warnings = (ex.doc.warnings || []).concat(`Read with OCR (average confidence ${ex.doc.ocr_confidence}%). Check every figure in the preview.`);
  }
  await run('UPDATE import_documents SET extraction = ?, status = ?, category = ? WHERE id = ?', [JSON.stringify(ex), done >= ex.doc.pages ? 'read' : 'needs_ocr', ex.classification.category, id]);
  return { page, pages: ex.doc.pages, done, confidence: Math.round(r.confidence || 0), classification: done >= ex.doc.pages ? ex.classification : null };
}

/** what was read from the file: type, pages / sheets, rows */
function fileInfo(d, ex) {
  const sheets = (ex.doc.sheets || []).filter(Boolean);
  return { kind: d.kind, size: d.size, pages: ex.doc.pages || null, sheets: d.kind === 'pdf' || d.kind === 'image' ? [] : sheets.map((s) => s.name),
    rows: sheets.reduce((t, s) => t + (s.rows || []).filter((r) => (r || []).some((c) => c !== '' && c != null)).length, 0), ocr_confidence: ex.doc.ocr_confidence || null, truncated: !!ex.doc.truncated };
}

async function preview(id, settings = {}) {
  const d = await loadDoc(id);
  if (d.status === 'needs_ocr') throw bad(409, 'The scanned pages are still being read (OCR).');
  const ex = JSON.parse(d.extraction);
  const merged = { ...(d.settings ? JSON.parse(d.settings) : {}), ...settings };
  const p = await evaluate(d, ex, merged);
  await run('UPDATE import_documents SET settings = ?, category = ?, detected = ? WHERE id = ?', [JSON.stringify(merged), p.category, p.records.length, id]);
  const prior = await get("SELECT id, imported_at FROM import_documents WHERE sha256 = ? AND status = 'imported' AND id <> ? ORDER BY id DESC LIMIT 1", [d.sha256, id]);
  return { id: d.id, file_name: d.file_name, kind: d.kind, status: d.status, file_info: fileInfo(d, ex), classification: ex.classification, warnings: ex.doc.warnings || [], already_imported: prior ? { id: prior.id, at: prior.imported_at } : null,
    categories: Object.entries(CATEGORIES).map(([k, v]) => ({ id: k, label: v.label, kind: v.kind })), settings: merged, ...p };
}

const committing = new Set(); // one import at a time per document (a double click waits for nothing: it is refused)
async function commit(id, settings = {}, user) {
  const key = `${require('./db').getCompanyNumber()}:${id}`;
  if (committing.has(key)) throw bad(409, 'This document is being imported right now.');
  committing.add(key);
  try { return await commitOnce(id, settings, user); } finally { committing.delete(key); }
}
async function commitOnce(id, settings = {}, user) {
  const d = await loadDoc(id);
  const before = d.status === 'imported' ? JSON.parse(d.result || '{}') : null;
  // a retry / second click returns the first result; "continue" imports the rows corrected after the first import
  if (before && !settings.continue) return { ...before, replayed: true };
  const done = new Set((before && before.imported_ns || []).map(String));
  const p = await preview(id, settings);
  if (!p.category) throw bad(400, 'Choose what kind of document this is.');
  if (p.kind === 'report') throw bad(400, `A ${p.category_label.split(' (')[0].toLowerCase()} is a report: it is compared with the books and never turned into vouchers.`);
  const only = Array.isArray(settings.only) ? new Set(settings.only.map(String)) : null; // the records the person kept (default: every valid one)
  const take = p.records.filter((r) => r.status === 'ok' && !done.has(String(r.n)) && (!only || only.has(String(r.n))));
  const rejected = p.records.filter((r) => !take.includes(r) && !done.has(String(r.n))).map((r) => ({ n: r.n, row: r.row, status: r.status, reason: r.errors.concat(r.warnings).join('; ') || (only && !only.has(String(r.n)) ? 'left out by you' : '') }));
  if (!take.length) throw bad(400, 'Nothing to import: no valid record is selected.', { preview: p });
  // the role may post these voucher types?
  const perms = require('./db').getRolePermissions((user && user.role) || 'Owner');
  for (const r of take) if (r.voucher && !(perms.allowedVoucherTypes || []).includes(r.voucher.voucher_type)) throw bad(403, `Your role may not post ${r.voucher.voucher_type} vouchers.`);

  const { postVoucher } = require('./voucherService');
  const created = { vouchers: [], ledgers: [], parties: [], items: [], bank_import: null };
  const groupId = async (name) => (await get('SELECT id FROM account_groups WHERE name = ?', [name]) || {}).id;
  if (p.category === 'bank_statement') {
    // the statement goes to bank reconciliation (it never posts vouchers): bankTools reads it as CSV
    const bankId = parseInt(settings.bank_ledger_id || (p.defaults.bank_ledger && p.defaults.bank_ledger.id), 10);
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = ['Date,Description,Reference,Withdrawal,Deposit,Balance'].concat(take.map((r) => [r.data.date, r.data.description, r.data.reference, r.data.withdrawal || '', r.data.deposit || '', r.data.balance ?? ''].map(q).join(','))).join('\n');
    const bank = require('./bankTools');
    const imp = await bank.importStatement({ bank_ledger_id: bankId, content: csv, filename: d.file_name }, user);
    created.bank_import = imp;
  } else {
    await require('./tx').withTransaction(async () => {
      const made = new Map(); // ledger names created in this import -> id
      const ensureLedger = async (name, group_id, extra = {}) => {
        const k = norm(name); if (made.has(k)) return made.get(k);
        const ex = await get('SELECT id FROM ledgers WHERE LOWER(name) = LOWER(?)', [name]); if (ex) { made.set(k, ex.id); return ex.id; }
        const g = await get('SELECT id, name FROM account_groups WHERE id = ?', [group_id]); if (!g) throw bad(400, `Choose a valid group for the new ledger "${name}".`);
        const r = await run('INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state, state_code) VALUES (?, ?, 0, ?, ?, ?, ?)',
          [name, g.id, ['Sundry Creditors', 'Duties & Taxes'].includes(g.name) || /income|sales/i.test(g.name) ? 'Cr' : 'Dr', extra.gstin || null, extra.state || null, extra.gstin ? String(extra.gstin).slice(0, 2) : null]);
        made.set(k, r.lastID); created.ledgers.push({ id: r.lastID, name, group: g.name }); return r.lastID;
      };
      if (['party_list', 'stock_statement'].includes(p.category)) {
        for (const r of take) {
          if (p.category === 'party_list') {
            const m = r.master; const id = await ensureLedger(m.name, await groupId(m.kind === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors'), m);
            await run('INSERT OR IGNORE INTO party_profiles (ledger_id) VALUES (?)', [id]);
            await run('UPDATE party_profiles SET email = ?, phone = ?, city = ? WHERE ledger_id = ?', [m.email || null, m.phone || null, m.city || null, id]);
            if (m.address) await run('UPDATE ledgers SET address = ? WHERE id = ?', [m.address, id]);
            created.parties.push({ id, name: m.name, kind: m.kind });
          } else {
            const m = r.master;
            let uom = m.unit ? await get('SELECT id FROM units_of_measure WHERE LOWER(symbol) = LOWER(?) OR LOWER(formal_name) = LOWER(?)', [m.unit, m.unit]) : null;
            if (!uom && m.unit) { const u = await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, 2)', [m.unit.toUpperCase().slice(0, 10), m.unit]); uom = { id: u.lastID }; }
            if (!uom) uom = await get('SELECT id FROM units_of_measure ORDER BY id LIMIT 1');
            const grp = (await get("SELECT id FROM stock_groups WHERE name = 'Imported Items'")) || { id: (await run("INSERT INTO stock_groups (name) VALUES ('Imported Items')")).lastID };
            const q = m.qty || 0, rate = m.rate || 0;
            const ins = await run('INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, opening_qty, opening_rate, opening_val, standard_cost, standard_price, reorder_level, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)',
              [m.name, grp.id, uom.id, /^\d{4,8}$/.test(m.hsn || '') ? m.hsn : null, m.gst_rate != null && !Number.isNaN(m.gst_rate) ? m.gst_rate : 18, q, rate, r2(q * rate), rate]);
            await run('UPDATE stock_items SET sku = ? WHERE id = ?', [`SKU-${String(ins.lastID).padStart(5, '0')}`, ins.lastID]);
            created.items.push({ id: ins.lastID, name: m.name, qty: q });
          }
        }
      } else {
        for (const r of take) {
          const v = r.voucher;
          let partyId = null;
          for (const l of v.lines) {
            if (!l.ledger_id) {
              const m = settings.ledger_map && settings.ledger_map[l.ledger];
              const create = l.create || (v.party_create && norm(v.party_create.name) === norm(l.ledger) ? v.party_create : null) || (m && /^create:/.test(m) ? { group_id: parseInt(String(m).slice(7), 10) } : null);
              if (!create) throw bad(400, `Record ${r.n}: ledger "${l.ledger}" does not exist.`);
              l.ledger_id = await ensureLedger(l.ledger, create.group_id, l.ledger === v.party ? { gstin: v.party_gstin } : {});
            }
            if (norm(l.ledger) === norm(v.party)) partyId = l.ledger_id;
          }
          const payload = { voucher_type: v.voucher_type, voucher_no: v.voucher_no || undefined, date: v.date, reference_no: v.reference_no, narration: v.narration, party_ledger_id: partyId,
            entries: v.lines.map((l) => ({ ledger_id: l.ledger_id, debit_amount: l.debit, credit_amount: l.credit, particulars: l.ledger })),
            bill_allocations: v.bill && partyId ? [{ ledger_id: partyId, bill_type: 'New Ref', bill_ref: v.bill.ref || undefined, amount: v.bill.amount }] : undefined };
          const res = await postVoucher(payload, { inTransaction: true, userId: user && user.userId });
          created.vouchers.push({ n: r.n, id: res.id, voucher_no: res.voucher_no, voucher_type: res.voucher_type, total: res.total_amount });
        }
      }
      await run('INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user && user.userId || null, userName(user), user && user.role || null, 'DOCUMENT_IMPORT', 'import_document', String(id),
          JSON.stringify({ file: d.file_name, category: p.category, vouchers: created.vouchers.map((x) => x.voucher_no), ledgers: created.ledgers.map((x) => x.name), parties: created.parties.length, items: created.items.length })]);
    });
  }
  if (before) { // merge with the first import
    for (const k of ['vouchers', 'ledgers', 'parties', 'items']) created[k] = (before.created && before.created[k] || []).concat(created[k]);
    if (!created.bank_import && before.created) created.bank_import = before.created.bank_import;
  }
  const importedNs = [...done, ...take.map((r) => String(r.n))];
  const t = (k) => r2(take.reduce((s, r) => s + (r.voucher ? r.voucher.lines.reduce((a, l) => a + (l[k] || 0), 0) : 0), 0));
  const totals = { debit: r2(((before && before.totals || {}).debit || 0) + t('debit')), credit: r2(((before && before.totals || {}).credit || 0) + t('credit')),
    gst: r2(((before && before.totals || {}).gst || 0) + take.reduce((s, r) => s + (r.data ? (r.data.cgst || 0) + (r.data.sgst || 0) + (r.data.igst || 0) : 0), 0)) };
  const ex = JSON.parse(d.extraction);
  const result = { id, file_name: d.file_name, file_info: fileInfo(d, ex), category: p.category, category_label: p.category_label, kind: p.kind,
    records: p.records.length, valid: done.size + p.records.filter((r) => r.status === 'ok' && !done.has(String(r.n))).length, duplicates: p.records.filter((r) => r.status === 'duplicate' && !done.has(String(r.n))).length, imported: importedNs.length, imported_now: take.length, imported_ns: importedNs,
    rejected: rejected.length, rejected_records: rejected, created, totals, summary: p.summary, verification: await verifySaved(created) };
  await run('UPDATE import_documents SET status = ?, imported = ?, rejected = ?, result = ?, imported_by = ?, imported_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?',
    ['imported', importedNs.length, rejected.length, JSON.stringify(result), userName(user), id]);
  return result;
}

/** read back what the import saved: every voucher is in the books (and so in the Day Book), Dr = Cr, the closing balance of each ledger it touched */
async function verifySaved(created) {
  const ids = (created.vouchers || []).map((v) => v.id);
  const out = { vouchers_expected: ids.length, vouchers_found: 0, balanced: true, dates: [], ledgers: [] };
  if (!ids.length) return out;
  const touched = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200), q = chunk.map(() => '?').join(',');
    const vs = await all(`SELECT v.id, v.date, COALESCE(SUM(e.debit_amount), 0) AS dr, COALESCE(SUM(e.credit_amount), 0) AS cr FROM vouchers v LEFT JOIN ledger_entries e ON e.voucher_id = v.id WHERE v.id IN (${q}) GROUP BY v.id, v.date`, chunk);
    out.vouchers_found += vs.length;
    for (const v of vs) { if (Math.abs(Number(v.dr) - Number(v.cr)) > 0.005) out.balanced = false; if (!out.dates.includes(v.date)) out.dates.push(v.date); }
    for (const e of await all(`SELECT DISTINCT ledger_id FROM ledger_entries WHERE voucher_id IN (${q})`, chunk)) touched.add(Number(e.ledger_id));
  }
  out.dates.sort();
  for (const lid of [...touched].slice(0, 60)) {
    const l = await get(`SELECT l.id, l.name, l.opening_balance, l.opening_balance_type, COALESCE((SELECT SUM(debit_amount) - SUM(credit_amount) FROM ledger_entries WHERE ledger_id = l.id), 0) AS net FROM ledgers l WHERE l.id = ?`, [lid]);
    if (!l) continue;
    const bal = r2((l.opening_balance_type === 'Cr' ? -1 : 1) * (Number(l.opening_balance) || 0) + Number(l.net));
    out.ledgers.push({ id: l.id, name: l.name, closing: Math.abs(bal), type: bal < 0 ? 'Cr' : 'Dr' });
  }
  out.ledgers.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function history({ limit = 200 } = {}) {
  return all(`SELECT id, file_name, kind, size, category, status, detected, imported, rejected, error, uploaded_by, uploaded_at, imported_by, imported_at FROM import_documents ORDER BY id DESC LIMIT ?`, [Math.min(500, limit)]);
}
async function detail(id) {
  const d = await loadDoc(id);
  return { id: d.id, file_name: d.file_name, kind: d.kind, size: d.size, category: d.category, category_label: d.category && CATEGORIES[d.category] ? CATEGORIES[d.category].label : null, status: d.status, detected: d.detected, imported: d.imported, rejected: d.rejected, error: d.error, uploaded_by: d.uploaded_by, uploaded_at: d.uploaded_at, imported_by: d.imported_by, imported_at: d.imported_at, result: d.result ? JSON.parse(d.result) : null };
}
async function original(id) {
  const d = await loadDoc(id);
  const b = await get('SELECT data FROM import_document_data WHERE document_id = ?', [id]);
  if (!b) throw bad(404, 'The original file is not stored.');
  return { file_name: d.file_name, mime: d.mime, data: Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data) };
}
async function markFailed(id, message) { await run("UPDATE import_documents SET status = CASE WHEN status = 'imported' THEN status ELSE 'failed' END, error = ? WHERE id = ?", [String(message).slice(0, 1000), id]).catch(() => {}); }

module.exports = { upload, addOcrPage, preview, commit, history, detail, original, markFailed, classify, buildRecords, evaluate, CATEGORIES, findTable, fieldOf };

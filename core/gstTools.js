/**
 * RRE Tally — GST validation and reconciliation tools (offline, read-only on accounting data).
 *
 * IMPORTANT LIMITS (stated in every result):
 *  - A GSTIN that passes format + state + checksum is *structurally* valid. Only the GST portal can
 *    confirm that it is registered and active. No portal call is made here.
 *  - HSN checks are structural (length/chapter). They do not verify the code against the live HSN master.
 *  - GSTR-2B reconciliation works on a file the user downloads from the GST portal; nothing is filed or fetched.
 */
const { all, get } = require('./db');
const { parseCsv, parseAmount, parseDate } = require('./csv');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TOLERANCE = 1.0; // ₹1 rounding tolerance

// Valid GST state/UT codes (01–38 plus 97 Other Territory, 99 Centre Jurisdiction)
const STATE_NAMES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction'
};

function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let v = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    v = Math.floor(v / 36) + (v % 36);
    sum += v;
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

function validateGstin(input) {
  const raw = String(input == null ? '' : input).trim();
  const g = raw.toUpperCase();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('15 characters', g.length === 15, `length ${g.length}`);
  const formatOk = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
  add('Format (SS + PAN + entity + Z + check)', formatOk, formatOk ? 'ok' : 'does not match the GSTIN pattern');
  const state = g.slice(0, 2);
  const stateOk = !!STATE_NAMES[state];
  add('State code', stateOk, stateOk ? `${state} = ${STATE_NAMES[state]}` : `"${state}" is not a valid GST state code`);
  const pan = g.slice(2, 12);
  const panOk = /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) && 'ABCFGHLJPTK'.includes(pan[3]);
  add('Embedded PAN structure', panOk, panOk ? pan : 'characters 3–12 are not a valid PAN structure');
  let checksumOk = false;
  if (formatOk) {
    const expected = gstinCheckChar(g.slice(0, 14));
    checksumOk = expected === g[14];
    add('Check digit', checksumOk, checksumOk ? 'ok' : `expected "${expected}", found "${g[14]}"`);
  } else add('Check digit', false, 'not evaluated (format invalid)');

  return {
    gstin: g,
    valid: checks.every((c) => c.ok),
    state: stateOk ? STATE_NAMES[state] : null,
    pan: panOk ? pan : null,
    checks,
    note: 'Structural validation only. Registration status must be confirmed on the GST portal.'
  };
}

function validateHsn(input) {
  const code = String(input == null ? '' : input).trim().replace(/\s+/g, '');
  const issues = [];
  let kind = null;
  if (!code) return { code, valid: false, kind: null, issues: ['Empty code'], note: HSN_NOTE };
  if (!/^\d+$/.test(code)) issues.push('Must contain digits only');
  else if (code.startsWith('99')) {
    kind = 'SAC';
    if (code.length !== 6) issues.push('SAC (services) codes have 6 digits');
  } else {
    kind = 'HSN';
    if (![2, 4, 6, 8].includes(code.length)) issues.push('HSN codes have 2, 4, 6 or 8 digits');
    const ch = parseInt(code.slice(0, 2), 10);
    if (ch < 1 || ch > 97 || ch === 77) issues.push(`Chapter ${code.slice(0, 2)} is not a valid HSN chapter`);
    else if (code.length < 6 && [2, 4].includes(code.length)) issues.push('Warning: 6 or 8 digits are mandatory on invoices for most taxpayers (4 digits only below ₹5 crore turnover)');
  }
  return { code, valid: issues.filter((i) => !i.startsWith('Warning')).length === 0, kind, issues, note: HSN_NOTE };
}
const HSN_NOTE = 'Structural check only (length and chapter). It does not confirm the code or its tax rate against the official HSN master.';

/** Audit every ledger GSTIN and stock-item HSN in the company data. */
async function auditMasters() {
  const ledgers = await all(`
    SELECT l.id, l.name, l.gstin, l.state_code, g.name AS group_name
    FROM ledgers l JOIN account_groups g ON l.group_id = g.id
    WHERE l.gstin IS NOT NULL AND TRIM(l.gstin) <> '' ORDER BY l.name`);
  const ledgerIssues = [];
  for (const l of ledgers) {
    const r = validateGstin(l.gstin);
    const problems = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    if (r.valid && l.state_code && r.gstin.slice(0, 2) !== String(l.state_code).padStart(2, '0')) {
      problems.push(`State code in GSTIN (${r.gstin.slice(0, 2)}) differs from the ledger's state code (${l.state_code})`);
    }
    if (problems.length) ledgerIssues.push({ ledger_id: l.id, name: l.name, group: l.group_name, gstin: l.gstin, problems });
  }
  const noGstin = await all(`
    SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON l.group_id = g.id
    WHERE g.name IN ('Sundry Debtors','Sundry Creditors') AND (l.gstin IS NULL OR TRIM(l.gstin) = '')`);

  const items = await all('SELECT id, name, hsn_code, gst_rate FROM stock_items WHERE is_active = 1 ORDER BY name');
  const itemIssues = [];
  const VALID_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];
  for (const it of items) {
    const problems = [];
    if (!it.hsn_code) problems.push('Missing HSN/SAC code');
    else { const h = validateHsn(it.hsn_code); problems.push(...h.issues); }
    if (!VALID_RATES.includes(Number(it.gst_rate))) problems.push(`GST rate ${it.gst_rate}% is not a standard slab (${VALID_RATES.join(', ')})`);
    if (problems.length) itemIssues.push({ item_id: it.id, name: it.name, hsn_code: it.hsn_code, gst_rate: it.gst_rate, problems });
  }
  return {
    ledgers_checked: ledgers.length, ledger_issues: ledgerIssues,
    parties_without_gstin: noGstin.map((r) => ({ ledger_id: r.id, name: r.name })),
    items_checked: items.length, item_issues: itemIssues,
    note: 'Structural validation only. It cannot confirm that a GSTIN is registered or active.'
  };
}

// ---------------------------------------------------------------------------
// Tax calculation validation on posted vouchers
// ---------------------------------------------------------------------------
function taxKind(name) {
  const n = name.toUpperCase();
  if (n.includes('CGST')) return 'cgst';
  if (n.includes('SGST') || n.includes('UTGST')) return 'sgst';
  if (n.includes('IGST')) return 'igst';
  if (n.includes('CESS')) return 'cess';
  return null;
}

async function validateTaxes({ from_date, to_date } = {}) {
  const company = (await get('SELECT state_code FROM company_info LIMIT 1')) || {};
  const companyState = String(company.state_code || '').padStart(2, '0');
  const params = [];
  let where = "v.voucher_type IN ('Sales','Purchase','Credit Note','Debit Note')";
  if (from_date) { where += ' AND v.date >= ?'; params.push(from_date); }
  if (to_date) { where += ' AND v.date <= ?'; params.push(to_date); }
  const vouchers = await all(`
    SELECT v.id, v.voucher_no, v.voucher_type, v.date, v.total_amount, v.party_ledger_id, p.name AS party, p.state_code AS party_state, p.gstin AS party_gstin
    FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id WHERE ${where} ORDER BY v.date, v.id`, params);

  // Load every voucher's lines in two queries (not two per voucher) and group them in memory.
  const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.voucher_id)) m.set(r.voucher_id, []); m.get(r.voucher_id).push(r); } return m; };
  const entriesBy = group(await all(`
    SELECT e.voucher_id, e.ledger_id, e.debit_amount, e.credit_amount, l.name AS ledger_name, g.name AS group_name
    FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id JOIN account_groups g ON l.group_id = g.id
    WHERE e.voucher_id IN (SELECT v.id FROM vouchers v WHERE ${where})`, params));
  const invBy = group(await all(`
    SELECT i.voucher_id, i.amount, i.discount_pct, i.direction, s.name, s.gst_rate FROM inventory_entries i JOIN stock_items s ON s.id = i.stock_item_id
    WHERE i.voucher_id IN (SELECT v.id FROM vouchers v WHERE ${where})`, params));

  const findings = [];
  let checked = 0;
  for (const v of vouchers) {
    const entries = entriesBy.get(v.id) || [];
    const inv = invBy.get(v.id) || [];

    const tax = { cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const e of entries) {
      if (e.group_name !== 'Duties & Taxes') continue;
      const k = taxKind(e.ledger_name);
      if (k) tax[k] += e.debit_amount + e.credit_amount;
    }
    const totalTax = tax.cgst + tax.sgst + tax.igst + tax.cess;
    const flag = (severity, code, message) => findings.push({ voucher_id: v.id, voucher_no: v.voucher_no, type: v.voucher_type, date: v.date, party: v.party, severity, code, message });

    // Credit/Debit Notes recorded before the posting fix were booked like a Sales/Purchase invoice (inverted).
    if (v.voucher_type === 'Credit Note' || v.voucher_type === 'Debit Note') {
      const partyLine = entries.find((e) => e.ledger_id === v.party_ledger_id);
      const wrongSide = partyLine && (v.voucher_type === 'Credit Note' ? partyLine.debit_amount > 0 : partyLine.credit_amount > 0);
      if (wrongSide) {
        flag('error', v.voucher_type === 'Credit Note' ? 'CREDIT_NOTE_LEGACY_POSTING' : 'DEBIT_NOTE_LEGACY_POSTING',
          `${v.voucher_type} was posted like a ${v.voucher_type === 'Credit Note' ? 'sales invoice' : 'purchase'} (party ${v.voucher_type === 'Credit Note' ? 'debited' : 'credited'}), which inflates ` +
          `${v.voucher_type === 'Credit Note' ? 'sales and receivables' : 'purchases and payables'} instead of reversing them. Reverse this voucher and re-enter the note.`);
      }
      const wrongStock = inv.find((i) => i.direction === (v.voucher_type === 'Credit Note' ? 'OUT' : 'IN'));
      if (wrongStock) {
        flag('error', 'RETURN_STOCK_DIRECTION',
          `Stock for this ${v.voucher_type} was recorded ${wrongStock.direction === 'OUT' ? 'outward' : 'inward'}; a ${v.voucher_type === 'Credit Note' ? 'sales return should bring stock in' : 'purchase return should send stock out'}.`);
      }
    }

    if (!inv.length && totalTax === 0) continue; // no tax data to validate (e.g. exempt/no-item vouchers)
    checked++;

    if (Math.abs(tax.cgst - tax.sgst) > 0.011) flag('error', 'CGST_SGST_ASYMMETRY', `CGST ₹${round2(tax.cgst)} and SGST ₹${round2(tax.sgst)} must be equal.`);

    const partyState = v.party_state ? String(v.party_state).padStart(2, '0') : (v.party_gstin ? v.party_gstin.slice(0, 2) : null);
    if (companyState && partyState && v.party) {
      const intra = partyState === companyState;
      if (intra && tax.igst > 0) flag('error', 'IGST_ON_INTRASTATE', `IGST charged but party state (${partyState}) equals company state (${companyState}); CGST+SGST applies.`);
      if (!intra && (tax.cgst > 0 || tax.sgst > 0)) flag('error', 'CGST_SGST_ON_INTERSTATE', `CGST/SGST charged but party state (${partyState}) differs from company state (${companyState}); IGST applies.`);
    }

    if (inv.length) {
      const taxable = inv.reduce((s, i) => s + i.amount, 0);
      const expected = inv.reduce((s, i) => s + (i.amount * (Number(i.gst_rate) || 0)) / 100, 0);
      if (Math.abs(expected - totalTax) > TOLERANCE) {
        flag('warning', 'TAX_AMOUNT_MISMATCH',
          `Tax booked ₹${round2(totalTax)} but item GST rates imply ₹${round2(expected)} on taxable value ₹${round2(taxable)} (difference ₹${round2(totalTax - expected)}).`);
      }
      if (Math.abs(taxable + totalTax - v.total_amount) > TOLERANCE) {
        flag('warning', 'TOTAL_MISMATCH', `Items ₹${round2(taxable)} + tax ₹${round2(totalTax)} = ₹${round2(taxable + totalTax)} but voucher total is ₹${round2(v.total_amount)}.`);
      }
    } else if (totalTax > 0) {
      flag('info', 'TAX_WITHOUT_ITEMS', 'Tax is booked without stock items, so the rate could not be verified against item GST rates.');
    }
  }
  return {
    vouchers_scanned: vouchers.length, vouchers_with_tax_checked: checked,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    // errors first, then warnings; capped so a very large company does not return megabytes
    findings: findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : a.severity === 'warning' ? (b.severity === 'error' ? 1 : -1) : 1)).slice(0, 1000),
    findings_total: findings.length, truncated: findings.length > 1000,
    assumptions: [
      'Expected tax = Σ(item amount × the stock item\'s GST rate). Item-level discounts and cess are not modelled.',
      `Differences up to ₹${TOLERANCE} are treated as rounding.`,
      'Place of supply is approximated by the party\'s state (ledger state code, else GSTIN prefix). Special cases (SEZ, imports, bill-to/ship-to) are not modelled.'
    ]
  };
}

// ---------------------------------------------------------------------------
// GSTR-2B reconciliation (books purchases vs. a file downloaded from the GST portal)
// ---------------------------------------------------------------------------
const normInv = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

/** Parses a GSTR-2B JSON (portal download) or a simple CSV into normalised invoice rows. */
function parseGstr2b(content, format) {
  const rows = [];
  const skipped = { cdnr: 0, other: 0 };
  if (format === 'json') {
    let j;
    try { j = typeof content === 'string' ? JSON.parse(content) : content; } catch (e) { throw new Error('File is not valid JSON.'); }
    const doc = (j && j.data && j.data.docdata) || (j && j.docdata) || j;
    const b2b = doc && doc.b2b;
    if (!Array.isArray(b2b)) throw new Error('No "b2b" section found. Expected a GSTR-2B JSON downloaded from the GST portal.');
    for (const sup of b2b) {
      for (const inv of sup.inv || []) {
        const items = Array.isArray(inv.items) ? inv.items : [];
        const sum = (k) => (inv[k] !== undefined ? Number(inv[k]) : items.reduce((s, it) => s + (Number(it[k]) || 0), 0));
        rows.push({
          gstin: String(sup.ctin || '').toUpperCase(), supplier: sup.trdnm || '', invoice_no: String(inv.inum || ''),
          date: parseDate(inv.dt), taxable: sum('txval'), igst: sum('igst'), cgst: sum('cgst'), sgst: sum('sgst'), cess: sum('cess'),
          itc_available: inv.itcavl === undefined ? null : inv.itcavl
        });
      }
    }
    if (doc.cdnr) skipped.cdnr = Array.isArray(doc.cdnr) ? doc.cdnr.length : 0;
  } else if (format === 'csv') {
    const { rows: recs, headers } = parseCsv(content);
    const need = ['gstin', 'invoice_no'];
    for (const n of need) if (!headers.includes(n)) throw new Error(`CSV must have a "${n}" column. Columns: gstin, invoice_no, date, taxable, igst, cgst, sgst, cess.`);
    recs.forEach((r, i) => {
      const nums = ['taxable', 'igst', 'cgst', 'sgst', 'cess'].map((k) => parseAmount(r[k]));
      if (nums.some(Number.isNaN)) throw new Error(`Row ${i + 2}: an amount column is not a number.`);
      rows.push({
        gstin: (r.gstin || '').toUpperCase(), supplier: r.supplier || r.trade_name || '', invoice_no: r.invoice_no,
        date: parseDate(r.date), taxable: nums[0], igst: nums[1], cgst: nums[2], sgst: nums[3], cess: nums[4], itc_available: null
      });
    });
  } else throw new Error('format must be "json" or "csv".');
  if (!rows.length) throw new Error('No invoices found in the file.');
  return { rows, skipped };
}

async function loadBooksPurchases(period) {
  const params = [];
  let where = "v.voucher_type = 'Purchase'";
  if (period && /^\d{4}-\d{2}$/.test(period)) { where += " AND substr(v.date,1,7) = ?"; params.push(period); }
  const vs = await all(`
    SELECT v.id, v.voucher_no, v.date, v.reference_no, v.total_amount, p.name AS supplier, p.gstin
    FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id WHERE ${where} ORDER BY v.date`, params);
  const out = [];
  for (const v of vs) {
    const taxes = await all(`
      SELECT l.name, e.debit_amount, e.credit_amount FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id WHERE e.voucher_id = ? AND g.name = 'Duties & Taxes'`, [v.id]);
    const t = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const x of taxes) { const k = taxKind(x.name); if (k) t[k] += x.debit_amount - x.credit_amount; }
    const totalTax = t.igst + t.cgst + t.sgst + t.cess;
    out.push({
      voucher_id: v.id, voucher_no: v.voucher_no, date: v.date, invoice_no: v.reference_no || '', supplier: v.supplier || '',
      gstin: (v.gstin || '').toUpperCase(), taxable: round2(v.total_amount - totalTax), ...Object.fromEntries(Object.entries(t).map(([k, x]) => [k, round2(x)]))
    });
  }
  return out;
}

const taxTotal = (r) => round2((r.igst || 0) + (r.cgst || 0) + (r.sgst || 0) + (r.cess || 0));

async function reconcileGstr2b(content, format, { period } = {}) {
  const parsed = parseGstr2b(content, format);
  const portal = parsed.rows;
  const books = await loadBooksPurchases(period);
  const usedBooks = new Set();
  const matched = [], mismatched = [], probable = [], missingInBooks = [];

  const keyOf = (r) => `${r.gstin}|${normInv(r.invoice_no)}`;
  const booksByKey = new Map();
  books.forEach((b, i) => { if (b.invoice_no) booksByKey.set(keyOf(b), i); });

  const leftover = [];
  for (const p of portal) {
    const idx = booksByKey.get(keyOf(p));
    if (idx !== undefined && !usedBooks.has(idx)) {
      usedBooks.add(idx);
      const b = books[idx];
      const diff = {
        taxable: round2(b.taxable - p.taxable), igst: round2(b.igst - p.igst), cgst: round2(b.cgst - p.cgst),
        sgst: round2(b.sgst - p.sgst), cess: round2(b.cess - p.cess)
      };
      const bad = Object.entries(diff).filter(([, d]) => Math.abs(d) > TOLERANCE).map(([k]) => k);
      (bad.length ? mismatched : matched).push({ portal: p, books: b, difference: diff, differing_fields: bad });
    } else leftover.push(p);
  }
  // second pass: same GSTIN, taxable & tax equal within tolerance, invoice number differs
  for (const p of leftover) {
    const idx = books.findIndex((b, i) => !usedBooks.has(i) && b.gstin === p.gstin &&
      Math.abs(b.taxable - p.taxable) <= TOLERANCE && Math.abs(taxTotal(b) - taxTotal(p)) <= TOLERANCE);
    if (idx >= 0) { usedBooks.add(idx); probable.push({ portal: p, books: books[idx], reason: 'Same supplier GSTIN and amounts, but the invoice number differs.' }); }
    else missingInBooks.push(p);
  }
  const missingIn2b = books.filter((_, i) => !usedBooks.has(i));
  const sumTax = (arr) => round2(arr.reduce((s, r) => s + taxTotal(r.books || r.portal || r), 0));

  const result = {
    period: period || null,
    summary: {
      portal_invoices: portal.length, books_purchase_vouchers: books.length,
      matched: matched.length, mismatched: mismatched.length, probable: probable.length,
      in_2b_not_in_books: missingInBooks.length, in_books_not_in_2b: missingIn2b.length,
      tax_matched: sumTax(matched), tax_in_2b_not_in_books: sumTax(missingInBooks), tax_in_books_not_in_2b_itc_at_risk: sumTax(missingIn2b)
    },
    matched, mismatched, probable, in_2b_not_in_books: missingInBooks, in_books_not_in_2b: missingIn2b,
    not_covered: { credit_debit_notes_in_file: parsed.skipped.cdnr, note: 'Only the B2B invoice section is reconciled. Credit/debit notes, imports (IMPG), ISD and RCM entries are not covered.' },
    assumptions: [
      'Books side = Purchase vouchers; supplier invoice number is read from the voucher\'s Reference No.',
      'Invoices are matched on supplier GSTIN + normalised invoice number (case, spaces, punctuation and leading zeros ignored).',
      `Amount differences up to ₹${TOLERANCE} are treated as rounding.`,
      'ITC eligibility is not decided here. "In books but not in 2B" means the supplier may not have filed; verify before claiming ITC.'
    ]
  };
  return result;
}

module.exports = { validateGstin, validateHsn, auditMasters, validateTaxes, parseGstr2b, reconcileGstr2b, gstinCheckChar, STATE_NAMES };

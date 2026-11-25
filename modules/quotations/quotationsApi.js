// ========================================================
// Quotations / Estimates & Follow-up API (Zoho Books-style)
// ========================================================
const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');
const { postVoucher, VoucherValidationError, VoucherConflictError, round2 } = require('../../core/voucherService');
const { withTransaction } = require('../../core/tx');

const STATUSES = ['Draft', 'Sent', 'Accepted', 'Declined', 'Expired', 'Revised', 'Invoiced'];
const OPEN_STATUSES = ['Draft', 'Sent', 'Accepted'];
const FOLLOWUP_MODES = ['Call', 'Email', 'WhatsApp', 'Visit', 'Meeting'];
const DEFAULT_TERMS = '1. Prices are valid until the expiry date mentioned above.\n2. GST extra as applicable.\n3. Payment: 100% against invoice within the agreed credit period.\n4. Delivery: Ex-works, subject to stock availability at the time of order.';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const today = () => new Date().toISOString().split('T')[0];
function addDays(dateStr, days) {
  const d = new Date((dateStr || today()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function sendError(res, err) {
  const status = err.status || (err instanceof VoucherValidationError ? 400 : err instanceof VoucherConflictError ? 409 : 500);
  res.status(status).json({ success: false, error: err.message });
}

async function getCompany() {
  return (await get('SELECT * FROM company_info WHERE id = 1')) || (await get('SELECT * FROM company_info LIMIT 1')) || {};
}

/**
 * Server-authoritative totals. Line discount first, then the quote-level
 * discount is prorated across lines before GST is applied per line rate.
 */
function computeTotals(items, { discount_pct = 0, shipping_charges = 0, interState = false } = {}) {
  const overallDisc = Math.min(100, Math.max(0, parseFloat(discount_pct) || 0));
  let subtotal = 0;
  let taxable = 0;
  let tax = 0;

  const lines = items.map((it, idx) => {
    const qty = parseFloat(it.quantity) || 0;
    const rate = parseFloat(it.rate) || 0;
    const lineDisc = Math.min(100, Math.max(0, parseFloat(it.discount_pct) || 0));
    const gstRate = it.gst_rate === undefined || it.gst_rate === null || it.gst_rate === '' ? 18 : parseFloat(it.gst_rate) || 0;
    const amount = round2(qty * rate * (1 - lineDisc / 100));
    const lineTaxable = amount * (1 - overallDisc / 100);
    subtotal += amount;
    taxable += lineTaxable;
    tax += lineTaxable * gstRate / 100;
    return {
      stock_item_id: it.stock_item_id ? parseInt(it.stock_item_id, 10) : null,
      item_name: (it.item_name || '').trim(),
      description: it.description || '',
      hsn_code: it.hsn_code || '',
      uom: it.uom || '',
      quantity: qty,
      rate,
      discount_pct: lineDisc,
      gst_rate: gstRate,
      amount,
      sort_order: idx
    };
  });

  subtotal = round2(subtotal);
  taxable = round2(taxable);
  const discount_amount = round2(subtotal - taxable);
  let cgst = 0, sgst = 0, igst = 0;
  if (interState) {
    igst = round2(tax);
  } else {
    cgst = round2(tax / 2);
    sgst = round2(tax / 2);
  }
  const shipping = round2(shipping_charges);
  const raw = taxable + cgst + sgst + igst + shipping;
  const total = Math.round(raw);
  const round_off = round2(total - raw);

  return { lines, subtotal, discount_amount, taxable_amount: taxable, cgst, sgst, igst, shipping_charges: shipping, round_off, total, discount_pct: overallDisc };
}

async function nextQuoteNo() {
  const rows = await all("SELECT quote_no FROM quotations WHERE quote_no LIKE 'QT-%'");
  let max = 0;
  for (const r of rows) {
    const m = /^QT-(\d+)/.exec(r.quote_no);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `QT-${String(max + 1).padStart(5, '0')}`;
}

async function expireStaleQuotes() {
  await run(
    `UPDATE quotations SET status = 'Expired', updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('Draft', 'Sent') AND expiry_date IS NOT NULL AND expiry_date <> '' AND expiry_date < ?`,
    [today()]
  );
}

async function loadQuotation(id) {
  const q = await get(
    `SELECT q.*, l.name AS party_name, l.gstin AS party_gstin, l.address AS party_address, l.state AS party_state,
            l.state_code AS party_state_code, v.voucher_no AS converted_voucher_no
     FROM quotations q
     LEFT JOIN ledgers l ON q.party_ledger_id = l.id
     LEFT JOIN vouchers v ON q.converted_voucher_id = v.id
     WHERE q.id = ?`,
    [id]
  );
  if (!q) return null;
  q.items = await all('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id', [id]);
  q.followups = await all('SELECT * FROM quotation_followups WHERE quotation_id = ? ORDER BY followup_date DESC, id DESC', [id]);
  q.display_customer = q.customer_name || q.party_name || '';
  return q;
}

/** Normalises request body into a row + computed totals. */
async function buildQuotePayload(body) {
  const company = await getCompany();
  const items = Array.isArray(body.items) ? body.items.filter((i) => (i.item_name || i.stock_item_id) && parseFloat(i.quantity) > 0) : [];
  if (items.length === 0) throw new HttpError(400, 'Add at least one line item with a quantity.');

  // Fill item names / HSN / UoM from stock master when only an id was sent
  for (const it of items) {
    if (it.stock_item_id && (!it.item_name || !it.hsn_code || !it.uom)) {
      const s = await get(
        'SELECT s.name, s.hsn_code, s.gst_rate, u.symbol FROM stock_items s LEFT JOIN units_of_measure u ON s.uom_id = u.id WHERE s.id = ?',
        [it.stock_item_id]
      );
      if (s) {
        it.item_name = it.item_name || s.name;
        it.hsn_code = it.hsn_code || s.hsn_code;
        it.uom = it.uom || s.symbol;
        if (it.gst_rate === undefined || it.gst_rate === '') it.gst_rate = s.gst_rate;
      }
    }
  }

  let party = null;
  if (body.party_ledger_id) {
    party = await get('SELECT * FROM ledgers WHERE id = ?', [body.party_ledger_id]);
    if (!party) throw new HttpError(400, 'Selected customer ledger was not found.');
  }
  const customerName = (body.customer_name || (party && party.name) || '').trim();
  if (!customerName) throw new HttpError(400, 'Select a customer ledger or enter a customer name.');

  const posCode = body.place_of_supply_code || (party && party.state_code) || company.state_code || '33';
  const posName = body.place_of_supply || (party && party.state) || company.state || '';
  const interState = String(posCode) !== String(company.state_code || '33');

  const totals = computeTotals(items, { discount_pct: body.discount_pct, shipping_charges: body.shipping_charges, interState });
  const date = body.date || today();

  return {
    row: {
      date,
      expiry_date: body.expiry_date || addDays(date, 15),
      party_ledger_id: party ? party.id : null,
      customer_name: customerName,
      customer_email: body.customer_email || '',
      customer_phone: body.customer_phone || '',
      customer_gstin: body.customer_gstin || (party && party.gstin) || '',
      billing_address: body.billing_address || (party && party.address) || '',
      place_of_supply: posName,
      place_of_supply_code: String(posCode),
      reference_no: body.reference_no || '',
      salesperson: body.salesperson || '',
      subject: body.subject || '',
      customer_notes: body.customer_notes ?? 'Looking forward to your business.',
      terms: body.terms ?? DEFAULT_TERMS,
      next_followup_date: body.next_followup_date === undefined ? addDays(date, 3) : (body.next_followup_date || null),
      discount_pct: totals.discount_pct,
      shipping_charges: totals.shipping_charges,
      subtotal: totals.subtotal,
      discount_amount: totals.discount_amount,
      taxable_amount: totals.taxable_amount,
      cgst: totals.cgst,
      sgst: totals.sgst,
      igst: totals.igst,
      round_off: totals.round_off,
      total: totals.total
    },
    lines: totals.lines
  };
}

async function insertLines(quotationId, lines) {
  for (const l of lines) {
    await run(
      `INSERT INTO quotation_items (quotation_id, stock_item_id, item_name, description, hsn_code, uom, quantity, rate, discount_pct, gst_rate, amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quotationId, l.stock_item_id, l.item_name, l.description, l.hsn_code, l.uom, l.quantity, l.rate, l.discount_pct, l.gst_rate, l.amount, l.sort_order]
    );
  }
}

async function insertQuotation(row, lines, extra = {}) {
  const full = { ...row, ...extra };
  const cols = Object.keys(full);
  return withTransaction(async () => { // the company's transaction queue: never overlaps another posting
    const r = await run(
      `INSERT INTO quotations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => full[c])
    );
    await insertLines(r.lastID, lines);
    return r.lastID;
  });
}

// --------------------------------------------------------
// LIST + PIPELINE STATS
// --------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    await expireStaleQuotes();
    const { status, search, from_date, to_date, followup } = req.query;
    let sql = `
      SELECT q.id, q.quote_no, q.revision, q.date, q.expiry_date, q.status, q.total, q.subject, q.salesperson,
             q.next_followup_date, q.converted_voucher_id, v.voucher_no AS converted_voucher_no,
             COALESCE(NULLIF(q.customer_name, ''), l.name) AS customer_name,
             (SELECT COUNT(*) FROM quotation_followups f WHERE f.quotation_id = q.id) AS followup_count,
             (SELECT MAX(f.followup_date) FROM quotation_followups f WHERE f.quotation_id = q.id) AS last_followup_date
      FROM quotations q
      LEFT JOIN ledgers l ON q.party_ledger_id = l.id
      LEFT JOIN vouchers v ON q.converted_voucher_id = v.id
      WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND q.status = ?'; params.push(status); }
    if (from_date) { sql += ' AND q.date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND q.date <= ?'; params.push(to_date); }
    if (search) {
      sql += ' AND (q.quote_no LIKE ? OR q.customer_name LIKE ? OR l.name LIKE ? OR q.subject LIKE ? OR q.reference_no LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (followup) {
      const t = today();
      sql += ` AND q.status IN ('Draft', 'Sent', 'Accepted') AND q.next_followup_date IS NOT NULL AND q.next_followup_date <> ''`;
      if (followup === 'overdue') { sql += ' AND q.next_followup_date < ?'; params.push(t); }
      else if (followup === 'today') { sql += ' AND q.next_followup_date = ?'; params.push(t); }
      else if (followup === 'due') { sql += ' AND q.next_followup_date <= ?'; params.push(t); }
      else if (followup === 'upcoming') { sql += ' AND q.next_followup_date > ? AND q.next_followup_date <= ?'; params.push(t, addDays(t, 7)); }
    }
    sql += followup ? ' ORDER BY q.next_followup_date ASC, q.id DESC' : ' ORDER BY q.date DESC, q.id DESC';
    res.json({ success: true, data: await all(sql, params) });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/stats', async (req, res) => {
  try {
    await expireStaleQuotes();
    const t = today();
    const byStatus = await all('SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS value FROM quotations GROUP BY status');
    const map = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, value: 0 }]));
    byStatus.forEach((r) => { map[r.status] = { count: r.count, value: r.value }; });

    const fu = await get(
      `SELECT
         SUM(CASE WHEN next_followup_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN next_followup_date = ? THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN next_followup_date > ? AND next_followup_date <= ? THEN 1 ELSE 0 END) AS upcoming
       FROM quotations
       WHERE status IN ('Draft', 'Sent', 'Accepted') AND next_followup_date IS NOT NULL AND next_followup_date <> ''`,
      [t, t, t, addDays(t, 7)]
    );

    const decided = map.Accepted.count + map.Invoiced.count + map.Declined.count + map.Expired.count;
    const won = map.Accepted.count + map.Invoiced.count;
    const openValue = OPEN_STATUSES.reduce((s, k) => s + map[k].value, 0);
    const openCount = OPEN_STATUSES.reduce((s, k) => s + map[k].count, 0);

    res.json({
      success: true,
      data: {
        by_status: map,
        open_count: openCount,
        open_value: round2(openValue),
        won_value: round2(map.Accepted.value + map.Invoiced.value),
        conversion_rate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : 0,
        followups: { overdue: fu?.overdue || 0, today: fu?.today || 0, upcoming: fu?.upcoming || 0 }
      }
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/next-number', async (req, res) => {
  try {
    res.json({ success: true, quote_no: await nextQuoteNo(), default_terms: DEFAULT_TERMS });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const q = await loadQuotation(req.params.id);
    if (!q) return res.status(404).json({ success: false, error: 'Quotation not found' });
    res.json({ success: true, data: q });
  } catch (err) {
    sendError(res, err);
  }
});

// --------------------------------------------------------
// CREATE / UPDATE / DELETE
// --------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { row, lines } = await buildQuotePayload(req.body || {});
    let quoteNo = (req.body.quote_no || '').trim() || (await nextQuoteNo());
    if (await get('SELECT id FROM quotations WHERE quote_no = ?', [quoteNo])) quoteNo = await nextQuoteNo();
    const status = STATUSES.includes(req.body.status) && req.body.status !== 'Invoiced' ? req.body.status : 'Draft';
    const id = await insertQuotation(row, lines, { quote_no: quoteNo, status, created_by: req.body.created_by || '' });
    res.json({ success: true, id, quote_no: quoteNo, data: await loadQuotation(id), message: `Quotation ${quoteNo} created` });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await get('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
    if (!existing) throw new HttpError(404, 'Quotation not found');
    if (existing.status === 'Invoiced') throw new HttpError(409, 'This quotation is already invoiced and cannot be edited. Duplicate it instead.');

    const { row, lines } = await buildQuotePayload(req.body || {});
    if (STATUSES.includes(req.body.status) && req.body.status !== 'Invoiced') row.status = req.body.status;
    // Re-opening an expired quote by moving the expiry date forward
    if (existing.status === 'Expired' && !req.body.status && row.expiry_date >= today()) row.status = 'Draft';

    const cols = Object.keys(row);
    await withTransaction(async () => {
      await run(
        `UPDATE quotations SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...cols.map((c) => row[c]), existing.id]
      );
      await run('DELETE FROM quotation_items WHERE quotation_id = ?', [existing.id]);
      await insertLines(existing.id, lines);
    });
    res.json({ success: true, id: existing.id, data: await loadQuotation(existing.id), message: `Quotation ${existing.quote_no} updated` });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const q = await get('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
    if (!q) throw new HttpError(404, 'Quotation not found');
    if (q.status === 'Invoiced') throw new HttpError(409, 'Invoiced quotations cannot be deleted. Delete the sales voucher first.');
    await run('DELETE FROM quotation_followups WHERE quotation_id = ?', [q.id]);
    await run('DELETE FROM quotation_items WHERE quotation_id = ?', [q.id]);
    await run('DELETE FROM quotations WHERE id = ?', [q.id]);
    res.json({ success: true, message: `Quotation ${q.quote_no} deleted` });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/status', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status) || status === 'Invoiced') throw new HttpError(400, `Status must be one of: ${STATUSES.filter((s) => s !== 'Invoiced').join(', ')}`);
    const q = await get('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
    if (!q) throw new HttpError(404, 'Quotation not found');
    if (q.status === 'Invoiced') throw new HttpError(409, 'Quotation is already invoiced.');
    // Closed quotes no longer need chasing
    const clearFollowup = ['Declined', 'Revised', 'Expired'].includes(status);
    await run(
      `UPDATE quotations SET status = ?, ${clearFollowup ? 'next_followup_date = NULL,' : ''} updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, q.id]
    );
    res.json({ success: true, data: await loadQuotation(q.id), message: `Quotation ${q.quote_no} marked ${status}` });
  } catch (err) {
    sendError(res, err);
  }
});

// Duplicate (new number, fresh dates) or Revise (same series, R1/R2..., old one marked Revised)
async function cloneQuotation(req, res, mode) {
  try {
    const src = await loadQuotation(req.params.id);
    if (!src) throw new HttpError(404, 'Quotation not found');
    const date = today();
    const fields = [
      'party_ledger_id', 'customer_name', 'customer_email', 'customer_phone', 'customer_gstin', 'billing_address',
      'place_of_supply', 'place_of_supply_code', 'reference_no', 'salesperson', 'subject', 'discount_pct',
      'shipping_charges', 'subtotal', 'discount_amount', 'taxable_amount', 'cgst', 'sgst', 'igst', 'round_off',
      'total', 'customer_notes', 'terms'
    ];
    const row = Object.fromEntries(fields.map((f) => [f, src[f]]));
    row.date = date;
    row.expiry_date = addDays(date, 15);
    row.next_followup_date = addDays(date, 3);
    row.status = 'Draft';

    let quoteNo;
    if (mode === 'revise') {
      const rootId = src.parent_quote_id || src.id;
      const root = await get('SELECT quote_no FROM quotations WHERE id = ?', [rootId]);
      const base = (root ? root.quote_no : src.quote_no).replace(/-R\d+$/, '');
      const maxRev = await get('SELECT MAX(revision) AS r FROM quotations WHERE id = ? OR parent_quote_id = ?', [rootId, rootId]);
      row.revision = (maxRev?.r || 0) + 1;
      row.parent_quote_id = rootId;
      quoteNo = `${base}-R${row.revision}`;
    } else {
      quoteNo = await nextQuoteNo();
    }

    const id = await insertQuotation(row, src.items.map((i, idx) => ({ ...i, sort_order: idx })), { quote_no: quoteNo });
    if (mode === 'revise' && src.status !== 'Invoiced') {
      await run("UPDATE quotations SET status = 'Revised', next_followup_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [src.id]);
    }
    res.json({ success: true, id, quote_no: quoteNo, data: await loadQuotation(id), message: `${mode === 'revise' ? 'Revision' : 'Copy'} ${quoteNo} created` });
  } catch (err) {
    sendError(res, err);
  }
}
router.post('/:id/duplicate', (req, res) => cloneQuotation(req, res, 'duplicate'));
router.post('/:id/revise', (req, res) => cloneQuotation(req, res, 'revise'));

// --------------------------------------------------------
// FOLLOW-UPS
// --------------------------------------------------------
router.post('/:id/followups', async (req, res) => {
  try {
    const q = await get('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
    if (!q) throw new HttpError(404, 'Quotation not found');
    const b = req.body || {};
    const mode = FOLLOWUP_MODES.includes(b.mode) ? b.mode : 'Call';
    const fDate = b.followup_date || today();
    const next = b.next_followup_date || null;

    await run(
      `INSERT INTO quotation_followups (quotation_id, followup_date, mode, notes, outcome, next_followup_date, done_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [q.id, fDate, mode, b.notes || '', b.outcome || '', next, b.done_by || '']
    );

    // Outcome drives the quote lifecycle
    let status = q.status;
    if (b.outcome === 'Won' && status !== 'Invoiced') status = 'Accepted';
    else if (b.outcome === 'Lost' && status !== 'Invoiced') status = 'Declined';
    else if (status === 'Draft') status = 'Sent';
    const closed = ['Declined', 'Invoiced', 'Revised'].includes(status);

    await run(
      'UPDATE quotations SET status = ?, next_followup_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, closed ? null : next, q.id]
    );
    res.json({ success: true, data: await loadQuotation(q.id), message: 'Follow-up logged' });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id/followups/:fid', async (req, res) => {
  try {
    const r = await run('DELETE FROM quotation_followups WHERE id = ? AND quotation_id = ?', [req.params.fid, req.params.id]);
    if (!r.changes) throw new HttpError(404, 'Follow-up not found');
    res.json({ success: true, data: await loadQuotation(req.params.id) });
  } catch (err) {
    sendError(res, err);
  }
});

// --------------------------------------------------------
// CONVERT TO SALES INVOICE (posts a balanced Sales voucher)
// --------------------------------------------------------
async function findLedger(patterns) {
  for (const p of patterns) {
    const l = await get('SELECT id, name FROM ledgers WHERE name LIKE ? ORDER BY id LIMIT 1', [p]);
    if (l) return l;
  }
  return null;
}

router.post('/:id/convert', async (req, res) => {
  try {
    const q = await loadQuotation(req.params.id);
    if (!q) throw new HttpError(404, 'Quotation not found');
    if (q.status === 'Invoiced' && q.converted_voucher_id) throw new HttpError(409, `Already invoiced as ${q.converted_voucher_no}.`);
    if (['Declined', 'Revised'].includes(q.status)) throw new HttpError(409, `A ${q.status.toLowerCase()} quotation cannot be invoiced.`);

    const company = await getCompany();
    const date = (req.body && req.body.date) || today();

    const result = await withTransaction(async () => {
      // checked again inside the transaction: two people converting the same quotation at once get ONE invoice
      const now = await get('SELECT status, converted_voucher_id FROM quotations WHERE id = ?', [q.id]);
      if (now && now.status === 'Invoiced' && now.converted_voucher_id) throw new HttpError(409, `Already invoiced (voucher #${now.converted_voucher_id}).`);
      // Customer ledger: use linked ledger, or create one under Sundry Debtors
      let partyId = q.party_ledger_id;
      if (!partyId) {
        const existing = await get('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE', [q.customer_name]);
        if (existing) {
          partyId = existing.id;
        } else {
          const debtors = await get("SELECT id FROM account_groups WHERE name = 'Sundry Debtors'");
          const r = await run(
            `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, address, state, state_code)
             VALUES (?, ?, 0, 'Dr', ?, ?, ?, ?)`,
            [q.customer_name, debtors ? debtors.id : 16, q.customer_gstin || '', q.billing_address || '', q.place_of_supply || company.state || '', q.place_of_supply_code || company.state_code || '33']
          );
          partyId = r.lastID;
        }
        await run('UPDATE quotations SET party_ledger_id = ? WHERE id = ?', [partyId, q.id]);
      }
      const party = await get('SELECT * FROM ledgers WHERE id = ?', [partyId]);

      const sales = (await get("SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON l.group_id = g.id WHERE g.name = 'Sales Accounts' ORDER BY l.id LIMIT 1"))
        || (await findLedger(['Sales Account%', '%Sales%']));
      if (!sales) throw new HttpError(400, 'No Sales ledger found. Create a ledger under "Sales Accounts" first.');

      const entries = [{ ledger_id: partyId, debit_amount: q.total, credit_amount: 0, particulars: party.name }];
      entries.push({ ledger_id: sales.id, debit_amount: 0, credit_amount: round2(q.taxable_amount + (q.shipping_charges || 0)), particulars: `${sales.name} (Sales)` });

      const taxLines = [
        ['cgst', ['Output CGST%'], 'Output CGST'],
        ['sgst', ['Output SGST%'], 'Output SGST'],
        ['igst', ['Output IGST%'], 'Output IGST']
      ];
      for (const [key, pats, label] of taxLines) {
        if (q[key] > 0) {
          const led = await findLedger(pats);
          if (!led) throw new HttpError(400, `Ledger "${label}" not found under Duties & Taxes.`);
          entries.push({ ledger_id: led.id, debit_amount: 0, credit_amount: q[key], particulars: led.name });
        }
      }
      if (Math.abs(q.round_off) > 0.001) {
        const ro = await findLedger(['Round Off%', '%Round%']);
        if (!ro) throw new HttpError(400, 'Ledger "Round Off A/c" not found.');
        entries.push(q.round_off > 0
          ? { ledger_id: ro.id, debit_amount: 0, credit_amount: q.round_off, particulars: ro.name }
          : { ledger_id: ro.id, debit_amount: Math.abs(q.round_off), credit_amount: 0, particulars: ro.name });
      }

      const inventory = q.items
        .filter((i) => i.stock_item_id)
        .map((i) => ({ stock_item_id: i.stock_item_id, quantity: i.quantity, rate: i.rate, discount_pct: i.discount_pct, amount: i.amount, godown_id: 1 }));

      const due = addDays(date, party.credit_period || 30);
      const vNo = `RRE/SAL/${q.quote_no}`;
      const held = await require('../../core/approvals').evaluate({ voucher_type: 'Sales', entries, inventory }, req.user);
      if (held.length) throw new HttpError(403, `This invoice needs approval (${held.map((h) => h.reason).join('; ')}). An Owner or Accountant must convert it.`);
      const posted = await postVoucher({
        voucher_type: 'Sales',
        voucher_no: (await get('SELECT id FROM vouchers WHERE voucher_no = ?', [vNo])) ? undefined : vNo,
        date,
        reference_no: q.quote_no,
        narration: `Converted from Quotation ${q.quote_no}${q.subject ? ' — ' + q.subject : ''}`,
        party_ledger_id: partyId,
        entries,
        inventory,
        bill_allocations: [{ ledger_id: partyId, bill_type: 'New Ref', amount: q.total, due_date: due }]
      }, { inTransaction: true });

      await run(
        "UPDATE quotations SET status = 'Invoiced', converted_voucher_id = ?, next_followup_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [posted.id, q.id]
      );
      return posted;
    });
    res.json({ success: true, voucher: result, data: await loadQuotation(q.id), message: `Sales Invoice ${result.voucher_no} created from ${q.quote_no}` });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
module.exports.computeTotals = computeTotals;
module.exports.loadQuotation = loadQuotation;
module.exports.expireStaleQuotes = expireStaleQuotes;
module.exports.STATUSES = STATUSES;

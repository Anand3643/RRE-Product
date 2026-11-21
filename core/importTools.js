/**
 * RRE Tally — bulk voucher import from CSV (Excel: save as CSV).
 *
 * Two steps, so nothing reaches the books unreviewed:
 *   1. preview — parse and validate every voucher, store the batch, write NOTHING to the books
 *   2. commit  — post the previewed vouchers in ONE transaction (all succeed or none do)
 *
 * CSV columns (one row per ledger line; rows sharing voucher_ref form one voucher):
 *   voucher_ref, date, voucher_type, voucher_no (optional), ledger, debit, credit, narration, reference_no, bill_ref (optional)
 */
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { parseCsv, parseAmount, parseDate } = require('./csv');
const { withTransaction } = require('./tx');
const { postVoucher, normaliseVoucher, assertRoleMayPost, KNOWN_TYPES } = require('./voucherPoster');
const { duplicateCheck } = require('./automationTools');
const { logActivity } = require('./auth');
const approvals = require('./approvals');

const MAX_VOUCHERS = 2000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

const TEMPLATE = [
  'voucher_ref,date,voucher_type,voucher_no,ledger,debit,credit,narration,reference_no,bill_ref',
  'R1,2026-06-05,Payment,,Office Rent,45000,,Rent for June,CHQ-1001,',
  'R1,,,,HDFC Bank Current A/c,,45000,,,',
  'R2,2026-06-07,Sales,,Chennai Auto Components Pvt Ltd,11800,,Spares sale,INV-77,',
  'R2,,,,Sales Account - Spares & Lubes,,10000,,,',
  'R2,,,,Output CGST 9%,,900,,,',
  'R2,,,,Output SGST 9%,,900,,,'
].join('\r\n') + '\r\n';

function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Closest existing ledger name by edit distance (typos), accepted only if reasonably near. */
function closest(name, names) {
  const a = nameKey(name);
  if (!a) return null;
  let best = null, bestD = Infinity;
  for (const n of names) {
    const b = nameKey(n);
    const d = (b.includes(a) || a.includes(b)) && Math.min(a.length, b.length) >= 4 ? 0 : editDistance(a, b);
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD <= Math.max(2, Math.floor(a.length * 0.3)) ? best : null;
}

async function preview(content, filename, user) {
  if (typeof content !== 'string' || !content.trim()) throw bad('The file is empty.');
  const { headers, rows } = parseCsv(content);
  for (const need of ['voucher_ref', 'date', 'voucher_type', 'ledger', 'debit', 'credit']) {
    if (!headers.includes(need)) throw bad(`Missing column "${need}". Expected: voucher_ref, date, voucher_type, voucher_no, ledger, debit, credit, narration, reference_no, bill_ref.`);
  }
  const fileHash = crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex');
  const ledgers = await all(`SELECT l.id, l.name, l.credit_period, g.name AS grp FROM ledgers l JOIN account_groups g ON g.id = l.group_id`);
  const byName = new Map(ledgers.map((l) => [nameKey(l.name), l]));
  const allNames = ledgers.map((l) => l.name);

  // group rows by voucher_ref, preserving order
  const groups = new Map();
  rows.forEach((r, i) => {
    const ref = (r.voucher_ref || '').trim();
    if (!ref) { groups.set(`__blank_${i}`, { ref: `(row ${i + 2})`, rows: [{ r, line: i + 2 }], blank: true }); return; }
    if (!groups.has(ref)) groups.set(ref, { ref, rows: [] });
    groups.get(ref).rows.push({ r, line: i + 2 });
  });
  if (groups.size > MAX_VOUCHERS) throw bad(`Too many vouchers (${groups.size}); the limit is ${MAX_VOUCHERS} per file.`);

  const results = [], payload = [];
  const seenNos = new Set();
  const earlier = await get('SELECT id, created_at FROM import_batches WHERE file_hash = ? AND status = ? ORDER BY id DESC LIMIT 1', [fileHash, 'committed']);
  let seq = 0;

  for (const g of groups.values()) {
    const res = { ref: g.ref, lines: g.rows.map((x) => x.line), errors: [], warnings: [], status: 'ok' };
    results.push(res);
    if (g.blank) { res.errors.push('voucher_ref is blank.'); res.status = 'error'; continue; }
    const head = (k) => { const vals = [...new Set(g.rows.map((x) => (x.r[k] || '').trim()).filter(Boolean))]; return vals; };
    const dates = head('date'), types = head('voucher_type'), nos = head('voucher_no'), nars = head('narration'), refs = head('reference_no');
    if (dates.length !== 1) res.errors.push(dates.length ? `Conflicting dates: ${dates.join(', ')}.` : 'date is missing.');
    if (types.length !== 1) res.errors.push(types.length ? `Conflicting voucher types: ${types.join(', ')}.` : 'voucher_type is missing.');
    if (nos.length > 1) res.errors.push(`Conflicting voucher numbers: ${nos.join(', ')}.`);
    const date = dates.length === 1 ? parseDate(dates[0]) : null;
    if (dates.length === 1 && !date) res.errors.push(`Invalid date "${dates[0]}".`);
    const type = types.length === 1 ? KNOWN_TYPES.find((t) => t.toLowerCase() === types[0].toLowerCase()) : null;
    if (types.length === 1 && !type) res.errors.push(`Unknown voucher type "${types[0]}". Use: ${KNOWN_TYPES.join(', ')}.`);
    if (type) { try { assertRoleMayPost(user, type); } catch (e) { res.errors.push(e.message); } }

    const entries = [];
    for (const { r, line } of g.rows) {
      const led = byName.get(nameKey(r.ledger));
      if (!led) {
        const sug = closest(r.ledger, allNames);
        res.errors.push(`Row ${line}: ledger "${r.ledger}" not found${sug ? ` (did you mean "${sug}"?)` : ''}.`);
        continue;
      }
      const d = parseAmount(r.debit), c = parseAmount(r.credit);
      if (Number.isNaN(d) || Number.isNaN(c)) { res.errors.push(`Row ${line}: debit/credit is not a number.`); continue; }
      entries.push({ ledger_id: led.id, ledger: led.name, grp: led.grp, credit_period: led.credit_period, debit_amount: d, credit_amount: c, line });
    }
    let total = 0;
    if (!res.errors.length) {
      try { total = normaliseVoucher({ voucher_type: type, date, entries }, { tolerance: 0.01 }).total; }
      catch (e) { res.errors.push(e.message); }
    }
    if (!res.errors.length && type) {
      const held = await approvals.evaluate({ voucher_type: type, entries }, user);
      if (held.length) res.errors.push(`Needs approval (${held.map((h) => h.reason).join('; ')}). Ask an Owner or Accountant to import it, or post it through the voucher screen so it can be approved.`);
    }
    res.total = total;
    let voucherNo = nos[0] || null;
    if (voucherNo) {
      if (seenNos.has(voucherNo)) res.errors.push(`Voucher number "${voucherNo}" appears twice in the file.`);
      seenNos.add(voucherNo);
      if (await get('SELECT id FROM vouchers WHERE voucher_no = ?', [voucherNo])) res.errors.push(`Voucher number "${voucherNo}" already exists in the books.`);
    }
    if (type === 'Contra' && !res.errors.length && entries.some((e) => !['Bank Accounts', 'Bank OD A/c', 'Cash-in-hand'].includes(e.grp))) res.warnings.push('A Contra should involve only cash and bank ledgers.');

    // party = first debtor/creditor line
    const partyLine = entries.find((e) => ['Sundry Debtors', 'Sundry Creditors'].includes(e.grp)) ||
      (['Payment', 'Receipt'].includes(type) ? entries.find((e) => !['Bank Accounts', 'Bank OD A/c', 'Cash-in-hand'].includes(e.grp)) : null);
    const reference_no = refs[0] || '';
    if (!res.errors.length && partyLine && reference_no && type) {
      const dup = await duplicateCheck({ voucher_type: type, party_ledger_id: partyLine.ledger_id, reference_no, total_amount: total, date });
      const hi = dup.candidates.find((c) => c.level === 'high');
      if (hi) res.warnings.push(`Possible duplicate of ${hi.voucher_type} ${hi.voucher_no} (${hi.date}): same party and reference "${reference_no}".`);
    }
    if (earlier) res.warnings.push(`This file was already imported on ${earlier.created_at.slice(0, 10)} (batch #${earlier.id}).`);

    if (!res.errors.length) {
      // bill allocations (bill-by-bill): invoices open a bill; settlements/returns reference one
      const bills = [];
      const billRef = head('bill_ref')[0] || reference_no;
      if (partyLine) {
        const amt = partyLine.debit_amount || partyLine.credit_amount;
        if (type === 'Sales' || type === 'Purchase') {
          const due = new Date(Date.parse(date + 'T00:00:00Z') + (partyLine.credit_period || 30) * 86400000).toISOString().slice(0, 10);
          bills.push({ ledger_id: partyLine.ledger_id, bill_type: 'New Ref', bill_ref: billRef || voucherNo || `IMP-${g.ref}`, amount: amt, due_date: due });
        } else if (['Receipt', 'Payment', 'Credit Note', 'Debit Note'].includes(type) && head('bill_ref')[0]) {
          bills.push({ ledger_id: partyLine.ledger_id, bill_type: 'Agst Ref', bill_ref: head('bill_ref')[0], amount: amt });
        }
      }
      seq++;
      payload.push({ ref: g.ref, voucher_type: type, date, voucher_no: voucherNo, reference_no, narration: nars[0] || '', party_ledger_id: partyLine ? partyLine.ledger_id : null,
        entries: entries.map(({ ledger_id, debit_amount, credit_amount }) => ({ ledger_id, debit_amount, credit_amount })), bill_allocations: bills, total });
      res.voucher_type = type; res.date = date;
    }
    res.status = res.errors.length ? 'error' : res.warnings.length ? 'warning' : 'ok';
  }

  const summary = {
    vouchers: results.length, ok: results.filter((r) => r.status === 'ok').length, warnings: results.filter((r) => r.status === 'warning').length, errors: results.filter((r) => r.status === 'error').length,
    total_amount: r2(results.filter((r) => r.status !== 'error').reduce((s, r) => s + (r.total || 0), 0)), rows: rows.length
  };
  const ins = await run(`INSERT INTO import_batches (created_by, filename, file_hash, status, summary, payload, results) VALUES (?, ?, ?, 'previewed', ?, ?, ?)`,
    [user?.username || 'unknown', String(filename || '').slice(0, 150) || null, fileHash, JSON.stringify(summary), JSON.stringify(payload), JSON.stringify(results)]);
  await logActivity({ user, action: 'IMPORT_PREVIEW', entity: 'import', entityId: ins.lastID, details: summary });
  return { batch_id: ins.lastID, summary, results };
}

async function commit(batchId, { skip_invalid = false, include_warnings = false } = {}, user) {
  const batch = await get('SELECT * FROM import_batches WHERE id = ?', [batchId]);
  if (!batch) throw bad('Import batch not found.', 404);
  if (batch.status !== 'previewed') throw bad(`This batch is already ${batch.status}.`, 409);
  const results = JSON.parse(batch.results), payload = JSON.parse(batch.payload);
  const errors = results.filter((r) => r.status === 'error').length;
  if (errors && !skip_invalid) throw bad(`${errors} voucher(s) have errors. Fix the file and preview again, or commit only the valid ones with skip_invalid.`);
  const warned = new Set(results.filter((r) => r.status === 'warning').map((r) => r.ref));
  const toPost = payload.filter((p) => include_warnings || !warned.has(p.ref));
  if (!toPost.length) throw bad('Nothing to import: every voucher has errors or warnings.');
  for (const p of toPost) assertRoleMayPost(user, p.voucher_type);

  const posted = await withTransaction(async () => {
    // claim the batch first so two simultaneous commits can't both post it
    const claim = await run(`UPDATE import_batches SET status = 'committing' WHERE id = ? AND status = 'previewed'`, [batchId]);
    if (!claim.changes) throw bad('This batch is already being committed.', 409);
    const out = [];
    for (const p of toPost) {
      const no = p.voucher_no || `IMP/${batchId}/${String(out.length + 1).padStart(4, '0')}`;
      const r = await postVoucher({ ...p, voucher_no: no }, { user, source: 'import' });
      out.push({ ref: p.ref, id: r.id, voucher_no: r.voucher_no, total_amount: r.total_amount });
    }
    await run(`UPDATE import_batches SET status = 'committed', committed_at = CURRENT_TIMESTAMP, committed_by = ?, posted = ? WHERE id = ?`, [user?.username || 'unknown', JSON.stringify(out), batchId]);
    return out;
  });
  const skipped = results.length - posted.length; // vouchers with errors, plus any held back for warnings
  await logActivity({ user, action: 'IMPORT_COMMIT', entity: 'import', entityId: batchId, details: { vouchers: posted.length, skipped } });
  return { batch_id: batchId, posted_count: posted.length, skipped, posted };
}

async function discard(batchId, user) {
  const r = await run(`UPDATE import_batches SET status = 'discarded' WHERE id = ? AND status = 'previewed'`, [batchId]);
  if (!r.changes) throw bad('Batch not found or not in preview.', 404);
  await logActivity({ user, action: 'IMPORT_DISCARD', entity: 'import', entityId: batchId });
}

async function listBatches() {
  const rows = await all('SELECT id, created_at, created_by, filename, status, summary, committed_at, committed_by FROM import_batches ORDER BY id DESC LIMIT 50');
  return rows.map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
}
async function getBatch(id) {
  const r = await get('SELECT * FROM import_batches WHERE id = ?', [id]);
  if (!r) throw bad('Batch not found.', 404);
  return { ...r, summary: JSON.parse(r.summary), results: JSON.parse(r.results), payload: undefined, posted: r.posted ? JSON.parse(r.posted) : null };
}

module.exports = { preview, commit, discard, listBatches, getBatch, TEMPLATE };

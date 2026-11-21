/**
 * RRE Tally — bank statement import and smart reconciliation.
 *
 * Safety model:
 *  - Importing a statement only stores the statement. It never changes books.
 *  - Matching only SUGGESTS pairs. Nothing is cleared until the user confirms.
 *  - Confirming only sets the clearing date on existing bank_reconciliation rows
 *    (the same effect as the existing "Clear" button). No vouchers are posted or altered.
 */
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { parseCsv, parseAmount, parseDate } = require('./csv');
const { withTransaction } = require('./tx');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dayDiff = (a, b) => Math.abs(Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000));
const todayIso = () => new Date().toISOString().slice(0, 10);

const COLS = {
  date: ['date', 'txn_date', 'transaction_date', 'value_date', 'posting_date', 'tran_date'],
  description: ['description', 'narration', 'particulars', 'remarks', 'transaction_remarks', 'details', 'transaction_details'],
  ref: ['ref_no', 'reference', 'reference_no', 'chq_no', 'cheque_no', 'chq_ref_no', 'utr', 'utr_no', 'instrument_no', 'ref', 'chq_ref_no_'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'withdrawal_amt', 'withdrawal_amount', 'dr', 'debit_amount', 'debits'],
  credit: ['credit', 'deposit', 'deposits', 'deposit_amt', 'deposit_amount', 'cr', 'credit_amount', 'credits'],
  amount: ['amount', 'txn_amount', 'transaction_amount'],
  type: ['type', 'dr_cr', 'cr_dr', 'txn_type', 'transaction_type'],
  balance: ['balance', 'closing_balance', 'running_balance', 'bal']
};
const pick = (headers, names) => names.find((n) => headers.includes(n));

async function getBankLedger(id) {
  const l = await get(`
    SELECT l.*, g.name AS group_name FROM ledgers l JOIN account_groups g ON l.group_id = g.id WHERE l.id = ?`, [id]);
  if (!l) throw httpErr(404, 'Bank ledger not found.');
  if (!['Bank Accounts', 'Bank OD A/c'].includes(l.group_name)) throw httpErr(400, `"${l.name}" is not a bank account ledger.`);
  return l;
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

/** Parses a bank statement CSV into normalised lines (bank's perspective: debit = money out). */
function parseStatement(content) {
  const { headers, rows } = parseCsv(content);
  const c = {};
  for (const k of Object.keys(COLS)) c[k] = pick(headers, COLS[k]);
  if (!c.date) throw httpErr(400, `No date column found. Columns seen: ${headers.join(', ') || '(none)'}.`);
  if (!c.debit && !c.credit && !(c.amount && c.type)) {
    throw httpErr(400, 'Need Debit/Withdrawal and Credit/Deposit columns (or Amount with a Dr/Cr Type column).');
  }
  const lines = [], errors = [], warnings = [];
  rows.forEach((r, i) => {
    const n = i + 2;
    const date = parseDate(r[c.date]);
    if (!date) return errors.push(`Row ${n}: invalid date "${r[c.date]}".`);
    let debit = 0, credit = 0;
    if (c.debit || c.credit) {
      debit = c.debit ? parseAmount(r[c.debit]) : 0;
      credit = c.credit ? parseAmount(r[c.credit]) : 0;
    } else {
      const amt = parseAmount(r[c.amount]);
      const t = String(r[c.type] || '').trim().toLowerCase();
      if (Number.isNaN(amt)) return errors.push(`Row ${n}: invalid amount "${r[c.amount]}".`);
      if (/^(dr|debit|d|w)/.test(t)) debit = Math.abs(amt); else if (/^(cr|credit|c)/.test(t)) credit = Math.abs(amt);
      else return errors.push(`Row ${n}: cannot tell Dr/Cr from "${r[c.type]}".`);
    }
    if (Number.isNaN(debit) || Number.isNaN(credit)) return errors.push(`Row ${n}: amount is not a number.`);
    if (debit < 0 || credit < 0) return errors.push(`Row ${n}: negative debit/credit; use the Debit and Credit columns.`);
    if (debit > 0 && credit > 0) return errors.push(`Row ${n}: both debit and credit are filled.`);
    if (debit === 0 && credit === 0) return warnings.push(`Row ${n}: zero amount skipped.`);
    const balance = c.balance && String(r[c.balance]).trim() !== '' ? parseAmount(r[c.balance]) : null;
    if (balance !== null && Number.isNaN(balance)) return errors.push(`Row ${n}: invalid balance "${r[c.balance]}".`);
    lines.push({
      row: n, date, description: (c.description ? r[c.description] : '') || '', ref: (c.ref ? r[c.ref] : '') || '',
      debit: round2(debit), credit: round2(credit), balance: balance === null ? null : round2(balance)
    });
  });
  if (errors.length) {
    const e = httpErr(400, `Statement not imported. ${errors.length} problem(s): ` + errors.slice(0, 10).join(' ') + (errors.length > 10 ? ' …' : ''));
    e.details = errors; throw e;
  }
  if (!lines.length) throw httpErr(400, 'No transactions found in the statement.');

  // running-balance continuity (only when the file carries balances, in file order)
  let breaks = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], q = lines[i];
    if (p.balance === null || q.balance === null) continue;
    const forward = round2(p.balance + q.credit - q.debit);
    if (Math.abs(forward - q.balance) > 0.01) {
      // some banks list newest first; accept the reverse direction too
      const backward = round2(p.balance - p.credit + p.debit);
      if (Math.abs(backward - q.balance) > 0.01) breaks++;
    }
  }
  if (breaks) warnings.push(`${breaks} row(s) where the running balance does not follow from the previous row; check for missing or reordered lines.`);
  return { lines, warnings, columns: { date: c.date, description: c.description, ref: c.ref, debit: c.debit, credit: c.credit, balance: c.balance } };
}

async function importStatement({ bank_ledger_id, content, filename }, user) {
  const ledger = await getBankLedger(bank_ledger_id);
  if (typeof content !== 'string' || !content.trim()) throw httpErr(400, 'Statement content is empty.');
  const parsed = parseStatement(content);
  const fileHash = sha(content.replace(/\r\n/g, '\n').trim());
  const sameFile = await get('SELECT id, created_at FROM bank_statement_imports WHERE bank_ledger_id = ? AND file_hash = ?', [ledger.id, fileHash]);
  if (sameFile) throw httpErr(409, `This exact statement file was already imported (import #${sameFile.id}).`);

  return withTransaction(async () => {
    const imp = await run(
      `INSERT INTO bank_statement_imports (bank_ledger_id, filename, row_count, file_hash, created_by, date_from, date_to)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ledger.id, String(filename || '').slice(0, 150) || null, parsed.lines.length, fileHash, user?.username || 'unknown',
        parsed.lines.reduce((m, l) => (m === null || l.date < m ? l.date : m), null), parsed.lines.reduce((m, l) => (m === null || l.date > m ? l.date : m), null)]
    );
    const seen = new Map();
    let dupes = 0, inFileRepeats = 0;
    for (const l of parsed.lines) {
      const base = sha([ledger.id, l.date, norm(l.ref), l.debit, l.credit, l.balance, norm(l.description)].join('|'));
      const idx = (seen.get(base) || 0) + 1; seen.set(base, idx);
      if (idx > 1) inFileRepeats++;
      const h = `${base}:${idx}`;
      const prior = await get('SELECT id FROM bank_statement_lines WHERE bank_ledger_id = ? AND dedupe_hash = ? LIMIT 1', [ledger.id, h]);
      const isDup = prior ? 1 : 0;
      if (isDup) dupes++;
      await run(
        `INSERT INTO bank_statement_lines (import_id, bank_ledger_id, line_date, description, ref_no, debit, credit, balance, status, is_duplicate, dedupe_hash, source_row)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [imp.lastID, ledger.id, l.date, l.description, l.ref, l.debit, l.credit, l.balance, isDup ? 'duplicate' : 'unmatched', isDup, h, l.row]
      );
    }
    if (dupes) parsed.warnings.push(`${dupes} line(s) were already present from an earlier statement and are marked Duplicate (excluded from matching).`);
    if (inFileRepeats) parsed.warnings.push(`${inFileRepeats} line(s) repeat an identical earlier line in this file (same date, reference, amount, balance). They were kept as separate transactions; please check they are genuine.`);
    await history({ bank_ledger_id: ledger.id, import_id: imp.lastID, action: 'IMPORT', details: { rows: parsed.lines.length, duplicates: dupes }, user });
    return { import_id: imp.lastID, rows: parsed.lines.length, duplicates: dupes, warnings: parsed.warnings, columns_used: parsed.columns, bank_ledger: ledger.name };
  });
}

async function history({ bank_ledger_id, import_id, action, line_id, entry_id, details, user }) {
  await run(
    `INSERT INTO bank_recon_history (bank_ledger_id, import_id, action, line_id, entry_id, details, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [bank_ledger_id || null, import_id || null, action, line_id || null, entry_id || null, details ? JSON.stringify(details) : null, user?.username || 'unknown']
  );
}

/** Book entries on the bank ledger that are not yet cleared and not already linked to a statement line. */
async function openBookEntries(bankLedgerId) {
  return all(`
    SELECT e.id AS entry_id, e.debit_amount, e.credit_amount, e.particulars,
           v.id AS voucher_id, v.voucher_no, v.voucher_type, v.date, v.reference_no, v.narration, p.name AS party,
           r.instrument_no, r.status
    FROM ledger_entries e
    JOIN vouchers v ON e.voucher_id = v.id
    LEFT JOIN ledgers p ON v.party_ledger_id = p.id
    LEFT JOIN bank_reconciliation r ON r.ledger_entry_id = e.id
    WHERE e.ledger_id = ? AND (r.status IS NULL OR r.status <> 'Cleared')
      AND e.id NOT IN (SELECT matched_entry_id FROM bank_statement_lines WHERE matched_entry_id IS NOT NULL)
    ORDER BY v.date, e.id`, [bankLedgerId]);
}

const HINTS = [
  [/charge|fee|sms|amc|penal|gst on|service tax|commission/i, { voucher_type: 'Payment', ledger: 'Bank Charges' }],
  [/interest|int\.?\s*(cr|paid|pd)|int pd/i, { voucher_type: 'Receipt', ledger: 'Interest on Bank Deposits' }]
];

async function suggestMatches(importId, { windowDays = 15 } = {}) {
  const imp = await get('SELECT * FROM bank_statement_imports WHERE id = ?', [importId]);
  if (!imp) throw httpErr(404, 'Import not found.');
  const lines = await all(`SELECT * FROM bank_statement_lines WHERE import_id = ? AND status = 'unmatched' ORDER BY line_date, id`, [importId]);
  const entries = await openBookEntries(imp.bank_ledger_id);

  const pairs = [];
  for (const l of lines) {
    const out = l.debit > 0; // money out of the bank => credit entry in the bank ledger
    const amt = out ? l.debit : l.credit;
    const lref = norm(l.ref_no), ldesc = norm(l.description);
    for (const e of entries) {
      const eamt = out ? e.credit_amount : e.debit_amount;
      if (Math.abs(eamt - amt) > 0.005) continue;
      const reasons = ['Exact amount'];
      let score = 40;
      const refPool = [e.instrument_no, e.reference_no, e.voucher_no].map(norm).filter(Boolean);
      const refHit = lref.length >= 4 && refPool.some((p) => p.includes(lref) || lref.includes(p) && p.length >= 4);
      const descHit = ldesc.length >= 4 && refPool.some((p) => p.length >= 5 && ldesc.includes(p));
      if (refHit || descHit) { score += 50; reasons.push('Reference / instrument number matches'); }
      const d = dayDiff(l.line_date, e.date);
      if (d <= 3) { score += 25; reasons.push(`Dates ${d} day(s) apart`); }
      else if (d <= 7) { score += 15; reasons.push(`Dates ${d} days apart`); }
      else if (d <= windowDays) { score += 8; reasons.push(`Dates ${d} days apart`); }
      else if (!(refHit || descHit)) continue; // too far apart without a reference
      else reasons.push(`Dates ${d} days apart (reference matched)`);
      const partyTokens = String(e.party || '').split(/\s+/).map(norm).filter((t) => t.length >= 4);
      if (partyTokens.some((t) => ldesc.includes(t))) { score += 10; reasons.push('Party name appears in bank description'); }
      pairs.push({ line: l, entry: e, score, reasons, d });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.d - b.d || a.entry.entry_id - b.entry.entry_id || a.line.id - b.line.id);

  const candidateCount = new Map();
  pairs.forEach((p) => candidateCount.set(p.line.id, (candidateCount.get(p.line.id) || 0) + 1));
  const usedLines = new Set(), usedEntries = new Set(), suggestions = [];
  for (const p of pairs) {
    if (usedLines.has(p.line.id) || usedEntries.has(p.entry.entry_id)) continue;
    usedLines.add(p.line.id); usedEntries.add(p.entry.entry_id);
    const unique = candidateCount.get(p.line.id) === 1;
    const confidence = p.score >= 90 || (p.score >= 65 && unique) ? 'high' : p.score >= 55 ? 'medium' : 'low';
    suggestions.push({
      line_id: p.line.id, entry_id: p.entry.entry_id, score: p.score, confidence, reasons: p.reasons,
      ambiguous: candidateCount.get(p.line.id) > 1,
      line: { date: p.line.line_date, description: p.line.description, ref: p.line.ref_no, debit: p.line.debit, credit: p.line.credit },
      entry: { voucher_no: p.entry.voucher_no, voucher_type: p.entry.voucher_type, date: p.entry.date, party: p.entry.party, instrument_no: p.entry.instrument_no || p.entry.reference_no,
        debit: p.entry.debit_amount, credit: p.entry.credit_amount }
    });
  }
  const unmatchedLines = lines.filter((l) => !usedLines.has(l.id)).map((l) => {
    const hint = HINTS.find(([re]) => re.test(l.description || ''));
    return { line_id: l.id, date: l.line_date, description: l.description, ref: l.ref_no, debit: l.debit, credit: l.credit,
      hint: hint ? `Looks like ${hint[1].ledger === 'Bank Charges' ? 'a bank charge' : 'bank interest'}: record a ${hint[1].voucher_type} voucher to "${hint[1].ledger}".` : 'Not found in your books: record the transaction, or match it manually.' };
  });
  const unmatchedBook = entries.filter((e) => !usedEntries.has(e.entry_id) && e.date <= (imp.date_to || todayIso())).map((e) => ({
    entry_id: e.entry_id, date: e.date, voucher_no: e.voucher_no, voucher_type: e.voucher_type, party: e.party,
    instrument_no: e.instrument_no || e.reference_no, debit: e.debit_amount, credit: e.credit_amount
  }));
  return { import: imp, suggestions, unmatched_bank_lines: unmatchedLines, books_not_in_statement: unmatchedBook,
    assumptions: [
      `A pair needs the same amount and the same direction (bank withdrawal = credit in your bank ledger; deposit = debit).`,
      `Dates may differ by up to ${windowDays} days (cheques clear late); a matching reference/instrument number overrides the date window.`,
      'One statement line is matched to one voucher line. Batched deposits and split payments must be matched manually after correcting the books.',
      'Suggestions are not applied until you confirm them.'
    ] };
}

async function confirmMatches(importId, pairs, user) {
  if (!Array.isArray(pairs) || !pairs.length) throw httpErr(400, 'No matches supplied.');
  if (pairs.length > 2000) throw httpErr(400, 'Too many matches in one request (max 2000).');
  const imp = await get('SELECT * FROM bank_statement_imports WHERE id = ?', [importId]);
  if (!imp) throw httpErr(404, 'Import not found.');

  return withTransaction(async () => {
    const seenLines = new Set(), seenEntries = new Set(), problems = [];
    const planned = [];
    for (const p of pairs) {
      const lineId = parseInt(p.line_id, 10), entryId = parseInt(p.entry_id, 10);
      if (!lineId || !entryId) { problems.push('Each match needs line_id and entry_id.'); continue; }
      if (seenLines.has(lineId) || seenEntries.has(entryId)) { problems.push(`Line ${lineId} / entry ${entryId} appears twice in this request.`); continue; }
      seenLines.add(lineId); seenEntries.add(entryId);
      const line = await get('SELECT * FROM bank_statement_lines WHERE id = ? AND import_id = ?', [lineId, importId]);
      if (!line) { problems.push(`Line ${lineId} does not belong to this import.`); continue; }
      if (line.status !== 'unmatched') { problems.push(`Line ${lineId} is already ${line.status}.`); continue; }
      const entry = await get(`
        SELECT e.*, r.status AS rstatus, r.instrument_no FROM ledger_entries e LEFT JOIN bank_reconciliation r ON r.ledger_entry_id = e.id WHERE e.id = ?`, [entryId]);
      if (!entry || entry.ledger_id !== imp.bank_ledger_id) { problems.push(`Entry ${entryId} is not on this bank ledger.`); continue; }
      if (entry.rstatus === 'Cleared') { problems.push(`Entry ${entryId} is already cleared.`); continue; }
      if (await get('SELECT id FROM bank_statement_lines WHERE matched_entry_id = ?', [entryId])) { problems.push(`Entry ${entryId} is already matched to another statement line.`); continue; }
      const out = line.debit > 0;
      const lamt = out ? line.debit : line.credit, eamt = out ? entry.credit_amount : entry.debit_amount;
      if (Math.abs(lamt - eamt) > 0.005) { problems.push(`Line ${lineId} (₹${lamt}) and entry ${entryId} (₹${eamt}) differ in amount or direction.`); continue; }
      planned.push({ line, entry });
    }
    if (problems.length) { const e = httpErr(400, 'Nothing was applied. ' + problems.slice(0, 8).join(' ')); e.details = problems; throw e; }

    for (const { line, entry } of planned) {
      await run(
        `INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status) VALUES (?, ?, ?, 'Cleared')
         ON CONFLICT(ledger_entry_id) DO UPDATE SET bank_clearing_date = excluded.bank_clearing_date, status = 'Cleared',
           instrument_no = COALESCE(NULLIF(bank_reconciliation.instrument_no, ''), excluded.instrument_no)`,
        [entry.id, line.line_date, line.ref_no || null]
      );
      await run(`UPDATE bank_statement_lines SET status = 'matched', matched_entry_id = ?, matched_at = CURRENT_TIMESTAMP, matched_by = ? WHERE id = ?`, [entry.id, user?.username || 'unknown', line.id]);
      await history({ bank_ledger_id: imp.bank_ledger_id, import_id: importId, action: 'MATCH', line_id: line.id, entry_id: entry.id, details: { date: line.line_date, amount: line.debit || line.credit }, user });
    }
    return { matched: planned.length };
  });
}

async function unmatchLine(lineId, user) {
  return withTransaction(async () => {
    const line = await get('SELECT * FROM bank_statement_lines WHERE id = ?', [lineId]);
    if (!line) throw httpErr(404, 'Line not found.');
    if (line.status !== 'matched') throw httpErr(400, `Line is ${line.status}, not matched.`);
    await run(`UPDATE bank_reconciliation SET status = 'Pending', bank_clearing_date = NULL WHERE ledger_entry_id = ?`, [line.matched_entry_id]);
    await run(`UPDATE bank_statement_lines SET status = 'unmatched', matched_entry_id = NULL, matched_at = NULL, matched_by = NULL WHERE id = ?`, [lineId]);
    await history({ bank_ledger_id: line.bank_ledger_id, import_id: line.import_id, action: 'UNMATCH', line_id: lineId, entry_id: line.matched_entry_id, user });
    return { line_id: lineId };
  });
}

async function setIgnored(lineId, ignore, reason, user) {
  return withTransaction(async () => {
    const line = await get('SELECT * FROM bank_statement_lines WHERE id = ?', [lineId]);
    if (!line) throw httpErr(404, 'Line not found.');
    if (ignore && line.status !== 'unmatched') throw httpErr(400, `Only unmatched lines can be ignored (line is ${line.status}).`);
    if (!ignore && line.status !== 'ignored') throw httpErr(400, 'Line is not ignored.');
    await run('UPDATE bank_statement_lines SET status = ? WHERE id = ?', [ignore ? 'ignored' : 'unmatched', lineId]);
    await history({ bank_ledger_id: line.bank_ledger_id, import_id: line.import_id, action: ignore ? 'IGNORE' : 'UNIGNORE', line_id: lineId, details: reason ? { reason: String(reason).slice(0, 200) } : null, user });
    return { line_id: lineId };
  });
}

/** Balance comparison: books vs bank statement, with the reconciling items. */
async function bankSummary(bankLedgerId) {
  const ledger = await getBankLedger(bankLedgerId);
  const entries = await all(`
    SELECT e.id, e.debit_amount, e.credit_amount, v.date, v.voucher_no, v.voucher_type, r.status
    FROM ledger_entries e JOIN vouchers v ON e.voucher_id = v.id LEFT JOIN bank_reconciliation r ON r.ledger_entry_id = e.id
    WHERE e.ledger_id = ?`, [ledger.id]);
  const opening = ledger.opening_balance_type === 'Dr' ? ledger.opening_balance : -ledger.opening_balance;
  let book = opening, upRec = 0, upPay = 0, upRecN = 0, upPayN = 0;
  for (const e of entries) {
    book += e.debit_amount - e.credit_amount;
    if (e.status !== 'Cleared') {
      if (e.debit_amount > 0) { upRec += e.debit_amount; upRecN++; } else { upPay += e.credit_amount; upPayN++; }
    }
  }
  const expectedBank = round2(book - upRec + upPay);
  const last = await get(`
    SELECT line_date, balance FROM bank_statement_lines WHERE bank_ledger_id = ? AND balance IS NOT NULL AND is_duplicate = 0
    ORDER BY line_date DESC, id DESC LIMIT 1`, [ledger.id]);
  const counts = await all(`SELECT status, COUNT(*) c FROM bank_statement_lines WHERE bank_ledger_id = ? GROUP BY status`, [ledger.id]);
  const c = Object.fromEntries(counts.map((r) => [r.status, r.c]));
  return {
    bank_ledger: { id: ledger.id, name: ledger.name },
    balance_per_books: round2(book),
    uncleared_receipts: { amount: round2(upRec), count: upRecN },
    uncleared_payments: { amount: round2(upPay), count: upPayN },
    expected_bank_balance: expectedBank,
    statement_closing_balance: last ? round2(last.balance) : null,
    statement_as_of: last ? last.line_date : null,
    unexplained_difference: last ? round2(last.balance - expectedBank) : null,
    statement_lines: { matched: c.matched || 0, unmatched: c.unmatched || 0, ignored: c.ignored || 0, duplicate: c.duplicate || 0 },
    explanation: 'Expected bank balance = books − receipts not yet cleared + payments not yet cleared. A non-zero unexplained difference means bank lines missing from the books, books entries wrongly cleared, or a statement dated before later book entries.'
  };
}

async function paymentStatus(bankLedgerId, { status, limit = 200 } = {}) {
  await getBankLedger(bankLedgerId);
  const rows = await all(`
    SELECT e.id AS entry_id, e.debit_amount, e.credit_amount, v.date, v.voucher_no, v.voucher_type, v.reference_no, p.name AS party,
           r.status, r.bank_clearing_date, r.instrument_no
    FROM ledger_entries e JOIN vouchers v ON e.voucher_id = v.id LEFT JOIN ledgers p ON v.party_ledger_id = p.id
    LEFT JOIN bank_reconciliation r ON r.ledger_entry_id = e.id
    WHERE e.ledger_id = ? ORDER BY v.date DESC, e.id DESC`, [bankLedgerId]);
  const today = todayIso();
  const out = rows.map((r) => {
    const cleared = r.status === 'Cleared';
    const pendingDays = cleared ? null : dayDiff(today, r.date);
    return {
      entry_id: r.entry_id, date: r.date, voucher_no: r.voucher_no, voucher_type: r.voucher_type, party: r.party,
      instrument_no: r.instrument_no || r.reference_no, direction: r.credit_amount > 0 ? 'Payment' : 'Receipt',
      amount: r.credit_amount > 0 ? r.credit_amount : r.debit_amount, status: cleared ? 'Cleared' : 'Pending',
      bank_clearing_date: r.bank_clearing_date, pending_days: pendingDays,
      flag: !cleared && r.credit_amount > 0 && pendingDays > 90 ? 'Stale cheque? Pending more than 90 days (cheques are valid for 3 months).' : null
    };
  }).filter((r) => !status || r.status.toLowerCase() === String(status).toLowerCase());
  return out.slice(0, Math.min(1000, limit));
}

async function listImports(bankLedgerId) {
  return all(`
    SELECT i.*, (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.import_id = i.id AND l.status='matched') AS matched,
           (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.import_id = i.id AND l.status='unmatched') AS unmatched,
           (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.import_id = i.id AND l.status='duplicate') AS duplicates
    FROM bank_statement_imports i WHERE (? IS NULL OR i.bank_ledger_id = ?) ORDER BY i.id DESC LIMIT 100`, [bankLedgerId || null, bankLedgerId || null]);
}

async function listHistory(bankLedgerId, limit = 100) {
  return all(`
    SELECT h.*, v.voucher_no FROM bank_recon_history h
    LEFT JOIN ledger_entries e ON e.id = h.entry_id LEFT JOIN vouchers v ON v.id = e.voucher_id
    WHERE (? IS NULL OR h.bank_ledger_id = ?) ORDER BY h.id DESC LIMIT ?`, [bankLedgerId || null, bankLedgerId || null, Math.min(500, limit)]);
}

module.exports = { parseStatement, importStatement, suggestMatches, confirmMatches, unmatchLine, setIgnored, bankSummary, paymentStatus, listImports, listHistory, getBankLedger };

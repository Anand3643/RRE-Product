/**
 * RRE Tally — accounting automation (read-only analysis over posted vouchers).
 * Nothing here posts or edits a voucher. Every result says how it was derived.
 */
const { all, get } = require('./db');
const { getOpenBills, daysBetween } = require('./analytics');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
const STOP = new Set(['being', 'paid', 'payment', 'received', 'receipt', 'against', 'towards', 'from', 'with', 'this', 'that', 'for', 'the', 'and', 'invoice', 'bill', 'voucher', 'amount', 'month', 'ltd', 'pvt', 'limited']);
const tokens = (s) => [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t)))];

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------
async function duplicateCheck({ voucher_type, party_ledger_id, reference_no, total_amount, date }, { windowDays = 7 } = {}) {
  if (date && !ISO.test(date)) throw bad('date must be YYYY-MM-DD.');
  const party = parseInt(party_ledger_id, 10) || null;
  const ref = normRef(reference_no);
  const amt = total_amount === undefined || total_amount === null || total_amount === '' ? null : Number(total_amount);
  if (amt !== null && !Number.isFinite(amt)) throw bad('total_amount must be a number.');
  if (!party && !ref) return { candidates: [], note: 'Supply a party and/or reference number to check.' };

  const rows = await all(`
    SELECT v.id, v.voucher_no, v.voucher_type, v.date, v.reference_no, v.total_amount, p.name AS party
    FROM vouchers v LEFT JOIN ledgers p ON p.id = v.party_ledger_id
    WHERE (? IS NULL OR v.party_ledger_id = ?) ORDER BY v.date DESC, v.id DESC LIMIT 5000`, [party, party]);
  const cands = [];
  for (const r of rows) {
    const reasons = [];
    let level = null;
    const sameType = !voucher_type || r.voucher_type === voucher_type;
    if (ref && normRef(r.reference_no) === ref && party && sameType) { level = 'high'; reasons.push('Same party and same reference / invoice number'); }
    if (amt !== null && party && sameType && Math.abs(r.total_amount - amt) < 0.005) {
      const d = date ? Math.abs(daysBetween(r.date, date)) : null;
      if (d !== null && d <= windowDays) { level = level || 'medium'; reasons.push(`Same party and amount (₹${amt}) within ${d} day(s)`); }
    }
    if (ref && !party && normRef(r.reference_no) === ref && sameType) { level = level || 'medium'; reasons.push('Same reference number'); }
    if (level) cands.push({ ...r, level, reasons });
  }
  cands.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1));
  return { candidates: cands.slice(0, 10), method: 'Compared with posted vouchers: reference numbers ignore case, punctuation and leading zeros; amount matches use the same party within the date window.' };
}

async function scanDuplicates({ from_date, to_date } = {}) {
  for (const d of [from_date, to_date]) if (d && !ISO.test(d)) throw bad('Dates must be YYYY-MM-DD.');
  const params = []; let where = '1=1';
  if (from_date) { where += ' AND v.date >= ?'; params.push(from_date); }
  if (to_date) { where += ' AND v.date <= ?'; params.push(to_date); }
  const vs = await all(`
    SELECT v.id, v.voucher_no, v.voucher_type, v.date, v.reference_no, v.total_amount, v.party_ledger_id, p.name AS party
    FROM vouchers v LEFT JOIN ledgers p ON p.id = v.party_ledger_id WHERE ${where}
    AND v.voucher_type NOT IN ('Journal', 'Contra') ORDER BY v.date, v.id`, params);
  const groups = new Map();
  const add = (key, kind, v) => { if (!groups.has(key)) groups.set(key, { kind, vouchers: [] }); groups.get(key).vouchers.push(v); };
  for (const v of vs) {
    if (!v.party_ledger_id) continue;
    const ref = normRef(v.reference_no);
    if (ref) add(`R|${v.voucher_type}|${v.party_ledger_id}|${ref}`, 'Same party and reference number', v);
    add(`A|${v.voucher_type}|${v.party_ledger_id}|${v.date}|${round2(v.total_amount)}`, 'Same party, date and amount', v);
  }
  const seen = new Set(), out = [];
  for (const g of groups.values()) {
    if (g.vouchers.length < 2) continue;
    const sig = g.vouchers.map((v) => v.id).join(',');
    if (seen.has(sig)) continue; seen.add(sig);
    out.push({ reason: g.kind, level: g.kind.includes('reference') ? 'high' : 'medium', amount: g.vouchers[0].total_amount, vouchers: g.vouchers.map(({ id, voucher_no, voucher_type, date, reference_no, party, total_amount }) => ({ id, voucher_no, voucher_type, date, reference_no, party, total_amount })) });
  }
  out.sort((a, b) => (a.level === b.level ? b.amount - a.amount : a.level === 'high' ? -1 : 1));
  return { groups: out, vouchers_scanned: vs.length, note: 'Journal and Contra vouchers are not scanned. Two genuine purchases of the same amount on one day will also appear; review before acting.' };
}

// ---------------------------------------------------------------------------
// Suggestions & categorisation from history
// ---------------------------------------------------------------------------
async function counterLines(voucherIds) {
  if (!voucherIds.length) return [];
  const ph = voucherIds.map(() => '?').join(',');
  return all(`
    SELECT e.voucher_id, e.ledger_id, e.debit_amount, e.credit_amount, l.name, g.name AS grp, g.nature
    FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id
    WHERE e.voucher_id IN (${ph})`, voucherIds);
}
const isBookingLedger = (r) => !['Bank Accounts', 'Bank OD A/c', 'Cash-in-hand', 'Duties & Taxes', 'Sundry Debtors', 'Sundry Creditors'].includes(r.grp) && r.name !== 'Round Off A/c';

async function similarVouchers(narration, voucherType, limit = 200) {
  const toks = tokens(narration);
  if (!toks.length) return [];
  const rows = await all(`SELECT id, narration, voucher_type, total_amount FROM vouchers WHERE narration IS NOT NULL AND narration <> '' ${voucherType ? 'AND voucher_type = ?' : ''} ORDER BY id DESC LIMIT 3000`, voucherType ? [voucherType] : []);
  const out = [];
  for (const r of rows) {
    const t2 = tokens(r.narration); if (!t2.length) continue;
    const inter = toks.filter((t) => t2.includes(t)).length;
    if (!inter) continue;
    out.push({ ...r, similarity: inter / (toks.length + t2.length - inter) });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

async function suggestLedgers({ voucher_type, party_ledger_id, narration }) {
  const party = parseInt(party_ledger_id, 10) || null;
  const scores = new Map(); const reasons = new Map();
  const bump = (l, pts, why) => { const k = l.ledger_id; scores.set(k, (scores.get(k) || 0) + pts); if (!reasons.has(k)) reasons.set(k, new Set()); reasons.get(k).add(why); scores.set('meta' + k, l); };
  let template = null, basis = 0;

  if (party) {
    const hist = await all(`SELECT id, voucher_no, date, total_amount, narration FROM vouchers WHERE party_ledger_id = ? ${voucher_type ? 'AND voucher_type = ?' : ''} ORDER BY date DESC, id DESC LIMIT 10`, voucher_type ? [party, voucher_type] : [party]);
    basis += hist.length;
    const lines = await counterLines(hist.map((h) => h.id));
    for (const l of lines.filter(isBookingLedger)) bump(l, 2, `Used in ${hist.length} earlier ${voucher_type || 'voucher'}(s) with this party`);
    if (hist[0]) {
      const ls = lines.filter((l) => l.voucher_id === hist[0].id);
      template = { from_voucher: hist[0].voucher_no, date: hist[0].date, total_amount: hist[0].total_amount, narration: hist[0].narration,
        lines: ls.map((l) => ({ ledger_id: l.ledger_id, name: l.name, debit_amount: l.debit_amount, credit_amount: l.credit_amount })) };
      const amts = hist.map((h) => h.total_amount).sort((a, b) => a - b);
      template.typical_amount = amts[Math.floor(amts.length / 2)];
    }
  }
  const sim = await similarVouchers(narration, voucher_type, 20);
  if (sim.length) {
    basis += sim.length;
    const lines = await counterLines(sim.map((s) => s.id));
    for (const s of sim) for (const l of lines.filter((x) => x.voucher_id === s.id && isBookingLedger(x))) bump(l, s.similarity * 3, `Narration resembles ${sim.length} earlier voucher(s)`);
  }
  const maxScore = Math.max(0, ...[...scores.entries()].filter(([k]) => typeof k === 'number').map(([, v]) => v));
  const suggestions = [...scores.entries()].filter(([k]) => typeof k === 'number').map(([k, s]) => {
    const m = scores.get('meta' + k);
    return { ledger_id: k, name: m.name, group: m.grp, score: round2(s), confidence: maxScore ? round2(s / maxScore) : 0, because: [...reasons.get(k)] };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  return { suggestions, template, based_on_vouchers: basis, method: 'Counts which non-bank, non-tax ledgers were used in earlier vouchers with the same party and in vouchers with similar narration words. Suggestions only; nothing is filled or posted.' };
}

async function categorize({ narration, amount }) {
  const sim = await similarVouchers(narration, null, 40);
  if (!sim.length) return { category: null, ledger: null, confidence: 0, based_on_vouchers: 0, note: 'No earlier vouchers with similar narration.' };
  const lines = await counterLines(sim.map((s) => s.id));
  const tally = new Map(); let total = 0;
  for (const s of sim) {
    const ls = lines.filter((l) => l.voucher_id === s.id && isBookingLedger(l));
    for (const l of ls) { const w = s.similarity; total += w; const cur = tally.get(l.ledger_id) || { ledger_id: l.ledger_id, name: l.name, group: l.grp, nature: l.nature, w: 0, n: 0 }; cur.w += w; cur.n++; tally.set(l.ledger_id, cur); }
  }
  const ranked = [...tally.values()].sort((a, b) => b.w - a.w);
  const best = ranked[0];
  if (!best) return { category: null, ledger: null, confidence: 0, based_on_vouchers: sim.length, note: 'Similar vouchers had no categorisable ledger.' };
  return { category: best.group, nature: best.nature, ledger: { id: best.ledger_id, name: best.name }, confidence: round2(best.w / total), based_on_vouchers: best.n,
    alternatives: ranked.slice(1, 3).map((r) => ({ ledger: r.name, confidence: round2(r.w / total) })), amount_given: amount ?? null,
    method: 'Weighted vote of ledgers used in earlier vouchers whose narration shares words with this one.' };
}

// ---------------------------------------------------------------------------
// Unusual transactions
// ---------------------------------------------------------------------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function unusualTransactions({ from_date, to_date } = {}) {
  for (const d of [from_date, to_date]) if (d && !ISO.test(d)) throw bad('Dates must be YYYY-MM-DD.');
  const rows = await all(`
    SELECT e.id AS entry_id, e.ledger_id, e.debit_amount, e.credit_amount, l.name AS ledger, g.name AS grp, g.nature,
           v.id AS voucher_id, v.voucher_no, v.voucher_type, v.date, v.total_amount, v.created_at, v.party_ledger_id, p.name AS party
    FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id
    LEFT JOIN ledgers p ON p.id = v.party_ledger_id ORDER BY v.date, v.id`);
  const inRange = (r) => (!from_date || r.date >= from_date) && (!to_date || r.date <= to_date);
  const findings = [];
  const add = (r, severity, code, message, score) => findings.push({ voucher_id: r.voucher_id, voucher_no: r.voucher_no, voucher_type: r.voucher_type, date: r.date, party: r.party, ledger: r.ledger, amount: r.debit_amount || r.credit_amount, severity, code, message, score: round2(score) });

  // 1. amount outliers per booking ledger (robust: median / MAD)
  const byLedger = new Map();
  rows.filter(isBookingLedger).forEach((r) => { const a = r.debit_amount || r.credit_amount; if (!byLedger.has(r.ledger_id)) byLedger.set(r.ledger_id, []); byLedger.get(r.ledger_id).push({ r, a }); });
  for (const list of byLedger.values()) {
    if (list.length < 6) continue;
    const amts = list.map((x) => x.a), med = median(amts), mad = median(amts.map((a) => Math.abs(a - med)));
    for (const { r, a } of list) {
      if (!inRange(r)) continue;
      let z = null;
      if (mad > 0) z = (0.6745 * (a - med)) / mad;
      else if (a > 3 * med && med > 0) z = 99;
      if (z !== null && z > 3.5) add(r, 'warning', 'AMOUNT_OUTLIER', `₹${round2(a)} on "${r.ledger}" is far above its usual size (median ₹${round2(med)} over ${amts.length} entries).`, Math.min(z, 20));
    }
  }
  // 2. first-time party with a large voucher
  const partyCount = new Map();
  rows.forEach((r) => { if (r.party_ledger_id && r.ledger_id === r.party_ledger_id) partyCount.set(r.party_ledger_id, (partyCount.get(r.party_ledger_id) || 0) + 1); });
  const totals = [...new Map(rows.map((r) => [r.voucher_id, r.total_amount])).values()].sort((a, b) => a - b);
  const p90 = totals.length >= 10 ? totals[Math.floor(totals.length * 0.9)] : Infinity;
  const seenV = new Set();
  for (const r of rows) {
    if (seenV.has(r.voucher_id)) continue; seenV.add(r.voucher_id);
    if (!inRange(r) || !r.party_ledger_id || !['Sales', 'Purchase', 'Payment', 'Receipt'].includes(r.voucher_type)) continue;
    if (partyCount.get(r.party_ledger_id) === 1 && r.total_amount >= p90) add(r, 'info', 'NEW_PARTY_LARGE', `First transaction with "${r.party}" is unusually large (₹${round2(r.total_amount)} is in the top 10% of vouchers).`, 3);
  }
  // 3. late entry: voucher dated long before it was keyed in
  const seenL = new Set();
  for (const r of rows) {
    if (seenL.has(r.voucher_id)) continue; seenL.add(r.voucher_id);
    if (!inRange(r) || !r.created_at) continue;
    const lag = daysBetween(r.date, r.created_at.slice(0, 10));
    if (lag > 30) add(r, 'info', 'LATE_ENTRY', `Voucher dated ${r.date} was entered ${lag} days later (${r.created_at.slice(0, 10)}).`, lag / 30);
  }
  // 4. cash compliance (verify applicability): s.40A(3) payments > ₹10,000 and s.269ST receipts ≥ ₹2,00,000
  const cashDay = new Map();
  for (const r of rows) {
    if (r.grp !== 'Cash-in-hand' || !inRange(r)) continue;
    if (r.credit_amount > 0 && r.voucher_type === 'Payment') { const k = `P|${r.date}|${r.party_ledger_id || r.voucher_id}`; cashDay.set(k, { r, sum: (cashDay.get(k)?.sum || 0) + r.credit_amount }); }
    if (r.debit_amount > 0 && r.voucher_type === 'Receipt') { const k = `R|${r.date}|${r.party_ledger_id || r.voucher_id}`; cashDay.set(k, { r, sum: (cashDay.get(k)?.sum || 0) + r.debit_amount }); }
  }
  for (const [k, { r, sum }] of cashDay) {
    if (k.startsWith('P') && sum > 10000) add(r, 'warning', 'CASH_PAYMENT_OVER_10000', `Cash payments of ₹${round2(sum)} to one party in a day. Income-tax s.40A(3) can disallow cash expenditure above ₹10,000 per person per day (limits and exceptions vary; verify with your CA).`, 5);
    if (k.startsWith('R') && sum >= 200000) add(r, 'warning', 'CASH_RECEIPT_200000', `Cash receipt of ₹${round2(sum)} from one party in a day. Income-tax s.269ST restricts cash receipts of ₹2,00,000 or more (verify applicability with your CA).`, 6);
  }
  // 5. round-number large payments
  const seenR = new Set();
  for (const r of rows) {
    if (seenR.has(r.voucher_id)) continue; seenR.add(r.voucher_id);
    if (!inRange(r) || !['Payment', 'Journal'].includes(r.voucher_type)) continue;
    if (r.total_amount >= 100000 && r.total_amount % 10000 === 0) add(r, 'info', 'ROUND_LARGE_AMOUNT', `Large round amount ₹${round2(r.total_amount)}. Round figures are worth a second look when no invoice backs them.`, 2);
  }
  const rank = { warning: 0, info: 1 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.score - a.score);
  const total = findings.length;
  return { findings: findings.slice(0, 500), findings_total: total, truncated: total > 500, entries_analysed: rows.length,
    methods: ['Amount outliers use the median and median-absolute-deviation of that ledger\'s past entries (needs ≥ 6 entries); flagged when the modified z-score exceeds 3.5.',
      'New-party check: a party\'s only voucher is in the top 10% by amount (needs ≥ 10 vouchers).', 'Late entry: voucher date more than 30 days before it was keyed in.',
      'Cash rules are screening aids, not tax advice; exceptions (e.g. transporters, banking-hour limits) are not modelled.'] };
}

// ---------------------------------------------------------------------------
// Overdue payment reminders (text only; nothing is sent)
// ---------------------------------------------------------------------------
async function overdueReminders({ min_days = 1 } = {}) {
  const company = (await get('SELECT name, formal_name FROM company_info LIMIT 1')) || {};
  const who = company.formal_name || company.name || 'us';
  const { receivables } = await getOpenBills();
  const today = todayIso();
  const by = new Map();
  for (const b of receivables) {
    const d = daysBetween(b.due_date, today);
    if (d < min_days) continue;
    if (!by.has(b.ledger_id)) by.set(b.ledger_id, { ledger_id: b.ledger_id, customer: b.ledger_name, bills: [], total: 0, max_days: 0 });
    const c = by.get(b.ledger_id);
    c.bills.push({ bill_ref: b.bill_ref, bill_date: b.bill_date, due_date: b.due_date, pending: b.pending_amount, days_overdue: d });
    c.total = round2(c.total + b.pending_amount); c.max_days = Math.max(c.max_days, d);
  }
  const out = [...by.values()].map((c) => {
    c.bills.sort((a, b) => b.days_overdue - a.days_overdue);
    const lines = c.bills.map((b) => `• ${b.bill_ref} dated ${b.bill_date}: ₹${b.pending.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (due ${b.due_date}, ${b.days_overdue} days overdue)`).join('\n');
    return { ...c, tone: c.max_days > 60 ? 'firm' : 'polite',
      message: `Dear ${c.customer},\n\nOur records show the following payment(s) are overdue:\n${lines}\n\nTotal outstanding: ₹${c.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}.\n` +
        `${c.max_days > 60 ? 'Please arrange payment immediately or let us know if there is a dispute.' : 'Kindly arrange payment at your earliest convenience. If already paid, please share the payment details.'}\n\nRegards,\n${who}` };
  }).sort((a, b) => b.total - a.total);
  return { as_of: today, customers: out, total_overdue: round2(out.reduce((s, c) => s + c.total, 0)),
    note: 'Messages are drafts for you to send. RRE Tally does not store customer phone numbers or emails, so nothing is sent automatically.' };
}

module.exports = { duplicateCheck, scanDuplicates, suggestLedgers, categorize, unusualTransactions, overdueReminders, normRef };

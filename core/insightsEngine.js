/**
 * RRE Tally — business insights engine (offline, deterministic, read-only).
 *
 * Every answer is computed from the company's own books with plain SQL and statistics. There is no language
 * model: questions are matched to known intents, and anything not understood returns null so the caller can
 * fall back to the older assistant. Each result lists its assumptions and the date the books are "as at".
 * Nothing here posts, edits or sends anything.
 */
const { all, get } = require('./db');
const { getOpenBills, daysBetween, getUnbalancedVouchers } = require('./analytics');
const inventory = require('./inventoryTools');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

// ------------------------------------------------------------------ time
async function booksDate(override) {
  if (override) { if (!ISO.test(override)) throw bad('as_of must be YYYY-MM-DD.'); return override; }
  const r = await get('SELECT MAX(date) d FROM vouchers');
  return (r && r.d) || new Date().toISOString().slice(0, 10);
}
function monthRange(y, m) { return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastOfMonth(y, m))}` }; }
function monthShift(y, m, d) { const t = y * 12 + (m - 1) + d; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }

async function fyStart(asOf) {
  const c = await get('SELECT financial_year_from f FROM company_info LIMIT 1');
  const mmdd = (c && c.f ? c.f.slice(5) : '04-01');
  const y = Number(asOf.slice(0, 4));
  const cand = `${y}-${mmdd}`;
  return cand <= asOf ? cand : `${y - 1}-${mmdd}`;
}

/** Understands: today, yesterday, this/last month, this/last quarter, this year / financial year, last N days|weeks|months, a month name (+year), "from X to Y". */
async function parsePeriod(text, asOf, fallback = 'this month') {
  const t = String(text || '').toLowerCase();
  const y = Number(asOf.slice(0, 4)), m = Number(asOf.slice(5, 7));
  let mt;
  if ((mt = /from\s+(\d{4}-\d{2}-\d{2})\s+(?:to|till|until)\s+(\d{4}-\d{2}-\d{2})/.exec(t))) return { from: mt[1], to: mt[2], label: `${mt[1]} to ${mt[2]}` };
  if (/\byesterday\b/.test(t)) { const d = addDays(asOf, -1); return { from: d, to: d, label: 'yesterday (' + d + ')' }; }
  if (/\btoday\b|\btoday's\b/.test(t)) return { from: asOf, to: asOf, label: 'today (' + asOf + ')' };
  if ((mt = /last\s+(\d{1,3})\s+(day|week|month)s?/.exec(t))) {
    const n = Number(mt[1]); const days = mt[2] === 'day' ? n : mt[2] === 'week' ? n * 7 : n * 30;
    return { from: addDays(asOf, -days + 1), to: asOf, label: `last ${n} ${mt[2]}${n > 1 ? 's' : ''}` };
  }
  if (/last\s+month|previous\s+month|prior\s+month/.test(t)) { const p = monthShift(y, m, -1); return { ...monthRange(p.y, p.m), label: `${MONTHS[p.m - 1]} ${p.y}` }; }
  if (/this\s+month/.test(t)) return { from: `${y}-${pad(m)}-01`, to: asOf, label: `this month (${MONTHS[m - 1]} ${y})` };
  if (/last\s+quarter/.test(t)) { const q = Math.floor((m - 1) / 3); const p = monthShift(y, q * 3 + 1, -3); return { from: `${p.y}-${pad(p.m)}-01`, to: monthRange(...Object.values(monthShift(p.y, p.m, 2))).to, label: 'last quarter' }; }
  if (/this\s+quarter/.test(t)) { const q = Math.floor((m - 1) / 3); return { from: `${y}-${pad(q * 3 + 1)}-01`, to: asOf, label: 'this quarter' }; }
  if (/this\s+(financial\s+)?year|\bfy\b|year\s+to\s+date|ytd/.test(t)) return { from: await fyStart(asOf), to: asOf, label: 'this financial year' };
  for (let i = 0; i < 12; i++) {
    const words = i === 4 ? ['may'] : i === 8 ? ['september', 'sept', 'sep'] : [MONTHS[i], MONTH_ABBR[i]];
    const re = new RegExp(`\\b(?:${words.join('|')})\\b(?:\\s+(\\d{4}))?`);
    const mm = re.exec(t);
    if (!mm) continue;
    // "may" is also a verb: only treat it as the month when it follows a preposition or carries a year
    if (i === 4 && !(/\b(in|for|during|of|on|since|from)\s+may\b/.test(t) || mm[1])) continue;
    const yy = mm[1] ? Number(mm[1]) : (i + 1 > m ? y - 1 : y);
    return { ...monthRange(yy, i + 1), label: `${MONTHS[i]} ${yy}` };
  }
  return parsePeriod(fallback, asOf, 'this month');
}

// ------------------------------------------------------------------ core metrics (period activity from ledger entries)
async function groupNet(from, to, groupNames) {
  const ph = groupNames.map(() => '?').join(',');
  return all(`
    SELECT l.id, l.name, g.name AS grp, COALESCE(SUM(e.credit_amount - e.debit_amount), 0) AS net_credit
    FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id
    WHERE g.name IN (${ph}) AND v.date >= ? AND v.date <= ? GROUP BY l.id HAVING ABS(net_credit) > 0.004 ORDER BY ABS(net_credit) DESC`, [...groupNames, from, to]);
}

async function costPerUnitMap(to) {
  const rows = await all(`
    SELECT s.id, s.opening_qty, s.opening_val, s.opening_rate,
      COALESCE((SELECT SUM(i.quantity) FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id WHERE i.stock_item_id = s.id AND v.voucher_type = 'Purchase' AND v.date <= ?), 0) AS pq,
      COALESCE((SELECT SUM(i.amount) FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id WHERE i.stock_item_id = s.id AND v.voucher_type = 'Purchase' AND v.date <= ?), 0) AS pa
    FROM stock_items s`, [to, to]);
  const m = new Map();
  for (const r of rows) { const q = r.opening_qty + r.pq; m.set(r.id, q > 0 ? (r.opening_val + r.pa) / q : r.opening_rate || 0); }
  return m;
}

async function netSoldByItem(from, to) {
  return all(`
    SELECT i.stock_item_id AS id, s.name,
      SUM(CASE WHEN v.voucher_type = 'Sales' THEN i.quantity WHEN v.voucher_type = 'Credit Note' THEN -i.quantity ELSE 0 END) AS qty,
      SUM(CASE WHEN v.voucher_type = 'Sales' THEN i.amount WHEN v.voucher_type = 'Credit Note' THEN -i.amount ELSE 0 END) AS value
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.stock_item_id
    WHERE v.voucher_type IN ('Sales', 'Credit Note') AND v.date >= ? AND v.date <= ? GROUP BY i.stock_item_id`, [from, to]);
}

async function periodProfit(from, to) {
  const sales = await groupNet(from, to, ['Sales Accounts']);
  const dInc = await groupNet(from, to, ['Direct Incomes']), iInc = await groupNet(from, to, ['Indirect Incomes']);
  const dExp = await groupNet(from, to, ['Direct Expenses']), iExp = await groupNet(from, to, ['Indirect Expenses']);
  const sum = (a) => a.reduce((s, x) => s + x.net_credit, 0);
  const cost = await costPerUnitMap(to);
  const sold = await netSoldByItem(from, to);
  const cogs = sold.reduce((s, x) => s + x.qty * (cost.get(x.id) || 0), 0);
  const revenue = sum(sales), directInc = sum(dInc), indirectInc = sum(iInc), directExp = -sum(dExp), indirectExp = -sum(iExp);
  const gross = revenue + directInc - cogs - directExp;
  const net = gross + indirectInc - indirectExp;
  return { from, to, revenue: r2(revenue), cogs: r2(cogs), direct_expenses: r2(directExp), direct_incomes: r2(directInc), gross_profit: r2(gross),
    indirect_incomes: r2(indirectInc), indirect_expenses: r2(indirectExp), net_profit: r2(net), net_margin_pct: revenue > 0 ? r2((net / revenue) * 100) : null };
}
const PROFIT_METHOD = 'Net profit = sales + other incomes − cost of goods sold − direct and indirect expenses for the period. Cost of goods sold = units sold (net of sales returns) × weighted-average purchase cost, so stock bought but not yet sold is not treated as an expense. It will differ from the Profit & Loss report, which values closing stock for the whole year.';

async function expensesByLedger(from, to) {
  const rows = await groupNet(from, to, ['Direct Expenses', 'Indirect Expenses']);
  return rows.map((r) => ({ ledger_id: r.id, ledger: r.name, group: r.grp, amount: r2(-r.net_credit) })).filter((r) => Math.abs(r.amount) > 0.004);
}

async function salesBreakdown(from, to) {
  const total = (await groupNet(from, to, ['Sales Accounts'])).reduce((s, x) => s + x.net_credit, 0);
  const byCustomer = await all(`
    SELECT p.id, p.name, SUM(CASE WHEN v.voucher_type = 'Sales' THEN v.total_amount WHEN v.voucher_type = 'Credit Note' THEN -v.total_amount ELSE 0 END) AS amount, COUNT(*) AS vouchers
    FROM vouchers v JOIN ledgers p ON p.id = v.party_ledger_id WHERE v.voucher_type IN ('Sales', 'Credit Note') AND v.date >= ? AND v.date <= ?
    GROUP BY p.id ORDER BY amount DESC`, [from, to]);
  const byDay = await all(`
    SELECT v.date, SUM(CASE WHEN v.voucher_type = 'Sales' THEN v.total_amount ELSE -v.total_amount END) AS amount FROM vouchers v
    WHERE v.voucher_type IN ('Sales', 'Credit Note') AND v.date >= ? AND v.date <= ? GROUP BY v.date ORDER BY v.date`, [from, to]);
  const invoices = (await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales' AND date >= ? AND date <= ?`, [from, to])).c;
  const invoiceTotal = (await get(`SELECT COALESCE(SUM(total_amount),0) s FROM vouchers WHERE voucher_type = 'Sales' AND date >= ? AND date <= ?`, [from, to])).s;
  return { net_sales_excl_tax: r2(total), invoices, invoice_total_incl_tax: r2(invoiceTotal), by_customer: byCustomer.map((c) => ({ ...c, amount: r2(c.amount) })), by_day: byDay.map((d) => ({ ...d, amount: r2(d.amount) })) };
}

async function cashPosition(asOf) {
  const rows = await all(`
    SELECT l.id, l.name, g.name AS grp, l.opening_balance, l.opening_balance_type,
      COALESCE((SELECT SUM(e.debit_amount - e.credit_amount) FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = l.id AND v.date <= ?), 0) AS mv
    FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name IN ('Cash-in-hand', 'Bank Accounts', 'Bank OD A/c')`, [asOf]);
  const accounts = rows.map((r) => ({ id: r.id, name: r.name, group: r.grp, balance: r2((r.opening_balance_type === 'Cr' ? -r.opening_balance : r.opening_balance) + r.mv) }));
  return { total: r2(accounts.reduce((s, a) => s + a.balance, 0)), accounts };
}

// ------------------------------------------------------------------ trends (ordinary least squares, stated plainly)
function linearFit(ys) {
  const n = ys.length; const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const slope = sxx ? sxy / sxx : 0, intercept = my - slope * mx;
  const fitted = xs.map((x) => intercept + slope * x);
  const ssRes = ys.reduce((s, y, i) => s + (y - fitted[i]) ** 2, 0), ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const sigma = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : 0, sigma, mean: my, n };
}

async function monthlySeries(asOf, months = 12) {
  const end = { y: Number(asOf.slice(0, 4)), m: Number(asOf.slice(5, 7)) };
  const first = monthShift(end.y, end.m, -(months - 1));
  const fromAll = `${first.y}-${pad(first.m)}-01`;
  const GROUPS = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes', 'Direct Expenses', 'Indirect Expenses'];

  // (1) period activity of the profit-and-loss groups, per month
  const gRows = await all(`
    SELECT substr(v.date, 1, 7) AS m, g.name AS grp, COALESCE(SUM(e.credit_amount - e.debit_amount), 0) AS net
    FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id
    WHERE g.name IN (${GROUPS.map(() => '?').join(',')}) AND v.date >= ? AND v.date <= ? GROUP BY m, grp`, [...GROUPS, fromAll, asOf]);
  const net = new Map(gRows.map((r) => [`${r.m}|${r.grp}`, r.net]));
  // (2) net units sold per item per month
  const sold = await all(`
    SELECT substr(v.date, 1, 7) AS m, i.stock_item_id AS id,
      SUM(CASE WHEN v.voucher_type = 'Sales' THEN i.quantity WHEN v.voucher_type = 'Credit Note' THEN -i.quantity ELSE 0 END) AS qty
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
    WHERE v.voucher_type IN ('Sales', 'Credit Note') AND v.date >= ? AND v.date <= ? GROUP BY m, i.stock_item_id`, [fromAll, asOf]);
  // (3) purchases per item per month (cumulative cost basis is built from these), plus opening stock
  const buys = await all(`
    SELECT i.stock_item_id AS id, substr(v.date, 1, 7) AS m, SUM(i.quantity) AS q, SUM(i.amount) AS a
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
    WHERE v.voucher_type = 'Purchase' AND v.date <= ? GROUP BY i.stock_item_id, m ORDER BY m`, [asOf]);
  const openings = new Map((await all('SELECT id, opening_qty, opening_val, opening_rate FROM stock_items')).map((r) => [r.id, r]));
  const buysBy = new Map();
  for (const b of buys) { if (!buysBy.has(b.id)) buysBy.set(b.id, []); buysBy.get(b.id).push(b); }
  const costAt = (id, mk) => {
    const o = openings.get(id); if (!o) return 0;
    let q = o.opening_qty, v = o.opening_val;
    for (const b of buysBy.get(id) || []) { if (b.m > mk) break; q += b.q; v += b.a; }
    return q > 0 ? v / q : o.opening_rate || 0;
  };

  const out = [];
  for (let k = months - 1; k >= 0; k--) {
    const mm = monthShift(end.y, end.m, -k);
    const mk = `${mm.y}-${pad(mm.m)}`;
    const range = monthRange(mm.y, mm.m);
    const complete = k > 0 || asOf >= range.to;
    const g = (name) => net.get(`${mk}|${name}`) || 0;
    const revenue = g('Sales Accounts'), directInc = g('Direct Incomes'), indirectInc = g('Indirect Incomes'), directExp = -g('Direct Expenses'), indirectExp = -g('Indirect Expenses');
    const cogs = sold.filter((s) => s.m === mk).reduce((t, s) => t + s.qty * costAt(s.id, mk), 0);
    const gross = revenue + directInc - cogs - directExp;
    out.push({ month: mk, complete, sales: r2(revenue), expenses: r2(directExp + indirectExp), gross_profit: r2(gross), net_profit: r2(gross + indirectInc - indirectExp) });
  }
  return out;
}

async function trends(asOf, { metric = 'sales', months = 12 } = {}) {
  const series = await monthlySeries(asOf, months);
  const complete = series.filter((s) => s.complete);
  // drop leading empty months (books not started yet)
  const firstIdx = complete.findIndex((s) => s.sales !== 0 || s.expenses !== 0);
  const usable = firstIdx >= 0 ? complete.slice(firstIdx) : [];
  const ys = usable.map((s) => s[metric]);
  const base = { as_of: asOf, metric, series, complete_months_used: usable.length };
  if (usable.length < 6) {
    return { ...base, forecast: null, note: `Only ${usable.length} complete month(s) of activity. At least 6 are needed for a trend forecast; showing history only.` };
  }
  const f = linearFit(ys);
  const nextN = 3, forecast = [];
  const last = usable[usable.length - 1].month; const ly = Number(last.slice(0, 4)), lm = Number(last.slice(5));
  for (let i = 1; i <= nextN; i++) {
    const mm = monthShift(ly, lm, i); const x = usable.length - 1 + i;
    const pred = f.intercept + f.slope * x; const band = 1.96 * f.sigma * Math.sqrt(1 + 1 / f.n);
    forecast.push({ month: `${mm.y}-${pad(mm.m)}`, predicted: r2(Math.max(metric === 'sales' || metric === 'expenses' ? 0 : -Infinity, pred)), low: r2(pred - band), high: r2(pred + band) });
  }
  const pctPerMonth = f.mean ? r2((f.slope / Math.abs(f.mean)) * 100) : null;
  const strength = f.r2 >= 0.6 ? 'clear' : f.r2 >= 0.3 ? 'weak' : 'no real';
  return { ...base, trend: { slope_per_month: r2(f.slope), pct_of_average_per_month: pctPerMonth, r_squared: r2(f.r2), direction: f.slope > 0 ? 'rising' : f.slope < 0 ? 'falling' : 'flat', strength }, forecast,
    assumptions: ['Straight-line trend (least squares) through complete months only; the current partial month is excluded.',
      'The range is a 95% prediction interval from how far past months strayed from the line. A low R² means the line explains little and the range is wide.',
      'Seasonality, price changes, one-off orders and new customers are not modelled.'] };
}

// ------------------------------------------------------------------ expense comparison & drivers
async function compareExpenses(cur, prev) {
  const a = await expensesByLedger(cur.from, cur.to), b = await expensesByLedger(prev.from, prev.to);
  const map = new Map();
  for (const x of a) map.set(x.ledger_id, { ledger: x.ledger, group: x.group, current: x.amount, previous: 0 });
  for (const x of b) { const e = map.get(x.ledger_id) || { ledger: x.ledger, group: x.group, current: 0, previous: 0 }; e.previous = x.amount; map.set(x.ledger_id, e); }
  const rows = [...map.values()].map((r) => ({ ...r, change: r2(r.current - r.previous), change_pct: r.previous ? r2(((r.current - r.previous) / r.previous) * 100) : null, is_new: r.previous === 0 && r.current > 0 })).sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  const totalCur = r2(a.reduce((s, x) => s + x.amount, 0)), totalPrev = r2(b.reduce((s, x) => s + x.amount, 0));
  const change = r2(totalCur - totalPrev);
  const drivers = rows.filter((r) => (change >= 0 ? r.change > 0 : r.change < 0)).slice(0, 5).map((r) => ({ ...r, share_of_change_pct: change ? r2((r.change / change) * 100) : null }));
  // biggest single vouchers behind the increase (top drivers' largest entries in the current period)
  const detail = [];
  for (const d of drivers.slice(0, 3)) {
    const led = a.find((x) => x.ledger === d.ledger);
    if (!led) continue;
    const v = await all(`SELECT vo.voucher_no, vo.date, vo.narration, e.debit_amount - e.credit_amount AS amount FROM ledger_entries e JOIN vouchers vo ON vo.id = e.voucher_id
                         WHERE e.ledger_id = ? AND vo.date >= ? AND vo.date <= ? ORDER BY ABS(e.debit_amount - e.credit_amount) DESC LIMIT 2`, [led.ledger_id, cur.from, cur.to]);
    detail.push({ ledger: d.ledger, largest_entries: v.map((x) => ({ ...x, amount: r2(x.amount) })) });
  }
  return { current: { ...cur, total: totalCur }, previous: { ...prev, total: totalPrev }, change, change_pct: totalPrev ? r2((change / totalPrev) * 100) : null, rows, drivers, detail };
}

// ------------------------------------------------------------------ cash-flow forecast
const COLLECT_WEIGHTS = [[0, 0.95, 'not yet due'], [30, 0.75, '1–30 days overdue'], [90, 0.4, '31–90 days overdue'], [Infinity, 0, 'over 90 days overdue (treated as unlikely)']];
function collectWeight(daysOver) { if (daysOver <= 0) return COLLECT_WEIGHTS[0]; for (const w of COLLECT_WEIGHTS.slice(1)) if (daysOver <= w[0]) return w; return COLLECT_WEIGHTS[3]; }

async function customerPayDelays() {
  // average days between a bill's due date and the voucher date of money received against it
  const rows = await all(`
    SELECT b.ledger_id, AVG(julianday(v.date) - julianday(n.due_date)) AS delay, COUNT(*) AS n
    FROM bill_allocations b JOIN vouchers v ON v.id = b.voucher_id
    JOIN bill_allocations n ON n.bill_ref = b.bill_ref AND n.ledger_id = b.ledger_id AND n.bill_type = 'New Ref' AND n.due_date IS NOT NULL
    WHERE b.bill_type = 'Agst Ref' AND v.voucher_type = 'Receipt' GROUP BY b.ledger_id`);
  return new Map(rows.map((r) => [r.ledger_id, { delay: Math.round(r.delay), n: r.n }]));
}

async function cashflowForecast(asOf, { days = 30, scenario_factor = 1 } = {}) {
  const horizon = Math.min(90, Math.max(7, parseInt(days, 10) || 30));
  const end = addDays(asOf, horizon);
  const start = await cashPosition(asOf);
  const { receivables, payables } = await getOpenBills();
  const delays = await customerPayDelays();
  const events = [];
  const unlikely = [];
  for (const b of receivables) {
    const d = delays.get(b.ledger_id); const expected = addDays(b.due_date, d ? Math.max(0, d.delay) : 0);
    const overdue = daysBetween(b.due_date, asOf);
    const [, w, bucket] = collectWeight(overdue);
    if (w === 0) { unlikely.push({ party: b.ledger_name, bill: b.bill_ref, amount: b.pending_amount, days_overdue: overdue }); continue; }
    const date = expected < asOf ? addDays(asOf, 7) : expected; // overdue money is assumed to arrive within a week if it arrives at all
    if (date <= end) events.push({ date, kind: 'in', label: `Receipt: ${b.ledger_name} (${b.bill_ref})`, amount: r2(b.pending_amount * w * scenario_factor), basis: `${Math.round(w * 100)}% likely (${bucket})${d ? `, usually pays ${d.delay >= 0 ? d.delay + ' days late' : -d.delay + ' days early'}` : ''}` });
  }
  for (const b of payables) {
    const date = b.due_date < asOf ? addDays(asOf, 3) : b.due_date;
    if (date <= end) events.push({ date, kind: 'out', label: `Payment: ${b.ledger_name} (${b.bill_ref})`, amount: r2(b.pending_amount), basis: 'bill due date (overdue bills assumed paid within 3 days)' });
  }
  const covered = new Set();
  const recurring = await all(`SELECT t.name, t.entries, t.frequency, t.anchor_day, t.next_due, t.end_date FROM recurring_templates t WHERE t.is_active = 1 AND t.next_due IS NOT NULL`);
  const recur = require('./recurring');
  for (const t of recurring) {
    const entries = JSON.parse(t.entries); const amount = entries.reduce((s, e) => s + e.debit_amount, 0);
    const bankLine = entries.find((e) => e.credit_amount > 0); const isOut = !!bankLine;
    entries.forEach((e) => covered.add(e.ledger_id));
    let d = t.next_due;
    while (d <= end) { if (d >= asOf && (!t.end_date || d <= t.end_date)) events.push({ date: d, kind: isOut ? 'out' : 'in', label: `Recurring: ${t.name}`, amount: r2(amount), basis: 'recurring template' }); d = recur.nextDue(d, t.frequency, t.anchor_day); }
  }
  // typical running costs not tied to bills or templates: average of the last 3 full months of expense ledgers paid in cash/bank
  const e3 = { from: monthRange(...Object.values(monthShift(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), -3))).from, to: addDays(`${asOf.slice(0, 7)}-01`, -1) };
  const billLedgers = new Set(payables.map((b) => b.ledger_id));
  const exp3 = (await expensesByLedger(e3.from, e3.to)).filter((x) => !covered.has(x.ledger_id) && !billLedgers.has(x.ledger_id));
  const monthlyRun = r2(exp3.reduce((s, x) => s + x.amount, 0) / 3);
  const weeks = [];
  for (let w = 0; w * 7 < horizon; w++) {
    const ws = addDays(asOf, w * 7 + 1), we = addDays(asOf, Math.min((w + 1) * 7, horizon));
    weeks.push({ from: ws, to: we, inflow: 0, outflow: 0, items: [] });
  }
  for (const ev of events) { const i = Math.min(weeks.length - 1, Math.max(0, Math.floor((daysBetween(asOf, ev.date) - 1) / 7))); const w = weeks[i]; if (ev.kind === 'in') w.inflow += ev.amount; else w.outflow += ev.amount; w.items.push(ev); }
  const runPerWeek = monthlyRun > 0 ? r2((monthlyRun * 12) / 52) : 0;
  let bal = start.total, low = { balance: start.total, date: asOf };
  for (const w of weeks) {
    const span = daysBetween(w.from, w.to) + 1; const run_ = r2(runPerWeek * (span / 7));
    if (run_ > 0) { w.outflow += run_; w.items.push({ date: w.to, kind: 'out', label: 'Typical running costs (average of last 3 months)', amount: run_, basis: 'average, not tied to a bill' }); }
    w.inflow = r2(w.inflow); w.outflow = r2(w.outflow); w.net = r2(w.inflow - w.outflow); bal = r2(bal + w.net); w.closing = bal;
    // keep the detail readable on a large company: the 40 biggest items per week (totals above always include everything)
    w.item_count = w.items.length;
    if (w.items.length > 40) w.items = w.items.sort((x, y) => y.amount - x.amount).slice(0, 40);
    if (bal < low.balance) low = { balance: bal, date: w.to };
  }
  return { as_of: asOf, horizon_days: horizon, scenario: scenario_factor === 1 ? 'expected' : `inflows scaled to ${Math.round(scenario_factor * 100)}%`, opening_balance: start.total, accounts: start.accounts, weeks, closing_balance: bal, lowest_point: low,
    warning: low.balance < 0 ? `Projected balance goes negative (${inr(low.balance)}) around ${low.date}.` : null,
    not_expected: unlikely, running_costs_per_month: monthlyRun,
    assumptions: ['Starts from today\'s cash + bank balances (overdraft counted as negative).',
      `Customer receipts: each open bill is expected on its due date plus how late that customer has usually paid; weighted by likelihood — ${COLLECT_WEIGHTS.slice(0, 3).map((w) => `${w[2]} ${Math.round(w[1] * 100)}%`).join(', ')}; bills over 90 days overdue are excluded.`,
      'Supplier payments: open bills on their due dates. Active recurring templates: on their due dates.',
      'Other running costs: average monthly expense over the last 3 full months for ledgers that have no open bill or recurring template.',
      'Not included: GST/TDS payments, loan repayments, capital expenditure, new sales and purchases not yet invoiced, and seasonal swings.'] };
}

// ------------------------------------------------------------------ health score
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const interp = (x, pts) => { // pts sorted by x ascending: [[x, score], ...]
  if (x <= pts[0][0]) return pts[0][1]; if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); }
};

async function healthScore(asOf) {
  const comps = [];
  const cash = await cashPosition(asOf);
  const { receivables, payables } = await getOpenBills();
  const recvTotal = receivables.reduce((s, b) => s + b.pending_amount, 0), payTotal = payables.reduce((s, b) => s + b.pending_amount, 0);
  const stockVal = (await get(`SELECT COALESCE(SUM(s.opening_val),0) v FROM stock_items s`)).v;
  const lastMonths = [1, 2, 3].map((k) => { const m = monthShift(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), -k); return monthRange(m.y, m.m); });
  const exp3 = [];
  for (const r of lastMonths) exp3.push((await expensesByLedger(r.from, r.to)).reduce((s, x) => s + x.amount, 0));
  const monthlyBurn = exp3.reduce((a, b) => a + b, 0) / 3;
  const add = (key, label, weight, value, unit, score, explain, usable = true) => comps.push({ key, label, weight, value, unit, score: usable ? Math.round(clamp(score)) : null, usable, explain });

  const liquidAssets = cash.total + recvTotal;
  const ratio = payTotal > 0 ? liquidAssets / payTotal : null;
  add('liquidity', 'Liquidity (cash + receivables ÷ payables)', 25, ratio === null ? null : r2(ratio), 'x', ratio === null ? 0 : interp(ratio, [[0, 0], [0.5, 25], [1, 60], [1.5, 85], [2, 100]]),
    ratio === null ? 'No open payables, so the ratio is not meaningful.' : `Cash and receivables cover payables ${r2(ratio)} times. 2× or more scores 100; below 0.5× scores under 25.`, ratio !== null);
  const runway = monthlyBurn > 0 ? cash.total / monthlyBurn : null;
  add('runway', 'Cash runway (months of expenses covered)', 20, runway === null ? null : r2(runway), 'months', runway === null ? 0 : interp(runway, [[0, 0], [0.5, 10], [1, 40], [3, 80], [6, 100]]),
    runway === null ? 'No expenses in the last 3 months to compare against.' : `Cash and bank ${inr(cash.total)} against average monthly expenses ${inr(monthlyBurn)}. 6 months scores 100.`, runway !== null);
  const overdue30 = receivables.filter((b) => daysBetween(b.due_date, asOf) > 30).reduce((s, b) => s + b.pending_amount, 0);
  const shareOver = recvTotal > 0 ? overdue30 / recvTotal : null;
  add('receivables', 'Receivables quality (share over 30 days overdue)', 20, shareOver === null ? null : r2(shareOver * 100), '%', shareOver === null ? 0 : interp(shareOver, [[0, 100], [0.1, 85], [0.3, 40], [0.5, 0]]),
    shareOver === null ? 'No outstanding receivables.' : `${r2(shareOver * 100)}% of ${inr(recvTotal)} receivable is more than 30 days overdue. 0% scores 100; 50% or more scores 0.`, shareOver !== null);
  const profit3 = await periodProfit(lastMonths[2].from, lastMonths[0].to);
  add('profitability', 'Profitability (net margin, last 3 full months)', 20, profit3.net_margin_pct, '%', profit3.net_margin_pct === null ? 0 : interp(profit3.net_margin_pct, [[-10, 0], [0, 40], [5, 70], [15, 100]]),
    profit3.net_margin_pct === null ? 'No sales in the last 3 full months.' : `Net profit ${inr(profit3.net_profit)} on sales ${inr(profit3.revenue)} (${profit3.net_margin_pct}%). 15% or more scores 100; a loss scores below 40.`, profit3.net_margin_pct !== null);
  const dead = await inventory.deadStock({ as_of: asOf, days: 90 });
  const deadShare = stockVal > 0 ? dead.total_value_locked / stockVal : null;
  add('inventory', 'Inventory health (slow/dead stock share)', 10, deadShare === null ? null : r2(Math.min(1, deadShare) * 100), '%', deadShare === null ? 0 : interp(deadShare, [[0, 100], [0.1, 80], [0.3, 0]]),
    deadShare === null ? 'No opening stock value to compare.' : `${inr(dead.total_value_locked)} is in items not sold for 90+ days (≈${r2(deadShare * 100)}% of opening stock value). 0% scores 100; 30% or more scores 0.`, deadShare !== null);
  const unb = await getUnbalancedVouchers();
  add('integrity', 'Books integrity (unbalanced vouchers)', 5, unb.length, 'vouchers', unb.length ? 0 : 100, unb.length ? `${unb.length} voucher(s) where debit ≠ credit.` : 'Every voucher balances.');
  const used = comps.filter((c) => c.usable);
  const wsum = used.reduce((s, c) => s + c.weight, 0);
  const score = wsum ? Math.round(used.reduce((s, c) => s + c.score * c.weight, 0) / wsum) : null;
  return { as_of: asOf, score, band: score === null ? 'not enough data' : score >= 80 ? 'strong' : score >= 60 ? 'good' : score >= 40 ? 'needs attention' : 'at risk', components: comps,
    components_excluded: comps.filter((c) => !c.usable).map((c) => c.label),
    method: 'Weighted average of the components above (weights shown). A component with no data is left out and the remaining weights are rescaled. This is an operational health indicator derived from your books; it is not a credit rating or an audit opinion.' };
}

// ------------------------------------------------------------------ daily summary & recommendations
async function dailySummary(asOf) {
  const today = await salesBreakdown(asOf, asOf);
  const mtd = { from: `${asOf.slice(0, 7)}-01`, to: asOf };
  const pm = monthShift(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), -1); const prevRange = monthRange(pm.y, pm.m);
  const prevSameDays = { from: prevRange.from, to: `${prevRange.from.slice(0, 7)}-${pad(Math.min(Number(asOf.slice(8)), lastOfMonth(pm.y, pm.m)))}` };
  const profitM = await periodProfit(mtd.from, mtd.to);
  const salesM = await salesBreakdown(mtd.from, mtd.to), salesPrev = await salesBreakdown(prevSameDays.from, prevSameDays.to);
  const cash = await cashPosition(asOf);
  const { receivables } = await getOpenBills();
  const overdue = receivables.map((b) => ({ ...b, days: daysBetween(b.due_date, asOf) })).filter((b) => b.days > 0);
  const overdueTotal = r2(overdue.reduce((s, b) => s + b.pending_amount, 0));
  const byCust = new Map(); overdue.forEach((b) => byCust.set(b.ledger_name, (byCust.get(b.ledger_name) || 0) + b.pending_amount));
  const topOverdue = [...byCust.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const reorder = (await inventory.reorderSuggestions({ as_of: asOf })).items.filter((i) => ['out_of_stock', 'reorder_now', 'below_reorder_level'].includes(i.status));
  const tracking = require('./trackingTools');
  const exp = (await tracking.expiring({ days: 30 })).batches;
  const cmp = await compareExpenses(mtd, prevSameDays);
  const pending = (await get(`SELECT COUNT(*) c FROM recurring_drafts WHERE status = 'pending'`)).c;
  const health = await healthScore(asOf);
  const fc = await cashflowForecast(asOf, { days: 30 });
  const staleDays = daysBetween(asOf, new Date().toISOString().slice(0, 10));

  const rec = [];
  const push = (priority, title, because) => rec.push({ priority, title, because });
  if (overdueTotal > 0) push(overdueTotal > cash.total * 0.3 ? 1 : 2, `Chase ${inr(overdueTotal)} of overdue receivables`, `${byCust.size} customer(s) are past due; largest: ${topOverdue.map(([n, a]) => `${n} (${inr(a)})`).join(', ')}.`);
  if (fc.warning) push(1, 'Cash may run short in the next 30 days', fc.warning + ' (see the cash-flow forecast for the week-by-week view).');
  if (reorder.length) push(reorder.some((r) => r.status !== 'below_reorder_level') ? 1 : 2, `Reorder ${reorder.length} item(s)`, reorder.slice(0, 3).map((r) => `${r.name}: ${r.status.replace(/_/g, ' ')}, ${r.current_qty} on hand`).join('; ') + '.');
  if (exp.length) push(exp.some((b) => b.days_to_expiry < 0) ? 1 : 2, `${exp.length} batch(es) expired or expiring within 30 days`, exp.slice(0, 3).map((b) => `${b.item} batch ${b.batch_no} (${b.remaining} units, ${b.days_to_expiry < 0 ? 'expired' : 'expires'} ${b.expiry_date})`).join('; ') + '.');
  if (cmp.change_pct !== null && cmp.change_pct > 20 && cmp.change > 1000) push(2, `Expenses are ${cmp.change_pct}% above the same days last month`, cmp.drivers.slice(0, 2).map((d) => `${d.ledger} ${d.change > 0 ? '+' : ''}${inr(d.change)}`).join(', ') + '.');
  if (pending) push(3, `${pending} recurring voucher(s) waiting for your confirmation`, 'They will not post until you confirm them.');
  if (health.score !== null && health.score < 60) push(2, `Health score is ${health.score} (${health.band})`, health.components.filter((c) => c.usable && c.score < 50).map((c) => c.label).join(', ') + ' pull it down.');
  if (staleDays > 7) push(3, `Your latest entry is ${staleDays} days old`, `The books run to ${asOf}. Figures above reflect what has been entered, not necessarily today's position.`);
  rec.sort((a, b) => a.priority - b.priority);
  return { as_of: asOf, books_age_days: staleDays,
    today: { sales_excl_tax: today.net_sales_excl_tax, invoices: today.invoices }, month_to_date: { sales_excl_tax: salesM.net_sales_excl_tax, net_profit: profitM.net_profit, net_margin_pct: profitM.net_margin_pct, sales_prev_month_same_days: salesPrev.net_sales_excl_tax },
    cash: { total: cash.total, accounts: cash.accounts }, receivables_overdue: { total: overdueTotal, customers: byCust.size },
    low_stock_items: reorder.length, expiring_batches: exp.length, expenses_vs_last_month: { change: cmp.change, change_pct: cmp.change_pct },
    health: { score: health.score, band: health.band }, forecast_30d: { closing_balance: fc.closing_balance, lowest_point: fc.lowest_point, warning: fc.warning },
    recommendations: rec,
    assumptions: ['Everything is computed from your books as at the date shown. Recommendations are rules applied to those numbers (thresholds are visible in each "because"); they are not predictions of customer behaviour.'] };
}

module.exports = { booksDate, parsePeriod, periodProfit, PROFIT_METHOD, expensesByLedger, salesBreakdown, netSoldByItem, cashPosition, trends, compareExpenses, cashflowForecast, healthScore, dailySummary, monthlySeries, linearFit, monthRange, monthShift, addDays, inr, r2, MONTHS };

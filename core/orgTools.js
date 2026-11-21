/**
 * RRE Tally — organisation tools: branches, departments, budgets, customer credit limits, supplier performance.
 *
 * Branches and departments TAG vouchers (they never change a posting, amount or ledger). Untagged vouchers are
 * reported as "Unassigned". Budgets and credit limits only raise alerts; they never block a voucher. Everything here
 * is derived from the company's own books and states its method.
 */
const { run, get, all } = require('./db');
const { getOpenBills, daysBetween } = require('./analytics');
const { logActivity } = require('./auth');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const pad = (n) => String(n).padStart(2, '0');
const validDate = (d) => ISO.test(d || '') && !Number.isNaN(Date.parse(d));
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const booksDate = async (o) => { if (o) { if (!validDate(o)) throw bad('as_of must be YYYY-MM-DD.'); return o; } const r = await get('SELECT MAX(date) d FROM vouchers'); return (r && r.d) || new Date().toISOString().slice(0, 10); };
const EXPENSE_GROUPS = ['Direct Expenses', 'Indirect Expenses'];

// ---------------------------------------------------------------- branches & departments
const KINDS = { branch: { table: 'branches', label: 'Branch' }, department: { table: 'departments', label: 'Department' } };

async function listUnits(kind) {
  const k = KINDS[kind];
  return all(`SELECT x.*, (SELECT COUNT(*) FROM vouchers v WHERE v.${kind}_id = x.id) AS vouchers FROM ${k.table} x ORDER BY x.is_active DESC, x.name`);
}

async function saveUnit(kind, id, b, user) {
  const k = KINDS[kind];
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(code)) throw bad(`${k.label} code must be 1–12 characters: letters, digits, - or _.`);
  if (name.length < 2 || name.length > 60) throw bad(`${k.label} name must be 2–60 characters.`);
  const extra = kind === 'branch' ? [String(b.address || '').slice(0, 150), String(b.state_code || '').slice(0, 2)] : [];
  try {
    if (id) {
      const cur = await get(`SELECT id FROM ${k.table} WHERE id = ?`, [id]);
      if (!cur) throw bad(`${k.label} not found.`, 404);
      if (kind === 'branch') await run('UPDATE branches SET code = ?, name = ?, address = ?, state_code = ? WHERE id = ?', [code, name, ...extra, id]);
      else await run('UPDATE departments SET code = ?, name = ? WHERE id = ?', [code, name, id]);
    } else {
      const r = kind === 'branch'
        ? await run('INSERT INTO branches (code, name, address, state_code) VALUES (?, ?, ?, ?)', [code, name, ...extra])
        : await run('INSERT INTO departments (code, name) VALUES (?, ?)', [code, name]);
      id = r.lastID;
    }
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw bad(`A ${k.label.toLowerCase()} with that code or name already exists.`, 409);
    throw e;
  }
  await logActivity({ user, action: `${k.label.toUpperCase()}_SAVE`, entity: kind, entityId: id, details: { code, name } });
  return get(`SELECT * FROM ${k.table} WHERE id = ?`, [id]);
}

async function setUnitActive(kind, id, active, user) {
  const k = KINDS[kind];
  const r = await run(`UPDATE ${k.table} SET is_active = ? WHERE id = ?`, [active ? 1 : 0, id]);
  if (!r.changes) throw bad(`${k.label} not found.`, 404);
  await logActivity({ user, action: `${k.label.toUpperCase()}_${active ? 'ENABLE' : 'DISABLE'}`, entity: kind, entityId: id });
}

// ---------------------------------------------------------------- tagging vouchers
async function tagVouchers({ voucher_ids, branch_id, department_id, clear }, user) {
  if (!Array.isArray(voucher_ids) || !voucher_ids.length || voucher_ids.length > 5000) throw bad('Provide 1–5000 voucher ids.');
  const ids = [...new Set(voucher_ids.map((x) => parseInt(x, 10)).filter(Boolean))];
  const sets = [], params = [];
  const check = async (table, v, label) => {
    if (v === undefined) return;
    if (v === null) { sets.push(`${label}_id = NULL`); return; }
    const row = await get(`SELECT id, is_active FROM ${table} WHERE id = ?`, [parseInt(v, 10)]);
    if (!row) throw bad(`${label[0].toUpperCase() + label.slice(1)} not found.`, 404);
    if (!row.is_active) throw bad(`That ${label} is switched off.`);
    sets.push(`${label}_id = ?`); params.push(row.id);
  };
  await check('branches', clear ? null : branch_id, 'branch');
  await check('departments', clear ? null : department_id, 'department');
  if (!sets.length) throw bad('Choose a branch and/or a department (or clear).');
  const ph = ids.map(() => '?').join(',');
  const r = await run(`UPDATE vouchers SET ${sets.join(', ')} WHERE id IN (${ph})`, [...params, ...ids]);
  await logActivity({ user, action: 'VOUCHER_TAG', entity: 'voucher', details: { count: r.changes, branch_id: branch_id ?? null, department_id: department_id ?? null, clear: !!clear } });
  return { tagged: r.changes, requested: ids.length };
}

async function setDefaults(username, { branch_id, department_id }) {
  const u = String(username || '');
  const ok = async (table, v) => { if (v === null || v === undefined || v === '') return null; const row = await get(`SELECT id, is_active FROM ${table} WHERE id = ?`, [parseInt(v, 10)]); if (!row || !row.is_active) throw bad('Branch or department not found or switched off.'); return row.id; };
  const b = await ok('branches', branch_id), d = await ok('departments', department_id);
  await run(`INSERT INTO user_org_defaults (username, branch_id, department_id) VALUES (?, ?, ?)
             ON CONFLICT(username) DO UPDATE SET branch_id = excluded.branch_id, department_id = excluded.department_id`, [u, b, d]);
  return { username: u, branch_id: b, department_id: d };
}
async function getDefaults(username) { return (await get('SELECT branch_id, department_id FROM user_org_defaults WHERE username = ?', [String(username || '')])) || { branch_id: null, department_id: null }; }

/** Tags a newly posted voucher with the poster's default branch/department (never overwrites a tag already set). */
async function applyDefaults(username, voucherId) {
  const d = await getDefaults(username);
  if (!d.branch_id && !d.department_id) return;
  await run('UPDATE vouchers SET branch_id = COALESCE(branch_id, ?), department_id = COALESCE(department_id, ?) WHERE id = ?', [d.branch_id, d.department_id, voucherId]);
}

// ---------------------------------------------------------------- expense / branch reports
function rangeOf({ from_date, to_date }) {
  for (const d of [from_date, to_date]) if (d && !validDate(d)) throw bad('Dates must be YYYY-MM-DD.');
  return { from: from_date || '0000-01-01', to: to_date || '9999-12-31' };
}

async function expensesBy(dim, q) {
  if (!['department', 'branch', 'cost_centre'].includes(dim)) throw bad('by must be department, branch or cost_centre.');
  const { from, to } = rangeOf(q);
  const join = dim === 'department' ? 'LEFT JOIN departments x ON x.id = v.department_id'
    : dim === 'branch' ? 'LEFT JOIN branches x ON x.id = v.branch_id' : 'LEFT JOIN cost_centres x ON x.id = e.cost_centre_id';
  const rows = await all(`
    SELECT COALESCE(x.name, 'Unassigned') AS dimension, l.name AS ledger, SUM(e.debit_amount - e.credit_amount) AS amount
    FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id ${join}
    WHERE g.name IN ('Direct Expenses', 'Indirect Expenses') AND v.date >= ? AND v.date <= ?
    GROUP BY dimension, l.id HAVING ABS(amount) > 0.004`, [from, to]);
  const by = new Map();
  for (const r of rows) { const d = by.get(r.dimension) || { dimension: r.dimension, amount: 0, ledgers: [] }; d.amount += r.amount; d.ledgers.push({ ledger: r.ledger, amount: r2(r.amount) }); by.set(r.dimension, d); }
  const out = [...by.values()].map((d) => ({ ...d, amount: r2(d.amount), ledgers: d.ledgers.sort((a, b) => b.amount - a.amount).slice(0, 8) })).sort((a, b) => b.amount - a.amount);
  const total = r2(out.reduce((s, d) => s + d.amount, 0));
  out.forEach((d) => { d.share_pct = total ? r2((d.amount / total) * 100) : 0; });
  return { by: dim, from: from === '0000-01-01' ? null : from, to: to === '9999-12-31' ? null : to, total, rows: out,
    note: 'Expenses = Direct and Indirect Expense ledgers. A voucher without a ' + (dim === 'cost_centre' ? 'cost centre on its line' : dim) + ' is shown as "Unassigned".' };
}

async function branchSummary(q) {
  const { from, to } = rangeOf(q);
  const rows = await all(`
    SELECT COALESCE(b.name, 'Unassigned') AS branch, g.name AS grp, SUM(e.credit_amount - e.debit_amount) AS net
    FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id
    LEFT JOIN branches b ON b.id = v.branch_id
    WHERE g.name IN ('Sales Accounts', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses') AND v.date >= ? AND v.date <= ?
    GROUP BY branch, grp`, [from, to]);
  const m = new Map();
  for (const r of rows) {
    const b = m.get(r.branch) || { branch: r.branch, sales: 0, purchases: 0, expenses: 0 };
    if (r.grp === 'Sales Accounts') b.sales += r.net; else if (r.grp === 'Purchase Accounts') b.purchases += -r.net; else b.expenses += -r.net;
    m.set(r.branch, b);
  }
  const out = [...m.values()].map((b) => ({ branch: b.branch, sales: r2(b.sales), purchases: r2(b.purchases), expenses: r2(b.expenses), surplus: r2(b.sales - b.purchases - b.expenses) })).sort((a, b) => b.sales - a.sales);
  return { from: from === '0000-01-01' ? null : from, to: to === '9999-12-31' ? null : to, rows: out,
    totals: { sales: r2(out.reduce((s, b) => s + b.sales, 0)), purchases: r2(out.reduce((s, b) => s + b.purchases, 0)), expenses: r2(out.reduce((s, b) => s + b.expenses, 0)) },
    note: 'Surplus = sales − purchases − expenses for vouchers tagged to the branch. It is a cash-style indicator that does not adjust for closing stock, so it will differ from the Profit & Loss report.' };
}

// ---------------------------------------------------------------- budgets
function periodBounds(type, start) {
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  if (type === 'month') return { from: start, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  return { from: start, to: addDays(`${y + 1}-${pad(m)}-${start.slice(8, 10)}`, -1) };
}

async function saveBudget(id, b, user) {
  const ledger = await get(`SELECT l.id, l.name, g.name AS grp FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ?`, [parseInt(b.ledger_id, 10)]);
  if (!ledger) throw bad('Ledger not found.', 404);
  if (!EXPENSE_GROUPS.includes(ledger.grp)) throw bad('Budgets can be set on expense ledgers (Direct or Indirect Expenses).');
  if (!['month', 'year'].includes(b.period_type)) throw bad('period_type must be "month" or "year".');
  if (!validDate(b.period_start)) throw bad('period_start must be YYYY-MM-DD.');
  if (b.period_type === 'month' && b.period_start.slice(8) !== '01') throw bad('A monthly budget must start on the 1st of the month.');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e11) throw bad('Amount must be a positive number.');
  const dept = b.department_id ? parseInt(b.department_id, 10) : null, br = b.branch_id ? parseInt(b.branch_id, 10) : null;
  if (dept && !(await get('SELECT id FROM departments WHERE id = ?', [dept]))) throw bad('Department not found.', 404);
  if (br && !(await get('SELECT id FROM branches WHERE id = ?', [br]))) throw bad('Branch not found.', 404);
  try {
    if (id) {
      const r = await run('UPDATE budgets SET ledger_id=?, department_id=?, branch_id=?, period_type=?, period_start=?, amount=?, note=? WHERE id=?', [ledger.id, dept, br, b.period_type, b.period_start, r2(amount), String(b.note || '').slice(0, 200), id]);
      if (!r.changes) throw bad('Budget not found.', 404);
    } else {
      const r = await run('INSERT INTO budgets (ledger_id, department_id, branch_id, period_type, period_start, amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [ledger.id, dept, br, b.period_type, b.period_start, r2(amount), String(b.note || '').slice(0, 200), user?.username || 'unknown']);
      id = r.lastID;
    }
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw bad('A budget for that ledger, department, branch and period already exists. Edit it instead.', 409);
    throw e;
  }
  await logActivity({ user, action: 'BUDGET_SAVE', entity: 'budget', entityId: id, details: { ledger: ledger.name, amount: r2(amount), period: `${b.period_type} ${b.period_start}` } });
  return get('SELECT * FROM budgets WHERE id = ?', [id]);
}

async function deleteBudget(id, user) {
  const r = await run('DELETE FROM budgets WHERE id = ?', [id]);
  if (!r.changes) throw bad('Budget not found.', 404);
  await logActivity({ user, action: 'BUDGET_DELETE', entity: 'budget', entityId: id });
}

async function budgetStatus(asOfIn) {
  const asOf = await booksDate(asOfIn);
  const rows = await all(`
    SELECT b.*, l.name AS ledger, d.name AS department, br.name AS branch
    FROM budgets b JOIN ledgers l ON l.id = b.ledger_id LEFT JOIN departments d ON d.id = b.department_id LEFT JOIN branches br ON br.id = b.branch_id
    ORDER BY b.period_start DESC, l.name`);
  const out = [];
  for (const b of rows) {
    const { from, to } = periodBounds(b.period_type, b.period_start);
    if (from > asOf) { out.push({ ...b, from, to, actual: 0, remaining: b.amount, pct_used: 0, projected: null, status: 'not_started' }); continue; }
    const upTo = asOf < to ? asOf : to;
    const params = [b.ledger_id, from, upTo]; let extra = '';
    if (b.department_id) { extra += ' AND v.department_id = ?'; params.push(b.department_id); }
    if (b.branch_id) { extra += ' AND v.branch_id = ?'; params.push(b.branch_id); }
    const actual = r2((await get(`SELECT COALESCE(SUM(e.debit_amount - e.credit_amount), 0) s FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? AND v.date >= ? AND v.date <= ?${extra}`, params)).s);
    const total = daysBetween(from, to) + 1, elapsed = Math.min(total, daysBetween(from, upTo) + 1);
    const complete = asOf >= to;
    const projected = complete ? actual : (elapsed >= 7 ? r2((actual / elapsed) * total) : null);
    const pct = r2((actual / b.amount) * 100);
    let status = 'ok';
    if (actual > b.amount) status = 'over';
    else if (pct >= 80) status = 'near';
    else if (projected !== null && !complete && projected > b.amount * 1.05) status = 'on_track_to_exceed';
    out.push({ ...b, from, to, actual, remaining: r2(b.amount - actual), pct_used: pct, projected, status, period_complete: complete });
  }
  return { as_of: asOf, budgets: out,
    method: 'Actual = debits less credits on the ledger within the period (limited to the department/branch when the budget names one). Projected = actual so far ÷ days elapsed × days in period (shown once 7 days have passed). "near" = 80% or more used; "over" = actual exceeds the budget.' };
}

async function getBudgetAlerts(asOf) {
  const out = [];
  const st = await budgetStatus(asOf);
  const active = st.budgets.filter((b) => ['over', 'near', 'on_track_to_exceed'].includes(b.status) && !b.period_complete).sort((a, b) => b.pct_used - a.pct_used);
  for (const b of active.slice(0, 15)) {
    const scope = [b.department && `dept ${b.department}`, b.branch && `branch ${b.branch}`].filter(Boolean).join(', ');
    out.push({ key: `budget:${b.id}`, type: 'budget', severity: b.status === 'over' ? 'critical' : 'warning',
      title: `${b.status === 'over' ? 'Over budget' : b.status === 'near' ? 'Budget nearly used' : 'On track to exceed budget'}: ${b.ledger}${scope ? ' (' + scope + ')' : ''}`,
      message: `₹${b.actual.toLocaleString('en-IN')} of ₹${b.amount.toLocaleString('en-IN')} used (${b.pct_used}%) for ${b.period_type} starting ${b.period_start}.` + (b.projected && b.status === 'on_track_to_exceed' ? ` At this pace it will reach ₹${b.projected.toLocaleString('en-IN')}.` : ''), view: null });
  }
  return out;
}

// ---------------------------------------------------------------- credit limits
async function setCreditLimit(ledgerId, limit, user) {
  const l = await get(`SELECT l.id, l.name, g.name AS grp FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ?`, [ledgerId]);
  if (!l) throw bad('Ledger not found.', 404);
  if (l.grp !== 'Sundry Debtors') throw bad('Credit limits apply to customers (Sundry Debtors).');
  const v = Number(limit);
  if (limit === null || limit === undefined || limit === '' || typeof limit === 'boolean' || !Number.isFinite(v) || v < 0 || v > 1e11) throw bad('credit_limit must be a number ≥ 0 (0 removes the limit).');
  await run('UPDATE ledgers SET credit_limit = ? WHERE id = ?', [r2(v), ledgerId]);
  await logActivity({ user, action: 'CREDIT_LIMIT_SET', entity: 'ledger', entityId: ledgerId, details: { name: l.name, limit: r2(v) } });
  return { ledger_id: ledgerId, credit_limit: r2(v) };
}

async function exposures(onlyLimited = true) {
  const rows = await all(`
    SELECT l.id, l.name, l.credit_limit, l.opening_balance, l.opening_balance_type,
      COALESCE((SELECT SUM(e.debit_amount - e.credit_amount) FROM ledger_entries e WHERE e.ledger_id = l.id), 0) AS mv
    FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Sundry Debtors' ${onlyLimited ? 'AND l.credit_limit > 0' : ''}`);
  return rows.map((r) => {
    const balance = r2((r.opening_balance_type === 'Cr' ? -r.opening_balance : r.opening_balance) + r.mv);
    const used = r.credit_limit > 0 ? r2((balance / r.credit_limit) * 100) : null;
    return { ledger_id: r.id, customer: r.name, credit_limit: r.credit_limit, balance, available: r.credit_limit > 0 ? r2(r.credit_limit - balance) : null, pct_used: used,
      status: r.credit_limit <= 0 ? 'no_limit' : balance > r.credit_limit ? 'over' : used >= 90 ? 'near' : 'ok' };
  }).sort((a, b) => (b.pct_used ?? -1) - (a.pct_used ?? -1));
}

async function creditStatus(asOfIn) {
  const asOf = await booksDate(asOfIn);
  const list = await exposures(true);
  const { receivables } = await getOpenBills();
  const overdue = new Map();
  for (const b of receivables) { const d = daysBetween(b.due_date, asOf); if (d > 0) overdue.set(b.ledger_id, r2((overdue.get(b.ledger_id) || 0) + b.pending_amount)); }
  return { as_of: asOf, customers: list.map((c) => ({ ...c, overdue: overdue.get(c.ledger_id) || 0 })),
    method: 'Balance = the customer\'s ledger balance (opening + all vouchers), i.e. what they owe including unbilled receipts not yet matched to bills. A limit only raises alerts; it never blocks a sale.' };
}

async function creditCheck(ledgerId, amount) {
  const l = await get('SELECT id, name, credit_limit FROM ledgers WHERE id = ?', [ledgerId]);
  if (!l) throw bad('Ledger not found.', 404);
  if (!(l.credit_limit > 0)) return { limit: 0, would_exceed: false, message: 'No credit limit is set for this customer.' };
  const e = (await exposures(true)).find((x) => x.ledger_id === l.id);
  const add = Number(amount) || 0;
  const after = r2(e.balance + add);
  return { customer: l.name, limit: l.credit_limit, balance: e.balance, adding: add, balance_after: after, would_exceed: after > l.credit_limit, already_over: e.balance > l.credit_limit, pct_used: e.pct_used,
    message: after > l.credit_limit ? `${l.name} would be ₹${r2(after - l.credit_limit).toLocaleString('en-IN')} over the credit limit of ₹${l.credit_limit.toLocaleString('en-IN')}.` : `Within the credit limit (₹${r2(l.credit_limit - after).toLocaleString('en-IN')} available).` };
}

async function getCreditAlerts() {
  const list = (await exposures(true)).filter((c) => c.status === 'over' || c.status === 'near');
  const out = list.slice(0, 20).map((c) => ({ key: `credit:${c.ledger_id}`, type: 'credit_limit', severity: c.status === 'over' ? 'critical' : 'warning',
    title: `${c.status === 'over' ? 'Over credit limit' : 'Near credit limit'}: ${c.customer}`,
    message: `Owes ₹${c.balance.toLocaleString('en-IN')} against a limit of ₹${c.credit_limit.toLocaleString('en-IN')} (${c.pct_used}%).`, view: 'view-outstandings' }));
  if (list.length > 20) out.push({ key: 'credit:more', type: 'credit_limit', severity: 'info', title: `${list.length - 20} more customer(s) near or over their credit limit`, message: 'Open Credit limits for the full list.', view: null });
  return out;
}

// ---------------------------------------------------------------- supplier performance
const interp = (x, pts) => { if (x <= pts[0][0]) return pts[0][1]; if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]; for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); } };

async function supplierPerformance(q = {}) {
  const asOf = await booksDate(q.as_of);
  let from = q.from_date, to = q.to_date || asOf;
  if (from && !validDate(from)) throw bad('from_date must be YYYY-MM-DD.');
  if (!validDate(to)) throw bad('to_date must be YYYY-MM-DD.');
  if (!from) from = addDays(to, -364);
  const lines = await all(`
    SELECT v.party_ledger_id AS sid, p.name AS supplier, v.date, v.voucher_type, i.stock_item_id AS item, s.name AS item_name, i.quantity AS qty, i.rate, i.amount
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN ledgers p ON p.id = v.party_ledger_id JOIN stock_items s ON s.id = i.stock_item_id
    WHERE v.voucher_type = 'Purchase' AND v.date >= ? AND v.date <= ? ORDER BY v.date, v.id`, [from, to]);
  const totals = await all(`
    SELECT v.party_ledger_id AS sid, p.name AS supplier,
      SUM(CASE WHEN v.voucher_type = 'Purchase' THEN v.total_amount ELSE 0 END) AS purchases,
      SUM(CASE WHEN v.voucher_type = 'Debit Note' THEN v.total_amount ELSE 0 END) AS returns,
      SUM(CASE WHEN v.voucher_type = 'Purchase' THEN 1 ELSE 0 END) AS bills
    FROM vouchers v JOIN ledgers p ON p.id = v.party_ledger_id JOIN account_groups g ON g.id = p.group_id
    WHERE v.voucher_type IN ('Purchase', 'Debit Note') AND g.name = 'Sundry Creditors' AND v.date >= ? AND v.date <= ? GROUP BY v.party_ledger_id`, [from, to]);
  // best (lowest) average rate per item across all suppliers in the period
  const itemSup = new Map();
  for (const l of lines) { const k = `${l.item}|${l.sid}`; const e = itemSup.get(k) || { item: l.item, sid: l.sid, name: l.item_name, qty: 0, amt: 0, first: null, last: null }; e.qty += l.qty; e.amt += l.amount; if (e.first === null) e.first = l.rate; e.last = l.rate; itemSup.set(k, e); }
  const bestRate = new Map();
  for (const e of itemSup.values()) { const avg = e.amt / e.qty; if (!bestRate.has(e.item) || avg < bestRate.get(e.item)) bestRate.set(e.item, avg); }
  const itemsBySup = new Map();
  for (const e of itemSup.values()) { if (!itemsBySup.has(e.sid)) itemsBySup.set(e.sid, []); itemsBySup.get(e.sid).push(e); }
  // payment behaviour: days between bill date and the payment settling it
  const pay = await all(`
    SELECT b.ledger_id AS sid, AVG(julianday(pv.date) - julianday(nv.date)) AS days, COUNT(*) AS n
    FROM bill_allocations b JOIN vouchers pv ON pv.id = b.voucher_id
    JOIN bill_allocations n ON n.bill_ref = b.bill_ref AND n.ledger_id = b.ledger_id AND n.bill_type = 'New Ref' JOIN vouchers nv ON nv.id = n.voucher_id
    WHERE b.bill_type = 'Agst Ref' AND pv.voucher_type = 'Payment' GROUP BY b.ledger_id`);
  const payBy = new Map(pay.map((p) => [p.sid, { days: Math.round(p.days), n: p.n }]));
  const { payables } = await getOpenBills();
  const owed = new Map(); for (const b of payables) owed.set(b.ledger_id, r2((owed.get(b.ledger_id) || 0) + b.pending_amount));
  const spendAll = totals.reduce((s, t) => s + t.purchases, 0);

  const rows = totals.filter((t) => t.purchases > 0 || t.returns > 0).map((t) => {
    const items = itemsBySup.get(t.sid) || [];
    const spend = items.reduce((s, e) => s + e.amt, 0);
    let premiumW = 0, riseW = 0, compared = 0;
    for (const e of items) {
      const avg = e.amt / e.qty, best = bestRate.get(e.item);
      const competing = [...itemSup.values()].filter((x) => x.item === e.item).length > 1;
      if (competing && best > 0) { premiumW += ((avg - best) / best) * e.amt; compared += e.amt; }
      if (e.first > 0) riseW += Math.max(0, (e.last - e.first) / e.first) * e.amt;
    }
    const premium = compared > 0 ? (premiumW / compared) * 100 : null;
    const rise = spend > 0 ? (riseW / spend) * 100 : null;
    const returnPct = t.purchases > 0 ? (t.returns / t.purchases) * 100 : null;
    const comps = [
      { key: 'price', label: 'Price vs best rate paid to other suppliers', weight: 40, value: premium === null ? null : r2(premium), unit: '% above best', score: premium === null ? null : Math.round(interp(Math.max(0, premium), [[0, 100], [10, 60], [25, 0]])) },
      { key: 'returns', label: 'Goods returned (Debit Notes ÷ purchases)', weight: 30, value: returnPct === null ? null : r2(returnPct), unit: '%', score: returnPct === null ? null : Math.round(interp(returnPct, [[0, 100], [5, 60], [15, 0]])) },
      { key: 'stability', label: 'Price rise from first to last purchase', weight: 30, value: rise === null ? null : r2(rise), unit: '%', score: rise === null ? null : Math.round(interp(rise, [[0, 100], [2, 100], [10, 50], [25, 0]])) }
    ];
    const used = comps.filter((c) => c.score !== null), ws = used.reduce((s, c) => s + c.weight, 0);
    const score = ws ? Math.round(used.reduce((s, c) => s + c.score * c.weight, 0) / ws) : null;
    return { supplier_id: t.sid, supplier: t.supplier, purchases: r2(t.purchases), returns: r2(t.returns), bills: t.bills, share_of_spend_pct: spendAll ? r2((t.purchases / spendAll) * 100) : 0,
      avg_bill: t.bills ? r2(t.purchases / t.bills) : 0, avg_days_to_pay: payBy.has(t.sid) ? payBy.get(t.sid).days : null, owed_now: owed.get(t.sid) || 0, score, band: score === null ? 'not enough data' : score >= 80 ? 'strong' : score >= 60 ? 'acceptable' : 'review', components: comps };
  }).sort((a, b) => b.purchases - a.purchases);
  return { from, to, suppliers: rows, total_purchases: r2(spendAll),
    method: 'Score = weighted average of the components shown (a component with no data is left out and the rest rescaled). "Price" compares each item\'s average rate with the lowest average rate any supplier charged in the period, so it needs an item bought from at least two suppliers. The books hold no purchase orders or delivery dates, so delivery timeliness and quality are not measured.' };
}

module.exports = { listUnits, saveUnit, setUnitActive, tagVouchers, setDefaults, getDefaults, applyDefaults, expensesBy, branchSummary, saveBudget, deleteBudget, budgetStatus, getBudgetAlerts,
  setCreditLimit, creditStatus, creditCheck, getCreditAlerts, supplierPerformance, exposures };

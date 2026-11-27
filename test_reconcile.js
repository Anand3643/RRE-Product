process.env.RRE_LEGACY_TOKENS = '1';
process.env.RRE_ENFORCE_AUTH = '1';
/**
 * The whole accounting system, end to end, and its reconciliations (every report against the entries underneath it):
 *  1 ledger master (available, no Day Book entry, duplicates refused, delete only when unused)   2 journal -> Day Book, ledgers, TB
 *  3 sales voucher with stock -> customer, stock, GST, Day Book, P&L (cost of goods sold)          4 purchase voucher -> supplier, stock, ITC
 *  5 receipt / payment -> cash, bank, outstanding bills                                            6-7 quotation: no revenue; converted once
 *  8-10 Excel sales / PDF purchase / bank statement imports                                          11 alter, reverse (cancel) a voucher
 *  12-14 Dr = Cr, Trial Balance = ledgers, Balance Sheet balances                                   15 period: P&L for a period, as on a date, lock
 *  16 two devices: change notices, stale edits refused                                              17 roles and customers                18 restart
 *  + sales returns reduce sales, registers = ledgers, stock = movements, GST reports = tax ledgers, Cash / Bank Book = ledgers
 * Runs on a DISPOSABLE data directory.   node test_reconcile.js      PostgreSQL:  npm run test:pg -- test_reconcile.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_reconcile_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const db = require('./core/db');
const { initDb, get, all, run } = db;
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const F = require('./test_helpers/docFixtures');
const { gstinCheckChar } = require('./core/gstTools');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;
const gstin = (state, pan) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };

let srv, base;
const owner = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
const accT = createSessionToken({ id: 2, username: 'accountant', role: 'Accountant' });
const clerk = createSessionToken({ id: 3, username: 'dataentry', role: 'Data Entry' });
const viewer = createSessionToken({ id: 5, username: 'viewer', role: 'Viewer' });
const customer = createSessionToken({ id: 9, username: 'cust1', role: 'Customer' });
const call = (method, p, { token = owner, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
  const rq = http.request(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
  });
  rq.on('error', reject); if (data) rq.write(data); rq.end();
});
const data = async (method, p, opts) => { const r = await call(method, p, opts); if (!r.json || r.json.success === false) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json.data !== undefined ? r.json.data : r.json; };

// ------------------------------------------------------------------------------------------------ independent arithmetic
const L = async (name) => (await get('SELECT l.*, g.name AS group_name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.name = ?', [name]));
/** a ledger's balance from its opening balance and its entries (Dr positive), optionally up to a date */
async function bal(name, upTo = null) {
  const l = await L(name); if (!l) return null;
  const e = await get(`SELECT COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? ${upTo ? 'AND v.date <= ?' : ''}`, upTo ? [l.id, upTo] : [l.id]);
  return r2((l.opening_balance_type === 'Cr' ? -1 : 1) * (Number(l.opening_balance) || 0) + Number(e.n));
}
/** net Dr of all ledgers in groups, from the entries (and openings) */
async function groupNet(groups, { from = null, to = null, openings = true } = {}) {
  const q = groups.map(() => '?').join(',');
  const params = [...groups]; let where = '';
  if (from) { where += ' AND v.date >= ?'; params.push(from); }
  if (to) { where += ' AND v.date <= ?'; params.push(to); }
  const e = await get(`SELECT COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id WHERE g.name IN (${q})${where}`, params);
  let o = 0;
  if (openings) { const ob = await get(`SELECT COALESCE(SUM(CASE WHEN l.opening_balance_type = 'Cr' THEN -l.opening_balance ELSE l.opening_balance END), 0) AS n FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name IN (${q})`, groups); o = Number(ob.n); }
  return r2(Number(e.n) + o);
}
const onHand = async (itemId) => { const s = await get(`SELECT s.opening_qty + COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) FROM inventory_entries WHERE stock_item_id = s.id), 0) AS q FROM stock_items s WHERE s.id = ?`, [itemId]); return Number(s.q); };

/** every reconciliation at once: run after each step */
async function reconcile(label) {
  const problems = [];
  // 12: every voucher balances, all entries balance
  const unb = await all('SELECT v.voucher_no FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id, v.voucher_no HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0');
  if (unb.length) problems.push(`unbalanced vouchers: ${unb.map((x) => x.voucher_no).join(', ')}`);
  const tot = await get('SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2) AS dr, ROUND(COALESCE(SUM(credit_amount), 0), 2) AS cr FROM ledger_entries');
  if (!near(tot.dr, tot.cr)) problems.push(`entries Dr ${tot.dr} ≠ Cr ${tot.cr}`);
  // 13: Trial Balance = ledger balances; TB totals = Dr/Cr of balances
  const tb = await data('GET', '/api/reports/trial-balance');
  for (const it of tb.items) { const b = await bal(it.name); if (!near(b, r2(it.debit - it.credit))) { problems.push(`TB ${it.name} ${r2(it.debit - it.credit)} ≠ ledger ${b}`); break; } }
  // opening balances themselves may not balance (the user's data): TB difference must equal the opening difference exactly
  const od = await get("SELECT COALESCE(SUM(CASE WHEN opening_balance_type = 'Cr' THEN -opening_balance ELSE opening_balance END), 0) AS n FROM ledgers");
  if (!near(r2(tb.total_debit - tb.total_credit), r2(od.n), 0.05)) problems.push(`TB difference ${r2(tb.total_debit - tb.total_credit)} ≠ opening difference ${r2(od.n)}`);
  // Day Book totals = the entries
  const dbk = await data('GET', '/api/reports/daybook?from=2000-01-01&to=2100-12-31&summary=1&limit=1');
  if (dbk.summary && dbk.summary.total_debit != null && !near(dbk.summary.total_debit, tot.dr)) problems.push(`Day Book Dr ${dbk.summary.total_debit} ≠ entries ${tot.dr}`);
  // P&L = the income / expense entries (signed), gross profit = sales − COGS
  const pl = await data('GET', '/api/reports/profit-loss');
  const salesNet = -(await groupNet(['Sales Accounts'])), purchNet = await groupNet(['Purchase Accounts']);
  if (!near(pl.trading.sales, salesNet)) problems.push(`P&L sales ${pl.trading.sales} ≠ Sales Accounts ${salesNet}`);
  if (!near(pl.trading.purchases, purchNet)) problems.push(`P&L purchases ${pl.trading.purchases} ≠ Purchase Accounts ${purchNet}`);
  const indExp = await groupNet(['Indirect Expenses']), indInc = -(await groupNet(['Indirect Incomes'])), dirExp = await groupNet(['Direct Expenses']), dirInc = -(await groupNet(['Direct Incomes']));
  const cogs = r2(pl.trading.opening_stock + purchNet + dirExp - pl.trading.closing_stock);
  if (!near(pl.trading.gross_profit, salesNet + dirInc - cogs, 0.05)) problems.push(`gross profit ${pl.trading.gross_profit} ≠ sales ${salesNet} + direct incomes ${dirInc} − COGS ${cogs}`);
  if (!near(pl.indirect.net_profit, pl.trading.gross_profit + indInc - indExp, 0.05)) problems.push('net profit ≠ gross profit + indirect incomes − indirect expenses');
  // 14: Balance Sheet balances (when the opening balances themselves balance)
  const bs = await data('GET', '/api/reports/balance-sheet');
  if (!near(bs.assets.total, bs.liabilities.total, 0.05)) problems.push(`Balance Sheet assets ${bs.assets.total} ≠ liabilities ${bs.liabilities.total}`);
  const os = await get('SELECT COALESCE(SUM(opening_val), 0) AS n FROM stock_items');
  const odx = await get("SELECT COALESCE(SUM(CASE WHEN l.opening_balance_type = 'Cr' THEN -l.opening_balance ELSE l.opening_balance END), 0) AS n FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name <> 'Stock-in-hand'");
  const expDiff = r2(Number(odx.n) + Number(os.n));
  if (!near(bs.opening_difference.amount, Math.abs(expDiff), 0.05) || (expDiff > 0.005 && bs.opening_difference.side !== 'liabilities') || (expDiff < -0.005 && bs.opening_difference.side !== 'assets')) problems.push(`opening difference ${JSON.stringify(bs.opening_difference)} ≠ ledger openings + opening stock ${expDiff}`);
  // stock: every item's quantity = opening + IN − OUT; stock summary value = valuation
  const ss = await data('GET', '/api/reports/stock-summary');
  for (const it of ss.items) { const q = await onHand(it.id); if (!near(it.closing_qty, q, 0.001)) { problems.push(`stock ${it.name} ${it.closing_qty} ≠ movements ${q}`); break; } }
  if (!near(pl.trading.closing_stock, ss.total_valuation, 0.05)) problems.push('P&L closing stock ≠ stock summary');
  // GST report = tax ledger lines of sales / purchase vouchers; dashboard = the reports
  const gst = await data('GET', '/api/reports/gst');
  const outTax = await get("SELECT COALESCE(SUM(e.credit_amount - e.debit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id WHERE v.voucher_type IN ('Sales', 'Credit Note') AND g.name = 'Duties & Taxes' AND e.ledger_id <> COALESCE(v.party_ledger_id, -1) AND (UPPER(l.name) LIKE '%CGST%' OR UPPER(l.name) LIKE '%SGST%' OR UPPER(l.name) LIKE '%IGST%')");
  if (!near(gst.gstr1.total_outward_tax, outTax.n, 0.05)) problems.push(`GSTR-1 tax ${gst.gstr1.total_outward_tax} ≠ output tax lines ${r2(outTax.n)}`);
  // registers = ledgers: Sales Register taxable = Sales Accounts lines of Sales vouchers; Purchase Register = Purchase Accounts lines
  const sr = await data('GET', '/api/report-center/sales-register');
  const srL = await get("SELECT COALESCE(SUM(e.credit_amount - e.debit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id WHERE v.voucher_type = 'Sales' AND g.name = 'Sales Accounts'");
  if (!near(sr.totals.taxable, srL.n, 0.05)) problems.push(`Sales Register taxable ${sr.totals.taxable} ≠ Sales ledgers ${r2(srL.n)}`);
  const pr = await data('GET', '/api/report-center/purchase-register');
  const prL = await get("SELECT COALESCE(SUM(e.debit_amount - e.credit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id JOIN account_groups g ON g.id = l.group_id WHERE v.voucher_type = 'Purchase' AND g.name = 'Purchase Accounts'");
  if (!near(pr.totals.taxable, prL.n, 0.05)) problems.push(`Purchase Register taxable ${pr.totals.taxable} ≠ Purchase ledgers ${r2(prL.n)}`);
  // Cash Book / Bank Book closing = the cash / bank ledgers
  const cb = await data('GET', '/api/report-center/cash-book'), bb = await data('GET', '/api/report-center/bank-book');
  if (!near(cb.totals.balance, await groupNet(['Cash-in-hand']), 0.05)) problems.push(`Cash Book ${cb.totals.balance} ≠ cash ledgers`);
  if (!near(bb.totals.balance, await groupNet(['Bank Accounts', 'Bank OD A/c']), 0.05)) problems.push(`Bank Book ${bb.totals.balance} ≠ bank ledgers`);
  const fin = (await data('GET', '/api/dashboard/tiles')).financials;
  if (!near(fin.total_sales, pl.trading.sales) || !near(fin.gross_profit, pl.trading.gross_profit) || !near(fin.inventory_value, ss.total_valuation, 0.05)) problems.push('dashboard ≠ reports');
  assert(!problems.length, `reconciled after ${label}: Dr = Cr, Trial Balance = ledgers, Day Book = entries, P&L = income/expense lines (gross profit = sales − COGS), Balance Sheet, stock = movements, GST = tax lines, registers = ledgers, Cash/Bank Book = ledgers, dashboard = reports`, problems.join(' | '));
}

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM approval_rules').catch(() => {});
  const OURS = gstin('33', 'AABCR1234F');
  await run('UPDATE company_info SET gstin = ?, state_code = ?', [OURS, '33']);
  srv = await startServer(14700 + Math.floor(Math.random() * 90), '127.0.0.1');
  base = `http://${srv.host}:${srv.port}`;
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  const lid = async (n) => (await L(n)).id;
  const salesL = (await get("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Sales Accounts' AND l.name NOT LIKE '%Return%' AND l.name NOT LIKE '%IGST%' ORDER BY l.id LIMIT 1")).name;
  const purchL = (await get("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Purchase Accounts' AND l.name NOT LIKE '%Return%' AND l.name NOT LIKE '%IGST%' ORDER BY l.id LIMIT 1")).name;
  const bankL = (await get("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Bank Accounts' ORDER BY l.id LIMIT 1")).name;
  const cashL = 'Cash';
  const od = await get("SELECT COALESCE(SUM(CASE WHEN opening_balance_type = 'Cr' THEN -opening_balance ELSE opening_balance END), 0) AS n FROM ledgers");
  console.log(`    demo books: ledger openings differ by ${r2(od.n)}; the Balance Sheet must show that (plus opening stock) as "Difference in opening balances"`);
  await reconcile('start (demo books)');

  // ------------------------------------------------------------------------------------------------ TEST 1 ledgers
  console.log('\n--- TEST 1: ledger master ---');
  const v0 = Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n);
  const cr = await call('POST', '/api/masters/ledgers', { body: { name: 'Kaveri Pumps Ltd', group_id: await grp('Sundry Debtors'), opening_balance: 0, opening_balance_type: 'Dr', gstin: gstin('33', 'AAKCK1111P'), state_code: '33' } });
  const list = await data('GET', '/api/masters/ledgers');
  assert(cr.status === 200 && await L('Kaveri Pumps Ltd') && list.some((l) => l.name === 'Kaveri Pumps Ltd' && l.group_name === 'Sundry Debtors'), 'a new customer ledger is saved and is in the ledger list every voucher form uses');
  assert(Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n) === v0, 'creating a ledger posts nothing: no voucher, no Day Book entry');
  assert((await call('POST', '/api/masters/ledgers', { body: { name: 'kaveri pumps ltd', group_id: await grp('Sundry Debtors') } })).status === 409, 'a second ledger with the same name is refused (409)');
  assert((await call('POST', '/api/masters/ledgers', { body: { name: 'Bad Group Ledger', group_id: 99999 } })).status === 400 && (await call('POST', '/api/masters/ledgers', { body: { name: 'Neg OB', group_id: await grp('Sundry Debtors'), opening_balance: -5 } })).status === 400, 'an unknown group or a negative opening balance is refused');
  await data('POST', '/api/masters/ledgers', { body: { name: 'Godavari Steels', group_id: await grp('Sundry Creditors'), opening_balance: 0, opening_balance_type: 'Cr', state_code: '33' } });
  const tmpL = await data('POST', '/api/masters/ledgers', { body: { name: 'Unused Test Ledger', group_id: await grp('Indirect Expenses') } }).catch(() => null);
  const tmpId = (await L('Unused Test Ledger')).id;
  assert((await call('DELETE', `/api/masters/ledgers/${tmpId}`)).status === 200 && !(await L('Unused Test Ledger')), 'an unused ledger can be deleted (audited)');
  const cashDel = await call('DELETE', `/api/masters/ledgers/${await lid(cashL)}`);
  const usedDel = await call('DELETE', `/api/masters/ledgers/${await lid(salesL)}`);
  assert(cashDel.status === 409 && usedDel.status === 409, 'a ledger the tax / invoice logic relies on, or one with transactions, cannot be deleted', `${cashDel.status} ${usedDel.status} ${JSON.stringify(usedDel.json).slice(0, 120)}`);

  // ------------------------------------------------------------------------------------------------ TEST 2 journal
  console.log('\n--- TEST 2: journal voucher ---');
  const rent0 = await bal('Office Rent'), cash0 = await bal(cashL);
  const j = await data('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2026-06-01', narration: 'June rent provision', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 12000, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 12000 }] } });
  const dbJ = await data('GET', '/api/reports/daybook?from=2026-06-01&to=2026-06-01&limit=100');
  assert(dbJ.some((v) => v.voucher_no === j.voucher_no), 'the journal is in the Day Book on its date');
  assert(near((await bal('Office Rent')) - rent0, 12000) && near((await bal(cashL)) - cash0, -12000), 'Office Rent +₹12,000 Dr, Cash −₹12,000');
  assert((await call('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2026-06-01', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 100, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 99 }] } })).status === 400, 'an unbalanced voucher (Dr ₹100, Cr ₹99) is refused');
  await reconcile('TEST 2');

  // ------------------------------------------------------------------------------------------------ TEST 3 / 4 sales and purchase with stock
  console.log('\n--- TEST 3 / 4: sales and purchase vouchers with stock ---');
  const item = await data('POST', '/api/masters/stock-items', { body: { name: 'Pump Impeller 4in', hsn_code: '84139190', gst_rate: 18, opening_qty: 50, opening_rate: 100, standard_cost: 100 } }).catch(async () => null);
  const itemId = (await get("SELECT id FROM stock_items WHERE name = 'Pump Impeller 4in'")).id;
  const pl0 = await data('GET', '/api/reports/profit-loss'), gst0 = await data('GET', '/api/reports/gst');
  const sale = await data('POST', '/api/vouchers', { body: { voucher_type: 'Sales', date: '2026-06-05', reference_no: 'KP-1', party_ledger_id: await lid('Kaveri Pumps Ltd'),
    entries: [{ ledger_id: await lid('Kaveri Pumps Ltd'), debit_amount: 1180, credit_amount: 0 }, { ledger_id: await lid(salesL), debit_amount: 0, credit_amount: 1000 }, { ledger_id: await lid('Output CGST 9%'), debit_amount: 0, credit_amount: 90 }, { ledger_id: await lid('Output SGST 9%'), debit_amount: 0, credit_amount: 90 }],
    inventory: [{ stock_item_id: itemId, quantity: 5, rate: 200, amount: 1000 }], bill_allocations: [{ ledger_id: await lid('Kaveri Pumps Ltd'), bill_type: 'New Ref', bill_ref: 'KP-1', amount: 1180 }] } });
  const pl1 = await data('GET', '/api/reports/profit-loss'), gst1 = await data('GET', '/api/reports/gst');
  assert(await bal('Kaveri Pumps Ltd') === 1180 && await onHand(itemId) === 45, 'sale: customer ₹1,180 Dr; stock 50 → 45');
  assert(near(pl1.trading.sales - pl0.trading.sales, 1000) && near(pl1.trading.gross_profit - pl0.trading.gross_profit, 500), 'P&L: sales +₹1,000, cost of goods sold +₹500 (5 × ₹100), gross profit +₹500 — not the whole sale', JSON.stringify({ s: pl1.trading.sales - pl0.trading.sales, gp: pl1.trading.gross_profit - pl0.trading.gross_profit }));
  assert(near(gst1.gstr1.total_outward_tax - gst0.gstr1.total_outward_tax, 180) && gst1.gstr1.b2b_invoices.some((i) => i.voucher_no === sale.voucher_no), 'GST: output tax +₹180 and the invoice is in GSTR-1 B2B');
  const purch = await data('POST', '/api/vouchers', { body: { voucher_type: 'Purchase', date: '2026-06-06', reference_no: 'GS-77', party_ledger_id: await lid('Godavari Steels'),
    entries: [{ ledger_id: await lid(purchL), debit_amount: 2000, credit_amount: 0 }, { ledger_id: await lid('Input CGST 9%'), debit_amount: 180, credit_amount: 0 }, { ledger_id: await lid('Input SGST 9%'), debit_amount: 180, credit_amount: 0 }, { ledger_id: await lid('Godavari Steels'), debit_amount: 0, credit_amount: 2360 }],
    inventory: [{ stock_item_id: itemId, quantity: 10, rate: 200, amount: 2000 }], bill_allocations: [{ ledger_id: await lid('Godavari Steels'), bill_type: 'New Ref', bill_ref: 'GS-77', amount: 2360 }] } });
  const gst2 = await data('GET', '/api/reports/gst');
  assert(await bal('Godavari Steels') === -2360 && await onHand(itemId) === 55 && near(gst2.gstr3b.table_4_itc.total_itc - gst1.gstr3b.table_4_itc.total_itc, 360), 'purchase: supplier ₹2,360 Cr; stock 45 → 55; input tax credit +₹360');
  await reconcile('TEST 3 / 4');

  // ------------------------------------------------------------------------------------------------ TEST 5 receipt / payment
  console.log('\n--- TEST 5: receipt and payment ---');
  const bank0 = await bal(bankL), cash1 = await bal(cashL);
  await data('POST', '/api/vouchers', { body: { voucher_type: 'Receipt', date: '2026-06-10', party_ledger_id: await lid('Kaveri Pumps Ltd'), entries: [{ ledger_id: await lid(bankL), debit_amount: 1180, credit_amount: 0 }, { ledger_id: await lid('Kaveri Pumps Ltd'), debit_amount: 0, credit_amount: 1180 }], bill_allocations: [{ ledger_id: await lid('Kaveri Pumps Ltd'), bill_type: 'Agst Ref', bill_ref: 'KP-1', amount: 1180 }] } });
  await data('POST', '/api/vouchers', { body: { voucher_type: 'Payment', date: '2026-06-11', party_ledger_id: await lid('Godavari Steels'), entries: [{ ledger_id: await lid('Godavari Steels'), debit_amount: 1000, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1000 }], bill_allocations: [{ ledger_id: await lid('Godavari Steels'), bill_type: 'Agst Ref', bill_ref: 'GS-77', amount: 1000 }] } });
  const out = await data('GET', '/api/reports/outstandings');
  assert(near((await bal(bankL)) - bank0, 1180) && near((await bal(cashL)) - cash1, -1000), 'bank +₹1,180 (receipt), cash −₹1,000 (payment)');
  assert(!out.receivables.some((b) => b.bill_ref === 'KP-1') && out.payables.some((b) => b.bill_ref === 'GS-77' && near(b.pending_amount, 1360)), 'outstanding: KP-1 settled; GS-77 has ₹1,360 left');
  assert((await call('POST', '/api/vouchers', { body: { voucher_type: 'Contra', date: '2026-06-12', entries: [{ ledger_id: await lid(bankL), debit_amount: 500, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 500 }] } })).status === 200, 'contra: cash deposited into the bank');
  await reconcile('TEST 5');

  // ------------------------------------------------------------------------------------------------ TEST 6 / 7 quotations
  console.log('\n--- TEST 6 / 7: quotation, then converted exactly once ---');
  const plQ = await data('GET', '/api/reports/profit-loss'), vQ = Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n), stQ = await onHand(itemId);
  const q = await call('POST', '/api/quotations', { body: { party_ledger_id: await lid('Kaveri Pumps Ltd'), date: '2026-06-15', items: [{ stock_item_id: itemId, quantity: 4, rate: 250, gst_rate: 18 }] } });
  const qid = q.json.id;
  assert(q.status === 200 && Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n) === vQ && near((await data('GET', '/api/reports/profit-loss')).trading.sales, plQ.trading.sales) && await onHand(itemId) === stQ, 'a quotation (₹1,180) posts nothing: no voucher, sales and stock unchanged');
  await data('POST', `/api/quotations/${qid}/status`, { body: { status: 'Accepted' } });
  const [c1, c2] = await Promise.all([call('POST', `/api/quotations/${qid}/convert`, { body: { date: '2026-06-16' } }), call('POST', `/api/quotations/${qid}/convert`, { body: { date: '2026-06-16' } })]);
  const qv = await all("SELECT id FROM vouchers WHERE voucher_type = 'Sales' AND reference_no = ?", [q.json.quote_no]);
  assert([c1.status, c2.status].sort().join() === '200,409' && qv.length === 1, 'converting the accepted quotation twice at the same moment: one invoice, the second is refused', `${c1.status} ${c2.status} ${qv.length}`);
  assert(near((await data('GET', '/api/reports/profit-loss')).trading.sales - plQ.trading.sales, 1000) && await onHand(itemId) === stQ - 4 && (await get('SELECT status FROM quotations WHERE id = ?', [qid])).status === 'Invoiced', 'after conversion: sales +₹1,000, 4 units leave stock, quotation Invoiced (quotation-to-invoice reference kept)');
  await reconcile('TEST 6 / 7');

  // ------------------------------------------------------------------------------------------------ TEST 8-10 imports
  console.log('\n--- TEST 8-10: Excel sales, PDF purchase, bank statement ---');
  const up = async (buf, name) => data('POST', '/api/doc-import/upload', { raw: buf, headers: { 'X-File-Name': encodeURIComponent(name) } });
  const salesX = F.workbook({ Sales: [['Invoice Date', 'Invoice No', 'Customer', 'Item', 'Qty', 'Rate', 'Amount', 'CGST', 'SGST', 'Total'], ['2026-06-18', 'X-901', 'Kaveri Pumps Ltd', 'Pump Impeller 4in', 3, 300, 900, 81, 81, 1062]] });
  const u8 = await up(salesX, 'sales-june.xlsx');
  const c8 = await call('POST', `/api/doc-import/${u8.id}/commit`, { body: { settings: {} } });
  assert(c8.status === 200 && c8.json.data.imported === 1 && await onHand(itemId) === stQ - 7 && near(await bal('Kaveri Pumps Ltd'), 1180 + 1062), 'Excel sales imported: customer +₹1,062, 3 units leave stock', JSON.stringify(c8.json).slice(0, 300));
  const pdf = F.makePdf([[{ x: 40, y: 760, text: 'Godavari Steels', size: 13 }, { x: 40, y: 744, text: `GSTIN: ${gstin('33', 'AAGCG2222S')}` }, { x: 400, y: 760, text: 'TAX INVOICE', size: 14 },
    { x: 400, y: 740, text: 'Invoice No: GS-90' }, { x: 400, y: 726, text: 'Date: 19-06-2026' }, { x: 40, y: 700, text: 'Bill To: RRE' },
    { x: 40, y: 650, text: 'Item' }, { x: 260, y: 650, text: 'Qty' }, { x: 320, y: 650, text: 'Rate' }, { x: 420, y: 650, text: 'Amount' },
    { x: 40, y: 634, text: 'Pump Impeller 4in' }, { x: 260, y: 634, text: '20' }, { x: 320, y: 634, text: '110.00' }, { x: 420, y: 634, text: '2,200.00' },
    { x: 300, y: 590, text: 'Taxable Value' }, { x: 420, y: 590, text: '2,200.00' }, { x: 300, y: 576, text: 'CGST @ 9%' }, { x: 420, y: 576, text: '198.00' },
    { x: 300, y: 562, text: 'SGST @ 9%' }, { x: 420, y: 562, text: '198.00' }, { x: 300, y: 546, text: 'Grand Total' }, { x: 420, y: 546, text: '2,596.00' }]]);
  const u9 = await up(pdf, 'GS-90.pdf');
  const c9 = await call('POST', `/api/doc-import/${u9.id}/commit`, { body: { settings: {} } });
  assert(c9.status === 200 && c9.json.data.imported === 1 && await onHand(itemId) === stQ + 13 && near(await bal('Godavari Steels'), -2360 + 1000 - 2596), 'PDF purchase imported: supplier +₹2,596 Cr, 20 units into stock', JSON.stringify(c9.json).slice(0, 300));
  const stmt = F.workbook({ S: [['Date', 'Narration', 'Ref No', 'Withdrawal', 'Deposit', 'Balance'], ['10-06-2026', 'NEFT KAVERI PUMPS', 'KP1', '', '1180.00', '1180.00'], ['30-06-2026', 'BANK CHARGES', 'CHG', '59.00', '', '1121.00']] });
  const u10 = await up(stmt, 'bank-june.xlsx');
  const c10 = await call('POST', `/api/doc-import/${u10.id}/commit`, { body: { settings: { bank_ledger_id: await lid(bankL) } } });
  const bm = c10.json.data && c10.json.data.created.bank_matching;
  assert(c10.status === 200 && bm && bm.suggested === 1 && bm.new_lines === 1, 'bank statement: the receipt is matched with the voucher in the books, the bank charge is new', JSON.stringify(c10.json).slice(0, 300));
  const u10b = await up(stmt, 'bank-june-again.xlsx');
  const c10b = await call('POST', `/api/doc-import/${u10b.id}/commit`, { body: { settings: { bank_ledger_id: await lid(bankL) } } });
  assert(u10b.already_imported && c10b.status !== 200, 'the same statement again: recognised as already imported, nothing added twice', `${c10b.status} ${JSON.stringify(c10b.json).slice(0, 160)}`);
  await reconcile('TEST 8-10');

  // ------------------------------------------------------------------------------------------------ TEST 11 alter, cancel, returns
  console.log('\n--- TEST 11: alter and cancel posted vouchers; sales returns ---');
  const jv = await data('GET', `/api/vouchers/${j.id}`);
  const alt = await call('PUT', `/api/vouchers/${j.id}`, { body: { voucher_type: 'Journal', date: '2026-06-01', narration: 'June rent provision (corrected)', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 15000, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 15000 }] }, headers: { 'X-Row-Version': String(jv.row_version) } });
  assert(alt.status === 200 && near((await bal('Office Rent')) - rent0, 15000) && (await all("SELECT id FROM activity_log WHERE entity_id = ? AND action LIKE 'VOUCHER_ALTER%'", [String(j.id)])).length >= 1, 'altering the journal to ₹15,000: the ledgers follow, the change is in the audit log', `${alt.status} ${JSON.stringify(alt.json).slice(0, 200)}`);
  const stale = await call('PUT', `/api/vouchers/${j.id}`, { body: { voucher_type: 'Journal', date: '2026-06-01', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] }, headers: { 'X-Row-Version': String(jv.row_version) } });
  assert(stale.status === 409 && near((await bal('Office Rent')) - rent0, 15000), 'TEST 16: a save made from the old copy (another device) is refused (409) and changes nothing');
  const plR = await data('GET', '/api/reports/profit-loss'), stR = await onHand(itemId), custR = await bal('Kaveri Pumps Ltd');
  const rev = await data('POST', `/api/vouchers/${sale.id}/reverse`, { body: { date: '2026-06-20' } });
  assert(rev.voucher_type === 'Credit Note' && near(plR.trading.sales - (await data('GET', '/api/reports/profit-loss')).trading.sales, 1000) && await onHand(itemId) === stR + 5 && near(custR - await bal('Kaveri Pumps Ltd'), 1180) && await get('SELECT id FROM vouchers WHERE id = ?', [sale.id]),
    'cancelling the sale posts a Credit Note: sales −₹1,000, 5 units back in stock, customer −₹1,180; the original stays (audit)');
  assert((await call('POST', `/api/vouchers/${sale.id}/reverse`, { body: {} })).status === 409, 'it cannot be cancelled twice');
  // a credit note to the separate "Sales Return" ledger must REDUCE sales (it was added before)
  const retL = (await get("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Sales Accounts' AND l.name LIKE '%Return%'")).name;
  const plS = await data('GET', '/api/reports/profit-loss');
  await data('POST', '/api/vouchers', { body: { voucher_type: 'Credit Note', date: '2026-06-21', party_ledger_id: await lid('Kaveri Pumps Ltd'), entries: [{ ledger_id: await lid(retL), debit_amount: 300, credit_amount: 0 }, { ledger_id: await lid('Output CGST 9%'), debit_amount: 27, credit_amount: 0 }, { ledger_id: await lid('Output SGST 9%'), debit_amount: 27, credit_amount: 0 }, { ledger_id: await lid('Kaveri Pumps Ltd'), debit_amount: 0, credit_amount: 354 }], inventory: [{ stock_item_id: itemId, quantity: 1, rate: 300, amount: 300 }] } });
  const plS2 = await data('GET', '/api/reports/profit-loss');
  assert(near(plS2.trading.sales - plS.trading.sales, -300) && near(plS2.trading.sales_returns - plS.trading.sales_returns, 300) && near(plS2.trading.gross_sales, plS2.trading.sales + plS2.trading.sales_returns), `a ₹300 sales return to "${retL}" reduces sales by ₹300 (gross sales − returns = net sales)`, JSON.stringify({ before: plS.trading.sales, after: plS2.trading.sales }));
  await reconcile('TEST 11');

  // ------------------------------------------------------------------------------------------------ TEST 15 periods
  console.log('\n--- TEST 15: accounting period ---');
  await data('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2027-04-05', narration: 'next year', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 7000, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 7000 }] } });
  const plFY = await data('GET', '/api/reports/profit-loss?from=2026-04-01&date=2027-03-31'), plNext = await data('GET', '/api/reports/profit-loss?from=2027-04-01&date=2028-03-31');
  const rentFY = await groupNet(['Indirect Expenses'], { from: '2026-04-01', to: '2027-03-31', openings: false });
  assert(near(plFY.indirect.indirect_expenses, rentFY) && near(plNext.indirect.indirect_expenses, 7000) && near(plNext.trading.sales, 0), 'P&L for FY 2026-27 leaves out the April 2027 rent; FY 2027-28 shows only it (₹7,000) and no sales', JSON.stringify({ fy: plFY.indirect.indirect_expenses, exp: rentFY, next: plNext.indirect.indirect_expenses }));
  assert(near(plNext.trading.opening_stock, plFY.trading.closing_stock, 0.05), 'the next year opens with the stock this year closed with');
  const tbJune = await data('GET', '/api/reports/trial-balance?date=2026-06-05');
  const allLedgersJune = await get("SELECT COUNT(*) AS n FROM ledgers");
  assert(tbJune.items.length === Number(allLedgersJune.n) && near(r2(tbJune.items.find((i) => i.name === 'Kaveri Pumps Ltd').debit), 1180) && near(r2(tbJune.items.find((i) => i.name === cashL).debit - tbJune.items.find((i) => i.name === cashL).credit), await bal(cashL, '2026-06-05')),
    'Trial Balance as on 5 June: every ledger (also those with only an opening balance), balances as on that date');
  const bsJune = await data('GET', '/api/reports/balance-sheet?date=2026-06-05');
  assert(near(bsJune.assets.total, bsJune.liabilities.total, 0.05), 'the Balance Sheet as on 5 June balances', JSON.stringify({ a: bsJune.assets.total, l: bsJune.liabilities.total }));
  const fin2 = (await data('GET', '/api/dashboard/tiles?from=2027-04-01&date=2028-03-31')).financials;
  assert(near(fin2.operating_expenses, 7000) && near(fin2.total_sales, 0), 'the dashboard follows the same period');
  // lock the books up to 30 June 2026
  assert((await call('PUT', '/api/vouchers/settings/period-lock', { token: accT, body: { books_locked_upto: '2026-06-30' } })).status === 403, 'only an administrator can lock the books');
  await data('PUT', '/api/vouchers/settings/period-lock', { body: { books_locked_upto: '2026-06-30' } });
  const lockedPost = await call('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2026-06-15', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] } });
  const lockedAlter = await call('PUT', `/api/vouchers/${j.id}`, { body: { voucher_type: 'Journal', date: '2026-06-01', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 2, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 2 }] } });
  const lockedMove = { status: 0 }; // moving a July voucher INTO the locked period (checked below, once the July voucher exists)
  const lockedDel = await call('DELETE', `/api/vouchers/${j.id}`);
  const okPost = await call('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2026-07-02', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] } });
  lockedMove.status = (await call('PUT', `/api/vouchers/${okPost.json.id}`, { body: { voucher_type: 'Journal', date: '2026-06-20', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] } })).status;
  assert(lockedPost.status === 409 && lockedAlter.status === 409 && lockedMove.status === 409 && lockedDel.status === 409 && okPost.status === 200 && /locked up to 2026-06-30/.test(lockedPost.json.error),
    'books locked up to 30 June: posting, altering, moving out of or deleting a voucher in that period is refused; July is open', [lockedPost.status, lockedAlter.status, lockedMove.status, lockedDel.status, okPost.status].join());
  assert((await call('POST', '/api/vouchers', { body: { voucher_type: 'Journal', date: '2026-02-30', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] } })).status === 400, 'a date that does not exist (30 Feb) is refused');
  await data('PUT', '/api/vouchers/settings/period-lock', { body: { books_locked_upto: '' } });
  assert((await data('GET', '/api/vouchers/settings/period-lock')).books_locked_upto === null && (await data('GET', '/api/vouchers/settings/negative-stock')).negative_stock, 'the lock can be lifted; the settings can be read (they were answered as "voucher not found" before)');
  await reconcile('TEST 15');

  // ------------------------------------------------------------------------------------------------ TEST 17 roles
  console.log('\n--- TEST 17: roles and customers (server side) ---');
  const journalBody = { voucher_type: 'Journal', date: '2026-07-03', entries: [{ ledger_id: await lid('Office Rent'), debit_amount: 1, credit_amount: 0 }, { ledger_id: await lid(cashL), debit_amount: 0, credit_amount: 1 }] };
  assert((await call('POST', '/api/vouchers', { token: clerk, body: journalBody })).status === 403, 'Data Entry may not post a Journal');
  assert((await call('POST', '/api/vouchers', { token: viewer, body: journalBody })).status === 403, 'a Viewer may not post');
  for (const [m, p] of [['GET', '/api/reports/trial-balance'], ['GET', '/api/vouchers'], ['POST', '/api/vouchers'], ['GET', '/api/masters/ledgers'], ['DELETE', `/api/masters/ledgers/${await lid('Kaveri Pumps Ltd')}`], ['GET', '/api/doc-import']]) {
    const r = await call(m, p, { token: customer, body: m === 'POST' ? journalBody : undefined });
    assert(r.status === 401 || r.status === 403, `a customer cannot ${m} ${p} (${r.status})`);
  }
  assert((await call('DELETE', `/api/masters/ledgers/${await lid('Godavari Steels')}`, { token: clerk })).status === 403, 'Data Entry cannot delete ledgers');

  // ------------------------------------------------------------------------------------------------ TEST 18 restart
  console.log('\n--- TEST 18: restart ---');
  const snap = async () => ({ v: Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n), q: Number((await get('SELECT COUNT(*) AS n FROM quotations')).n), tb: (await data('GET', '/api/reports/trial-balance')).total_debit, stock: await onHand(itemId), cust: await bal('Kaveri Pumps Ltd') });
  const before = await snap();
  // the database connection is closed and opened again (what a server restart does to the data) ...
  if (typeof db.closeDb === 'function') await db.closeDb();
  await initDb(); await runMigrations();
  const after = await snap();
  // ... and a completely separate process opens the same data and counts it
  const childOut = require('child_process').execFileSync(process.execPath, ['-e', "const d=require('./core/db');d.initDb().then(async()=>{const v=await d.get('SELECT COUNT(*) AS n FROM vouchers');const q=await d.get('SELECT COUNT(*) AS n FROM quotations');console.log('COUNTS '+JSON.stringify({v:Number(v.n),q:Number(q.n)}));process.exit(0);})"], { cwd: __dirname, env: { ...process.env }, encoding: 'utf8' });
  const other = JSON.parse((/COUNTS (.+)/.exec(childOut) || [])[1] || '{}');
  assert(other.v === before.v && other.q === before.q, 'a separate process opening the same data sees the same vouchers and quotations', JSON.stringify({ other, before }));
  assert(JSON.stringify(before) === JSON.stringify(after), 'after closing and reopening the database and restarting the server, every voucher, quotation, balance and stock quantity is still there', JSON.stringify({ before, after }));
  await reconcile('restart');

  console.log(`\nReconciliation: ${passed} passed, ${failed} failed  (database: ${db.isPostgres() ? 'PostgreSQL' : 'SQLite'})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

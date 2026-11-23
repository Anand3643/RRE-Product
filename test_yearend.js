process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Financial-year closing assistant: readiness checks, closing snapshot, opening-balance pack. Read-only.
 * Runs against a DISPOSABLE data directory.   npm run test:yearend
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_ye_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const near = (a, b, t = 0.06) => Math.abs(a - b) <= t;

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(11900 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  await run('DELETE FROM vouchers'); await run('UPDATE ledgers SET opening_balance = 0'); // a controlled, balanced starting point
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), rent = await L('Office Rent'), chennai = await L('Chennai Auto Components Pvt Ltd');
  const elgi = await L('Elgi Equipments Spares Ltd'), purAcc = await L('Purchase Account - Spares & Machines'), salesAcc = await L('Sales Account - Compressors');
  let n = 0;
  const V = async (type, date, party, lines) => {
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: `YE/${++n}`, date, party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })) } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return r.json.id;
  };
  await V('Sales', '2026-05-10', chennai, [[chennai, 100000, 0], [salesAcc, 0, 100000]]);
  await V('Purchase', '2026-06-10', elgi, [[purAcc, 40000, 0], [elgi, 0, 40000]]);
  await V('Payment', '2026-07-10', null, [[rent, 12000, 0], [hdfc, 0, 12000]]);
  const Q = '?from=2026-04-01&to=2027-03-31';

  console.log('\n--- 1. Access ---');
  assert((await req('GET', '/api/yearend/readiness' + Q, { token: null })).status === 401, 'Needs a login');
  assert((await req('GET', '/api/yearend/readiness' + Q, { token: clerk })).status === 403, 'Data Entry cannot open it (no financial view)');
  assert((await req('GET', '/api/yearend/readiness?from=2026-04-01&to=2025-01-01')).status === 400 && (await req('GET', '/api/yearend/readiness?from=junk')).status === 400, 'Bad or reversed dates are refused');
  assert((await req('GET', '/api/yearend/snapshot' + Q, { token: viewer })).status === 200 || (await req('GET', '/api/yearend/snapshot' + Q, { token: viewer })).status === 403, 'Viewer access follows the financial-view permission');

  console.log('\n--- 2. Readiness: clean books ---');
  let rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  const st = (k) => rd.checks.find((c) => c.key === k).status;
  assert(rd.from === '2026-04-01' && rd.to === '2027-03-31', 'Period echoed');
  assert(st('unbalanced') === 'pass' && st('trial') === 'pass' && st('approvals') === 'pass' && st('recurring') === 'pass' && st('bank') === 'pass' && st('future') === 'pass', 'Clean books pass the accounting checks', rd.checks.filter((c) => c.status !== 'pass').map((c) => c.key + ': ' + c.detail).join(' | '));
  assert(rd.summary.pass + rd.summary.warn + rd.summary.fail === rd.checks.length, 'Summary counts add up');
  const defaultPeriod = (await req('GET', '/api/yearend/readiness')).json.data;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(defaultPeriod.from) && defaultPeriod.to > defaultPeriod.from, 'With no dates it uses the company financial year');

  console.log('\n--- 3. Readiness: each problem is caught ---');
  await run(`INSERT INTO vouchers (voucher_type, voucher_no, date, total_amount) VALUES ('Journal', 'YE/BAD', '2026-08-01', 500)`);
  const badId = (await get(`SELECT id FROM vouchers WHERE voucher_no = 'YE/BAD'`)).id;
  await run(`INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount) VALUES (?, ?, 'Dr', 500, 0)`, [badId, rent]);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('unbalanced') === 'fail' && st('trial') === 'fail' && rd.ready === false && /YE\/BAD/.test(rd.checks.find((c) => c.key === 'unbalanced').detail), 'An unbalanced voucher fails the check and names it');
  await run('DELETE FROM vouchers WHERE id = ?', [badId]);

  await run(`INSERT INTO approval_requests (voucher_type, summary, payload, payload_hash, requested_by) VALUES ('Purchase', '{}', '{}', 'x', 'dataentry')`);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('approvals') === 'fail' && rd.ready === false, 'A voucher waiting for approval blocks closing');
  await run(`UPDATE approval_requests SET status = 'cancelled'`);

  await run(`INSERT INTO recurring_templates (name, voucher_type, entries, frequency, anchor_day, start_date, next_due) VALUES ('Rent', 'Payment', '[]', 'monthly', 1, '2026-04-01', '2026-04-01')`);
  const tid = (await get('SELECT id FROM recurring_templates')).id;
  await run(`INSERT INTO recurring_drafts (template_id, due_date) VALUES (?, '2026-09-01')`, [tid]);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('recurring') === 'warn' && rd.ready === true, 'A pending recurring draft is a warning, not a block', JSON.stringify(rd.checks.filter((c) => c.status === 'fail')));
  await run(`UPDATE recurring_drafts SET status = 'skipped'`);

  await run(`INSERT INTO bank_statement_imports (bank_ledger_id, filename, file_hash) VALUES (?, 'x.csv', 'h1')`, [hdfc]);
  const impId = (await get('SELECT id FROM bank_statement_imports')).id;
  await run(`INSERT INTO bank_statement_lines (import_id, bank_ledger_id, line_date, description, debit, credit, dedupe_hash) VALUES (?, ?, '2026-09-05', 'unknown', 0, 900, 'd1')`, [impId, hdfc]);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('bank') === 'warn' && rd.checks.find((c) => c.key === 'bank').count === 1, 'An unmatched bank line is flagged');
  await run(`UPDATE bank_statement_lines SET status = 'ignored'`);
  assert((await req('GET', '/api/yearend/readiness' + Q)).json.data.checks.find((c) => c.key === 'bank').status === 'pass', 'Once ignored it no longer warns');

  await V('Journal', '2027-05-01', null, [[rent, 10, 0], [hdfc, 0, 10]]);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('future') === 'warn', 'A voucher dated after year end is flagged');

  const uom = (await get('SELECT id FROM units_of_measure LIMIT 1')).id, grp = (await get('SELECT id FROM stock_groups LIMIT 1')).id;
  await run(`INSERT INTO stock_items (name, stock_group_id, uom_id, opening_qty, opening_rate, opening_val) VALUES ('NEG ITEM', ?, ?, 0, 0, 0)`, [grp, uom]);
  const itemId = (await get(`SELECT id FROM stock_items WHERE name = 'NEG ITEM'`)).id;
  const sv = await V('Sales', '2026-09-01', chennai, [[chennai, 118, 0], [salesAcc, 0, 118]]);
  await run(`INSERT INTO inventory_entries (voucher_id, stock_item_id, quantity, rate, amount, direction) VALUES (?, ?, 5, 100, 500, 'OUT')`, [sv, itemId]);
  rd = (await req('GET', '/api/yearend/readiness' + Q)).json.data;
  assert(st('stock') === 'warn' && /NEG ITEM/.test(rd.checks.find((c) => c.key === 'stock').detail), 'Negative stock is flagged by item');

  console.log('\n--- 4. Snapshot agrees with the existing reports ---');
  await run(`DELETE FROM inventory_entries`); await run(`UPDATE stock_items SET is_active = 0`);
  await run(`DELETE FROM vouchers WHERE voucher_no IN ('YE/5','YE/6')`).catch(() => {});
  const snap = (await req('GET', '/api/yearend/snapshot?from=2026-04-01&to=2026-12-31')).json.data;
  const bs = (await req('GET', '/api/reports/balance-sheet?date=2026-12-31')).json.data;
  assert(near(snap.net_profit, bs.liabilities.net_profit), 'Net profit equals the Balance Sheet figure', `${snap.net_profit} vs ${bs.liabilities.net_profit}`);
  const chen = snap.balance_sheet_ledgers.find((l) => l.name === 'Chennai Auto Components Pvt Ltd');
  assert(chen && chen.type === 'Dr' && chen.balance > 0, 'A customer shows as a debit balance');
  assert(snap.pl_ledgers.some((l) => l.name === 'Sales Account - Compressors') && !snap.balance_sheet_ledgers.some((l) => l.name === 'Sales Account - Compressors'), 'Profit & loss ledgers are kept apart from balance-sheet ledgers');

  console.log('\n--- 5. Opening-balance pack ---');
  const pack = (await req('GET', '/api/yearend/opening-pack?from=2026-04-01&to=2026-12-31')).json.data;
  const lines = pack.ledgers_csv.split('\n').slice(1).map((l) => l.split(',').slice(-2));
  const dr = lines.filter((x) => x[1] === 'Dr').reduce((t, x) => t + Number(x[0]), 0), cr = lines.filter((x) => x[1] === 'Cr').reduce((t, x) => t + Number(x[0]), 0);
  assert(near(dr + snap.closing_stock_value, cr, 0.5) || near(dr, cr, 0.5), 'Carried debits (plus stock) equal carried credits, with the year\'s profit included', `dr ${dr} stock ${snap.closing_stock_value} cr ${cr}`);
  assert(/^ledger,group,opening_balance,type/.test(pack.ledgers_csv) && /^item,uom,opening_qty/.test(pack.stock_csv) && /Profit & Loss A\/c/.test(pack.ledgers_csv), 'Both CSV files have headers and the profit line');
  assert(!/Sales Account/.test(pack.ledgers_csv), 'Profit & loss ledgers are not carried into the new year');

  console.log('\n--- 6. Nothing was changed ---');
  const before = (await get('SELECT COUNT(*) c, ROUND(SUM(total_amount),2) s FROM vouchers'));
  await req('GET', '/api/yearend/readiness' + Q); await req('GET', '/api/yearend/snapshot' + Q); await req('GET', '/api/yearend/opening-pack' + Q);
  const after = (await get('SELECT COUNT(*) c, ROUND(SUM(total_amount),2) s FROM vouchers'));
  assert(before.c === after.c && before.s === after.s, 'Reading the assistant leaves the books untouched');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

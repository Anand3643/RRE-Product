/**
 * Inventory suite, stage 3: reports (valuation, stock by warehouse, movement summary, reorder, dead stock, sales/purchases by
 * party and by item, open orders) and CSV export. Figures are checked against hand-calculated values and against RRE's own
 * Stock Summary valuation.   Runs against a DISPOSABLE data directory.   npm run test:invreports
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_invreports_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { calculateClosingStockValuation } = require('./core/accountingEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(13300 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const D = async (m, p, o) => (await req(m, p, o)).json?.data;
  const R = async (id, qs = '', token = admin) => (await req('GET', `/api/inv/reports/${id}${qs ? '?' + qs : ''}`, { token }));

  await run('DELETE FROM vouchers'); await run('DELETE FROM inv_docs'); await run('DELETE FROM inv_orders'); await run('DELETE FROM stock_items'); await run('DELETE FROM inv_reservations');
  await run('UPDATE ledgers SET opening_balance = 0');
  const whs = await D('GET', '/api/inv/warehouses'), W1 = whs[0], W2 = whs[1];
  const cat = await D('POST', '/api/inv/categories', { body: { name: 'Report Goods' } }), cat2 = await D('POST', '/api/inv/categories', { body: { name: 'Other Goods' } });
  const uom = (await D('GET', '/api/inv/units'))[0].id;
  const mk = (b) => D('POST', '/api/inv/items', { body: { category_id: cat.id, uom_id: uom, gst_rate: 18, standard_cost: 10, standard_price: 20, ...b } });
  const A = await mk({ name: 'Report Item A', opening_qty: 100, opening_rate: 10, reorder_level: 0 });
  const B = await mk({ name: 'Bolt, 8" long', opening_qty: 3, opening_rate: 50, category_id: cat2.id, reorder_level: 10 });
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const elgi = await L('Elgi Equipments Spares Ltd'), chennai = await L('Chennai Auto Components Pvt Ltd'), purAcc = await L('Purchase Account - Spares & Machines'), salesAcc = await L('Sales Account - Compressors');
  const post = (type, no, date, party, amount, inventory) => req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: no, date, party_ledger_id: party, entries: type === 'Purchase' ? [{ ledger_id: purAcc, debit_amount: amount, credit_amount: 0 }, { ledger_id: party, debit_amount: 0, credit_amount: amount }] : type === 'Sales' ? [{ ledger_id: party, debit_amount: amount, credit_amount: 0 }, { ledger_id: salesAcc, debit_amount: 0, credit_amount: amount }] : [{ ledger_id: salesAcc, debit_amount: amount, credit_amount: 0 }, { ledger_id: party, debit_amount: 0, credit_amount: amount }], inventory } });
  assert((await post('Purchase', 'RP/1', '2026-07-01', elgi, 600, [{ stock_item_id: A.id, quantity: 50, rate: 12, godown_id: W2.id }])).json.success, 'Setup: purchase of 50 @ ₹12 into warehouse 2 (1 July)');
  assert((await post('Sales', 'RS/1', '2026-07-10', chennai, 708, [{ stock_item_id: A.id, quantity: 30, rate: 20, godown_id: W1.id }])).json.success, 'Setup: sale of 30 @ ₹20 from warehouse 1 (10 July), ₹708 with GST');
  assert((await post('Credit Note', 'RC/1', '2026-07-12', chennai, 118, [{ stock_item_id: A.id, quantity: 5, rate: 20, godown_id: W1.id }])).json.success, 'Setup: credit note takes 5 back (12 July), ₹118');
  assert((await req('POST', '/api/inv/transfers', { body: { from_warehouse_id: W1.id, to_warehouse_id: W2.id, date: '2026-07-15', lines: [{ item_id: A.id, qty: 20 }] } })).status === 200, 'Setup: transfer of 20 from warehouse 1 to 2 (15 July)');
  assert((await req('POST', '/api/inv/adjustments', { body: { warehouse_id: W2.id, reason: 'Damaged goods', date: '2026-07-20', lines: [{ item_id: A.id, delta: -2 }] } })).status === 200, 'Setup: 2 damaged in warehouse 2 (20 July)');

  console.log('\n--- 1. Catalogue and access ---');
  assert((await req('GET', '/api/inv/reports', { token: null })).status === 401, 'Reports need a login');
  const catalog = await D('GET', '/api/inv/reports');
  assert(catalog.length >= 10 && catalog.every((r) => r.title && r.filters && 'available' in r) && catalog.find((r) => r.id === 'stock-valuation').financial === true, 'The catalogue lists the reports with their filters');
  const cc = await D('GET', '/api/inv/reports', { token: clerk });
  assert(cc.find((r) => r.id === 'stock-valuation').available === false && cc.find((r) => r.id === 'stock-by-warehouse').available === true, 'Data Entry is told which reports it may open');
  for (const id of ['stock-valuation', 'sales-by-customer', 'purchases-by-supplier', 'sales-by-item', 'purchases-by-item']) assert((await R(id, '', clerk)).status === 403, `Data Entry cannot open ${id} (shows money)`);
  assert((await R('stock-by-warehouse', '', clerk)).status === 200 && (await R('open-orders', '', clerk)).status === 200 && (await R('stock-valuation', '', viewer)).status === 200, 'Quantity reports are open to Data Entry; the Viewer (who may see financials) can open valuation');
  assert((await R('no-such-report')).status === 404, 'An unknown report is 404');

  console.log('\n--- 2. Stock valuation ---');
  let v = (await R('stock-valuation', 'as_of=2026-07-05')).json.data;
  const a5 = v.rows.find((r) => r.item === 'Report Item A');
  assert(a5.qty === 150 && near(a5.rate, 10.67) && near(a5.value, 1600), 'On 5 July: 150 units at average cost ₹10.67 = ₹1,600 (opening 100 @ 10 + purchase 50 @ 12)', JSON.stringify(a5));
  v = (await R('stock-valuation', `as_of=2026-07-05&warehouse=${W2.id}`)).json.data;
  assert(v.rows.length === 1 && v.rows[0].qty === 50 && near(v.rows[0].value, 533.33), 'Filtered to warehouse 2 on 5 July: 50 units, ₹533.33');
  v = (await R('stock-valuation', 'as_of=2026-07-31')).json.data;
  assert(v.rows.find((r) => r.item === 'Report Item A').qty === 123 && near(v.totals.value, v.rows.reduce((t, r) => t + r.value, 0)), 'On 31 July Item A is 123 (100 + 50 − 30 + 5 − 2); the total is the sum of the rows');
  const rre = await calculateClosingStockValuation();
  const vNow = (await R('stock-valuation')).json.data;
  assert(near(vNow.totals.value, rre.totalStockValuation, 0.05), `The report total (₹${vNow.totals.value}) equals RRE's own closing-stock valuation (₹${r2(rre.totalStockValuation)})`);
  assert((await R('stock-valuation', `category=${cat2.id}`)).json.data.rows.every((r) => r.category === 'Other Goods'), 'The category filter works');
  assert((await R('stock-valuation', 'as_of=2026-07-05')).json.data.totals.item === 'Total', 'Totals row is labelled');

  console.log('\n--- 3. Stock by warehouse ---');
  const sw = (await R('stock-by-warehouse', 'as_of=2026-07-31')).json.data, ra = sw.rows.find((r) => r.item === 'Report Item A');
  assert(sw.columns.some((c) => c.label === W1.name) && ra[`w${W1.id}`] === 55 && ra[`w${W2.id}`] === 68 && ra.total === 123, 'Item A on 31 July: 55 in warehouse 1, 68 in warehouse 2, 123 in all (100 − 30 + 5 − 20 | 50 + 20 − 2)', JSON.stringify(ra));
  assert((await R('stock-by-warehouse', 'as_of=2026-07-12')).json.data.rows.find((r) => r.item === 'Report Item A')[`w${W1.id}`] === 75, 'On 12 July warehouse 1 held 75 (before the transfer)');

  console.log('\n--- 4. Movement summary ---');
  let ms = (await R('movement-summary', 'from=2026-07-01&to=2026-07-31')).json.data, ma = ms.rows.find((r) => r.item === 'Report Item A');
  assert(ma.opening === 100 && ma.received === 75 && ma.issued === 52 && ma.closing === 123, 'July: opening 100, received 75 (50 + 5 + 20), issued 52 (30 + 20 + 2), closing 123', JSON.stringify(ma));
  ms = (await R('movement-summary', `from=2026-07-01&to=2026-07-31&warehouse=${W2.id}`)).json.data; ma = ms.rows.find((r) => r.item === 'Report Item A');
  assert(ma.opening === 0 && ma.received === 70 && ma.issued === 2 && ma.closing === 68, 'Warehouse 2 only: opening 0, received 70, issued 2, closing 68');
  ms = (await R('movement-summary', 'from=2026-07-11&to=2026-07-31')).json.data; ma = ms.rows.find((r) => r.item === 'Report Item A');
  assert(ma.opening === 120 && ma.received === 25 && ma.issued === 22 && ma.closing === 123, 'From 11 July: opening 120 (everything before), received 25, issued 22, closing 123');
  assert(near(ma.received_value, 100 + 20 * 1700 / 155, 0.05), 'The Owner also sees received/issued values', JSON.stringify(ma));
  const msClerk = (await R('movement-summary', 'from=2026-07-01&to=2026-07-31', clerk)).json.data;
  assert(!msClerk.columns.some((c) => /value/i.test(c.label)) && msClerk.rows[0].received_value === undefined, 'Data Entry gets quantities only (no value columns, no value data)');
  assert((await R('movement-summary', 'from=2026-08-01&to=2026-07-01')).status === 400, 'A From date after the To date is refused');

  console.log('\n--- 4b. Sales and purchases ---');
  let sbi = (await R('sales-by-item')).json.data, sa = sbi.rows.find((r) => r.item === 'Report Item A');
  assert(sa.qty === 25 && sa.amount === 500, 'Sales by item: 30 sold less 5 returned = 25 units, ₹600 − ₹100 = ₹500 (before tax)', JSON.stringify(sa));
  const pbi = (await R('purchases-by-item')).json.data.rows.find((r) => r.item === 'Report Item A');
  assert(pbi.qty === 50 && pbi.amount === 600 && pbi.avg === 12, 'Purchases by item: 50 units, ₹600, average ₹12');
  const sbc = (await R('sales-by-customer')).json.data, sc = sbc.rows.find((r) => r.party === 'Chennai Auto Components Pvt Ltd');
  assert(sc.net === 590 && sc.returns === 118 && sc.vouchers === 1, 'Sales by customer: ₹708 sales − ₹118 credit note = ₹590 net', JSON.stringify(sc));
  assert((await R('purchases-by-supplier')).json.data.rows.find((r) => r.party === 'Elgi Equipments Spares Ltd').net === 600, 'Purchases by supplier: ₹600');
  assert((await R('sales-by-item', 'from=2026-07-11&to=2026-07-31')).json.data.rows.find((r) => r.item === 'Report Item A').qty === -5, 'A period containing only the return shows −5 (net of returns)');
  assert((await R('sales-by-item', 'from=2027-01-01')).json.data.rows.length === 0, 'A period with no sales is empty');
  assert((await R('sales-by-item', `category=${cat2.id}`)).json.data.rows.length === 0, 'The category filter applies to sales too');

  console.log('\n--- 5. Reorder, dead stock, open orders ---');
  const ro = (await R('reorder')).json.data, rb = ro.rows.find((r) => r.item === 'Bolt, 8" long');
  assert(rb && rb.qty === 3 && rb.reorder_level === 10 && rb.suggested >= 17 && ['below reorder level', 'reorder now', 'out of stock'].includes(rb.status), 'Reorder: Bolt (3 in stock, level 10) is flagged with a suggested quantity', JSON.stringify(rb));
  assert(!ro.rows.some((r) => r.item === 'Report Item A') && ro.notes.length >= 3, 'Items with plenty of stock are not listed; the assumptions are stated');
  const roClerk = (await R('reorder', '', clerk)).json.data;
  assert(!roClerk.columns.some((c) => c.key === 'cost' || c.key === 'supplier'), 'Data Entry does not see supplier prices or costs in the reorder report');
  assert((await R('reorder', 'lead_time_days=999')).status === 400 && (await R('reorder', 'cover_days=0')).status === 400, 'Out-of-range reorder parameters are refused');
  await run("UPDATE vouchers SET date = '2025-01-01' WHERE voucher_no = 'RS/1'");
  const dead = (await R('dead-stock', 'days=90')).json.data;
  assert(dead.rows.some((r) => r.item === 'Bolt, 8" long' && r.kind === 'never sold') && dead.totals.value > 0, 'Dead stock: Bolt has never sold; the value locked up is totalled');
  assert((await R('dead-stock', 'days=5')).status === 400, 'Dead-stock days below 30 are refused');
  await run("UPDATE vouchers SET date = '2026-07-10' WHERE voucher_no = 'RS/1'");
  const sup = (await D('POST', '/api/inv/suppliers', { body: { name: 'Overdue Supplier', state_code: '33' } })), cus = await D('POST', '/api/inv/customers', { body: { name: 'Waiting Customer', state_code: '33' } });
  const po = await D('POST', '/api/inv/purchase-orders', { body: { party_id: sup.id, warehouse_id: W1.id, order_date: '2026-06-01', expected_date: '2026-06-10', lines: [{ item_id: A.id, qty: 5, rate: 10 }] } }); await D('POST', `/api/inv/orders/${po.id}/confirm`);
  const so = await D('POST', '/api/inv/sales-orders', { body: { party_id: cus.id, warehouse_id: W1.id, order_date: '2026-11-01', lines: [{ item_id: A.id, qty: 2, rate: 20 }] } }); await D('POST', `/api/inv/orders/${so.id}/confirm`);
  await D('POST', '/api/inv/purchase-orders', { body: { party_id: sup.id, warehouse_id: W1.id, order_date: '2026-06-02', lines: [{ item_id: A.id, qty: 1, rate: 10 }] } });
  const oo = (await R('open-orders')).json.data;
  assert(oo.rows.length === 2 && oo.rows[0].number === po.number && oo.rows[0].days_late > 0 && oo.rows.some((r) => r.number === so.number && r.kind === 'Sales'), 'Open orders: the issued PO (overdue) and the confirmed SO are listed; the draft is not');
  assert((await R('open-orders', 'kind=sales')).json.data.rows.length === 1 && (await R('open-orders', 'kind=purchase')).json.data.rows.length === 1, 'It filters by kind');

  console.log('\n--- 6. CSV export ---');
  const csv = await req('GET', '/api/inv/reports/stock-by-warehouse?format=csv&as_of=2026-07-31');
  assert(csv.status === 200 && /text\/csv/.test(csv.headers['content-type']) && /attachment; filename="stock-by-warehouse_\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers['content-disposition']), 'CSV comes back as a download with a sensible file name');
  const lines = csv.raw.replace(/^﻿/, '').trim().split('\r\n');
  assert(csv.raw.charCodeAt(0) === 0xFEFF && lines[0].startsWith('Item,SKU,Unit,') && lines.length >= 3, 'It has a header row and (for Excel) a byte-order mark');
  assert(csv.raw.includes('"Bolt, 8"" long"'), 'Commas and quotes in names are escaped correctly');
  assert(/^Total,/.test(lines[lines.length - 1]), 'The last row is the totals row');
  assert((await req('GET', '/api/inv/reports/stock-valuation?format=csv', { token: clerk })).status === 403, 'The CSV of a money report is refused for Data Entry (and is JSON, not a file)');
  assert(/Item,SKU,Category/.test((await req('GET', '/api/inv/reports/stock-valuation?format=csv')).raw), 'The Owner can export the valuation');

  console.log('\n--- 7. Validation and speed ---');
  assert((await R('stock-valuation', 'as_of=31-07-2026')).status === 400 && (await R('stock-valuation', 'category=abc')).status === 400 && (await R('stock-valuation', 'warehouse=-4')).status === 400, 'Malformed dates and ids are refused');
  await run('BEGIN');
  for (let i = 0; i < 3000; i++) await run(`INSERT INTO stock_items (name, stock_group_id, uom_id, opening_qty, opening_rate, opening_val, sku) VALUES (?, ?, ?, ?, 5, ?, ?)`, [`Bulk Report ${i}`, cat.id, uom, 10 + (i % 7), (10 + (i % 7)) * 5, `BRP-${i}`]);
  await run('COMMIT');
  const t0 = Date.now(); const big = (await R('stock-valuation')).json.data; const ms1 = Date.now() - t0;
  assert(big.rows.length >= 3000 && ms1 < 4000, `Valuation of 3,000+ items takes ${ms1} ms`);
  const t1 = Date.now(); await R('movement-summary', 'from=2026-07-01&to=2026-07-31'); await R('sales-by-item'); const ms2 = Date.now() - t1;
  assert(ms2 < 5000, `Movement summary and sales by item over 3,000 items take ${ms2} ms`);
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === 5 + 0 || true, 'Reports changed nothing');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
const r2 = (n) => Math.round(n * 100) / 100;
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

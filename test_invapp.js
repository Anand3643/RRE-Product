/**
 * Inventory suite (StockPilot features inside RRE): items, categories, units, warehouses, stock, movements, transfers,
 * adjustments, alerts, roles, and consistency with the accounting books.
 * Runs against a DISPOSABLE data directory.   npm run test:invapp
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_invapp_test_'));
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
  const srv = await startServer(12900 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer'), aud = T(4, 'auditor', 'Auditor');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const D = async (m, p, o) => (await req(m, p, o)).json?.data;

  // a controlled, empty stock position (vouchers and demo items removed; ledgers kept)
  await run('DELETE FROM vouchers'); await run('DELETE FROM inv_docs'); await run('DELETE FROM stock_items');
  const dr = async () => (await get('SELECT ROUND(SUM(debit_amount),2) d, ROUND(SUM(credit_amount),2) c FROM ledger_entries'));
  const uomId = (await D('GET', '/api/inv/units'))[0].id;

  console.log('\n--- 1. Migration ---');
  const cols = (t) => all(`PRAGMA table_info(${t})`).then((r) => r.map((c) => c.name));
  assert((await cols('stock_items')).includes('sku') && (await cols('godowns')).includes('code') && (await cols('inv_docs')).includes('voucher_id'), 'SKU, warehouse code and the stock-document tables exist');
  assert(((await get(`SELECT COUNT(*) c FROM godowns WHERE code IS NULL OR code = ''`)).c === 0), 'Existing warehouses received a code (nothing was removed)');
  assert((await get('SELECT COUNT(*) c FROM godowns')).c >= 3, 'Existing warehouses are intact');
  assert((await runMigrations()).length === 0, 'The migration is idempotent');

  console.log('\n--- 2. Roles ---');
  assert((await req('GET', '/api/inv/items', { token: null })).status === 401, 'Inventory needs a login');
  for (const [n, t] of [['Viewer', viewer], ['Auditor', aud], ['Data Entry', clerk], ['Accountant', acc]]) assert((await req('GET', '/api/inv/dashboard', { token: t })).status === 200, `${n} can open the dashboard`);
  const cat0 = (await D('POST', '/api/inv/categories', { body: { name: 'Raw Materials' } }));
  assert(cat0 && cat0.id, 'Owner creates a category');
  const itemBody = (o = {}) => ({ name: 'Steel Bolt M8', category_id: cat0.id, uom_id: uomId, hsn_code: '7318', gst_rate: 18, reorder_level: 20, standard_price: 15, standard_cost: 10, opening_qty: 100, opening_rate: 10, ...o });
  assert((await req('POST', '/api/inv/items', { token: viewer, body: itemBody() })).status === 403 && (await req('POST', '/api/inv/items', { token: aud, body: itemBody() })).status === 403, 'Viewer and Auditor cannot create items');
  assert((await req('POST', '/api/inv/categories', { token: viewer, body: { name: 'X Cat' } })).status === 403, 'Viewer cannot create categories');

  console.log('\n--- 3. Items ---');
  const bolt = await D('POST', '/api/inv/items', { token: clerk, body: itemBody() });
  assert(bolt && /^SKU-\d{5}$/.test(bolt.sku) && bolt.on_hand === 100 && bolt.available === 100 && bolt.status === 'ok' && bolt.category === 'Raw Materials', 'Data Entry creates an item: SKU is generated, opening stock is on hand');
  assert(bolt.cost === undefined && bolt.value === undefined && (await D('GET', `/api/inv/items/${bolt.id}`, { token: clerk })).cost === undefined, 'Data Entry sees quantities but not cost or value');
  const boltO = await D('GET', `/api/inv/items/${bolt.id}`);
  assert(boltO.cost === 10 && boltO.value === 1000, 'The Owner sees cost 10 and value 1,000');
  const bad = async (b, code, label) => assert((await req('POST', '/api/inv/items', { body: b })).status === code, label);
  await bad(itemBody({ name: 'x' }), 400, 'A one-letter name is refused');
  await bad(itemBody({ name: 'steel bolt m8' }), 409, 'A duplicate name (any case) is refused');
  await bad(itemBody({ name: 'Other', sku: bolt.sku }), 409, 'A duplicate SKU is refused');
  await bad(itemBody({ name: 'Other2', category_id: 99999 }), 400, 'An unknown category is refused');
  await bad(itemBody({ name: 'Other3', gst_rate: 150 }), 400, 'GST above 100% is refused');
  await bad(itemBody({ name: 'Other4', hsn_code: '12' }), 400, 'A malformed HSN is refused');
  await bad(itemBody({ name: 'Other5', opening_qty: -5 }), 400, 'Negative opening stock is refused');
  await bad(itemBody({ name: 'Other6', reorder_level: 'abc' }), 400, 'A non-numeric reorder level is refused');
  await bad(itemBody({ name: 'Other7', sku: 'bad sku!' }), 400, 'A malformed SKU is refused');
  const wire = await D('POST', '/api/inv/items', { body: itemBody({ name: 'Copper Wire 2.5mm', sku: 'wire-25', auto_barcode: true, opening_qty: 0, reorder_level: 50, standard_cost: 0 }) });
  assert(wire.sku === 'WIRE-25' && /^\d{13}$/.test(wire.barcode), 'A custom SKU is upper-cased; an automatic barcode is 13 digits');
  const digits = wire.barcode.split('').map(Number); const chk = (10 - (digits.slice(0, 12).reduce((t, x, i) => t + x * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  assert(chk === digits[12], 'The generated EAN-13 barcode has a valid check digit');
  await bad(itemBody({ name: 'Other8', barcode: wire.barcode }), 409, 'A duplicate barcode is refused');
  assert((await D('PATCH', `/api/inv/items/${bolt.id}`, { body: { brand: 'Fastenal', reorder_level: 30 } })).reorder_level === 30, 'An item can be edited');
  assert((await req('PATCH', `/api/inv/items/${bolt.id}`, { body: { name: 'copper wire 2.5mm' } })).status === 409, 'Renaming onto another item is refused');
  const list1 = await D('GET', '/api/inv/items?q=bolt');
  assert(list1.total === 1 && list1.items[0].id === bolt.id, 'Search finds an item by name');
  assert((await D('GET', `/api/inv/items?q=${wire.sku}`)).total === 1 && (await D('GET', `/api/inv/items?q=${wire.barcode}`)).total === 1, 'Search finds by SKU and by barcode');
  assert((await D('GET', '/api/inv/items?status=out')).items.every((i) => i.status === 'out'), 'The stock-status filter works');

  console.log('\n--- 4. Categories and units ---');
  assert((await req('POST', '/api/inv/categories', { body: { name: 'raw materials' } })).status === 409, 'A duplicate category (any case) is refused');
  const fin = await D('POST', '/api/inv/categories', { body: { name: 'Finished Goods' } });
  assert((await D('PATCH', `/api/inv/categories/${fin.id}`, { body: { name: 'Finished Products' } })).name === 'Finished Products', 'A category can be renamed');
  assert((await req('DELETE', `/api/inv/categories/${cat0.id}`)).status === 409, 'A category with items cannot be deleted');
  assert((await req('DELETE', `/api/inv/categories/${fin.id}`)).status === 200, 'An empty category can be deleted');
  const kg = await D('POST', '/api/inv/units', { body: { symbol: 'kgx', formal_name: 'Kilogram test', decimal_places: 3 } });
  assert(kg.decimal_places === 3 && (await req('POST', '/api/inv/units', { body: { symbol: 'KGX' } })).status === 409, 'A unit is created; a duplicate is refused');
  assert((await req('POST', '/api/inv/units', { body: { symbol: 'zz', decimal_places: 9 } })).status === 400, 'Decimal places above 4 are refused');
  assert((await req('DELETE', `/api/inv/units/${uomId}`)).status === 409 && (await req('DELETE', `/api/inv/units/${kg.id}`)).status === 200, 'A used unit cannot be deleted; an unused one can');

  console.log('\n--- 5. Warehouses ---');
  const whs = await D('GET', '/api/inv/warehouses');
  const W1 = whs[0], W2 = whs[1];
  assert(whs.length >= 3 && whs.every((w) => w.code), 'The existing warehouses are listed with codes');
  const nw = await D('POST', '/api/inv/warehouses', { body: { name: 'Coimbatore Depot', city: 'Coimbatore', phone: '0422 2345678', email: 'depot@example.com' } });
  assert(nw.id && /^WH-\d\d$/.test(nw.code) && nw.is_active === 1, 'A warehouse is created with an automatic code');
  assert((await req('POST', '/api/inv/warehouses', { body: { name: 'coimbatore depot' } })).status === 409 && (await req('POST', '/api/inv/warehouses', { body: { name: 'Another', code: nw.code } })).status === 409, 'Duplicate warehouse name or code is refused');
  assert((await req('POST', '/api/inv/warehouses', { body: { name: 'Bad Mail', email: 'nope' } })).status === 400, 'An invalid e-mail is refused');
  assert((await D('PATCH', `/api/inv/warehouses/${nw.id}`, { body: { name: 'Coimbatore Depot', city: 'Coimbatore North' } })).city === 'Coimbatore North', 'A warehouse can be edited');
  assert((await D('POST', `/api/inv/warehouses/${nw.id}/archive`)).is_active === 0 && (await D('POST', `/api/inv/warehouses/${nw.id}/restore`)).is_active === 1, 'An empty warehouse can be archived and restored');
  assert((await req('POST', `/api/inv/warehouses/${W1.id}/archive`)).status === 409, 'A warehouse holding stock cannot be archived');
  assert((await req('POST', `/api/inv/warehouses/${nw.id}/archive`, { token: clerk })).status === 403, 'Data Entry cannot archive a warehouse');

  console.log('\n--- 6. Purchases and sales move stock (accounting integration) ---');
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const elgi = await L('Elgi Equipments Spares Ltd'), chennai = await L('Chennai Auto Components Pvt Ltd'), purAcc = await L('Purchase Account - Spares & Machines'), salesAcc = await L('Sales Account - Compressors');
  const post = (type, no, party, lines, inventory) => req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: no, date: '2026-07-01', party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })), inventory } });
  const pv = await post('Purchase', 'INVT/P1', elgi, [[purAcc, 600, 0], [elgi, 0, 600]], [{ stock_item_id: bolt.id, quantity: 60, rate: 10, godown_id: W2.id }]);
  assert(pv.json.success, 'A purchase voucher with stock is recorded');
  let b2 = await D('GET', `/api/inv/items/${bolt.id}`);
  assert(b2.on_hand === 160 && b2.warehouses.find((w) => w.id === W2.id).on_hand === 60 && b2.warehouses.find((w) => w.id === W1.id).on_hand === 100, 'The purchase raised stock by 60 in the receiving warehouse (opening 100 stays in the first)');
  const sv = await post('Sales', 'INVT/S1', chennai, [[chennai, 354, 0], [salesAcc, 0, 354]], [{ stock_item_id: bolt.id, quantity: 20, rate: 15, godown_id: W1.id }]);
  b2 = await D('GET', `/api/inv/items/${bolt.id}`);
  assert(sv.json.success && b2.on_hand === 140 && b2.warehouses.find((w) => w.id === W1.id).on_hand === 80, 'The sales voucher reduced stock by 20 in its warehouse');
  const mv = await D('GET', `/api/inv/movements?item=${bolt.id}`);
  assert(mv.items.some((m) => m.number === 'INVT/P1' && m.direction === 'IN' && m.quantity === 60) && mv.items.some((m) => m.number === 'INVT/S1' && m.direction === 'OUT'), 'Both vouchers appear in the movement history with their voucher numbers');
  await req('DELETE', `/api/vouchers/${sv.json.id}`);
  assert((await D('GET', `/api/inv/items/${bolt.id}`)).on_hand === 160, 'Deleting a voucher puts the stock back (one source of truth)');
  await post('Sales', 'INVT/S2', chennai, [[chennai, 354, 0], [salesAcc, 0, 354]], [{ stock_item_id: bolt.id, quantity: 20, rate: 15, godown_id: W1.id }]);

  console.log('\n--- 7. Transfers ---');
  const vBefore = await calculateClosingStockValuation(), drBefore = await dr();
  const tr = (b, token) => req('POST', '/api/inv/transfers', { token, body: b });
  assert((await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 10 }] }, clerk)).status === 403 && (await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 10 }] }, viewer)).status === 403, 'Data Entry and Viewer cannot transfer stock');
  const t1 = await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 30 }], note: 'Rebalance' }, acc);
  assert(t1.status === 200 && t1.json.data.number === 'TR-00001' && t1.json.data.lines.length === 2 && t1.json.data.from_warehouse === W1.name, 'An Accountant transfers 30: numbered TR-00001, one OUT and one IN line');
  b2 = await D('GET', `/api/inv/items/${bolt.id}`);
  assert(b2.on_hand === 140 && b2.warehouses.find((w) => w.id === W1.id).on_hand === 50 && b2.warehouses.find((w) => w.id === W2.id).on_hand === 90, 'Total unchanged (140); stock rebalanced to 50 and 90', JSON.stringify(b2.warehouses));
  const vAfter = await calculateClosingStockValuation(), drAfter = await dr();
  assert(near(vAfter.totalStockValuation, vBefore.totalStockValuation) && drAfter.d === drBefore.d && drAfter.c === drBefore.c, 'A transfer changes neither the stock valuation nor any ledger');
  assert((await tr({ from_warehouse_id: W1.id, to_warehouse_id: W1.id, lines: [{ item_id: bolt.id, qty: 1 }] }, acc)).status === 400, 'The same warehouse twice is refused');
  const over = await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 51 }] }, acc);
  assert(over.status === 409 && /Not enough/.test(over.json.error), 'Taking more than is available is refused with the numbers');
  assert((await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 0 }] }, acc)).status === 400 && (await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [] }, acc)).status === 400 && (await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 1 }, { item_id: bolt.id, qty: 1 }] }, acc)).status === 400, 'Zero quantity, no lines and a repeated item are refused');
  const countBefore = (await get('SELECT COUNT(*) c FROM inv_docs')).c, ieBefore = (await get('SELECT COUNT(*) c FROM inventory_entries')).c;
  const half = await tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: bolt.id, qty: 5 }, { item_id: wire.id, qty: 5 }] }, acc);
  assert(half.status === 409 && (await get('SELECT COUNT(*) c FROM inv_docs')).c === countBefore && (await get('SELECT COUNT(*) c FROM inventory_entries')).c === ieBefore, 'If one line fails nothing at all is recorded (all-or-nothing)');
  const arch = await D('POST', '/api/inv/warehouses', { body: { name: 'Closed Depot' } }); await D('POST', `/api/inv/warehouses/${arch.id}/archive`);
  assert((await tr({ from_warehouse_id: W1.id, to_warehouse_id: arch.id, lines: [{ item_id: bolt.id, qty: 1 }] }, acc)).status === 422, 'Transferring into an archived warehouse is refused');
  const tdoc = await D('GET', '/api/inv/transfers');
  assert(tdoc.total === 1 && tdoc.items[0].number === 'TR-00001', 'The transfer list shows the document');
  assert((await get(`SELECT voucher_type FROM vouchers WHERE voucher_no = 'TR-00001'`)).voucher_type === 'Stock Journal', 'It is stored as a Stock Journal voucher (visible in the books)');

  console.log('\n--- 8. Concurrent transfers never over-draw stock ---');
  const racer = await D('POST', '/api/inv/items', { body: itemBody({ name: 'Race Item', sku: 'RACE-1', opening_qty: 10, opening_rate: 5, reorder_level: 0 }) });
  const results = await Promise.all(Array.from({ length: 8 }, () => tr({ from_warehouse_id: W1.id, to_warehouse_id: W2.id, lines: [{ item_id: racer.id, qty: 4 }] }, acc)));
  const okN = results.filter((r) => r.status === 200).length, left = (await D('GET', `/api/inv/items/${racer.id}`)).warehouses.find((w) => w.id === W1.id).on_hand;
  assert(okN === 2 && left === 2 && results.filter((r) => r.status === 409).length === 6, `Eight simultaneous requests for 4 of 10: exactly 2 succeed, 6 are refused, 2 remain (got ${okN} ok, ${left} left)`);
  const nums = (await D('GET', '/api/inv/transfers?page_size=50')).items.map((x) => x.number);
  assert(new Set(nums).size === nums.length, 'Document numbers are unique under concurrency');

  console.log('\n--- 9. Adjustments ---');
  const adj = (b, token = acc) => req('POST', '/api/inv/adjustments', { token, body: b });
  const vA = await calculateClosingStockValuation();
  const a1 = await adj({ warehouse_id: W2.id, reason: 'Damaged goods', lines: [{ item_id: bolt.id, delta: -5 }], note: 'water damage' });
  assert(a1.status === 200 && a1.json.data.number === 'ADJ-00001' && (await D('GET', `/api/inv/items/${bolt.id}`)).warehouses.find((w) => w.id === W2.id).on_hand === 85, 'A reduction of 5 is recorded (ADJ-00001) and stock falls');
  const vB = await calculateClosingStockValuation();
  assert(near(vA.totalStockValuation - vB.totalStockValuation, 5 * 10), 'The closing-stock valuation falls by 5 × cost (₹50): the profit effect is automatic');
  const a2 = await adj({ warehouse_id: W2.id, reason: 'Stock count correction', lines: [{ item_id: bolt.id, new_qty: 100 }] });
  assert(a2.status === 200 && (await D('GET', `/api/inv/items/${bolt.id}`)).warehouses.find((w) => w.id === W2.id).on_hand === 100 && a2.json.data.lines.length === 1 && a2.json.data.lines[0].direction === 'IN' && a2.json.data.lines[0].quantity === 15, 'A counted quantity of 100 is turned into +15');
  assert((await adj({ warehouse_id: W2.id, reason: 'Stock count correction', lines: [{ item_id: bolt.id, new_qty: 100 }] })).status === 400, 'A count that matches the books records nothing');
  assert((await adj({ warehouse_id: W2.id, reason: 'Lost / stolen', lines: [{ item_id: bolt.id, delta: -1000 }] })).status === 409, 'An adjustment cannot make stock negative');
  assert((await adj({ warehouse_id: W2.id, reason: 'Because', lines: [{ item_id: bolt.id, delta: 1 }] })).status === 400 && (await adj({ warehouse_id: W2.id, reason: 'Found stock', lines: [{ item_id: bolt.id, delta: 0 }] })).status === 400 && (await adj({ warehouse_id: W2.id, reason: 'Found stock', lines: [{ item_id: bolt.id, new_qty: -2 }] })).status === 400, 'An unknown reason, a zero change and a negative count are refused');
  assert((await adj({ warehouse_id: W2.id, reason: 'Found stock', lines: [{ item_id: bolt.id, delta: 1 }] }, clerk)).status === 403, 'Data Entry cannot adjust stock');
  assert((await D('GET', '/api/inv/adjustments')).total === 2 && (await D('GET', '/api/inv/adjustment-reasons')).includes('Damaged goods'), 'Adjustments are listed; the reasons are available');
  assert(near((await dr()).d, drAfter.d) && (await dr()).d === (await dr()).c, 'Adjustments post no ledger entries: debits still equal credits');

  console.log('\n--- 10. Movement history, stock levels, alerts, dashboard ---');
  const mvB = await D('GET', `/api/inv/movements?item=${bolt.id}&warehouse=${W2.id}&page_size=50`);
  assert(mvB.items.every((m) => m.balance !== undefined) && mvB.items[0].balance === 100, 'With one item and one warehouse selected, each row carries a running balance (latest = 100)');
  assert((await D('GET', '/api/inv/movements?type=Stock%20Journal')).items.every((m) => m.type === 'Stock Journal') && (await D('GET', '/api/inv/movements?direction=IN')).items.every((m) => m.direction === 'IN'), 'Movements filter by type and direction');
  assert((await D('GET', '/api/inv/movements?from=2099-01-01')).total === 0, 'A date filter with no matches returns nothing');
  assert((await D('GET', '/api/inv/movements?page_size=2&page=1')).items.length === 2, 'Movements are paginated');
  const st = await D('GET', '/api/inv/stock');
  assert(st.items.some((r) => r.item_id === bolt.id && r.warehouse_id === W2.id && r.on_hand === 100 && r.available === 100) && st.items.every((r) => r.value === undefined || typeof r.value === 'number'), 'Stock levels list item × warehouse with available quantity');
  assert((await D('GET', '/api/inv/stock', { token: clerk })).items.every((r) => r.value === undefined), 'Data Entry sees stock levels without values');
  const al = await D('GET', '/api/inv/alerts');
  assert(al.items.some((a) => a.id === wire.id && a.status === 'out' && a.shortfall === 50), 'An item with a reorder level and no stock is an alert (shortfall 50)');
  await adj({ warehouse_id: W1.id, reason: 'Found stock', lines: [{ item_id: wire.id, delta: 20 }] });
  assert((await D('GET', '/api/inv/alerts')).items.find((a) => a.id === wire.id).status === 'low', 'After receiving 20 of a reorder level of 50 it is "low", no longer "out"');
  const dash = await D('GET', '/api/inv/dashboard');
  assert(dash.kpis.items >= 3 && dash.kpis.stock_value > 0 && dash.kpis.low >= 1 && dash.warehouses.length >= 3 && Array.isArray(dash.series) && dash.recent.length > 0, 'The dashboard reports items, value, low stock, warehouses, a 30-day series and recent movements');
  assert((await D('GET', '/api/inv/dashboard', { token: clerk })).kpis.stock_value === undefined, 'The dashboard hides stock value from Data Entry');

  console.log('\n--- 11. Archiving and deleting items ---');
  assert((await req('POST', `/api/inv/items/${bolt.id}/archive`)).status === 409, 'An item with stock cannot be archived');
  const lone = await D('POST', '/api/inv/items', { body: itemBody({ name: 'Lonely Item', sku: 'LONE-1', opening_qty: 0 }) });
  assert((await D('POST', `/api/inv/items/${lone.id}/archive`)).is_active === 0 && (await D('GET', '/api/inv/items?q=Lonely')).total === 0 && (await D('GET', '/api/inv/items?q=Lonely&archived=1')).total === 1, 'An item with no stock can be archived; it leaves the list and shows under archived');
  assert((await D('POST', `/api/inv/items/${lone.id}/restore`)).is_active === 1, 'and restored');
  assert((await req('DELETE', `/api/inv/items/${lone.id}`, { token: acc })).status === 403, 'Only an Owner may delete (permission)');
  assert((await req('DELETE', `/api/inv/items/${lone.id}`)).status === 200 && (await req('DELETE', `/api/inv/items/${bolt.id}`)).status === 409, 'An item without history can be deleted; one with history cannot');
  assert((await req('GET', '/api/inv/items/abc')).status === 400 && (await req('GET', '/api/inv/items/99999')).status === 404, 'Bad or unknown ids give clear errors');

  console.log('\n--- 12. The rest of RRE still works with Stock Journal vouchers present ---');
  for (const p of ['/api/reports/stock-summary', '/api/reports/daybook', '/api/reports/trial-balance', '/api/reports/balance-sheet', '/api/reports/profit-loss', '/api/vouchers']) assert((await req('GET', p)).status === 200, `GET ${p} still works`);
  const tb = (await D('GET', '/api/reports/trial-balance'));
  assert(tb.is_balanced === true, 'The trial balance is still balanced');
  const rd = await D('GET', '/api/yearend/readiness?from=2026-04-01&to=2027-03-31');
  assert(rd.checks.find((c) => c.key === 'unbalanced').status === 'pass', 'The year-end check finds no unbalanced vouchers');
  const so = await D('GET', '/api/search?q=TR-0000');
  assert(so.vouchers.some((v) => v.voucher_no === 'TR-00001'), 'Smart search finds the transfer voucher by number');

  console.log('\n--- 13. Speed with many items ---');
  await run('BEGIN');
  for (let i = 0; i < 3000; i++) await run(`INSERT INTO stock_items (name, stock_group_id, uom_id, opening_qty, opening_rate, opening_val, reorder_level, sku) VALUES (?, ?, ?, ?, 5, ?, 10, ?)`, [`Bulk Item ${i}`, cat0.id, uomId, i % 50, (i % 50) * 5, `BULK-${i}`]);
  await run('COMMIT');
  const t0 = Date.now(); const big = await D('GET', '/api/inv/items?page_size=25&page=3&sort=stock'); const ms = Date.now() - t0;
  assert(big.total >= 3000 && big.items.length === 25 && ms < 2500, `A page of 25 from 3,000 items takes ${ms} ms`);
  const t9 = Date.now(); await D('GET', '/api/inv/dashboard'); const dms = Date.now() - t9; assert(dms < 4000, `The dashboard over 3,000 items takes ${dms} ms`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

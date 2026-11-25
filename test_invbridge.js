process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Original inventory application (StockPilot) <-> RRE books.
 * Starts the REAL inventory backend (inventory-app/, FastAPI + its own database), does real work through ITS API, and checks that RRE's
 * books follow: purchases, sales, transfers and adjustments, exactly once each, with history left alone and failures contained.
 * Needs Python with the inventory requirements (inventory-app/backend/.venv).   npm run test:invbridge
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_invbridge_test_'));
process.env.RRE_DATA_DIR = tmp;
process.env.RRE_INVENTORY_SEED = '0';  // start from an empty inventory database, not a copy of the real one
process.env.RRE_BRIDGE_AUTO = '0';     // the test runs the synchronisation itself

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const host = require('./core/inventoryHost');
const bridge = require('./core/invBridge');
const { calculateClosingStockValuation } = require('./core/accountingEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(13600 + Math.floor(Math.random() * 90), '127.0.0.1');
  const rre = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry');
  const rreReq = (m, p, token = admin, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(rre + p, { method: m, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  console.log('\n--- 0. Start the real inventory application ---');
  const py = await host.findPython();
  if (!py) { console.log('  (Python with the inventory requirements was not found: this suite is skipped)'); process.exit(0); }
  const l = await rreReq('POST', '/api/inventory-app/launch', admin, {});
  assert(l.status === 200 && /^http:\/\/127\.0\.0\.1:\d+\//.test(l.json.data.url), 'RRE starts the original inventory application on a private local port', JSON.stringify(l.json));
  const sp = `http://127.0.0.1:${host._state.port}`;
  const spReq = async (m, p, token, body, form) => { const r = await fetch(sp + p, { method: m, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : form }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j }; };
  const sso = new URL(l.json.data.url).searchParams.get('sso');
  const su = await spReq('POST', '/api/rre/sso', null, { token: sso });
  assert(su.status === 200 && su.json.access_token, 'RRE signs its administrator in to the empty inventory as its owner (no second login, no sign-up)', JSON.stringify(su.json).slice(0, 150));
  assert((await spReq('POST', '/api/rre/sso', null, { token: sso })).status === 401, 'the sign-in link works once');
  assert((await spReq('POST', '/api/auth/signup', null, { org_name: 'X', name: 'X Y', email: 'x@example.com', password: 'password123' })).status === 410 && (await spReq('POST', '/api/auth/login', null, { email: 'x@example.com', password: 'password123' })).status === 410 && (await spReq('POST', '/api/auth/forgot', null, { email: 'x@example.com' })).status === 410, 'the inventory application has no sign-up, login or password reset of its own');
  // one identity: an RRE employee reaches Inventory through their RRE session, with the role RRE gives them (never an administrator)
  const ins = await run("INSERT INTO users (username, password, full_name, role, email, status) VALUES ('invemp', '" + require('./core/security').hashPassword('Employee#Pass2026x') + "', 'Inv Employee', 'Data Entry', 'inv.employee@example.com', 'Active')");
  const empLogin = await rreReq('POST', '/api/auth/login', null, { identifier: 'inv.employee@example.com', password: 'Employee#Pass2026x', login_type: 'employee' });
  const empTok = empLogin.json && empLogin.json.data && empLogin.json.data.token;
  const el = await rreReq('POST', '/api/inventory-app/launch', empTok, {});
  const esso = el.status === 200 && new URL(el.json.data.url).searchParams.get('sso');
  const es = esso ? await spReq('POST', '/api/rre/sso', null, { token: esso }) : { status: 0, json: {} };
  assert(es.status === 200 && es.json.user && es.json.user.role === 'warehouse' && es.json.user.email === 'inv.employee@example.com', 'An RRE employee is signed in to Inventory with no second login, as a warehouse user (never an administrator)', JSON.stringify(es.json).slice(0, 200));
  const adminAttempt = await spReq('GET', '/api/users', es.json.access_token);
  assert(adminAttempt.status === 410, 'The inventory user list is closed: accounts are managed in RRE');
  await run("UPDATE users SET status = 'Inactive' WHERE id = ?", [ins.lastID]); // as a legacy screen or the portal would
  await new Promise((r) => setTimeout(r, 1200));
  const afterOff = await spReq('GET', '/api/auth/me', es.json.access_token); assert([401, 403].includes(afterOff.status), 'Deactivating the person in RRE ends their inventory session', afterOff.status + ' ' + JSON.stringify(afterOff.json).slice(0, 120));
  const el2 = await rreReq('POST', '/api/inventory-app/launch', empTok, {});
  assert(el2.status === 401, 'A deactivated account cannot open Inventory');
  assert((await rreReq('POST', '/api/inventory-app/launch', T(ins.lastID + 999, 'ghost', 'Data Entry'), {})).status === 401, 'An unknown account cannot open Inventory');
  const H = su.json.access_token;
  const sp_ = (m, p, b) => spReq(m, p, H, b);
  await sp_('PATCH', '/api/organization', { gstin: '33ABCDE1234F1Z5', state: 'Tamil Nadu' });
  const whs = (await sp_('GET', '/api/warehouses')).json, main = whs[0].id;
  const second = (await sp_('POST', '/api/warehouses', { code: 'W2', name: 'Bridge Second' })).json.id;
  const vendor = (await sp_('POST', '/api/vendors', { name: 'Bridge Vendor', gstin: '33AAACB1234C1Z5', bill_state: 'Tamil Nadu' })).json;
  const cust = (await sp_('POST', '/api/customers', { name: 'Bridge Customer', gstin: '33AABCL1111A1Z1', ship_state: 'Tamil Nadu' })).json;
  const bolt = (await sp_('POST', '/api/products', { name: 'Bridge Bolt', sku: 'BB-1', purchase_price: 100, selling_price: 150, tax_rate: 18 })).json;
  const nut = (await sp_('POST', '/api/products', { name: 'Bridge Nut', sku: 'BN-1', purchase_price: 40, selling_price: 70, tax_rate: 12 })).json;
  assert(vendor.id && cust.id && bolt.id && nut.id && second, 'Vendor, customer, two products and a second warehouse exist in the inventory application');
  const receive = async (qty, prod = bolt, wh = main, rate = 100) => {
    const po = (await sp_('POST', '/api/purchase-orders', { vendor_id: vendor.id, warehouse_id: wh, lines: [{ product_id: prod.id, quantity: qty, rate }] })).json;
    await sp_('POST', `/api/purchase-orders/${po.id}/issue`);
    const r = await sp_('POST', `/api/purchase-orders/${po.id}/receive`, { warehouse_id: wh, lines: [{ po_line_id: po.lines[0].id, quantity: qty }] });
    return { po, grn: r.json, status: r.status };
  };
  const sell = async (qty, prod = bolt, discount = 0, ship = true) => {
    const so = (await sp_('POST', '/api/sales-orders', { customer_id: cust.id, warehouse_id: main, lines: [{ product_id: prod.id, quantity: qty, discount_pct: discount }] })).json;
    await sp_('POST', `/api/sales-orders/${so.id}/confirm`);
    const pk = (await sp_('POST', `/api/sales-orders/${so.id}/packages`, { lines: so.lines.map((x) => ({ so_line_id: x.id, quantity: x.quantity })) })).json;
    const sh = (await sp_('POST', `/api/packages/${pk.id}/shipment`, { carrier: 'Bridge Carrier', shipping_date: new Date().toISOString().slice(0, 10) })).json;
    if (ship) await sp_('POST', `/api/shipments/${sh.id}/status`, { status: 'shipped' });
    return { so, sh };
  };

  console.log('\n--- 1. What already existed is history, not posted ---');
  const old = await receive(10);
  assert(old.status === 201 && /^GRN-/.test(old.grn.number), 'A goods receipt of 10 bolts exists BEFORE the accounting link starts', JSON.stringify(old.grn).slice(0, 120));
  const base = await bridge.syncOnce();
  assert(base.history_marked >= 1 && Object.values(base.posted).every((n) => n === 0) && base.failed.length === 0, 'The first run marks existing documents as history and posts nothing', JSON.stringify(base));
  // regression: the link belongs to THIS inventory database (organisation number + creation time), not to "organisation 1" of any database
  const baseRows = await all("SELECT source FROM inv_bridge_events WHERE kind = 'baseline'");
  assert(baseRows.some((r) => /^stockpilot:\d+@[0-9a-f]{12}$/.test(r.source)) && baseRows.filter((r) => /^stockpilot:\d+@/.test(r.source)).length === 1,
    'The accounting link is tied to this specific inventory database (a new inventory database never inherits an older one\'s link)', JSON.stringify(baseRows));
  assert((await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no LIKE 'SP-%'")).c === 0, 'No voucher was created for history');

  console.log('\n--- 2. Purchases ---');
  const p1 = await receive(6);
  const r1 = await bridge.syncOnce();
  assert(r1.posted.purchases === 1 && r1.failed.length === 0, 'A new goods receipt (6 bolts) is posted to the books', JSON.stringify(r1));
  const pv = await get(`SELECT * FROM vouchers WHERE voucher_no = 'SP-${p1.grn.number}'`);
  assert(pv && pv.voucher_type === 'Purchase' && near(pv.total_amount, 708) && /GRN/.test(pv.reference_no), 'It is a Purchase voucher for ₹708 (6 × ₹100 + 18% GST)', JSON.stringify(pv));
  const pe = await all('SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?', [pv.id]);
  const sumD = pe.reduce((t, x) => t + x.d, 0), sumC = pe.reduce((t, x) => t + x.c, 0);
  assert(near(sumD, sumC) && pe.some((x) => x.name === 'Bridge Vendor' && near(x.c, 708)) && pe.some((x) => /Input CGST/.test(x.name) && near(x.d, 54)) && pe.some((x) => /Input SGST/.test(x.name) && near(x.d, 54)) && pe.some((x) => /Purchase/.test(x.name) && near(x.d, 600)), 'The entries balance: supplier credited ₹708, purchases ₹600, input CGST ₹54 + SGST ₹54', JSON.stringify(pe));
  const boltRre = await get("SELECT id FROM stock_items WHERE name = 'Bridge Bolt'");
  const stockOf = async (item, wh) => (await get(`SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0) q FROM inventory_entries WHERE stock_item_id = ? ${wh ? 'AND godown_id = ' + wh : ''}`, [item])).q;
  assert(boltRre && (await stockOf(boltRre.id)) === 6, 'RRE stock of Bridge Bolt is 6 (only the new receipt; the history receipt is not counted)');
  const ven = await get("SELECT l.id, g.name grp FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.name = 'Bridge Vendor'");
  assert(ven && /Creditors/.test(ven.grp) && (await get('SELECT COUNT(*) c FROM bill_allocations WHERE voucher_id = ?', [pv.id])).c === 1, 'The supplier was created under Sundry Creditors and a bill was opened');
  const nutLine = await receive(5, nut, main, 40);
  await bridge.syncOnce();
  const nv = await get(`SELECT total_amount FROM vouchers WHERE voucher_no = 'SP-${nutLine.grn.number}'`);
  assert(nv && near(nv.total_amount, 224), 'A second product with a different GST rate (12%) is posted correctly: 5 × ₹40 + 12% = ₹224');

  console.log('\n--- 3. Sales (posted when the shipment is dispatched) ---');
  const s1 = await sell(4, bolt, 10, false);
  const r2 = await bridge.syncOnce();
  assert(r2.posted.sales === 0 && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales' AND voucher_no LIKE 'SP-%'")).c === 0, 'A shipment that is only "ready to ship" is NOT posted yet', JSON.stringify([r2, s1.sh.status, s1.sh.number, await all("SELECT voucher_type, voucher_no FROM vouchers WHERE voucher_no LIKE 'SP-%'"), await all('SELECT kind, src_id, status, number FROM inv_bridge_events')]));
  await sp_('POST', `/api/shipments/${s1.sh.id}/status`, { status: 'shipped' });
  const r3 = await bridge.syncOnce();
  assert(r3.posted.sales === 1 && r3.failed.length === 0, 'Once dispatched, the sale is posted', JSON.stringify(r3));
  const sv = await get(`SELECT * FROM vouchers WHERE voucher_no = 'SP-${s1.sh.number}'`);
  assert(sv && sv.voucher_type === 'Sales' && near(sv.total_amount, 637, 0.51), 'It is a Sales voucher for about ₹637 (4 × ₹150 less 10% = ₹540, + 18% GST = ₹637.20)', JSON.stringify(sv));
  const se = await all('SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?', [sv.id]);
  assert(near(se.reduce((t, x) => t + x.d, 0), se.reduce((t, x) => t + x.c, 0)) && se.some((x) => x.name === 'Bridge Customer' && x.d > 636) && se.some((x) => /Output CGST/.test(x.name) && near(x.c, 48.6)), 'The entries balance: customer debited, sales credited, output CGST ₹48.60', JSON.stringify(se));
  assert((await stockOf(boltRre.id)) === 2, 'RRE stock of Bridge Bolt falls from 6 to 2');
  assert((await get('SELECT COUNT(*) c FROM bill_allocations WHERE voucher_id = ?', [sv.id])).c === 1, 'A receivable bill is opened for the customer');

  console.log('\n--- 4. Transfers and adjustments ---');
  const tr = await sp_('POST', '/api/transfers', { from_warehouse_id: main, to_warehouse_id: second, lines: [{ product_id: bolt.id, quantity: 1 }] });
  assert(tr.status === 201, 'A transfer of 1 bolt to the second warehouse is made in the inventory application', JSON.stringify(tr.json).slice(0, 120));
  const adj = await sp_('POST', '/api/adjustments', { adj_type: 'damage', warehouse_id: main, reason: 'Dropped in the yard', lines: [{ product_id: bolt.id, quantity: 1 }] });
  assert(adj.status === 201, 'A damage adjustment of 1 bolt is recorded', JSON.stringify(adj.json).slice(0, 120));
  const r4 = await bridge.syncOnce();
  assert(r4.posted.transfers === 1 && r4.posted.adjustments === 1 && r4.failed.length === 0, 'Both are posted as Stock Journals', JSON.stringify(r4));
  const g2 = (await get("SELECT id FROM godowns WHERE name = 'Bridge Second'"));
  assert(g2 && (await stockOf(boltRre.id, g2.id)) === 1, 'The transfer put 1 bolt in the second warehouse');
  assert((await stockOf(boltRre.id)) === 1, 'The damage adjustment took 1 off: 1 bolt in total (6 − 4 sold − 1 damaged)');
  assert((await get("SELECT COUNT(*) c FROM inv_docs WHERE note LIKE 'StockPilot %'")).c === 2 && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Stock Journal'")).c >= 2, 'They are recorded as Stock Journal vouchers noting their inventory numbers');
  const val = await calculateClosingStockValuation();
  assert(val.totalStockValuation > 0, 'RRE\'s closing-stock valuation includes the stock that came through the link', String(val.totalStockValuation));

  console.log('\n--- 5. Exactly once ---');
  const count = async () => JSON.stringify([(await get('SELECT COUNT(*) c FROM vouchers')).c, (await get('SELECT COUNT(*) c FROM inventory_entries')).c, (await get('SELECT COUNT(*) c FROM ledger_entries')).c, (await get('SELECT COUNT(*) c FROM bill_allocations')).c]);
  const before = await count();
  const again = await bridge.syncOnce();
  assert(Object.values(again.posted).every((n) => n === 0) && (await count()) === before, 'Running the link again posts nothing');
  const par = await Promise.all(Array.from({ length: 5 }, () => bridge.syncOnce({ force: true })));
  assert((await count()) === before && par.filter((x) => !x.skipped).length >= 1, 'Five synchronisations at once change nothing either (one runs, the rest step aside)');
  const q1 = await sell(1, bolt, 0, true);
  const par2 = await Promise.all(Array.from({ length: 5 }, () => bridge.syncOnce()));
  assert((await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'SP-${q1.sh.number}'`)).c === 1 && par2.reduce((t, x) => t + (x.posted ? x.posted.sales : 0), 0) === 1, 'A new sale reached by five simultaneous runs is posted exactly once');

  console.log('\n--- 6. A failure is contained and recoverable ---');
  await run("UPDATE ledgers SET is_active = 0 WHERE name LIKE 'Output CGST%'");
  const bad = await sell(1, bolt, 0, true);
  const good = await receive(3);
  const r5 = await bridge.syncOnce();
  assert(r5.failed.length === 1 && r5.failed[0].number === bad.sh.number && /Output CGST/.test(r5.failed[0].reason) && r5.posted.purchases === 1, 'A sale that cannot be posted (a ledger is missing) is reported with the reason, while the purchase after it still posts', JSON.stringify(r5));
  assert((await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'SP-${bad.sh.number}'`)).c === 0 && (await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'SP-${good.grn.number}'`)).c === 1, 'Nothing half-posted: no voucher for the failed sale');
  const st = await rreReq('GET', '/api/inv/bridge/status', acc);
  assert(st.status === 200 && st.json.data.failed.length === 1 && st.json.data.failed[0].number === bad.sh.number && st.json.data.counts.length >= 1, 'The status page lists the failed document and its reason', JSON.stringify(st.json).slice(0, 500));
  const quick = await bridge.syncOnce();
  assert(quick.failed.length === 0 && quick.retried === 0, 'It is not retried every few seconds (it waits)');
  await run("UPDATE ledgers SET is_active = 1 WHERE name LIKE 'Output CGST%'");
  const fixed = await rreReq('POST', '/api/inv/bridge/sync', acc, { force: true });
  assert(fixed.status === 200 && fixed.json.data.posted.sales === 1 && fixed.json.data.failed.length === 0, 'After the ledger is restored, a forced run posts it', JSON.stringify(fixed.json));
  assert((await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'SP-${bad.sh.number}'`)).c === 1, 'It now has its voucher, once');

  console.log('\n--- 7. Access and books integrity ---');
  assert((await rreReq('GET', '/api/inv/bridge/status', clerk)).status === 403 && (await rreReq('POST', '/api/inv/bridge/sync', clerk, {})).status === 403 && (await rreReq('GET', '/api/inv/bridge/status', null)).status === 401, 'Data Entry and signed-out callers cannot see or run the link');
  const unbalanced = await all('SELECT v.id FROM vouchers v LEFT JOIN ledger_entries e ON e.voucher_id = v.id WHERE v.voucher_type IN (\'Purchase\', \'Sales\') AND v.voucher_no LIKE \'SP-%\' GROUP BY v.id HAVING ABS(COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0)) > 0.005');
  assert(unbalanced.length === 0, 'Every voucher the link posted balances to the paisa');
  const ev = await all("SELECT status, COUNT(*) n FROM inv_bridge_events GROUP BY status");
  assert(ev.some((x) => x.status === 'history') && ev.some((x) => x.status === 'synced') && !ev.some((x) => x.status === 'failed'), 'The event table shows history and synced documents and no failures', JSON.stringify(ev));
  await run("UPDATE app_settings SET value = '0' WHERE key = 'inv_bridge_enabled'").catch(() => {});
  await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('inv_bridge_enabled', '0')").catch(() => {});
  const off = await bridge.syncOnce();
  assert(off.skipped && /switched off/.test(off.skipped), 'The accounting link can be switched off');
  await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('inv_bridge_enabled', '1')").catch(() => {});

  await host.stop();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error('FATAL', e); try { await host.stop(); } catch (x) { /* ignore */ } process.exit(1); });

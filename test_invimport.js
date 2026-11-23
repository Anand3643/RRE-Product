/**
 * Inventory suite, stage 3: one-time import of a StockPilot database.
 * Builds a synthetic StockPilot file (and also previews the real one if present), checks read-only access, preview-before-write,
 * duplicate matching, idempotent re-run, stock as adjustments, Owner-only access and the "not imported" report.
 * Runs against a DISPOSABLE data directory.   npm run test:invimport
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_invimport_test_'));
process.env.RRE_DATA_DIR = tmp;
const srcFile = path.join(tmp, 'stockpilot_test.db');

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function buildSource() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(srcFile, (e) => { if (e) return reject(e); });
    const stmts = [
      `CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT)`,
      `CREATE TABLE categories (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT)`,
      `CREATE TABLE products (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, sku TEXT, barcode TEXT, brand TEXT, description TEXT, hsn_code TEXT, tax_rate REAL, reorder_point REAL, selling_price REAL, avg_cost REAL, purchase_price REAL, unit TEXT, category_id INTEGER, parent_id INTEGER, is_archived INTEGER DEFAULT 0, status TEXT)`,
      `CREATE TABLE warehouses (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, code TEXT, city TEXT, address TEXT, contact_name TEXT, phone TEXT, email TEXT, is_active INTEGER DEFAULT 1)`,
      `CREATE TABLE stock_balances (id INTEGER PRIMARY KEY, org_id INTEGER, product_id INTEGER, warehouse_id INTEGER, on_hand REAL, reserved REAL)`,
      `CREATE TABLE customers (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, company_name TEXT, gstin TEXT, email TEXT, phone TEXT, bill_address TEXT, bill_city TEXT, bill_state TEXT, payment_terms INTEGER, credit_limit REAL, contact_person TEXT, notes TEXT, status TEXT)`,
      `CREATE TABLE vendors (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, company_name TEXT, gstin TEXT, email TEXT, phone TEXT, bill_address TEXT, bill_city TEXT, bill_state TEXT, payment_terms INTEGER, contact_person TEXT, notes TEXT, status TEXT)`,
      `CREATE TABLE users (id INTEGER PRIMARY KEY, org_id INTEGER, email TEXT, password_hash TEXT)`,
      `CREATE TABLE sales_orders (id INTEGER PRIMARY KEY, org_id INTEGER, number TEXT)`,
      `CREATE TABLE payments (id INTEGER PRIMARY KEY, org_id INTEGER, amount REAL)`,
      `INSERT INTO organizations VALUES (1, 'Acme Traders'), (2, 'Empty Org')`,
      `INSERT INTO categories VALUES (1, 1, 'Fasteners'), (2, 1, 'Spares Family'), (3, 2, 'Other Org Cat')`,
      // products: normal; metric unit; existing-in-RRE name; bad name; sku clash; bad hsn; archived; no category; org 2 product
      `INSERT INTO products (id, org_id, name, sku, barcode, brand, hsn_code, tax_rate, reorder_point, selling_price, avg_cost, unit, category_id, status) VALUES
        (1, 1, 'SP Hex Bolt', 'HB-001', '8900000000011', 'Acme', '7318', 18, 20, 12, 7, 'pcs', 1, 'active'),
        (2, 1, 'SP Grease', 'GR-001', NULL, NULL, 'XY', 28, 5, 250, 180, 'kg', 1, 'active'),
        (3, 1, 'SP Washer', 'HB-001', NULL, NULL, NULL, 18, 0, 2, 1, 'pcs', NULL, 'active'),
        (4, 1, 'X', 'BAD', NULL, NULL, NULL, 18, 0, 1, 1, 'pcs', 1, 'active'),
        (5, 1, 'SP Old Gasket', 'GK-001', NULL, NULL, NULL, 18, 0, 9, 4, 'pcs', 2, 'inactive'),
        (6, 1, 'Report Item Existing', 'EX-001', NULL, NULL, NULL, 18, 0, 9, 4, 'pcs', 1, 'active'),
        (7, 1, 'SP Spare No Stock', 'SN-001', NULL, NULL, NULL, 18, 0, 9, 4, 'pcs', 2, 'active'),
        (8, 2, 'Other Org Product', 'OO-001', NULL, NULL, NULL, 18, 0, 9, 4, 'pcs', 3, 'active')`,
      `INSERT INTO warehouses VALUES (1, 1, 'SP Main Warehouse', 'SPM', 'Chennai', '1 Mount Rd', 'Ravi', '9876543210', 'ravi@example.com', 1), (2, 1, 'SP Old Shed', 'SPO', 'Madurai', NULL, NULL, NULL, NULL, 0), (3, 2, 'Other Org WH', 'OOW', NULL, NULL, NULL, NULL, NULL, 1)`,
      `INSERT INTO stock_balances (org_id, product_id, warehouse_id, on_hand, reserved) VALUES (1, 1, 1, 100, 10), (1, 2, 1, 25.5, 0), (1, 3, 2, 40, 0), (1, 5, 1, 7, 0), (1, 6, 1, 99, 0), (1, 1, 2, 0, 0), (2, 8, 3, 5, 0)`,
      `INSERT INTO customers (id, org_id, name, company_name, gstin, email, phone, bill_address, bill_city, bill_state, payment_terms, credit_limit, contact_person, status) VALUES
        (1, 1, 'Meena', 'SP Customer One', '33AAAAA0000A1Z5', 'one@example.com', '9000000001', '5 Anna Salai', 'Chennai', 'Tamil Nadu', 30, 50000, 'Meena', 'active'),
        (2, 1, 'Bad Gstin Co', NULL, '33BAD', 'not-an-email', 'abc', NULL, NULL, 'Kerala', 15, 0, NULL, 'active'),
        (3, 1, 'Chennai Auto Components Pvt Ltd', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 30, 0, NULL, 'active')`,
      `INSERT INTO vendors (id, org_id, name, company_name, gstin, bill_city, bill_state, payment_terms, status) VALUES (1, 1, 'SP Supplier One', 'SP Supplier One Ltd', '29BBBBB1111B1Z5', 'Bengaluru', 'Karnataka', 45, 'active'), (2, 1, 'Z', NULL, NULL, NULL, NULL, 30, 'active')`,
      `INSERT INTO users VALUES (1, 1, 'owner@sp.test', 'hash1'), (2, 1, 'staff@sp.test', 'hash2')`,
      `INSERT INTO sales_orders VALUES (1, 1, 'SO-1'), (2, 1, 'SO-2')`,
      `INSERT INTO payments VALUES (1, 1, 100)`,
    ];
    let i = 0;
    const next = (err) => { if (err) return reject(err); if (i >= stmts.length) return db.close(() => resolve()); db.run(stmts[i++], next); };
    next();
  });
}

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(13400 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  await run('DELETE FROM vouchers'); await run('DELETE FROM inv_docs'); await run('DELETE FROM stock_items');
  // an item that already exists in RRE under the same name as a StockPilot product (id 6)
  const grp = (await get('SELECT id FROM stock_groups LIMIT 1')).id, uom = (await get('SELECT id FROM units_of_measure LIMIT 1')).id;
  await run('INSERT INTO stock_items (name, stock_group_id, uom_id, opening_qty, opening_rate, opening_val) VALUES (?, ?, ?, 0, 0, 0)', ['Report Item Existing', grp, uom]);
  const beforeLedgers = (await get('SELECT COUNT(*) c FROM ledgers')).c;
  await buildSource();
  const hashBefore = sha(srcFile);
  const P = (body, token = admin) => req('POST', '/api/inv/import/preview', { token, body });

  console.log('\n--- 1. Access ---');
  assert((await req('GET', '/api/inv/import/detect', { token: null })).status === 401, 'Detect needs a login');
  for (const [n, t] of [['Accountant', acc], ['Data Entry', clerk]]) {
    assert((await req('GET', '/api/inv/import/detect', { token: t })).status === 403 && (await P({ path: srcFile }, t)).status === 403 && (await req('POST', '/api/inv/import/run', { token: t, body: { path: srcFile, org_id: 1, confirm: true } })).status === 403, `${n} cannot detect, preview or run the import (Owner only)`);
  }
  assert((await req('GET', '/api/inv/import/detect')).status === 200, 'The Owner can ask where StockPilot is');

  console.log('\n--- 2. Choosing the file ---');
  assert((await P({})).status === 400 && (await P({ path: '' })).status === 400, 'No file given → asked to choose one');
  assert((await P({ path: path.join(tmp, 'notes.txt') })).status === 400, 'A non-database file name is refused');
  assert((await P({ path: path.join(tmp, 'missing.db') })).status === 404, 'A file that does not exist is 404');
  fs.writeFileSync(path.join(tmp, 'junk.db'), 'this is not sqlite');
  assert((await P({ path: path.join(tmp, 'junk.db') })).status === 400, 'A file that is not a database is refused');
  const other = path.join(tmp, 'other.db'); await new Promise((r) => { const d = new sqlite3.Database(other, () => d.run('CREATE TABLE t (a)', () => d.close(r))); });
  const notSp = await P({ path: other });
  assert(notSp.status === 400 && /does not look like a StockPilot/.test(notSp.json.error), 'A database that is not StockPilot is refused with a clear message');

  console.log('\n--- 3. Preview writes nothing ---');
  let pv = (await P({ path: srcFile })).json.data;
  assert(pv.step === 'choose_organisation' && pv.organisations.length === 2 && pv.organisations[0].items === 7 && pv.organisations[1].items === 1, 'Without an organisation, it lists them with item counts');
  assert((await P({ path: srcFile, org_id: 9 })).status === 404, 'An organisation that is not in the file is 404');
  pv = (await P({ path: srcFile, org_id: 1 })).json.data;
  const s = pv.summary;
  assert(pv.step === 'preview' && s.items.total === 7 && s.items.new === 5 && s.items.exists === 1 && s.items.invalid === 1, 'Preview: 7 items (5 new, 1 already in RRE, 1 invalid)', JSON.stringify(s.items));
  assert(s.customers.total === 3 && s.customers.new === 2 && s.customers.exists === 1 && s.suppliers.total === 2 && s.suppliers.invalid === 1, 'Preview: 3 customers (2 new, 1 already a ledger), 2 suppliers (1 invalid)', JSON.stringify([s.customers, s.suppliers]));
  assert(s.warehouses.total === 2 && s.warehouses.new === 2 && s.stock_lines === 4 && s.stock_units === 172.5, 'Preview: 2 warehouses, 4 stock lines totalling 172.5 (the existing item\'s stock is not imported)', JSON.stringify([s.warehouses, s.stock_lines, s.stock_units]));
  const w = pv.warnings.join(' | ');
  assert(/reserved/.test(w) && /HSN "XY"/.test(w) && /GSTIN "33BAD"/.test(w) && /already exists in RRE/.test(w) && /Chennai Auto Components/.test(w), 'Warnings cover reserved stock, bad HSN, bad GSTIN and existing records');
  assert(pv.not_imported.some((n) => n.what === 'User accounts' && n.count === 2) && pv.not_imported.some((n) => n.what === 'Sales orders' && n.count === 2) && pv.not_imported.some((n) => n.what === 'Payments'), 'It states what is NOT imported, with reasons (users, sales orders, payments)');
  assert(!JSON.stringify(pv).includes('hash1') && !JSON.stringify(pv).includes('owner@sp.test'), 'No password hashes or user emails leave the StockPilot file');
  assert((await get('SELECT COUNT(*) c FROM stock_items')).c === 1 && (await get('SELECT COUNT(*) c FROM ledgers')).c === beforeLedgers && (await get('SELECT COUNT(*) c FROM inv_import_map')).c === 0, 'After previewing, RRE is unchanged (nothing written)');
  assert(sha(srcFile) === hashBefore, 'The StockPilot file is byte-for-byte unchanged');

  console.log('\n--- 4. Running the import ---');
  assert((await req('POST', '/api/inv/import/run', { body: { path: srcFile, org_id: 1 } })).status === 400, 'The import will not run without explicit confirmation');
  assert((await get('SELECT COUNT(*) c FROM inv_import_map')).c === 0, '…and nothing was written by the refused call');
  const run1 = await req('POST', '/api/inv/import/run', { body: { path: srcFile, org_id: 1, confirm: true } });
  const o = run1.json.data;
  assert(run1.status === 200 && o.created.items === 5 && o.created.customers === 2 && o.created.suppliers === 1 && o.created.warehouses === 2 && o.created.stock_documents === 2, 'Created 5 items, 2 customers, 1 supplier, 2 warehouses and 2 stock documents', JSON.stringify(o));
  assert(o.matched.items === 1 && o.matched.parties === 1 && o.failed.length === 0 && o.skipped.length === 2, 'Matched 1 item and 1 party; none failed; 2 invalid records skipped with reasons', JSON.stringify([o.matched, o.failed, o.skipped]));
  assert(o.skipped.every((x) => x.reason) && o.not_imported.length >= 3, 'Every skipped record has a reason');
  assert((await get('SELECT COUNT(*) c FROM stock_items')).c === 6 && (await get('SELECT COUNT(*) c FROM ledgers')).c === beforeLedgers + 3, 'RRE now has 6 items (1 + 5) and 3 new ledgers (2 customers + 1 supplier)');
  assert(sha(srcFile) === hashBefore, 'The StockPilot file is still unchanged after the import');

  console.log('\n--- 5. What landed ---');
  const bolt = await get("SELECT * FROM stock_items WHERE name = 'SP Hex Bolt'");
  assert(bolt && bolt.sku === 'HB-001' && bolt.barcode === '8900000000011' && bolt.hsn_code === '7318' && bolt.gst_rate === 18 && bolt.reorder_level === 20 && bolt.standard_price === 12 && bolt.standard_cost === 7 && bolt.brand === 'Acme', 'Bolt came across with SKU, barcode, HSN, GST, reorder level, price, cost and brand', JSON.stringify(bolt));
  const grease = await get("SELECT * FROM stock_items WHERE name = 'SP Grease'");
  assert(grease && !grease.hsn_code && grease.gst_rate === 28, 'Grease: the invalid HSN was left out, GST kept');
  const washer = await get("SELECT * FROM stock_items WHERE name = 'SP Washer'");
  assert(washer && washer.sku && washer.sku !== 'HB-001', 'Washer clashed with the bolt\'s SKU, so it got a fresh one');
  assert((await get("SELECT g.name FROM stock_groups g JOIN stock_items i ON i.stock_group_id = g.id WHERE i.name = 'SP Washer'")).name === 'Imported Items', 'An item with no category lands in "Imported Items"');
  assert(!(await get("SELECT id FROM stock_items WHERE name IN ('X', 'Other Org Product')")), 'The invalid item and the other organisation\'s item were not imported');
  const kg = await get("SELECT u.* FROM units_of_measure u JOIN stock_items i ON i.uom_id = u.id WHERE i.name = 'SP Grease'");
  assert(kg && /^KG/i.test(kg.symbol), 'The "kg" unit mapped to RRE\'s kilogram unit (no duplicate unit created)', JSON.stringify(kg));
  const whs = await all("SELECT * FROM godowns WHERE name LIKE 'SP %' ORDER BY name");
  assert(whs.length === 2 && whs.find((x) => x.name === 'SP Main Warehouse').code === 'SPM' && whs.find((x) => x.name === 'SP Old Shed').is_active === 1 && o.warnings.some((m) => /Old Shed.*stays active/.test(m)), 'Warehouses imported with codes; the archived one holds stock, so it stays active with a warning');
  const lv = (await req('GET', '/api/inv/stock')).json.data;
  const rows = lv.rows || lv;
  const qty = (name, wh) => (rows.filter((r) => r.item_name === name || r.name === name || r.item === name).reduce((t, r) => t + ((wh == null || r.warehouse_id === wh || r.godown_id === wh) ? Number(r.qty ?? r.on_hand ?? r.quantity ?? 0) : 0), 0));
  const mainId = whs.find((x) => x.name === 'SP Main Warehouse').id, shedId = whs.find((x) => x.name === 'SP Old Shed').id;
  const sb = await all("SELECT e.stock_item_id item_id, e.godown_id, SUM(CASE WHEN e.direction = 'IN' THEN e.quantity ELSE -e.quantity END) q FROM inventory_entries e GROUP BY e.stock_item_id, e.godown_id");
  const stockOf = (itemName, gid) => { const it = sb.find((r) => r.godown_id === gid && r.item_id === itemName); return it ? it.q : 0; };
  const idOf = async (n) => (await get('SELECT id FROM stock_items WHERE name = ?', [n])).id;
  assert(stockOf(await idOf('SP Hex Bolt'), mainId) === 100 && stockOf(await idOf('SP Grease'), mainId) === 25.5 && stockOf(await idOf('SP Washer'), shedId) === 40 && stockOf(await idOf('SP Old Gasket'), mainId) === 7, 'Stock on hand matches StockPilot per warehouse (100, 25.5, 40, 7); reserved units are not subtracted', JSON.stringify(sb));
  assert(stockOf(await idOf('Report Item Existing'), mainId) === 0, 'The item that already existed did not receive StockPilot\'s 99 units');
  const docs = await all("SELECT * FROM inv_docs WHERE reason = 'Opening balance fix'");
  assert(docs.length === 2 && docs.every((d) => /StockPilot/.test(d.note || '')) && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Stock Journal'")).c === 2, 'Stock arrived as 2 "Opening balance fix" adjustments noted "Imported from StockPilot" (visible in movement history)');
  const cust = await get("SELECT * FROM ledgers WHERE name = 'SP Customer One'");
  assert(cust && cust.gstin === '33AAAAA0000A1Z5' && cust.state_code === '33' && cust.credit_period === 30, 'Customer imported with GSTIN, state code and credit period', JSON.stringify(cust));
  const badG = await get("SELECT * FROM ledgers WHERE name = 'Bad Gstin Co'");
  assert(badG && !badG.gstin && badG.state_code === '32', 'Customer with an invalid GSTIN: GSTIN dropped, state code taken from the state name (Kerala = 32)');
  assert((await get("SELECT COUNT(*) c FROM ledgers WHERE name = 'Chennai Auto Components Pvt Ltd'")).c === 1, 'A customer that already existed in RRE was not duplicated');
  assert(!(await get("SELECT id FROM ledgers WHERE name = 'Z'")), 'The one-letter supplier was not imported');
  assert(!!(await get("SELECT id FROM activity_log WHERE action = 'INV_IMPORT_STOCKPILOT'")), 'The import is recorded in the audit trail');
  assert((await get('SELECT COUNT(*) c FROM users WHERE username LIKE ?', ['%sp.test%'])).c === 0, 'No StockPilot user accounts were created');

  console.log('\n--- 6. Running it again ---');
  const snap = async () => JSON.stringify([(await get('SELECT COUNT(*) c FROM stock_items')).c, (await get('SELECT COUNT(*) c FROM ledgers')).c, (await get('SELECT COUNT(*) c FROM godowns')).c, (await get('SELECT COUNT(*) c FROM inventory_entries')).c, (await get('SELECT COUNT(*) c FROM vouchers')).c, (await get('SELECT COUNT(*) c FROM inv_docs')).c]);
  const s1 = await snap();
  const pv2 = (await P({ path: srcFile, org_id: 1 })).json.data;
  assert(pv2.summary.items.new === 0 && pv2.summary.items.imported === 5 && pv2.summary.customers.new === 0 && pv2.summary.warehouses.imported === 2, 'A second preview shows everything as already imported');
  const run2 = (await req('POST', '/api/inv/import/run', { body: { path: srcFile, org_id: 1, confirm: true } })).json.data;
  assert(Object.values(run2.created).every((n) => n === 0) && run2.failed.length === 0, 'A second run creates nothing', JSON.stringify(run2.created));
  assert((await snap()) === s1, 'Item, ledger, warehouse, stock-entry, voucher and document counts are exactly as before (no duplicates, no double stock)');
  // concurrency: two simultaneous runs of a fresh organisation
  const conc = await Promise.all([1, 2].map(() => req('POST', '/api/inv/import/run', { body: { path: srcFile, org_id: 2, confirm: true } })));
  const codes = conc.map((c) => c.status).sort();
  assert(codes.includes(200) && (codes[1] === 200 || codes[1] === 409), 'Two simultaneous imports: one runs, the other is refused or finds nothing left to do', JSON.stringify(codes));
  assert((await get("SELECT COUNT(*) c FROM stock_items WHERE name = 'Other Org Product'")).c === 1, 'The second organisation\'s product exists exactly once after simultaneous runs');

  console.log('\n--- 7. The real StockPilot file (read-only preview) ---');
  const found = (await req('GET', '/api/inv/import/detect')).json.data;
  if (found.length) {
    const realHash = sha(found[0].path);
    const rp = await P({ path: found[0].path, org_id: 1 });
    assert(rp.status === 200 && rp.json.data.step === 'preview', `Previewed the real StockPilot database (${found[0].size_mb} MB)`, rp.raw.slice(0, 200));
    assert(sha(found[0].path) === realHash, 'The real StockPilot file was not modified by the preview');
  } else console.log('  (no real StockPilot database on this machine — skipped)');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

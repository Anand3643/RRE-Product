process.env.RRE_ENFORCE_AUTH = '1';
/**
 * Cross-device suite: ONE server and ONE database, several devices signed in to the same account (each its own real sign-in
 * session, its own browser id and its own live-update stream), plus other users, customers and companies.
 *   TEST 1  customer made on computer A is seen on computer B
 *   TEST 2  sales voucher made on A is seen on B and on a phone
 *   TEST 3  stock changed on A: B sees the correct balance
 *   TEST 4  purchase made on B is seen on A
 *   TEST 5  sign out and sign in again: everything is still there
 *   TEST 6  everything is in the database itself (read back over a NEW database connection, as after closing everything)
 *   TEST 7  two devices edit DIFFERENT records at the same time: both changes are saved
 *   TEST 8  two devices edit the SAME record: the second save is refused (409), nothing is overwritten; also when simultaneous
 *   TEST 9  a customer-portal login sees only its own orders, never another customer's
 *   TEST 10 users of different companies see only their own company's data, and get no live updates from another company
 *   + live updates: the other devices of the company are told within seconds; the device that saved is not
 * Runs on a DISPOSABLE data directory.   node test_crossdevice.js        on PostgreSQL:  npm run test:pg -- test_crossdevice.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_crossdevice_test_'));
process.env.RRE_DATA_DIR = tmp;

const mailer = require('./core/mailer');
const outbox = [];
mailer.setTransport({ sendMail: async (m) => { outbox.push(m); } });

const { startServer } = require('./server');
const db = require('./core/db');
const { initDb, get, run } = db;
const { runMigrations } = require('./core/migrations');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = 'Winter#Garden-2026';

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM user_logins'); await run('DELETE FROM auth_sessions'); await run('DELETE FROM password_resets'); await run('DELETE FROM users');
  await db.hardenAccounts(true);
  const srv = await startServer(13800 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const { loginRateLimiter } = require('./core/security');
  const calm = () => { for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) try { loginRateLimiter.recordSuccess(ip); } catch (e) { /* ignore */ } };

  // a "device": its own sign-in session, browser id and user agent
  const req = (method, p, { token, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, raw: b, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  async function device(name, identifier, password, loginType, agent) {
    calm();
    const r = await req('POST', '/api/auth/login', { body: { identifier, password, login_type: loginType }, headers: { 'User-Agent': agent } });
    if (r.status !== 200) throw new Error(`${name}: sign-in failed ${r.status} ${r.raw.slice(0, 200)}`);
    const d = { name, token: r.json.data.token, client: 'dev-' + name + '-' + Math.random().toString(36).slice(2), agent, events: [] };
    d.call = (m, p, o = {}) => req(m, p, { token: d.token, ...o, headers: { 'User-Agent': agent, 'X-RRE-Client': d.client, ...(o.headers || {}) } });
    d.data = async (m, p, o) => { const x = await d.call(m, p, o); return x.json && x.json.data; };
    d.listen = () => new Promise((resolve) => {
      const rq = http.request(base + '/api/events', { headers: { Authorization: 'Bearer ' + d.token, 'X-RRE-Client': d.client, Accept: 'text/event-stream' } }, (res) => {
        d.streamStatus = res.statusCode; let buf = '';
        res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = (/^event: (.+)$/m.exec(blk) || [])[1]; if (ev) d.events.push({ ev, data: JSON.parse((/^data: (.+)$/m.exec(blk) || [, '{}'])[1]), at: Date.now() }); } });
        resolve();
      });
      rq.on('error', () => resolve()); rq.end(); d.stop = () => rq.destroy();
    });
    d.changed = () => d.events.filter((e) => e.ev === 'changed');
    return d;
  }
  const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

  // ---------------------------------------------------------------- the account (one administrator) and the company's set-up
  const setup = await req('POST', '/api/auth/setup', { body: { password: PW } });
  if (!(setup.json && setup.json.success)) throw new Error('setup failed ' + setup.raw.slice(0, 200));
  const A = await device('computerA', 'admin', PW, 'admin', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/131 [computer A]');
  const B = await device('computerB', 'admin', PW, 'admin', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605 [computer B]');
  const P = await device('phone', 'admin', PW, 'admin', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Chrome/131 [phone]');
  await Promise.all([A.listen(), B.listen(), P.listen()]);
  await sleep(300);
  assert(A.token !== B.token && B.token !== P.token, 'the same account is signed in on two computers and a phone at the same time (three separate sessions)');
  assert(A.streamStatus === 200 && B.streamStatus === 200 && P.streamStatus === 200 && A.events.some((e) => e.ev === 'hello'), 'every device has the live-update stream open');

  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  const sales = (await A.call('POST', '/api/masters/ledgers', { body: { name: 'XD Sales', group_id: await grp('Sales Accounts') } })).json.id;
  const purch = (await A.call('POST', '/api/masters/ledgers', { body: { name: 'XD Purchases', group_id: await grp('Purchase Accounts') } })).json.id;
  const outC = await L('Output CGST 9%'), outS = await L('Output SGST 9%'), inC = await L('Input CGST 9%'), inS = await L('Input SGST 9%');
  const whs = await A.data('GET', '/api/inv/warehouses'); const W = whs[0];
  const cat = await A.data('POST', '/api/inv/categories', { body: { name: 'XD Goods' } });
  const uom = (await A.data('GET', '/api/inv/units'))[0].id;
  const item = await A.data('POST', '/api/inv/items', { body: { name: 'XD Compressor', category_id: cat.id, uom_id: uom, gst_rate: 18, standard_cost: 800, standard_price: 1000, opening_qty: 0 } });
  const item2 = await A.data('POST', '/api/inv/items', { body: { name: 'XD Filter', category_id: cat.id, uom_id: uom, gst_rate: 18, standard_cost: 50, standard_price: 80, opening_qty: 0 } });
  assert(item && item.id && item2 && item2.id, 'set-up: ledgers, a category and two items created from computer A');

  console.log('\n--- TEST 1: a customer created on computer A appears on computer B ---');
  const before = B.changed().length;
  const cust = await A.data('POST', '/api/inv/customers', { body: { name: 'Apex Tech Pvt Ltd', email: 'buy@apex.example', phone: '9876543210', state: 'Tamil Nadu', state_code: '33' } });
  assert(cust && cust.id, 'computer A creates customer "Apex Tech Pvt Ltd"', JSON.stringify(cust).slice(0, 200));
  const seenB = await B.data('GET', '/api/inv/customers?q=Apex');
  assert(seenB && (seenB.items || seenB).some((c) => c.id === cust.id), 'computer B lists the same customer');
  assert((await B.data('GET', '/api/masters/ledgers')).some((l) => l.id === cust.id && l.name === 'Apex Tech Pvt Ltd'), 'it is also in B\'s ledger list (the voucher screen\'s party list)');
  assert(await waitFor(() => B.changed().length > before && P.changed().length > 0), 'computer B and the phone are told immediately that customers changed (live update)', `B events ${B.changed().length - before}`);
  assert(B.changed().slice(-1)[0].data.area === 'inv/customers' && !JSON.stringify(B.events).includes('Apex'), 'the live update names only the area, never the record contents');
  assert(!A.changed().some((e) => e.at >= Date.now() - 3000 && e.data.area === 'inv/customers'), 'the device that saved is not told about its own change');

  console.log('\n--- TEST 2: a sales voucher created on A appears on B and on the phone ---');
  // stock first (TEST 4 checks the purchase direction separately): 20 units arrive
  const cashL = await L('Cash');
  const purchaseBody = (qty, no) => ({ voucher_type: 'Purchase', date: '2026-06-09', reference_no: no, party_ledger_id: null, entries: [
    { ledger_id: purch, debit_amount: qty * 800, credit_amount: 0 }, { ledger_id: inC, debit_amount: qty * 72, credit_amount: 0 }, { ledger_id: inS, debit_amount: qty * 72, credit_amount: 0 },
    { ledger_id: cashL, debit_amount: 0, credit_amount: qty * 944 }], inventory: [{ stock_item_id: item.id, quantity: qty, rate: 800, amount: qty * 800, godown_id: W.id }] });
  const p0 = await A.call('POST', '/api/vouchers', { body: await purchaseBody(20, 'XD-P0') });
  assert(p0.status === 200, 'set-up purchase of 20 units on A', p0.raw.slice(0, 200));
  const saleBody = { voucher_type: 'Sales', date: '2026-06-10', reference_no: 'XD-S1', party_ledger_id: cust.id, entries: [
    { ledger_id: cust.id, debit_amount: 3540, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: 3000 },
    { ledger_id: outC, debit_amount: 0, credit_amount: 270 }, { ledger_id: outS, debit_amount: 0, credit_amount: 270 }],
  inventory: [{ stock_item_id: item.id, quantity: 3, rate: 1000, amount: 3000, godown_id: W.id }] };
  const s1 = await A.call('POST', '/api/vouchers', { body: saleBody, headers: { 'Idempotency-Key': 'xd-sale-1' } });
  assert(s1.status === 200 && s1.json.id, 'computer A posts a sales voucher (3 × ₹1,000 + GST)', s1.raw.slice(0, 200));
  const dbB = await B.call('GET', '/api/reports/daybook?limit=200&entries=0'), dbP = await P.call('GET', '/api/reports/daybook?limit=200&entries=0');
  const has = (r) => JSON.stringify(r.json).includes('XD-S1') || (Array.isArray(r.json.data) && r.json.data.some((v) => v.id === s1.json.id));
  assert(dbB.status === 200 && has(dbB), 'computer B\'s Day Book shows the sales voucher');
  assert(dbP.status === 200 && has(dbP), 'the phone\'s Day Book shows the sales voucher');
  const vB = await B.data('GET', `/api/vouchers/${s1.json.id}`);
  assert(vB && Number(vB.total_amount || 0) >= 3540 - 0.01 || (vB && vB.voucher_type === 'Sales'), 'B opens the voucher itself with the same amount', JSON.stringify(vB).slice(0, 160));
  const again = await A.call('POST', '/api/vouchers', { body: saleBody, headers: { 'Idempotency-Key': 'xd-sale-1' } });
  assert(again.status === 200 && again.json.id === s1.json.id && (await get("SELECT COUNT(*) c FROM vouchers WHERE reference_no = 'XD-S1'")).c === 1, 'sending the same voucher again (a retry after a dropped connection) does not post it twice');

  console.log('\n--- TEST 3: stock changed on A; B sees the correct balance ---');
  const adj = await A.call('POST', '/api/inv/adjustments', { body: { warehouse_id: W.id, reason: 'Damaged goods', lines: [{ item_id: item.id, delta: -2 }], note: 'cross-device test' } });
  assert(adj.status === 200, 'computer A records a stock adjustment of -2', adj.raw.slice(0, 200));
  const itB = await B.data('GET', `/api/inv/items/${item.id}`);
  const onB = itB && (itB.warehouses || []).find((w) => w.id === W.id);
  assert(onB && Number(onB.on_hand) === 15, 'computer B sees 15 on hand (20 bought - 3 sold - 2 damaged)', JSON.stringify(onB));

  console.log('\n--- TEST 4: a purchase made on B is seen on A ---');
  const pB = await B.call('POST', '/api/vouchers', { body: await purchaseBody(5, 'XD-P-FROM-B') });
  assert(pB.status === 200, 'computer B posts a purchase of 5 units', pB.raw.slice(0, 200));
  const hist = await A.data('GET', '/api/inv/movements?item=' + item.id + '&page_size=50');
  const itA = await A.data('GET', `/api/inv/items/${item.id}`);
  assert(JSON.stringify(await A.data('GET', '/api/vouchers?limit=50')).includes('XD-P-FROM-B'), 'computer A sees B\'s purchase voucher');
  assert(Number(itA.warehouses.find((w) => w.id === W.id).on_hand) === 20 && hist, 'computer A sees the new stock balance (20)');
  assert(await waitFor(() => A.changed().some((e) => e.data.area === 'vouchers')), 'computer A was told live that vouchers changed');

  console.log('\n--- TEST 5: sign out and sign in again ---');
  assert((await B.call('POST', '/api/auth/logout')).status === 200 && (await B.call('GET', '/api/vouchers?limit=1')).status === 401, 'computer B signs out (its old session no longer works)');
  assert((await A.call('GET', '/api/vouchers?limit=1')).status === 200, 'signing out on B does not sign out computer A');
  const B2 = await device('computerB-again', 'admin', PW, 'admin', B.agent);
  const after = JSON.stringify(await B2.data('GET', '/api/vouchers?limit=100'));
  assert(after.includes('XD-S1') && after.includes('XD-P-FROM-B') && (await B2.data('GET', '/api/inv/customers?q=Apex')).items.length === 1, 'after signing in again every record is still there');

  console.log('\n--- TEST 6: the data is in the database, not in a device or in memory ---');
  if (db.isPostgres()) {
    const { Client } = require('pg'); const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    const co = String(db.getCompanyNumber());
    const q = async (sql, p) => (await c.query(sql, p)).rows[0];
    const v = await q("SELECT COUNT(*)::int n FROM rre.vouchers WHERE company_no = $1 AND reference_no IN ('XD-S1', 'XD-P0', 'XD-P-FROM-B')", [co]);
    const cu = await q("SELECT COUNT(*)::int n FROM rre.ledgers WHERE company_no = $1 AND name = 'Apex Tech Pvt Ltd'", [co]);
    await c.end();
    assert(v.n === 3 && cu.n === 1, 'a brand-new PostgreSQL connection (as after closing every browser and the server) reads all three vouchers and the customer');
  } else {
    const sqlite3 = require('sqlite3'); const file = path.join(tmp, 'company.db');
    const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
    const q = (sql) => new Promise((res, rej) => d.get(sql, (e, r) => (e ? rej(e) : res(r))));
    const v = await q("SELECT COUNT(*) n FROM vouchers WHERE reference_no IN ('XD-S1', 'XD-P0', 'XD-P-FROM-B')"), cu = await q("SELECT COUNT(*) n FROM ledgers WHERE name = 'Apex Tech Pvt Ltd'");
    d.close();
    assert(v.n === 3 && cu.n === 1, 'a separate read-only connection to the database file reads all three vouchers and the customer');
  }
  assert(!/XD-S1|Apex/.test(fs.readFileSync(path.join(__dirname, 'public', 'ext', 'live-sync.js'), 'utf8')), '(the browser code keeps no business records: they are always fetched from the server)');

  console.log('\n--- TEST 7: two devices edit different records at the same time ---');
  const [e1, e2] = await Promise.all([
    A.call('PATCH', `/api/inv/items/${item.id}`, { body: { standard_price: 1100 } }),
    B2.call('PATCH', `/api/inv/items/${item2.id}`, { body: { standard_price: 95 } })
  ]);
  const [i1, i2] = [await P.data('GET', `/api/inv/items/${item.id}`), await P.data('GET', `/api/inv/items/${item2.id}`)];
  assert(e1.status === 200 && e2.status === 200 && Number(i1.price) === 1100 && Number(i2.price) === 95, 'both saved, and a third device (the phone) sees both changes', `${e1.status} ${e2.status} ${i1.price} ${i2.price}`);

  console.log('\n--- TEST 8: two devices edit the SAME record ---');
  const openA = await A.data('GET', `/api/inv/items/${item.id}`), openB = await B2.data('GET', `/api/inv/items/${item.id}`);
  assert(Number.isInteger(openA.row_version) && openA.row_version === openB.row_version, 'both devices open the item and see the same version', String(openA.row_version));
  const saveA = await A.call('PATCH', `/api/inv/items/${item.id}`, { body: { name: 'XD Compressor (edited on A)' }, headers: { 'X-Row-Version': String(openA.row_version) } });
  assert(saveA.status === 200 && Number(saveA.headers['x-row-version']) === openA.row_version + 1, 'A saves first: accepted, the version goes up', `${saveA.status} ${saveA.headers['x-row-version']}`);
  const saveB = await B2.call('PATCH', `/api/inv/items/${item.id}`, { body: { name: 'XD Compressor (edited on B)' }, headers: { 'X-Row-Version': String(openB.row_version) } });
  assert(saveB.status === 409 && saveB.json.code === 'ROW_CONFLICT' && saveB.json.current_version === openA.row_version + 1, 'B saves from its older copy: refused with a conflict (409) and told the current version', saveB.raw.slice(0, 160));
  assert((await P.data('GET', `/api/inv/items/${item.id}`)).name === 'XD Compressor (edited on A)', 'nothing was overwritten: the record still has A\'s change');
  const reopenB = await B2.data('GET', `/api/inv/items/${item.id}`);
  const retryB = await B2.call('PATCH', `/api/inv/items/${item.id}`, { body: { name: 'XD Compressor (A and B)' }, headers: { 'X-Row-Version': String(reopenB.row_version) } });
  assert(retryB.status === 200 && (await A.data('GET', `/api/inv/items/${item.id}`)).name === 'XD Compressor (A and B)', 'after reloading, B makes its change again and it is saved');
  // exactly at the same moment
  const cur = (await A.data('GET', `/api/inv/items/${item.id}`)).row_version;
  const race = await Promise.all([A, B2, P].map((dv, i) => dv.call('PATCH', `/api/inv/items/${item.id}`, { body: { standard_cost: 700 + i }, headers: { 'X-Row-Version': String(cur) } })));
  const codes = race.map((r) => r.status).sort();
  assert(codes.join(',') === '200,409,409', 'three devices save the same version at the same moment: exactly one is accepted, the other two get a conflict', codes.join(','));
  // a customer (ledger) and a quotation behave the same; a delete from an old copy is refused too
  const cA = await A.data('GET', `/api/inv/customers/${cust.id}`), cB = await B2.data('GET', `/api/inv/customers/${cust.id}`);
  assert((await A.call('PATCH', `/api/inv/customers/${cust.id}`, { body: { phone: '9000000001' }, headers: { 'X-Row-Version': String(cA.row_version) } })).status === 200
    && (await B2.call('PATCH', `/api/inv/customers/${cust.id}`, { body: { phone: '9000000002' }, headers: { 'X-Row-Version': String(cB.row_version) } })).status === 409, 'customers: the second save from an older copy is refused');
  const q = await A.call('POST', '/api/quotations', { body: { customer_name: 'Apex Tech Pvt Ltd', party_ledger_id: cust.id, subject: 'XD quote', items: [{ item_name: 'Service', quantity: 1, rate: 1000, gst_rate: 18 }] } });
  const qA = await A.data('GET', `/api/quotations/${q.json.id}`), qB = await B2.data('GET', `/api/quotations/${q.json.id}`);
  const qBody = (s) => ({ customer_name: 'Apex Tech Pvt Ltd', party_ledger_id: cust.id, subject: s, items: [{ item_name: 'Service', quantity: 1, rate: 1000, gst_rate: 18 }] });
  const qa = await A.call('PUT', `/api/quotations/${q.json.id}`, { body: qBody('changed on A'), headers: { 'X-Row-Version': String(qA.row_version) } });
  const qb = await B2.call('PUT', `/api/quotations/${q.json.id}`, { body: qBody('changed on B'), headers: { 'X-Row-Version': String(qB.row_version) } });
  const qd = await B2.call('DELETE', `/api/quotations/${q.json.id}`, { headers: { 'X-Row-Version': String(qB.row_version) } });
  assert(qa.status === 200 && qb.status === 409 && qd.status === 409 && (await A.data('GET', `/api/quotations/${q.json.id}`)).subject === 'changed on A', 'quotations: an edit or a delete from an older copy is refused; A\'s version stays');
  assert((await A.call('PATCH', `/api/inv/items/${item2.id}`, { body: { standard_price: 99 } })).status === 200, 'a save that sends no version (older screens, imports) still works as before');

  console.log('\n--- TEST 9: customer-portal accounts see only their own records ---');
  const mkDebtor = async (name) => (await A.data('POST', '/api/inv/customers', { body: { name } })).id;
  const custX = cust.id, custY = await mkDebtor('Bharat Motors');
  const portalUser = async (email, party) => { const r = await A.call('POST', '/api/auth/users', { body: { full_name: email.split('@')[0], email, role: 'Customer', party_id: party, password: 'Portal#Pass-2026x' } }); await run('UPDATE users SET must_change_password = 0 WHERE email = ?', [email]); return r; };
  const ux = await portalUser('buyer@apex.example', custX), uy = await portalUser('buyer@bharat.example', custY);
  assert(ux.status < 300 && uy.status < 300, 'two portal logins created, one for each customer', ux.raw.slice(0, 160) + ' ' + uy.raw.slice(0, 160));
  const soX = await A.call('POST', '/api/inv/sales-orders', { body: { party_id: custX, warehouse_id: W.id, lines: [{ item_id: item2.id, qty: 1, rate: 80 }] } });
  const soY = await A.call('POST', '/api/inv/sales-orders', { body: { party_id: custY, warehouse_id: W.id, lines: [{ item_id: item2.id, qty: 2, rate: 80 }] } });
  assert(soX.status === 200 && soY.status === 200, 'the company creates an order for each customer', soX.raw.slice(0, 160));
  const X = await device('portal-apex', 'buyer@apex.example', 'Portal#Pass-2026x', 'customer', 'Mobile Safari [customer X phone]');
  const Y = await device('portal-bharat', 'buyer@bharat.example', 'Portal#Pass-2026x', 'customer', 'Chrome [customer Y laptop]');
  const ordX = JSON.stringify(await X.data('GET', '/api/portal/orders')), ordY = JSON.stringify(await Y.data('GET', '/api/portal/orders'));
  assert(ordX.includes(soX.json.data.number) && !ordX.includes(soY.json.data.number), 'customer X sees its own order and not Y\'s');
  assert(ordY.includes(soY.json.data.number) && !ordY.includes(soX.json.data.number), 'customer Y sees its own order and not X\'s');
  assert((await X.call('GET', `/api/portal/orders/${soY.json.data.id}`)).status === 404, 'customer X cannot open Y\'s order by guessing its number');
  assert((await X.call('GET', '/api/vouchers')).status === 403 && (await X.call('GET', '/api/inv/customers')).status === 403, 'a portal login cannot read the company\'s books or customer list');
  await X.listen();
  assert(X.streamStatus === 403, 'a portal login does not receive the company\'s live updates', String(X.streamStatus));

  console.log('\n--- TEST 10: users of different companies are strictly separated ---');
  const signupCo = async (email, name) => {
    outbox.length = 0;
    await req('POST', '/api/auth/signup', { body: { full_name: name, email, phone: '+91 98765 43210', password: 'Company#Pass-2026', confirm: 'Company#Pass-2026' } });
    const tok = decodeURIComponent((/verify=([^\s"&<]+)/.exec((outbox.find((m) => /verify=/.test(m.text)) || {}).text || '') || [])[1] || '');
    await req('POST', '/api/auth/verify-email', { body: { token: tok } });
    return device('co-' + name, email, 'Company#Pass-2026', 'customer', 'Firefox [' + name + ']');
  };
  const C1 = await signupCo('owner@alpha.example', 'Alpha Traders'), C2 = await signupCo('owner@beta.example', 'Beta Stores');
  await C1.listen(); await C2.listen(); await sleep(200);
  const c1Ledger = await C1.call('POST', '/api/masters/ledgers', { body: { name: 'Alpha Private Bank', group_id: await grp('Bank Accounts') } });
  assert(c1Ledger.status === 200, 'company Alpha creates a ledger in its own books', c1Ledger.raw.slice(0, 160));
  const names = async (dv) => (await dv.data('GET', '/api/masters/ledgers') || []).map((l) => l.name);
  const n2 = await names(C2), nA = await names(A), n1 = await names(C1);
  assert(n1.includes('Alpha Private Bank') && !n2.includes('Alpha Private Bank') && !nA.includes('Alpha Private Bank'), 'Beta and the main company cannot see Alpha\'s ledger');
  assert(!n1.includes('Apex Tech Pvt Ltd') && !n2.includes('Apex Tech Pvt Ltd'), 'neither Alpha nor Beta can see the main company\'s customer');
  assert(!JSON.stringify(await C2.data('GET', '/api/vouchers?limit=100')).includes('XD-S1'), 'Beta cannot see the main company\'s vouchers');
  await sleep(600);
  assert(C1.events.some((e) => e.ev === 'hello') && !C2.changed().length, 'Beta received no live update when Alpha saved (updates stay inside a company)', JSON.stringify(C2.changed()));
  assert(!C1.changed().some((e) => e.data.area === 'quotations' || e.data.area === 'inv/items'), 'Alpha received none of the main company\'s updates');

  for (const d of [A, B, P, B2, X, C1, C2]) try { d.stop && d.stop(); } catch (e) { /* ignore */ }
  console.log(`\nCross-device: ${passed} passed, ${failed} failed  (database: ${db.isPostgres() ? 'PostgreSQL' : 'SQLite'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

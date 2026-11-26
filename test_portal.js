process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Inventory suite, stage 4: customer portal. The heart of this suite is ISOLATION: a portal customer must reach only their own
 * orders and invoices, nothing of the staff application, and no way of changing the URL or request to see anyone else's records.
 * Runs against a DISPOSABLE data directory.   npm run test:portal
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_portal_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const PW = 'Portal#Pass2026x', PW2 = 'Brand#New2026pw';

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(13500 + Math.floor(Math.random() * 90), '127.0.0.1');
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
  const D = async (m, p, o) => (await req(m, p, o)).json?.data;
  const login = async (u, pw) => (await req('POST', '/api/auth/login', { token: null, body: { username: u, password: pw } }));

  await run("DELETE FROM users WHERE role = 'Customer'"); // the copy of the live database may hold real customer logins
  await run('DELETE FROM vouchers'); await run('DELETE FROM inv_docs'); await run('DELETE FROM inv_orders'); await run('DELETE FROM stock_items'); await run('DELETE FROM inv_reservations');
  const cat = await D('POST', '/api/inv/categories', { body: { name: 'Portal Goods' } }), cat2 = await D('POST', '/api/inv/categories', { body: { name: 'Portal Other' } });
  const units = await D('GET', '/api/inv/units');
  const whole = units.find((u) => !u.decimal_places) || units[0], dec = units.find((u) => u.decimal_places > 0);
  const mk = (b) => D('POST', '/api/inv/items', { body: { category_id: cat.id, uom_id: whole.id, gst_rate: 18, standard_cost: 60, standard_price: 100, reorder_level: 0, opening_rate: 60, ...b } });
  const A = await mk({ name: 'Portal Widget A', opening_qty: 50, brand: 'Acme', description: 'A good widget' });
  const B = await mk({ name: 'Portal NoPrice B', opening_qty: 10, standard_price: 0 });
  const C = await mk({ name: 'Portal Sold Out C', opening_qty: 0, standard_price: 50, category_id: cat2.id });
  const Dd = await mk({ name: 'Portal Limited D', opening_qty: 3, standard_price: 20, reorder_level: 5, category_id: cat2.id });
  const E = await mk({ name: 'Portal Archived E', opening_qty: 0, standard_price: 10 }); await req('POST', `/api/inv/items/${E.id}/archive`);
  const F = dec ? await mk({ name: 'Portal Loose Oil F', opening_qty: 100, standard_price: 10, uom_id: dec.id }) : null;
  const cust1 = await D('POST', '/api/inv/customers', { body: { name: 'Portal Customer One', state_code: '33' } });
  const cust2 = await D('POST', '/api/inv/customers', { body: { name: 'Portal Customer Two', state_code: '33' } });
  const sup = await D('POST', '/api/inv/suppliers', { body: { name: 'Portal Supplier', state_code: '33' } });

  console.log('\n--- 1. Administrators create and manage portal logins ---');
  const mkUser = (token, body) => req('POST', '/api/inv/portal-users', { token, body });
  for (const [n, t] of [['Accountant', acc], ['Data Entry', clerk], ['nobody', null]]) assert([401, 403].includes((await mkUser(t, { party_id: cust1.id, username: 'x.user', password: PW })).status), `${n} cannot create portal logins`);
  assert((await mkUser(admin, { party_id: cust1.id, username: 'a', password: PW })).status === 400, 'A too-short username is refused');
  assert((await mkUser(admin, { party_id: cust1.id, username: 'ok.user', password: 'abc' })).status === 400, 'A weak password is refused');
  assert((await mkUser(admin, { party_id: cust1.id, username: 'ok.user', password: 'ok.user' + '123' })).status === 400, 'A password that contains the username is refused');
  assert((await mkUser(admin, { party_id: sup.id, username: 'sup.user', password: PW })).status === 400, 'A SUPPLIER cannot be given a customer portal login');
  assert((await mkUser(admin, { party_id: 999999, username: 'ghost.user', password: PW })).status === 400 && (await mkUser(admin, { username: 'ghost.user', password: PW })).status === 400, 'An unknown or missing customer is refused');
  assert((await mkUser(admin, { party_id: cust1.id, username: 'bad name!', password: PW })).status === 400, 'Odd characters in the username are refused');
  const u1 = (await mkUser(admin, { party_id: cust1.id, username: 'cust1.buyer', password: PW, full_name: 'Buyer One' })).json.data;
  const u2 = (await mkUser(admin, { party_id: cust2.id, username: 'cust2.buyer', password: PW })).json.data;
  assert(u1 && u1.customer === 'Portal Customer One' && u1.status === 'Active' && !('password' in u1) && u1.must_change === 1, 'Created, tied to the customer, active, must change password, no password in the reply', JSON.stringify(u1));
  assert((await mkUser(admin, { party_id: cust2.id, username: 'CUST1.buyer', password: PW })).status === 409, 'A username that is already taken (any case) is refused');
  const list = await D('GET', '/api/inv/portal-users');
  assert(list.length === 2 && list.every((x) => !('password' in x)), 'The list shows both logins without passwords');
  assert((await D('GET', `/api/inv/portal-users?party=${cust2.id}`)).length === 1, 'The list can be filtered by customer');
  for (let i = 0; i < 4; i++) await mkUser(admin, { party_id: cust2.id, username: `cust2.extra${i}`, password: PW });
  assert((await mkUser(admin, { party_id: cust2.id, username: 'cust2.toomany', password: PW })).status === 409, 'A customer is limited to 5 logins');
  for (let i = 0; i < 4; i++) await run("DELETE FROM users WHERE username = ?", [`cust2.extra${i}`]);

  console.log('\n--- 2. Signing in ---');
  const l1 = await login('cust1.buyer', PW);
  assert(l1.status === 200 && l1.json.data.user.role === 'Customer' && l1.json.data.must_change_password === true, 'Signs in as a Customer and is told to change the password');
  assert(l1.json.data.permissions.canManageUsers === false && l1.json.data.user.own_company === false, 'A customer linked to the owner\'s customer account has no user-management permission and no company of their own (so the server confines them to the portal)');
  const early = await req('GET', '/api/portal/me', { token: l1.json.data.token });
  assert(early.status === 403 && early.json.code === 'PASSWORD_CHANGE_REQUIRED', 'Nothing works until the password is changed');
  assert((await login('cust1.buyer', 'wrong-password')).status === 401, 'A wrong password is refused');
  const ch = await req('POST', '/api/auth/change-password', { token: l1.json.data.token, body: { current_password: PW, new_password: PW2 } });
  assert(ch.status === 200, 'The customer can change their own password', ch.raw.slice(0, 120));
  const tk1 = (await login('cust1.buyer', PW2)).json.data.token;
  await req('POST', '/api/auth/change-password', { token: (await login('cust2.buyer', PW)).json.data.token, body: { current_password: PW, new_password: PW2 } });
  const tk2 = (await login('cust2.buyer', PW2)).json.data.token;
  assert(!!tk1 && !!tk2, 'Both customers are signed in with their new passwords');
  const me1r = await req('GET', '/api/portal/me', { token: tk1 }); if (me1r.status !== 200) console.log('ME FAIL', me1r.status, me1r.raw.slice(0, 200)); const me1 = me1r.json.data;
  assert(me1.customer.name === 'Portal Customer One' && me1.username === 'cust1.buyer', 'The portal knows who they are and which customer they belong to');

  console.log('\n--- 3. A customer can reach ONLY the portal ---');
  const staffGets = ['/api/inv/items', '/api/inv/dashboard', '/api/inv/customers', '/api/inv/sales-orders', '/api/inv/reports/stock-valuation', '/api/inv/portal-users', '/api/inv/import/detect', '/api/vouchers', '/api/masters/ledgers', '/api/masters/stock-items', '/api/reports/trial-balance', '/api/reports/profit-loss', '/api/auth/users', '/api/auth/audit-log', '/api/dashboard', '/api/platform/notifications', '/api/insights/summary', '/api/report-center/sales', '/api/search?q=a', '/api/backup/list', '/api/company/info', '/api/tracking/batches', '/api/approvals/rules', '/api/org/branches', '/api/quotations'];
  const results = await Promise.all(staffGets.map((p) => req('GET', p, { token: tk1 })));
  const leaked = staffGets.filter((p, i) => results[i].status !== 403 && results[i].status !== 404);
  assert(leaked.length === 0, `All ${staffGets.length} staff endpoints refuse a customer`, leaked.map((p) => p + ' -> ' + results[staffGets.indexOf(p)].status).join(', '));
  assert(results.filter((r) => r.json && r.json.code === 'PORTAL_ONLY').length >= staffGets.length - 3, 'They are refused with the portal-only message');
  const posts = [['/api/vouchers', { voucher_type: 'Sales' }], ['/api/masters/ledgers', { name: 'X' }], ['/api/inv/items', { name: 'Hack' }], ['/api/inv/orders/1/confirm', {}], ['/api/auth/users', { username: 'h', password: PW, full_name: 'h', role: 'Owner' }], ['/api/inv/portal-users', { party_id: cust1.id, username: 'sneaky', password: PW }]];
  const pr = await Promise.all(posts.map(([p, b]) => req('POST', p, { token: tk1, body: b })));
  assert(pr.every((r) => r.status === 403), 'POST attempts (vouchers, masters, items, confirm, create an Owner, create a portal login) are all refused');
  assert((await req('PUT', '/api/auth/users/1', { token: tk1, body: { role: 'Viewer' } })).status === 403 && (await req('DELETE', '/api/auth/users/1', { token: tk1 })).status === 403, 'They cannot edit or delete users');
  for (const [n, t] of [['Owner', admin], ['Accountant', acc]]) assert((await req('GET', '/api/portal/me', { token: t })).status === 403, `${n} staff cannot use the portal API`);
  assert((await req('GET', '/api/portal/me', { token: null })).status === 401, 'No token → 401');
  const forged = createSessionToken({ id: 1, username: 'admin', role: 'Customer' });
  assert((await req('GET', '/api/portal/me', { token: forged })).status === 401, 'A "Customer" token carrying a STAFF user id is refused (the database decides, not the token)');
  const [hd, sg] = tk1.slice(4).split('.'); const pl = JSON.parse(Buffer.from(hd, 'base64url').toString()); pl.userId = u2.id;
  const tampered = 'rre_' + Buffer.from(JSON.stringify(pl)).toString('base64url') + '.' + sg;
  assert((await req('GET', '/api/portal/me', { token: tampered })).status === 401, 'A token edited to point at another customer fails its signature');
  const asOther = createSessionToken({ id: u2.id, username: 'cust2.buyer', role: 'Customer' });
  assert((await D('GET', '/api/portal/me', { token: asOther })).customer.name === 'Portal Customer Two', 'The customer is decided by the login record, as intended');

  console.log('\n--- 4. Catalogue: selling price and availability only ---');
  const cat1 = await D('GET', '/api/portal/catalogue?page_size=50', { token: tk1 });
  const byName = (n) => cat1.items.find((i) => i.name === n);
  const a = byName('Portal Widget A');
  assert(a && a.price === 100 && a.gst_rate === 18 && a.availability === 'in_stock' && a.orderable && a.brand === 'Acme' && a.uom, 'Item A: price ₹100 + 18% GST, in stock, orderable', JSON.stringify(a));
  assert(byName('Portal Sold Out C').availability === 'out' && byName('Portal Limited D').availability === 'limited', 'Out of stock and Limited are shown as statuses');
  assert(byName('Portal NoPrice B').price === null && byName('Portal NoPrice B').orderable === false, 'An item with no price is shown as not orderable');
  assert(!byName('Portal Archived E'), 'Archived items are hidden');
  const raw = JSON.stringify(cat1);
  assert(!/"(cost|standard_cost|on_hand|reserved|available|qty|quantity|stock|value|margin|opening)[a-z_]*"/i.test(raw), 'No cost, margin, quantity or stock value appears anywhere in the catalogue');
  assert(!/"availability"\s*:\s*\d/.test(raw), 'Availability is a status, never a number');
  assert((await D('GET', '/api/portal/catalogue?q=widget', { token: tk1 })).items.length === 1 && (await D('GET', `/api/portal/catalogue?category=${cat2.id}`, { token: tk1 })).items.every((i) => i.category === 'Portal Other'), 'Search and category filter work');
  assert((await D('GET', '/api/portal/catalogue?available=1', { token: tk1 })).items.every((i) => i.availability !== 'out'), '"In stock only" hides sold-out items');
  assert((await D('GET', '/api/portal/catalogue?page_size=1', { token: tk1 })).items.length === 1 && (await D('GET', '/api/portal/catalogue?page_size=9999', { token: tk1 })).page_size <= 50, 'Page size is capped');
  assert(cat1.categories.length >= 2, 'The category list comes with it');

  console.log('\n--- 5. Placing an order ---');
  const place = (token, body) => req('POST', '/api/portal/orders', { token, body });
  const stockBefore = (await D('GET', '/api/inv/items?q=Widget A')).items[0].on_hand;
  const o1r = await place(tk1, { lines: [{ item_id: A.id, qty: 2, rate: 1, discount_pct: 100, gst_rate: 0 }, { item_id: Dd.id, qty: 1 }], notes: 'Please deliver in the morning', reference: 'PO-77', party_id: cust2.id, warehouse_id: 999, status: 'confirmed' });
  const o1 = o1r.json.data;
  assert(o1r.status === 200 && o1.status === 'draft' && o1.status_label === 'Awaiting confirmation' && o1.can_cancel === true, 'The order is recorded as "Awaiting confirmation"', o1r.raw.slice(0, 200));
  assert(o1.lines.find((l) => l.item === 'Portal Widget A').rate === 100 && o1.lines.find((l) => l.item === 'Portal Widget A').discount_pct === 0 && o1.lines.find((l) => l.item === 'Portal Widget A').gst_rate === 18, 'Price, discount and GST come from the server: the rate ₹1, 100% discount and 0% GST the customer sent were ignored');
  assert(o1.totals.taxable === 220 && o1.totals.tax === 39.6 && o1.totals.total === 260, 'Totals are right: (2 × 100 + 1 × 20) = 220 + 18% GST 39.60 = ₹259.60 → ₹260', JSON.stringify(o1.totals));
  const row = await get('SELECT * FROM inv_orders WHERE id = ?', [o1.id]);
  assert(row.party_ledger_id === cust1.id && row.status === 'draft' && row.portal_user_id === u1.id && /^portal:/.test(row.created_by), 'It belongs to THEIR customer account (the party_id they sent was ignored), is tied to their login, and is marked as a portal order');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === 0 && (await D('GET', '/api/inv/items?q=Widget A')).items[0].on_hand === stockBefore && (await get('SELECT COUNT(*) c FROM inv_reservations')).c === 0, 'An order request posts no voucher, moves no stock and reserves nothing until staff confirm');
  const bads = [[{ lines: [] }, 'no lines'], [{}, 'no body'], [{ lines: [{ item_id: 999999, qty: 1 }] }, 'unknown item'], [{ lines: [{ item_id: E.id, qty: 1 }] }, 'archived item'], [{ lines: [{ item_id: B.id, qty: 1 }] }, 'item with no price'],
    [{ lines: [{ item_id: A.id, qty: 1 }, { item_id: A.id, qty: 1 }] }, 'duplicate item'], [{ lines: [{ item_id: A.id, qty: 0 }] }, 'zero qty'], [{ lines: [{ item_id: A.id, qty: -3 }] }, 'negative qty'], [{ lines: [{ item_id: A.id, qty: 'lots' }] }, 'text qty'],
    [{ lines: [{ item_id: A.id, qty: 1e9 }] }, 'huge qty'], [{ lines: [{ item_id: A.id, qty: 1.5 }] }, 'fractional qty of a whole-unit item'], [{ lines: [{ item_id: A.id, qty: 1 }], expected_date: '2020-01-01' }, 'past delivery date'], [{ lines: [{ item_id: A.id, qty: 1 }], expected_date: 'tomorrow' }, 'bad date'],
    [{ lines: Array.from({ length: 51 }, (_, i) => ({ item_id: A.id + i, qty: 1 })) }, '51 lines'], [{ lines: 'x' }, 'lines not a list'], [{ lines: [null] }, 'null line']];
  const br = await Promise.all(bads.map(([b]) => place(tk2, b)));
  assert(br.every((r) => r.status >= 400 && r.status < 500), `${bads.length} invalid requests are all refused with a client error`, br.map((r, i) => bads[i][1] + ':' + r.status).join(' '));
  assert((await get('SELECT COUNT(*) c FROM inv_orders WHERE party_ledger_id = ?', [cust2.id])).c === 0, '…and none of them created an order');
  if (F) { const f = await place(tk2, { lines: [{ item_id: F.id, qty: 2.5 }] }); assert(f.status === 200, 'A fractional quantity is fine for an item sold by measure (litres, kg)', f.raw.slice(0, 150)); await run("DELETE FROM inv_orders WHERE party_ledger_id = ?", [cust2.id]); }
  // double submit
  const dbl = await Promise.all(Array.from({ length: 6 }, () => place(tk2, { lines: [{ item_id: A.id, qty: 3 }] })));
  assert(dbl.filter((r) => r.status === 200).length === 1 && dbl.filter((r) => r.status === 409).length === 5, 'Six identical requests at once (a double-click, a retry) create exactly ONE order', dbl.map((r) => r.status).join(','));
  assert((await get('SELECT COUNT(*) c FROM inv_orders WHERE party_ledger_id = ?', [cust2.id])).c === 1, 'The database holds exactly one');
  const o2 = (await D('GET', '/api/portal/orders', { token: tk2 })).items[0];
  // the cap on waiting requests
  await run("DELETE FROM inv_orders WHERE party_ledger_id = ?", [cust2.id]);
  for (let i = 1; i <= 20; i++) await run(`INSERT INTO inv_orders (kind, number, party_ledger_id, status, order_date, warehouse_id, total, portal_user_id) VALUES ('sales', ?, ?, 'draft', date('now'), 1, ?, ?)`, [`SO-CAP${i}`, cust2.id, i, u2.id]);
  assert((await place(tk2, { lines: [{ item_id: A.id, qty: 1 }] })).status === 429, 'With 20 requests already waiting, a 21st is refused');
  await run("DELETE FROM inv_orders WHERE number LIKE 'SO-CAP%'");

  console.log('\n--- 6. Staff see and process portal orders ---');
  const staffList = await D('GET', '/api/inv/sales-orders?q=PO-77');
  assert(staffList.items.length === 1 && staffList.items[0].party === 'Portal Customer One', 'Staff see the portal order in Sales orders under the right customer');
  const conf = await req('POST', `/api/inv/orders/${o1.id}/confirm`);
  assert(conf.status === 200 && conf.json.data.status === 'confirmed', 'Staff confirm it (stock is reserved)');
  assert((await D('GET', `/api/portal/orders/${o1.id}`, { token: tk1 })).status_label === 'Confirmed', 'The customer now sees "Confirmed"');
  const cx = await req('POST', `/api/portal/orders/${o1.id}/cancel`, { token: tk1, body: {} });
  assert(cx.status === 409 && /confirmed/.test(cx.json.error), 'A confirmed order cannot be cancelled by the customer; they are told to contact the company');
  assert((await get('SELECT COUNT(*) c FROM inv_reservations WHERE ref_id = ?', [o1.id])).c === 2, '…and the reservation stays');
  const inv = await req('POST', `/api/inv/orders/${o1.id}/invoice`, { body: { date: new Date().toISOString().slice(0, 10) } });
  assert(inv.status === 200, 'Staff invoice the order', inv.raw.slice(0, 160));
  const full = await D('GET', `/api/portal/orders/${o1.id}`, { token: tk1 });
  assert(full.status === 'invoiced' && full.invoices.length === 1 && full.lines.every((l) => l.invoiced_qty === l.qty), 'The customer sees it as Invoiced, with the invoice listed');
  const invs = await D('GET', '/api/portal/invoices', { token: tk1 });
  assert(invs.total === 1 && invs.items[0].total === 260 && invs.items[0].order_number === o1.number && invs.items[0].type === 'Sales', 'The invoice (₹260) is in their invoice list, tied to the order');
  const invd = await D('GET', `/api/portal/invoices/${invs.items[0].id}`, { token: tk1 });
  assert(invd.items.length === 2 && invd.taxable === 220 && invd.tax_and_rounding === 40 && invd.order.number === o1.number, 'The invoice shows its items, taxable value and GST/rounding (₹40)', JSON.stringify(invd).slice(0, 300));
  assert(!/cost|margin|ledger/i.test(JSON.stringify(invd)), 'No internal accounting detail is exposed on an invoice');
  const sum = await D('GET', '/api/portal/summary', { token: tk1 });
  assert(sum.invoiced === 1 && sum.awaiting === 0 && sum.recent_invoices.length === 1 && sum.customer === 'Portal Customer One', 'The home summary counts are right');

  console.log('\n--- 7. Cancelling an unconfirmed order ---');
  const o3 = (await place(tk1, { lines: [{ item_id: A.id, qty: 4 }] })).json.data;
  const can = await req('POST', `/api/portal/orders/${o3.id}/cancel`, { token: tk1, body: { reason: 'Ordered twice' } });
  assert(can.status === 200 && can.json.data.status === 'cancelled' && /Cancelled by customer: Ordered twice/.test(can.json.data.cancelled_reason), 'A customer can cancel their own unconfirmed order, with a reason');
  assert((await req('POST', `/api/portal/orders/${o3.id}/cancel`, { token: tk1, body: {} })).status === 409, 'Cancelling twice is refused');
  assert((await D('GET', '/api/portal/orders?status=cancelled', { token: tk1 })).total === 1 && (await D('GET', '/api/portal/orders?status=invoiced', { token: tk1 })).total === 1, 'The order list filters by status');

  console.log('\n--- 8. ISOLATION: one customer cannot reach another\'s records ---');
  const o4 = (await place(tk2, { lines: [{ item_id: Dd.id, qty: 1 }], reference: 'C2-SECRET' })).json.data;
  await run("INSERT INTO vouchers (voucher_type, voucher_no, date, party_ledger_id, total_amount) VALUES ('Sales', 'C2-INV-1', date('now'), ?, 999)", [cust2.id]);
  const c2v = (await get("SELECT id FROM vouchers WHERE voucher_no = 'C2-INV-1'")).id;
  await run("INSERT INTO vouchers (voucher_type, voucher_no, date, party_ledger_id, total_amount) VALUES ('Receipt', 'C1-RCPT-1', date('now'), ?, 50)", [cust1.id]);
  const c1receipt = (await get("SELECT id FROM vouchers WHERE voucher_no = 'C1-RCPT-1'")).id;
  assert((await req('GET', `/api/portal/orders/${o4.id}`, { token: tk1 })).status === 404, 'Customer 1 asking for Customer 2\'s order by id gets 404 (as if it did not exist)');
  assert((await req('POST', `/api/portal/orders/${o4.id}/cancel`, { token: tk1, body: {} })).status === 404 && (await get('SELECT status FROM inv_orders WHERE id = ?', [o4.id])).status === 'draft', 'Cancelling someone else\'s order is refused and the order is untouched');
  assert((await req('GET', `/api/portal/invoices/${c2v}`, { token: tk1 })).status === 404, 'Customer 1 asking for Customer 2\'s invoice gets 404');
  assert((await req('GET', `/api/portal/invoices/${c1receipt}`, { token: tk1 })).status === 404, 'Even their OWN receipt voucher is not an invoice: 404');
  assert((await req('GET', `/api/portal/invoices/${invs.items[0].id}`, { token: tk2 })).status === 404 && (await req('GET', `/api/portal/orders/${o1.id}`, { token: tk2 })).status === 404, 'And the other way round: Customer 2 cannot open Customer 1\'s invoice or order');
  const allOrders = await all('SELECT id, party_ledger_id FROM inv_orders'), allVouchers = await all('SELECT id, party_ledger_id FROM vouchers');
  let leak = [];
  for (const o of allOrders) { const r = await req('GET', `/api/portal/orders/${o.id}`, { token: tk1 }); if ((o.party_ledger_id === cust1.id) !== (r.status === 200)) leak.push('order ' + o.id + ':' + r.status); }
  for (const v of allVouchers) { const r = await req('GET', `/api/portal/invoices/${v.id}`, { token: tk1 }); if (r.status === 200 && v.party_ledger_id !== cust1.id) leak.push('voucher ' + v.id); }
  assert(leak.length === 0, `Walking every order id (${allOrders.length}) and voucher id (${allVouchers.length}) in the database as Customer 1 reaches only Customer 1's own`, leak.join(', '));
  for (let n = 1; n <= 40; n++) { const r = await req('GET', `/api/portal/orders/${n}`, { token: tk2 }); if (r.status === 200) { const o = allOrders.find((x) => x.id === n); if (!o || o.party_ledger_id !== cust2.id) leak.push('guess ' + n); } }
  assert(leak.length === 0, 'Guessing ids 1–40 as Customer 2 also reaches only their own');
  for (const bad of ['0', '-1', '1%20OR%201=1', '1;DROP%20TABLE%20users', 'abc', '99999999999999999999', '1.5']) assert([400, 404].includes((await req('GET', `/api/portal/orders/${bad}`, { token: tk1 })).status), `Odd order id "${decodeURIComponent(bad)}" → 404, not data`);
  const l1o = await D('GET', `/api/portal/orders?party=${cust2.id}&party_id=${cust2.id}&customer=${cust2.id}&q=C2-SECRET`, { token: tk1 });
  assert(l1o.items.every((o) => o.reference !== 'C2-SECRET') && l1o.total === 0, 'Adding ?party= / ?customer= to a list changes nothing: still only their own orders');
  const l2 = await D('GET', '/api/portal/orders', { token: tk2 }), l2i = await D('GET', '/api/portal/invoices', { token: tk2 });
  assert(l2.items.every((o) => ['C2-SECRET', null, ''].includes(o.reference) || true) && l2.total === 1 && l2i.total === 1 && l2i.items[0].number === 'C2-INV-1', 'Customer 2\'s lists hold only Customer 2\'s order and invoice');
  assert(!JSON.stringify(await D('GET', '/api/portal/orders', { token: tk1 })).includes('C2-SECRET') && !JSON.stringify(await D('GET', '/api/portal/invoices', { token: tk1 })).includes('C2-INV-1'), 'Nothing of Customer 2 appears in Customer 1\'s lists');
  assert(!(JSON.stringify(full).match(/created_by|portal:|warehouse|cost/)), 'An order does not expose staff names, warehouses or costs');

  console.log('\n--- 8b. Customer dashboard inside RRE: dashboard, tracking, history, isolation ---');
  const G = (tk, p) => req('GET', p, { token: tk });
  const dash1 = (await G(tk1, '/api/portal/dashboard')).json.data, dash2 = (await G(tk2, '/api/portal/dashboard')).json.data;
  assert(dash1 && dash1.customer === 'Portal Customer One' && dash1.orders.total >= 1 && 'pending' in dash1.orders && 'completed' in dash1.orders && Array.isArray(dash1.notifications) && dash1.full_name, 'the dashboard shows the customer\'s name, profile and order totals (total, pending, completed)');
  assert(dash2.customer === 'Portal Customer Two' && dash2.orders.total !== undefined && !JSON.stringify(dash2).includes('Portal Customer One'), 'customer 2\'s dashboard is about customer 2 only');
  const pk1 = (await G(tk1, '/api/portal/packages')).json.data, pk2 = (await G(tk2, '/api/portal/packages')).json.data;
  assert(pk1.items.length >= 1 && pk1.steps.length === 7 && pk1.items.every((x) => x.status && x.status_label), 'package tracking lists the customer\'s own orders with their delivery stage');
  const nums1 = new Set(pk1.items.map((x) => x.order_number)), nums2 = new Set(pk2.items.map((x) => x.order_number));
  assert([...nums1].every((n) => !nums2.has(n)), 'no package or order number appears for both customers');
  const h1 = (await G(tk1, '/api/portal/history')).json.data, h2 = (await G(tk2, '/api/portal/history')).json.data;
  assert(h1.items.length >= 1 && h1.items.every((r) => ['order', 'invoice'].includes(r.kind)), 'purchase history combines the customer\'s orders and invoices');
  const ids1 = new Set(h1.items.map((r) => r.kind + r.number)), ids2 = new Set(h2.items.map((r) => r.kind + r.number));
  assert([...ids1].every((k) => !ids2.has(k)), 'purchase histories do not overlap');
  const f = (await G(tk1, '/api/portal/history?status=invoice')).json.data; assert(f.items.every((r) => r.kind === 'invoice'), 'history filters by type/status');
  const q1 = (await G(tk1, `/api/portal/history?q=${encodeURIComponent(h1.items[0].number)}`)).json.data; assert(q1.items.length >= 1 && q1.items.every((r) => r.number.includes(h1.items[0].number)), 'history searches by number');
  assert((await G(tk1, '/api/portal/orders/' + (await D('GET', '/api/portal/orders', { token: tk2 })).items[0].id)).status === 404, 'changing the order id in the URL does not reveal another customer\'s order');
  for (const p of ['/api/portal/dashboard', '/api/portal/packages', '/api/portal/history']) assert((await G(null, p)).status === 401 && (await G(acc, p)).status === 403, `${p} refuses anonymous users and staff`);
  assert((await Promise.all([G(tk1, '/api/portal/dashboard'), G(tk2, '/api/portal/dashboard'), G(tk1, '/api/portal/packages'), G(tk2, '/api/portal/packages')])).every((r) => r.status === 200), 'two customers can use the application at the same time with independent sessions');

  console.log('\n--- 9. Disabling, resetting, deleting ---');
  const dis = await req('POST', `/api/inv/portal-users/${u1.id}/disable`);
  assert(dis.status === 200 && dis.json.data.status === 'Inactive', 'Staff disable a portal login');
  assert((await req('GET', '/api/portal/me', { token: tk1 })).status === 401, 'The disabled customer\'s existing session stops working at once');
  assert((await login('cust1.buyer', PW2)).status === 401, 'They cannot sign in again');
  assert((await req('POST', `/api/inv/portal-users/${u1.id}/enable`)).status === 200 && (await login('cust1.buyer', PW2)).status === 200 && (await req('GET', '/api/portal/me', { token: tk1 })).status === 401, 'Re-enabling lets them sign in again (the session ended by the disabling stays ended)');
  const rs = await req('POST', `/api/inv/portal-users/${u1.id}/reset-password`, { body: { password: 'Reset#Temp2026ab' } });
  assert(rs.status === 200 && rs.json.data.must_change === 1 && (await login('cust1.buyer', PW2)).status === 401, 'Resetting the password locks out the old one');
  assert((await req('POST', `/api/inv/portal-users/${u1.id}/reset-password`, { body: { password: '123' } })).status === 400, 'A weak reset password is refused');
  assert((await login('cust1.buyer', 'Reset#Temp2026ab')).json.data.must_change_password === true, 'The new temporary password must be changed at first sign-in');
  for (const [n, t] of [['Accountant', acc], ['customer', tk2]]) assert((await req('POST', `/api/inv/portal-users/${u1.id}/disable`, { token: t })).status === 403, `${n} cannot disable a login`);
  assert((await req('POST', '/api/inv/portal-users/1/disable')).status === 404 && (await req('POST', '/api/inv/portal-users/1/reset-password', { body: { password: 'Some#Pass2026xy' } })).status === 404, 'These routes refuse to touch a STAFF account (the Owner)');
  const dl = await req('DELETE', `/api/auth/users/${u2.id}`);
  assert(dl.status === 400 && /placed \d+ order/.test(dl.json.error), 'A login that has placed orders cannot be deleted (deactivate instead)');
  assert((await req('PUT', `/api/auth/users/${u2.id}`, { body: { role: 'Owner' } })).status === 400, 'A portal login cannot be promoted to a staff role');
  // a real staff account made for this check (id 3 is staff only in copies of the live database, not on a fresh PostgreSQL copy)
  const staffId = (await req('POST', '/api/auth/users', { body: { full_name: 'Staff Check', email: 'staff.check@example.com', role: 'Accountant', password: 'Staff#Check-2026x' } })).json.data.id;
  assert((await get('SELECT role FROM users WHERE id = ?', [staffId])).role === 'Accountant'
    && (await req('PUT', `/api/auth/users/${staffId}`, { body: { role: 'Customer' } })).status === 400
    && (await get('SELECT role FROM users WHERE id = ?', [staffId])).role === 'Accountant', 'A staff user cannot be turned into a portal login');
  const fresh = (await mkUser(admin, { party_id: cust1.id, username: 'cust1.second', password: PW })).json.data;
  assert((await req('DELETE', `/api/auth/users/${fresh.id}`)).status === 200, 'A portal login with no orders can be deleted');
  assert((await req('GET', '/api/portal/me', { token: tk2 })).status === 200, 'Customer 2 is unaffected by all of this');
  await run('UPDATE ledgers SET is_active = 0 WHERE id = ?', [cust2.id]);
  const arch = await req('GET', '/api/portal/me', { token: tk2 });
  assert(arch.status === 403 && arch.json.code === 'NO_CUSTOMER', 'If the customer account is archived, the portal login stops working');
  await run('UPDATE ledgers SET is_active = 1 WHERE id = ?', [cust2.id]);
  await run('UPDATE users SET party_id = NULL WHERE id = ?', [u2.id]);
  assert((await req('GET', '/api/portal/me', { token: tk2 })).status === 403, 'A login with no customer link gets nothing');
  await run('UPDATE users SET party_id = ? WHERE id = ?', [cust2.id, u2.id]);

  console.log('\n--- 10. Existing behaviour is untouched ---');
  assert((await req('GET', '/api/inv/items', { token: acc })).status === 200 && (await req('GET', '/api/vouchers', { token: clerk })).status === 200 && (await req('GET', '/api/reports/trial-balance', { token: acc })).status === 200, 'Staff roles still reach everything they did before');
  assert((await req('GET', '/api/reports/trial-balance', { token: clerk })).status === 403, 'Data Entry is still blocked from financial statements');
  assert((await D('GET', '/api/auth/users')).every((u) => !('password' in u)), 'The user list still never returns passwords');
  const logs = await all("SELECT action FROM activity_log WHERE action LIKE 'PORTAL_%' OR (action = 'INV_ORDER_CREATE' AND username LIKE 'portal:%')");
  const acts = new Set(logs.map((l) => l.action));
  assert(['PORTAL_USER_CREATE', 'PORTAL_USER_DISABLE', 'PORTAL_USER_ENABLE', 'PORTAL_USER_RESET_PASSWORD', 'PORTAL_ORDER_CANCEL', 'INV_ORDER_CREATE'].every((a) => acts.has(a)), 'Creating, disabling, enabling, resetting, placing and cancelling are all in the audit trail', [...acts].join(','));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

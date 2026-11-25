process.env.RRE_ENFORCE_AUTH = '1';
/**
 * One application, many companies: every self-registered customer works in the full Tally application inside a PRIVATE company, side by
 * side with the owner's and with each other, on separate database connections. This suite is about ISOLATION.
 *   node test_tenants.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_tenants_test_'));
process.env.RRE_DATA_DIR = tmp;
process.env.RRE_INVENTORY_SEED = '0'; process.env.RRE_BRIDGE_AUTO = '0';

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { loginRateLimiter } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const PW = 'Winter#Garden-2026';
const calm = () => { for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginRateLimiter.recordSuccess(ip); } catch (e) { /* ignore */ } } };

async function main() {
  await initDb(); await runMigrations();
  for (const t of ['user_logins', 'auth_sessions', 'password_resets', 'users']) await run('DELETE FROM ' + t);
  await require('./core/db').hardenAccounts(true);
  const srv = await startServer(13800 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  console.log('\n--- 1. The owner and customers each get their own books ---');
  const setup = await req('POST', '/api/auth/setup', { body: { password: PW } });
  const OWN = setup.json.data.token;
  const groups = (await req('GET', '/api/masters/groups', { token: OWN })).json.data || [];
  const grp = (groups.find((g) => /sundry debtors/i.test(g.name)) || groups[0]).id;
  assert((await req('POST', '/api/masters/ledgers', { token: OWN, body: { name: 'Owner Private Ledger', group_id: grp } })).json.success, 'the owner creates a ledger in the owner\'s company');

  const mk = async (name, email) => {
    const r = await req('POST', '/api/auth/signup', { body: { full_name: name, email, phone: '+91 98765 43210', password: 'Maple#Secure2026x', confirm: 'Maple#Secure2026x' } });
    return { status: r.status, token: r.json && r.json.data && r.json.data.token, company: r.json && r.json.data && r.json.data.user && r.json.data.user.own_company };
  };
  calm(); const t0 = Date.now();
  const A = await mk('Alice Trader', 'alice@t.example'); const ms = Date.now() - t0;
  const B = await mk('Bob Retailer', 'bob@t.example');
  assert(A.status === 201 && A.token && A.company && B.token, 'two customers register and are signed in', JSON.stringify([A.status, B.status]));
  assert(ms < 20000, 'creating a customer\'s company does not take long', ms + ' ms');
  assert(require('./core/db').companyExists('U' + (await get("SELECT id FROM users WHERE email = 'alice@t.example'")).id), 'each customer\'s company is a separate company (its own database file on SQLite, its own company number on PostgreSQL)');

  const names = async (tk) => ((await req('GET', '/api/masters/ledgers', { token: tk })).json.data || []).map((l) => l.name);
  assert((await req('POST', '/api/masters/ledgers', { token: A.token, body: { name: 'Alice Secret Ledger', group_id: grp } })).json.success, 'Alice creates a ledger in her company');
  assert((await req('POST', '/api/masters/ledgers', { token: B.token, body: { name: 'Bob Secret Ledger', group_id: grp } })).json.success, 'Bob creates a ledger in his company');
  const [nA, nB, nO] = [await names(A.token), await names(B.token), await names(OWN)];
  assert(nA.includes('Alice Secret Ledger') && !nA.includes('Bob Secret Ledger') && !nA.includes('Owner Private Ledger'), 'Alice sees only her own ledgers');
  assert(nB.includes('Bob Secret Ledger') && !nB.includes('Alice Secret Ledger') && !nB.includes('Owner Private Ledger'), 'Bob sees only his own ledgers');
  assert(nO.includes('Owner Private Ledger') && !nO.includes('Alice Secret Ledger') && !nO.includes('Bob Secret Ledger'), 'the owner sees only the owner\'s ledgers: customers\' books never leak into the owner\'s');
  assert((await get("SELECT COUNT(*) c FROM ledgers WHERE name LIKE '%Secret%'")).c === 0, 'nothing a customer does is written into the owner\'s database');

  console.log('\n--- 2. Real accounting in each company ---');
  const post = async (tk, no, amount) => {
    const lg = (await req('GET', '/api/masters/ledgers', { token: tk })).json.data;
    const cash = lg.find((l) => /cash/i.test(l.name)), bank = lg.find((l) => /bank/i.test(l.name));
    return req('POST', '/api/vouchers', { token: tk, body: { voucher_type: 'Contra', voucher_no: no, date: '2026-06-01', narration: 'tenant test', entries: [{ ledger_id: bank.id, debit_amount: amount, credit_amount: 0 }, { ledger_id: cash.id, debit_amount: 0, credit_amount: amount }] } });
  };
  const pa = await post(A.token, 'ALICE-1', 700), pb = await post(B.token, 'BOB-1', 300);
  assert(pa.json.success && pb.json.success, 'each customer posts a double-entry voucher in their own company', pa.raw.slice(0, 120) + pb.raw.slice(0, 120));
  const dayA = JSON.stringify((await req('GET', '/api/reports/daybook', { token: A.token })).json), dayB = JSON.stringify((await req('GET', '/api/reports/daybook', { token: B.token })).json), dayO = JSON.stringify((await req('GET', '/api/reports/daybook', { token: OWN })).json);
  assert(dayA.includes('ALICE-1') && !dayA.includes('BOB-1') && dayB.includes('BOB-1') && !dayB.includes('ALICE-1') && !dayO.includes('ALICE-1') && !dayO.includes('BOB-1'), 'each Day Book holds only that company\'s vouchers');
  const vA = (await req('GET', '/api/vouchers', { token: A.token })).raw, vB = (await req('GET', '/api/vouchers', { token: B.token })).raw;
  assert(vA.includes('ALICE-1') && !vA.includes('BOB-1') && vB.includes('BOB-1') && !vB.includes('ALICE-1'), 'the voucher lists are separate too');
  const tbA = (await req('GET', '/api/reports/trial-balance', { token: A.token })).status, ba = (await req('GET', '/api/reports/balance-sheet', { token: A.token })).status;
  assert(tbA === 200 && ba === 200, 'reports (trial balance, balance sheet) work in a customer\'s company');
  assert((await req('GET', '/api/inv/items', { token: A.token })).status === 200 && (await req('GET', '/api/dashboard/tiles', { token: A.token })).status === 200, 'inventory and the dashboard work in a customer\'s company');

  console.log('\n--- 3. Many customers at the same time ---');
  const crowd = await Promise.all(['c1', 'c2', 'c3', 'c4'].map((n) => mk('Crowd ' + n, n + '@t.example')));
  assert(crowd.every((c) => c.status === 201 && c.token && c.company), 'four customers register at the same moment');
  const ncomp = await require('./core/db').all("SELECT DISTINCT company_id FROM users WHERE email LIKE 'c_@t.example' AND company_id IS NOT NULL"); assert(ncomp.length === 4, 'each gets a different company');
  await Promise.all(crowd.map((c, i) => req('POST', '/api/masters/ledgers', { token: c.token, body: { name: 'Crowd Ledger ' + i, group_id: grp } })));
  const seen = await Promise.all(crowd.map((c) => names(c.token)));
  assert(seen.every((list, i) => list.includes('Crowd Ledger ' + i) && list.filter((n) => /Crowd Ledger/.test(n)).length === 1), 'concurrent customers each see only their own data');
  const mix = await Promise.all([post(A.token, 'ALICE-2', 50), post(B.token, 'BOB-2', 60), req('GET', '/api/reports/daybook', { token: OWN }), req('GET', '/api/vouchers', { token: crowd[0].token })]);
  assert(mix.every((r) => r.status === 200), 'simultaneous work in different companies does not interfere');

  console.log('\n--- 4. What a customer can NOT do ---');
  const deny = ['/api/auth/users', '/api/auth/login-activity', '/api/companies', '/api/system/logs', '/api/backup/list', '/api/auth/audit-log'];
  for (const p of deny) assert([403, 404].includes((await req('GET', p, { token: A.token })).status), 'refused: ' + p);
  assert((await req('POST', '/api/companies', { token: A.token, body: { name: 'Hack Co' } })).status === 403 && (await req('POST', '/api/companies/switch', { token: A.token, body: { number: '100000' } })).status === 403, 'a customer can neither create nor switch companies');
  assert((await req('POST', '/api/auth/users', { token: A.token, body: { full_name: 'Evil Admin', email: 'evil@t.example', role: 'Owner', password: PW } })).status === 403, 'a customer cannot create users or an administrator');
  assert((await req('PUT', '/api/auth/users/1', { token: A.token, body: { role: 'Viewer' } })).status === 403, 'a customer cannot change anyone\'s role');
  const me = (await req('GET', '/api/auth/me', { token: A.token })).json.data;
  assert(me.user.role === 'Customer' && me.permissions.canManageUsers === false, 'the role stays Customer; user management is not among their permissions');
  assert((await req('GET', '/api/vouchers')).status === 401, 'anonymous requests are still refused');

  console.log('\n--- 5. Admin and employees are unchanged ---');
  assert((await req('GET', '/api/auth/users', { token: OWN })).status === 200 && (await req('GET', '/api/companies', { token: OWN })).status === 200 && (await req('GET', '/api/auth/login-activity', { token: OWN })).status === 200, 'the administrator keeps user management, the company list and login activity');
  const ids = (await req('GET', '/api/auth/users', { token: OWN })).json.data;
  assert(ids.filter((u) => u.role === 'Customer').length >= 6 && ids.filter((u) => u.role === 'Owner').length === 1, 'every registration is an ordinary Customer; there is still exactly one administrator');
  assert((await req('GET', '/api/companies', { token: OWN })).json.data.companies.length === 1, 'customers\' private companies do not clutter the owner\'s company list');
  const emp = await req('POST', '/api/auth/users', { token: OWN, body: { full_name: 'Emma Employee', email: 'emma@t.example', role: 'Accountant', password: 'Employee#Pass2026x', extras: ['logins'] } });
  assert(emp.json.success, 'the administrator creates an employee with login-monitoring access');
  calm(); const E = (await req('POST', '/api/auth/login', { body: { identifier: 'emma@t.example', password: 'Employee#Pass2026x', login_type: 'employee' } })).json.data;
  const chg = await req('POST', '/api/auth/change-password', { token: E.token, body: { current_password: 'Employee#Pass2026x', new_password: 'Employee#Pass2027y' } });
  const ET = chg.json.data.token;
  assert((await req('GET', '/api/auth/login-activity', { token: ET })).status === 200, 'an employee the administrator allowed can see login and sign-up activity');
  assert((await req('GET', '/api/companies', { token: ET })).status === 403, 'but not the company list (not allowed)');
  assert((await req('GET', '/api/auth/users', { token: ET })).status === 403, 'and never user management');
  assert((await req('GET', '/api/vouchers', { token: ET })).status === 200 && !(await req('GET', '/api/vouchers', { token: ET })).raw.includes('ALICE-1'), 'the employee works in the owner\'s company, never in a customer\'s');
  const act = (await req('GET', '/api/auth/login-activity?limit=200', { token: OWN })).json.data;
  assert(act.events.some((e) => e.action === 'AUTH_SIGNUP') && act.logins.length > 3, 'sign-ups and logins are tracked for the administrator');

  console.log('\n--- 6. Customers who signed up before this change get their own company too ---');
  const lg = await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES ('Old Signup Person', ?, 0, 'Dr')", [grp]);
  const lg2 = await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES ('Admin Linked Buyer', ?, 0, 'Dr')", [grp]);
  const hash = (await get("SELECT password FROM users WHERE role = 'Owner'")).password;
  const u1 = await run("INSERT INTO users (username, password, full_name, role, email, status, party_id, email_verified) VALUES ('oldsignup', ?, 'Old Signup Person', 'Customer', 'old@t.example', 'Active', ?, 1)", [hash, lg.lastID]);
  const u2 = await run("INSERT INTO users (username, password, full_name, role, email, status, party_id, email_verified) VALUES ('linkedbuyer', ?, 'Admin Linked Buyer', 'Customer', 'linked@t.example', 'Active', ?, 1)", [hash, lg2.lastID]);
  await run("INSERT INTO activity_log (username, role, action, entity, entity_id) VALUES ('self-registration', 'System', 'INV_CUSTOMER_CREATE', 'ledger', ?)", [String(lg.lastID)]);
  const upg = await require('./core/identity').upgradeSelfRegistered();
  assert(upg === 1 && (await get('SELECT company_id FROM users WHERE id = ?', [u1.lastID])).company_id === 'U' + u1.lastID, 'an earlier self-registered customer is given a company of their own');
  assert((await get('SELECT company_id FROM users WHERE id = ?', [u2.lastID])).company_id === null, 'a customer an administrator linked to a customer account is left as a portal customer');
  assert((await get("SELECT COUNT(*) c FROM ledgers WHERE name = 'Old Signup Person'")).c === 1, 'their earlier ledger is kept');
  assert((await require('./core/identity').upgradeSelfRegistered()) === 0, 'running it again changes nothing');

  console.log('\n--- 7. Inventory for everyone: a private inventory per company ---');
  const hostMod = require('./core/inventoryHost');
  if (!(await hostMod.findPython())) console.log('  (Python with the inventory requirements was not found: this section is skipped)');
  else {
    const open = async (tk) => { for (let i = 0; i < 60; i++) { const r = await req('POST', '/api/inventory-app/launch', { token: tk, body: { nowait: true } }); if (r.status !== 202) return r; await new Promise((x) => setTimeout(x, 1500)); } return { status: 0, json: {} }; };
    const [la, lb] = [await open(A.token), await open(B.token)];
    assert(la.status === 200 && lb.status === 200, 'every customer can open Inventory from the side bar', JSON.stringify([la.json, lb.json]).slice(0, 200));
    const portOf = (r) => new URL(r.json.data.url).port;
    assert(portOf(la) !== portOf(lb), 'each company runs its own inventory (separate process and database)');
    const sp = async (r, p, tok, m = 'GET', body) => { const base2 = `http://127.0.0.1:${portOf(r)}`; const res = await fetch(base2 + p, { method: m, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => ({})) }; };
    const sa = await sp(la, '/api/rre/sso', null, 'POST', { token: new URL(la.json.data.url).searchParams.get('sso') });
    const sb = await sp(lb, '/api/rre/sso', null, 'POST', { token: new URL(lb.json.data.url).searchParams.get('sso') });
    assert(sa.status === 200 && sa.json.user && sa.json.user.role === 'owner' && sa.json.user.email === 'alice@t.example', 'Alice is signed in as the owner of her own inventory (no second login)', JSON.stringify(sa.json).slice(0, 160));
    const pa2 = await sp(la, '/api/products', sa.json.access_token, 'POST', { name: 'Alice Only Product', sku: 'AO-1', purchase_price: 10, selling_price: 15, tax_rate: 18 });
    const listA = JSON.stringify((await sp(la, '/api/products', sa.json.access_token)).json), listB = JSON.stringify((await sp(lb, '/api/products', sb.json.access_token)).json);
    assert(pa2.status < 300 && listA.includes('Alice Only Product') && !listB.includes('Alice Only Product'), 'what Alice stores in her inventory is not in Bob\'s');
    assert((await sp(la, '/api/auth/login', null, 'POST', { email: 'alice@t.example', password: 'x' })).status === 410, 'there is still no separate inventory login');
    assert((await sp(la, '/api/monitor/sessions', sa.json.access_token)).status === 410 && (await sp(la, '/api/users', sa.json.access_token)).status === 410, 'the removed admin screens (login history, users) are closed on the server');
    const page = await (await fetch(`http://127.0.0.1:${portOf(la)}/admin/settings`)).text();
    assert(/GONE=/.test(page) && page.includes('a[href^="/admin/"][href$="/settings"]'),'the inventory page hides Login history, Support tickets, Users and Settings and sends direct visits back to the dashboard');
    const org = (await sp(la, '/api/organization', sa.json.access_token)).json;
    assert(org && org.state === 'Tamil Nadu' && /Alice Trader/.test(org.name || ''), 'the inventory organisation (name, GST state) comes from the RRE company, since its Settings screen is gone', JSON.stringify(org).slice(0, 120));
    const ownL = await req('POST', '/api/inventory-app/launch', { token: OWN, body: { nowait: false } });
    assert(ownL.status === 200 && portOf(ownL) !== portOf(la) && portOf(ownL) !== portOf(lb), 'the owner\'s inventory is a third, separate one');
    assert((await req('POST', '/api/auth/users/' + (await get("SELECT id FROM users WHERE email = 'alice@t.example'")).id + '/sign-out', { token: OWN })).json.success, 'the administrator can end a customer\'s session');
    for (const st of hostMod._states.values()) { try { await require('./core/db').withCompany(st.company, () => hostMod.stop()); } catch (e) { /* ignore */ } }
  }

  console.log(`\nTenants: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

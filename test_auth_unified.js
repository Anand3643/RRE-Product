process.env.RRE_ENFORCE_AUTH = '1';
process.env.RRE_TEST_AWAIT_MAIL = '1';
process.env.RRE_PUBLIC_URL = 'http://rre.test:4000';
/**
 * Unified authentication suite: ONE login (Admin / Employee / Customer), one user table, roles checked by the server, sessions that can
 * be ended, Argon2id hashes, lock-out, forgot / reset password by e-mail (tokens single-use, time-limited, hashed at rest), and the
 * administrator's user management. E-mail is captured by a fake transport, so nothing is sent. DISPOSABLE data directory.
 *   node test_auth_unified.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_authu_test_'));
process.env.RRE_DATA_DIR = tmp;
process.env.RRE_INVENTORY_SEED = '0'; process.env.RRE_BRIDGE_AUTO = '0';

const mailer = require('./core/mailer');
const outbox = [];
mailer.setTransport({ sendMail: async (m) => { outbox.push(m); } });

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const PW = 'Winter#Garden-2026', EMP = 'Employee#Pass2026x', CUS = 'Customer#Pass2026x', NEW = 'Brand#New2026pw';
const tokenFrom = (m) => decodeURIComponent((/reset=([^\s"&<]+)/.exec(m.text) || [])[1] || '');

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM user_logins'); await run('DELETE FROM auth_sessions'); await run('DELETE FROM password_resets'); await run('DELETE FROM users'); // the pre-seeded copy has demo accounts: start as a fresh installation
  await require('./core/db').hardenAccounts(true);
  const srv = await startServer(13700 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const login = (identifier, password, login_type, extra = {}) => req('POST', '/api/auth/login', { body: { identifier, password, login_type, ...extra } });
  // the application limits sign-in attempts per address; this suite signs in a lot, so it clears the counter between sections
  const { loginRateLimiter } = require('./core/security'); const calm = () => { try { loginRateLimiter.recordSuccess('::ffff:127.0.0.1'); loginRateLimiter.recordSuccess('127.0.0.1'); loginRateLimiter.recordSuccess('::1'); } catch (e) {} };

  console.log('\n--- 1. First start: no default credentials, nothing works without sign-in ---');
  const cfg = await req('GET', '/api/auth/config');
  assert(cfg.json.data.setup_required === true && cfg.json.data.login_types.length === 3, 'a fresh install asks for a first-time administrator password and offers three login types');
  assert((await req('GET', '/api/vouchers')).status === 401 && (await req('GET', '/api/inv/items')).status === 401 && (await req('GET', '/api/auth/users')).status === 401, 'protected routes refuse anonymous requests (accounting, inventory, users)');
  assert((await login('admin', 'admin', 'admin')).status === 401 && (await login('admin', '', 'admin')).status === 401, 'no default password works');
  const setup = await req('POST', '/api/auth/setup', { body: { password: PW } });
  assert(setup.json && setup.json.success && setup.json.data.token, 'the first administrator password is chosen on this computer', setup.raw.slice(0, 200));
  const adminRow = await get("SELECT * FROM users WHERE role = 'Owner' ORDER BY id LIMIT 1");
  assert(adminRow.password.startsWith('argon2id$'), 'the administrator password is stored as an Argon2id hash', adminRow.password.slice(0, 12));
  assert(!JSON.stringify(setup.json).includes(adminRow.password) && !JSON.stringify(setup.json).includes(PW), 'the response contains no hash and no password');

  console.log('\n--- 2. Login types are checked against the role stored on the server ---');
  calm();
  const a1 = await login('admin', PW, 'admin');
  assert(a1.status === 200 && a1.json.data.login_type === 'admin' && a1.json.data.home === 'app' && a1.json.data.user.role === 'Owner', 'Admin login works and routes to the full application');
  const A = a1.json.data.token;
  assert(a1.json.data.user.password === undefined && !a1.raw.includes('argon2id'), 'sign-in response never carries a password or hash');
  const wrongType = await login('admin', PW, 'employee'), wrongType2 = await login('admin', PW, 'customer'), badPw = await login('admin', 'nope-nope-1A!', 'admin'), noUser = await login('ghost@nowhere.example', 'nope-nope-1A!', 'admin');
  assert(wrongType.status === 401 && wrongType2.status === 401, 'choosing the wrong login type does not sign an administrator in');
  assert(wrongType.json.error === badPw.json.error && badPw.json.error === noUser.json.error, 'wrong type, wrong password and unknown account all give the same message (nothing is revealed)');
  assert((await login('admin', PW, 'superuser')).status === 401, 'an invented login type is refused');
  assert((await login('admin', PW, null)).status === 200, 'sign-in without a type still checks the real role (compatibility)');

  console.log('\n--- 3. Administrator creates employee and customer accounts (invitation by e-mail) ---');
  const adm = (m, p, body) => req(m, p, { token: A, body });
  assert((await adm('POST', '/api/auth/users', { full_name: 'Eve Employee', role: 'Accountant' })).status === 400, 'an e-mail address is required for an invitation');
  outbox.length = 0;
  const e1 = await adm('POST', '/api/auth/users', { full_name: 'Eve Employee', email: 'eve@example.com', role: 'Accountant' });
  assert(e1.json.success && e1.json.data.invited === true && outbox.length === 1 && outbox[0].to === 'eve@example.com', 'employee created and an invitation e-mail was sent');
  const empUser = await get("SELECT * FROM users WHERE email = 'eve@example.com'");
  assert(empUser && empUser.role === 'Accountant' && empUser.must_change_password === 1, 'the employee account exists once, with the chosen role');
  assert(!/argon2|\$/.test(empUser.password) === false && empUser.password.startsWith('argon2id$'), 'before choosing a password the account holds only an unguessable random hash');
  assert((await login('eve@example.com', 'whatever-1A!x', 'employee')).status === 401, 'nobody can sign in to an invited account before the link is used');
  const inviteTok = tokenFrom(outbox[0]);
  assert(inviteTok.length > 30, 'the invitation contains a long random link token');
  const stored = await get('SELECT * FROM password_resets WHERE user_id = ?', [empUser.id]);
  assert(stored && stored.token_hash && stored.token_hash !== inviteTok && !stored.token_hash.includes(inviteTok), 'the token is stored only as a hash');
  assert((await req('GET', '/api/auth/reset/validate?token=' + encodeURIComponent(inviteTok))).json.data.valid === true, 'the link validates');
  assert((await req('POST', '/api/auth/reset', { body: { token: inviteTok, password: 'short' } })).status === 422, 'a weak password is refused');
  assert((await req('POST', '/api/auth/reset', { body: { token: inviteTok, password: EMP, confirm: 'different' } })).status === 422, 'mismatched confirmation is refused');
  assert((await req('POST', '/api/auth/reset', { body: { token: inviteTok, password: EMP, confirm: EMP } })).json.success === true, 'the person chooses a password with the link');
  assert((await req('POST', '/api/auth/reset', { body: { token: inviteTok, password: NEW, confirm: NEW } })).status === 400, 'the link cannot be used twice');
  calm();
  const e2 = await login('eve@example.com', EMP, 'employee');
  assert(e2.status === 200 && e2.json.data.login_type === 'employee' && e2.json.data.must_change_password === false, 'employee signs in with e-mail after choosing a password');
  const E = e2.json.data.token;
  assert((await login('eve@example.com', EMP, 'admin')).status === 401 && (await login('eve@example.com', EMP, 'customer')).status === 401, 'an employee cannot enter through the Admin or Customer option');

  // a customer: tied to a customer account in the books
  const party = await req('POST', '/api/inv/customers', { token: A, body: { name: 'Acme Traders', state_code: '33' } });
  const partyId = party.json && party.json.data && party.json.data.id;
  assert(partyId, 'a customer record exists to attach a login to');
  outbox.length = 0;
  const c1 = await adm('POST', '/api/auth/users', { full_name: 'Carl Customer', email: 'carl@example.com', role: 'Customer', party_id: partyId, password: CUS });
  assert(c1.json.success && outbox.length === 0, 'an administrator can instead set a temporary password (no e-mail)');
  calm();
  const c2 = await login('carl@example.com', CUS, 'customer');
  assert(c2.status === 200 && c2.json.data.must_change_password === true && c2.json.data.home === 'app' && c2.json.data.user.customer.name === 'Acme Traders', 'customer signs in, must change the temporary password, stays inside the main application');
  const C = c2.json.data.token;
  assert((await req('GET', '/api/inv/items', { token: C })).status === 403, 'a customer with a temporary password cannot do anything but change it');
  const chg = await req('POST', '/api/auth/change-password', { token: C, body: { current_password: CUS, new_password: NEW } });
  assert(chg.json.success && chg.json.data.token, 'the customer chooses their own password');
  const C2 = chg.json.data.token;

  console.log('\n--- 4. Authorisation is on the server (role, module, other people\'s data) ---');
  const g = (t, p) => req('GET', p, { token: t });
  assert((await g(E, '/api/auth/users')).status === 403 && (await req('POST', '/api/auth/users', { token: E, body: { full_name: 'X Y', email: 'x@example.com', role: 'Owner', password: EMP } })).status === 403, 'an employee cannot see or create users');
  assert((await g(C2, '/api/auth/users')).status === 403 && (await g(C2, '/api/vouchers')).status === 403 && (await g(C2, '/api/inv/items')).status === 403, 'a customer is confined to their own area');
  assert((await g(C2, '/api/portal/me')).status === 200 || (await g(C2, '/api/portal/products')).status === 200, 'a customer reaches the customer portal');
  assert((await g(E, '/api/vouchers')).status === 200 && (await g(A, '/api/auth/users')).status === 200, 'employee reaches accounting; administrator reaches user management');
  const me = await g(C2, '/api/auth/me');
  assert(me.status === 200 && me.json.data.user.username === 'carl@example.com'.split('@')[0] && me.json.data.login_type === 'customer', 'a customer can read their own profile');
  assert((await req('PUT', '/api/auth/users/' + empUser.id, { token: E, body: { role: 'Owner' } })).status === 403, 'an employee cannot promote themselves');
  const mod = await adm('PUT', '/api/auth/users/' + empUser.id, { modules: ['reports'] });
  assert(mod.json.success && Array.isArray(mod.json.data.modules), 'the administrator limits the employee to chosen modules');
  assert((await g(E, '/api/inv/items')).status === 403 && (await g(E, '/api/inv/items')).json.code === 'MODULE_FORBIDDEN', 'the employee is refused the Inventory module immediately');
  assert((await g(E, '/api/reports/trial-balance')).status !== 403, 'the employee still reaches the module they were given');
  await adm('PUT', '/api/auth/users/' + empUser.id, { modules: null });
  assert((await g(E, '/api/inv/items')).status === 200, 'removing the limit restores access');
  const list = await adm('GET', '/api/auth/users');
  assert(list.json.data.length >= 3 && !/argon2|"password"|token_hash/.test(list.raw), 'user management lists people without any password or hash');
  assert(list.json.data.every((u) => 'created_at' in u && 'last_login' in u && 'status' in u && 'login_type' in u), 'user management shows status, creation date, last login and type');

  console.log('\n--- 5. Lock-out, deactivation, sessions ---');
  calm();
  for (let i = 0; i < 5; i++) await login('eve@example.com', 'wrong-Pass-1A!', 'employee');
  calm();
  assert((await login('eve@example.com', EMP, 'employee')).status === 401, 'after repeated failures the account is locked, even for the correct password');
  assert((await adm('POST', '/api/auth/users/' + empUser.id + '/unlock')).json.success, 'an administrator can unlock it');
  calm();
  const e3 = await login('eve@example.com', EMP, 'employee'); assert(e3.status === 200, 'sign-in works again after unlocking');
  const E3 = e3.json.data.token;
  const lg = await req('POST', '/api/auth/logout', { token: E3 });
  assert(lg.json.success && (await g(E3, '/api/vouchers')).status === 401, 'logout ends the session on the server: the same token no longer works');
  calm();
  const e4 = await login('eve@example.com', EMP, 'employee', { remember: true }); const E4 = e4.json.data.token;
  assert((await g(E4, '/api/vouchers')).status === 200, 'remember-me session works');
  const deact = await adm('PUT', '/api/auth/users/' + empUser.id, { status: 'Inactive' });
  assert(deact.json.success && (await g(E4, '/api/vouchers')).status === 401, 'deactivating an account ends its sessions at once');
  assert((await login('eve@example.com', EMP, 'employee')).status === 401, 'a deactivated account cannot sign in');
  await adm('PUT', '/api/auth/users/' + empUser.id, { status: 'Active' });
  assert((await adm('PUT', '/api/auth/users/' + adminRow.id, { status: 'Inactive' })).status === 400, 'an administrator cannot deactivate themselves');
  assert((await adm('PUT', '/api/auth/users/' + adminRow.id, { role: 'Viewer' })).status === 400, 'an administrator cannot change their own role (so the last administrator is never lost)');
  assert((await adm('PUT', '/api/auth/users/' + empUser.id, { role: 'Customer' })).status === 400, 'a staff account cannot be turned into a customer login');
  assert((await adm('POST', '/api/auth/users', { full_name: 'Dup Eve', email: 'EVE@example.com', role: 'Viewer', password: EMP })).status === 409, 'no second account may use the same e-mail address (duplicates are prevented)');

  console.log('\n--- 6. Forgot password (all three roles) ---');
  const forgotFor = async (email) => { outbox.length = 0; const r = await req('POST', '/api/auth/forgot', { body: { email } }); return { r, mail: outbox[0] }; };
  const fA = await forgotFor('nobody@example.com');
  await run("UPDATE users SET email = 'owner@example.com' WHERE id = ?", [adminRow.id]); // the administrator's own address (an admin sets it in user management)
  require('./core/identity').refreshAll();
  const fB = await forgotFor('owner@example.com');
  assert(fA.r.status === 200 && fB.r.status === 200 && fA.r.json.message === fB.r.json.message, 'the answer is identical for an unknown and a registered address');
  assert(!fA.mail && fB.mail && fB.mail.to === 'owner@example.com', 'only the registered address receives a mail');
  const adminTok = tokenFrom(fB.mail);
  assert(fB.mail.text.includes('http://rre.test:4000/login.html?reset='), 'the link points at the configured public address');
  assert(!fB.mail.text.includes(PW), 'the mail never contains a password');
  // expired
  await run("UPDATE password_resets SET expires_at = ? WHERE token_hash IS NOT NULL AND used_at IS NULL", [new Date(Date.now() - 1000).toISOString()]);
  assert((await req('POST', '/api/auth/reset', { body: { token: adminTok, password: NEW, confirm: NEW } })).status === 400 && (await req('GET', '/api/auth/reset/validate?token=' + adminTok)).json.data.valid === false, 'an expired link is refused');
  assert((await req('POST', '/api/auth/reset', { body: { token: 'x'.repeat(43), password: NEW } })).status === 400, 'a made-up link is refused');
  // a newer request makes older links useless; use the newest
  const fB2 = await forgotFor('owner@example.com'), t2 = tokenFrom(fB2.mail);
  const fB3 = await forgotFor('owner@example.com'), t3 = tokenFrom(fB3.mail);
  assert((await req('POST', '/api/auth/reset', { body: { token: t2, password: NEW, confirm: NEW } })).status === 400, 'asking again invalidates the previous link');
  calm();
  outbox.length = 0;
  const done = await req('POST', '/api/auth/reset', { body: { token: t3, password: NEW, confirm: NEW } });
  assert(done.json.success, 'the administrator resets their password with the newest link');
  assert(outbox.some((m) => m.to === 'owner@example.com' && /changed/i.test(m.subject)), 'a confirmation e-mail is sent after the change');
  assert((await g(A, '/api/vouchers')).status === 401, 'all old sessions of that account are signed out after a reset');
  calm();
  assert((await login('admin', PW, 'admin')).status === 401, 'the old password stops working');
  const a2 = await login('owner@example.com', NEW, 'admin'); assert(a2.status === 200, 'signing in with the new password works');
  const A2 = a2.json.data.token;
  assert((await req('POST', '/api/auth/reset', { body: { token: t3, password: 'Another#Pass2026', confirm: 'Another#Pass2026' } })).status === 400, 'a used link cannot be used again');
  // employee and customer
  const fE = await forgotFor('eve@example.com'); const fC = await forgotFor('carl@example.com');
  assert(fE.mail && fC.mail, 'employees and customers can also reset by e-mail');
  const eT = tokenFrom(fE.mail), cT = tokenFrom(fC.mail);
  assert((await req('POST', '/api/auth/reset', { body: { token: eT, password: NEW + 'E', confirm: NEW + 'E' } })).json.success && (await req('POST', '/api/auth/reset', { body: { token: cT, password: NEW + 'C', confirm: NEW + 'C' } })).json.success, 'both complete the reset');
  calm();
  assert((await login('eve@example.com', NEW + 'E', 'employee')).status === 200 && (await login('carl@example.com', NEW + 'C', 'customer')).status === 200, 'and sign in with the new passwords');
  assert((await login('eve@example.com', NEW + 'E', 'customer')).status === 401, 'still only through their own login type');
  // nobody can reset someone else's password by guessing: token belongs to one account
  const o1 = await forgotFor('eve@example.com'); const tk = tokenFrom(o1.mail);
  assert((await req('POST', '/api/auth/reset', { body: { token: tk, email: 'owner@example.com', user_id: adminRow.id, password: NEW + 'Z', confirm: NEW + 'Z' } })).json.success, 'a reset link changes only the account it was issued to');
  calm();
  assert((await login('owner@example.com', NEW, 'admin')).status === 200, 'the administrator password is untouched by someone else\'s reset');
  // throttling
  outbox.length = 0; for (let i = 0; i < 6; i++) await req('POST', '/api/auth/forgot', { body: { email: 'carl@example.com' } });
  assert(outbox.length <= 2, 'repeated requests for one address are rate limited', 'mails=' + outbox.length);
  // mail not configured
  mailer.setTransport(null);
  const keep = [process.env.RRE_SMTP_USER, process.env.RRE_SMTP_PASS]; delete process.env.RRE_SMTP_USER; delete process.env.RRE_SMTP_PASS;
  const adm2 = (m, p, body) => req(m, p, { token: A2, body });
  const noMail = await adm2('POST', '/api/auth/users', { full_name: 'No Mail', email: 'nomail@example.com', role: 'Viewer' });
  assert(noMail.status === 409 && noMail.json.code === 'MAIL_NOT_CONFIGURED', 'without e-mail settings an invitation is refused with a clear explanation, not a crash');
  assert((await req('POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } })).status === 200, 'forgot-password still answers normally without e-mail settings');
  if (keep[0]) process.env.RRE_SMTP_USER = keep[0]; if (keep[1]) process.env.RRE_SMTP_PASS = keep[1];
  mailer.setTransport({ sendMail: async (m) => { outbox.push(m); } });

  console.log('\n--- 7. Audit trail and one user table ---');
  const act = await req('GET', '/api/auth/login-activity?limit=200', { token: A2 });
  const actions = new Set(act.json.data.events.map((e) => e.action));
  assert(act.json.data.logins.length > 3 && ['AUTH_LOGIN_FAILED', 'AUTH_PASSWORD_RESET', 'AUTH_RESET_REQUESTED', 'AUTH_USER_CREATE', 'AUTH_LOGOUT'].every((a) => actions.has(a)), 'sign-ins, failures, resets, user creation and logout are all audited', [...actions].join(','));
  assert(!JSON.stringify(act.json).match(/argon2id\$|rre_[A-Za-z0-9_-]{20,}/), 'the audit trail holds no secrets');
  calm(); const EE = (await login('eve@example.com', NEW + 'Z', 'employee')).json.data.token;
  assert((await g(EE, '/api/auth/login-activity')).status === 403, 'employees cannot read login activity');
  const roles = await all('SELECT role, COUNT(*) c FROM users GROUP BY role');
  assert(roles.some((r) => r.role === 'Owner') && roles.some((r) => r.role === 'Accountant') && roles.some((r) => r.role === 'Customer'), 'administrator, employee and customer accounts all live in the one users table');
  const dupEmails = await all("SELECT email, COUNT(*) c FROM users WHERE email <> '' GROUP BY lower(email) HAVING c > 1");
  assert(dupEmails.length === 0, 'no duplicate e-mail addresses in the user table');

  console.log('\n--- 8. Existing inventory accounts are brought into the one list safely ---');
  const sqlite3 = require('sqlite3'); const invDir = path.join(tmp, 'inventory'); fs.mkdirSync(invDir, { recursive: true });
  await new Promise((resolve, reject) => { const d = new sqlite3.Database(path.join(invDir, 'stockpilot.db'), (e) => { if (e) return reject(e);
    d.exec("CREATE TABLE organizations(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE products(id INTEGER PRIMARY KEY, org_id INT); CREATE TABLE warehouses(id INTEGER PRIMARY KEY, org_id INT); CREATE TABLE stock_balances(id INTEGER PRIMARY KEY);"
      + "CREATE TABLE users(id INTEGER PRIMARY KEY, org_id INT, email TEXT, name TEXT, role TEXT, is_active INT, phone TEXT, customer_id INT, last_login TEXT, created_at TEXT);"
      + "INSERT INTO organizations VALUES (1,'X');"
      + "INSERT INTO users(id,org_id,email,name,role,is_active) VALUES (1,1,'EVE@example.com','Eve Old','warehouse',1),(2,1,'boss@inv.example.com','Old Boss','owner',1),(3,1,'wh@inv.example.com','Warehouse Wally','warehouse',1),(4,1,'','No Mail','viewer',1),(5,1,'cust@inv.example.com','Portal Cust','user',1);", (e2) => { d.close(); e2 ? reject(e2) : resolve(); }); }); });
  const before = await get('SELECT COUNT(*) c FROM users');
  const dry = await adm2('POST', '/api/auth/migration', {});
  const afterDry = await get('SELECT COUNT(*) c FROM users');
  assert(dry.json.success && dry.json.data.applied === false && afterDry.c === before.c, 'a preview changes nothing');
  const rep = dry.json.data.inventory;
  assert(rep.linked.some((x) => x.email === 'eve@example.com' && x.rre_role === 'Accountant'), 'an inventory person with the identical e-mail is linked to the existing RRE account (role untouched)', JSON.stringify(rep.linked));
  assert(rep.created.some((x) => x.email === 'boss@inv.example.com' && x.rre_role === 'Accountant'), 'an inventory owner would be created as an Accountant, never as an administrator');
  assert(rep.skipped.some((x) => x.reason === 'no e-mail address') && rep.skipped.some((x) => /customer login/.test(x.reason)), 'people without an e-mail, and customer logins that cannot be matched with certainty, are skipped and reported');
  const applied = await adm2('POST', '/api/auth/migration', { apply: true });
  const boss = await get("SELECT * FROM users WHERE email = 'boss@inv.example.com'"), wally = await get("SELECT * FROM users WHERE email = 'wh@inv.example.com'");
  assert(applied.json.success && boss && boss.role === 'Accountant' && boss.needs_review === 1 && wally && wally.role === 'Data Entry', 'applying creates the missing accounts, flagged for review');
  calm();
  assert(boss.password.startsWith('argon2id$') && (await login('boss@inv.example.com', 'anything-1A!x', 'employee')).status === 401, 'migrated people have no usable password until they use "Forgot password"');
  assert((await get("SELECT COUNT(*) c FROM users WHERE role = 'Owner'")).c === 1, 'no new administrator was created');
  const again = await adm2('POST', '/api/auth/migration', { apply: true });
  assert(again.json.data.inventory.created.length === 0 && (await get('SELECT COUNT(*) c FROM users')).c === before.c + 2, 'running it again creates no duplicates');
  assert(fs.existsSync(path.join(invDir, 'stockpilot.db')), 'the old inventory database is left untouched');
  assert((await g(EE, '/api/auth/migration')).status === 403, 'employees cannot run or read the migration');

  require('./core/identity')._resetLimits(); calm();
  console.log('\n--- 9. Customer self-registration and admin-controlled employee invitations ---');
  const vTok = (m) => decodeURIComponent((/verify=([^\s"&<]+)/.exec(m.text) || [])[1] || '');
  const signup = (b) => req('POST', '/api/auth/signup', { body: b });
  const good = { full_name: 'Sam Shopper', email: 'sam@shop.example', phone: '+91 98765 43210', password: 'Shopper#Pass2026', confirm: 'Shopper#Pass2026' };
  assert((await signup({ ...good, email: 'not-an-email' })).status === 422 && (await signup({ ...good, phone: 'abc' })).status === 422 && (await signup({ ...good, password: 'short1', confirm: 'short1' })).status === 422 && (await signup({ ...good, confirm: 'other' })).status === 422, 'registration validates the e-mail, mobile number, password strength and confirmation');
  outbox.length = 0;
  const su1 = await signup({ ...good, role: 'Owner', status: 'Active', login_type: 'admin', party_id: 1 });
  const sam = await get("SELECT * FROM users WHERE email = 'sam@shop.example'");
  assert(su1.status === 201 && sam && sam.role === 'Customer' && sam.status === 'Pending' && sam.company_id, 'a customer registers: the role is always Customer and the account waits for e-mail confirmation (role / status in the request are ignored)', JSON.stringify(su1.json));
  assert(sam.password.startsWith('argon2id$') && !JSON.stringify(su1.json).includes(good.password), 'the password is stored hashed and never returned');
  assert(sam.company_id === 'U' + sam.id && require('fs').existsSync(require('path').join(tmp, '_companies', sam.company_id, 'company.db')), 'the customer gets books of their own: a private company with its own database file');
  assert(!(await get("SELECT 1 x FROM ledgers WHERE name LIKE 'Sam Shopper%'")), 'nothing is added to the owner\'s books for them');
  assert(outbox.length === 1 && outbox[0].to === 'sam@shop.example' && /verify=/.test(outbox[0].text), 'a confirmation e-mail with a single-use link is sent');
  const pre = await login('sam@shop.example', good.password, 'customer');
  assert(pre.status === 401 && pre.json.code === 'EMAIL_NOT_VERIFIED' && !pre.json.data, 'signing in before confirming the e-mail is refused');
  const before9 = await get('SELECT COUNT(*) c FROM users'); outbox.length = 0;
  const dup = await signup({ ...good, full_name: 'Someone Else', password: 'Another#Pass2026', confirm: 'Another#Pass2026' });
  assert(dup.status === 201 && dup.json.message === su1.json.message && (await get('SELECT COUNT(*) c FROM users')).c === before9.c, 'a repeated registration (still unconfirmed) creates nothing new and gets the same neutral answer');
  await new Promise((r) => setTimeout(r, 200));
  assert(outbox.length === 1 && /verify=/.test(outbox[0].text) && (await get("SELECT full_name FROM users WHERE email = 'sam@shop.example'")).full_name === 'Sam Shopper', 'it only re-sends the confirmation link; name and password are not overwritten');
  outbox.length = 0;
  const dup2 = await signup({ ...good, email: 'eve@example.com' });
  assert(dup2.status === 201 && dup2.json.message === su1.json.message && (await get('SELECT COUNT(*) c FROM users')).c === before9.c, 'registering with an address that already has an account creates nothing and gets the same neutral answer');
  await new Promise((r) => setTimeout(r, 200));
  assert(outbox.length === 1 && /already have/i.test(outbox[0].subject) && outbox[0].to === 'eve@example.com', 'the existing owner of the address is told by e-mail');
  const vt = vTok(outbox[0]) || null; // the duplicate mail has no link; use the first confirmation mail
  const verifyMail = [...outbox].find((m) => /verify=/.test(m.text));
  const reg2 = await signup({ ...good, email: 'pend@shop.example', full_name: 'Pend Ing' }); const pendTok = vTok(outbox[outbox.length - 1]);
  assert(reg2.status === 201 && pendTok.length > 30, 'a second customer registers');
  assert((await req('POST', '/api/auth/reset', { body: { token: pendTok, password: 'Brand#New2026pw', confirm: 'Brand#New2026pw' } })).status === 400, 'a confirmation link cannot be used to reset a password');
  assert((await req('POST', '/api/auth/verify-email', { body: { token: 'x'.repeat(43) } })).status === 400, 'a made-up confirmation link is refused');
  const sentBefore = outbox.length; await req('POST', '/api/auth/resend-verification', { body: { email: 'pend@shop.example' } });
  const newPend = vTok(outbox[outbox.length - 1]);
  assert(outbox.length === sentBefore + 1 && newPend !== pendTok && (await req('POST', '/api/auth/verify-email', { body: { token: pendTok } })).status === 400, 'asking again sends a new link and the old one stops working');
  const ok1 = await req('POST', '/api/auth/verify-email', { body: { token: newPend } });
  assert(ok1.json.success && (await get("SELECT status, email_verified FROM users WHERE email = 'pend@shop.example'")).status === 'Active', 'the link activates the account');
  assert((await req('POST', '/api/auth/verify-email', { body: { token: newPend } })).status === 400, 'a confirmation link works only once');
  calm();
  const samLogin = await login('pend@shop.example', good.password, 'customer');
  assert(samLogin.status === 200 && samLogin.json.data.home === 'app' && samLogin.json.data.user.role === 'Customer', 'a confirmed customer signs in and lands in the customer portal');
  const SC = samLogin.json.data.token;
  assert((await login('pend@shop.example', good.password, 'employee')).status === 401 && (await login('pend@shop.example', good.password, 'admin')).status === 401, 'a customer cannot enter through the Employee or Admin option');
  assert((await g(SC, '/api/auth/users')).status === 403 && (await g(SC, '/api/companies')).status === 403 && (await g(SC, '/api/auth/login-activity')).status === 403 && (await g(SC, '/api/inventory-app/status')).status === 403 && (await g(SC, '/api/portal/me')).status === 403, 'a customer cannot reach user management, the company list, login activity or the owner\'s portal');
  assert((await g(SC, '/api/vouchers')).status === 200 && (await g(SC, '/api/inv/items')).status === 200 && (await g(SC, '/api/reports/trial-balance')).status === 200, 'but has the whole accounting, inventory and reports application, in their own company');
  require('./core/identity')._resetLimits(); const forgotC = await forgotFor('pend@shop.example'); assert(!!forgotC.mail, 'a self-registered customer can use Forgot password');

  calm();
  console.log('--- 9b. Confirming in the same browser signs the customer in ---');
  require('./core/identity')._resetLimits(); calm();
  const cl1 = await signup({ ...good, email: 'claim1@shop.example', full_name: 'Claim One' }); const tk_1 = vTok(outbox[outbox.length - 1]);
  assert(cl1.json.claim && cl1.json.claim.length > 20, 'registration hands the creating browser a private claim');
  const noClaim = await req('POST', '/api/auth/verify-email', { body: { token: tk_1 } });
  assert(noClaim.json.success && !noClaim.json.data, 'opening the link elsewhere (no claim) only confirms the e-mail: no session is given');
  const cl2 = await signup({ ...good, email: 'claim2@shop.example', full_name: 'Claim Two' }); const tk_2 = vTok(outbox[outbox.length - 1]);
  const wrong = await req('POST', '/api/auth/verify-email', { body: { token: tk_2, claim: 'x'.repeat(32) } });
  assert(wrong.json.success && !wrong.json.data, 'a wrong claim does not sign anyone in');
  const cl3 = await signup({ ...good, email: 'claim3@shop.example', full_name: 'Claim Three' }); const tk_3 = vTok(outbox[outbox.length - 1]);
  const right = await req('POST', '/api/auth/verify-email', { body: { token: tk_3, claim: cl3.json.claim } });
  assert(right.json.success && right.json.data && right.json.data.token && right.json.data.user.role === 'Customer' && right.json.data.home === 'app', 'the browser that created the account is signed in when it confirms: straight into the application');
  assert((await req('GET', '/api/auth/me', { token: right.json.data.token })).status === 200 && (await req('GET', '/api/vouchers', { token: right.json.data.token })).status === 200, 'and that session works in the application');
  assert((await req('POST', '/api/auth/verify-email', { body: { token: tk_3, claim: cl3.json.claim } })).status === 400, 'the link and claim work only once');

  console.log('\n--- 10. Employees: invitation only ---');
  assert((await signup({ ...good, email: 'sneaky@shop.example', role: 'Accountant', login_type: 'employee' })).status === 201 && (await get("SELECT role FROM users WHERE email = 'sneaky@shop.example'")).role === 'Customer', 'asking for an Employee role at registration still produces a Customer');
  assert((await req('POST', '/api/auth/users', { body: { full_name: 'Ghost Emp', email: 'ghost@x.example', role: 'Accountant', password: EMP } })).status === 401 && (await req('POST', '/api/auth/users', { token: SC, body: { full_name: 'Ghost Emp', email: 'ghost@x.example', role: 'Accountant', password: EMP } })).status === 403, 'nobody but an administrator can create an employee (anonymous and customer are refused)');
  assert((await req('POST', '/api/auth/setup', { body: { password: 'Winter#Garden-2027' } })).status === 409 && (await get("SELECT COUNT(*) c FROM users WHERE role = 'Owner'")).c === 1, 'no one can create an administrator: setup is closed and registration never makes one');
  outbox.length = 0;
  const inv = await adm2('POST', '/api/auth/users', { full_name: 'Ivy Invited', email: 'ivy@co.example', phone: '+91 90000 11111', role: 'Accountant', modules: ['accounting', 'inventory'] });
  const ivy = await get("SELECT * FROM users WHERE email = 'ivy@co.example'");
  assert(inv.json.success && inv.json.data.invited && ivy.status === 'Invited' && ivy.phone === '+91 90000 11111' && outbox.length === 1 && /reset=/.test(outbox[0].text), 'the administrator invites an employee: account is "Invited" and an invitation e-mail is sent');
  const invTok = tokenFrom(outbox[0]);
  calm(); assert((await login('ivy@co.example', 'Whatever#1234x', 'employee')).status === 401, 'an invited employee cannot sign in before accepting');
  const fi = await forgotFor('ivy@co.example'); assert(!fi.mail, 'Forgot password does not work around the invitation');
  assert((await req('GET', '/api/auth/reset/validate?token=' + encodeURIComponent(invTok))).json.data.purpose === 'invite', 'the invitation link says it is an invitation');
  assert((await req('POST', '/api/auth/verify-email', { body: { token: invTok } })).status === 400, 'an invitation cannot be used as a customer confirmation');
  const listed = (await adm2('GET', '/api/auth/users')).json.data.find((u) => u.email === 'ivy@co.example');
  assert(listed && listed.status === 'Invited' && !/argon2|"password"/i.test(JSON.stringify(listed)), 'the administrator sees the status "Invited" and no password');
  calm(); const acc = await req('POST', '/api/auth/reset', { body: { token: invTok, password: 'Maple#Secure2026pw', confirm: 'Maple#Secure2026pw' } });
  assert(acc.json.success, 'the employee creates their password through the invitation', acc.raw.slice(0, 200));
  const ivy2 = await get("SELECT status, email_verified, role FROM users WHERE email = 'ivy@co.example'");
  assert(ivy2.status === 'Active' && ivy2.email_verified === 1 && ivy2.role === 'Accountant', 'the account is activated with the Employee role and the e-mail is verified');
  calm(); const ivyL = await login('ivy@co.example', 'Maple#Secure2026pw', 'employee');
  assert(ivyL.status === 200 && ivyL.json.data.login_type === 'employee', 'the invited employee signs in through Employee login');
  const IV = ivyL.json.data.token;
  assert((await g(IV, '/api/vouchers')).status === 200 && (await g(IV, '/api/reports/trial-balance')).status === 403 && (await g(IV, '/api/auth/users')).status === 403, 'an employee reaches only their assigned modules and no admin tools');
  assert((await req('POST', '/api/auth/reset', { body: { token: invTok, password: 'Other#Secure2026pw', confirm: 'Other#Secure2026pw' } })).status === 400, 'an invitation link works once');
  await adm2('PUT', '/api/auth/users/' + ivy.id, { status: 'Inactive' });
  calm(); assert((await login('ivy@co.example', 'Maple#Secure2026pw', 'employee')).status === 401 && (await g(IV, '/api/vouchers')).status === 401, 'a deactivated employee cannot sign in and their session ends');
  const expired = await adm2('POST', '/api/auth/users', { full_name: 'Old Invite', email: 'old@co.example', role: 'Viewer' });
  const oldTok = tokenFrom(outbox[outbox.length - 1]);
  await run("UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL", [new Date(Date.now() - 1000).toISOString()]);
  assert(expired.json.success && (await req('POST', '/api/auth/reset', { body: { token: oldTok, password: 'Old#Secure2026pw', confirm: 'Old#Secure2026pw' } })).status === 400, 'an expired invitation is refused');
  const resend = await adm2('POST', '/api/auth/users/' + expired.json.data.id + '/send-reset');
  assert(resend.json.success && /reset=/.test(outbox[outbox.length - 1].text), 'the administrator can send the invitation again');

  console.log('--- 10b. Sign-up when e-mail is not set up yet ---');
  mailer.setTransport(null); require('./core/identity')._resetLimits(); calm();
  const nm = await signup({ ...good, email: 'nomail@shop.example', full_name: 'No Mail Customer' });
  const nmUser = await get("SELECT role, status FROM users WHERE email = 'nomail@shop.example'");
  assert(nm.status === 201 && nm.json.activated === true && nmUser.role === 'Customer' && nmUser.status === 'Active', 'without e-mail set up a customer can still create an account: it is active at once and is always a Customer');
  assert(nm.json.data && nm.json.data.token && nm.json.data.home === 'app', 'the new customer is signed in at once and goes into the main application');
  calm(); assert((await login('nomail@shop.example', good.password, 'customer')).status === 200, 'and can sign in again with the password');
  assert((await signup({ ...good, email: 'nomail@shop.example' })).status === 409, 'a duplicate is refused');
  assert((await signup({ ...good, email: 'nomail2@shop.example', role: 'Owner' })).status === 201 && (await get("SELECT role FROM users WHERE email = 'nomail2@shop.example'")).role === 'Customer', 'the role still cannot be chosen');
  mailer.setTransport({ sendMail: async (m) => { outbox.push(m); } });

  console.log('\n--- 11. Real SMTP delivery path (local relay) ---');
  const fakeSmtp = await require('./scripts/fake-smtp').start(0);
  mailer.setTransport(null);
  Object.assign(process.env, { RRE_SMTP_HOST: '127.0.0.1', RRE_SMTP_PORT: String(fakeSmtp.port), RRE_SMTP_TLS: '0', RRE_SMTP_USER: 'sender@test.example', RRE_SMTP_PASS: 'app-password' });
  const smtpInvite = await adm2('POST', '/api/auth/users', { full_name: 'Smtp Person', email: 'smtp@co.example', role: 'Viewer' });
  await new Promise((r) => setTimeout(r, 400));
  assert(smtpInvite.json.success && smtpInvite.json.data.invited === true && fakeSmtp.inbox.length === 1 && /smtp@co\.example/.test(fakeSmtp.inbox[0].to.join()) && /reset=/.test(fakeSmtp.inbox[0].raw), 'an invitation is delivered through the real SMTP client (nodemailer) to the right address');
  const smtpSignup = await signup({ ...good, email: 'smtpc@shop.example', full_name: 'Smtp Customer' }); await new Promise((r) => setTimeout(r, 400));
  assert(smtpSignup.status === 201 && fakeSmtp.inbox.some((m) => /smtpc@shop\.example/.test(m.to.join()) && /verify=/.test(m.raw)), 'a customer confirmation e-mail is delivered through SMTP too');
  fakeSmtp.close();
  for (const k of ['RRE_SMTP_HOST', 'RRE_SMTP_PORT', 'RRE_SMTP_TLS', 'RRE_SMTP_USER', 'RRE_SMTP_PASS']) delete process.env[k];
  mailer.setTransport({ sendMail: async (m) => { outbox.push(m); } });

  console.log(`\nAuth unified: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

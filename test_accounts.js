process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Accounts and access: first-time setup, no default credentials, one-click read-only guest entry (Owner can switch it off),
 * forced password change, registration,
 * Google sign-in, role enforcement on the server, and nothing sensitive in the frontend or docs.
 * Runs against a DISPOSABLE data directory.   npm run test:accounts
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_accounts_test_'));
process.env.RRE_DATA_DIR = tmp;
delete process.env.RRE_ALLOW_SELF_REGISTRATION;

const { startServer } = require('./server');
const db = require('./core/db');
const { initDb, get, all, run } = db;
const { runMigrations } = require('./core/migrations');
const { createSessionToken, hashPassword, verifySessionToken, loginRateLimiter } = require('./core/security');
const { checkPassword } = require('./core/passwordPolicy');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const resetLimiter = () => { for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) loginRateLimiter.recordSuccess(ip); };

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(12500 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const login = async (u, p) => { resetLimiter(); return req('POST', '/api/auth/login', { body: { username: u, password: p } }); };
  const claims = (t) => JSON.parse(Buffer.from(t.slice(4).split('.')[0], 'base64url').toString());
  const STRONG = 'Winter#Garden-2026';

  console.log('\n--- 1. Password rules ---');
  const rules = [['short1', false], ['alllettersonly', false], ['1234567890', false], ['Password123', false], ['admin12345', false], ['aaaaaaaaaaaa', false], ['Winter#Garden-2026', true], ['correcthorse9battery', true]];
  for (const [pw, ok] of rules) assert((checkPassword(pw, { username: 'someone' }) === null) === ok, `"${pw}" is ${ok ? 'accepted' : 'refused'}`);
  assert(checkPassword('ramesh-Strong-2026', { username: 'ramesh' }) !== null, 'A password containing the username is refused');
  assert(checkPassword('x'.repeat(101) + '1') !== null && checkPassword(12345678901234) !== null, 'Too long / not a string is refused');

  console.log('\n--- 2. Fresh installation: no defaults, administrator chooses the password ---');
  await run('DELETE FROM user_logins'); await run('DELETE FROM users');
  await db.hardenAccounts(true);
  assert((await req('GET', '/api/auth/setup-status')).json.data.setup_required === true, 'Setup is required on a fresh installation (public status check)');
  const seeded = await all('SELECT username, role, status, password FROM users');
  assert(seeded.length === 1 && seeded[0].username === 'admin' && seeded[0].role === 'Owner', 'Exactly one account exists: the initial administrator (no demo staff, no guest)');
  assert(!seeded[0].password.startsWith('pbkdf2$') && !/admin|guest|123/i.test(seeded[0].password.replace('!setup-required!', '')), 'It has no password at all (no default is stored)');
  for (const p of ['', 'admin', '!setup-required!', 'admin123', 'anything']) assert((await login('admin', p)).status === 401, `Nobody can sign in as admin with "${p}" before setup`);
  assert((await login('admin', '!setup-required!')).json.error.includes('First-time setup'), 'The refusal tells them to finish setup');
  assert((await req('POST', '/api/auth/setup', { body: { password: 'short1' } })).status === 400 && (await req('POST', '/api/auth/setup', { body: { password: 'admin12345' } })).status === 400 && (await req('POST', '/api/auth/setup', { body: {} })).status === 400, 'Setup refuses weak, default-like or missing passwords');
  const su = await req('POST', '/api/auth/setup', { body: { password: STRONG } });
  assert(su.status === 200 && su.json.data.user.role === 'Owner' && su.json.data.must_change_password === false && !claims(su.json.data.token).pwc, 'Setup with a strong password signs the administrator in (no further change needed)');
  assert((await req('GET', '/api/auth/setup-status')).json.data.setup_required === false, 'Setup is no longer offered');
  assert((await req('POST', '/api/auth/setup', { body: { password: 'Another#Pass-2026' } })).status === 409, 'Setup cannot be run a second time (no takeover)');
  assert((await login('admin', STRONG)).status === 200 && (await login('admin', 'admin')).status === 401, 'Only the chosen password works afterwards');
  const adminTok = (await login('admin', STRONG)).json.data.token;
  assert((await req('GET', '/api/masters/ledgers', { token: adminTok })).status === 200, 'The administrator can use the application');

  console.log('\n--- 3. Existing installation with old demo accounts ---');
  const legacy = [['admin', 'admin123', 'Owner'], ['accountant', 'acc123', 'Accountant'], ['dataentry', 'data123', 'Data Entry'], ['auditor', 'audit123', 'Auditor'], ['viewer', 'view123', 'Viewer'], ['guest', 'guest', 'Guest']];
  await run('DELETE FROM users');
  for (const [u, p, r] of legacy) await run(`INSERT INTO users (username, password, full_name, role, email, status) VALUES (?, ?, ?, ?, ?, 'Active')`, [u, hashPassword(p), u + ' person', r, u + '@example.com']);
  await run(`INSERT INTO users (username, password, full_name, role, email, status) VALUES ('meena', ?, 'Meena (real user)', 'Accountant', 'meena@example.com', 'Active')`, [hashPassword('Meena#Own-Pass-77')]);
  await run(`INSERT INTO users (username, password, full_name, role, email, status) VALUES ('oldplain', 'plain-legacy-pass-9', 'Old plaintext user', 'Viewer', 'old@example.com', 'Active')`);
  const guestId = (await get(`SELECT id FROM users WHERE username = 'guest'`)).id;
  await run(`INSERT INTO user_logins (user_id, username, role) VALUES (?, 'guest', 'Guest')`, [guestId]);
  const vBefore = (await get('SELECT COUNT(*) c FROM vouchers')).c, lBefore = (await get('SELECT COUNT(*) c FROM ledgers')).c;
  const usersBefore = await all('SELECT id, username, role, full_name, email FROM users ORDER BY id');
  await db.hardenAccounts(true);
  const usersAfter = await all('SELECT id, username, role, full_name, email, status, must_change_password FROM users ORDER BY id');
  assert(usersAfter.length === usersBefore.length && usersBefore.every((u, i) => u.id === usersAfter[i].id && u.username === usersAfter[i].username && u.role === usersAfter[i].role && u.full_name === usersAfter[i].full_name && u.email === usersAfter[i].email), 'No account was deleted, renamed or re-roled');
  const by = Object.fromEntries(usersAfter.map((u) => [u.username, u]));
  assert(by.guest.status === 'Active' && (await get('SELECT COUNT(*) c FROM user_logins WHERE user_id = ?', [guestId])).c === 1, 'The guest account is kept with its login history');
  const guestRow = await get(`SELECT password FROM users WHERE username = 'guest'`);
  assert(!require('./core/security').verifyPassword('guest', guestRow.password).valid && !require('./core/security').verifyPassword('guest123', guestRow.password).valid, 'The old shipped guest password was replaced: nobody can type their way in as guest');
  assert(['admin', 'accountant', 'dataentry', 'auditor', 'viewer'].every((u) => by[u].must_change_password === 1), 'Every account still on a demo password must choose a new one');
  assert(by.meena.must_change_password === 0 && by.oldplain.must_change_password === 0 && by.meena.status === 'Active', 'Accounts with their own password are left alone');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === vBefore && (await get('SELECT COUNT(*) c FROM ledgers')).c === lBefore, 'Accounting data is untouched');
  await db.hardenAccounts(true);
  assert((await all('SELECT id FROM users')).length === usersBefore.length, 'Running it again changes nothing (idempotent)');

  console.log('\n--- 4. Signing in on an old demo password forces a change ---');
  const l1 = await login('admin', 'admin123');
  assert(l1.status === 200 && l1.json.data.must_change_password === true && claims(l1.json.data.token).pwc === 1, 'Login succeeds but says a new password is required, and the token is marked');
  const pwcTok = l1.json.data.token;
  const blocked = [['GET', '/api/masters/ledgers'], ['GET', '/api/reports/balance-sheet'], ['GET', '/api/vouchers'], ['GET', '/api/auth/users'], ['GET', '/api/platform/notifications'], ['GET', '/api/search?q=cash'], ['POST', '/api/voice/execute']];
  let allBlocked = true; const leaks = [];
  for (const [m, p] of blocked) { const r = await req(m, p, { token: pwcTok, body: m === 'POST' ? { text: 'open inventory' } : undefined }); if (r.status !== 403 || (r.json && r.json.code) !== 'PASSWORD_CHANGE_REQUIRED') { allBlocked = false; leaks.push(`${m} ${p}=${r.status}`); } }
  assert(allBlocked, `Until the password is changed every route is refused (${blocked.length} checked)`, leaks.join('; '));
  const cp = (token, cur, nw) => req('POST', '/api/auth/change-password', { token, body: { current_password: cur, new_password: nw } });
  assert((await cp(null, 'admin123', STRONG)).status === 401, 'Changing a password needs a signed-in person');
  assert((await cp(pwcTok, 'wrong-current-1', STRONG)).status === 400, 'A wrong current password is refused');
  assert((await cp(pwcTok, 'admin123', 'short1')).status === 400 && (await cp(pwcTok, 'admin123', 'Password123')).status === 400, 'A weak new password is refused');
  assert((await cp(pwcTok, 'admin123', 'admin123')).status === 400, 'The new password must differ from the old one');
  assert((await cp(pwcTok, 'admin123', 'admin-Strong-2026')).status === 400, 'A new password containing the username is refused');
  const ch = await cp(pwcTok, 'admin123', STRONG);
  assert(ch.status === 200 && ch.json.data.must_change_password === false && !claims(ch.json.data.token).pwc, 'A strong new password is accepted and returns a fresh, unrestricted token');
  assert((await req('GET', '/api/masters/ledgers', { token: ch.json.data.token })).status === 200 && (await req('GET', '/api/reports/balance-sheet', { token: ch.json.data.token })).status === 200, 'The new token works everywhere (roles still apply)');
  assert((await req('GET', '/api/masters/ledgers', { token: pwcTok })).status === 403, 'The old restricted token stays restricted');
  assert((await login('admin', 'admin123')).status === 401 && (await login('admin', STRONG)).status === 200, 'The old demo password stops working; the new one works');
  assert((await get(`SELECT must_change_password m, password_changed_at t FROM users WHERE username = 'admin'`)).m === 0, 'The requirement is cleared in the database');

  console.log('\n--- 5. Old shortcuts are gone ---');
  const attempts = [['administrator', 'x-anything-123'], ['administrator', ''], ['admin', ''], ['guest', 'guest'], ['guest', ''], ['guest', 'guest123'], ['viewer', ''], ['accountant', 'acc'], ['dataentry', 'data'], ['ADMIN', 'admin']];
  for (const [u, p] of attempts) assert((await login(u, p)).status === 401, `Login refused: "${u}" / "${p}"`);
  const e1 = (await login('nobody-here', 'x-Pass-12345')).json.error, e2 = (await login('admin', 'Wrong-Pass-12345')).json.error;
  assert(e1 === e2, 'Unknown user and wrong password give the same message (no account guessing)');
  assert((await login('guest', 'guest')).status === 401 && (await login('guest', '')).status === 401, 'Guest has no password: typing one is refused');

  console.log('\n--- 5b. One-click read-only guest entry ---');
  const adminTok0 = (await login('admin', STRONG)).json.data.token;
  const deT0 = createSessionToken({ id: by.dataentry.id, username: 'dataentry', role: 'Data Entry' }), accT0 = createSessionToken({ id: by.accountant.id, username: 'accountant', role: 'Accountant' });
  const ledg0 = (await get('SELECT id FROM ledgers LIMIT 1')).id;
  const gs = await req('GET', '/api/auth/setup-status');
  assert(gs.json.data.guest_access === true, 'The login screen is told that guest entry is available');
  resetLimiter();
  const ge = await req('POST', '/api/auth/guest', { body: {} });
  assert(ge.status === 200 && ge.json.data.user.role === 'Guest' && !claims(ge.json.data.token).pwc && ge.json.data.must_change_password === false, 'The Guest button gives a Guest session without any password');
  const gT = ge.json.data.token;
  assert(ge.json.data.permissions.canCreateVouchers === false && ge.json.data.permissions.canManageUsers === false, 'Guest permissions are read-only');
  const gStatus = async (m, p, b) => (await req(m, p, { token: gT, body: b })).status;
  assert((await gStatus('GET', '/api/masters/ledgers')) === 200 && (await gStatus('GET', '/api/reports/daybook')) === 200 && (await gStatus('GET', '/api/reports/trial-balance')) === 200 && (await gStatus('GET', '/api/search?q=cash')) === 200, 'A guest can look around: ledgers, Day Book, reports, search');
  const gBody = { voucher_type: 'Contra', voucher_no: 'GST/1', date: '2026-06-01', entries: [{ ledger_id: ledg0, debit_amount: 1 }, { ledger_id: ledg0, credit_amount: 1 }] };
  const blockedForGuest = [['POST', '/api/vouchers', gBody], ['POST', '/api/masters/ledgers', { name: 'GuestMade', group_id: 12 }], ['DELETE', '/api/vouchers/1'], ['GET', '/api/auth/users'], ['GET', '/api/backup/list'], ['POST', '/api/backup/restore', { filename: 'x' }], ['POST', '/api/auth/users', { username: 'g1', full_name: 'G', password: 'Temp#Guest-2026', role: 'Owner' }], ['POST', '/api/auth/guest-access', { enabled: false }], ['POST', '/api/voice/model/install', { model: 'tiny' }], ['POST', '/api/quotations', { customer_name: 'x', items: [{ item_name: 'a', quantity: 1, rate: 1 }] }], ['POST', '/api/company/clean-slate', {}]];
  const gLeaks = [];
  for (const [m, p, b] of blockedForGuest) { const st = await gStatus(m, p, b); if (st !== 403) gLeaks.push(`${m} ${p}=${st}`); }
  assert(!gLeaks.length, `A guest cannot post, edit, delete, manage users, back up or change settings (${blockedForGuest.length} checked)`, gLeaks.join('; '));
  const gv = await req('POST', '/api/voice/execute', { token: gT, body: { text: 'create sales voucher', confirmed: true } });
  assert(gv.json.data.status === 'denied', 'Voice cannot open a voucher form for a guest either');
  assert((await get(`SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'GST/1'`)).c === 0 && (await get(`SELECT COUNT(*) c FROM ledgers WHERE name = 'GuestMade'`)).c === 0, 'Nothing was created by the guest');
  assert((await get(`SELECT COUNT(*) c FROM user_logins WHERE username = 'guest'`)).c >= 2, 'Guest entries are recorded in the login audit trail');
  assert((await req('POST', '/api/auth/change-password', { token: gT, body: { current_password: 'x', new_password: 'Guest#Chosen-2026' } })).status === 400, 'A guest cannot set a password for the shared guest account');

  console.log('\n--- 5c. The Owner can switch guest entry off and on ---');
  assert((await req('POST', '/api/auth/guest-access', { token: deT0, body: { enabled: false } })).status === 403 && (await req('POST', '/api/auth/guest-access', { token: accT0, body: { enabled: false } })).status === 403, 'Only an administrator can change it');
  assert((await req('POST', '/api/auth/guest-access', { token: null, body: { enabled: false } })).status === 401, 'Changing it needs a login');
  const off = await req('POST', '/api/auth/guest-access', { token: adminTok0, body: { enabled: false } });
  assert(off.status === 200 && off.json.data.guest_access === false, 'The Owner switches it off');
  resetLimiter();
  assert((await req('POST', '/api/auth/guest', { body: {} })).status === 403, 'The Guest button no longer works');
  assert((await req('GET', '/api/auth/setup-status')).json.data.guest_access === false, 'The login screen is told to hide the button');
  assert((await req('GET', '/api/masters/ledgers', { token: gT })).status === 401, 'Guest sessions already open stop working immediately');
  assert((await get(`SELECT status FROM users WHERE username = 'guest'`)).status === 'Inactive', 'The guest account is deactivated (kept, not deleted)');
  assert((await get(`SELECT COUNT(*) c FROM activity_log WHERE action = 'GUEST_ACCESS_OFF'`)).c === 1, 'The change is in the audit log');
  const on = await req('POST', '/api/auth/guest-access', { token: adminTok0, body: { enabled: true } });
  resetLimiter();
  assert(on.status === 200 && (await req('POST', '/api/auth/guest', { body: {} })).status === 200 && (await get(`SELECT status FROM users WHERE username = 'guest'`)).status === 'Active', 'Switched back on, guest entry works again');
  assert((await req('POST', '/api/auth/guest-access', { token: adminTok0, body: { enabled: 'yes' } })).json.data.guest_access === false, 'Only a real boolean true turns it on');
  await req('POST', '/api/auth/guest-access', { token: adminTok0, body: { enabled: true } });

  console.log('\n--- 6. Registration and Google ---');
  const reg = (b) => { resetLimiter(); return req('POST', '/api/auth/register', { body: b }); };
  const regBody = { full_name: 'New Person', email: 'new.person@example.com', username: 'newperson', password: 'Fresh#Start-2026', role: 'Owner' };
  assert((await reg(regBody)).status === 403 && !(await get(`SELECT id FROM users WHERE username = 'newperson'`)), 'Self-registration is off by default; nothing is created');
  process.env.RRE_ALLOW_SELF_REGISTRATION = '1';
  const rr = await reg(regBody);
  const created = await get(`SELECT role, status, must_change_password FROM users WHERE username = 'newperson'`);
  assert(rr.status === 200 && rr.json.data.pending === true && !rr.json.data.token, 'When switched on, registration only creates a pending request (no token)');
  assert(created.role === 'Viewer' && created.status === 'Inactive', 'The requested role (Owner) is ignored: Viewer, inactive until approved');
  assert((await login('newperson', 'Fresh#Start-2026')).status === 401, 'The person cannot sign in until an administrator approves');
  assert((await reg({ ...regBody, username: 'weakone', email: 'weak@example.com', password: 'weak1' })).status === 400, 'A weak password is refused at registration');
  const adminTok2 = (await login('admin', STRONG)).json.data.token;
  const nid = (await get(`SELECT id FROM users WHERE username = 'newperson'`)).id;
  assert((await req('PUT', `/api/auth/users/${nid}`, { token: adminTok2, body: { status: 'Active', role: 'Data Entry' } })).status === 200 && (await login('newperson', 'Fresh#Start-2026')).status === 200, 'An administrator approves and assigns the role; then they can sign in');
  delete process.env.RRE_ALLOW_SELF_REGISTRATION;
  const usersN = (await get('SELECT COUNT(*) c FROM users')).c;
  resetLimiter();
  const gg = await req('POST', '/api/auth/google', { body: { email: 'admin@example.com', name: 'Impostor', role: 'Owner', google_id: 'g_1' } });
  assert(gg.status === 403 && (await get('SELECT COUNT(*) c FROM users')).c === usersN, 'Google sign-in is refused and cannot create or take over an account');

  console.log('\n--- 7. Administrator-managed accounts ---');
  const mk = (b, token = adminTok2) => req('POST', '/api/auth/users', { token, body: b });
  assert((await mk({ username: 'clerk2', full_name: 'Clerk Two', password: 'Temp#Clerk-2026', role: 'Data Entry', email: 'c2@example.com' })).status === 200, 'An administrator creates an account');
  assert((await get(`SELECT must_change_password m FROM users WHERE username = 'clerk2'`)).m === 1, 'The temporary password must be changed at first login');
  const lc = await login('clerk2', 'Temp#Clerk-2026');
  assert(lc.status === 200 && lc.json.data.must_change_password === true, 'The new person is told to choose their own password');
  for (const [label, b] of [['weak password', { username: 'u1', full_name: 'U', password: 'short1', role: 'Viewer' }], ['Guest role', { username: 'u2', full_name: 'U', password: 'Temp#User-2026', role: 'Guest' }], ['unknown role', { username: 'u3', full_name: 'U', password: 'Temp#User-2026', role: 'SuperUser' }], ['duplicate', { username: 'CLERK2', full_name: 'U', password: 'Temp#User-2026', role: 'Viewer' }]])
    assert((await mk(b)).status === 400, `Refused: ${label}`);
  const accT = createSessionToken({ id: by.accountant.id, username: 'accountant', role: 'Accountant' }), deT = createSessionToken({ id: by.dataentry.id, username: 'dataentry', role: 'Data Entry' });
  assert((await mk({ username: 'u4', full_name: 'U', password: 'Temp#User-2026', role: 'Viewer' }, accT)).status === 403 && (await mk({ username: 'u5', full_name: 'U', password: 'Temp#User-2026', role: 'Viewer' }, deT)).status === 403, 'Only an administrator can create accounts (enforced by the server)');
  assert((await req('GET', '/api/auth/users', { token: deT })).status === 403 && (await req('GET', '/api/auth/users', { token: accT })).status === 403, 'Only an administrator can list accounts');
  const cid = (await get(`SELECT id FROM users WHERE username = 'clerk2'`)).id;
  assert((await req('PUT', `/api/auth/users/${cid}`, { token: adminTok2, body: { password: 'weak1' } })).status === 400, 'An administrator reset to a weak password is refused');
  assert((await req('PUT', `/api/auth/users/${cid}`, { token: adminTok2, body: { password: 'Reset#Clerk-2026' } })).status === 200 && (await get(`SELECT must_change_password m FROM users WHERE username = 'clerk2'`)).m === 1, 'An administrator reset is temporary too: a change is required again');
  assert((await req('PUT', `/api/auth/users/${cid}`, { token: adminTok2, body: { role: 'Guest' } })).status === 400, 'An account cannot be turned into Guest');
  const ownerId = (await get(`SELECT id FROM users WHERE username = 'admin'`)).id;
  await run(`UPDATE users SET status = 'Inactive' WHERE role = 'Owner' AND username != 'admin'`);
  assert((await req('PUT', `/api/auth/users/${ownerId}`, { token: adminTok2, body: { role: 'Viewer' } })).status === 400 || (await req('PUT', `/api/auth/users/${ownerId}`, { token: adminTok2, body: { role: 'Viewer' } })).status === 500, 'The only administrator cannot be demoted');
  const list = (await req('GET', '/api/auth/users', { token: adminTok2 })).json.data;
  assert(list.every((u) => u.password === undefined), 'The account list never contains passwords');

  console.log('\n--- 8. Roles are enforced on the server ---');
  const viewerT = createSessionToken({ id: by.viewer.id, username: 'viewer', role: 'Viewer' }), audT = createSessionToken({ id: by.auditor.id, username: 'auditor', role: 'Auditor' });
  const ledg = (await get('SELECT id FROM ledgers LIMIT 1')).id;
  const bodyV = { voucher_type: 'Contra', voucher_no: 'ACC/1', date: '2026-06-01', entries: [{ ledger_id: ledg, debit_amount: 1 }, { ledger_id: ledg, credit_amount: 1 }] };
  assert((await req('POST', '/api/vouchers', { token: viewerT, body: bodyV })).status === 403 && (await req('POST', '/api/vouchers', { token: audT, body: bodyV })).status === 403, 'Viewer and Auditor cannot post vouchers');
  assert((await req('GET', '/api/reports/trial-balance', { token: deT })).status === 403 && (await req('GET', '/api/reports/trial-balance', { token: accT })).status === 200, 'Data Entry cannot see financial statements; Accountant can');
  assert((await req('POST', '/api/backup/restore', { token: accT, body: { filename: 'x' } })).status === 403, 'Accountant cannot restore backups');
  assert((await req('GET', '/api/masters/ledgers', { token: 'rre_forged.token' })).status === 401 && (await req('GET', '/api/masters/ledgers')).status === 401, 'Forged and missing tokens are refused');
  const forgedRole = (() => { const p = Buffer.from(JSON.stringify({ userId: 1, username: 'admin', role: 'Owner', expiresAt: Date.now() + 1e7 })).toString('base64url'); return `rre_${p}.AAAA`; })();
  assert((await req('GET', '/api/auth/users', { token: forgedRole })).status === 401, 'A token with a self-written role is refused (signature check)');

  console.log('\n--- 9. Quotations and the report centre obey the same roles and approval rules ---');
  const qBody = (extra = {}) => ({ customer_name: 'Role Test Customer', party_ledger_id: (null), subject: 'role test', items: [{ item_name: 'Test Service', quantity: 2, rate: 1500, gst_rate: 18 }], ...extra });
  const post = (token, p, body) => req('POST', p, { token, body });
  assert((await post(viewerT, '/api/quotations', qBody())).status === 403 && (await post(audT, '/api/quotations', qBody())).status === 403, 'Viewer and Auditor cannot create quotations (they cannot post vouchers)');
  assert((await post(null, '/api/quotations', qBody())).status === 401, 'Quotations need a login');
  const q1 = await post(deT, '/api/quotations', qBody());
  assert(q1.status === 200 && /^QT-/.test(q1.json.quote_no), 'Data Entry can create a quotation');
  assert((await req('GET', `/api/quotations/${q1.json.id}`, { token: viewerT })).status === 200, 'Read-only roles can still read quotations');
  assert((await post(viewerT, `/api/quotations/${q1.json.id}/convert`, {})).status === 403, 'A Viewer cannot convert a quotation into a Sales invoice');
  const stockItem = await get('SELECT id FROM stock_items LIMIT 1');
  const sold = (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales'")).c;
  await post(adminTok2, '/api/approvals/rules', { name: 'Discount cap (quote test)', kind: 'sales_discount', threshold: 10 });
  const q2 = await post(deT, '/api/quotations', qBody({ items: [{ item_name: 'Discounted', stock_item_id: stockItem.id, quantity: 1, rate: 1000, discount_pct: 25, gst_rate: 18 }] }));
  assert(q2.status === 200, 'Quotation with a 25% discount created');
  const cv = await post(deT, `/api/quotations/${q2.json.id}/convert`, {});
  assert(cv.status === 403 && /needs approval/i.test(cv.json.error || '') && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales'")).c === sold, 'Converting it as Data Entry is held by the approval rule: nothing is posted');
  const cvOwner = await post(adminTok2, `/api/quotations/${q2.json.id}/convert`, {});
  assert(cvOwner.status === 200 && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales'")).c === sold + 1, 'The Owner (exempt) can convert it; one Sales voucher is posted');
  assert((await get('SELECT direction FROM inventory_entries ORDER BY id DESC LIMIT 1')).direction === 'OUT', 'The invoice takes stock OUT');
  assert((await req('GET', '/api/report-center', { token: deT })).status === 403 && (await req('GET', '/api/report-center/sales-register', { token: deT })).status === 403, 'Data Entry cannot open the report centre (sales analytics need the financial-view permission)');
  assert((await req('GET', '/api/report-center', { token: accT })).status === 200, 'Accountant can open the report centre');
  assert((await req('GET', '/api/documents/capabilities', { token: viewerT })).status === 200, 'Printing documents stays available to signed-in users');


  console.log('\n--- 10. Nothing sensitive in the frontend or documents ---');
  const roots = ['public/app.js', 'public/index.html', 'README.md', 'main.js', 'start-tally.bat', 'Launch-TallyPrime.vbs', 'build-installer.bat', 'Install-Desktop-App.bat', '.env.example'].concat(fs.readdirSync(path.join(__dirname, 'public', 'ext')).map((f) => 'public/ext/' + f));
  const bad = [];
  for (const f of roots) {
    let txt = ''; try { txt = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (e) { continue; }
    for (const w of ['admin123', 'acc123', 'data123', 'audit123', 'view123', 'guest123', "password: 'guest'", "'offline_token_' +"]) if (txt.includes(w.replace(/"/g, ''))) bad.push(`${f}: ${w}`);
  }
  assert(!bad.length, 'No default password or fake offline session in the frontend, launchers or docs', bad.join('; '));
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  assert(!/id="login-password"[^>]*value="[^"]+"/.test(html) && !html.includes('qu-guest'), 'The main page has no pre-filled password or quick-user buttons');
  const portalHtml = fs.readFileSync(path.join(__dirname, 'public/portal.html'), 'utf8');
  assert(/type="password"/.test(portalHtml) && !/<input[^>]*type="password"[^>]*value="[^"]+"/.test(portalHtml) && portalHtml.includes('This page is for customers'), 'The customer sign-in page has no pre-filled password and turns staff away');
  const appJs = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
  assert(/function loginAsGuest\(\) \{\n  if \(window\.RREAccounts\) window\.RREAccounts\.continueAsGuest\(\);/.test(appJs.replace(/\r\n/g, '\n')), 'The page asks the server for a guest session; it holds no guest password');
  assert(fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8').split(/\r?\n/).includes('.tally-profile/'), '.tally-profile/ is in .gitignore');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

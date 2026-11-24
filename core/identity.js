/**
 * RRE Entries — ONE identity system for the whole application (accounting, inventory, customer portal, everything).
 *
 *  - one users table (per company database); every person has exactly one account
 *  - three login types (Admin, Employee, Customer) that are only a CHECK against the role assigned in the database
 *  - Argon2id password hashes (see security.js); passwords are never readable by anyone, administrators included
 *  - server-side sessions that can be ended (logout, deactivation, password reset) and expire
 *  - account lock-out after repeated failures, and an audit trail of authentication events
 *  - secure password reset / invitation by e-mail: random single-use tokens, stored only as hashes, time-limited
 *  - administrator functions: create employees and customers, roles, module access, activate / deactivate, reset
 */
const crypto = require('crypto');
const db = require('./db');
const { hashPassword, verifyPassword, needsRehash, createSessionToken } = require('./security');
const { checkPassword } = require('./passwordPolicy');
const mailer = require('./mailer');

const { get, all, run } = db;
const bad = (m, s = 400, code) => { const e = new Error(m); e.status = s; if (code) e.code = code; return e; };

// ---------------------------------------------------------------------------------------------------- roles, login types, modules
const TYPE_OF = { Owner: 'admin', Administrator: 'admin', Accountant: 'employee', 'Data Entry': 'employee', Auditor: 'employee', Viewer: 'employee', Customer: 'customer', Guest: 'guest' };
const EMPLOYEE_ROLES = ['Accountant', 'Data Entry', 'Auditor', 'Viewer'];
const LOGIN_TYPES = ['admin', 'employee', 'customer'];
const MODULES = [
  { key: 'accounting', label: 'Accounting & vouchers' }, { key: 'reports', label: 'Reports & financial statements' }, { key: 'inventory', label: 'Inventory' },
  { key: 'banking', label: 'Banking & GST' }, { key: 'quotations', label: 'Quotations & documents' }
];
// URL prefix -> module. An employee WITH an explicit module list can only use the modules in it (an administrator always can).
const MODULE_PATHS = [
  ['inventory', /^\/api\/(inv|inventory|inventory-app|tracking)(\/|$)/],
  ['accounting', /^\/api\/(vouchers|masters|attachments|recurring|import|approvals|bulk|ocr)(\/|$)/],
  ['reports', /^\/api\/(reports|report-center|insights|yearend|dashboard)(\/|$)/],
  ['banking', /^\/api\/(bank|gst)(\/|$)/],
  ['quotations', /^\/api\/(quotations|documents)(\/|$)/]
];
const moduleOf = (url) => { const m = MODULE_PATHS.find(([, re]) => re.test(url)); return m ? m[0] : null; };
const parseModules = (v) => { if (v == null || v === '') return null; try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((k) => MODULES.some((m) => m.key === k)) : null; } catch (e) { return null; } };

const VERIFY_HOURS = 24;
const SESSION_HOURS = 12, REMEMBER_HOURS = 14 * 24, MAX_FAILS = 5, LOCK_MINUTES = 15, RESET_MINUTES = 30, INVITE_HOURS = 72;
const GENERIC_FAIL = 'We could not sign you in. Check your email or username, your password and the login type you chose. After several failed attempts an account is locked for 15 minutes.';
const iso = (d = new Date()) => new Date(d).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const lc = (s) => String(s || '').trim().toLowerCase();

// ---------------------------------------------------------------------------------------------------- audit
async function audit(action, { user = null, userId = null, username = null, role = null, ip = null, details = null } = {}) {
  try {
    await run('INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId ?? (user && user.id) ?? null, username || (user && user.username) || null, role || (user && user.role) || null, action, 'auth', (userId ?? (user && user.id)) != null ? String(userId ?? user.id) : null, details ? JSON.stringify(details).slice(0, 1500) : null, ip]);
  } catch (e) { /* auditing must never break authentication */ }
}

// A database opened without the migrations (older tools, tests) gets the identity tables the first time they are needed.
let schemaFor = null;
async function ready() {
  const f = db.getDbPath(); if (schemaFor === f) return;
  const cols = (await all('PRAGMA table_info(users)')).map((c) => c.name);
  if (cols.length && !cols.includes('failed_logins')) await require('./migrations').runMigrations();
  schemaFor = f;
}

// ---------------------------------------------------------------------------------------------------- live session state (so requests can be checked without a database round trip)
const state = { company: null, sessions: new Map(), users: new Map(), revokeHooks: [], changeHooks: [] };
const onRevoke = (fn) => state.revokeHooks.push(fn);
const onChange = (fn) => state.changeHooks.push(fn); // an account's role / name / status changed: other modules (inventory) follow
const changed = (id) => { for (const f of state.changeHooks) { try { f(id); } catch (e) { /* best effort */ } } };
async function refreshUser(id) {
  const u = await get('SELECT id, username, role, status, module_access, party_id, must_change_password FROM users WHERE id = ?', [id]);
  if (u) state.users.set(id, { status: u.status, role: u.role, modules: parseModules(u.module_access), party_id: u.party_id, username: u.username }); else state.users.delete(id);
  return u;
}
let sweeper = null;
function sweep() {
  const now = Date.now(), gone = new Set();
  for (const [sid, x] of [...state.sessions]) if (now > x.exp) { state.sessions.delete(sid); gone.add(x.userId); }
  for (const uid of gone) if (![...state.sessions.values()].some((x) => x.userId === uid)) for (const f of state.revokeHooks) { try { f(uid, 'expired'); } catch (e) { /* best effort */ } } // other modules (inventory) end their session too
}
async function preload() {
  if (!sweeper) { sweeper = setInterval(sweep, 60000); if (sweeper.unref) sweeper.unref(); }
  state.company = String(db.getCompanyNumber());
  state.sessions.clear(); state.users.clear();
  try {
    await run("DELETE FROM auth_sessions WHERE expires_at < ?", [iso(Date.now() - 30 * 864e5)]);
    const rows = await all('SELECT sid, user_id, expires_at FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?', [iso()]);
    const ids = new Set();
    for (const r of rows) { state.sessions.set(r.sid, { userId: r.user_id, exp: Date.parse(r.expires_at) }); ids.add(r.user_id); }
    for (const id of ids) await refreshUser(id);
  } catch (e) { /* tables are created by the migration; before it runs there is nothing to load */ }
}
/** Re-reads every cached account (called after any write to the users table made outside this module). */
let refreshing = null;
function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      for (const id of [...state.users.keys()]) {
        const before = state.users.get(id), u = await refreshUser(id), after = state.users.get(id);
        if (!u) for (const [sid, x] of [...state.sessions]) if (x.userId === id) state.sessions.delete(sid);
        if (!before || !after || before.status !== after.status || before.role !== after.role) { if (!after || after.status !== 'Active') await revokeUserSessions(id, 'deactivated').catch(() => {}); changed(id); }
      }
    } catch (e) { /* ignore */ } finally { refreshing = null; }
  })();
  return refreshing;
}
/** Synchronous check used on every request. Returns the CURRENT account facts (role, modules) or null if the session is not valid. */
function liveSession(sid, userId) {
  const s = state.sessions.get(sid);
  if (!s || s.userId !== userId || Date.now() > s.exp) return null;
  const u = state.users.get(userId);
  return u && u.status === 'Active' ? u : null;
}
async function createSession(user, meta = {}, remember = false) {
  const sid = crypto.randomBytes(18).toString('base64url'), hours = remember ? REMEMBER_HOURS : SESSION_HOURS, exp = Date.now() + hours * 3600e3;
  await run('INSERT INTO auth_sessions (sid, user_id, created_at, expires_at, remember, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)', [sid, user.id, iso(), iso(exp), remember ? 1 : 0, meta.ip || null, String(meta.agent || '').slice(0, 200)]);
  state.sessions.set(sid, { userId: user.id, exp });
  await refreshUser(user.id);
  return { sid, hours, expires_at: iso(exp) };
}
async function revokeSession(sid, reason = 'logout') {
  if (!sid) return;
  const s = state.sessions.get(sid); state.sessions.delete(sid);
  await run('UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE sid = ? AND revoked_at IS NULL', [iso(), reason, sid]);
  if (s) for (const f of state.revokeHooks) { try { f(s.userId, reason); } catch (e) { /* best effort */ } }
}
async function revokeUserSessions(userId, reason = 'revoked', exceptSid = null) {
  for (const [sid, s] of [...state.sessions]) if (s.userId === userId && sid !== exceptSid) state.sessions.delete(sid);
  await run('UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR sid <> ?)', [iso(), reason, userId, exceptSid, exceptSid]);
  for (const f of state.revokeHooks) { try { f(userId, reason); } catch (e) { /* best effort */ } }
}

// ---------------------------------------------------------------------------------------------------- sign-in
async function findAccount(identifier) {
  const id = String(identifier || '').trim(); if (!id) return null;
  const rows = await all('SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE', [id, id]);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) { const byName = rows.filter((r) => lc(r.username) === lc(id)); return byName.length === 1 ? byName[0] : null; } // an e-mail shared by several accounts is ambiguous: refuse
  return null;
}
let dummyHash = null;
const DUMMY = () => (dummyHash = dummyHash || hashPassword(crypto.randomBytes(18).toString('hex')));

const permissionsOf = (role) => db.getRolePermissions(role);
async function profileOf(u) {
  const party = u.party_id ? await get('SELECT id, name FROM ledgers WHERE id = ?', [u.party_id]) : null;
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, email: u.email, phone: u.phone, status: u.status, allow_backdated_entries: u.allow_backdated_entries,
    login_type: TYPE_OF[u.role] || 'employee', modules: parseModules(u.module_access), customer: party ? { id: party.id, name: party.name } : null, created_at: u.created_at, last_login: u.last_login };
}

/** Signs a verified person in: records the login, starts a server-side session and returns the token. */
async function issueLogin(user, meta = {}, { remember = false } = {}) {
  await ready();
  const now = iso();
  await run('UPDATE users SET last_login = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [now, user.id]);
  await run('INSERT INTO user_logins (user_id, username, role, ip_address, user_agent, login_time) VALUES (?, ?, ?, ?, ?, ?)', [user.id, user.username, user.role, meta.ip || '127.0.0.1', meta.agent || 'RRE', now]);
  const sess = await createSession(user, meta, remember);
  const token = createSessionToken(user, sess.hours, sess.sid);
  await audit('AUTH_LOGIN', { user, ip: meta.ip, details: { remember: !!remember, must_change_password: !!user.must_change_password } });
  const fresh = await get('SELECT * FROM users WHERE id = ?', [user.id]);
  return { success: true, data: { user: await profileOf(fresh), permissions: permissionsOf(user.role), token, must_change_password: !!user.must_change_password, login_type: TYPE_OF[user.role] || 'employee', home: user.role === 'Customer' ? 'portal' : 'app', expires_at: sess.expires_at } };
}

/**
 * identifier = e-mail or username. loginType ('admin' | 'employee' | 'customer') is only CHECKED against the role stored in the database;
 * it never grants anything. Every failure gives the same message, so nobody learns whether an account exists or what role it has.
 */
async function authenticate(identifier, password, meta = {}, { loginType = null, remember = false } = {}) {
  await ready();
  const generic = { success: false, error: GENERIC_FAIL };
  const user = await findAccount(identifier);
  const p = String(password || '').trim();
  if (!user) { verifyPassword(p || 'x', DUMMY()); await audit('AUTH_LOGIN_FAILED', { username: String(identifier || '').slice(0, 80), ip: meta.ip, details: { reason: 'unknown_account' } }); return generic; }
  if (user.role === 'Guest') return { success: false, error: 'The Guest account has no password. Use the Guest button on the login screen.' };
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) { await audit('AUTH_LOGIN_BLOCKED', { user, ip: meta.ip, details: { reason: 'locked' } }); return generic; }
  if (user.password === db.SETUP_MARKER) return { success: false, error: 'First-time setup is not finished. Open RRE Entries on this computer and choose the administrator password.' };
  if (!p) return generic;
  const v = verifyPassword(p, user.password);
  if (!v.valid) {
    const fails = (user.failed_logins || 0) + 1, lock = fails >= MAX_FAILS;
    await run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock ? iso(Date.now() + LOCK_MINUTES * 60e3) : null, user.id]);
    await audit('AUTH_LOGIN_FAILED', { user, ip: meta.ip, details: { reason: 'wrong_password', locked: lock } });
    return generic;
  }
  if (user.status === 'Pending') { await audit('AUTH_LOGIN_BLOCKED', { user, ip: meta.ip, details: { reason: 'unverified' } }); return { success: false, code: 'EMAIL_NOT_VERIFIED', error: 'Please confirm your e-mail address first. Open the link we sent you, or request a new one below.' }; }
  if (user.status !== 'Active') { await audit('AUTH_LOGIN_BLOCKED', { user, ip: meta.ip, details: { reason: 'inactive' } }); return { success: false, error: 'This account is deactivated. Contact your administrator.' }; }
  if (loginType != null && TYPE_OF[user.role] !== lc(loginType)) { await audit('AUTH_LOGIN_TYPE_MISMATCH', { user, ip: meta.ip, details: { chosen: String(loginType).slice(0, 20) } }); return generic; }
  if (v.needsMigration || needsRehash(user.password)) { try { await run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(p), user.id]); } catch (e) { /* the old hash keeps working */ } }
  return issueLogin(user, meta, { remember });
}

async function logout(user, meta = {}) {
  if (user && user.sid) await revokeSession(user.sid, 'logout');
  if (user) await audit('AUTH_LOGOUT', { userId: user.userId, username: user.username, role: user.role, ip: meta.ip });
  return { success: true };
}

async function me(userId) {
  const u = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!u || u.status !== 'Active') throw bad('This account is not active.', 401);
  return { user: await profileOf(u), permissions: permissionsOf(u.role), must_change_password: !!u.must_change_password, login_type: TYPE_OF[u.role] || 'employee', home: u.role === 'Customer' ? 'portal' : 'app' };
}

// ---------------------------------------------------------------------------------------------------- forgot / reset / invitation
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr); return false;
}
async function makeToken(userId, purpose, minutes, createdBy = null, ip = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  await run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [iso(), userId]); // only the newest link works
  await run('INSERT INTO password_resets (user_id, token_hash, purpose, created_at, expires_at, requested_ip, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, sha256(token), purpose, iso(), iso(Date.now() + minutes * 60e3), ip, createdBy]);
  return token;
}
const linkFor = (token, kind = 'reset') => `${mailer.publicUrl()}/login.html?${kind === 'verify' ? 'verify' : 'reset'}=${encodeURIComponent(token)}`;
async function mailLink(user, token, purpose) {
  const url = linkFor(token, purpose === 'verify' ? 'verify' : 'reset');
  const msg = purpose === 'verify' ? mailer.verifyEmail({ name: user.full_name, url, hours: VERIFY_HOURS }) : purpose === 'invite' ? mailer.inviteEmail({ name: user.full_name, url, hours: INVITE_HOURS, role: user.role }) : mailer.resetEmail({ name: user.full_name, url, minutes: RESET_MINUTES });
  const r = await mailer.send({ to: user.email, ...msg });
  if (!r.sent) {
    console.warn(`[Identity] ${purpose} e-mail was not sent (${r.reason}).`);
    if (r.reason === 'not_configured' && process.env.RRE_MAIL_DEV_LOG === '1') console.log(`[Identity] (dev) ${purpose} link for ${user.email}: ${url}`);
  }
  return r;
}

/** Always answers the same way. The e-mail is sent (or not) in the background, so timing does not reveal whether an account exists. */
function requestReset(email, meta = {}) {
  const addr = lc(email);
  const done = (async () => {
    if (!EMAIL.test(addr)) return;
    if (limited(`ip:${meta.ip || '?'}`, 8, 15 * 60e3) || limited(`mail:${addr}`, 3, 60 * 60e3)) { await audit('AUTH_RESET_THROTTLED', { username: addr.slice(0, 80), ip: meta.ip }); return; }
    const rows = await all("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND status = 'Active' AND role <> 'Guest'", [addr]);
    if (rows.length !== 1) { await audit('AUTH_RESET_REQUESTED', { username: addr.slice(0, 80), ip: meta.ip, details: { account: rows.length ? 'ambiguous' : 'none' } }); return; }
    const user = rows[0], token = await makeToken(user.id, 'reset', RESET_MINUTES, null, meta.ip);
    await audit('AUTH_RESET_REQUESTED', { user, ip: meta.ip });
    await mailLink(user, token, 'reset');
  })().catch((e) => console.warn('[Identity] reset request failed:', e.message));
  return { ok: true, done };
}
async function tokenRow(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const r = await get('SELECT * FROM password_resets WHERE token_hash = ?', [sha256(token)]);
  if (!r || r.used_at || Date.parse(r.expires_at) < Date.now()) return null;
  return r;
}
async function validateResetToken(token) { const t = await tokenRow(token); return { valid: !!t && t.purpose !== 'verify', purpose: t ? t.purpose : null }; }
async function resetPassword(token, newPassword, meta = {}) {
  const t = await tokenRow(token);
  if (!t || t.purpose === 'verify') throw bad('This link is no longer valid. Request a new one.', 400, 'RESET_INVALID');
  const user = await get('SELECT * FROM users WHERE id = ?', [t.user_id]);
  const invited = t.purpose === 'invite' && user && user.status === 'Invited';
  if (!user || (user.status !== 'Active' && !invited)) throw bad('This link is no longer valid. Request a new one.', 400, 'RESET_INVALID');
  const pw = String(newPassword || '').trim(), weak = checkPassword(pw, { username: user.username }); if (weak) throw bad(weak, 422, 'WEAK_PASSWORD');
  const claimed = await run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', [iso(), t.id]); // atomic: a link can be used once, even under a race
  if (!claimed.changes) throw bad('This link is no longer valid. Request a new one.', 400, 'RESET_INVALID');
  await run("UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ?, failed_logins = 0, locked_until = NULL, email_verified = 1, email_verified_at = COALESCE(email_verified_at, ?), status = CASE WHEN status = 'Invited' THEN 'Active' ELSE status END WHERE id = ?", [hashPassword(pw), iso(), iso(), user.id]);
  await refreshUser(user.id);
  await run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [iso(), user.id]);
  await revokeUserSessions(user.id, 'password_reset');
  await audit('AUTH_PASSWORD_RESET', { user, ip: meta.ip, details: { via: t.purpose } });
  if (user.email) mailer.send({ to: user.email, ...mailer.changedEmail({ name: user.full_name }) }).catch(() => {});
  return { success: true };
}

// ---------------------------------------------------------------------------------------------------- customer self-registration
const PHONE = /^\+?[0-9][0-9 ()-]{6,18}[0-9]$/;
async function customerLedger(name, email, phone) {
  const ord = require('./invOrders');
  for (const n of [name, `${name} (${email})`]) {
    try { return await ord.saveParty('customer', null, { name: n, email, phone }, { userId: null, username: 'self-registration', role: 'System' }); }
    catch (e) { if (e.status !== 409) throw e; }
  }
  throw bad('We could not create the account. Please contact the business.', 409);
}
/**
 * Anyone may create a CUSTOMER account and nothing else: the role is fixed here, the request cannot choose one. The account stays
 * "Pending" (cannot sign in) until the e-mail address is confirmed with a single-use link. The answer never reveals whether the
 * address already had an account (that person is told by e-mail).
 */
async function signup(b = {}, meta = {}) {
  // Without e-mail set up there is nobody to send the confirmation link to: the account is activated at once (still always a Customer).
  // As soon as the Gmail settings are added, every new account goes back to e-mail confirmation.
  const noMail = !mailer.isConfigured();
  if (limited(`signup:${meta.ip || "?"}`, 40, 60 * 60e3)) throw bad('Too many attempts. Please try again later.', 429);
  const name = String(b.full_name || '').trim().replace(/\s+/g, ' ');
  const email = lc(b.email), phone = String(b.phone || '').trim();
  if (name.length < 2 || name.length > 80) throw bad('Enter your full name.', 422);
  if (!EMAIL.test(email) || email.length > 120) throw bad('Enter a valid e-mail address.', 422);
  if (!PHONE.test(phone)) throw bad('Enter a valid mobile number (digits, optionally with + and a country code).', 422);
  if (b.confirm !== undefined && b.confirm !== b.password) throw bad('The two passwords do not match.', 422);
  const pw = String(b.password || '').trim(), weak = checkPassword(pw, { username: email.split('@')[0] }); if (weak) throw bad(weak, 422, 'WEAK_PASSWORD');
  const generic = { success: true, message: 'Almost done: we sent a message to that e-mail address. Open the link in it to activate your account.' };
  const existing = await all('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (existing.length && noMail) throw bad('An account with this e-mail address already exists. Sign in, or ask the business to help you.', 409);
  if (existing.length) {
    const u = existing[0];
    if (existing.length === 1 && u.role === 'Customer' && u.status === 'Pending') { // never verified: send a fresh link, change nothing else
      const token = await makeToken(u.id, 'verify', VERIFY_HOURS * 60, null, meta.ip); await mailLink(u, token, 'verify');
    } else mailer.send({ to: email, ...mailer.existsEmail({ name: u.full_name }) }).catch(() => {});
    await audit('AUTH_SIGNUP_DUPLICATE', { username: email.slice(0, 80), ip: meta.ip });
    return generic;
  }
  const party = (await customerLedger(name, email, phone)).id;
  const username = await uniqueUsername(email.split('@')[0]);
  const r = await run(`INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password, party_id, email_verified) VALUES (?, ?, ?, 'Customer', ?, ?, ?, 0, 0, ?, 0)`, [username, hashPassword(pw), name, email, phone, noMail ? 'Active' : 'Pending', party]);
  const created = await get('SELECT * FROM users WHERE id = ?', [r.lastID]);
  await audit('AUTH_SIGNUP', { user: created, ip: meta.ip, details: { activated_without_email: noMail } });
  if (noMail) { await refreshUser(created.id); return { success: true, activated: true, message: 'Your account is ready. You can sign in now.' }; }
  const token = await makeToken(created.id, 'verify', VERIFY_HOURS * 60, null, meta.ip), sent = await mailLink(created, token, 'verify');
  if (!sent.sent) throw bad('We could not send the confirmation e-mail. Please try again in a few minutes.', 502);
  return generic;
}
async function verifyEmail(token, meta = {}) {
  const t = await tokenRow(token);
  if (!t || t.purpose !== 'verify') throw bad('This confirmation link is no longer valid. Request a new one.', 400, 'VERIFY_INVALID');
  const user = await get('SELECT * FROM users WHERE id = ?', [t.user_id]);
  if (!user || user.role !== 'Customer' || !['Pending', 'Active'].includes(user.status)) throw bad('This confirmation link is no longer valid. Request a new one.', 400, 'VERIFY_INVALID');
  const claimed = await run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', [iso(), t.id]);
  if (!claimed.changes) throw bad('This confirmation link is no longer valid. Request a new one.', 400, 'VERIFY_INVALID');
  await run("UPDATE users SET status = 'Active', email_verified = 1, email_verified_at = ? WHERE id = ?", [iso(), user.id]);
  await refreshUser(user.id);
  await audit('AUTH_EMAIL_VERIFIED', { user, ip: meta.ip });
  return { success: true };
}
function resendVerification(email, meta = {}) {
  const addr = lc(email);
  const done = (async () => {
    if (!EMAIL.test(addr) || limited(`vip:${meta.ip || '?'}`, 8, 15 * 60e3) || limited(`verify:${addr}`, 3, 60 * 60e3)) return;
    const u = await get("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND role = 'Customer' AND status = 'Pending'", [addr]);
    if (!u) return;
    const token = await makeToken(u.id, 'verify', VERIFY_HOURS * 60, null, meta.ip); await mailLink(u, token, 'verify');
  })().catch((e) => console.warn('[Identity] resend failed:', e.message));
  return { ok: true, done };
}

// ---------------------------------------------------------------------------------------------------- administrators: users
const adminRoleOk = (role) => ['Owner', ...EMPLOYEE_ROLES, 'Customer'].includes(role);
async function ownerCount(exceptId = null) { return (await get("SELECT COUNT(*) c FROM users WHERE role = 'Owner' AND status = 'Active' AND (? IS NULL OR id <> ?)", [exceptId, exceptId])).c; }
async function uniqueEmail(email, exceptId = null) {
  if (await get('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND (? IS NULL OR id <> ?)', [email, exceptId, exceptId])) throw bad('That e-mail address already belongs to another account.', 409);
}
async function uniqueUsername(base) {
  let u = lc(base).replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user', n = 0;
  while (await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [n ? `${u}${n}` : u])) n++;
  return n ? `${u}${n}` : u;
}
const cleanModules = (m) => { if (m === undefined) return undefined; if (m === null || m === '') return null; const a = (Array.isArray(m) ? m : []).filter((k) => MODULES.some((x) => x.key === k)); return JSON.stringify([...new Set(a)]); };

async function listUsers(q = {}) {
  const where = ['1=1'], p = [];
  if (q.type && LOGIN_TYPES.includes(q.type)) { const roles = Object.keys(TYPE_OF).filter((r) => TYPE_OF[r] === q.type); where.push(`u.role IN (${roles.map(() => '?').join(',')})`); p.push(...roles); }
  if (q.status === 'Active' || q.status === 'Inactive') { where.push('u.status = ?'); p.push(q.status); }
  if (q.q) { where.push("(u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)"); const n = `%${String(q.q).replace(/[%_]/g, '')}%`; p.push(n, n, n); }
  const rows = await all(`SELECT u.id, u.username, u.full_name, u.role, u.email, u.phone, u.status, u.created_at, u.last_login, u.must_change_password, u.email_verified, u.auth_provider, u.module_access, u.party_id, u.needs_review, u.locked_until, u.failed_logins, u.password_changed_at,
      l.name AS customer, (SELECT COUNT(*) FROM user_logins x WHERE x.user_id = u.id) AS logins, (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS open_sessions,
      (SELECT COUNT(*) FROM password_resets r WHERE r.user_id = u.id AND r.used_at IS NULL AND r.expires_at > ?) AS reset_pending
    FROM users u LEFT JOIN ledgers l ON l.id = u.party_id WHERE ${where.join(' AND ')} ORDER BY CASE u.role WHEN 'Owner' THEN 0 WHEN 'Customer' THEN 2 ELSE 1 END, u.full_name COLLATE NOCASE LIMIT 500`, [iso(), iso(), ...p]);
  return rows.map((r) => ({ id: r.id, username: r.username, full_name: r.full_name, email: r.email, phone: r.phone, role: r.role, login_type: TYPE_OF[r.role] || 'employee', status: r.status, created_at: r.created_at, last_login: r.last_login,
    must_change_password: !!r.must_change_password, auth_provider: r.auth_provider || 'local', email_verified: !!r.email_verified, modules: parseModules(r.module_access), customer: r.customer || null, party_id: r.party_id, needs_review: !!r.needs_review, locked: !!(r.locked_until && Date.parse(r.locked_until) > Date.now()), login_count: r.logins, open_sessions: r.open_sessions, reset_pending: !!r.reset_pending, password_set: r.password !== db.SETUP_MARKER }));
}

async function createUser(b = {}, actor) {
  const role = String(b.role || (b.login_type === 'customer' ? 'Customer' : b.login_type === 'admin' ? 'Owner' : 'Data Entry')).trim();
  if (!adminRoleOk(role)) throw bad(`Role must be one of: Owner, ${EMPLOYEE_ROLES.join(', ')}, Customer.`);
  if (role === 'Owner' && !(actor && actor.role === 'Owner')) throw bad('Only an administrator can create another administrator.', 403);
  const name = String(b.full_name || '').trim().slice(0, 80); if (name.length < 2) throw bad('Enter the person\'s name.');
  const email = lc(b.email), hasTemp = !!String(b.password || '').trim();
  if (email || !hasTemp) { if (!EMAIL.test(email)) throw bad('Enter a valid e-mail address. It is where the password link is sent.'); await uniqueEmail(email); }
  let party = null;
  if (role === 'Customer') {
    party = await get("SELECT l.id, l.name, l.is_active FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ? AND g.name = 'Sundry Debtors'", [parseInt(b.party_id, 10) || 0]);
    if (!party) throw bad('Choose the customer this login belongs to.'); if (!party.is_active) throw bad(`${party.name} is archived.`, 422);
    if ((await get("SELECT COUNT(*) c FROM users WHERE role = 'Customer' AND party_id = ?", [party.id])).c >= 5) throw bad(`${party.name} already has 5 logins.`, 409);
  }
  const username = b.username ? String(b.username).trim() : await uniqueUsername(email.split('@')[0]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{2,39}$/.test(username)) throw bad('The username must be 3-40 characters: letters, numbers, dot, dash, underscore or @.');
  if (await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username])) throw bad(`The username "${username}" is already taken.`, 409);
  const temp = b.password ? String(b.password).trim() : '';
  if (temp) { const weak = checkPassword(temp, { username }); if (weak) throw bad(weak, 400); }
  else if (!mailer.isConfigured()) throw bad('E-mail is not set up on this computer, so the invitation link cannot be sent. Enter a temporary password instead (the person must change it at first sign-in), or set up e-mail (see .env.example).', 409, 'MAIL_NOT_CONFIGURED');
  const modules = role === 'Customer' || role === 'Owner' ? null : cleanModules(b.modules);
  const r = await run(`INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password, party_id, module_access, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [username, hashPassword(temp || crypto.randomBytes(24).toString('hex')), name, role, email, String(b.phone || '').trim().slice(0, 30), temp ? 'Active' : 'Invited', b.allow_backdated_entries ? 1 : 0, party ? party.id : null, modules === undefined ? null : modules, actor ? actor.userId : null]);
  await refreshUser(r.lastID);
  const created = await get('SELECT * FROM users WHERE id = ?', [r.lastID]);
  await audit('AUTH_USER_CREATE', { userId: actor && actor.userId, username: actor && actor.username, role: actor && actor.role, details: { created: created.username, role, how: temp ? 'temporary_password' : 'invitation' } });
  let invite = null;
  if (!temp) { const token = await makeToken(created.id, 'invite', INVITE_HOURS * 60, actor && actor.userId); invite = await mailLink(created, token, 'invite'); }
  return { id: created.id, username: created.username, email, role, invited: !!(invite && invite.sent), invitation_error: invite && !invite.sent ? invite.reason : null };
}

async function updateUser(id, b = {}, actor) {
  const u = await get('SELECT * FROM users WHERE id = ?', [id]); if (!u) throw bad('User not found.', 404);
  const sets = [], p = []; let revoke = null;
  const set = (col, val) => { sets.push(`${col} = ?`); p.push(val); };
  if (b.full_name !== undefined) { const n = String(b.full_name).trim().slice(0, 80); if (n.length < 2) throw bad('Enter the person\'s name.'); set('full_name', n); }
  if (b.phone !== undefined) set('phone', String(b.phone || '').trim().slice(0, 30));
  if (b.allow_backdated_entries !== undefined && b.allow_backdated_entries !== null) set('allow_backdated_entries', b.allow_backdated_entries ? 1 : 0);
  if (b.email !== undefined && lc(b.email) !== lc(u.email)) { const e = lc(b.email); if (!EMAIL.test(e)) throw bad('Enter a valid e-mail address.'); await uniqueEmail(e, id); set('email', e); revoke = 'email_changed'; }
  if (b.role !== undefined && b.role !== u.role) {
    if (!adminRoleOk(b.role)) throw bad('That role is not available.');
    if (actor && actor.userId === id) throw bad('You cannot change your own role.', 400);
    if (u.role === 'Owner' && (await ownerCount(id)) < 1) throw bad('There must always be one active administrator.', 409);
    if ((b.role === 'Customer') !== (u.role === 'Customer')) throw bad('A customer login cannot become a staff account, or the other way round. Create a separate account.', 400);
    if (b.role === 'Owner' && !(actor && actor.role === 'Owner')) throw bad('Only an administrator can make someone an administrator.', 403);
    set('role', b.role); set('needs_review', 0); // live role applies to open sessions at once (see auth.identify)
  }
  if (b.modules !== undefined) { if (u.role === 'Customer' || u.role === 'Owner') throw bad('Module access applies to employees only.'); set('module_access', cleanModules(b.modules)); }
  if (b.status !== undefined && b.status !== u.status) {
    if (!['Active', 'Inactive'].includes(b.status)) throw bad('Status must be Active or Inactive.');
    if (b.status === 'Inactive') { if (actor && actor.userId === id) throw bad('You cannot deactivate your own account.', 400); if (u.role === 'Owner' && (await ownerCount(id)) < 1) throw bad('There must always be one active administrator.', 409); }
    set('status', b.status); set('deactivated_at', b.status === 'Inactive' ? iso() : null); if (b.status === 'Inactive') revoke = 'deactivated';
  }
  if (!sets.length) return (await listUsers({})).find((x) => x.id === id);
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  await refreshUser(id);
  if (revoke) await revokeUserSessions(id, revoke);
  changed(id);
  await audit('AUTH_USER_UPDATE', { userId: actor && actor.userId, username: actor && actor.username, role: actor && actor.role, details: { user: u.username, fields: Object.keys(b).filter((k) => k !== 'password') } });
  return (await listUsers({})).find((x) => x.id === id);
}

async function sendResetFor(id, actor) {
  const u = await get('SELECT * FROM users WHERE id = ?', [id]); if (!u || u.role === 'Guest') throw bad('User not found.', 404);
  if (u.status !== 'Active' && u.status !== 'Invited') throw bad('Activate the account before sending a password link.', 409);
  if (!EMAIL.test(lc(u.email))) throw bad('This account has no e-mail address. Add one first.', 409);
  if (!mailer.isConfigured()) throw bad('E-mail is not set up on this computer (see .env.example).', 409, 'MAIL_NOT_CONFIGURED');
  const kind = u.status === 'Invited' ? 'invite' : 'reset';
  const token = await makeToken(u.id, kind, kind === 'invite' ? INVITE_HOURS * 60 : RESET_MINUTES, actor && actor.userId), r = await mailLink(u, token, kind);
  await audit('AUTH_RESET_SENT_BY_ADMIN', { userId: actor && actor.userId, username: actor && actor.username, role: actor && actor.role, details: { user: u.username, sent: r.sent } });
  if (!r.sent) throw bad(`The e-mail could not be sent (${r.reason === 'authentication_failed' ? 'Gmail rejected the sign-in: check the app password' : r.reason === 'unreachable' ? 'the mail server could not be reached' : 'it failed'}).`, 502);
  return { sent: true };
}

async function loginActivity(q = {}) {
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50)), uid = parseInt(q.user, 10) || null;
  const logins = await all(`SELECT l.id, l.user_id, l.username, l.role, l.ip_address, l.user_agent, l.login_time FROM user_logins l WHERE (? IS NULL OR l.user_id = ?) ORDER BY l.login_time DESC LIMIT ?`, [uid, uid, limit]);
  const events = await all(`SELECT id, created_at, user_id, username, role, action, details, ip_address FROM activity_log WHERE entity = 'auth' AND action <> 'AUTH_LOGIN' AND (? IS NULL OR user_id = ?) ORDER BY id DESC LIMIT ?`, [uid, uid, limit]);
  return { logins, events: events.map((e) => ({ ...e, details: e.details ? (() => { try { return JSON.parse(e.details); } catch (x) { return null; } })() : null })) };
}

async function updateOwnProfile(userId, b = {}) {
  const sets = [], p = [];
  if (b.full_name !== undefined) { const n = String(b.full_name).trim().slice(0, 80); if (n.length < 2) throw bad('Enter your name.'); sets.push('full_name = ?'); p.push(n); }
  if (b.phone !== undefined) { sets.push('phone = ?'); p.push(String(b.phone || '').trim().slice(0, 30)); }
  if (sets.length) await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...p, userId]);
  return me(userId);
}

module.exports = {
  TYPE_OF, EMPLOYEE_ROLES, LOGIN_TYPES, MODULES, MODULE_PATHS, moduleOf, parseModules, GENERIC_FAIL,
  preload, refreshAll, liveSession, refreshUser, onRevoke, onChange, createSession, revokeSession, revokeUserSessions,
  authenticate, issueLogin, logout, me, findAccount,
  requestReset, validateResetToken, resetPassword, signup, verifyEmail, resendVerification,
  listUsers, createUser, updateUser, sendResetFor, loginActivity, updateOwnProfile, ownerCount, audit,
  _resetLimits: () => buckets.clear(),
  _state: state
};

/**
 * /api/auth — the ONE authentication API: sign-in (Admin / Employee / Customer), session, logout, forgot / reset password,
 * and (administrators only) user management. Mounted before the older inline routes, which it replaces where they overlap.
 */
const express = require('express');
const identity = require('../../core/identity');
const mailer = require('../../core/mailer');
const db = require('../../core/db');
const { loginRateLimiter, rateLimitLoginMiddleware } = require('../../core/security');
const { getRolePermissions } = db;

const router = express.Router();
const meta = (req) => ({ ip: req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1', agent: req.headers['user-agent'] || 'RRE' });
const fail = (res, e, dflt = 400) => res.status(e.status || dflt).json({ success: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
const needUser = (req, res) => { if (!req.user) { res.status(401).json({ success: false, error: 'Please sign in.', code: 'AUTH_REQUIRED' }); return false; } return true; };
const needAdmin = (req, res) => {
  if (!needUser(req, res)) return false;
  if (!getRolePermissions(req.user.role).canManageUsers) { res.status(403).json({ success: false, error: 'Only an administrator can manage users.', code: 'FORBIDDEN' }); return false; }
  return true;
};

// ---- public
router.get('/config', async (req, res) => {
  try {
    res.json({ success: true, data: { login_types: identity.LOGIN_TYPES, mail_configured: mailer.isConfigured(), signup_enabled: mailer.isConfigured(), setup_required: await db.isSetupRequired(), guest_access: await db.guestAccessEnabled() } });
  } catch (e) { fail(res, e, 500); }
});

router.post('/login', rateLimitLoginMiddleware, async (req, res) => {
  const m = meta(req), b = req.body || {};
  try {
    const type = b.login_type == null || b.login_type === '' ? null : String(b.login_type).toLowerCase();
    if (type !== null && !identity.LOGIN_TYPES.includes(type)) { loginRateLimiter.recordFailure(m.ip); return res.status(401).json({ success: false, error: identity.GENERIC_FAIL }); }
    const r = await db.authenticateUser(String(b.identifier || b.email || b.username || ''), String(b.password || ''), m, { loginType: type, remember: !!b.remember });
    if (!r.success) { loginRateLimiter.recordFailure(m.ip); return res.status(401).json(r); }
    loginRateLimiter.recordSuccess(m.ip);
    res.json(r);
  } catch (e) { loginRateLimiter.recordFailure(m.ip); fail(res, e, 500); }
});

// Customers create their own account (always the Customer role, confirmed by e-mail before it works).
router.post('/signup', async (req, res) => {
  try { res.status(201).json(await identity.signup(req.body || {}, meta(req))); } catch (e) { fail(res, e); }
});
router.post('/verify-email', async (req, res) => { try { res.json(await identity.verifyEmail(String((req.body || {}).token || ''), meta(req), (req.body || {}).claim ? String(req.body.claim) : null)); } catch (e) { fail(res, e); } });
router.post('/resend-verification', async (req, res) => {
  const { done } = identity.resendVerification(String((req.body || {}).email || ''), meta(req));
  if (process.env.RRE_TEST_AWAIT_MAIL === '1') await done;
  res.json({ success: true, message: 'If that address is waiting for confirmation, a new link has been sent.' });
});

// Forgot password: the answer is always the same, whether or not the address belongs to an account.
router.post('/forgot', async (req, res) => {
  const { done } = identity.requestReset(String((req.body || {}).email || ''), meta(req));
  if (process.env.RRE_TEST_AWAIT_MAIL === '1') await done;
  res.json({ success: true, message: 'If that e-mail address belongs to an account, a password reset link has been sent. The link works once and expires in 30 minutes.' });
});
router.get('/reset/validate', async (req, res) => { try { res.json({ success: true, data: await identity.validateResetToken(String(req.query.token || '')) }); } catch (e) { fail(res, e, 500); } });
router.post('/reset', rateLimitLoginMiddleware, async (req, res) => {
  const m = meta(req), b = req.body || {};
  try {
    if (b.confirm !== undefined && b.confirm !== b.password) return res.status(422).json({ success: false, error: 'The two passwords do not match.' });
    const r = await identity.resetPassword(String(b.token || ''), String(b.password || ''), m);
    loginRateLimiter.recordSuccess(m.ip); res.json(r);
  } catch (e) { loginRateLimiter.recordFailure(m.ip); fail(res, e); }
});

// ---- any signed-in person (customers included)
router.get('/me', async (req, res) => { if (!needUser(req, res)) return; try { res.json({ success: true, data: await identity.me(req.user.userId) }); } catch (e) { fail(res, e); } });
router.put('/me', async (req, res) => { if (!needUser(req, res)) return; try { res.json({ success: true, data: await identity.updateOwnProfile(req.user.userId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.post('/logout', async (req, res) => { try { res.json(await identity.logout(req.user, meta(req))); } catch (e) { fail(res, e, 500); } });

// ---- administrators
router.get('/modules', (req, res) => { if (!needAdmin(req, res)) return; res.json({ success: true, data: identity.MODULES }); });
router.get('/users', async (req, res) => { if (!needAdmin(req, res)) return; try { res.json({ success: true, data: await identity.listUsers(req.query) }); } catch (e) { fail(res, e, 500); } });
router.post('/users', async (req, res) => {
  if (!needAdmin(req, res)) return;
  try { const d = await identity.createUser(req.body || {}, req.user); res.json({ success: true, data: d, message: `Account "${d.username}" created.${d.invited ? ' An e-mail with a link to choose a password was sent.' : ''}` }); } catch (e) { fail(res, e); }
});
router.put('/users/:id', async (req, res) => {
  if (!needAdmin(req, res)) return;
  try {
    const b = { ...(req.body || {}) };
    if (b.password) { // legacy: an administrator may set a temporary password (the person must change it at first sign-in). It is never readable afterwards.
      const id = parseInt(req.params.id, 10), u = await db.get('SELECT username, role FROM users WHERE id = ?', [id]);
      if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
      const weak = require('../../core/passwordPolicy').checkPassword(String(b.password).trim(), { username: u.username }); if (weak) return res.status(400).json({ success: false, error: weak });
      await db.run('UPDATE users SET password = ?, must_change_password = 1, password_changed_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?', [require('../../core/security').hashPassword(String(b.password).trim()), id]);
      await identity.revokeUserSessions(id, 'password_set_by_admin');
      await identity.audit('AUTH_PASSWORD_SET_BY_ADMIN', { userId: req.user.userId, username: req.user.username, role: req.user.role, details: { user: u.username } });
    }
    delete b.password;
    const row = await identity.updateUser(parseInt(req.params.id, 10), b, req.user);
    res.json({ success: true, data: row, message: 'User updated.' });
  } catch (e) { fail(res, e); }
});
router.post('/users/:id/send-reset', async (req, res) => { if (!needAdmin(req, res)) return; try { res.json({ success: true, data: await identity.sendResetFor(parseInt(req.params.id, 10), req.user), message: 'A password link was e-mailed to the user.' }); } catch (e) { fail(res, e); } });
router.post('/users/:id/unlock', async (req, res) => {
  if (!needAdmin(req, res)) return;
  try { await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [parseInt(req.params.id, 10)]); res.json({ success: true }); } catch (e) { fail(res, e); }
});
router.post('/users/:id/sign-out', async (req, res) => { if (!needAdmin(req, res)) return; try { await identity.revokeUserSessions(parseInt(req.params.id, 10), 'signed_out_by_admin'); res.json({ success: true }); } catch (e) { fail(res, e); } });
router.get('/login-activity', async (req, res) => { if (!needAdmin(req, res)) return; try { res.json({ success: true, data: await identity.loginActivity(req.query) }); } catch (e) { fail(res, e, 500); } });

// Bringing existing people (RRE and the old inventory accounts) into this one list. Preview first; nothing is deleted either way.
router.get('/migration', async (req, res) => { if (!needAdmin(req, res)) return; try { res.json({ success: true, data: await require('../../core/identityMigration').lastReport() }); } catch (e) { fail(res, e, 500); } });
router.post('/migration', async (req, res) => {
  if (!needAdmin(req, res)) return;
  try { res.json({ success: true, data: await require('../../core/identityMigration').run({ apply: !!(req.body && req.body.apply === true), actor: req.user }) }); } catch (e) { fail(res, e, 500); }
});

module.exports = router;

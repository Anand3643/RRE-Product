/**
 * RRE Tally — Server-side authorisation for new modules.
 * Verifies the signed session token and enforces role permissions
 * (permissions come from the existing getRolePermissions()).
 */
const { verifySessionToken } = require('./security');
const { getRolePermissions, run, getCompanyNumber, isGuestAccessOn } = require('./db');

function readToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Returns the verified user payload or null (never throws). */
function identify(req) {
  const t = readToken(req);
  if (!t) return null;
  const r = verifySessionToken(t);
  if (!r.valid) return null;
  if (r.user.role === 'Guest' && !isGuestAccessOn()) return null; // guest access switched off: existing guest sessions stop working
  // A token only works in the company it was issued for (tokens from before multi-company belong to the original company).
  const tokenCompany = r.user.company || require('./paths').DEFAULT_COMPANY;
  if (String(tokenCompany) !== String(getCompanyNumber())) return null;
  // The token is only a handle: the session must still be open on the server and the account still active.
  // The role and module list always come from the account as it is NOW, so a change by an administrator applies at once.
  if (!r.user.sid) return process.env.RRE_LEGACY_TOKENS === '1' ? r.user : null; // test suites only: tokens without a server-side session

  const live = require('./identity').liveSession(r.user.sid, r.user.userId);
  if (!live) return null;
  return { ...r.user, role: live.role, modules: live.modules, partyId: live.party_id };
}

/**
 * requireAuth()                  -> any logged-in user
 * requireAuth('canViewFinancials') -> user whose role has that permission
 */
function requireAuth(permissionKey, opts = {}) {
  return (req, res, next) => {
    const user = identify(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in again.' });
    }
    // A customer-portal login may only use the portal. Every other route (reads included) refuses it unless it opts in.
    if (user.role === 'Customer' && !opts.allowCustomer) {
      return res.status(403).json({ success: false, error: 'Customer portal accounts can only use the customer portal.', code: 'PORTAL_ONLY' });
    }
    if (user.pwc) {
      return res.status(403).json({ success: false, error: 'You must choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED', must_change_password: true });
    }
    if (permissionKey) {
      const perms = getRolePermissions(user.role);
      if (!perms[permissionKey]) {
        return res.status(403).json({
          success: false,
          error: `Your role "${user.role}" is not permitted to perform this action.`
        });
      }
    }
    req.user = user;
    next();
  };
}

/** Writes an audit row. Never throws — auditing must not break the operation. */
async function logActivity({ user, ip, action, entity, entityId, details }) {
  try {
    await run(
      `INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user?.userId ?? null,
        user?.username ?? 'unknown',
        user?.role ?? 'unknown',
        action,
        entity || null,
        entityId != null ? String(entityId) : null,
        details ? (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 2000) : null,
        ip || null
      ]
    );
  } catch (e) {
    console.warn('[Activity Log] write skipped:', e.message);
  }
}

/**
 * Non-invasive capture of mutating calls to existing modules (no edits to those routers).
 * Logs only successful (<400) POST/PUT/DELETE requests.
 */
const AUDITED = [
  { re: /^\/api\/vouchers/, entity: 'voucher' },
  { re: /^\/api\/masters\/(\w[\w-]*)/, entity: 'master' },
  { re: /^\/api\/backup\/(create|restore)/, entity: 'backup' },
  { re: /^\/api\/company\//, entity: 'company' },
  { re: /^\/api\/auth\/users/, entity: 'user' },
  { re: /^\/api\/reports\/bank-reconciliation\/clear/, entity: 'bank-reconciliation' }
];

function activityCaptureMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const hit = AUDITED.find((a) => a.re.test(req.originalUrl.split('?')[0]));
  if (!hit) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const path = req.originalUrl.split('?')[0];
    const idMatch = /\/(\d+)$/.exec(path);
    logActivity({
      user: identify(req),
      ip: req.ip,
      action: `${req.method} ${path}`,
      entity: hit.entity,
      entityId: idMatch ? idMatch[1] : null,
      details: req.method === 'DELETE' ? null : summariseBody(req.body)
    });
  });
  next();
}

function summariseBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const k of ['voucher_type', 'voucher_no', 'date', 'name', 'total_amount', 'entry_id', 'filename', 'username', 'role']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return Object.keys(out).length ? out : null; // never store passwords / full payloads
}

module.exports = { requireAuth, identify, logActivity, activityCaptureMiddleware };

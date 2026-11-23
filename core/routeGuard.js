/**
 * RRE Tally — server-side authorisation for the EXISTING /api routes.
 *
 * Until now roles were enforced only in the browser, so any local process could call
 * /api/* directly. This guard requires a valid signed session token and applies the same
 * role permissions the UI already applies (getRolePermissions). It changes no route logic.
 *
 * Emergency switch: set RRE_ENFORCE_AUTH=0 to disable (logged loudly at startup).
 * /api/platform/* routes carry their own requireAuth() and are skipped here.
 */
const { identify } = require('./auth');
const { getRolePermissions } = require('./db');

const ENFORCE = process.env.RRE_ENFORCE_AUTH === '1';

// Public: needed before login or harmless read-only status.
const PUBLIC = [
  ['POST', /^\/api\/auth\/(login|register|google)\/?$/],
  ['GET', /^\/api\/auth\/permissions\/?$/],
  ['GET', /^\/api\/auth\/setup-status\/?$/],
  ['POST', /^\/api\/auth\/setup\/?$/],
  ['POST', /^\/api\/auth\/guest\/?$/],
  ['GET', /^\/api\/health\/?$/],
  ['GET', /^\/api\/gateway\/info\/?$/],
  ['GET', /^\/api\/system\/update-status\/?$/]
];

// Ordered: first match wins. perm = key in getRolePermissions(role).
const RULES = [
  { m: 'POST', re: /^\/api\/auth\/guest-access\/?$/, perm: 'canManageUsers' },
  { re: /^\/api\/auth\/users/, perm: 'canManageUsers' },
  { re: /^\/api\/auth\/audit-log/, perm: 'canViewAuditTrail' },
  { re: /^\/api\/system\/logs/, perm: 'canViewAuditTrail' },
  { m: 'POST', re: /^\/api\/system\/perform-update/, perm: 'canAlterCompany' },
  { re: /^\/api\/company\/(clean-slate|load-demo)/, perm: 'canCleanSlate' },
  { re: /^\/api\/company\/update/, perm: 'canAlterCompany' },
  { m: 'POST', re: /^\/api\/backup\/restore/, perm: 'canAlterCompany' },
  { re: /^\/api\/backup\//, perm: 'canViewAuditTrail' },
  { re: /^\/api\/export\/tally-xml/, perm: 'canViewFinancials' },
  { re: /^\/api\/reports\/(trial-balance|profit-loss|balance-sheet|ratio-analysis)/, perm: 'canViewFinancials' },
  { m: 'DELETE', re: /^\/api\/vouchers\/\d+/, perm: 'canDeleteVouchers' },
  { m: 'POST', re: /^\/api\/vouchers\/?$/, perm: 'canCreateVouchers', checkVoucherType: true },
  { m: 'POST', re: /^\/api\/masters\//, perm: 'canCreateVouchers' },
  // Quotations can be converted into Sales invoices (a posting), so changing them needs the same permission as posting
  { re: /^\/api\/quotations(\/|$)/, m: 'POST', perm: 'canCreateVouchers' },
  { re: /^\/api\/quotations(\/|$)/, m: 'PUT', perm: 'canCreateVouchers' },
  { re: /^\/api\/quotations(\/|$)/, m: 'DELETE', perm: 'canCreateVouchers' },
  // The report centre holds sales analytics and receivable ageing
  { re: /^\/api\/report-center(\/|$)/, perm: 'canViewFinancials' },
  { m: 'POST', re: /^\/api\/reports\/bank-reconciliation\/clear/, perm: 'canCreateVouchers' }
  // anything else under /api: authenticated user is enough (reads, AI drafts, dashboard)
];

const KNOWN_VOUCHER_TYPES = ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note'];

function routeGuard(req, res, next) {
  if (!ENFORCE) return next();
  const url = req.originalUrl.split('?')[0];
  if (!url.startsWith('/api/') || url.startsWith('/api/platform/')) return next();
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC.some(([m, re]) => m === req.method && re.test(url))) return next();

  const user = identify(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please log in again.', code: 'AUTH_REQUIRED' });
  }

  if (user.pwc && !(req.method === 'POST' && /^\/api\/auth\/change-password\/?$/.test(url))) {
    return res.status(403).json({ success: false, error: 'You must choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED', must_change_password: true });
  }

  const rule = RULES.find((r) => (!r.m || r.m === req.method) && r.re.test(url));
  if (rule) {
    const perms = getRolePermissions(user.role);
    if (!perms[rule.perm]) {
      return res.status(403).json({ success: false, error: `Your role "${user.role}" is not permitted to perform this action.`, code: 'FORBIDDEN' });
    }
    if (rule.checkVoucherType) {
      const t = req.body && req.body.voucher_type;
      if (KNOWN_VOUCHER_TYPES.includes(t) && !(perms.allowedVoucherTypes || []).includes(t)) {
        return res.status(403).json({ success: false, error: `Your role "${user.role}" may not post ${t} vouchers.`, code: 'FORBIDDEN' });
      }
    }
  }
  req.user = user;
  next();
}

if (!ENFORCE) console.warn('[Security] RRE_ENFORCE_AUTH=0 — API authorisation is DISABLED.');

module.exports = { routeGuard, RULES, PUBLIC };

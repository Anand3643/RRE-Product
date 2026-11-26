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
const { identify, DEFAULT_OWNER } = require('./auth');
const { getRolePermissions } = require('./db');
const { moduleOf } = require('./identity');

// Login-free by default: direct Owner access without mandatory sessions. Set RRE_ENFORCE_AUTH=1 to enforce API login & role checks.
const ENFORCE = process.env.RRE_ENFORCE_AUTH === '1';

// Public: needed before login or harmless read-only status.
const PUBLIC = [
  ['GET', /^\/api\/auth\/mode\.js\/?$/],
  ['POST', /^\/api\/auth\/(login|register|google|forgot|reset|signup|verify-email|resend-verification)\/?$/],
  ['GET', /^\/api\/auth\/(config|reset\/validate)\/?$/],
  ['GET', /^\/api\/auth\/permissions\/?$/],
  ['GET', /^\/api\/auth\/setup-status\/?$/],
  ['POST', /^\/api\/auth\/setup\/?$/],
  ['POST', /^\/api\/auth\/guest\/?$/],
  ['POST', /^\/api\/auth\/auto\/?$/], // answers only when RRE_SKIP_LOGIN=1 and the request comes from this computer
  ['GET', /^\/api\/health\/?$/],
  ['GET', /^\/api\/gateway\/info\/?$/],
  ['GET', /^\/api\/settings(\/storage)?\/?$/],
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
  { m: 'POST', re: /^\/api\/vouchers\/\d+\/reverse\/?$/, perm: 'canEditVouchers' }, // correcting posted books
  { m: 'PUT', re: /^\/api\/vouchers\/\d+\/?$/, perm: 'canEditVouchers', checkVoucherType: true }, // altering a posted voucher
  { m: 'PUT', re: /^\/api\/vouchers\/settings\//, perm: 'canManageUsers' },          // company accounting settings: administrators
  { m: 'POST', re: /^\/api\/vouchers\/?$/, perm: 'canCreateVouchers', checkVoucherType: true },
  { m: 'POST', re: /^\/api\/masters\//, perm: 'canCreateVouchers' },
  { m: 'PUT', re: /^\/api\/masters\/ledgers\/\d+\/?$/, perm: 'canEditVouchers' }, // ledger alteration (group, opening balance ...) changes the books
  // Quotations can be converted into Sales invoices (a posting), so changing them needs the same permission as posting
  { re: /^\/api\/quotations(\/|$)/, m: 'POST', perm: 'canCreateVouchers' },
  { re: /^\/api\/quotations(\/|$)/, m: 'PUT', perm: 'canCreateVouchers' },
  { re: /^\/api\/quotations(\/|$)/, m: 'DELETE', perm: 'canCreateVouchers' },
  // The report centre holds sales analytics and receivable ageing
  { re: /^\/api\/report-center(\/|$)/, perm: 'canViewFinancials' },
  { m: 'POST', re: /^\/api\/reports\/bank-reconciliation\/clear/, perm: 'canCreateVouchers' }
  // anything else under /api: authenticated user is enough (reads, AI drafts, dashboard)
];

// Administration of the application as a whole (people, companies, updates, backups, the sidecar inventory): never for a customer
const ADMIN_ONLY = [/^\/api\/auth\/(users|login-activity|migration|guest-access|modules|audit-log)/, /^\/api\/companies/, /^\/api\/system\//, /^\/api\/backup\//, /^\/api\/portal(\/|$)/];

const KNOWN_VOUCHER_TYPES = ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note'];

function routeGuard(req, res, next) {
  const user = identify(req);
  if (user) req.user = user;
  else if (!ENFORCE) req.user = DEFAULT_OWNER;
  if (!ENFORCE) return next();
  const url = req.originalUrl.split('?')[0];
  if (!url.startsWith('/api/') || url.startsWith('/api/platform/')) return next();
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC.some(([m, re]) => m === req.method && re.test(url))) return next();

  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please log in again.', code: 'AUTH_REQUIRED' });
  }

  const OWN = (req.method === 'POST' && /^\/api\/auth\/(change-password|logout)\/?$/.test(url)) || (req.method === 'GET' && /^\/api\/auth\/me\/?$/.test(url));
  if (user.pwc && !OWN) {
    return res.status(403).json({ success: false, error: 'You must choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED', must_change_password: true });
  }

  // A customer with books of their own (everyone who signs up) uses the whole application, but only in THEIR company and never the administration of the
  // application itself. A customer who is only linked to one of the owner's customer accounts stays confined to /api/portal.
  if (user.role === 'Customer' && user.companyId && ADMIN_ONLY.some((re) => re.test(url)) && !OWN) {
    return res.status(403).json({ success: false, error: 'This is part of the administration of the application.', code: 'FORBIDDEN' });
  }
  if (user.role === 'Customer' && !user.companyId && !/^\/api\/portal(\/|$)/.test(url) && !OWN && !(req.method === 'PUT' && /^\/api\/auth\/me\/?$/.test(url))) {
    return res.status(403).json({ success: false, error: 'Customer portal accounts can only use the customer portal.', code: 'PORTAL_ONLY' });
  }

  // An employee whose administrator limited them to certain modules cannot use the others (administrators are never limited).
  if (Array.isArray(user.modules) && user.role !== 'Owner' && user.role !== 'Administrator') {
    const mod = moduleOf(url);
    if (mod && !user.modules.includes(mod)) return res.status(403).json({ success: false, error: 'Your account does not have access to this module. Ask your administrator.', code: 'MODULE_FORBIDDEN' });
  }

  // the list of companies: administrators, and employees the administrator has allowed (a customer never; see ADMIN_ONLY)
  if (/^\/api\/companies/.test(url) && !getRolePermissions(user.role).canManageUsers && !(user.role !== 'Customer' && (user.extras || []).includes('companies'))) {
    return res.status(403).json({ success: false, error: 'The list of companies is available to administrators, or to employees an administrator has allowed.', code: 'FORBIDDEN' });
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

if (!ENFORCE) console.log('[Access] Direct Owner access active (logins removed). Set RRE_ENFORCE_AUTH=1 to require login.');

module.exports = { routeGuard, RULES, PUBLIC };

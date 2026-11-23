const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const {
  initDb,
  get,
  all,
  closeDb,
  reopenDb,
  getDbPath,
  resetCleanCompany,
  loadDemoCompany,
  updateCompanyInfo,
  authenticateUser,
  registerUser,
  loginWithGoogle,
  isSetupRequired,
  setupAdmin,
  changePassword,
  guestAccessEnabled,
  setGuestAccess,
  startGuestSession,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getLoginAuditTrail,
  getRolePermissions
} = require('./core/db');
const {
  securityHeadersMiddleware,
  rateLimitLoginMiddleware,
  loginRateLimiter
} = require('./core/security');
const {
  createBackup,
  listBackups,
  restoreBackup,
  getBackupDir
} = require('./core/backupEngine');
const {
  parseVoucherPrompt,
  queryFinancialAgent,
  scanFinancialAnomalies,
  parseInvoiceDocument
} = require('./core/aiEngine');
const logger = require('./core/logger');
const { runMigrations } = require('./core/migrations');
const { activityCaptureMiddleware, logActivity } = require('./core/auth');
const { startScheduler } = require('./core/scheduler');
const { xmlEsc } = require('./core/xml');
const { routeGuard } = require('./core/routeGuard');

// Modular Routers
const dashboardRouter = require('./modules/dashboard/dashboardApi');
const mastersRouter = require('./modules/masters/mastersApi');
const vouchersRouter = require('./modules/vouchers/vouchersApi');
const reportsRouter = require('./modules/reports/reportsApi');
const tallyXmlGateway = require('./modules/gateway/tallyXmlGateway');
const platformRouter = require('./modules/platform/platformApi');
const gstRouter = require('./modules/gst/gstApi');
const bankRouter = require('./modules/bank/bankApi');
const inventoryRouter = require('./modules/inventory/inventoryApi');
const automationRouter = require('./modules/automation/automationApi');
const { recurringRouter, importRouter } = require('./modules/bulk/bulkApi');
const attachmentsRouter = require('./modules/attachments/attachmentsApi');
const trackingRouter = require('./modules/tracking/trackingApi');
const insightsRouter = require('./modules/insights/insightsApi');
const ocrRouter = require('./modules/ocr/ocrApi');
const companiesRouter = require('./modules/companies/companiesApi');
const orgRouter = require('./modules/org/orgApi');
const approvalsRouter = require('./modules/approvals/approvalsApi');
const yearEndRouter = require('./modules/yearend/yearEndApi');
const voiceRouter = require('./modules/voice/voiceApi');
const searchRouter = require('./modules/search/searchApi');
const invAppRouter = require('./modules/invapp/invApi');
const approvals = require('./core/approvals');
const orgTools = require('./core/orgTools');
const companies = require('./core/companies');
const { forLegacyParser } = require('./core/invoiceExtract');
const assistant = require('./core/assistant');
const { getRolePermissions: rolePerms } = require('./core/db');
const quotationsRouter = require('./modules/quotations/quotationsApi');
const { documentsRouter, reportCenterRouter } = require('./modules/documents/documentsApi');

const app = express();
const WEB_PORT = process.env.PORT || 4000;
const TALLY_PORT = process.env.TALLY_PORT || 9000;
const serverStartTime = Date.now();

// 1. HTTP Security Headers (Pillar 2 & 3)
app.use(securityHeadersMiddleware);

// 2. Loopback & Local Origin Lockdown (Pillar 7)
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') || origin.startsWith('file://')) {
      return callback(null, true);
    }
    return callback(new Error('CORS access blocked by RRE Entries local security policy.'));
  }
}));

// Raw body parser for Tally XML envelopes
app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('xml')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  } else {
    next();
  }
});

app.use(express.json({ limit: '10mb' })); // GSTR-2B / bank statement uploads exceed the 100kb default
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(logger.requestMiddleware);
app.use(companies.gate); // briefly refuses /api calls while the database is swapped during a company switch
app.use(routeGuard);
// Vouchers that trigger an approval rule are held for an approver instead of being posted
app.use(approvals.gate);
// A newly posted voucher is tagged with the poster's default branch/department (if they set one). The response waits for the tag
// so the voucher is never visible untagged; a tagging problem never blocks or fails the posting.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/vouchers' && req.user) {
    const original = res.json.bind(res);
    res.json = (body) => {
      if (body && body.success && body.id) orgTools.applyDefaults(req.user.username, body.id).catch(() => {}).finally(() => original(body));
      else original(body);
      return res;
    };
  }
  next();
}); // server-side authorisation (signed token + role permissions) for /api/*
app.use(activityCaptureMiddleware); // audit trail for mutating calls (additive, read-only on existing routers)

// ========================================================
// 1. HEALTH & SYSTEM MONITORING API (Pillars 6, 7 & 13)
// ========================================================
app.get('/api/health', async (req, res) => {
  try {
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

    let dbStatus = 'healthy';
    let dbSizeBytes = 0;
    let integrityCheck = 'unknown';

    try {
      const integrityRow = await get('PRAGMA integrity_check');
      integrityCheck = integrityRow ? Object.values(integrityRow)[0] : 'ok';
      if (fs.existsSync(getDbPath())) {
        dbSizeBytes = fs.statSync(getDbPath()).size;
      }
    } catch (e) {
      dbStatus = 'degraded';
    }

    const totalVouchers = await get('SELECT COUNT(*) as count FROM vouchers').catch(() => ({ count: 0 }));
    const totalLedgers = await get('SELECT COUNT(*) as count FROM ledgers').catch(() => ({ count: 0 }));
    const totalItems = await get('SELECT COUNT(*) as count FROM stock_items').catch(() => ({ count: 0 }));
    const totalUsers = await get('SELECT COUNT(*) as count FROM users WHERE status = "Active"').catch(() => ({ count: 0 }));

    const backups = listBackups();
    const mem = process.memoryUsage();

    res.json({
      status: (dbStatus === 'healthy' && integrityCheck === 'ok') ? 'healthy' : 'degraded',
      application: 'RRE Entries',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: uptimeSeconds,
        human: uptimeFormatted
      },
      system: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        memory: {
          rss_mb: (mem.rss / (1024 * 1024)).toFixed(2),
          heap_total_mb: (mem.heapTotal / (1024 * 1024)).toFixed(2),
          heap_used_mb: (mem.heapUsed / (1024 * 1024)).toFixed(2)
        }
      },
      database: {
        status: dbStatus,
        path: getDbPath(),
        size_bytes: dbSizeBytes,
        size_mb: (dbSizeBytes / (1024 * 1024)).toFixed(2),
        journal_mode: 'wal',
        integrity: integrityCheck
      },
      telemetry: {
        total_vouchers: totalVouchers.count || 0,
        total_ledgers: totalLedgers.count || 0,
        total_items: totalItems.count || 0,
        active_users: totalUsers.count || 0
      },
      disaster_recovery: {
        total_backups: backups.length,
        latest_backup: backups[0] || null
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/api/system/logs', (req, res) => {
  try {
    const limit = Math.min(250, parseInt(req.query.limit || 50, 10));
    res.json({
      success: true,
      count: logger.getRecentLogs(limit).length,
      data: logger.getRecentLogs(limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// 2. DISASTER RECOVERY & BACKUP API (Pillars 4, 5 & 12)
// ========================================================
app.get('/api/backup/list', (req, res) => {
  try {
    const list = listBackups();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backup/create', async (req, res) => {
  try {
    const { notes, encrypt, password } = req.body || {};
    const totalVouchers = await get('SELECT COUNT(*) as count FROM vouchers').catch(() => ({ count: 0 }));
    const totalLedgers = await get('SELECT COUNT(*) as count FROM ledgers').catch(() => ({ count: 0 }));

    const result = await createBackup({
      notes: notes || 'Manual On-Demand Snapshot',
      encrypt: Boolean(encrypt),
      password: password || undefined,
      metadata: {
        vouchers: totalVouchers.count || 0,
        ledgers: totalLedgers.count || 0
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backup/restore', async (req, res) => {
  try {
    const { filename, password } = req.body || {};
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Filename of the backup is required.' });
    }

    const result = await restoreBackup(filename, {
      password,
      beforeRestoreHook: async () => {
        await closeDb();
      },
      afterRestoreHook: async () => {
        await reopenDb();
        await initDb();
        await runMigrations();
      }
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/backup/download/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(getBackupDir(), safeFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Backup file not found.' });
    }
    res.download(filePath, safeFilename);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gateway & Company Meta Info
app.get('/api/gateway/info', async (req, res) => {
  try {
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    const lastVoucher = await get('SELECT date, voucher_no, voucher_type FROM vouchers ORDER BY date DESC, id DESC LIMIT 1');
    const totalVouchers = await get('SELECT COUNT(*) as count FROM vouchers');
    const totalLedgers = await get('SELECT COUNT(*) as count FROM ledgers');
    const totalItems = await get('SELECT COUNT(*) as count FROM stock_items');

    res.json({
      success: true,
      data: {
        company: comp || { name: 'RRE Entries', gstin: '', state: 'Tamil Nadu', state_code: '33' },
        current_date: lastVoucher ? lastVoucher.date : '2026-06-01',
        financial_year: '1-Apr-2026 to 31-Mar-2027',
        last_voucher: lastVoucher || null,
        total_vouchers: totalVouchers.count || 0,
        total_ledgers: totalLedgers.count || 0,
        total_items: totalItems.count || 0,
        is_clean_slate: (totalVouchers.count === 0 && totalItems.count === 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Company Management & Clean Slate Routes
app.post('/api/company/clean-slate', async (req, res) => {
  try {
    const result = await resetCleanCompany();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/company/load-demo', async (req, res) => {
  try {
    const result = await loadDemoCompany();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/company/update', async (req, res) => {
  try {
    const result = await updateCompanyInfo(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// TALLY SECURITY CONTROL & MULTI-USER API
// ========================================================

app.post('/api/auth/login', rateLimitLoginMiddleware, async (req, res) => {
  const clientMeta = {
    ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
    agent: req.headers['user-agent'] || 'TallyClient'
  };

  try {
    const { username, password } = req.body;
    const result = await authenticateUser(username, password, clientMeta);
    if (!result.success) {
      loginRateLimiter.recordFailure(clientMeta.ip);
      return res.status(401).json(result);
    }

    loginRateLimiter.recordSuccess(clientMeta.ip);
    res.json(result);
  } catch (err) {
    loginRateLimiter.recordFailure(clientMeta.ip);
    res.status(500).json({ success: false, error: err.message });
  }
});

// First-time setup: the person installing the application chooses the administrator password. Only possible on this computer,
// and only while no administrator password has been set. There are no default credentials.
app.get('/api/auth/setup-status', async (req, res) => {
  try { res.json({ success: true, data: { setup_required: await isSetupRequired(), guest_access: await guestAccessEnabled() } }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/auth/setup', rateLimitLoginMiddleware, async (req, res) => {
  const ip = req.socket && req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).json({ success: false, error: 'First-time setup can only be completed on the computer where RRE Entries is installed.' });
  }
  const clientMeta = { ip, agent: req.headers['user-agent'] || 'TallyClient' };
  try {
    const result = await setupAdmin(String((req.body && req.body.password) || ''), clientMeta);
    loginRateLimiter.recordSuccess(clientMeta.ip);
    res.json(result);
  } catch (err) {
    loginRateLimiter.recordFailure(clientMeta.ip);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// One-click read-only guest entry (no password). The Owner can switch it off. Only requests from this computer are accepted
// unless RRE_ALLOW_REMOTE_GUEST=1 is set, so a copy of the application reachable over a network never opens itself to strangers.
app.post('/api/auth/guest', rateLimitLoginMiddleware, async (req, res) => {
  const ip = req.socket && req.socket.remoteAddress;
  if (process.env.RRE_ALLOW_REMOTE_GUEST !== '1' && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).json({ success: false, error: 'Guest entry is only available on the computer where RRE Entries is installed.' });
  }
  try {
    const result = await startGuestSession({ ip, agent: req.headers['user-agent'] || 'TallyClient' });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/guest-access', async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled === true);
    const r = await setGuestAccess(enabled);
    await logActivity({ user: req.user, action: enabled ? 'GUEST_ACCESS_ON' : 'GUEST_ACCESS_OFF', entity: 'settings', entityId: 'guest_access' });
    res.json({ success: true, data: r });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// A signed-in person changes their own password. This is the only route open to someone who must change it first.
app.post('/api/auth/change-password', rateLimitLoginMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required. Please log in again.', code: 'AUTH_REQUIRED' });
  const clientMeta = { ip: req.ip || req.connection?.remoteAddress || '127.0.0.1', agent: req.headers['user-agent'] || 'TallyClient' };
  try {
    const b = req.body || {};
    const result = await changePassword(req.user.userId, String(b.current_password || ''), String(b.new_password || ''), clientMeta);
    loginRateLimiter.recordSuccess(clientMeta.ip);
    res.json(result);
  } catch (err) {
    loginRateLimiter.recordFailure(clientMeta.ip);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// Create / Register Account via Email
app.post('/api/auth/register', rateLimitLoginMiddleware, async (req, res) => {
  const clientMeta = {
    ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
    agent: req.headers['user-agent'] || 'TallyClient'
  };

  try {
    const result = await registerUser(req.body, clientMeta);
    loginRateLimiter.recordSuccess(clientMeta.ip);
    res.json(result);
  } catch (err) {
    loginRateLimiter.recordFailure(clientMeta.ip);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// Authenticate / Register via Google Account
app.post('/api/auth/google', rateLimitLoginMiddleware, async (req, res) => {
  const clientMeta = {
    ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
    agent: req.headers['user-agent'] || 'GoogleAuthClient'
  };

  try {
    const result = await loginWithGoogle(req.body, clientMeta);
    loginRateLimiter.recordSuccess(clientMeta.ip);
    res.json(result);
  } catch (err) {
    loginRateLimiter.recordFailure(clientMeta.ip);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/users', async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/users', async (req, res) => {
  try {
    const result = await createUser(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/auth/users/:id', async (req, res) => {
  try {
    const result = await updateUser(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/auth/users/:id', async (req, res) => {
  try {
    const result = await deleteUser(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/audit-log', async (req, res) => {
  try {
    const logs = await getLoginAuditTrail(req.query.limit ? parseInt(req.query.limit) : 50);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/permissions', (req, res) => {
  const role = req.query.role || 'Data Entry';
  res.json({ success: true, data: getRolePermissions(role) });
});

// 2. Mount Modular Subsystems
app.use('/api/dashboard', dashboardRouter);
app.use('/api/masters', mastersRouter);
app.use('/api/vouchers', vouchersRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/portal', require('./modules/portal/portalApi')); // new: customer portal (a customer sees only their own orders and invoices)
app.use('/api/inventory-app', require('./modules/inventoryhost/inventoryHostApi')); // new: opens the ORIGINAL inventory application (React UI + FastAPI) running beside RRE
app.use('/api/inv', invAppRouter); // new: inventory suite (items, warehouses, stock, transfers, adjustments)
app.use('/api/search', searchRouter); // new: smart search and quick look (read-only)
app.use('/api/voice', voiceRouter); // new: multilingual voice assistant (understanding, replies, consent)
app.use('/api/yearend', yearEndRouter); // new: read-only year-end readiness, snapshot and opening-balance pack
app.use('/api/approvals', approvalsRouter); // new: approval rules and held vouchers
app.use('/api/org', orgRouter); // new: branches, departments, budgets, credit limits, supplier performance
app.use('/api/companies', companiesRouter); // new: list / create / switch companies
app.use('/api/ocr', ocrRouter); // new: offline invoice scanning (OCR) -> reviewed draft
app.use('/api/insights', insightsRouter); // new: assistant, forecasts, trends, health score, daily summary
app.use('/api/tracking', trackingRouter); // new: batch / expiry / serial tracking, barcode lookup
app.use('/api/attachments', attachmentsRouter); // new: documents attached to vouchers (stored in the company DB)
app.use('/api/recurring', recurringRouter); // new: recurring voucher drafts (human-confirmed)
app.use('/api/import', importRouter); // new: previewed, all-or-nothing CSV voucher import
app.use('/api/automation', automationRouter); // new: duplicates, suggestions, unusual transactions, reminders
app.use('/api/inventory', inventoryRouter); // new: reorder, demand, dead stock, godown, supplier prices
app.use('/api/bank', bankRouter); // new: statement import, smart reconciliation
app.use('/api/gst', gstRouter); // new: GSTIN/HSN validation, tax checks, GSTR-2B reconciliation
app.use('/api/platform', platformRouter); // new: notifications, search, export, activity log, backup verify
app.use('/api/quotations', quotationsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/report-center', reportCenterRouter);

// 3. Tally XML Protocol (for external connectors and ERP bridges)
app.use('/', tallyXmlGateway);

// 4. Tally XML Export Download
app.get('/api/export/tally-xml', async (req, res) => {
  try {
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    const ledgers = await all('SELECT l.*, g.name as group_name FROM ledgers l JOIN account_groups g ON l.group_id = g.id');
    const vouchers = await all('SELECT * FROM vouchers ORDER BY date ASC');

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters and Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <COMPANY>
            <NAME>${xmlEsc(comp.name)}</NAME>
            <GSTIN>${xmlEsc(comp.gstin)}</GSTIN>
          </COMPANY>
`;

    for (const l of ledgers) {
      xml += `          <LEDGER NAME="${xmlEsc(l.name)}">
            <PARENT>${xmlEsc(l.group_name)}</PARENT>
            <OPENINGBALANCE>${l.opening_balance_type === 'Cr' ? '-' : ''}${xmlEsc(l.opening_balance)}</OPENINGBALANCE>
            <GSTIN>${xmlEsc(l.gstin || '')}</GSTIN>
          </LEDGER>
`;
    }

    for (const v of vouchers) {
      const entries = await all('SELECT e.*, l.name as ledger_name FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id WHERE e.voucher_id = ?', [v.id]);
      xml += `          <VOUCHER VCHTYPE="${xmlEsc(v.voucher_type)}">
            <DATE>${xmlEsc(v.date.replace(/-/g, ''))}</DATE>
            <VOUCHERNUMBER>${xmlEsc(v.voucher_no)}</VOUCHERNUMBER>
            <NARRATION>${xmlEsc(v.narration || '')}</NARRATION>
`;
      for (const e of entries) {
        xml += `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEsc(e.ledger_name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${e.entry_type === 'Dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${e.entry_type === 'Dr' ? '-' : ''}${xmlEsc(e.debit_amount || e.credit_amount)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
`;
      }
      xml += `          </VOUCHER>
`;
    }

    xml += `        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    res.setHeader('Content-Type', 'text/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="RRE_Entries_Backup.xml"');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// RRE AI COPILOT & FINANCIAL AGENT API
// ========================================================
app.post('/api/ai/parse-voucher', async (req, res) => {
  try {
    const result = await parseVoucherPrompt(req.body.prompt);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/ai/query', async (req, res) => {
  try {
    // Richer, data-backed answers first (sales, profit, top products, expense drivers, forecasts, health score...).
    // Anything it does not recognise falls through to the original assistant below, unchanged.
    const smart = await assistant.ask(req.body && req.body.query, { perms: rolePerms((req.user || {}).role) });
    if (smart) return res.json({ success: true, data: { answer: smart.answer, data: smart } });
    const result = await queryFinancialAgent(req.body.query);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/ai/insights', async (req, res) => {
  try {
    const result = await scanFinancialAnomalies();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai/parse-document', async (req, res) => {
  try {
    // Better field extraction first (supplier GSTIN, invoice no., date, taxes, total, ledger matching, duplicate check).
    // If the text has no usable total it falls through to the original parser, unchanged.
    const smart = await forLegacyParser(req.body && req.body.text);
    if (smart) return res.json(smart);
    const result = await parseInvoiceDocument(req.body.text);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ========================================================
// SYSTEM UPDATE & VERSION MANAGEMENT API
// ========================================================
app.get('/api/system/update-status', async (req, res) => {
  let buildInfo = { version: '1.0.0', commit: 'd2fa68d' };
  try {
    const bPath = path.join(__dirname, 'build-info.json');
    if (fs.existsSync(bPath)) {
      buildInfo = JSON.parse(fs.readFileSync(bPath, 'utf8'));
    }
  } catch (e) {}

  const currentVersion = buildInfo.version || '1.0.0';
  let currentCommit = buildInfo.commit || 'd2fa68d';
  let hasGit = false;

  try {
    const isGit = fs.existsSync(path.join(__dirname, '.git')) || fs.existsSync(path.join(process.cwd(), '.git'));
    if (isGit) {
      const { stdout } = await execPromise('git rev-parse --short HEAD', { timeout: 3000 });
      if (stdout && stdout.trim()) {
        currentCommit = stdout.trim();
        hasGit = true;
      }
    }
  } catch (e) {
    // git CLI may not be available in packaged mode
  }

  // Check network connectivity and query GitHub commits API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    const ghRes = await fetch('https://api.github.com/repos/Anand3643/RRE-Product/commits/main', {
      headers: { 'User-Agent': 'RRE-Entries-Desktop' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!ghRes.ok) {
      return res.json({
        success: true,
        is_online: false,
        current_version: currentVersion,
        current_commit: currentCommit,
        update_available: false,
        message: 'Could not contact update server. 100% offline mode active.'
      });
    }

    const commitData = await ghRes.json();
    const remoteSha = (commitData.sha || '').slice(0, 7);
    const remoteMessage = commitData.commit ? commitData.commit.message : '';
    const remoteDate = commitData.commit && commitData.commit.author ? commitData.commit.author.date : '';

    const isParentBuildInfo = Boolean(commitData.parents && commitData.parents.some(p => (p.sha || '').slice(0, 7) === currentCommit && /build-info/i.test(remoteMessage)));
    const updateAvailable = Boolean(remoteSha && remoteSha !== currentCommit && !isParentBuildInfo);

    return res.json({
      success: true,
      is_online: true,
      current_version: currentVersion,
      current_commit: currentCommit,
      remote_commit: remoteSha,
      remote_message: remoteMessage,
      remote_date: remoteDate,
      update_available: updateAvailable,
      can_auto_update: hasGit,
      message: updateAvailable
        ? `New version available: ${remoteSha} - "${remoteMessage.split('\n')[0]}"`
        : 'Your RRE Entries installation is completely up to date!'
    });
  } catch (err) {
    // Offline mode
    return res.json({
      success: true,
      is_online: false,
      current_version: currentVersion,
      current_commit: currentCommit,
      update_available: false,
      message: 'PC is offline or unable to connect to update server. 100% offline mode active.'
    });
  }
});

app.post('/api/system/perform-update', async (req, res) => {
  const isGitRepo = fs.existsSync(path.join(__dirname, '.git')) || fs.existsSync(path.join(process.cwd(), '.git'));

  if (isGitRepo) {
    try {
      const { stdout: pullOut } = await execPromise('git pull origin main', { timeout: 45000 });
      console.log('[System Update] git pull result:', pullOut);

      // Trigger silent rebuild and installation in background
      exec('npm run build:win && powershell -Command "Start-Process dist\\\"RRE Entries Setup 1.0.0.exe\\\" -ArgumentList \\\"/S\\\" -Wait"', (err) => {
        if (err) console.warn('[System Update] Background installer warning:', err.message);
        else console.log('[System Update] Successfully rebuilt and updated desktop app on PC!');
      });

      return res.json({
        success: true,
        message: 'Successfully updated application files from GitHub! The PC installation is being refreshed.',
        details: pullOut
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `Git repository update error: ${err.message}`
      });
    }
  }

  // Packaged / Installed Mode (No .git folder)
  // Check if setup installer exists locally or provide direct installer download
  const possibleSetupPaths = [
    path.join(__dirname, 'dist', 'RRE Entries Setup 1.0.0.exe'),
    path.join(__dirname, '..', 'dist', 'RRE Entries Setup 1.0.0.exe'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', 'Desktop', 'RRE PRoduct', 'dist', 'RRE Entries Setup 1.0.0.exe'),
    path.join(__dirname, 'dist', 'RRE Tally Setup 1.0.0.exe')
  ];

  const foundInstaller = possibleSetupPaths.find(p => fs.existsSync(p));

  if (foundInstaller) {
    exec(`powershell -Command "Start-Process '${foundInstaller}' -ArgumentList '/S' -Wait"`, (err) => {
      if (err) console.warn('[System Update] Installer launch notice:', err.message);
    });

    return res.json({
      success: true,
      message: 'Latest RRE Entries Setup installer found and launched. Your installation is being updated in the background without affecting your accounting data.'
    });
  }

  // For remote client PCs without a local installer
  return res.json({
    success: true,
    requires_download: true,
    download_url: 'https://github.com/Anand3643/RRE-Product',
    message: 'To install the latest release on this PC, please run the setup installer RRE Entries Setup 1.0.0.exe. All your company accounting data in company.db remains 100% intact.'
  });
});

// SPA Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Master Server Startup with Dynamic Port & Guaranteed Loopback Binding
let startServerPromise = null;

function startServer(preferredPort = WEB_PORT, preferredHost = '127.0.0.1') {
  if (startServerPromise) return startServerPromise;

  startServerPromise = new Promise(async (resolve) => {
    try {
      await initDb();
      await runMigrations();
      startScheduler();
    } catch (err) {
      console.error('[Tally Core DB] Database warning during startup:', err.message);
    }

    const host = process.env.HOST || preferredHost;
    let basePort = parseInt(process.env.PORT || preferredPort, 10);

    const tryBind = (portToTry) => {
      const server = http.createServer(app);
      // Keep-alive timeouts to prevent idle connection drop / Failed to fetch
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 66000;

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[Tally Web Server] Port ${portToTry} in use. Attempting next available port...`);
          if (portToTry < basePort + 10) {
            tryBind(portToTry + 1);
          } else {
            console.log(`[Tally Web Server] Assuming existing Tally instance active on port ${basePort}.`);
            resolve({ port: basePort, host, existing: true });
          }
        } else {
          console.error('[Tally Web Server] Server error:', err.message);
          resolve({ port: portToTry, host, error: err.message });
        }
      });

      server.listen(portToTry, host, () => {
        console.log(`=======================================================`);
        console.log(`✨ RRE Entries (V5 Edition) Running!`);
        console.log(`👉 Web Interface: http://${host}:${portToTry}`);
        console.log(`📂 Data Storage: data/100000/company.db (Local PC SQLite)`);
        console.log(`⚡ Offline Mode: 100% Standalone (No Internet Required)`);
        console.log(`=======================================================`);
        try { require('./core/invBridge').startAuto(); } catch (e) { console.warn('[Inventory bridge] not started:', e.message); } // posts the original inventory app's purchases and sales to the books

        // Start secondary Tally XML / ODBC server on loopback
        try {
          const xmlServer = http.createServer((req, res) => app(req, res));
          xmlServer.keepAliveTimeout = 65000;
          xmlServer.headersTimeout = 66000;
          xmlServer.listen(TALLY_PORT, host, () => {
            console.log(`⚡ Tally Native XML Gateway Active on ${host}:${TALLY_PORT}`);
          }).on('error', (xErr) => {
            console.warn(`[Tally Native Gateway] Port ${TALLY_PORT} notice:`, xErr.message);
          });
        } catch (xErr) {
          console.warn('[Tally Native Gateway] Could not bind XML port:', xErr.message);
        }

        resolve({ port: portToTry, host, server });
      });
    };

    tryBind(basePort);
  });

  return startServerPromise;
}

// Auto-start if invoked directly via `node server.js`
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer
};

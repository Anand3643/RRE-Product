const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const {
  initDb,
  get,
  all,
  resetCleanCompany,
  loadDemoCompany,
  updateCompanyInfo,
  authenticateUser,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getLoginAuditTrail,
  getRolePermissions
} = require('./core/db');

// Modular Routers
const dashboardRouter = require('./modules/dashboard/dashboardApi');
const mastersRouter = require('./modules/masters/mastersApi');
const vouchersRouter = require('./modules/vouchers/vouchersApi');
const reportsRouter = require('./modules/reports/reportsApi');
const tallyXmlGateway = require('./modules/gateway/tallyXmlGateway');

const app = express();
const WEB_PORT = process.env.PORT || 4000;
const TALLY_PORT = process.env.TALLY_PORT || 9000;

app.use(cors());

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Gateway & Company Meta Info
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
        company: comp || { name: 'Ramraj Enterprises', gstin: '33ANUPS7331M1Z8', state: 'Tamil Nadu', state_code: '33' },
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const clientMeta = {
      ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
      agent: req.headers['user-agent'] || 'TallyClient'
    };
    const result = await authenticateUser(username, password, clientMeta);
    if (!result.success) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
            <NAME>${comp.name}</NAME>
            <GSTIN>${comp.gstin}</GSTIN>
          </COMPANY>
`;

    for (const l of ledgers) {
      xml += `          <LEDGER NAME="${l.name}">
            <PARENT>${l.group_name}</PARENT>
            <OPENINGBALANCE>${l.opening_balance_type === 'Cr' ? '-' : ''}${l.opening_balance}</OPENINGBALANCE>
            <GSTIN>${l.gstin || ''}</GSTIN>
          </LEDGER>
`;
    }

    for (const v of vouchers) {
      const entries = await all('SELECT e.*, l.name as ledger_name FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id WHERE e.voucher_id = ?', [v.id]);
      xml += `          <VOUCHER VCHTYPE="${v.voucher_type}">
            <DATE>${v.date.replace(/-/g, '')}</DATE>
            <VOUCHERNUMBER>${v.voucher_no}</VOUCHERNUMBER>
            <NARRATION>${v.narration || ''}</NARRATION>
`;
      for (const e of entries) {
        xml += `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${e.ledger_name}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${e.entry_type === 'Dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${e.entry_type === 'Dr' ? '-' : ''}${e.debit_amount || e.credit_amount}</AMOUNT>
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
    res.setHeader('Content-Disposition', 'attachment; filename="TallyPrime_Backup.xml"');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// SYSTEM UPDATE & VERSION MANAGEMENT API
// ========================================================
app.get('/api/system/update-status', async (req, res) => {
  const currentVersion = '1.0.0';
  let currentCommit = '03810f9';
  let hasGit = false;

  try {
    const { stdout } = await execPromise('git rev-parse --short HEAD', { timeout: 3000 });
    if (stdout && stdout.trim()) {
      currentCommit = stdout.trim();
      hasGit = true;
    }
  } catch (e) {
    // git CLI may not be available in packaged mode
  }

  // Check network connectivity and query GitHub commits API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    const ghRes = await fetch('https://api.github.com/repos/Anand3643/RRE-Product/commits/main', {
      headers: { 'User-Agent': 'TallyPrime-Gold-Desktop' },
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

    const updateAvailable = Boolean(remoteSha && remoteSha !== currentCommit);

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
        : 'Your TallyPrime Gold installation is completely up to date!'
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
  try {
    const { stdout: pullOut } = await execPromise('git pull origin main', { timeout: 45000 });
    console.log('[System Update] git pull result:', pullOut);

    // Trigger silent rebuild and installation in background
    exec('npm run build:win && powershell -Command "Start-Process dist\\\"TallyPrime Gold Setup 1.0.0.exe\\\" -ArgumentList \\\"/S\\\" -Wait"', (err) => {
      if (err) console.warn('[System Update] Background installer warning:', err.message);
      else console.log('[System Update] Successfully rebuilt and updated desktop app on PC!');
    });

    res.json({
      success: true,
      message: 'Successfully updated application files from GitHub! The PC installation is being refreshed.',
      details: pullOut
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Update error: ${err.message}`
    });
  }
});

// SPA Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Master Server Startup
async function startServer() {
  try {
    await initDb();

    // 1. Primary Web Application Server on Port 4000
    const webServer = app.listen(WEB_PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(`✨ TallyPrime Gold (V5 Edition) Running!`);
      console.log(`👉 Web Interface: http://localhost:${WEB_PORT} (http://127.0.0.1:${WEB_PORT})`);
      console.log(`📂 Data Storage: data/100000/company.db (Local PC SQLite)`);
      console.log(`⚡ Offline Mode: 100% Standalone (No Internet Required)`);
      console.log(`=======================================================`);
    });

    webServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Tally Web Server] Port ${WEB_PORT} already running — connected to active local backend.`);
      } else {
        console.error('[Tally Web Server] Server error:', err.message);
      }
    });

    // 2. Secondary Tally XML/ODBC Protocol Server on Port 9000
    const xmlServer = http.createServer((req, res) => {
      app(req, res);
    });

    xmlServer.listen(TALLY_PORT, '0.0.0.0', () => {
      console.log(`⚡ Tally Native XML Gateway Active on Port ${TALLY_PORT} (ServerPort=9000)`);
    }).on('error', (err) => {
      console.warn(`[Tally Native Gateway] Port ${TALLY_PORT} busy or restricted:`, err.message);
    });

  } catch (err) {
    console.error('Failed to initialize local Tally database:', err.message);
  }
}

startServer();

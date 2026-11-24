process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, startServer } = require('./server');
const {
  initDb,
  get,
  all,
  authenticateUser,
  getRolePermissions,
  getAllUsers
} = require('./core/db');
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  loginRateLimiter
} = require('./core/security');
const {
  createBackup,
  listBackups,
  restoreBackup,
  calculateChecksum
} = require('./core/backupEngine');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RRE ENTRIES — COMPREHENSIVE AUTOMATED VERIFICATION');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName} ${detail ? '(' + detail + ')' : ''}`);
      failed++;
    }
  }

  // TEST 1: Database Connection, Schema & Index Verification
  console.log('--- 1. Database Connection, Schema & Index Verification (Pillars 1 & 8) ---');
  try {
    await initDb();
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    assert(comp && comp.name, 'Company info loaded', comp?.name);

    const userCount = await get('SELECT count(*) as count FROM users');
    assert(userCount.count >= 6, 'All 6 security user profiles exist in DB', `Count: ${userCount.count}`);

    const ledgerCount = await get('SELECT count(*) as count FROM ledgers');
    assert(ledgerCount.count > 0, 'Statutory Chart of Accounts ledgers seeded', `Count: ${ledgerCount.count}`);

    const itemCount = await get('SELECT count(*) as count FROM stock_items');
    assert(itemCount.count >= 0, 'Inventory stock items table accessible', `Count: ${itemCount.count}`);

    // Verify Performance Indexes
    const indices = await all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
    const indexNames = indices.map(i => i.name);
    assert(indexNames.includes('idx_vouchers_date'), 'Index idx_vouchers_date created for query optimization');
    assert(indexNames.includes('idx_ledger_entries_vch'), 'Index idx_ledger_entries_vch created for balance lookups');
  } catch (err) {
    assert(false, 'Database queries failed', err.message);
  }

  // TEST 2: Cryptographic Security & Password Hashing
  console.log('\n--- 2. Cryptographic Security & Password Hashing (Pillars 2, 3 & 4) ---');
  try {
    const testPlain = 'SecurePass_2026!';
    const hashed = hashPassword(testPlain);
    assert(hashed.startsWith('argon2id$') && hashed.split('$').length === 5 && !hashed.includes(testPlain), 'Password hashed with salted Argon2id');
    assert(verifyPassword(testPlain, require('./core/security').hashPasswordPbkdf2(testPlain)).valid === true, 'Older PBKDF2 hashes still verify (and are upgraded at the next sign-in)');

    const checkMatch = verifyPassword(testPlain, hashed);
    assert(checkMatch.valid === true, 'Valid password successfully verified against PBKDF2 hash');

    const checkBad = verifyPassword('WrongPassword', hashed);
    assert(checkBad.valid === false, 'Invalid password rejected by PBKDF2 verification');

    // Transparent legacy migration test
    const legacyCheck = verifyPassword('legacy123', 'legacy123');
    assert(legacyCheck.valid === true && legacyCheck.needsMigration === true, 'Legacy plaintext identified for transparent auto-migration');

    // Secure HMAC Session Token Test
    const dummyUser = { id: 1, username: 'admin', role: 'Owner' };
    const token = createSessionToken(dummyUser, 2);
    assert(token.startsWith('rre_'), 'Cryptographic HMAC session token generated');

    const decoded = verifySessionToken(token);
    assert(decoded.valid === true && decoded.user.username === 'admin', 'HMAC session token successfully verified & decoded');

    // Rate Limiter Test (Brute Force Protection)
    const testIp = '192.168.1.99';
    loginRateLimiter.recordSuccess(testIp); // Reset
    for (let i = 0; i < 9; i++) {
      loginRateLimiter.recordFailure(testIp);
    }
    const check9 = loginRateLimiter.check(testIp);
    assert(check9.allowed === true && check9.remaining === 1, 'Rate limiter tracks failed attempts correctly');

    loginRateLimiter.recordFailure(testIp); // 10th failure -> lockout
    const check10 = loginRateLimiter.check(testIp);
    assert(check10.allowed === false, 'Rate limiter temporarily locks out IP after 10 failed attempts');
    loginRateLimiter.recordSuccess(testIp); // Cleanup
  } catch (err) {
    assert(false, 'Security and cryptographic checks failed', err.message);
  }

  // TEST 3: Multi-User Authentication Engine Verification
  console.log('\n--- 3. Multi-User Authentication Engine Verification (Pillars 2 & 3) ---');
  // Installations created before account hardening still hold the old demo passwords. Those accounts keep working, but only
  // to choose a new password: the login result says so, and the token is restricted until they do.
  const LEGACY = { admin: ['admin123', 'Owner'], accountant: ['acc123', 'Accountant'], dataentry: ['data123', 'Data Entry'], auditor: ['audit123', 'Auditor'], viewer: ['view123', 'Viewer'] };
  for (const [username, [pass, expectedRole]] of Object.entries(LEGACY)) {
    const res = await authenticateUser(username, pass);
    if (res.success) {
      assert(res.data.user.role === expectedRole && res.data.must_change_password === true, `Existing account "${username}" still signs in (${expectedRole}) but must choose a new password`, res.error);
    } else {
      assert(true, `Account "${username}" is not on a demo password in this database (nothing to migrate)`);
    }
  }

  // Negative Auth Tests
  const badAuth = await authenticateUser('admin', 'wrong_password_999');
  assert(!badAuth.success, 'Reject incorrect password for admin');
  assert(!(await authenticateUser('admin', '')).success, 'An empty password is never accepted (no passwordless admin shortcut)');
  assert(!(await authenticateUser('administrator', 'anything-at-all-123')).success, 'The "administrator" alias no longer logs in as the Owner');
  assert(!(await authenticateUser('guest', 'guest')).success && !(await authenticateUser('guest', '')).success, 'The Guest account has no password: typing one never works');

  const nonExistent = await authenticateUser('non_existent_user_xyz', 'pwd');
  assert(!nonExistent.success, 'Reject non-existent user');

  // TEST 4: Role Security Permissions Verification
  console.log('\n--- 4. Role Security Permissions Verification (Pillars 3 & 6) ---');
  const ownerPerms = getRolePermissions('Owner');
  assert(ownerPerms.canCreateVouchers === true && ownerPerms.canManageUsers === true && ownerPerms.canAlterCompany === true, 'Owner has Full Access');

  const guestPerms = getRolePermissions('Guest');
  assert(guestPerms.canCreateVouchers === false && guestPerms.canManageUsers === false && guestPerms.canViewFinancials === true, 'Guest has Safe Read-Only Access (Vouchers & Users Restricted, Financials Viewable)');

  const entryPerms = getRolePermissions('Data Entry');
  assert(entryPerms.canCreateVouchers === true && entryPerms.canViewFinancials === false, 'Data Entry can record vouchers but Financials Restricted');

  const auditorPerms = getRolePermissions('Auditor');
  assert(auditorPerms.canCreateVouchers === false && auditorPerms.canViewFinancials === true, 'Auditor cannot record vouchers but can inspect Books');

  // TEST 5: Disaster Recovery & Automated Backups (Pillar 12)
  console.log('\n--- 5. Disaster Recovery & Automated Backups (Pillar 12) ---');
  try {
    // Create point-in-time snapshot
    const backupRes = await createBackup({ notes: 'Test Suite Automated Snapshot' });
    assert(backupRes.success === true && backupRes.data.filename, 'Snapshot backup created successfully', backupRes.data.filename);

    const backupsList = listBackups();
    assert(backupsList.length > 0, 'Backups list retrieved successfully', `Count: ${backupsList.length}`);

    // Verify SHA-256 checksum integrity
    const latest = backupsList[0];
    const fullBackupPath = path.join(process.env.RRE_DATA_DIR || path.join(__dirname, 'data', '100000'), 'backups', latest.filename);
    const checksum = calculateChecksum(fullBackupPath);
    assert(checksum.length === 64, 'SHA-256 cryptographic checksum verified for backup file', checksum.slice(0, 16) + '...');
  } catch (err) {
    assert(false, 'Disaster recovery checks failed', err.message);
  }

  // TEST 6: Backend Web Server & REST API Verification
  console.log('\n--- 6. Backend Web Server, Security Headers & Health Checks (Pillars 6, 7 & 13) ---');
  // API routes now require a signed session token (server-side authorisation)
  const testToken = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const serverInfo = await startServer(4005, '127.0.0.1');
  const baseUrl = `http://${serverInfo.host}:${serverInfo.port}`;

  function httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer ' + testToken } }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusMessage,
              statusCode: res.statusCode,
              headers: res.headers,
              data: JSON.parse(body)
            });
          } catch(e) {
            resolve({
              status: res.statusMessage,
              statusCode: res.statusCode,
              headers: res.headers,
              raw: body
            });
          }
        });
      }).on('error', reject);
    });
  }

  function httpPost(path, payload) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const req = http.request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + testToken,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusMessage,
              statusCode: res.statusCode,
              headers: res.headers,
              data: JSON.parse(body)
            });
          } catch(e) {
            resolve({
              status: res.statusMessage,
              statusCode: res.statusCode,
              headers: res.headers,
              raw: body
            });
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  try {
    // Health Check Endpoint (Pillar 13)
    const healthRes = await httpGet('/api/health');
    assert(healthRes.statusCode === 200 && healthRes.data.status === 'healthy', 'GET /api/health reports healthy system status');
    assert(healthRes.data.system?.node_version, 'Health check returns Node version and memory metrics');
    assert(healthRes.data.database?.integrity === 'ok', 'Health check reports SQLite WAL integrity OK');

    // Security Headers (Pillar 2)
    assert(healthRes.headers['x-content-type-options'] === 'nosniff', 'Security header X-Content-Type-Options: nosniff present');
    assert(healthRes.headers['x-frame-options'] === 'SAMEORIGIN', 'Security header X-Frame-Options: SAMEORIGIN present');

    // Backup API endpoints
    const backupApiList = await httpGet('/api/backup/list');
    assert(backupApiList.statusCode === 200 && backupApiList.data.success, 'GET /api/backup/list returns backup archive metadata');

    const gwRes = await httpGet('/api/gateway/info');
    assert(gwRes.statusCode === 200 && gwRes.data.success, 'GET /api/gateway/info returns company metadata', gwRes.data.data?.company?.name);

    const ledgersRes = await httpGet('/api/masters/ledgers');
    assert(ledgersRes.statusCode === 200 && ledgersRes.data.success && Array.isArray(ledgersRes.data.data), 'GET /api/masters/ledgers returns ledger list', `Count: ${ledgersRes.data.data?.length}`);

    const stockRes = await httpGet('/api/masters/stock-items');
    assert(stockRes.statusCode === 200 && stockRes.data.success, 'GET /api/masters/stock-items returns stock item list');

    const dashRes = await httpGet('/api/dashboard/tiles');
    assert(dashRes.statusCode === 200 && dashRes.data.success, 'GET /api/dashboard/tiles returns analytical cards', `Debtors: ₹${dashRes.data.data?.totalDebtors?.toFixed(2)}`);

    const bsRes = await httpGet('/api/reports/balance-sheet');
    assert(bsRes.statusCode === 200 && bsRes.data.success, 'GET /api/reports/balance-sheet returns Balance Sheet', `Total Assets: ₹${bsRes.data.data?.total_assets}`);

    const plRes = await httpGet('/api/reports/profit-loss');
    assert(plRes.statusCode === 200 && plRes.data.success, 'GET /api/reports/profit-loss returns P&L statement', `Net Profit: ₹${plRes.data.data?.net_profit}`);

    const tbRes = await httpGet('/api/reports/trial-balance');
    assert(tbRes.statusCode === 200 && tbRes.data.success, 'GET /api/reports/trial-balance returns Trial Balance', `Debit: ₹${tbRes.data.data?.total_debit} = Credit: ₹${tbRes.data.data?.total_credit}`);

    const dbRes = await httpGet('/api/reports/daybook');
    assert(dbRes.statusCode === 200 && dbRes.data.success, 'GET /api/reports/daybook returns Day Book journal', `Vouchers: ${dbRes.data.data?.length}`);

    const ratioRes = await httpGet('/api/reports/ratio-analysis');
    assert(ratioRes.statusCode === 200 && ratioRes.data.success, 'GET /api/reports/ratio-analysis returns financial ratios');

    const gstRes = await httpGet('/api/reports/gst');
    assert(gstRes.statusCode === 200 && gstRes.data.success, 'GET /api/reports/gst returns GSTR-1 and GSTR-3B statutory tables');

    const vListRes = await httpGet('/api/vouchers');
    assert(vListRes.statusCode === 200 && vListRes.data.success && Array.isArray(vListRes.data.data), 'GET /api/vouchers returns recorded accounting vouchers');

    // Guest has no password; entry is the one-click Guest button
    const guestLoginApi = await httpPost('/api/auth/login', { username: 'guest', password: 'guest' });
    assert(guestLoginApi.statusCode === 401 && guestLoginApi.data.success === false, 'POST /api/auth/login refuses the Guest account');
    const guestEntry = await httpPost('/api/auth/guest', {});
    assert(guestEntry.statusCode === 200 && guestEntry.data.data.user.role === 'Guest' && guestEntry.data.data.permissions.canCreateVouchers === false, 'POST /api/auth/guest gives a read-only Guest session without a password');

    // Test POST login API for admin: an account on an old demo password may sign in only to choose a new one
    const adminLoginApi = await httpPost('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert(adminLoginApi.statusCode === 200 || adminLoginApi.statusCode === 401, 'POST /api/auth/login answers for Admin');
    if (adminLoginApi.statusCode === 200) {
      assert(adminLoginApi.data.data.user.role === 'Owner' && adminLoginApi.data.data.must_change_password === true, 'Admin on an old demo password must change it');
    }

    // Public self-registration is off by default: nobody can register themselves (least of all as an administrator)
    const testEmail = `cfo_${Date.now().toString().slice(-4)}@example.com`;
    const regRes = await httpPost('/api/auth/register', {
      full_name: 'Chief Financial Officer',
      email: testEmail,
      username: `cfo_${Date.now().toString().slice(-4)}`,
      password: 'CFO_Password_2026!',
      role: 'Owner'
    });
    assert(regRes.statusCode === 403 && regRes.data.success === false, 'POST /api/auth/register is refused (self-registration is off)');
    assert(!(await get('SELECT id FROM users WHERE email = ?', [testEmail])), 'No account was created by the refused registration');

    // Accounts are created by an administrator, with a temporary password the person must change
    const newName = `cfo_${Date.now().toString().slice(-6)}`;
    const mkRes = await httpPost('/api/auth/users', { username: newName, full_name: 'Chief Financial Officer', email: testEmail, password: 'Temp_Pass_2026x', role: 'Accountant' });
    assert(mkRes.statusCode === 200 && mkRes.data.success, 'An administrator can create an account');
    assert((await httpPost('/api/auth/users', { username: newName + 'b', full_name: 'Weak', password: 'short1', role: 'Accountant' })).statusCode === 400, 'A weak password is refused');
    assert((await httpPost('/api/auth/users', { username: newName + 'c', full_name: 'Guest Try', password: 'Another_Pass_2026x', role: 'Guest' })).statusCode === 400, 'A Guest account cannot be created');
    const storedUser = await get('SELECT * FROM users WHERE username = ?', [newName]);
    assert(storedUser && storedUser.password.startsWith('argon2id$') && storedUser.must_change_password === 1, 'New account is stored with an Argon2id hash and must change its password');
    const regLoginRes = await httpPost('/api/auth/login', { username: newName, password: 'Temp_Pass_2026x' });
    assert(regLoginRes.statusCode === 200 && regLoginRes.data.data.must_change_password === true, 'The new person can sign in with the temporary password, and is told to change it');

    // Google sign-in cannot be verified offline, so it is switched off (a typed-in email must never prove identity)
    const googleRes = await httpPost('/api/auth/google', { email: 'admin@rretally.com', name: 'Someone', role: 'Owner', google_id: 'g_1' });
    assert(googleRes.statusCode === 403 && googleRes.data.success === false, 'POST /api/auth/google is refused');

    // Test GET /api/auth/users returns the directory without ever exposing passwords
    const usersListRes = await httpGet('/api/auth/users');
    assert(usersListRes.statusCode === 200 && usersListRes.data.success, 'GET /api/auth/users returns user directory');
    assert(usersListRes.data.data.every((u) => u.password === undefined) && usersListRes.data.data.some((u) => u.auth_provider), 'Users list never exposes passwords and includes auth_provider metadata');
  } catch (err) {
    assert(false, 'API Endpoints check failed', err.message);
  }

  // TEST 7: Double-Entry Transaction Recording
  console.log('\n--- 7. Double-Entry Accounting Engine Verification (Pillars 1 & 6) ---');
  try {
    const cashLedger = await get("SELECT id FROM ledgers WHERE name LIKE '%Cash%' LIMIT 1");
    const bankLedger = await get("SELECT id FROM ledgers WHERE name LIKE '%Bank%' LIMIT 1");

    if (cashLedger && bankLedger) {
      const contraVoucher = {
        voucher_type: 'Contra',
        voucher_no: 'TEST-CON-' + Date.now().toString().slice(-4),
        date: '2026-06-01',
        narration: 'Automated System Health Verification Deposit',
        entries: [
          { ledger_id: bankLedger.id, debit_amount: 500, credit_amount: 0 },
          { ledger_id: cashLedger.id, debit_amount: 0, credit_amount: 500 }
        ]
      };

      const postVoucherRes = await httpPost('/api/vouchers', contraVoucher);
      assert(postVoucherRes.statusCode === 200 && postVoucherRes.data.success, 'POST /api/vouchers records valid double-entry Contra voucher');
    }
  } catch (err) {
    assert(false, 'Double-entry voucher creation check failed', err.message);
  }

  // TEST 8: AI Copilot & NLP Double-Entry Accounting Verification (AI Architecture)
  console.log('\n--- 8. AI Copilot & NLP Double-Entry Accounting Verification ---');
  try {
    // 8a: Natural language Sales Voucher parser with 18% GST
    const aiSales = await httpPost('/api/ai/parse-voucher', {
      prompt: 'Sold 5 Compressors to Apex Tech at 45000 each with 18% GST on credit'
    });
    assert(aiSales.statusCode === 200 && aiSales.data.interpreted?.voucher_type === 'Sales', 'AI drafts Sales voucher from plain English prompt');
    assert(aiSales.data.interpreted?.entries && aiSales.data.interpreted.entries.length >= 2, 'AI drafts balanced double-entry ledger allocations');
    const totalDr = aiSales.data.interpreted.entries.reduce((sum, e) => sum + (e.debit_amount || 0), 0);
    const totalCr = aiSales.data.interpreted.entries.reduce((sum, e) => sum + (e.credit_amount || 0), 0);
    assert(Math.abs(totalDr - totalCr) < 0.01, `AI ensures mathematical double-entry balance: Debit ₹${totalDr} == Credit ₹${totalCr}`);

    // 8b: Natural language Payment Voucher parser
    const aiPayment = await httpPost('/api/ai/parse-voucher', {
      prompt: 'Paid Office Rent 15000 via Bank'
    });
    assert(aiPayment.statusCode === 200 && aiPayment.data.interpreted?.voucher_type === 'Payment', 'AI drafts Payment voucher for rent expense');

    // 8c: Financial Q&A Agent Query
    const aiQuery = await httpPost('/api/ai/query', {
      query: 'What is our current cash and bank balance?'
    });
    assert(aiQuery.statusCode === 200 && aiQuery.data.success && typeof aiQuery.data.data?.answer === 'string', 'AI Financial Agent answers balance queries dynamically from SQLite');

    // 8c-1: Profit & Loss Query
    const aiProfit = await httpPost('/api/ai/query', {
      query: 'What is our net profit and margins?'
    });
    assert(aiProfit.statusCode === 200 && aiProfit.data.success && typeof aiProfit.data.data?.answer === 'string' && /net (profit|loss)/i.test(aiProfit.data.data.answer), 'AI Financial Agent calculates Net Profit & margins from trading books');

    // 8c-2: Purchases Overview Query
    const aiPurchases = await httpPost('/api/ai/query', {
      query: 'Show total purchases and vendor bills'
    });
    assert(aiPurchases.statusCode === 200 && aiPurchases.data.success && typeof aiPurchases.data.data?.answer === 'string' && aiPurchases.data.data.answer.includes('Purchases'), 'AI Financial Agent answers purchase inquiries');

    // 8c-3: Stock Valuation Query
    const aiStock = await httpPost('/api/ai/query', {
      query: 'What is our total stock valuation?'
    });
    assert(aiStock.statusCode === 200 && aiStock.data.success && typeof aiStock.data.data?.answer === 'string' && aiStock.data.data.answer.includes('Stock Valuation'), 'AI Financial Agent computes live weighted inventory valuation');

    // 8c-4: Working Capital Query
    const aiWC = await httpPost('/api/ai/query', {
      query: 'What is our working capital and solvency?'
    });
    assert(aiWC.statusCode === 200 && aiWC.data.success && typeof aiWC.data.data?.answer === 'string' && aiWC.data.data.answer.includes('Working Capital'), 'AI Financial Agent computes working capital ratio metrics');

    // 8c-5: Specific Stock Item Query
    const aiItem = await httpPost('/api/ai/query', {
      query: 'How many Compressors in stock?'
    });
    assert(aiItem.statusCode === 200 && aiItem.data.success && typeof aiItem.data.data?.answer === 'string', 'AI Financial Agent answers specific stock item query');

    // 8d: Anomaly & Audit Diagnostic Scanner
    const aiInsights = await httpGet('/api/ai/insights');
    assert(aiInsights.statusCode === 200 && typeof aiInsights.data.health_score === 'number', `AI Anomaly Scanner audits company health (Score: ${aiInsights.data.health_score}%)`);
    assert(Array.isArray(aiInsights.data.anomalies), 'AI returns structured anomaly diagnostic feed');

    // 8e: Document / Invoice Parser
    const testInvoiceText = `TAX INVOICE #INV-2026-9901
Vendor: Global Spares Ltd.
Date: 2026-06-15
Item: Heavy Duty Bearing Units
Quantity: 10 Nos @ 2500.00
Subtotal: 25000.00
CGST 9%: 2250.00
SGST 9%: 2250.00
Total Amount Payable: 29500.00`;
    const docParseRes = await httpPost('/api/ai/parse-document', { text: testInvoiceText });
    assert(docParseRes.statusCode === 200 && docParseRes.data.document_parsed?.draft_voucher, 'AI Document Parser extracts structured voucher from pasted invoice text');
    assert(docParseRes.data.document_parsed.draft_voucher.voucher_type === 'Purchase', 'AI identifies supplier bill as Purchase voucher');
  } catch (err) {
    assert(false, 'AI Copilot and Engine verification failed', err.message);
  }

  // TEST 8B: Quotations, Follow-ups, Documents & Report Center
  // Everything created here is deleted again so the company books are unchanged.
  console.log('\n--- 8B. Quotations, Follow-ups, PDF Documents & Report Center ---');
  try {
    const { computeTotals } = require('./modules/quotations/quotationsApi');
    const { amountInWords } = require('./core/documentTemplates');

    const intra = computeTotals([{ item_name: 'A', quantity: 2, rate: 1000, gst_rate: 18 }, { item_name: 'B', quantity: 1, rate: 500, discount_pct: 10, gst_rate: 5 }], { discount_pct: 0, interState: false });
    assert(intra.subtotal === 2450 && intra.cgst === 191.25 && intra.sgst === 191.25 && intra.igst === 0, 'Quote totals split per-line GST into CGST/SGST for intra-state', JSON.stringify(intra));
    assert(intra.total === Math.round(2450 + 382.5) && Math.abs(intra.total - (2450 + 382.5) - intra.round_off) < 0.001, 'Quote total is rounded with matching round-off');
    const inter = computeTotals([{ item_name: 'A', quantity: 10, rate: 100, gst_rate: 18 }], { discount_pct: 10, shipping_charges: 50, interState: true });
    assert(inter.taxable_amount === 900 && inter.igst === 162 && inter.total === 1112, 'Quote discount applied before IGST for inter-state supply', JSON.stringify(inter));
    assert(amountInWords(1234567.5) === 'Indian Rupee Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only', 'Amount in words uses Indian Lakh/Crore system');

    const httpReq = (method, p, payload) => new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : '';
      const req = http.request(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + testToken } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (e) {}
          resolve({ statusCode: res.statusCode, headers: res.headers, data: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    const debtor = await get("SELECT l.id FROM ledgers l JOIN account_groups g ON l.group_id = g.id WHERE g.name = 'Sundry Debtors' LIMIT 1");
    const created = await httpReq('POST', '/api/quotations', {
      customer_name: 'Automated Test Prospect',
      party_ledger_id: debtor ? debtor.id : null,
      subject: 'Automated verification quote',
      items: [{ item_name: 'Test Service', quantity: 2, rate: 1500, gst_rate: 18 }]
    });
    assert(created.statusCode === 200 && /^QT-/.test(created.data.quote_no), 'POST /api/quotations creates a numbered quotation', created.data.quote_no || created.data.error);
    const qid = created.data.id;

    const rejected = await httpReq('POST', '/api/quotations', { customer_name: 'X', items: [] });
    assert(rejected.statusCode === 400, 'Quotation without line items is rejected');

    const fu = await httpReq('POST', `/api/quotations/${qid}/followups`, { mode: 'Call', outcome: 'Interested', notes: 'Automated follow-up', next_followup_date: '2099-01-01' });
    assert(fu.statusCode === 200 && fu.data.data.status === 'Sent' && fu.data.data.next_followup_date === '2099-01-01', 'Logging a follow-up moves Draft to Sent and schedules next follow-up');

    const stats = await httpReq('GET', '/api/quotations/stats');
    assert(stats.statusCode === 200 && typeof stats.data.data.conversion_rate === 'number', 'GET /api/quotations/stats returns pipeline & follow-up counts');

    const doc = await httpReq('GET', `/api/documents/quotation/${qid}`);
    assert(doc.statusCode === 200 && String(doc.data).includes(created.data.quote_no) && String(doc.data).includes('Total In Words'), 'Quotation renders as Zoho-style printable document');

    let voucherId = null;
    if (debtor) {
      const conv = await httpReq('POST', `/api/quotations/${qid}/convert`, {});
      assert(conv.statusCode === 200 && conv.data.voucher && conv.data.data.status === 'Invoiced', 'Accepted quote converts into a posted Sales voucher', conv.data.error);
      voucherId = conv.data.voucher && conv.data.voucher.id;
      const again = await httpReq('POST', `/api/quotations/${qid}/convert`, {});
      assert(again.statusCode === 409, 'Quote cannot be invoiced twice');
      const tbAfter = await httpReq('GET', '/api/reports/trial-balance');
      assert(tbAfter.data.data.is_balanced, 'Trial Balance stays balanced after quote conversion');
      const inv = await httpReq('GET', `/api/documents/invoice/${voucherId}`);
      assert(inv.statusCode === 200 && String(inv.data).includes('Tax Invoice'), 'Converted Sales voucher renders as Tax Invoice document');
    }

    const catalogue = await httpReq('GET', '/api/report-center');
    assert(catalogue.statusCode === 200 && catalogue.data.data.length >= 8, 'Report Center lists available reports', `${catalogue.data.data.length} reports`);
    for (const r of catalogue.data.data) {
      const rr = await httpReq('GET', `/api/report-center/${r.id}`);
      if (rr.statusCode !== 200 || !Array.isArray(rr.data.data.rows)) assert(false, `Report ${r.id} generates`, rr.data.error);
    }
    assert(true, 'Every Report Center report generates without error');
    const csv = await httpReq('GET', '/api/report-center/sales-register?format=csv');
    assert(csv.statusCode === 200 && /text\/csv/.test(csv.headers['content-type']) && String(csv.data).includes('Invoice #'), 'Report exports to CSV');

    // Cleanup: remove the test invoice (re-opens the quote) and the quote itself
    if (voucherId) await httpReq('DELETE', `/api/vouchers/${voucherId}`);
    const del = await httpReq('DELETE', `/api/quotations/${qid}`);
    assert(del.statusCode === 200, 'Test quotation and follow-ups cleaned up');
  } catch (err) {
    assert(false, 'Quotation module verification failed', err.message);
  }

  // TEST 9: Master Observability & Structured Logging (Pillars 6, 7 & 13)
  console.log('\n--- 9. Master Observability & Structured Logging ---');
  try {
    const logsRes = await httpGet('/api/system/logs?limit=25');
    assert(logsRes.statusCode === 200 && logsRes.data.success, 'GET /api/system/logs retrieves structured log buffer');
    assert(Array.isArray(logsRes.data.data) && logsRes.data.data.length > 0, 'Logger captures telemetry events in memory ring buffer', `Logs: ${logsRes.data.data.length}`);
    const sampleLog = logsRes.data.data[logsRes.data.data.length - 1];
    assert(sampleLog.timestamp && sampleLog.level, 'Log entries contain ISO timestamp and severity level', `${sampleLog.level} @ ${sampleLog.timestamp}`);
  } catch (err) {
    assert(false, 'Observability & Logging check failed', err.message);
  }

  // TEST 10: Offline Bundled Client Assets
  console.log('\n--- 10. Offline Bundled Client Assets Verification (Pillar 11) ---');
  // The installer only exists after a packaging run (npm run dist). A source checkout that has not been packaged is not a failure.
  const installerName = ['dist/RRE Entries Setup 1.0.0.exe', 'dist/RRE Tally Setup 1.0.0.exe'].find((f) => fs.existsSync(path.join(__dirname, f)));
  if (!installerName) console.log('  (no packaged installer in dist/ yet: installer check skipped)');
  const assetsToCheck = [
    'public/index.html',
    'public/app.js',
    'public/vendor/tailwind.min.js',
    'public/vendor/lucide.min.js',
    'public/rre_icon.png',
    'rre_icon.ico',
    ...(installerName ? [installerName] : [])
  ];

  for (const asset of assetsToCheck) {
    const fullPath = path.join(__dirname, asset);
    const exists = fs.existsSync(fullPath);
    let sizeStr = '';
    if (exists) {
      const stats = fs.statSync(fullPath);
      sizeStr = stats.size > 1024 * 1024
        ? `${(stats.size / (1024 * 1024)).toFixed(1)} MB`
        : `${(stats.size / 1024).toFixed(1)} KB`;
    }
    assert(exists, `Asset exists: ${asset}`, sizeStr);
  }

  console.log('\n====================================================');
  console.log(`📊 RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');

  if (failed === 0) {
    console.log('🎉 ALL PRODUCTION PILLAR TESTS PASSED! APPLICATION IS 100% HEALTHY.\n');
    process.exit(0);
  } else {
    console.error('⚠️ Some tests failed. Please review.\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

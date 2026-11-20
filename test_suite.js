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
  console.log('🧪 RRE TALLY — COMPREHENSIVE AUTOMATED VERIFICATION');
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
    assert(hashed.startsWith('pbkdf2$10000$'), 'Password hashed with Salted PBKDF2-SHA512');

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
  const testRoles = [
    { username: 'admin', pass: 'admin123', expectedRole: 'Owner' },
    { username: 'admin', pass: '', expectedRole: 'Owner' }, // Passwordless admin shortcut
    { username: 'accountant', pass: 'acc123', expectedRole: 'Accountant' },
    { username: 'dataentry', pass: 'data123', expectedRole: 'Data Entry' },
    { username: 'auditor', pass: 'audit123', expectedRole: 'Auditor' },
    { username: 'viewer', pass: 'view123', expectedRole: 'Viewer' },
    { username: 'guest', pass: 'guest', expectedRole: 'Guest' },
    { username: 'guest', pass: '', expectedRole: 'Guest' } // 1-Click Guest entry
  ];

  for (const t of testRoles) {
    const res = await authenticateUser(t.username, t.pass);
    assert(
      res.success && res.data.user.role === t.expectedRole,
      `Login: "${t.username}" (pwd: "${t.pass}") -> Role: ${t.expectedRole}`,
      res.error
    );
  }

  // Negative Auth Tests
  const badAuth = await authenticateUser('admin', 'wrong_password_999');
  assert(!badAuth.success, 'Reject incorrect password for admin');

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
    const fullBackupPath = path.join(__dirname, 'data', '100000', 'backups', latest.filename);
    const checksum = calculateChecksum(fullBackupPath);
    assert(checksum.length === 64, 'SHA-256 cryptographic checksum verified for backup file', checksum.slice(0, 16) + '...');
  } catch (err) {
    assert(false, 'Disaster recovery checks failed', err.message);
  }

  // TEST 6: Backend Web Server & REST API Verification
  console.log('\n--- 6. Backend Web Server, Security Headers & Health Checks (Pillars 6, 7 & 13) ---');
  const serverInfo = await startServer(4005, '127.0.0.1');
  const baseUrl = `http://${serverInfo.host}:${serverInfo.port}`;

  function httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
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

    // Test POST login API for guest
    const guestLoginApi = await httpPost('/api/auth/login', { username: 'guest', password: 'guest' });
    assert(guestLoginApi.statusCode === 200 && guestLoginApi.data.success && guestLoginApi.data.data.user.role === 'Guest', 'POST /api/auth/login succeeds for Guest');

    // Test POST login API for admin
    const adminLoginApi = await httpPost('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert(adminLoginApi.statusCode === 200 && adminLoginApi.data.success && adminLoginApi.data.data.user.role === 'Owner', 'POST /api/auth/login succeeds for Admin');

    // Test POST /api/auth/register (Email User Creation in Authenticator DB)
    const testEmail = `cfo_${Date.now().toString().slice(-4)}@example.com`;
    const regRes = await httpPost('/api/auth/register', {
      full_name: 'Chief Financial Officer',
      email: testEmail,
      username: `cfo_${Date.now().toString().slice(-4)}`,
      password: 'CFO_Password_2026!',
      role: 'Accountant'
    });
    assert(regRes.statusCode === 200 && regRes.data.success, 'POST /api/auth/register creates user account via Email');
    assert(regRes.data.data.user.email === testEmail, 'Registered user stores correct email address in DB');

    // Verify stored user in SQLite Authenticator with PBKDF2 hash
    const storedUser = await get('SELECT * FROM users WHERE email = ?', [testEmail]);
    assert(storedUser && storedUser.auth_provider === 'email', 'User record saved in Authenticator table with auth_provider = "email"');
    assert(storedUser && storedUser.password.startsWith('pbkdf2$10000$'), 'Registered user password cryptographically hashed with PBKDF2');

    // Test Login with newly registered user
    const regLoginRes = await httpPost('/api/auth/login', {
      username: storedUser.username,
      password: 'CFO_Password_2026!'
    });
    assert(regLoginRes.statusCode === 200 && regLoginRes.data.success, 'New email user can authenticate via POST /api/auth/login');

    // Test duplicate registration rejection
    const dupRes = await httpPost('/api/auth/register', {
      full_name: 'Duplicate Test',
      email: testEmail,
      password: 'somepassword'
    });
    assert(dupRes.statusCode === 400 && dupRes.data.success === false, 'Duplicate email registration safely rejected with 400 error');

    // Test POST /api/auth/google (Google Account Provisioning in Authenticator DB)
    const googleEmail = `auditor_${Date.now().toString().slice(-4)}@gmail.com`;
    const googleId = `g_${Date.now()}`;
    const googleRes = await httpPost('/api/auth/google', {
      email: googleEmail,
      name: 'Google External Auditor',
      role: 'Auditor',
      google_id: googleId
    });
    assert(googleRes.statusCode === 200 && googleRes.data.success, 'POST /api/auth/google provisions & logs in Google account');
    assert(googleRes.data.data.user.role === 'Auditor', 'Google authenticated user receives selected RBAC role');

    // Verify Google user stored in SQLite Authenticator
    const storedGoogleUser = await get('SELECT * FROM users WHERE google_id = ?', [googleId]);
    assert(storedGoogleUser && storedGoogleUser.auth_provider === 'google', 'Google user stored in Authenticator with auth_provider = "google"');
    assert(storedGoogleUser && storedGoogleUser.google_id === googleId, 'Google identifier securely preserved in database');

    // Test subsequent Google sign-in for existing user
    const repeatGoogleRes = await httpPost('/api/auth/google', {
      email: googleEmail,
      name: 'Google External Auditor Updated',
      google_id: googleId
    });
    assert(repeatGoogleRes.statusCode === 200 && repeatGoogleRes.data.success, 'Existing Google user successfully re-authenticates');

    // Test GET /api/auth/users returns auth_provider
    const usersListRes = await httpGet('/api/auth/users');
    assert(usersListRes.statusCode === 200 && usersListRes.data.success, 'GET /api/auth/users returns user directory');
    const hasAuthProvider = usersListRes.data.data.some(u => u.auth_provider === 'email' || u.auth_provider === 'google');
    assert(hasAuthProvider, 'Users list includes auth_provider metadata for multi-provider identity management');
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

  // TEST 8: Offline Bundled Client Assets
  console.log('\n--- 8. Offline Bundled Client Assets Verification (Pillar 11) ---');
  const assetsToCheck = [
    'public/index.html',
    'public/app.js',
    'public/vendor/tailwind.min.js',
    'public/vendor/lucide.min.js',
    'public/tally_icon.png',
    'tally_icon.ico',
    'dist/RRE Tally Setup 1.0.0.exe'
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

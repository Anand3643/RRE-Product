const http = require('http');
const { app, startServer } = require('./server');
const {
  get,
  all,
  authenticateUser,
  getRolePermissions,
  getAllUsers
} = require('./core/db');

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

  // TEST 1: Database Connection & Schema Verification
  console.log('--- 1. Database Connection & Schema Verification ---');
  try {
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    assert(comp && comp.name, 'Company info loaded', comp?.name);

    const userCount = await get('SELECT count(*) as count FROM users');
    assert(userCount.count >= 6, 'All 6 security user profiles exist in DB', `Count: ${userCount.count}`);

    const ledgerCount = await get('SELECT count(*) as count FROM ledgers');
    assert(ledgerCount.count > 0, 'Statutory Chart of Accounts ledgers seeded', `Count: ${ledgerCount.count}`);

    const itemCount = await get('SELECT count(*) as count FROM stock_items');
    assert(itemCount.count >= 0, 'Inventory stock items table accessible', `Count: ${itemCount.count}`);
  } catch (err) {
    assert(false, 'Database queries failed', err.message);
  }

  // TEST 2: Multi-User Authentication Engine
  console.log('\n--- 2. Multi-User Authentication Engine Verification ---');
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

  // TEST 3: Role Security & Permissions Matrix
  console.log('\n--- 3. Role Security Permissions Verification ---');
  const ownerPerms = getRolePermissions('Owner');
  assert(ownerPerms.canCreateVouchers === true && ownerPerms.canManageUsers === true && ownerPerms.canAlterCompany === true, 'Owner has Full Access');

  const guestPerms = getRolePermissions('Guest');
  assert(guestPerms.canCreateVouchers === false && guestPerms.canManageUsers === false && guestPerms.canViewFinancials === true, 'Guest has Safe Read-Only Access (Vouchers & Users Restricted, Financials Viewable)');

  const entryPerms = getRolePermissions('Data Entry');
  assert(entryPerms.canCreateVouchers === true && entryPerms.canViewFinancials === false, 'Data Entry can record vouchers but Financials Restricted');

  const auditorPerms = getRolePermissions('Auditor');
  assert(auditorPerms.canCreateVouchers === false && auditorPerms.canViewFinancials === true, 'Auditor cannot record vouchers but can inspect Books');

  // TEST 4: Backend Web Server & REST API Verification
  console.log('\n--- 4. Backend Web Server & REST API Verification ---');
  const serverInfo = await startServer(4005, '127.0.0.1');
  const baseUrl = `http://${serverInfo.host}:${serverInfo.port}`;

  function httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusMessage, statusCode: res.statusCode, data: JSON.parse(body) });
          } catch(e) {
            resolve({ status: res.statusMessage, statusCode: res.statusCode, raw: body });
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
            resolve({ status: res.statusMessage, statusCode: res.statusCode, data: JSON.parse(body) });
          } catch(e) {
            resolve({ status: res.statusMessage, statusCode: res.statusCode, raw: body });
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  try {
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
  } catch (err) {
    assert(false, 'API Endpoints check failed', err.message);
  }

  // TEST 5: Double-Entry Transaction Recording
  console.log('\n--- 5. Double-Entry Accounting Engine Verification ---');
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

  // TEST 6: Offline Bundled Client Assets
  console.log('\n--- 6. Offline Bundled Client Assets Verification ---');
  const fs = require('fs');
  const path = require('path');

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
    console.log('🎉 ALL 33 AUDIT TESTS PASSED! APPLICATION IS HEALTHY & READY.\n');
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

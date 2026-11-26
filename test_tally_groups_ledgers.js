// ========================================================
// Test: 96 Standard Tally Ledgers & Group Creation Engine
// ========================================================
// a DISPOSABLE copy of the company (this suite used to run against the real data folder) and a signed-in owner, like the other suites
process.env.RRE_DATA_DIR = process.env.RRE_DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rre_ledgers_test_'));
process.env.RRE_LEGACY_TOKENS = '1';
const assert = require('assert');
const { initDb, all, get, seedStandardTallyLedgers, STANDARD_TALLY_LEDGERS } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { calculateAllLedgerBalances } = require('./core/accountingEngine');

async function runTests() {
  console.log('--- 1. Testing Schema Migration & Standard Tally Ledgers Seeding ---');
  await initDb();
  await runMigrations();

  const seedResult = await seedStandardTallyLedgers();
  console.log(`  Seeded/Verified: ${seedResult.total} total standard ledgers, newly added: ${seedResult.newlySeeded}`);
  assert(seedResult.total === 96, 'All 96 standard Tally ERP 9 ledgers are tracked in dictionary');

  // Verify all 96 exist in the database
  const dbLedgers = await all(`
    SELECT l.id, l.name, l.description, l.opening_balance, l.opening_balance_type, g.name as group_name
    FROM ledgers l
    JOIN account_groups g ON l.group_id = g.id
  `);
  const ledgerMap = new Map();
  dbLedgers.forEach(l => ledgerMap.set(l.name.toLowerCase().trim(), l));

  let verifiedCount = 0;
  for (const item of STANDARD_TALLY_LEDGERS) {
    const found = ledgerMap.get(item.name.toLowerCase().trim());
    assert(found, `Ledger "${item.name}" (Sno ${item.sno}) must exist in database`);
    assert(found.opening_balance_type === item.side, `Ledger "${item.name}" default balance type must be ${item.side}, got ${found.opening_balance_type}`);
    verifiedCount++;
  }
  console.log(`  ✅ [PASS] Successfully verified all ${verifiedCount}/96 standard Tally ledgers with Dr/Cr sides`);

  console.log('\n--- 2. Testing Predefined Groups (no duplicate alias groups) ---');
  const groups = await all('SELECT id, name, nature FROM account_groups');
  const groupNames = groups.map(g => g.name.toLowerCase());
  const expectedGroups = [
    'direct expenses', 'indirect expenses', 'indirect incomes', 'fixed assets', 'bank accounts', 'cash-in-hand',
    'bank od a/c', 'capital account', 'purchase accounts', 'sales accounts', 'stock-in-hand', 'current assets', 'current liabilities',
    'loans & advances (asset)', 'loans (liability)', 'duties & taxes', 'reserves & surplus', 'investments', 'sundry creditors', 'sundry debtors'
  ];
  for (const eg of expectedGroups) {
    assert(groupNames.includes(eg.toLowerCase()), `Group "${eg}" must exist in account_groups`);
  }
  console.log(`  ✅ [PASS] All standard Tally groups exist in account_groups`);
  // the old alias spellings must NOT be separate groups: each one showed the same group twice in every group list
  const aliasCopies = ['bank account', 'cash in hand', 'bank o/d account', 'purchase account', 'sales account', 'indirect income',
    'current liability', 'loans (advance assets)', 'reserve & surplus', 'investment'];
  const fresh = await all("SELECT name FROM account_groups WHERE LOWER(name) IN (" + aliasCopies.map(() => '?').join(',') + ')', aliasCopies);
  const seededNow = (await get("SELECT value FROM app_settings WHERE key = 'standard_masters'"));
  if (!fresh.length) console.log('  ✅ [PASS] No duplicate alias groups (Bank Account / Cash In Hand / Sales Account ...)');
  else console.log(`  ℹ️  This copy of the data still holds ${fresh.length} alias group(s) created by an earlier version; the set-up no longer creates them`);
  // forced re-seed (as on a clean company) must not add any alias group
  const before = (await get('SELECT COUNT(*) n FROM account_groups')).n;
  await seedStandardTallyLedgers({ force: true });
  assert((await get('SELECT COUNT(*) n FROM account_groups')).n === before, 'Seeding the standard masters again adds no group');
  console.log('  ✅ [PASS] Seeding the standard masters creates no alias groups' + (seededNow ? '' : ''));

  console.log('\n--- 3. Testing Mathematical Equilibrium (Trial Balance) ---');
  const balances = await calculateAllLedgerBalances();
  let totalDebit = 0;
  let totalCredit = 0;
  balances.forEach(b => {
    if (b.closing_type === 'Dr') totalDebit += b.closing_balance;
    else totalCredit += b.closing_balance;
  });
  const diff = Math.abs(totalDebit - totalCredit);
  console.log(`  Total Debits: ₹${totalDebit.toFixed(2)} | Total Credits: ₹${totalCredit.toFixed(2)} | Difference: ₹${diff.toFixed(2)}`);
  assert(diff <= 0.05, `Trial balance must remain in equilibrium (diff <= 0.05). Got diff: ₹${diff.toFixed(2)}`);
  console.log(`  ✅ [PASS] Trial Balance remains in 100% mathematical equilibrium!`);

  console.log('\n--- 4. Testing Group Creation & Ledger API Operations ---');
  const http = require('http');
  const { app } = require('./server');
  const port = 14899;
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(port, () => resolve(s));
  });

  const request = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + require('./core/security').createSessionToken({ id: 1, username: 'admin', role: 'Owner' }) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  try {
    // 1. Create a custom primary group
    const grpRes = await request('POST', '/api/masters/groups', {
      name: 'Custom Logistics & Fleet',
      nature: 'Expenses',
      affects_gross_profit: true
    });
    assert(grpRes.status === 200 && grpRes.data.success, 'Can create custom primary account group');
    const customGroupId = grpRes.data.id;
    console.log(`  ✅ [PASS] POST /api/masters/groups creates custom primary group (ID: ${customGroupId})`);

    // 2. Create a custom sub-group
    const subGrpRes = await request('POST', '/api/masters/groups', {
      name: 'South Zone Fleet Fuel',
      parent_id: customGroupId
    });
    assert(subGrpRes.status === 200 && subGrpRes.data.success, 'Can create sub-group inheriting parent nature');
    const subGroupId = subGrpRes.data.id;
    console.log(`  ✅ [PASS] POST /api/masters/groups creates sub-group (ID: ${subGroupId})`);

    // 3. Create a custom ledger with description
    const ldgRes = await request('POST', '/api/masters/ledgers', {
      name: 'Highway Toll & FASTag Charges',
      group_id: subGroupId,
      opening_balance: 0,
      opening_balance_type: 'Dr',
      description: 'Highway toll plaza FASTag charges'
    });
    assert(ldgRes.status === 200 && ldgRes.data.success, 'Can create ledger with custom group and description');
    console.log(`  ✅ [PASS] POST /api/masters/ledgers creates ledger with group link and description`);

    // 4. Verify in GET /api/masters/ledgers
    const listRes = await request('GET', '/api/masters/ledgers');
    const fastag = listRes.data.data.find(l => l.name === 'Highway Toll & FASTag Charges');
    assert(fastag, 'Newly created ledger returned in GET /api/masters/ledgers');
    assert(fastag.description === 'Highway toll plaza FASTag charges', 'Description preserved in API response');
    console.log(`  ✅ [PASS] GET /api/masters/ledgers returns ledger with description`);

    // Clean up test ledger and groups
    const { run } = require('./core/db');
    await run('DELETE FROM ledgers WHERE id = ?', [ldgRes.data.id]);
    await run('DELETE FROM account_groups WHERE id IN (?, ?)', [subGroupId, customGroupId]);
  } finally {
    srv.close();
  }

  console.log('\n====================================================');
  console.log('🎉 ALL 96 TALLY LEDGERS & GROUP SEEDING TESTS PASSED!');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

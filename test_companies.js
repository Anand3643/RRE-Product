process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Multiple companies: isolation, switching, tokens bound to a company, per-company backups.
 * Uses a DISPOSABLE data root (RRE_DATA_ROOT) so the real data folder is never touched.   npm run test:companies
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_companies_test_'));
process.env.RRE_DATA_ROOT = root;
delete process.env.RRE_DATA_DIR;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const db = require('./core/db');
const { runMigrations, MIGRATIONS } = require('./core/migrations');
const security = require('./core/security');
const paths = require('./core/paths');
const { createBackup, listBackups } = require('./core/backupEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const ADMIN_PW = 'Admin#Test-2026a'; // old demo passwords now force a change; give the test admin a proper one
  await db.run('UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ? WHERE username = ?', [security.hashPassword(ADMIN_PW), new Date().toISOString(), 'admin']);
  const info = await startServer(11000 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const login = async (u, p) => { const r = await req('POST', '/api/auth/login', { body: { username: u, password: p } }); return r.json?.data?.token; };
  const T = (id, u, r) => security.createSessionToken({ id, username: u, role: r });

  console.log('\n--- 1. Starting point: one company, original folder ---');
  const adminA = await login('admin', ADMIN_PW);
  const clerkA = T(3, 'dataentry', 'Data Entry');
  let l = (await req('GET', '/api/companies', { token: adminA })).json.data;
  assert(l.companies.length === 1 && l.active === '100000' && l.companies[0].active && l.can_create, 'One company (100000) is active and creating more is allowed');
  assert(fs.existsSync(paths.registryFile()) && JSON.parse(fs.readFileSync(paths.registryFile(), 'utf8')).active === '100000', 'The registry file was created in the data root');
  assert(db.getDataDir() === paths.companyDir('100000') && fs.existsSync(path.join(paths.companyDir('100000'), 'company.db')), 'Original company uses <root>/100000/company.db');
  assert((await req('GET', '/api/companies')).status === 401, 'Listing requires login');
  assert(JSON.parse(Buffer.from(adminA.slice(4).split('.')[0], 'base64url').toString()).company === '100000', 'A session token records the company it was issued in');

  // distinctive data in company A
  const cashA = (await get("SELECT id FROM ledgers WHERE name = 'Cash'")).id, bankA = (await get("SELECT id FROM ledgers WHERE name LIKE 'HDFC%'")).id;
  await req('POST', '/api/masters/ledgers', { token: adminA, body: { name: 'A-Only Ledger', group_id: 12 } });
  const postA = await req('POST', '/api/vouchers', { token: adminA, body: { voucher_type: 'Contra', voucher_no: 'A/1', date: '2026-06-02', entries: [{ ledger_id: cashA, debit_amount: 77 }, { ledger_id: bankA, credit_amount: 77 }] } });
  assert(postA.json.success, 'Company A: a distinctive ledger and voucher posted');
  const aVouchers = (await get('SELECT COUNT(*) c FROM vouchers')).c, aLedgers = (await get('SELECT COUNT(*) c FROM ledgers')).c, aUsers = (await get('SELECT COUNT(*) c FROM users')).c;
  await createBackup({ notes: 'A backup' });
  assert(listBackups().length === 1, 'Company A has one backup');

  console.log('\n--- 2. Creating a company ---');
  const good = { name: 'Second Traders', owner_username: 'owner2', owner_password: 'Secret#12345', owner_full_name: 'Second Owner', financial_year_from: '2026-04-01', state: 'Karnataka', state_code: '29' };
  assert((await req('POST', '/api/companies', { token: clerkA, body: good })).status === 403, 'Data Entry cannot create a company');
  assert((await req('POST', '/api/companies', { token: null, body: good })).status === 401, 'Anonymous cannot create a company');
  for (const [label, b] of [['short name', { ...good, name: 'x' }], ['bad username', { ...good, owner_username: 'a b' }], ['short password', { ...good, owner_password: 'short' }], ['common password', { ...good, owner_password: 'Password123' }],
    ['bad FY date', { ...good, financial_year_from: '2026-13-40' }], ['bad GSTIN', { ...good, gstin: '27AAPFU0939F1Z' }], ['duplicate of the first company', { ...good, name: 'rre tally' }]])
    assert([400, 409].includes((await req('POST', '/api/companies', { token: adminA, body: b })).status), `Rejected: ${label}`);
  assert(fs.readdirSync(root).filter((f) => /^\d{6}$/.test(f)).length === 1, 'Rejected requests created no folders');
  const t0 = Date.now();
  const mk = await req('POST', '/api/companies', { token: adminA, body: good });
  assert(mk.status === 200 && mk.json.data.number === '100001' && mk.json.data.name === 'Second Traders', `Company 100001 created in ${Date.now() - t0} ms`, mk.raw.slice(0, 200));
  assert(db.getCompanyNumber() === '100000', 'Creating a company does NOT change the active company');
  l = (await req('GET', '/api/companies', { token: adminA })).json.data;
  assert(l.companies.length === 2 && l.companies.find((c) => c.number === '100001' && !c.active) && l.companies.find((c) => c.number === '100000').active, 'Both companies listed; the original is still active');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === aVouchers && (await get('SELECT COUNT(*) c FROM ledgers')).c === aLedgers && (await get('SELECT COUNT(*) c FROM users')).c === aUsers, 'Company A\'s data is exactly as it was (vouchers, ledgers, users)');
  assert(fs.existsSync(path.join(paths.companyDir('100001'), 'company.db')), 'The new company has its own database file');
  assert((await req('POST', '/api/companies', { token: adminA, body: good })).status === 409, 'Creating the same name again is refused');

  console.log('\n--- 3. Switching: tokens, isolation, clean books ---');
  assert((await req('POST', '/api/companies/switch', { token: clerkA, body: { number: '100001' } })).status === 403, 'Data Entry cannot switch');
  assert((await req('POST', '/api/companies/switch', { token: adminA, body: { number: '999999' } })).status === 404, 'Switching to an unknown company -> 404');
  const same = await req('POST', '/api/companies/switch', { token: adminA, body: { number: '100000' } });
  assert(same.status === 200 && same.json.data.changed === false, 'Switching to the current company is a harmless no-op');
  const sw = await req('POST', '/api/companies/switch', { token: adminA, body: { number: '100001' } });
  assert(sw.status === 200 && sw.json.data.changed && sw.json.data.name === 'Second Traders', 'Switched to Second Traders');
  assert(db.getCompanyNumber() === '100001' && JSON.parse(fs.readFileSync(paths.registryFile(), 'utf8')).active === '100001', 'Active company is persisted in the registry (it will reopen after a restart)');
  assert((await req('GET', '/api/masters/ledgers', { token: adminA })).status === 401, 'The Owner token from company A is REJECTED in company B (tokens are company-bound)');
  assert((await req('GET', '/api/companies', { token: adminA })).status === 401, '…everywhere, including the company list');
  assert((await login('admin', ADMIN_PW)) === undefined, 'The demo admin account does not exist in the new company');
  assert((await login('owner2', 'wrong-password')) === undefined, 'A wrong password is refused');
  const ownerB = await login('owner2', 'Secret#12345');
  assert(!!ownerB && JSON.parse(Buffer.from(ownerB.slice(4).split('.')[0], 'base64url').toString()).company === '100001', 'The chosen owner can sign in; the token is for company 100001');
  const ledB = (await req('GET', '/api/masters/ledgers', { token: ownerB })).json.data;
  assert(!ledB.some((x) => x.name === 'A-Only Ledger') && !ledB.some((x) => /Chennai|HDFC|Elgi/.test(x.name)), 'Company B contains none of company A\'s (or the demo) ledgers');
  assert(ledB.some((x) => x.name === 'Cash') && ledB.some((x) => x.name === 'Output CGST 9%') && ledB.some((x) => x.name === 'Round Off A/c') && ledB.length === 20 && ledB.every((x) => x.state_code === '29'), 'It starts with 20 neutral ledgers (the standard clean-slate set plus the exact-name GST ledgers the invoice screens use), all in the chosen state (29)', String(ledB.length));
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === 0 && (await get('SELECT COUNT(*) c FROM stock_items')).c === 0, 'Company B has no vouchers and no stock items');
  const ci = await get('SELECT name, state_code, financial_year_from, company_number FROM company_info');
  assert(ci.name === 'Second Traders' && ci.state_code === '29' && ci.financial_year_from === '2026-04-01' && ci.company_number === '100001', 'Company B\'s details are the ones entered');
  const usersB = (await all('SELECT username, role FROM users ORDER BY username')).map((u) => u.username);
  assert(usersB.includes('owner2') && !usersB.some((u) => ['admin', 'accountant', 'dataentry', 'auditor', 'viewer'].includes(u)), 'No demo staff accounts exist in the new company (only the chosen owner, plus the read-only "guest" that the existing login code adds on first sign-in)', usersB.join());
  assert((await get('PRAGMA foreign_keys')).foreign_keys === 1, 'Foreign-key enforcement is ON after the switch');
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === MIGRATIONS.length, 'All schema migrations were applied to the new company');
  assert(listBackups().length >= 0 && !listBackups().some((b) => b.notes === 'A backup'), 'Company A\'s backups are not visible from company B');

  console.log('\n--- 4. Working in company B ---');
  const cashB = (await get("SELECT id FROM ledgers WHERE name = 'Cash'")).id;
  const rentB = (await req('POST', '/api/masters/ledgers', { token: ownerB, body: { name: 'B-Only Rent', group_id: 12 } })).json.id;
  const postB = await req('POST', '/api/vouchers', { token: ownerB, body: { voucher_type: 'Payment', voucher_no: 'B/1', date: '2026-06-03', party_ledger_id: rentB, entries: [{ ledger_id: rentB, debit_amount: 500 }, { ledger_id: cashB, credit_amount: 500 }] } });
  assert(postB.json.success, 'Company B: its own ledger and voucher posted');
  assert((await req('GET', '/api/reports/trial-balance', { token: ownerB })).json.success, 'Reports work in company B');
  const note = await req('GET', '/api/platform/notifications', { token: ownerB });
  assert(note.status === 200 && !note.json.data.some((n) => /Chennai|Southern|Elgi/.test(n.title)), 'Alerts in company B contain nothing from company A');
  await createBackup({ notes: 'B backup' });
  assert(listBackups().some((b) => b.notes === 'B backup') && !listBackups().some((b) => b.notes === 'A backup'), "Company B has its own backups (its own snapshot, none of company A's)");
  assert(fs.existsSync(path.join(paths.companyDir('100001'), 'backups')), 'Backups live inside company B\'s folder');
  const log = (await req('GET', '/api/platform/activity-log', { token: ownerB })).json.data;
  assert(log.some((x) => x.action === 'POST /api/vouchers') && !log.some((x) => x.action === 'COMPANY_CREATE'), 'The activity log is per company (B\'s shows B\'s work, not A\'s company-creation entry)');
  const sch = await req('POST', '/api/platform/schedules', { token: ownerB, body: { name: 'B report', dataset: 'vouchers', frequency: 'daily', hour: 8 } });
  assert(sch.status === 200, 'Scheduled reports work in company B');

  console.log('\n--- 5. Switching back: nothing lost, nothing mixed ---');
  const back = await req('POST', '/api/companies/switch', { token: ownerB, body: { number: '100000' } });
  assert(back.status === 200 && db.getCompanyNumber() === '100000', 'Owner of B switched back to company A');
  assert((await req('GET', '/api/masters/ledgers', { token: ownerB })).status === 401, 'B\'s token is rejected in company A');
  const adminA2 = await login('admin', ADMIN_PW);
  assert(!!adminA2, 'The original admin signs in to company A again');
  const ledA = (await req('GET', '/api/masters/ledgers', { token: adminA2 })).json.data;
  assert(ledA.some((x) => x.name === 'A-Only Ledger') && !ledA.some((x) => x.name === 'B-Only Rent'), 'A has its own ledger and none of B\'s');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === aVouchers && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'B/1'")).c === 0, 'A\'s vouchers are unchanged and B\'s voucher is not here');
  assert(listBackups().length === 1 && listBackups()[0].notes === 'A backup', 'A\'s backups are A\'s only');
  assert((await get('SELECT COUNT(*) c FROM scheduled_reports')).c === 0, 'B\'s scheduled report did not leak into A');
  assert((await get('PRAGMA foreign_keys')).foreign_keys === 1, 'Foreign-key enforcement is ON again in A');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Company A: total Dr == total Cr', `${dr}/${cr}`);
  const logA = (await req('GET', '/api/platform/activity-log?limit=100', { token: adminA2 })).json.data;
  assert(logA.some((x) => x.action === 'COMPANY_CREATE') && logA.some((x) => x.action === 'COMPANY_SWITCH'), 'The creation and the switch are recorded in company A\'s activity log');

  console.log('\n--- 6. Requests during a switch ---');
  const burst = [];
  const swp = req('POST', '/api/companies/switch', { token: adminA2, body: { number: '100001' } });
  for (let i = 0; i < 25; i++) burst.push(req('GET', '/api/masters/ledgers', { token: adminA2 }));
  const sres = await swp;
  const results = await Promise.all(burst);
  assert(sres.status === 200, 'Switch completes while 25 requests are in flight');
  assert(results.every((r) => [200, 401, 503].includes(r.status)), 'Concurrent requests get a normal answer (200, 401 or "retry" 503) — never a server error', results.map((r) => r.status).join());
  assert(results.filter((r) => r.status === 200).every((r) => r.json.data.some((x) => x.name === 'A-Only Ledger')), 'Any request answered with data got company A\'s data (the company it was issued for), never a mixture');
  assert(db.getCompanyNumber() === '100001', 'The switch took effect');
  const ownerB2 = await login('owner2', 'Secret#12345');
  await req('POST', '/api/companies/switch', { token: ownerB2, body: { number: '100000' } });

  console.log('\n--- 7. Tokens from before multi-company, and the registry ---');
  security.setCompanyProvider(null);
  const legacyTok = security.createSessionToken({ id: 1, username: 'admin', role: 'Owner' }); // no company field, like tokens issued by older versions
  security.setCompanyProvider(() => db.getCompanyNumber());
  assert((await req('GET', '/api/masters/ledgers', { token: legacyTok })).status === 200, 'An older token (no company recorded) still works in the ORIGINAL company');
  await req('POST', '/api/companies/switch', { token: await login('admin', ADMIN_PW), body: { number: '100001' } });
  assert((await req('GET', '/api/masters/ledgers', { token: legacyTok })).status === 401, '…but not in any other company');
  const reg = JSON.parse(fs.readFileSync(paths.registryFile(), 'utf8'));
  assert(reg.companies.length === 2 && reg.active === '100001' && !fs.existsSync(paths.registryFile() + '.tmp'), 'Registry is valid JSON with both companies and no leftover temp file');
  assert(fs.readdirSync(root).filter((f) => /^\d{6}$/.test(f)).length === 2, 'Exactly two company folders exist; nothing was deleted');

  console.log('\n====================================================');
  console.log(`📊 COMPANIES RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { await db.closeDb(); fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  void all; void run;
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

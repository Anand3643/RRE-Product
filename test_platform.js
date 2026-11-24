process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Verification for the Phase 3 platform services.
 * Always runs against a DISPOSABLE data directory (never the live company data).
 *   npm run test:platform
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_platform_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createBackup } = require('./core/backupEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb();
  const applied = await runMigrations();
  // The pre-seeded dev database may already carry migrations/log rows (it depends on its WAL state), so judge by the migrations table and start with an empty log.
  const dbm = require('./core/db');
  const first = [...new Set([...applied, ...(await dbm.all('SELECT id FROM schema_migrations')).map((r) => r.id)])];
  await dbm.run('DELETE FROM activity_log');
  // Give the test accounts strong passwords of their own (old demo passwords now force a password change at login)
  const { hashPassword } = require('./core/security');
  const PW = { admin: 'Admin#Test-2026a', viewer: 'Viewer#Test-2026a', dataentry: 'Clerk#Test-2026a', accountant: 'Acct#Test-2026a', auditor: 'Audit#Test-2026a' };
  for (const [u, p] of Object.entries(PW)) await dbm.run('UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ? WHERE username = ?', [hashPassword(p), new Date().toISOString(), u]);
  const info = await startServer(0 + 4600 + Math.floor(Math.random() * 300), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;

  function req(method, p, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request(base + p, {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        }
      }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(b); } catch (e) {}
          resolve({ status: res.statusCode, json, raw: b, headers: res.headers });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  const login = async (u, p) => (await req('POST', '/api/auth/login', { body: { username: u, password: p } })).json.data.token;

  console.log('\n--- 1. Migrations ---');
  assert(first.includes('001_platform_tables') && first.includes('002_stock_reorder_level') && first.includes('003_scheduled_reports'), 'Migrations applied on first run', first.join(','));
  assert((await runMigrations()).length === 0, 'Migrations are idempotent (second run applies nothing)');
  const cols = await all('PRAGMA table_info(stock_items)');
  assert(cols.some((c) => c.name === 'reorder_level'), 'stock_items.reorder_level column added');
  const before = {
    vouchers: (await get('SELECT COUNT(*) c FROM vouchers')).c,
    ledgers: (await get('SELECT COUNT(*) c FROM ledgers')).c,
    entries: (await get('SELECT COUNT(*) c FROM ledger_entries')).c,
    dr: (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s,
    cr: (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s
  };
  assert(before.vouchers > 0 && before.ledgers > 0, 'Existing masters/vouchers intact after migration', JSON.stringify(before));

  console.log('\n--- 2. Server-side authorisation on new routes ---');
  for (const p of ['/api/platform/notifications', '/api/platform/search?q=abc', '/api/platform/export/vouchers', '/api/platform/activity-log']) {
    const r = await req('GET', p);
    assert(r.status === 401, `No token -> 401: ${p}`, String(r.status));
  }
  assert((await req('GET', '/api/platform/notifications', { token: 'rre_garbage.sig' })).status === 401, 'Forged token rejected');
  const admin = await login('admin', PW.admin);
  const viewer = await login('viewer', PW.viewer);
  const clerk = await login('dataentry', PW.dataentry);
  assert((await req('GET', '/api/platform/export/vouchers', { token: clerk })).status === 403, 'Data Entry cannot export (no canViewFinancials)');
  assert((await req('GET', '/api/platform/export/vouchers', { token: viewer })).status === 200, 'Viewer can export');
  assert((await req('GET', '/api/platform/activity-log', { token: viewer })).status === 403, 'Viewer cannot read activity log');
  assert((await req('GET', '/api/platform/activity-log', { token: admin })).status === 200, 'Owner can read activity log');

  console.log('\n--- 3. Notification centre ---');
  let n = await req('GET', '/api/platform/notifications', { token: admin });
  assert(n.status === 200 && Array.isArray(n.json.data), 'Notifications load');
  const overdueRecv = n.json.data.filter((x) => x.type === 'overdue_receivable');
  assert(overdueRecv.length > 0, 'Overdue receivables detected from bill due dates', `count=${overdueRecv.length}`);
  assert(n.json.data.some((x) => x.type === 'backup'), 'Backup-missing alert raised when no backup exists');
  const again = await req('GET', '/api/platform/notifications', { token: admin });
  assert(again.json.data.length === n.json.data.length, 'Re-polling does not duplicate alerts');

  const item = await get("SELECT id FROM stock_items WHERE name LIKE 'Screw Compressor Oil Filter%'");
  await run('UPDATE stock_items SET reorder_level = 999 WHERE id = ?', [item.id]);
  n = await req('GET', '/api/platform/notifications', { token: admin });
  assert(n.json.data.some((x) => x.dedupe_key === undefined && x.type === 'low_stock'), 'Low-stock alert raised when qty <= reorder level');
  await run('UPDATE stock_items SET reorder_level = 0 WHERE id = ?', [item.id]);
  n = await req('GET', '/api/platform/notifications', { token: admin });
  assert(!n.json.data.some((x) => x.type === 'low_stock'), 'Low-stock alert auto-resolves when condition clears');
  const one = n.json.data[0];
  await req('POST', `/api/platform/notifications/${one.id}/read`, { token: admin });
  n = await req('GET', '/api/platform/notifications', { token: admin });
  assert(n.json.data.find((x) => x.id === one.id).is_read === 1, 'Mark single notification read');
  await req('POST', '/api/platform/notifications/read-all', { token: admin });
  n = await req('GET', '/api/platform/notifications', { token: admin });
  assert(n.json.unread === 0, 'Mark all read');

  console.log('\n--- 4. Global search ---');
  let s = (await req('GET', '/api/platform/search?q=Chennai', { token: admin })).json.data;
  assert(s.ledgers.some((l) => l.kind === 'Customer'), 'Finds customer ledger by name');
  assert(s.vouchers.length > 0, 'Finds vouchers via party name');
  s = (await req('GET', '/api/platform/search?q=407100', { token: admin })).json.data;
  assert(s.vouchers.some((v) => v.total_amount === 407100), 'Finds voucher by amount');
  s = (await req('GET', '/api/platform/search?q=%25%25', { token: admin })).json.data;
  assert(s.ledgers.length === 0 && s.vouchers.length === 0, 'LIKE wildcards are escaped (q="%%" matches nothing)');
  s = (await req('GET', '/api/platform/search?q=84148011', { token: admin })).json.data;
  assert(s.items.length > 0, 'Finds stock item by HSN');
  s = (await req('GET', "/api/platform/search?q=%27%3B%20DROP%20TABLE%20vouchers%3B--", { token: admin }));
  assert(s.status === 200 && (await get('SELECT COUNT(*) c FROM vouchers')).c === before.vouchers, 'SQL-injection style query is harmless');

  console.log('\n--- 5. Export ---');
  const ex = await req('GET', '/api/platform/export/vouchers', { token: admin });
  assert(ex.headers['content-type'].includes('text/csv') && ex.raw.startsWith('﻿Date,Type,Voucher No'), 'Voucher CSV has BOM + header');
  assert(ex.raw.trim().split('\r\n').length - 1 === before.vouchers, 'Voucher CSV row count equals database', `${ex.raw.trim().split('\r\n').length - 1} vs ${before.vouchers}`);
  const exF = await req('GET', '/api/platform/export/vouchers?type=Sales', { token: admin });
  assert(exF.raw.trim().split('\r\n').length - 1 === (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type='Sales'")).c, 'Type filter applied');
  await req('POST', '/api/masters/ledgers', { token: admin, body: { name: '=HYPERLINK("http://x")', group_id: 12 } });
  const exL = await req('GET', '/api/platform/export/ledgers', { token: admin });
  assert(exL.raw.includes(`"'=HYPERLINK(""http://x"")"`), 'Formula-injection neutralised in CSV');
  for (const d of ['stock-items', 'outstandings']) {
    const r = await req('GET', '/api/platform/export/' + d, { token: admin });
    assert(r.status === 200 && r.raw.length > 20, `Export dataset: ${d}`);
  }
  assert((await req('GET', '/api/platform/export/nope', { token: admin })).status === 404, 'Unknown dataset -> 404');

  console.log('\n--- 6. Activity log ---');
  const cc = await get("SELECT id FROM ledgers WHERE name = 'Cash'");
  const bk = await get("SELECT id FROM ledgers WHERE name LIKE 'HDFC%'");
  const post = await req('POST', '/api/vouchers', {
    token: admin,
    body: { voucher_type: 'Contra', voucher_no: 'T/CON/1', date: '2026-06-02', entries: [
      { ledger_id: cc.id, debit_amount: 1000 }, { ledger_id: bk.id, credit_amount: 1000 }] }
  });
  assert(post.json && post.json.success, 'Existing voucher API still posts a Contra voucher');
  await new Promise((r) => setTimeout(r, 150));
  let log = (await req('GET', '/api/platform/activity-log', { token: admin })).json.data;
  const row = log.find((l) => l.action === 'POST /api/vouchers');
  assert(row && row.username === 'admin' && row.entity === 'voucher', 'Voucher post recorded with user', JSON.stringify(row));
  await req('POST', '/api/auth/users', { body: { username: 'tmp1', password: 'SuperSecret!9', full_name: 'Tmp' } });
  await new Promise((r) => setTimeout(r, 150));
  log = (await req('GET', '/api/platform/activity-log', { token: admin })).json.data;
  assert(!JSON.stringify(log).includes('SuperSecret'), 'Passwords never written to the activity log');
  const bad = await req('POST', '/api/vouchers', { token: admin, body: { voucher_type: 'Contra', entries: [{ ledger_id: cc.id, debit_amount: 5 }, { ledger_id: bk.id, credit_amount: 1 }] } });
  await new Promise((r) => setTimeout(r, 150));
  log = (await req('GET', '/api/platform/activity-log', { token: admin })).json.data;
  assert(bad.status === 400 && log.filter((l) => l.action === 'POST /api/vouchers').length === 1, 'Rejected (unbalanced) voucher is not logged as a success');

  console.log('\n--- 7. Backup verification ---');
  const b = await createBackup({ notes: 'platform test' });
  const v = await req('POST', '/api/platform/backup/verify', { token: admin, body: { filename: b.data.filename } });
  assert(v.json.success && v.json.data.checks.find((c) => c.name.startsWith('SHA-256')).ok, 'Verify: checksum OK on untouched snapshot');
  assert(v.json.data.checks.find((c) => c.name === 'SQLite integrity_check')?.ok === true, 'Verify: snapshot opens and passes integrity_check');
  const snap = v.json.data.checks.find((c) => c.name.startsWith('Snapshot has the same data'));
  console.log(`  ℹ️  ${snap.detail}`);
  assert(snap.ok === true, 'Verify: snapshot contains the same vouchers/ledgers as the live DB (detects WAL-omission data loss)');
  const file = path.join(tmp, 'backups', b.data.filename);
  fs.appendFileSync(file, 'tamper');
  const v2 = await req('POST', '/api/platform/backup/verify', { token: admin, body: { filename: b.data.filename } });
  assert(v2.json.data.ok === false, 'Verify: tampered snapshot detected');

  console.log('\n--- 8. Accounting invariants unchanged by platform services ---');
  const after = {
    dr: (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s,
    cr: (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s,
    vouchers: (await get('SELECT COUNT(*) c FROM vouchers')).c
  };
  assert(after.dr === after.cr, 'Total Dr == total Cr across ledger', `${after.dr} / ${after.cr}`);
  assert(after.vouchers === before.vouchers + 1, 'Only the one intentionally posted voucher was added');
  assert((await get("SELECT COUNT(*) c FROM account_groups")).c === 28, '28 statutory groups still present');

  console.log('\n--- 8b. Scheduled reports ---');
  const sch = require('./core/scheduler');
  assert((await req('GET', '/api/platform/schedules')).status === 401, 'Schedules require login');
  assert((await req('POST', '/api/platform/schedules', { token: clerk, body: { name: 'x', dataset: 'vouchers', frequency: 'daily', hour: 8 } })).status === 403, 'Data Entry cannot create schedules');
  const bads = [
    { name: '', dataset: 'vouchers', frequency: 'daily', hour: 8 },
    { name: 'a', dataset: 'users', frequency: 'daily', hour: 8 },
    { name: 'a', dataset: 'vouchers', frequency: 'hourly', hour: 8 },
    { name: 'a', dataset: 'vouchers', frequency: 'daily', hour: 24 },
    { name: 'a', dataset: 'vouchers', frequency: 'daily', hour: 8, params: { from_date: "2026-01-01'; DROP" } }
  ];
  let allRejected = true;
  for (const b of bads) if ((await req('POST', '/api/platform/schedules', { token: admin, body: b })).status !== 400) allRejected = false;
  assert(allRejected, 'Invalid schedule definitions are rejected (name, dataset, frequency, hour, date params)');
  const mk = await req('POST', '/api/platform/schedules', { token: admin, body: { name: 'Daily vouchers', dataset: 'vouchers', frequency: 'daily', hour: 8 } });
  assert(mk.json.success && mk.json.data.next_run_at, 'Schedule created with a next-run time');
  const sid = mk.json.data.id;
  const runNow = await req('POST', `/api/platform/schedules/${sid}/run`, { token: admin });
  assert(runNow.json.success && runNow.json.data.status === 'ok' && runNow.json.data.rows === (await get('SELECT COUNT(*) c FROM vouchers')).c, 'Run-now generates a report with correct row count');
  const outs = (await req('GET', `/api/platform/schedules/${sid}/outputs`, { token: admin })).json.data;
  const dl = await req('GET', `/api/platform/outputs/${outs[0].id}/download`, { token: admin });
  assert(dl.status === 200 && dl.raw.startsWith('﻿Date,Type'), 'Generated report downloads as CSV');
  // due-run: force next_run_at into the past
  await run("UPDATE scheduled_reports SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [sid]);
  const due = await sch.runDueSchedules();
  assert(due.length === 1 && due[0].status === 'ok', 'Due schedule runs automatically');
  assert((await sch.runDueSchedules()).length === 0, 'Schedule is not re-run until its next time');
  const nxt = (await get('SELECT next_run_at FROM scheduled_reports WHERE id = ?', [sid])).next_run_at;
  assert(Date.parse(nxt) > Date.now(), 'Next run advanced into the future', nxt);
  await req('POST', `/api/platform/schedules/${sid}/toggle`, { token: admin });
  await run("UPDATE scheduled_reports SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [sid]);
  assert((await sch.runDueSchedules()).length === 0, 'Paused schedule does not run');
  const n1 = sch.computeNextRun('monthly', 8, new Date(2026, 0, 31, 9));
  assert(n1.getMonth() === 1 && n1.getDate() === 28, 'Monthly schedule clamps 31st to end of February', n1.toString());
  const n2 = sch.computeNextRun('daily', 8, new Date(2026, 5, 1, 7));
  assert(n2.getDate() === 1 && n2.getHours() === 8, 'Daily schedule before the hour runs the same day');
  assert((await req('DELETE', `/api/platform/schedules/${sid}`, { token: viewer })).status === 403, 'Only Owner-level roles may delete schedules');
  assert((await req('DELETE', `/api/platform/schedules/${sid}`, { token: admin })).status === 200 && (await get('SELECT COUNT(*) c FROM report_outputs WHERE schedule_id = ?', [sid])).c === 0, 'Delete removes schedule and its stored outputs');

  console.log('\n--- 8c. Printable invoice ---');
  const { amountInWords } = require('./core/invoice');
  assert(amountInWords(407100) === 'Four Lakh Seven Thousand One Hundred Rupees Only', 'Amount in words (lakh format)', amountInWords(407100));
  assert(amountInWords(1250.5) === 'One Thousand Two Hundred Fifty Rupees and Fifty Paise Only', 'Amount in words with paise', amountInWords(1250.5));
  assert(amountInWords(10000000) === 'One Crore Rupees Only', 'Amount in words (crore)');
  const sale = await get("SELECT id FROM vouchers WHERE voucher_no = 'RRE/SALES/001'");
  assert((await req('GET', `/api/platform/invoice/${sale.id}`)).status === 401, 'Invoice requires login');
  const inv = await req('GET', `/api/platform/invoice/${sale.id}`, { token: admin });
  assert(inv.status === 200 && inv.headers['content-type'].includes('text/html'), 'Invoice returned as HTML');
  assert(inv.raw.includes('TAX INVOICE') && inv.raw.includes('RRE/SALES/001') && inv.raw.includes('4,07,100.00') && inv.raw.includes('33AABCC1234F1Z1'), 'Invoice shows number, Indian-format total and party GSTIN');
  assert(inv.raw.includes('Output CGST 9%') && inv.raw.includes('31,050.00'), 'Invoice lists GST lines from the voucher');
  await run("UPDATE ledgers SET name = '<script>alert(1)</script>' WHERE id = (SELECT party_ledger_id FROM vouchers WHERE id = ?)", [sale.id]);
  const inv2 = await req('GET', `/api/platform/invoice/${sale.id}`, { token: admin });
  assert(!inv2.raw.includes('<script>alert(1)') && inv2.raw.includes('&lt;script&gt;'), 'Invoice HTML-escapes party data (no script injection)');
  assert((await req('GET', '/api/platform/invoice/999999', { token: admin })).status === 404, 'Unknown voucher -> 404');
  await run("UPDATE ledgers SET name = 'Chennai Auto Components Pvt Ltd' WHERE name LIKE '<script>%'");

  console.log('\n--- 9. Backup / restore round-trip (WAL-safe) ---');
  const bGood = await createBackup({ notes: 'round-trip' });
  const vGood = await req('POST', '/api/platform/backup/verify', { token: admin, body: { filename: bGood.data.filename } });
  const snapGood = vGood.json.data.checks.find((c) => c.name.startsWith('Snapshot has the same data'));
  assert(snapGood.ok === true && vGood.json.data.ok === true, 'Fresh snapshot contains all live data', snapGood.detail);
  const vCountAtBackup = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const post2 = await req('POST', '/api/vouchers', { token: admin, body: { voucher_type: 'Contra', voucher_no: 'T/CON/2', date: '2026-06-03', entries: [
    { ledger_id: cc.id, debit_amount: 7 }, { ledger_id: bk.id, credit_amount: 7 }] } });
  assert(post2.json.success && (await get('SELECT COUNT(*) c FROM vouchers')).c === vCountAtBackup + 1, 'Voucher added after the snapshot');
  const rest = await req('POST', '/api/backup/restore', { token: admin, body: { filename: bGood.data.filename } });
  assert(rest.json && rest.json.success, 'Restore succeeds', rest.raw.slice(0, 150));
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === vCountAtBackup, 'Restore returns database to the snapshot state');
  assert((await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no='T/CON/2'")).c === 0, 'Post-snapshot voucher is gone after restore');
  assert((await get('SELECT COUNT(*) c FROM account_groups')).c === 28 && (await get('SELECT COUNT(*) c FROM ledgers')).c > 0, 'Masters intact after restore');
  const mig = await get("SELECT COUNT(*) c FROM schema_migrations");
  assert(mig.c === 21, 'Migrations table survives restore', String(mig.c));
  // the safety rollback taken just before the restore must itself hold the post-snapshot voucher
  const rb = fs.readdirSync(path.join(tmp, 'backups')).filter((f) => f.startsWith('rollback_pre_restore_')).sort().pop();
  const sq = require('sqlite3');
  const rbDb = await new Promise((res, rej) => { const d = new sq.Database(path.join(tmp, 'backups', rb), sq.OPEN_READONLY, (e) => (e ? rej(e) : res(d))); });
  const rbRow = await new Promise((res, rej) => rbDb.get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no='T/CON/2'", (e, r) => (e ? rej(e) : res(r))));
  rbDb.close();
  assert(rbRow.c === 1, 'Pre-restore rollback snapshot preserved the un-backed-up voucher (no data loss on restore)');
  assert((await req('GET', '/api/platform/notifications', { token: admin })).status === 200, 'App fully functional after restore');

  console.log('\n--- 10. Server-side authorisation on EXISTING routes ---');
  const { createSessionToken } = require('./core/security');
  const status = async (m, p, tok, body) => (await req(m, p, { token: tok, body })).status;
  const wasVouchers = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const unauth = [
    ['GET', '/api/masters/ledgers'], ['GET', '/api/vouchers'], ['GET', '/api/vouchers/1'], ['GET', '/api/reports/daybook'],
    ['GET', '/api/reports/trial-balance'], ['GET', '/api/dashboard/tiles'], ['GET', '/api/ai/insights'],
    ['POST', '/api/vouchers'], ['DELETE', '/api/vouchers/1'], ['POST', '/api/masters/ledgers'],
    ['GET', '/api/backup/list'], ['POST', '/api/backup/create'], ['POST', '/api/backup/restore'],
    ['GET', '/api/auth/users'], ['POST', '/api/auth/users'], ['DELETE', '/api/auth/users/2'], ['GET', '/api/auth/audit-log'],
    ['POST', '/api/company/clean-slate'], ['POST', '/api/company/load-demo'], ['POST', '/api/company/update'],
    ['GET', '/api/export/tally-xml'], ['GET', '/api/system/logs'], ['POST', '/api/system/perform-update'],
    ['POST', '/api/reports/bank-reconciliation/clear'], ['POST', '/api/ai/parse-voucher'], ['GET', '/api/api-that-does-not-exist']
  ];
  let allBlocked = true; const leaked = [];
  for (const [m, p] of unauth) { const s_ = await status(m, p); if (s_ !== 401) { allBlocked = false; leaked.push(`${m} ${p}=${s_}`); } }
  assert(allBlocked, `All ${unauth.length} sampled existing routes reject requests without a token (401)`, leaked.join('; '));
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === wasVouchers, 'Rejected requests changed no data');

  assert((await status('GET', '/api/health')) === 200, 'Public: /api/health');
  assert((await status('GET', '/api/gateway/info')) === 200, 'Public: /api/gateway/info');
  assert((await status('GET', '/api/auth/permissions?role=Viewer')) === 200, 'Public: /api/auth/permissions');
  assert((await status('POST', '/api/auth/login', null, { username: 'admin', password: PW.admin })) === 200, 'Public: login still works');
  assert((await status('GET', '/app.js')) === 200 && (await status('GET', '/ext/platform.js')) === 200, 'Static UI files still served without a token');
  assert((await req('POST', '/', { body: {} })).status === 200, 'Tally XML gateway (external connectors) behaviour unchanged');

  const expired = createSessionToken({ id: 1, username: 'admin', role: 'Owner' }, -1);
  assert((await status('GET', '/api/masters/ledgers', expired)) === 401, 'Expired token rejected');
  assert((await status('GET', '/api/masters/ledgers', admin.slice(0, -3) + 'abc')) === 401, 'Tampered token rejected');
  assert((await status('GET', '/api/masters/ledgers', 'offline_token_123')) === 401, 'Browser-only offline token rejected by server');

  const accountant = await login('accountant', PW.accountant);
  const auditor = await login('auditor', PW.auditor);
  const guest = createSessionToken({ id: 99, username: 'guest', role: 'Guest' }); // one-click guest entry is on by default
  const ctr = (n) => ({ voucher_type: 'Contra', voucher_no: 'T/ROLE/' + n, date: '2026-06-04', entries: [{ ledger_id: cc.id, debit_amount: 1 }, { ledger_id: bk.id, credit_amount: 1 }] });

  // Owner keeps full access
  const own = await req('POST', '/api/vouchers', { token: admin, body: ctr('own') });
  assert(own.status === 200 && (await status('GET', '/api/reports/trial-balance', admin)) === 200 && (await status('GET', '/api/backup/list', admin)) === 200 && (await status('GET', '/api/auth/users', admin)) === 200, 'Owner: post voucher, view TB, backups, users');
  // Read-only roles
  for (const [name, tok] of [['Viewer', viewer], ['Auditor', auditor], ['Guest', guest]]) {
    assert((await status('GET', '/api/masters/ledgers', tok)) === 200 && (await status('GET', '/api/reports/daybook', tok)) === 200, `${name}: can read ledgers and Day Book`);
    assert((await status('POST', '/api/vouchers', tok, ctr(name))) === 403, `${name}: cannot post vouchers`);
    assert((await status('POST', '/api/masters/ledgers', tok, { name: 'X' + name, group_id: 12 })) === 403, `${name}: cannot create masters`);
    assert((await status('DELETE', `/api/vouchers/${own.json.id}`, tok)) === 403, `${name}: cannot delete vouchers`);
  }
  assert((await status('GET', '/api/reports/trial-balance', guest)) === 200, 'Guest: financial reports visible (matches existing role definition)');
  // Data Entry
  assert((await status('GET', '/api/reports/trial-balance', clerk)) === 403 && (await status('GET', '/api/reports/profit-loss', clerk)) === 403, 'Data Entry: financial statements blocked');
  assert((await status('GET', '/api/reports/daybook', clerk)) === 200 && (await status('GET', '/api/reports/outstandings', clerk)) === 200, 'Data Entry: operational reports still available');
  assert((await status('POST', '/api/vouchers', clerk, ctr('clerk'))) === 200, 'Data Entry: can post an allowed voucher type (Contra)');
  assert((await status('POST', '/api/vouchers', clerk, { ...ctr('clerkj'), voucher_type: 'Journal' })) === 403, 'Data Entry: cannot post Journal (not in allowed types)');
  assert((await status('DELETE', `/api/vouchers/${own.json.id}`, clerk)) === 403, 'Data Entry: cannot delete vouchers');
  assert((await status('GET', '/api/backup/list', clerk)) === 403 && (await status('GET', '/api/auth/users', clerk)) === 403, 'Data Entry: no backups / user management');
  // Accountant
  assert((await status('POST', '/api/vouchers', accountant, { ...ctr('acc'), voucher_type: 'Journal' })) === 200, 'Accountant: can post Journal');
  assert((await status('GET', '/api/backup/list', accountant)) === 200 && (await status('POST', '/api/backup/restore', accountant, { filename: 'x' })) === 403, 'Accountant: can list backups, cannot restore');
  assert((await status('GET', '/api/auth/users', accountant)) === 403 && (await status('POST', '/api/company/clean-slate', accountant)) === 403 && (await status('POST', '/api/company/update', accountant, { name: 'Z' })) === 403, 'Accountant: no user management / clean slate / company alter');
  assert((await status('DELETE', `/api/vouchers/${own.json.id}`, accountant)) === 403, 'Accountant: cannot delete vouchers');
  assert((await status('DELETE', `/api/vouchers/${own.json.id}`, admin)) === 200, 'Owner: can delete a voucher');
  assert((await status('GET', '/api/system/logs', clerk)) === 403 && (await status('GET', '/api/auth/audit-log', viewer)) === 403, 'Log views limited to audit-capable roles');
  // 403s must not be recorded as successful activity, and must not break the invariant
  log = (await req('GET', '/api/platform/activity-log?limit=500', { token: admin })).json.data;
  assert(!log.some((l) => l.details && /T\/ROLE\/(Viewer|Auditor|Guest|clerkj)/.test(l.details)), 'Denied attempts are not logged as successful changes');
  const fin = { dr: (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr: (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s };
  assert(fin.dr === fin.cr, 'Total Dr == total Cr after all role tests', `${fin.dr}/${fin.cr}`);

  console.log('\n====================================================');
  console.log(`📊 PLATFORM RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

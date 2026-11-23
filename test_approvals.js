/**
 * Approval workflows: rules, holding, approving, rejecting, forged passes, import/recurring.
 * Runs against a DISPOSABLE data directory.   npm run test:approvals
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_appr_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(11700 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  await run('DELETE FROM vouchers'); await run('UPDATE ledgers SET opening_balance = 0 WHERE group_id IN (16, 17)');
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), rent = await L('Office Rent'), elec = await L('Factory Electricity Charges');
  const elgi = await L('Elgi Equipments Spares Ltd'), purAcc = await L('Purchase Account - Spares & Machines');
  const salesAcc = await L('Sales Account - Compressors'), chennai = await L('Chennai Auto Components Pvt Ltd');
  let n = 0;
  const purchase = (amt, token, no) => req('POST', '/api/vouchers', { token, body: { voucher_type: 'Purchase', voucher_no: no || `AP/${++n}`, date: '2026-04-10', party_ledger_id: elgi, entries: [{ ledger_id: purAcc, debit_amount: amt, credit_amount: 0 }, { ledger_id: elgi, debit_amount: 0, credit_amount: amt }] } });
  const payment = (ledger, amt, token) => req('POST', '/api/vouchers', { token, body: { voucher_type: 'Payment', voucher_no: `AP/${++n}`, date: '2026-04-11', entries: [{ ledger_id: ledger, debit_amount: amt, credit_amount: 0 }, { ledger_id: hdfc, debit_amount: 0, credit_amount: amt }] } });
  const vcount = async () => (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const balanced = async () => (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s === (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;

  console.log('\n--- 1. Rules: permissions and validation ---');
  const mk = (body, token = admin) => req('POST', '/api/approvals/rules', { token, body });
  assert((await mk({ name: 'Big purchase', kind: 'purchase_amount', threshold: 50000 }, acc)).status === 403 && (await mk({ name: 'Big purchase', kind: 'purchase_amount', threshold: 50000 }, clerk)).status === 403, 'Only the Owner can create rules');
  assert((await req('GET', '/api/approvals/rules', { token: null })).status === 401, 'Rules need a login');
  for (const [label, b] of [['short name', { name: 'x', kind: 'purchase_amount', threshold: 1 }], ['bad kind', { name: 'Some rule', kind: 'nope', threshold: 1 }], ['zero threshold', { name: 'Some rule', kind: 'purchase_amount', threshold: 0 }], ['null threshold', { name: 'Some rule', kind: 'purchase_amount', threshold: null }], ['discount 100', { name: 'Some rule', kind: 'sales_discount', threshold: 100 }], ['bad exempt role', { name: 'Some rule', kind: 'purchase_amount', threshold: 5, exempt_roles: ['King'] }]])
    assert((await mk(b)).status === 400, `Rejected: ${label}`);
  const r1 = (await mk({ name: 'Big purchase', kind: 'purchase_amount', threshold: 50000 })).json.data;
  assert(r1.id && r1.exempt_roles === 'Owner,Accountant' && r1.is_active === 1, 'Rule created; Owner and Accountant exempt by default');
  assert((await mk({ name: 'big PURCHASE', kind: 'purchase_amount', threshold: 1 })).status === 409, 'Duplicate rule name (any case) refused');
  assert((await req('PUT', `/api/approvals/rules/${r1.id}`, { body: { name: 'Big purchase', kind: 'purchase_amount', threshold: 40000 } })).json.data.threshold === 40000, 'Rule can be edited');
  await req('PUT', `/api/approvals/rules/${r1.id}`, { body: { name: 'Big purchase', kind: 'purchase_amount', threshold: 50000 } });

  console.log('\n--- 2. Holding ---');
  const before = await vcount();
  const held = await purchase(75000, clerk);
  assert(held.status === 202 && held.json.pending_approval && held.json.success === false && /Not posted yet/.test(held.json.error), 'Data Entry purchase over the limit is held (202, clearly "not posted")');
  assert(await vcount() === before, 'Nothing was posted');
  const reqId = held.json.request_id;
  assert((await purchase(50000, clerk)).json.success === true, 'Exactly at the threshold posts normally');
  assert((await purchase(60000, admin)).json.success === true && (await purchase(60000, acc)).json.success === true, 'Owner and Accountant are exempt');
  const rs = (await req('POST', '/api/approvals/rules', { body: { name: 'Expense cap', kind: 'expense_amount', threshold: 20000 } })).json.data;
  const rd = (await req('POST', '/api/approvals/rules', { body: { name: 'Discount cap', kind: 'sales_discount', threshold: 10 } })).json.data;
  const exp = await payment(rent, 30000, clerk);
  assert(exp.status === 202, 'Large expense payment by Data Entry is held');
  assert((await payment(chennai, 30000, clerk)).json.success === true, 'A payment to a non-expense ledger is not caught by the expense rule');
  assert((await payment(elec, 15000, clerk)).json.success === true, 'Expense under the cap posts');
  const disc = await req('POST', '/api/vouchers', { token: clerk, body: { voucher_type: 'Sales', voucher_no: `AP/${++n}`, date: '2026-04-12', party_ledger_id: chennai, entries: [{ ledger_id: chennai, debit_amount: 1000, credit_amount: 0 }, { ledger_id: salesAcc, debit_amount: 0, credit_amount: 1000 }], inventory: [{ stock_item_id: 1, quantity: 1, rate: 1000, discount_pct: 25 }] } });
  assert(disc.status === 202 && /Discount of 25%/.test(disc.json.error), 'Sales discount above the limit is held');
  const multi = await req('POST', '/api/vouchers', { token: clerk, body: { voucher_type: 'Purchase', voucher_no: `AP/${++n}`, date: '2026-04-12', party_ledger_id: elgi, entries: [{ ledger_id: purAcc, debit_amount: 90000, credit_amount: 0 }, { ledger_id: elgi, debit_amount: 0, credit_amount: 90000 }] } });
  assert(multi.status === 202, 'Held purchase recorded');
  await req('POST', `/api/approvals/rules/${r1.id}/active`, { body: { active: false } });
  assert((await purchase(90000, clerk)).json.success === true, 'A disabled rule no longer holds vouchers');
  await req('POST', `/api/approvals/rules/${r1.id}/active`, { body: { active: true } });
  assert((await purchase(90000, clerk)).status === 202, 'Re-enabled rule holds again');

  console.log('\n--- 3. Visibility ---');
  const pend = (await req('GET', '/api/approvals/requests', { token: acc })).json.data;
  assert(pend.length >= 4 && pend.every((p) => p.status === 'pending') && pend[0].summary.reasons.length, 'Approver sees pending requests with the reasons');
  assert((await req('GET', '/api/approvals/requests', { token: clerk })).status === 403, 'Data Entry cannot list everyone\'s requests');
  const mine = (await req('GET', '/api/approvals/mine', { token: clerk })).json.data;
  assert(mine.length === pend.length && mine.every((m) => m.requested_by === 'dataentry'), 'A user sees their own requests');
  assert((await req('GET', '/api/approvals/mine', { token: viewer })).json.data.length === 0, 'Another user sees none of them');
  const al = (await req('GET', '/api/platform/notifications', { token: acc })).json;
  assert(JSON.stringify(al).includes('waiting for approval'), 'The alerts bell shows pending approvals');

  console.log('\n--- 4. Approving ---');
  assert((await req('POST', `/api/approvals/requests/${reqId}/approve`, { token: clerk })).status === 403, 'Data Entry cannot approve');
  // make the requester an approver-capable person to test self-approval: the accountant requests a held voucher by being non-exempt
  await mk({ name: 'Accountant watch', kind: 'purchase_amount', threshold: 200000, exempt_roles: ['Owner'] });
  const accHeld = await purchase(250000, acc);
  assert(accHeld.status === 202, 'A non-exempt Accountant is held too');
  const selfA = await req('POST', `/api/approvals/requests/${accHeld.json.request_id}/approve`, { token: acc });
  assert(selfA.status === 403 && /own request/.test(selfA.json.error), 'Nobody can approve their own request');
  const vBefore = await vcount();
  const ok = await req('POST', `/api/approvals/requests/${reqId}/approve`, { token: acc, body: { note: 'ok, verified bill' } });
  assert(ok.status === 200 && ok.json.data.voucher_id, 'Approver approves; the voucher is posted', ok.raw);
  assert(await vcount() === vBefore + 1, 'Exactly one voucher was added');
  const v = await get('SELECT * FROM vouchers WHERE id = ?', [ok.json.data.voucher_id]);
  assert(v.voucher_type === 'Purchase' && v.total_amount === 75000, 'It is the held purchase, unchanged');
  const aud = await all(`SELECT action, username FROM activity_log WHERE action IN ('APPROVAL_REQUEST','APPROVAL_APPROVE','CREATE_VOUCHER') ORDER BY id DESC LIMIT 6`).catch(() => []);
  assert(aud.some((a) => a.action === 'APPROVAL_APPROVE' && a.username === 'accountant'), 'The approval is in the audit trail under the approver');
  assert((await get('SELECT status, decided_by, voucher_id FROM approval_requests WHERE id = ?', [reqId])).status === 'approved', 'The request is marked approved');
  const again = await req('POST', `/api/approvals/requests/${reqId}/approve`, { token: admin });
  assert(again.status === 409 && await vcount() === vBefore + 1, 'A second approval is refused and posts nothing more');
  const ledgerDup = await req('POST', `/api/approvals/requests/${reqId}/reject`, { token: admin, body: { note: 'late' } });
  assert(ledgerDup.status === 409, 'An approved request cannot then be rejected');

  console.log('\n--- 5. Concurrent approvals ---');
  const c0 = await vcount();
  const outs = await Promise.all([admin, acc, admin, acc].map((t) => req('POST', `/api/approvals/requests/${multi.json.request_id}/approve`, { token: t })));
  assert(outs.filter((o) => o.status === 200).length === 1 && await vcount() === c0 + 1, 'Four simultaneous approvals post exactly one voucher', outs.map((o) => o.status).join(','));

  console.log('\n--- 6. Rejecting and cancelling ---');
  const rej = await req('POST', `/api/approvals/requests/${exp.json.request_id}/reject`, { token: acc, body: {} });
  assert(rej.status === 400, 'Rejecting needs a reason');
  const v1 = await vcount();
  assert((await req('POST', `/api/approvals/requests/${exp.json.request_id}/reject`, { token: acc, body: { note: 'Not budgeted' } })).status === 200 && await vcount() === v1, 'Rejected: nothing posted');
  assert((await get('SELECT decision_note, status FROM approval_requests WHERE id = ?', [exp.json.request_id])).decision_note === 'Not budgeted', 'The reason is stored');
  assert((await req('POST', `/api/approvals/requests/${disc.json.request_id}/cancel`, { token: admin })).status === 403, 'Only the requester can cancel');
  assert((await req('POST', `/api/approvals/requests/${disc.json.request_id}/cancel`, { token: clerk })).status === 200, 'The requester cancels their own request');
  assert((await req('POST', `/api/approvals/requests/${disc.json.request_id}/approve`, { token: admin })).status === 409, 'A cancelled request cannot be approved');
  const selfRej = await req('POST', `/api/approvals/requests/${accHeld.json.request_id}/reject`, { token: acc, body: { note: 'x' } });
  assert(selfRej.status === 403, 'Rejecting your own request is refused (use Cancel)');

  console.log('\n--- 7. A failed post leaves the request open ---');
  const dupNo = 'AP/DUP';
  assert((await purchase(100, admin, dupNo)).json.success === true, 'Voucher number taken by another voucher');
  const heldDup = await purchase(95000, clerk, dupNo);
  assert(heldDup.status === 202 || heldDup.status === 400 || heldDup.status === 409, 'Duplicate number handled at submit or hold');
  if (heldDup.status === 202) {
    const fail = await req('POST', `/api/approvals/requests/${heldDup.json.request_id}/approve`, { token: admin });
    const row = await get('SELECT status, error FROM approval_requests WHERE id = ?', [heldDup.json.request_id]);
    assert(fail.status === 409 && row.status === 'pending' && row.error, 'Approve fails cleanly; request stays pending with the reason');
  } else assert(true, 'Duplicate refused before holding');

  console.log('\n--- 8. No back doors ---');
  const base0 = await vcount();
  const forged = await req('POST', '/api/vouchers', { token: clerk, headers: { 'X-RRE-Approval': '1.deadbeef' }, body: { voucher_type: 'Purchase', voucher_no: `AP/${++n}`, date: '2026-04-12', party_ledger_id: elgi, entries: [{ ledger_id: purAcc, debit_amount: 99000, credit_amount: 0 }, { ledger_id: elgi, debit_amount: 0, credit_amount: 99000 }] } });
  assert(forged.status === 202 && await vcount() === base0, 'A forged approval header is ignored; the voucher is held');
  const { signApprovalPass } = require('./core/security');
  const sneaky = await req('POST', '/api/vouchers', { token: clerk, headers: { 'X-RRE-Approval': `${reqId}.${signApprovalPass(reqId)}` }, body: { voucher_type: 'Purchase', voucher_no: `AP/${++n}`, date: '2026-04-12', party_ledger_id: elgi, entries: [{ ledger_id: purAcc, debit_amount: 99000, credit_amount: 0 }, { ledger_id: elgi, debit_amount: 0, credit_amount: 99000 }] } });
  assert(sneaky.status === 202 && await vcount() === base0, 'A genuine pass for an already-decided request cannot be reused');
  const csvText = 'voucher_ref,date,voucher_type,voucher_no,ledger,debit,credit,narration,reference_no,bill_ref\nA,2026-04-15,Purchase,IMP-AP-1,Purchase Account - Spares & Machines,99000,0,,,\nA,2026-04-15,Purchase,IMP-AP-1,Elgi Equipments Spares Ltd,0,99000,,,\n';
  const csv = await req('POST', '/api/import/preview', { token: clerk, body: { content: csvText, filename: 'ap.csv' } });
  assert(/Needs approval/.test(csv.raw), 'CSV preview flags a voucher that would need approval', csv.raw.slice(0, 200));
  const csvOwner = await req('POST', '/api/import/preview', { token: admin, body: { content: csvText.split('IMP-AP-1').join('IMP-AP-2'), filename: 'ap2.csv' } });
  assert(!/Needs approval/.test(csvOwner.raw), 'The same CSV is fine for an exempt Owner');

  console.log('\n--- 9. Integrity ---');
  assert(await balanced(), 'Debits equal credits across the books');
  const mg = (await get(`SELECT COUNT(*) c FROM schema_migrations`)).c;
  assert(mg === 12, 'Migrations applied: 12', 'got ' + mg);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

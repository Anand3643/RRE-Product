process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Branches, departments, tagging, budgets, credit limits and supplier performance.
 * Runs against a DISPOSABLE data directory with a controlled dataset.   npm run test:org
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_org_test_'));
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
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(11500 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  await run('DELETE FROM vouchers'); await run('UPDATE stock_items SET is_active = 0'); await run('UPDATE ledgers SET opening_balance = 0 WHERE group_id IN (16, 17)');
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), rent = await L('Office Rent'), salary = await L('Staff Salaries & Wages'), phone = await L('Telephone & Internet Charges'), elec = await L('Factory Electricity Charges'), bankCh = await L('Bank Charges');
  const chennai = await L('Chennai Auto Components Pvt Ltd'), southern = await L('Southern Textiles & Spinning Mills'), elgi = await L('Elgi Equipments Spares Ltd'), bharat = await L('Bharat Electric Motors Vendor'), pune = await L('Pune Pneumatics Industries');
  const salesAcc = await L('Sales Account - Compressors'), purAcc = await L('Purchase Account - Spares & Machines'), cash = await L('Cash');
  let n = 0;
  const V = async (type, date, party, lines, extra = {}, token = admin) => {
    n++;
    const r = await req('POST', '/api/vouchers', { token, body: { voucher_type: type, voucher_no: `OG/${n}`, date, party_ledger_id: party, entries: lines.map(([l, d, c, cc]) => ({ ledger_id: l, debit_amount: d, credit_amount: c, particulars: '', cost_centre_id: cc || null })), ...extra } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return r.json.id;
  };
  const pay = (date, ledger, amt, cc) => V('Payment', date, ledger, [[ledger, amt, 0, cc], [hdfc, 0, amt]]);
  const tag = (id, b, d) => run('UPDATE vouchers SET branch_id = ?, department_id = ? WHERE id = ?', [b || null, d || null, id]);
  const dr = async () => ((await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s === (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s);

  console.log('\n--- 1. Branches & departments ---');
  const post = (kind, body, token = admin) => req('POST', `/api/org/units/${kind}`, { token, body });
  assert((await post('branches', { code: 'MAA', name: 'Chennai HQ' }, clerk)).status === 403 && (await post('branches', { code: 'MAA', name: 'Chennai HQ' }, viewer)).status === 403, 'Data Entry and Viewer cannot create branches');
  for (const [label, b] of [['lower-case/odd code', { code: '-x', name: 'Valid Name' }], ['code too long', { code: 'ABCDEFGHIJKLM', name: 'Valid Name' }], ['name too short', { code: 'OK1', name: 'x' }], ['no code', { name: 'Valid Name' }]])
    assert((await post('branches', b)).status === 400, `Rejected: ${label}`);
  const maa = (await post('branches', { code: 'maa', name: 'Chennai HQ', address: 'Anna Salai', state_code: '33' })).json.data;
  assert(maa.code === 'MAA' && maa.is_active === 1, 'Branch created (code upper-cased)');
  const blr = (await post('branches', { code: 'BLR', name: 'Bengaluru Depot', state_code: '29' })).json.data;
  assert((await post('branches', { code: 'MAA', name: 'Other' })).status === 409 && (await post('branches', { code: 'XYZ', name: 'chennai hq' })).status === 409, 'Duplicate code or name (any case) refused');
  const adm = (await post('departments', { code: 'ADM', name: 'Administration' })).json.data, sal = (await post('departments', { code: 'SAL', name: 'Sales' })).json.data, prd = (await post('departments', { code: 'PRD', name: 'Production' })).json.data;
  assert(adm && sal && prd, 'Three departments created');
  assert((await req('PUT', `/api/org/units/branches/${blr.id}`, { token: acc, body: { code: 'BLR', name: 'Bengaluru Depot Ltd', state_code: '29' } })).json.data.name === 'Bengaluru Depot Ltd', 'Accountant can edit a branch');
  assert((await req('PUT', '/api/org/units/branches/99999', { body: { code: 'ZZ', name: 'Nowhere' } })).status === 404 && (await req('GET', '/api/org/units/nonsense')).status === 404, 'Unknown branch / resource -> 404');
  const lst = (await req('GET', '/api/org/units/branches', { token: viewer })).json.data;
  assert(lst.length === 2 && lst[0].vouchers === 0, 'Anyone logged in can list branches; each shows its voucher count');
  const spare = (await post('departments', { code: 'OLD', name: 'Closed Dept' })).json.data;
  assert((await req('POST', `/api/org/units/departments/${spare.id}/active`, { body: { active: false } })).status === 200 && (await req('GET', '/api/org/units/departments')).json.data.find((d) => d.id === spare.id).is_active === 0, 'A department can be switched off (never deleted)');

  console.log('\n--- 2. Tagging vouchers ---');
  const v1 = await pay('2026-08-01', rent, 20000), v2 = await pay('2026-08-02', salary, 50000), v3 = await pay('2026-08-03', salary, 40000);
  const before = await get('SELECT COUNT(*) c, ROUND(SUM(total_amount),2) s FROM vouchers');
  const tg = (b, token = admin) => req('POST', '/api/org/tag', { token, body: b });
  assert((await tg({ voucher_ids: [v1], branch_id: maa.id }, clerk)).status === 403, 'Data Entry cannot tag vouchers');
  assert((await tg({ voucher_ids: [], branch_id: maa.id })).status === 400 && (await tg({ voucher_ids: [v1] })).status === 400, 'Empty list / nothing to apply rejected');
  assert((await tg({ voucher_ids: [v1], branch_id: 999 })).status === 404 && (await tg({ voucher_ids: [v1], department_id: spare.id })).status === 400, 'Unknown branch -> 404; a switched-off department is refused');
  const t1 = await tg({ voucher_ids: [v1, v2, 424242], branch_id: maa.id });
  assert(t1.json.data.tagged === 2 && t1.json.data.requested === 3, 'Two of three ids matched and were tagged (unknown id ignored)');
  assert((await tg({ voucher_ids: [v1], department_id: adm.id })).json.data.tagged === 1 && (await tg({ voucher_ids: [v2, v3], department_id: sal.id })).json.data.tagged === 2, 'Departments tagged independently of branches');
  const row = await get('SELECT branch_id, department_id FROM vouchers WHERE id = ?', [v1]);
  assert(row.branch_id === maa.id && row.department_id === adm.id, 'A voucher carries both tags');
  assert((await tg({ voucher_ids: [v3], clear: true })).json.data.tagged === 1 && (await get('SELECT branch_id, department_id FROM vouchers WHERE id = ?', [v3])).branch_id === null, 'Tags can be cleared');
  await tg({ voucher_ids: [v3], branch_id: blr.id });
  const after = await get('SELECT COUNT(*) c, ROUND(SUM(total_amount),2) s FROM vouchers');
  assert(after.c === before.c && after.s === before.s && await dr(), 'Tagging changes no amounts, ledgers or balances');
  assert((await req('GET', '/api/org/units/branches')).json.data.find((b) => b.id === maa.id).vouchers === 2, 'Branch voucher count follows the tags');

  console.log('\n--- 3. Default branch/department for a user (auto-tag on posting) ---');
  assert((await req('POST', '/api/org/defaults', { token: clerk, body: { branch_id: 999 } })).status === 400 && (await req('POST', '/api/org/defaults', { token: clerk, body: { department_id: spare.id } })).status === 400, 'Unknown or switched-off defaults refused');
  assert((await req('POST', '/api/org/defaults', { token: clerk, body: { branch_id: blr.id, department_id: prd.id } })).status === 200 && (await req('GET', '/api/org/defaults', { token: clerk })).json.data.branch_id === blr.id, 'Data Entry sets their own default (BLR / Production)');
  const cv = await req('POST', '/api/vouchers', { token: clerk, body: { voucher_type: 'Payment', voucher_no: 'OG/AUTO', date: '2026-08-05', party_ledger_id: elec, entries: [{ ledger_id: elec, debit_amount: 8000 }, { ledger_id: hdfc, credit_amount: 8000 }] } });
  assert(cv.status === 200 && cv.json.success && cv.json.id, 'The existing voucher API still answers normally (success + id)');
  const auto = await get('SELECT branch_id, department_id FROM vouchers WHERE voucher_no = ?', ['OG/AUTO']);
  assert(auto.branch_id === blr.id && auto.department_id === prd.id, 'The voucher was tagged with the poster\'s defaults by the time the response arrived');
  const none = await req('POST', '/api/vouchers', { body: { voucher_type: 'Payment', voucher_no: 'OG/NODEF', date: '2026-08-05', party_ledger_id: phone, entries: [{ ledger_id: phone, debit_amount: 1 }, { ledger_id: hdfc, credit_amount: 1 }] } });
  assert((await get('SELECT branch_id FROM vouchers WHERE voucher_no = ?', ['OG/NODEF'])).branch_id === null, 'A user with no default leaves the voucher untagged');
  const bad = await req('POST', '/api/vouchers', { token: clerk, body: { voucher_type: 'Payment', voucher_no: 'OG/BAD', date: '2026-08-05', entries: [{ ledger_id: elec, debit_amount: 5 }, { ledger_id: hdfc, credit_amount: 1 }] } });
  assert(bad.status === 400 && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no = 'OG/BAD'")).c === 0, 'A rejected (unbalanced) voucher is still rejected normally');
  await run("DELETE FROM vouchers WHERE voucher_no IN ('OG/AUTO', 'OG/NODEF')");

  console.log('\n--- 4. Expense reports by department / branch / cost centre ---');
  await run('DELETE FROM vouchers');
  const e1 = await pay('2026-08-01', rent, 20000, 1), e2 = await pay('2026-08-02', salary, 50000), e3 = await pay('2026-08-03', salary, 40000);
  const e4 = await pay('2026-08-05', elec, 8000, 2), e5 = await pay('2026-08-04', phone, 4000), e6 = await pay('2026-08-06', bankCh, 3000), e7 = await pay('2026-07-15', rent, 999);
  await tag(e1, maa.id, adm.id); await tag(e2, maa.id, sal.id); await tag(e3, blr.id, sal.id); await tag(e4, blr.id, prd.id); await tag(e5, maa.id, adm.id);
  const ex = async (q) => (await req('GET', `/api/org/expenses?${q}`, { token: viewer })).json.data;
  let r = await ex('by=department&from_date=2026-08-01&to_date=2026-08-31');
  const D = Object.fromEntries(r.rows.map((x) => [x.dimension, x]));
  assert(D['Administration'].amount === 24000 && D['Sales'].amount === 90000 && D['Production'].amount === 8000 && D.Unassigned.amount === 3000 && r.total === 125000, 'By department (August): Admin ₹24,000 (rent + phone), Sales ₹90,000, Production ₹8,000, Unassigned ₹3,000; total ₹1,25,000', JSON.stringify(r.rows.map((x) => [x.dimension, x.amount])));
  assert(near(D['Sales'].share_pct, 72) && D['Sales'].ledgers[0].ledger === 'Staff Salaries & Wages' && D['Sales'].ledgers[0].amount === 90000, 'Share of total (72%) and the ledger breakdown are shown');
  assert(r.rows[0].dimension === 'Sales' && r.rows.map((x) => x.amount).join() === [...r.rows.map((x) => x.amount)].sort((a, b) => b - a).join(), 'Largest first');
  r = await ex('by=branch&from_date=2026-08-01&to_date=2026-08-31');
  const B = Object.fromEntries(r.rows.map((x) => [x.dimension, x.amount]));
  assert(B['Chennai HQ'] === 74000 && B['Bengaluru Depot Ltd'] === 48000 && B.Unassigned === 3000, 'By branch: Chennai ₹74,000, Bengaluru ₹48,000, Unassigned ₹3,000', JSON.stringify(B));
  r = await ex('by=cost_centre&from_date=2026-08-01&to_date=2026-08-31');
  const C = Object.fromEntries(r.rows.map((x) => [x.dimension, x.amount]));
  assert(C['Compressor Manufacturing Unit'] === 20000 && C['Customer Service & AMC Division'] === 8000 && C.Unassigned === 97000, 'By cost centre (tagged on the ledger lines): ₹20,000, ₹8,000 and the rest Unassigned');
  r = await ex('by=department');
  assert(r.total === 125999 && r.from === null, 'Without dates it covers everything (includes the July voucher)');
  assert((await req('GET', '/api/org/expenses?by=colour', { token: viewer })).status === 400 && (await req('GET', '/api/org/expenses?from_date=bad', { token: viewer })).status === 400, 'Unknown dimension / bad date rejected');
  assert((await req('GET', '/api/org/expenses?by=branch', { token: clerk })).status === 403, 'Data Entry cannot view expense reports');
  // branch summary with sales/purchases
  const s1 = await V('Sales', '2026-08-10', chennai, [[chennai, 100000, 0], [salesAcc, 0, 100000]]), s2 = await V('Sales', '2026-08-11', southern, [[southern, 60000, 0], [salesAcc, 0, 60000]]);
  const p1 = await V('Purchase', '2026-08-12', elgi, [[purAcc, 30000, 0], [elgi, 0, 30000]]);
  await tag(s1, maa.id); await tag(s2, blr.id); await tag(p1, maa.id);
  const bs = (await req('GET', '/api/org/branch-summary?from_date=2026-08-01&to_date=2026-08-31', { token: viewer })).json.data;
  const BS = Object.fromEntries(bs.rows.map((x) => [x.branch, x]));
  assert(BS['Chennai HQ'].sales === 100000 && BS['Chennai HQ'].purchases === 30000 && BS['Chennai HQ'].expenses === 74000 && BS['Chennai HQ'].surplus === -4000, 'Branch summary, Chennai: sales 1,00,000 − purchases 30,000 − expenses 74,000 = −4,000', JSON.stringify(BS['Chennai HQ']));
  assert(BS['Bengaluru Depot Ltd'].sales === 60000 && BS['Bengaluru Depot Ltd'].surplus === 12000 && BS.Unassigned.expenses === 3000 && bs.totals.sales === 160000, 'Bengaluru surplus ₹12,000; untagged expenses appear under Unassigned; totals add up');
  assert(/does not adjust for closing stock/.test(bs.note), 'States that it is a cash-style indicator, not the P&L');

  console.log('\n--- 5. Budgets ---');
  const bud = (b, token = admin) => req('POST', '/api/org/budgets', { token, body: b });
  assert((await bud({ ledger_id: cash, period_type: 'month', period_start: '2026-08-01', amount: 1000 })).status === 400, 'Only expense ledgers can be budgeted');
  for (const [label, b] of [['bad period type', { ledger_id: rent, period_type: 'week', period_start: '2026-08-01', amount: 1 }], ['monthly not on the 1st', { ledger_id: rent, period_type: 'month', period_start: '2026-08-15', amount: 1 }],
    ['bad date', { ledger_id: rent, period_type: 'month', period_start: '2026-13-01', amount: 1 }], ['zero amount', { ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 0 }], ['negative', { ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: -5 }],
    ['unknown department', { ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 5, department_id: 999 }]])
    assert([400, 404].includes((await bud(b)).status), `Rejected: ${label}`);
  assert((await bud({ ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 1000 }, clerk)).status === 403, 'Data Entry cannot set budgets');
  const bRent = (await bud({ ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 18000 }, acc)).json.data;
  const bSal = (await bud({ ledger_id: salary, department_id: sal.id, period_type: 'month', period_start: '2026-08-01', amount: 100000 })).json.data;
  const bSalBlr = (await bud({ ledger_id: salary, branch_id: blr.id, period_type: 'month', period_start: '2026-08-01', amount: 30000 })).json.data;
  const bElec = (await bud({ ledger_id: elec, period_type: 'year', period_start: '2026-04-01', amount: 100000 })).json.data;
  const bPhone = (await bud({ ledger_id: phone, period_type: 'month', period_start: '2026-08-01', amount: 10000 })).json.data;
  const bFuture = (await bud({ ledger_id: phone, period_type: 'month', period_start: '2026-09-01', amount: 5000 })).json.data;
  assert((await bud({ ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 5 })).status === 409, 'The same ledger/scope/period cannot be budgeted twice');
  const st = async (asOf) => Object.fromEntries((await req('GET', `/api/org/budgets?as_of=${asOf}`, { token: viewer })).json.data.budgets.map((b) => [b.id, b]));
  let S = await st('2026-08-10');
  assert(S[bRent.id].actual === 20000 && S[bRent.id].pct_used === 111.11 && S[bRent.id].status === 'over' && S[bRent.id].remaining === -2000, 'Rent: ₹20,000 against ₹18,000 => over (111.11%)', JSON.stringify(S[bRent.id]));
  assert(S[bSal.id].actual === 90000 && S[bSal.id].pct_used === 90 && S[bSal.id].status === 'near', 'Salaries for the Sales department: ₹90,000 of ₹1,00,000 => near');
  assert(S[bSalBlr.id].actual === 40000 && S[bSalBlr.id].status === 'over', 'Salaries budget for the Bengaluru branch counts only Bengaluru vouchers (₹40,000 of ₹30,000)');
  assert(S[bElec.id].actual === 8000 && S[bElec.id].status === 'ok' && S[bElec.id].to === '2027-03-31', 'Annual (financial-year) electricity budget runs 1 Apr 2026 – 31 Mar 2027; ₹8,000 used => ok');
  assert(S[bPhone.id].actual === 4000 && S[bPhone.id].pct_used === 40 && S[bPhone.id].projected === 12400 && S[bPhone.id].status === 'on_track_to_exceed', 'Telephone: ₹4,000 by day 10 projects to ₹12,400 (4,000 ÷ 10 × 31) against ₹10,000 => on track to exceed', JSON.stringify(S[bPhone.id]));
  assert(S[bFuture.id].status === 'not_started' && S[bFuture.id].actual === 0, 'A budget for a future month is "not started"');
  const bal0 = await dr();
  S = await st('2026-09-15');
  assert(S[bRent.id].period_complete && S[bRent.id].status === 'over' && S[bRent.id].projected === 20000, 'Once the month is over the status is final (still "over")');
  assert((await req('PUT', `/api/org/budgets/${bRent.id}`, { body: { ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 100000 } })).json.data.amount === 100000 && (await st('2026-08-10'))[bRent.id].status === 'ok', 'Editing a budget changes its status immediately (₹1,00,000 => ok)');
  await req('PUT', `/api/org/budgets/${bRent.id}`, { body: { ledger_id: rent, period_type: 'month', period_start: '2026-08-01', amount: 18000 } });
  const alerts = async () => (await req('GET', '/api/platform/notifications')).json.data.filter((x) => x.type === 'budget');
  const a1 = await alerts();
  const titles = a1.map((x) => x.title).join(' | ');
  assert(a1.length === 3 && /Over budget: Office Rent/.test(titles) && /Over budget: Staff Salaries & Wages \(branch Bengaluru/.test(titles) && /Budget nearly used: Staff Salaries & Wages \(dept Sales/.test(titles), 'The Alerts bell shows the three live budget alerts as at the books date (12 Aug); telephone (projected ₹10,333 vs ₹10,000) is within the 5% tolerance so it is not raised', titles);
  assert(a1.find((x) => /Over budget: Office Rent/.test(x.title)).severity === 'critical' && a1.find((x) => /nearly used/.test(x.title)).severity === 'warning', 'Over budget is critical; nearly used is a warning');
  await V('Payment', '2026-09-20', bankCh, [[bankCh, 1, 0], [hdfc, 0, 1]]);
  assert((await alerts()).length === 0, 'Once the books move past August the August budgets are complete and stop alerting');
  assert((await req('DELETE', `/api/org/budgets/${bFuture.id}`, { token: clerk })).status === 403 && (await req('DELETE', `/api/org/budgets/${bFuture.id}`, { token: acc })).status === 200 && (await req('DELETE', `/api/org/budgets/${bFuture.id}`)).status === 404, 'Budgets can be deleted by editors only; a second delete -> 404');
  assert(S && await dr() === bal0 && bal0, 'Budgets change no accounting figures');

  console.log('\n--- 6. Credit limits ---');
  const cl = (b, token = admin) => req('POST', '/api/org/credit-limits', { token, body: b });
  assert((await cl({ ledger_id: chennai, credit_limit: 100000 }, clerk)).status === 403, 'Data Entry cannot set credit limits');
  assert((await cl({ ledger_id: elgi, credit_limit: 5 })).status === 400 && (await cl({ ledger_id: 99999, credit_limit: 5 })).status === 404, 'Only customers can have a limit; unknown ledger -> 404');
  for (const bad of [-1, 'abc', null]) assert((await cl({ ledger_id: chennai, credit_limit: bad })).status === 400, `Invalid limit rejected: ${bad}`);
  assert((await cl({ ledger_id: chennai, credit_limit: 120000 }, acc)).status === 200 && (await cl({ ledger_id: southern, credit_limit: 50000 })).status === 200, 'Limits set: Chennai ₹1,20,000, Southern ₹50,000');
  const cs = (await req('GET', '/api/org/credit-status?as_of=2026-09-15', { token: viewer })).json.data;
  const CS = Object.fromEntries(cs.customers.map((c) => [c.customer.split(' ')[0], c]));
  assert(CS.Chennai.balance === 100000 && CS.Chennai.pct_used === 83.33 && CS.Chennai.status === 'ok' && CS.Chennai.available === 20000, 'Chennai owes ₹1,00,000 of ₹1,20,000 (83.33%), ₹20,000 available');
  assert(CS.Southern.balance === 60000 && CS.Southern.status === 'over' && CS.Southern.available === -10000 && cs.customers[0].customer.startsWith('Southern'), 'Southern owes ₹60,000 against ₹50,000 => over; listed first');
  await cl({ ledger_id: chennai, credit_limit: 105000 });
  assert((await req('GET', '/api/org/credit-status', { token: viewer })).json.data.customers.find((c) => c.customer.startsWith('Chennai')).status === 'near', '≥ 90% of the limit is "near"');
  const chk = async (b, token = admin) => (await req('POST', '/api/org/credit-check', { token, body: b }));
  const c1 = await chk({ party_ledger_id: chennai, amount: 10000 }, clerk);
  assert(c1.status === 200 && c1.json.data.would_exceed === true && c1.json.data.balance_after === 110000 && /over the credit limit/.test(c1.json.data.message), 'Pre-posting check (open to Data Entry): adding ₹10,000 would put Chennai ₹5,000 over its limit');
  assert((await chk({ party_ledger_id: chennai, amount: 1000 })).json.data.would_exceed === false && (await chk({ party_ledger_id: bharat, amount: 1000 })).json.data.limit === 0 && (await chk({ party_ledger_id: 99999 })).status === 404, 'Within-limit sale passes; a customer with no limit says so; unknown ledger -> 404');
  const cn = (await req('GET', '/api/platform/notifications')).json.data.filter((x) => x.type === 'credit_limit');
  assert(cn.some((x) => /Over credit limit: Southern/.test(x.title) && x.severity === 'critical') && cn.some((x) => /Near credit limit: Chennai/.test(x.title)), 'The Alerts bell shows Southern (over) and Chennai (near)');
  await cl({ ledger_id: southern, credit_limit: 0 });
  assert(!(await req('GET', '/api/platform/notifications')).json.data.some((x) => /Southern/.test(x.title) && x.type === 'credit_limit'), 'Setting the limit to 0 removes the limit and clears its alert');
  await run('DELETE FROM bill_allocations');
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date) VALUES (?, ?, 'New Ref', 'CB-1', 100000, '2026-07-01')", [s1, chennai]);
  assert((await req('GET', '/api/org/credit-status?as_of=2026-09-15', { token: viewer })).json.data.customers.find((c) => c.customer.startsWith('Chennai')).overdue === 100000, 'Overdue amount (open bills past due) is shown beside the balance');

  console.log('\n--- 7. Supplier performance ---');
  await run('DELETE FROM vouchers'); await run('DELETE FROM bill_allocations');
  const item = async (name) => { await run('INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate) VALUES (?, 1, 1, ?, 18)', [name, '84148011']); return (await get('SELECT id FROM stock_items WHERE name = ?', [name])).id; };
  const W = await item('Perf Widget'), G = await item('Perf Gadget');
  const buy = (date, sup, it, qty, rate, bill) => V('Purchase', date, sup, [[purAcc, qty * rate, 0], [sup, 0, qty * rate]], { inventory: [{ stock_item_id: it, quantity: qty, rate, godown_id: 1 }], ...(bill ? { bill_allocations: [{ ledger_id: sup, bill_type: 'New Ref', bill_ref: bill.ref, amount: qty * rate, due_date: bill.due }] } : {}) });
  await buy('2026-06-01', elgi, W, 1000, 60); await buy('2026-07-01', elgi, W, 1000, 66, { ref: 'EL-OPEN', due: '2026-08-01' });
  await buy('2026-06-01', bharat, W, 1000, 55, { ref: 'BH-1', due: '2026-06-30' });
  await buy('2026-06-10', pune, G, 100, 500);
  await V('Debit Note', '2026-07-20', elgi, [[elgi, 6300, 0], [purAcc, 0, 6300]]);
  await V('Payment', '2026-06-21', bharat, [[bharat, 55000, 0], [hdfc, 0, 55000]], { bill_allocations: [{ ledger_id: bharat, bill_type: 'Agst Ref', bill_ref: 'BH-1', amount: 55000 }] });
  const sp = (await req('GET', '/api/org/supplier-performance?as_of=2026-08-31', { token: viewer })).json.data;
  const P = Object.fromEntries(sp.suppliers.map((s) => [s.supplier.split(' ')[0], s]));
  assert(sp.suppliers.length === 3 && sp.total_purchases === 126000 + 55000 + 50000 && near(sp.suppliers.reduce((s, x) => s + x.share_of_spend_pct, 0), 100, 0.05), 'Three suppliers; total purchases ₹2,31,000; shares add to 100%');
  const price = P.Elgi.components.find((c) => c.key === 'price'), ret = P.Elgi.components.find((c) => c.key === 'returns'), stab = P.Elgi.components.find((c) => c.key === 'stability');
  assert(near(price.value, 14.55, 0.01) && price.score === 42, 'Elgi pays ₹63 average vs the best ₹55 (Bharat): 14.55% above best => price score 42', JSON.stringify(price));
  assert(ret.value === 5 && ret.score === 60 && stab.value === 10 && stab.score === 50, 'Elgi: returns 5% (₹6,300 of ₹1,26,000) => 60; price rose 10% (60 → 66) => 50');
  assert(P.Elgi.score === 50 && P.Elgi.band === 'review', 'Elgi overall = (42×40 + 60×30 + 50×30) ÷ 100 = 49.8 => 50, "review"', String(P.Elgi.score));
  assert(P.Bharat.score === 100 && P.Bharat.band === 'strong' && P.Bharat.components.find((c) => c.key === 'price').value === 0, 'Bharat: cheapest, no returns, stable => 100 (strong)');
  const pp = P.Pune.components.find((c) => c.key === 'price');
  assert(pp.score === null && pp.value === null && P.Pune.score === 100, 'Pune is the only source of its item: the price component is left out (no comparison possible) and the score uses the others');
  assert(P.Bharat.avg_days_to_pay === 20, 'Bharat is paid 20 days after the bill (1 Jun → 21 Jun)');
  assert(P.Elgi.owed_now === 66000 && P.Elgi.bills === 2 && P.Elgi.avg_bill === 63000, 'Elgi: ₹66,000 still owed; 2 bills averaging ₹63,000');
  assert(sp.suppliers[0].supplier.startsWith('Elgi'), 'Largest spend first');
  assert(/no purchase orders or delivery dates/.test(sp.method), 'States what it cannot measure (delivery, quality)');
  assert((await req('GET', '/api/org/supplier-performance?from_date=2026-07-15&to_date=2026-08-31', { token: viewer })).json.data.suppliers.length === 1, 'A date range limits the suppliers (only the July Elgi purchase + debit note)');
  assert((await req('GET', '/api/org/supplier-performance?from_date=bad', { token: viewer })).status === 400 && (await req('GET', '/api/org/supplier-performance', { token: clerk })).status === 403, 'Bad dates rejected; Data Entry cannot view');

  console.log('\n--- 8. Integrity ---');
  assert(await dr(), 'Total Dr == total Cr');
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 15, 'Migration 009 recorded');
  void all; void wait; void e7;

  console.log('\n====================================================');
  console.log(`📊 ORG RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

/**
 * Recurring vouchers (human-confirmed drafts) and CSV voucher import (preview → atomic commit).
 * Runs against a DISPOSABLE data directory.   npm run test:bulk
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_bulk_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const recurring = require('./core/recurring');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(8600 + Math.floor(Math.random() * 150), '127.0.0.1');
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
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const rent = await L('Office Rent'), hdfc = await L('HDFC Bank Current A/c'), salaries = await L('Staff Salaries & Wages'), cash = await L('Cash'), phone = await L('Telephone & Internet Charges');
  const vcount = async () => (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const balanced = async () => { const d = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, c = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s; return d === c ? true : `${d}/${c}`; };

  console.log('\n=== RECURRING VOUCHERS ===');
  console.log('\n--- 1. Date arithmetic ---');
  assert(recurring.nextDue('2026-01-31', 'monthly', 31) === '2026-02-28' && recurring.nextDue('2026-02-28', 'monthly', 31) === '2026-03-31', 'Monthly from the 31st: Feb 28 then back to Mar 31 (anchor day kept)');
  assert(recurring.nextDue('2026-01-15', 'weekly') === '2026-01-22' && recurring.nextDue('2026-11-30', 'quarterly', 30) === '2027-02-28', 'Weekly +7 days; quarterly Nov 30 → Feb 28');
  assert(recurring.nextDue('2024-02-29', 'yearly', 29) === '2025-02-28' && recurring.nextDue('2025-02-28', 'yearly', 29) === '2026-02-28', 'Yearly from Feb 29 clamps to Feb 28');
  assert(recurring.nextDue('2026-12-15', 'monthly', 15) === '2027-01-15', 'December rolls into the next year');

  console.log('\n--- 2. Templates: validation & access ---');
  const start = addDays(TODAY, -75);
  const good = { name: 'Monthly rent', voucher_type: 'Payment', party_ledger_id: rent, frequency: 'monthly', start_date: start, narration: 'Office rent (recurring)', reference_no: 'RENT',
    entries: [{ ledger_id: rent, debit_amount: 45000 }, { ledger_id: hdfc, credit_amount: 45000 }] };
  const mk = (b, token = admin) => req('POST', '/api/recurring/templates', { token, body: b });
  assert((await req('GET', '/api/recurring/templates', { token: null })).status === 401, 'Requires login');
  assert((await mk(good, viewer)).status === 403, 'Viewer cannot create templates');
  assert((await mk({ ...good, voucher_type: 'Journal' }, clerk)).status === 403, 'Data Entry cannot create a Journal template (not an allowed type)');
  for (const [label, b] of [['empty name', { ...good, name: ' ' }], ['bad frequency', { ...good, frequency: 'daily' }], ['bad start date', { ...good, start_date: '2026-13-01' }],
    ['end before start', { ...good, end_date: addDays(start, -1) }], ['unbalanced', { ...good, entries: [{ ledger_id: rent, debit_amount: 5 }, { ledger_id: hdfc, credit_amount: 4 }] }],
    ['one line', { ...good, entries: [{ ledger_id: rent, debit_amount: 5 }] }], ['unknown ledger', { ...good, entries: [{ ledger_id: 99999, debit_amount: 5 }, { ledger_id: hdfc, credit_amount: 5 }] }],
    ['unknown type', { ...good, voucher_type: 'Bogus' }], ['both dr and cr', { ...good, entries: [{ ledger_id: rent, debit_amount: 5, credit_amount: 5 }, { ledger_id: hdfc, credit_amount: 0 }] }]])
    assert((await mk(b)).status === 400, `Rejected: ${label}`);
  assert((await get('SELECT COUNT(*) c FROM recurring_templates')).c === 0, 'Rejected templates leave nothing behind');

  console.log('\n--- 3. Drafts are created, not posted ---');
  const v0 = await vcount();
  const created = await mk(good, acc);
  assert(created.status === 200 && created.json.data.next_due !== null, 'Accountant creates a monthly rent template');
  const tid = created.json.data.id;
  let expected = 0, d = start; while (d <= TODAY) { expected++; d = recurring.nextDue(d, 'monthly', Number(start.slice(8))); }
  const drafts = (await req('GET', '/api/recurring/drafts')).json.data;
  assert(drafts.length === expected && expected >= 3, `One draft per missed month so far (${expected})`, `${drafts.length}`);
  assert(await vcount() === v0, 'NO voucher is posted when drafts are created');
  assert(drafts.every((x) => x.status === 'pending' && x.amount === 45000), 'All drafts pending with the template amount');
  const again = (await req('POST', '/api/recurring/run')).json.data;
  assert(again.drafts_created === 0 && (await req('GET', '/api/recurring/drafts')).json.data.length === expected, 'Running again creates no duplicates (idempotent)');
  const tpl = (await req('GET', '/api/recurring/templates')).json.data.find((t) => t.id === tid);
  assert(tpl.pending_drafts === expected && tpl.next_due > TODAY && tpl.amount === 45000, 'Template shows pending count and next due date in the future');
  const noti = (await req('GET', '/api/platform/notifications')).json.data;
  assert(noti.some((n) => n.type === 'recurring' && n.title.includes(`${expected} recurring`)), 'Notification centre tells you drafts are waiting');

  console.log('\n--- 4. Confirm / skip ---');
  const [d1, d2, d3] = drafts;
  assert((await req('POST', `/api/recurring/drafts/${d1.id}/confirm`, { token: viewer, body: {} })).status === 403, 'Viewer cannot confirm');
  const c1 = await req('POST', `/api/recurring/drafts/${d1.id}/confirm`, { token: acc, body: {} });
  assert(c1.status === 200 && c1.json.data.voucher_no === `REC/${tid}/${d1.due_date.replace(/-/g, '')}` && c1.json.data.total_amount === 45000, 'Confirm posts one voucher with a traceable number', JSON.stringify(c1.json));
  const pv = await get('SELECT * FROM vouchers WHERE id = ?', [c1.json.data.id]);
  const lines = await all('SELECT e.*, l.name FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?', [pv.id]);
  assert(pv.date === d1.due_date && pv.narration === 'Office rent (recurring)' && pv.voucher_type === 'Payment' && pv.party_ledger_id === rent, 'Voucher date = due date; narration, type and party from the template');
  assert(lines.length === 2 && lines.find((x) => x.name === 'Office Rent').debit_amount === 45000 && lines.find((x) => x.name === 'HDFC Bank Current A/c').credit_amount === 45000 && lines.every((x) => x.particulars === x.name), 'Dr Office Rent / Cr HDFC, with particulars filled in');
  const rr = await get('SELECT r.status, r.instrument_no FROM bank_reconciliation r WHERE r.ledger_entry_id = ?', [lines.find((x) => x.name.startsWith('HDFC')).id]);
  assert(rr && rr.status === 'Pending' && rr.instrument_no === 'RENT', 'Bank line is queued for reconciliation as Pending');
  assert((await get('SELECT status, voucher_id, actioned_by FROM recurring_drafts WHERE id = ?', [d1.id])).status === 'posted', 'Draft marked posted');
  assert((await req('POST', `/api/recurring/drafts/${d1.id}/confirm`, { body: {} })).status === 409 && (await vcount()) === v0 + 1, 'Confirming again is refused (409): no double posting');
  const [r1, r2] = await Promise.all([req('POST', `/api/recurring/drafts/${d2.id}/confirm`, { body: {} }), req('POST', `/api/recurring/drafts/${d2.id}/confirm`, { body: {} })]);
  assert([r1.status, r2.status].sort().join() === '200,409' && (await vcount()) === v0 + 2, 'Two simultaneous confirms: exactly one voucher is posted', `${r1.status},${r2.status}`);
  assert((await req('POST', `/api/recurring/drafts/${d3.id}/skip`, { token: viewer })).status === 403, 'Viewer cannot skip');
  assert((await req('POST', `/api/recurring/drafts/${d3.id}/skip`)).status === 200 && (await req('POST', `/api/recurring/drafts/${d3.id}/skip`)).status === 409, 'Skip works once; second skip refused');
  assert((await req('POST', `/api/recurring/drafts/${d3.id}/confirm`, { body: {} })).status === 409, 'A skipped draft cannot be confirmed');
  assert((await req('POST', '/api/recurring/drafts/99999/confirm', { body: {} })).status === 404, 'Unknown draft -> 404');
  const log = (await req('GET', '/api/platform/activity-log?limit=60')).json.data;
  assert(log.some((l) => l.action === 'RECURRING_CONFIRM' && l.username === 'accountant') && log.some((l) => l.action === 'RECURRING_SKIP'), 'Confirm and skip are in the activity log');

  console.log('\n--- 5. Amount override, catch-up, end date, pause ---');
  const sal = (await mk({ name: 'Salary', voucher_type: 'Payment', party_ledger_id: salaries, frequency: 'monthly', start_date: addDays(TODAY, -3), entries: [{ ledger_id: salaries, debit_amount: 100000 }, { ledger_id: hdfc, credit_amount: 100000 }] })).json.data;
  const sd = (await req('GET', '/api/recurring/drafts')).json.data.find((x) => x.template_id === sal.id);
  assert((await req('POST', `/api/recurring/drafts/${sd.id}/confirm`, { body: { amount: -5 } })).status === 400 && (await req('POST', `/api/recurring/drafts/${sd.id}/confirm`, { body: { amount: 'abc' } })).status === 400, 'Invalid override amounts rejected');
  assert((await req('POST', `/api/recurring/drafts/${sd.id}/confirm`, { body: { date: '31/12/2026' } })).status === 400, 'Invalid override date rejected');
  const co = await req('POST', `/api/recurring/drafts/${sd.id}/confirm`, { body: { amount: 98500, narration: 'Salary — one day unpaid leave' } });
  const cv = await get('SELECT total_amount, narration FROM vouchers WHERE id = ?', [co.json.data.id]);
  assert(co.status === 200 && cv.total_amount === 98500 && cv.narration.startsWith('Salary'), 'Amount and narration can be adjusted at confirmation (simple 2-line templates)');
  const three = (await mk({ name: 'Split', voucher_type: 'Journal', frequency: 'monthly', start_date: addDays(TODAY, -2), entries: [{ ledger_id: rent, debit_amount: 60 }, { ledger_id: phone, debit_amount: 40 }, { ledger_id: salaries, credit_amount: 100 }] })).json.data;
  const td = (await req('GET', '/api/recurring/drafts')).json.data.find((x) => x.template_id === three.id);
  assert((await req('POST', `/api/recurring/drafts/${td.id}/confirm`, { body: { amount: 50 } })).status === 400, 'Amount override refused on a multi-line template');
  assert((await req('POST', `/api/recurring/drafts/${td.id}/confirm`, { token: clerk, body: {} })).status === 403, 'Data Entry cannot confirm a Journal draft');
  assert((await req('POST', `/api/recurring/drafts/${td.id}/confirm`, { token: acc, body: {} })).status === 200, 'Accountant can confirm the Journal draft');
  const weekly = (await mk({ name: 'Weekly sub', voucher_type: 'Payment', frequency: 'weekly', start_date: addDays(TODAY, -400), entries: [{ ledger_id: phone, debit_amount: 100 }, { ledger_id: cash, credit_amount: 100 }] })).json.data;
  const cnt = async () => (await get('SELECT COUNT(*) c FROM recurring_drafts WHERE template_id = ?', [weekly.id])).c;
  assert(await cnt() === 12, 'A template 400 days behind creates at most 12 drafts per run (no flood)', String(await cnt()));
  await req('POST', '/api/recurring/run'); assert(await cnt() === 24, 'Each run catches up another 12 until current');
  for (let i = 0; i < 6; i++) await req('POST', '/api/recurring/run');
  assert((await get('SELECT next_due FROM recurring_templates WHERE id = ?', [weekly.id])).next_due > TODAY, 'Eventually caught up (next due is in the future)');
  const ended = (await mk({ name: 'Ended', voucher_type: 'Payment', frequency: 'monthly', start_date: addDays(TODAY, -100), end_date: addDays(TODAY, -40), entries: [{ ledger_id: phone, debit_amount: 5 }, { ledger_id: cash, credit_amount: 5 }] })).json.data;
  const et = await get('SELECT is_active, next_due FROM recurring_templates WHERE id = ?', [ended.id]);
  assert(et.is_active === 0 && et.next_due === null && (await get('SELECT COUNT(*) c FROM recurring_drafts WHERE template_id = ?', [ended.id])).c >= 2, 'Past end date: drafts up to the end date, then the template deactivates');
  const paused = (await mk({ name: 'Paused', voucher_type: 'Payment', frequency: 'monthly', start_date: addDays(TODAY, 20), entries: [{ ledger_id: phone, debit_amount: 5 }, { ledger_id: cash, credit_amount: 5 }] })).json.data;
  assert((await get('SELECT COUNT(*) c FROM recurring_drafts WHERE template_id = ?', [paused.id])).c === 0, 'Future start date: nothing due yet');
  await req('POST', `/api/recurring/templates/${paused.id}/toggle`);
  await run('UPDATE recurring_templates SET next_due = ? WHERE id = ?', [addDays(TODAY, -1), paused.id]);
  await req('POST', '/api/recurring/run');
  assert((await get('SELECT COUNT(*) c FROM recurring_drafts WHERE template_id = ?', [paused.id])).c === 0, 'A paused template creates no drafts');
  assert((await req('DELETE', `/api/recurring/templates/${paused.id}`, { token: acc })).status === 403 && (await req('DELETE', `/api/recurring/templates/${paused.id}`)).status === 200, 'Only an Owner-level role may delete a template');
  assert((await req('DELETE', '/api/recurring/templates/99999')).status === 404, 'Deleting an unknown template -> 404');

  console.log('\n=== CSV VOUCHER IMPORT ===');
  const hdr = 'voucher_ref,date,voucher_type,voucher_no,ledger,debit,credit,narration,reference_no,bill_ref\n';
  const pre = (content, token = admin) => req('POST', '/api/import/preview', { token, body: { content, filename: 'test.csv' } });
  const chennai = await L('Chennai Auto Components Pvt Ltd');

  console.log('\n--- 6. Template & preview (writes nothing) ---');
  const tpl2 = await req('GET', '/api/import/template');
  assert(tpl2.status === 200 && tpl2.raw.replace('﻿', '').startsWith('voucher_ref,date,voucher_type'), 'Template CSV downloads');
  const vBefore = await vcount();
  const good1 = tpl2.raw.replace('﻿', '');
  const p1 = await pre(good1);
  assert(p1.status === 200 && p1.json.data.summary.ok === 2 && p1.json.data.summary.errors === 0 && p1.json.data.summary.vouchers === 2, 'The downloadable template previews cleanly (2 vouchers)', JSON.stringify(p1.json.data?.summary));
  assert(await vcount() === vBefore, 'Preview writes NOTHING to the books');
  assert((await pre(good1, viewer)).status === 403 && (await req('POST', '/api/import/preview', { token: null, body: { content: good1 } })).status === 401, 'Preview needs login and the create-voucher permission');
  assert(p1.json.data.summary.total_amount === 45000 + 11800, 'Preview total = sum of voucher totals (₹56,800)');

  console.log('\n--- 7. Validation messages ---');
  const one = async (rows) => (await pre(hdr + rows)).json.data;
  let r = await one('X,2026-06-01,Payment,,Offce Rent,100,,,,\nX,,,,HDFC Bank Current A/c,,100,,,');
  assert(r.results[0].status === 'error' && /not found \(did you mean "Office Rent"/.test(r.results[0].errors[0]), 'Unknown ledger: names the row and suggests the closest ledger', r.results[0].errors[0]);
  r = await one('X,2026-06-01,Payment,,Office Rent,100,,,,\nX,,,,HDFC Bank Current A/c,,90,,,');
  assert(/Not balanced/.test(r.results[0].errors[0]), 'Unbalanced voucher rejected with both totals');
  r = await one('X,31-02-2026,Payment,,Office Rent,100,,,,\nX,,,,HDFC Bank Current A/c,,100,,,');
  assert(/Invalid date/.test(r.results[0].errors.join()), 'Impossible date rejected');
  r = await one('X,2026-06-01,Bogus,,Office Rent,100,,,,\nX,,,,HDFC Bank Current A/c,,100,,,');
  assert(/Unknown voucher type/.test(r.results[0].errors.join()), 'Unknown voucher type rejected');
  r = await one('X,2026-06-01,Payment,,Office Rent,100,100,,,\nX,,,,HDFC Bank Current A/c,,100,,,');
  assert(r.results[0].status === 'error', 'A line with both debit and credit rejected');
  r = await one('X,2026-06-01,Payment,,Office Rent,abc,,,,\nX,,,,HDFC Bank Current A/c,,100,,,');
  assert(/not a number/.test(r.results[0].errors.join()), 'Non-numeric amount rejected');
  r = await one('X,2026-06-01,Payment,,Office Rent,100,,,,\nX,2026-06-02,,,HDFC Bank Current A/c,,100,,,');
  assert(/Conflicting dates/.test(r.results[0].errors.join()), 'Conflicting dates within one voucher rejected');
  r = await one(',2026-06-01,Payment,,Office Rent,100,,,,');
  assert(/voucher_ref is blank/.test(r.results[0].errors[0]), 'Blank voucher_ref rejected');
  r = await one('A,2026-06-01,Payment,DUP-1,Office Rent,100,,,,\nA,,,,HDFC Bank Current A/c,,100,,,\nB,2026-06-01,Payment,DUP-1,Office Rent,100,,,,\nB,,,,HDFC Bank Current A/c,,100,,,');
  assert(r.results[1].status === 'error' && /appears twice/.test(r.results[1].errors.join()), 'Same voucher number twice in the file rejected');
  r = await one('A,2026-06-01,Payment,REC/1/X,Office Rent,100,,,,\nA,,,,HDFC Bank Current A/c,,100,,,');
  const existingNo = (await get("SELECT voucher_no FROM vouchers LIMIT 1")).voucher_no;
  r = await one(`A,2026-06-01,Payment,${existingNo},Office Rent,100,,,,\nA,,,,HDFC Bank Current A/c,,100,,,`);
  assert(/already exists in the books/.test(r.results[0].errors.join()), 'A voucher number already in the books rejected');
  r = await one('A,2026-06-01,Payment,,Office Rent,100,,,,');
  assert(r.results[0].status === 'error' && /at least two/.test(r.results[0].errors.join()), 'A single-line voucher rejected');
  assert((await pre('a,b\n1,2')).status === 400 && (await pre('')).status === 400, 'Wrong columns / empty file -> 400');
  r = await one('J,2026-06-01,Journal,,Office Rent,100,,,,\nJ,,,,Telephone & Internet Charges,,100,,,');
  assert(r.results[0].status === 'ok', 'Case-insensitive type and ledger names accepted'.replace('accepted', '(Journal ok)'));
  r = (await pre(hdr + 'q,2026-06-01,payment,,office rent,"1,00,000.50",,,,\nq,,,,hdfc bank current a/c,,"1,00,000.50",,,')).json.data;
  assert(r.results[0].status === 'ok' && r.results[0].total === 100000.5, 'Lower-case names and Indian-format amounts accepted');
  const clerkJ = (await pre(hdr + 'J,2026-06-01,Journal,,Office Rent,100,,,,\nJ,,,,Telephone & Internet Charges,,100,,,', clerk)).json.data;
  assert(clerkJ.results[0].status === 'error' && /may not post Journal/.test(clerkJ.results[0].errors.join()), 'Data Entry preview: Journal rows are errors (role check at preview time)');
  r = await one('C,2026-06-01,Contra,,Office Rent,100,,,,\nC,,,,Cash,,100,,,');
  assert(r.results[0].status === 'warning' && /cash and bank/.test(r.results[0].warnings.join()), 'Contra with a non-cash/bank ledger gets a warning');

  console.log('\n--- 8. Commit: posting, bills, GST, bank queue ---');
  const batch1 = p1.json.data.batch_id;
  assert((await req('POST', `/api/import/batches/${batch1}/commit`, { token: viewer, body: {} })).status === 403, 'Viewer cannot commit');
  const com = await req('POST', `/api/import/batches/${batch1}/commit`, { body: {} });
  assert(com.status === 200 && com.json.data.posted_count === 2 && com.json.data.posted[0].voucher_no === `IMP/${batch1}/0001`, 'Commit posts both vouchers with traceable numbers', com.raw.slice(0, 200));
  const sale = await get("SELECT * FROM vouchers WHERE voucher_no = ?", [`IMP/${batch1}/0002`]);
  const sl = await all('SELECT e.*, l.name FROM ledger_entries e JOIN ledgers l ON l.id=e.ledger_id WHERE e.voucher_id = ?', [sale.id]);
  assert(sale.voucher_type === 'Sales' && sale.party_ledger_id === chennai && sale.total_amount === 11800 && sale.reference_no === 'INV-77' && sl.length === 4 && sl.every((x) => x.particulars === x.name), 'Imported sale: party detected, 4 lines, particulars filled');
  const ba = await get('SELECT * FROM bill_allocations WHERE voucher_id = ?', [sale.id]);
  assert(ba && ba.bill_type === 'New Ref' && ba.bill_ref === 'INV-77' && ba.amount === 11800 && ba.due_date === addDays('2026-06-07', 30), 'Sales invoice opens a bill (New Ref) due after the customer\'s credit period');
  const outs = (await req('GET', '/api/reports/outstandings')).json.data;
  assert(outs.receivables.some((b) => b.bill_ref === 'INV-77' && b.pending_amount === 11800), 'The imported bill shows in Outstandings');
  const gst = (await req('GET', '/api/reports/gst')).json.data;
  assert(gst.gstr1.b2b_invoices.concat(gst.gstr1.b2c_invoices).some((x) => x.voucher_no === sale.voucher_no && x.taxable_value === 10000 && x.cgst === 900 && x.sgst === 900), 'The imported sale appears in GSTR-1 (taxable ₹10,000, CGST/SGST ₹900)');
  const payV = await get("SELECT id FROM vouchers WHERE voucher_no = ?", [`IMP/${batch1}/0001`]);
  const bankE = await get('SELECT e.id FROM ledger_entries e WHERE e.voucher_id = ? AND e.ledger_id = ?', [payV.id, hdfc]);
  assert((await get('SELECT status, instrument_no FROM bank_reconciliation WHERE ledger_entry_id = ?', [bankE.id])).instrument_no === 'CHQ-1001', 'Imported bank payment is queued for reconciliation with its cheque number');
  assert((await req('POST', `/api/import/batches/${batch1}/commit`, { body: {} })).status === 409, 'Committing the same batch twice is refused');
  assert((await req('POST', `/api/import/batches/${batch1}/discard`)).status === 404, 'A committed batch cannot be discarded');
  assert((await balanced()) === true, 'Total Dr == total Cr after the import');
  const p1b = await pre(good1);
  assert(p1b.json.data.results.every((x) => x.warnings.some((w) => /already imported/.test(w))), 'Re-previewing the same file warns that it was already imported');
  assert((await req('POST', `/api/import/batches/${p1b.json.data.batch_id}/commit`, { body: {} })).status === 400, 'Warned vouchers are not imported unless you explicitly include them');

  console.log('\n--- 9. Bill settlement via bill_ref ---');
  const rec = (await pre(hdr + `S,2026-06-20,Receipt,,HDFC Bank Current A/c,11800,,Received against INV-77,UTR9,INV-77\nS,,,,Chennai Auto Components Pvt Ltd,,11800,,,`)).json.data;
  assert(rec.summary.ok === 1, 'Receipt against a bill previews cleanly');
  await req('POST', `/api/import/batches/${rec.batch_id}/commit`, { body: {} });
  const outs2 = (await req('GET', '/api/reports/outstandings')).json.data;
  assert(!outs2.receivables.some((b) => b.bill_ref === 'INV-77'), 'Receipt with bill_ref settles the bill (no longer outstanding)');

  console.log('\n--- 10. Errors, skip_invalid, duplicates ---');
  const mixed = hdr + 'OK1,2026-06-10,Payment,,Office Rent,500,,,,\nOK1,,,,HDFC Bank Current A/c,,500,,,\nBAD1,2026-06-10,Payment,,Nowhere Ledger,500,,,,\nBAD1,,,,HDFC Bank Current A/c,,500,,,\nOK2,2026-06-11,Payment,,Telephone & Internet Charges,300,,,,\nOK2,,,,Cash,,300,,,';
  const pm = (await pre(mixed)).json.data;
  assert(pm.summary.ok === 2 && pm.summary.errors === 1, 'Mixed file: 2 valid, 1 invalid');
  const v1 = await vcount();
  assert((await req('POST', `/api/import/batches/${pm.batch_id}/commit`, { body: {} })).status === 400 && await vcount() === v1, 'Default commit is refused while any voucher has errors; nothing posted');
  const cs = await req('POST', `/api/import/batches/${pm.batch_id}/commit`, { body: { skip_invalid: true } });
  assert(cs.status === 200 && cs.json.data.posted_count === 2 && cs.json.data.skipped === 1 && await vcount() === v1 + 2, 'skip_invalid posts only the valid vouchers', cs.raw.slice(0, 300));
  const dupFile = hdr + 'D1,2026-06-12,Payment,,Office Rent,777,,,INV-DUP,\nD1,,,,HDFC Bank Current A/c,,777,,,';
  const first = (await pre(dupFile)).json.data; const fc = await req('POST', `/api/import/batches/${first.batch_id}/commit`, { body: {} }); void fc;
  const secondP = (await pre(dupFile.replace(/D1/g, 'D2'))).json.data;
  assert(secondP.results[0].status === 'warning' && /Possible duplicate/.test(secondP.results[0].warnings.join()), 'Same party + reference as an existing voucher => duplicate warning', JSON.stringify(secondP.results[0]));
  const v2 = await vcount();
  assert((await req('POST', `/api/import/batches/${secondP.batch_id}/commit`, { body: {} })).status === 400 && await vcount() === v2, 'Possible duplicates are held back by default');
  assert((await req('POST', `/api/import/batches/${secondP.batch_id}/commit`, { body: { include_warnings: true } })).status === 200 && await vcount() === v2 + 1, 'They can be included deliberately');
  const dis = (await pre(good1.replace(/R1|R2/g, (m) => m + 'x'))).json.data;
  assert((await req('POST', `/api/import/batches/${dis.batch_id}/discard`)).status === 200 && (await req('POST', `/api/import/batches/${dis.batch_id}/commit`, { body: { include_warnings: true } })).status === 409, 'A discarded batch cannot be committed');

  console.log('\n--- 11. All-or-nothing atomicity ---');
  const atom = hdr + 'T1,2026-06-15,Payment,ATOM-1,Office Rent,111,,,,\nT1,,,,HDFC Bank Current A/c,,111,,,\nT2,2026-06-15,Payment,ATOM-2,Office Rent,222,,,,\nT2,,,,HDFC Bank Current A/c,,222,,,\nT3,2026-06-15,Payment,ATOM-3,Office Rent,333,,,,\nT3,,,,HDFC Bank Current A/c,,333,,,';
  const pa = (await pre(atom)).json.data;
  assert(pa.summary.ok === 3, 'Three valid vouchers previewed');
  await req('POST', '/api/vouchers', { body: { voucher_type: 'Payment', voucher_no: 'ATOM-3', date: '2026-06-15', entries: [{ ledger_id: rent, debit_amount: 1 }, { ledger_id: hdfc, credit_amount: 1 }] } }); // someone grabs ATOM-3 after the preview
  const v3 = await vcount(), e3 = (await get('SELECT COUNT(*) c FROM ledger_entries')).c, br3 = (await get('SELECT COUNT(*) c FROM bank_reconciliation')).c;
  const bad = await req('POST', `/api/import/batches/${pa.batch_id}/commit`, { body: {} });
  assert(bad.status === 409 && /already exists/.test(bad.raw), 'Commit fails when a voucher number was taken after the preview');
  assert(await vcount() === v3 && (await get('SELECT COUNT(*) c FROM ledger_entries')).c === e3 && (await get('SELECT COUNT(*) c FROM bank_reconciliation')).c === br3 && (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no IN ('ATOM-1','ATOM-2')")).c === 0, 'ATOM-1 and ATOM-2 were rolled back: no vouchers, entries or bank rows left behind');
  assert((await get('SELECT status FROM import_batches WHERE id = ?', [pa.batch_id])).status === 'previewed', 'Batch is still "previewed" so it can be fixed and retried');
  const sim = (await pre(hdr + 'S1,2026-06-16,Payment,,Office Rent,10,,,,\nS1,,,,HDFC Bank Current A/c,,10,,,')).json.data;
  const [k1, k2] = await Promise.all([req('POST', `/api/import/batches/${sim.batch_id}/commit`, { body: {} }), req('POST', `/api/import/batches/${sim.batch_id}/commit`, { body: {} })]);
  assert([k1.status, k2.status].sort().join() === '200,409', 'Two simultaneous commits of one batch: exactly one wins', `${k1.status},${k2.status}`);

  console.log('\n--- 12. Volume ---');
  let big = hdr;
  for (let i = 0; i < 500; i++) big += `B${i},2026-07-${String((i % 27) + 1).padStart(2, '0')},Payment,,Office Rent,${100 + i},,Bulk ${i},,\nB${i},,,,HDFC Bank Current A/c,,${100 + i},,,\n`;
  const t0 = Date.now(); const pb = (await pre(big)).json.data; const t1 = Date.now();
  assert(pb.summary.ok === 500 && pb.summary.rows === 1000, `500 vouchers (1,000 rows) previewed in ${t1 - t0} ms`);
  const vb = await vcount(); const cb = await req('POST', `/api/import/batches/${pb.batch_id}/commit`, { body: {} }); const t2 = Date.now();
  assert(cb.status === 200 && cb.json.data.posted_count === 500 && await vcount() === vb + 500, `500 vouchers committed atomically in ${t2 - t1} ms`);
  assert((await balanced()) === true, 'Total Dr == total Cr after 500 imported vouchers');
  assert((await req('GET', '/api/import/batches')).json.data.length >= 10 && (await req('GET', `/api/import/batches/${pb.batch_id}`)).json.data.status === 'committed', 'Batch history is available');
  const log2 = (await req('GET', '/api/platform/activity-log?limit=500')).json.data;
  assert(log2.some((l) => l.action === 'IMPORT_COMMIT') && log2.some((l) => l.action === 'IMPORT_PREVIEW'), 'Previews and commits are in the activity log');
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 14, 'Migration 006 recorded');
  assert((await balanced()) === true, 'Books balanced at the end');

  console.log('\n====================================================');
  console.log(`📊 BULK RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

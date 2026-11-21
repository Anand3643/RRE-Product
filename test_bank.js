/**
 * Verification for bank statement import and smart reconciliation.
 * Runs against a DISPOSABLE data directory.   npm run test:bank
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_bank_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const bank = require('./core/bankTools');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb();
  await runMigrations();
  const info = await startServer(6200 + Math.floor(Math.random() * 200), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, role) => createSessionToken({ id, username: u, role });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer'), auditor = T(4, 'auditor', 'Auditor');

  function req(method, p, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request(base + p, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), cash = await L('Cash');
  const southern = await L('Southern Textiles & Spinning Mills'), bharat = await L('Bharat Electric Motors Vendor'), chennai = await L('Chennai Auto Components Pvt Ltd');
  const rent = await L('Office Rent');

  async function voucher(type, no, date, ref, party, bankSide, other, amt) {
    const bankDr = bankSide === 'Dr';
    const r = await req('POST', '/api/vouchers', { token: admin, body: { voucher_type: type, voucher_no: no, date, reference_no: ref, party_ledger_id: party,
      entries: [{ ledger_id: hdfc, debit_amount: bankDr ? amt : 0, credit_amount: bankDr ? 0 : amt }, { ledger_id: other, debit_amount: bankDr ? 0 : amt, credit_amount: bankDr ? amt : 0 }] } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return r.json.id;
  }
  await voucher('Receipt', 'BK/R1', '2026-06-05', 'UTR1234567', southern, 'Dr', southern, 50000);
  await voucher('Payment', 'BK/P1', '2026-06-06', 'CHQ-5001', bharat, 'Cr', bharat, 12000);
  await voucher('Payment', 'BK/P2', '2026-06-06', 'CHQ-5002', bharat, 'Cr', bharat, 12000);
  await voucher('Receipt', 'BK/R2', '2026-06-07', '', chennai, 'Dr', chennai, 7777);
  const oldId = await voucher('Payment', 'BK/OLD', '2026-01-10', 'CHQ-0001', rent, 'Cr', rent, 3000);
  const entryOf = async (no) => (await get('SELECT e.id FROM ledger_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.voucher_no=? AND e.ledger_id=?', [no, hdfc])).id;

  const counts = async () => ({
    v: (await get('SELECT COUNT(*) c FROM vouchers')).c, e: (await get('SELECT COUNT(*) c FROM ledger_entries')).c,
    dr: (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr: (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s
  });
  const base0 = await counts();

  console.log('\n--- 1. Statement parsing ---');
  const P = (csv) => { try { return bank.parseStatement(csv); } catch (e) { return { error: e.message }; } };
  let r = P('Txn Date,Narration,Chq/Ref No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n21/05/2026,X,R1,"1,000.50",,"9,999.50"\n22-May-2026,Y,R2,,250,10249.5');
  assert(r.lines?.length === 2 && r.lines[0].debit === 1000.5 && r.lines[1].credit === 250 && r.lines[0].date === '2026-05-21' && r.lines[1].date === '2026-05-22', 'Bank-style headers, Indian commas and mixed date formats parsed');
  r = P('Date,Description,Amount,Dr/Cr\n2026-05-01,A,500,DR\n2026-05-02,B,700,CR');
  assert(r.lines?.length === 2 && r.lines[0].debit === 500 && r.lines[1].credit === 700, 'Single Amount column with Dr/Cr type parsed');
  assert(P('Narration,Debit,Credit\nx,1,').error?.includes('No date column'), 'Missing date column rejected');
  assert(P('Date,Narration\n2026-01-01,x').error?.includes('Debit'), 'Missing amount columns rejected');
  assert(P('Date,Debit,Credit\n31-02-2026,5,').error?.includes('invalid date'), 'Impossible date rejected (names the row)');
  assert(P('Date,Debit,Credit\n2026-01-01,5,5').error?.includes('both debit and credit'), 'Row with both debit and credit rejected');
  assert(P('Date,Debit,Credit\n2026-01-01,abc,').error?.includes('not a number'), 'Non-numeric amount rejected');
  assert(P('Date,Debit,Credit\n2026-01-01,-5,').error?.includes('negative'), 'Negative amount rejected');
  assert(P('Date,Debit,Credit\n2026-01-01,0,0').error?.includes('No transactions'), 'Only zero-amount rows -> nothing to import');
  assert(P('').error !== undefined || P('   ').error !== undefined, 'Empty file rejected');
  r = P('Date,Debit,Credit,Balance\n2026-01-01,100,,900\n2026-01-02,,50,950\n2026-01-03,10,,111');
  assert(r.warnings.some((w) => /running balance/.test(w)), 'Running-balance break is warned');
  r = P('Date,Debit,Credit,Balance\n2026-01-03,10,,900\n2026-01-02,,50,910\n2026-01-01,100,,860');
  assert(!r.warnings.some((w) => /running balance/.test(w)), 'Newest-first statements are not falsely flagged');

  console.log('\n--- 2. Import & duplicate protection ---');
  const stmt = `Date,Description,Ref No,Debit,Credit,Balance
2026-05-21,RTGS FROM CHENNAI AUTO,RTGS-109283,,407100,1407100
2026-06-02,CHQ 44021 CLEARED,44021,45000,,1362100
2026-06-05,NEFT UTR1234567 SOUTHERN TEXTILES,UTR1234567,,50000,1412100
2026-06-08,CHQ 5001 PAID,5001,12000,,1400100
2026-06-09,CASH DEPOSIT,,,7777,1407877
2026-06-10,SMS CHARGES,,118,,1407759
`;
  const imp = (token, body) => req('POST', '/api/bank/import', { token, body });
  assert((await imp(undefined, { bank_ledger_id: hdfc, content: stmt })).status === 401, 'Import requires login');
  assert((await imp(viewer, { bank_ledger_id: hdfc, content: stmt })).status === 403, 'Viewer cannot import');
  assert((await imp(auditor, { bank_ledger_id: hdfc, content: stmt })).status === 403, 'Auditor cannot import');
  assert((await imp(admin, { bank_ledger_id: cash, content: stmt })).status === 400, 'Non-bank ledger (Cash) rejected');
  assert((await imp(admin, { bank_ledger_id: 99999, content: stmt })).status === 404, 'Unknown ledger -> 404');
  assert((await imp(admin, { bank_ledger_id: hdfc, content: 'Date,Debit,Credit\nbad,1,' })).status === 400 && (await get('SELECT COUNT(*) c FROM bank_statement_imports')).c === 0, 'Bad file imports nothing (all-or-nothing)');
  const i1 = await imp(clerk, { bank_ledger_id: hdfc, content: stmt, filename: 'hdfc_may_jun.csv' });
  assert(i1.status === 200 && i1.json.data.rows === 6 && i1.json.data.duplicates === 0, 'Statement imported (Data Entry role may import)', i1.raw.slice(0, 160));
  const imp1 = i1.json.data.import_id;
  const again = await imp(admin, { bank_ledger_id: hdfc, content: stmt.replace(/\n/g, '\r\n') });
  assert(again.status === 409, 'Same file again is rejected as a duplicate (even with different line endings)');
  assert((await counts()).v === base0.v && (await counts()).e === base0.e, 'Import changed no vouchers or ledger entries');

  console.log('\n--- 3. Suggestions ---');
  const sg = (await req('GET', `/api/bank/imports/${imp1}/suggestions`, { token: viewer })).json.data;
  const byRef = (ref) => sg.suggestions.find((s) => s.line.ref === ref);
  assert(sg.suggestions.length === 4, 'Four lines get suggestions', `got ${sg.suggestions.length}`);
  const sR1 = byRef('UTR1234567'), sP1 = byRef('5001'), sV6 = byRef('44021');
  const sR2 = sg.suggestions.find((s) => s.line.description === 'CASH DEPOSIT');
  assert(sR1?.entry.voucher_no === 'BK/R1' && sR1.confidence === 'high' && sR1.reasons.some((x) => /Reference/.test(x)), 'Receipt matched by UTR reference (high)');
  assert(sP1?.entry.voucher_no === 'BK/P1' && sP1.confidence === 'high' && sP1.ambiguous === true, 'Same-amount cheques disambiguated by cheque number (P1, not P2); flagged ambiguous');
  assert(sV6?.entry.voucher_no === 'RRE/PMT/002' && sV6.confidence === 'high', 'Pending demo cheque matched by number');
  assert(sR2?.entry.voucher_no === 'BK/R2' && sR2.confidence === 'high' && !sR2.reasons.some((x) => /Reference/.test(x)), 'Receipt without a reference matched on amount + date proximity');
  assert(!sg.suggestions.some((s) => s.entry.voucher_no === 'BK/P2'), 'One-to-one: second same-amount cheque (P2) is not double-used');
  assert(!sg.suggestions.some((s) => s.entry.voucher_no === 'RRE/REC/001'), 'Already-cleared book entries are never suggested');
  assert(sg.unmatched_bank_lines.length === 2 && sg.unmatched_bank_lines.some((l) => /bank charge/.test(l.hint)), 'Unmatched bank lines listed; charges get a "record a bank charge" hint');
  assert(sg.unmatched_bank_lines.some((l) => l.ref === 'RTGS-109283'), 'Bank credit whose book entry is already cleared shows as unmatched');
  const notInStmt = sg.books_not_in_statement.map((b) => b.voucher_no);
  assert(notInStmt.includes('BK/P2') && notInStmt.includes('BK/OLD') && notInStmt.includes('RRE/CON/001'), 'Books entries missing from the statement are listed (P2, old cheque, contra)', notInStmt.join());
  assert(sg.assumptions.length >= 4, 'Assumptions disclosed');
  assert((await req('GET', `/api/bank/imports/99999/suggestions`, { token: admin })).status === 404, 'Unknown import -> 404');

  console.log('\n--- 4. Confirm (atomic) ---');
  const good = [sR1, sP1, sV6, sR2].map((s) => ({ line_id: s.line_id, entry_id: s.entry_id }));
  const cEntry = await entryOf('RRE/REC/001');
  const smsLine = sg.unmatched_bank_lines.find((l) => /SMS/.test(l.description));
  const badBatch = await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [...good.slice(0, 2), { line_id: smsLine.line_id, entry_id: await entryOf('BK/P2') }] } });
  assert(badBatch.status === 400 && /differ in amount/.test(badBatch.raw), 'A wrong-amount pair is rejected');
  assert((await get("SELECT COUNT(*) c FROM bank_statement_lines WHERE status='matched'")).c === 0 && (await get("SELECT status FROM bank_reconciliation WHERE ledger_entry_id = ?", [await entryOf('BK/R1')]))?.status !== 'Cleared', 'Nothing from the failed batch was applied (valid pairs included)');
  const t2 = await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [good[0], good[0]] } });
  assert(t2.status === 400, 'Duplicate pair inside one request rejected');
  const cleared = await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [{ line_id: sR2.line_id, entry_id: cEntry }] } });
  assert(cleared.status === 400 && /already cleared|differ/.test(cleared.raw), 'Cannot match to an already-cleared entry');
  assert((await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [{ line_id: sR1.line_id, entry_id: await L('Cash') }] } })).status === 400, 'Entry from another ledger rejected');
  assert((await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: viewer, body: { matches: good } })).status === 403, 'Viewer cannot confirm');

  const [c1, c2] = await Promise.all([
    req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: good } }),
    req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: good } })
  ]);
  assert([c1.status, c2.status].sort().join() === '200,400', 'Two simultaneous confirms: exactly one wins', `${c1.status},${c2.status}`);
  assert((await get("SELECT COUNT(*) c FROM bank_statement_lines WHERE status='matched'")).c === 4, 'Four lines matched');
  const rows = await all("SELECT e.id, r.status, r.bank_clearing_date, r.instrument_no FROM bank_reconciliation r JOIN ledger_entries e ON e.id = r.ledger_entry_id WHERE r.status='Cleared' AND r.bank_clearing_date >= '2026-06-02'");
  assert(rows.length === 4 && rows.some((x) => x.bank_clearing_date === '2026-06-05') && rows.some((x) => x.bank_clearing_date === '2026-06-09'), 'Entries cleared on the bank statement dates');
  const brs = (await req('GET', `/api/reports/bank-reconciliation/${hdfc}`, { token: admin })).json.data;
  assert(brs.transactions.filter((t) => t.status === 'Cleared').length >= 6, 'Existing BRS screen API reflects the cleared entries');
  const after = await counts();
  assert(after.v === base0.v && after.e === base0.e && after.dr === base0.dr && after.cr === base0.cr, 'Confirming changed no vouchers, ledger entries or totals');
  assert((await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [good[0]] } })).status === 400, 'Re-confirming an already matched line is rejected');
  const sg2 = (await req('GET', `/api/bank/imports/${imp1}/suggestions`, { token: admin })).json.data;
  assert(sg2.suggestions.length === 0, 'Matched lines/entries no longer appear in suggestions');

  console.log('\n--- 5. Unmatch, ignore, history ---');
  assert((await req('POST', `/api/bank/lines/${sR1.line_id}/unmatch`, { token: admin })).status === 200, 'Unmatch works');
  const rr = await get('SELECT status, bank_clearing_date FROM bank_reconciliation WHERE ledger_entry_id = ?', [sR1.entry_id]);
  assert(rr.status === 'Pending' && rr.bank_clearing_date === null, 'Unmatch returns the entry to Pending with no clearing date');
  assert((await req('POST', `/api/bank/lines/${sR1.line_id}/unmatch`, { token: admin })).status === 400, 'Unmatching twice rejected');
  assert((await req('GET', `/api/bank/imports/${imp1}/suggestions`, { token: admin })).json.data.suggestions.length === 1, 'Unmatched pair is suggested again');
  assert((await req('POST', `/api/bank/imports/${imp1}/confirm`, { token: admin, body: { matches: [{ line_id: sR1.line_id, entry_id: sR1.entry_id }] } })).status === 200, 'Can be re-matched');
  assert((await req('POST', `/api/bank/lines/${smsLine.line_id}/ignore`, { token: admin, body: { reason: 'post later' } })).status === 200, 'Unmatched line can be ignored');
  assert((await req('POST', `/api/bank/lines/${smsLine.line_id}/ignore`, { token: admin })).status === 400, 'Ignoring an ignored line rejected');
  assert((await req('POST', `/api/bank/lines/${sR1.line_id}/ignore`, { token: admin })).status === 400, 'A matched line cannot be ignored');
  assert((await req('POST', `/api/bank/lines/${smsLine.line_id}/unignore`, { token: admin })).status === 200, 'Un-ignore works');
  const hist = (await req('GET', `/api/bank/history?bank_ledger_id=${hdfc}`, { token: auditor })).json.data;
  const acts = hist.map((h) => h.action);
  assert(acts.filter((a) => a === 'MATCH').length === 5 && acts.includes('UNMATCH') && acts.includes('IGNORE') && acts.includes('UNIGNORE') && acts.includes('IMPORT'), 'Reconciliation history records import, matches, unmatch, ignore', acts.join());
  assert(hist.find((h) => h.action === 'MATCH')?.voucher_no, 'History shows the voucher number');

  console.log('\n--- 6. Overlapping statements & duplicate lines ---');
  const stmt2 = `Date,Description,Ref No,Debit,Credit,Balance
2026-06-05,NEFT UTR1234567 SOUTHERN TEXTILES,UTR1234567,,50000,1412100
2026-06-08,CHQ 5001 PAID,5001,12000,,1400100
2026-06-10,SMS CHARGES,,118,,1407759
2026-06-12,BANK INTEREST,,,1500,1409259
`;
  const i2 = await imp(admin, { bank_ledger_id: hdfc, content: stmt2, filename: 'overlap.csv' });
  assert(i2.status === 200 && i2.json.data.duplicates === 3 && i2.json.data.warnings.some((w) => /already present/.test(w)), 'Lines already imported earlier are detected as duplicates');
  const lines2 = (await req('GET', `/api/bank/imports/${i2.json.data.import_id}/lines`, { token: admin })).json.data;
  assert(lines2.filter((l) => l.status === 'duplicate').length === 3 && lines2.filter((l) => l.status === 'unmatched').length === 1, 'Duplicates marked, only the new line is open');
  const sg3 = (await req('GET', `/api/bank/imports/${i2.json.data.import_id}/suggestions`, { token: admin })).json.data;
  assert(sg3.suggestions.length === 0 && /interest/.test(sg3.unmatched_bank_lines[0].hint), 'Duplicates excluded from matching; interest line gets a Receipt hint');
  const stmt3 = `Date,Description,Debit,Credit\n2026-07-01,UPI SHOP,100,\n2026-07-01,UPI SHOP,100,\n`;
  const i3 = await imp(admin, { bank_ledger_id: hdfc, content: stmt3 });
  assert(i3.json.data.rows === 2 && i3.json.data.duplicates === 0 && i3.json.data.warnings.some((w) => /repeat an identical/.test(w)), 'Two genuine identical lines in one file are both kept, with a warning');
  const i3b = await imp(admin, { bank_ledger_id: hdfc, content: stmt3 + '2026-07-02,UPI SHOP,100,\n' });
  assert(i3b.json.data.duplicates === 2, 'Re-importing an extended statement flags the two earlier identical lines (and not more)');

  console.log('\n--- 7. Balance comparison & payment status ---');
  const sum = (await req('GET', `/api/bank/summary?bank_ledger_id=${hdfc}`, { token: viewer })).json.data;
  const led = await get('SELECT opening_balance FROM ledgers WHERE id = ?', [hdfc]);
  const ents = await all('SELECT e.debit_amount d, e.credit_amount c, r.status s FROM ledger_entries e LEFT JOIN bank_reconciliation r ON r.ledger_entry_id = e.id WHERE e.ledger_id = ?', [hdfc]);
  const book = led.opening_balance + ents.reduce((a, x) => a + x.d - x.c, 0);
  const upR = ents.filter((x) => x.s !== 'Cleared').reduce((a, x) => a + x.d, 0), upP = ents.filter((x) => x.s !== 'Cleared').reduce((a, x) => a + x.c, 0);
  assert(Math.abs(sum.balance_per_books - book) < 0.01, 'Books balance equals independent calculation', `${sum.balance_per_books} vs ${book}`);
  assert(Math.abs(sum.uncleared_receipts.amount - upR) < 0.01 && Math.abs(sum.uncleared_payments.amount - upP) < 0.01, 'Uncleared receipts/payments equal independent calculation');
  assert(Math.abs(sum.expected_bank_balance - (book - upR + upP)) < 0.01, 'Expected bank balance = books − uncleared receipts + uncleared payments');
  assert(sum.statement_closing_balance === 1409259 && sum.statement_as_of === '2026-06-12', 'Statement closing balance taken from the latest dated line that carries a balance', JSON.stringify(sum));
  assert(sum.unexplained_difference === Math.round((sum.statement_closing_balance - sum.expected_bank_balance) * 100) / 100, 'Unexplained difference computed');
  assert(sum.statement_lines.matched === 4 && sum.statement_lines.duplicate >= 5, 'Statement line counts by status', JSON.stringify(sum.statement_lines));
  const pays = (await req('GET', `/api/bank/payments?bank_ledger_id=${hdfc}&status=Pending`, { token: viewer })).json.data;
  const old = pays.find((p) => p.voucher_no === 'BK/OLD');
  assert(old && old.pending_days > 90 && /Stale/.test(old.flag), 'Old uncleared cheque flagged as possibly stale');
  assert(pays.every((p) => p.status === 'Pending') && pays.some((p) => p.voucher_no === 'BK/P2'), 'Payment status filter works');
  const all_ = (await req('GET', `/api/bank/payments?bank_ledger_id=${hdfc}`, { token: viewer })).json.data;
  assert(all_.some((p) => p.status === 'Cleared' && p.bank_clearing_date) && all_.some((p) => p.direction === 'Receipt'), 'Cleared items carry the clearing date; direction shown');
  assert((await req('GET', '/api/bank/ledgers', { token: viewer })).json.data.length >= 2, 'Bank ledger list available');
  assert((await req('GET', '/api/bank/imports', { token: viewer })).json.data.length === 4, 'Import list available');

  console.log('\n--- 8. Deleting a matched voucher (existing screens keep working) ---');
  const p1Line = sP1.line_id;
  const p1Voucher = (await get("SELECT id FROM vouchers WHERE voucher_no = 'BK/P1'")).id;
  const del = await req('DELETE', `/api/vouchers/${p1Voucher}`, { token: admin });
  assert(del.status === 200 && del.json.success, 'Existing voucher delete still works for a voucher matched to a statement line');
  const ln = await get('SELECT status, matched_entry_id FROM bank_statement_lines WHERE id = ?', [p1Line]);
  assert(ln.status === 'unmatched' && ln.matched_entry_id === null, 'Its statement line automatically returns to unmatched');

  console.log('\n--- 9. Concurrency & integrity ---');
  const mk = (n) => `Date,Description,Debit,Credit\n2026-08-${String(n).padStart(2, '0')},CONC ${n},${n},\n2026-08-${String(n).padStart(2, '0')},CONC B${n},,${n + 1}\n`;
  const par = await Promise.all([11, 12, 13, 14, 15].map((n) => imp(admin, { bank_ledger_id: hdfc, content: mk(n) })));
  assert(par.every((x) => x.status === 200 && x.json.data.rows === 2), 'Five simultaneous imports all succeed');
  assert((await get("SELECT COUNT(*) c FROM bank_statement_lines WHERE description LIKE 'CONC%'")).c === 10, 'Exactly 10 lines stored (no lost or doubled rows)');
  const fin = await counts();
  assert(fin.dr === fin.cr, 'Total Dr == total Cr after everything', `${fin.dr}/${fin.cr}`);
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 11, 'Migration 005 recorded');
  assert((await req('GET', '/api/bank/summary?bank_ledger_id=' + cash, { token: admin })).status === 400, 'Summary refuses a non-bank ledger');

  console.log('\n====================================================');
  console.log(`📊 BANK RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

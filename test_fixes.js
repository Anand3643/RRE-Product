/**
 * Regression tests for approved bug fixes (XML escaping, AI opening balances).
 * Runs against a DISPOSABLE data directory.   npm run test:fixes
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const xml2js = require('xml2js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_fixes_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { xmlEsc } = require('./core/xml');
const ai = require('./core/aiEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(6600 + Math.floor(Math.random() * 200), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const admin = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const raw = (method, p, { body, token = admin, type } = {}) => new Promise((resolve, reject) => {
    const data = body || null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(type ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const parse = (s) => new xml2js.Parser({ explicitArray: false }).parseStringPromise(s);

  console.log('\n--- 1. XML escaping ---');
  assert(xmlEsc(`A & B <c> "d" 'e'`) === 'A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;' && xmlEsc(null) === '' && xmlEsc('a\u0001b') === 'ab', 'xmlEsc handles & < > quotes, null and control characters');

  await run("UPDATE ledgers SET name = 'Tom & Jerry <Traders> \"Ltd\"' WHERE name = 'Bank Charges'");
  await run("UPDATE company_info SET name = 'RRE & Sons', gstin = '33AAA&1'");
  await run("UPDATE vouchers SET narration = 'Paid <rent> & \"deposit\"' WHERE voucher_no = 'RRE/PMT/002'");

  const ex = await raw('GET', '/api/export/tally-xml');
  let doc, err = null;
  try { doc = await parse(ex.text); } catch (e) { err = e.message; }
  assert(ex.status === 200 && !err, 'Tally XML export is well-formed XML even with & < > " in names', err || '');
  assert(ex.text.includes('Plant &amp; Machinery') && ex.text.includes('NAME="Tom &amp; Jerry &lt;Traders&gt; &quot;Ltd&quot;"') && ex.text.includes('RRE &amp; Sons'), 'Special characters are escaped (ledger, attribute, company)');
  const msg = doc.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE;
  const names = [].concat(msg.LEDGER).map((l) => l.$.NAME);
  assert(names.includes('Plant & Machinery') && names.includes('Tom & Jerry <Traders> "Ltd"'), 'Parsed XML round-trips the original ledger names');
  const narr = [].concat(msg.VOUCHER).map((v) => v.NARRATION);
  assert(narr.includes('Paid <rent> & "deposit"'), 'Voucher narration round-trips');
  assert([].concat(msg.VOUCHER).length === (await get('SELECT COUNT(*) c FROM vouchers')).c && names.length === (await get('SELECT COUNT(*) c FROM ledgers')).c, 'Export still contains every voucher and ledger');

  const gw = await raw('POST', '/tally-xml', { token: null, type: 'text/xml', body: '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Trial Balance</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>' });
  let gdoc, gerr = null;
  try { gdoc = await parse(gw.text); } catch (e) { gerr = e.message; }
  assert(gw.status === 200 && !gerr, 'Native XML gateway (Trial Balance) is well-formed XML', gerr || '');
  assert(gw.text.includes('Plant &amp; Machinery') && gw.text.includes('RRE &amp; Sons'), 'Gateway escapes names too');

  console.log('\n--- 2. AI assistant honours opening balance type (Dr/Cr) ---');
  const bal = async (id) => {
    const l = await get('SELECT opening_balance ob, opening_balance_type t FROM ledgers WHERE id = ?', [id]);
    const f = await get('SELECT COALESCE(SUM(debit_amount),0) d, COALESCE(SUM(credit_amount),0) c FROM ledger_entries WHERE ledger_id = ?', [id]);
    return (l.t === 'Cr' ? -l.ob : l.ob) + f.d - f.c; // Dr-positive
  };
  const cashId = (await get("SELECT id FROM ledgers WHERE name = 'Cash'")).id;
  const base1 = await ai.queryFinancialAgent('what is my cash balance');
  assert(Math.abs(base1.data.balance - (await bal(cashId))) < 0.01, 'Cash balance (Dr opening) matches independent calculation', `${base1.data.balance}`);
  await run("UPDATE ledgers SET opening_balance_type = 'Cr' WHERE id = ?", [cashId]);
  const cr1 = await ai.queryFinancialAgent('what is my cash balance');
  assert(Math.abs(cr1.data.balance - (await bal(cashId))) < 0.01 && cr1.data.balance === base1.data.balance - 150000, 'Cash with a Cr opening balance is now subtracted, not added', `${cr1.data.balance} vs ${base1.data.balance}`);
  const insights = await ai.scanFinancialAnomalies();
  assert(Math.abs(insights.metrics.cash_balance - (await bal(cashId))) < 0.01, 'Anomaly scanner uses the same signed cash balance');
  await run("UPDATE ledgers SET opening_balance_type = 'Dr' WHERE id = ?", [cashId]);

  const hdfc = (await get("SELECT id FROM ledgers WHERE name LIKE 'HDFC%'")).id;
  await run("UPDATE ledgers SET opening_balance_type = 'Cr' WHERE id = ?", [hdfc]);
  const bq = await ai.queryFinancialAgent('what is my bank balance');
  const sbi = (await get("SELECT id FROM ledgers WHERE name LIKE 'State Bank%'")).id;
  assert(Math.abs(bq.data.totalBank - ((await bal(hdfc)) + (await bal(sbi)))) < 0.01, 'Bank total honours Cr opening balances (HDFC set to Cr)', `${bq.data.totalBank}`);
  await run("UPDATE ledgers SET opening_balance_type = 'Dr' WHERE id = ?", [hdfc]);

  const debtor = (await get("SELECT id FROM ledgers WHERE name = 'Southern Textiles & Spinning Mills'")).id;
  await run("UPDATE ledgers SET opening_balance_type = 'Cr', opening_balance = 1000 WHERE id = ?", [debtor]);
  const dq = await ai.queryFinancialAgent('which debtors owe us money');
  const dEntry = (dq.data || []).find((d) => d.name.startsWith('Southern'));
  assert(!dEntry, 'A debtor with a Cr opening balance and no movement is not listed as owing money');
  await run("UPDATE ledgers SET opening_balance_type = 'Dr', opening_balance = 85000 WHERE id = ?", [debtor]);
  const dq2 = await ai.queryFinancialAgent('which debtors owe us money');
  assert((dq2.data || []).find((d) => d.name.startsWith('Southern'))?.balance === 85000, 'Same debtor with Dr opening shows ₹85,000');

  const cred = (await get("SELECT id FROM ledgers WHERE name LIKE 'Bharat Electric%'")).id;
  const cq = await ai.queryFinancialAgent('what do we owe suppliers');
  assert((cq.data || []).find((c) => c.name.startsWith('Bharat'))?.balance === 40000, 'Creditor with Cr opening shows ₹40,000 payable');
  await run("UPDATE ledgers SET opening_balance_type = 'Dr' WHERE id = ?", [cred]);
  const cq2 = await ai.queryFinancialAgent('what do we owe suppliers');
  assert(!(cq2.data || []).find((c) => c.name.startsWith('Bharat')), 'Creditor with a Dr opening balance is not shown as payable');

  console.log('\n--- 3. Nothing else changed ---');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);

  console.log('\n====================================================');
  console.log(`📊 FIX RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

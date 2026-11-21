/**
 * Accounting automation (read-only): duplicates, suggestions, categorisation, unusual transactions, reminders.
 * Runs against a DISPOSABLE data directory.   npm run test:automation
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_automation_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const auto = require('./core/automationTools');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(8200 + Math.floor(Math.random() * 150), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), cash = await L('Cash'), rent = await L('Office Rent'), phone = await L('Telephone & Internet Charges'), bankCh = await L('Bank Charges');
  const southern = await L('Southern Textiles & Spinning Mills'), chennai = await L('Chennai Auto Components Pvt Ltd'), elgi = await L('Elgi Equipments Spares Ltd'), bharat = await L('Bharat Electric Motors Vendor');
  const salesSp = await L('Sales Account - Spares & Lubes'), salesCo = await L('Sales Account - Compressors'), purAcc = await L('Purchase Account - Spares & Machines');
  let n = 0;
  const post = async (type, date, party, lines, extra = {}) => {
    n++;
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: `AU/${n}`, date, party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })), ...extra } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return r.json.id;
  };
  const pay = (date, expense, amt, narration, ref = '', from = hdfc) => post('Payment', date, expense, [[expense, amt, 0], [from, 0, amt]], { narration, reference_no: ref });
  const sale = (date, party, amt, ledger, ref = '', due) => post('Sales', date, party, [[party, amt, 0], [ledger, 0, amt]], { reference_no: ref, bill_allocations: [{ ledger_id: party, bill_type: 'New Ref', bill_ref: ref || `AU/${n + 1}`, amount: amt, due_date: due || addDays(date, 30) }] });
  const counts = async () => ({ v: (await get('SELECT COUNT(*) c FROM vouchers')).c, e: (await get('SELECT COUNT(*) c FROM ledger_entries')).c });

  // ---- history
  await post('Purchase', addDays(TODAY, -3), elgi, [[purAcc, 11800, 0], [elgi, 0, 11800]], { reference_no: 'INV-5001' });
  await post('Purchase', addDays(TODAY, -2), bharat, [[purAcc, 0.0 + 0, 0]].length ? [[purAcc, 5000, 0], [bharat, 0, 5000]] : [], { reference_no: '0045' });
  await sale(addDays(TODAY, -40), southern, 2000, salesSp, 'S-A'); await sale(addDays(TODAY, -35), southern, 2400, salesSp, 'S-B');
  await sale(addDays(TODAY, -30), southern, 2200, salesSp, 'S-C'); await sale(addDays(TODAY, -20), southern, 90000, salesCo, 'S-D');
  for (const [i, nar] of ['Being office rent paid for April', 'Office rent May 2026', 'rent for June office premises', 'Office rent July'].entries()) await pay(addDays(TODAY, -200 + i * 30), rent, 45000 + i * 500, nar);
  for (const [i, nar] of ['Airtel broadband bill', 'Airtel broadband charges August', 'Airtel leased line bill'].entries()) await pay(addDays(TODAY, -90 + i * 30), phone, 2500, nar);
  const before = await counts();

  console.log('\n--- 1. Access & validation ---');
  assert((await req('POST', '/api/automation/duplicate-check', { token: null, body: {} })).status === 401, 'Requires login');
  assert((await req('GET', '/api/automation/duplicates', { token: clerk })).status === 403 && (await req('GET', '/api/automation/unusual', { token: clerk })).status === 403 && (await req('GET', '/api/automation/reminders', { token: clerk })).status === 403, 'Books-wide scans need the financial-view permission (Data Entry blocked)');
  assert((await req('POST', '/api/automation/duplicate-check', { token: clerk, body: { party_ledger_id: elgi, reference_no: 'INV-5001' } })).status === 200, 'Data Entry can use the pre-entry duplicate check');
  assert((await req('POST', '/api/automation/duplicate-check', { body: { party_ledger_id: elgi, date: '2026/01/01' } })).status === 400, 'Bad date rejected');
  assert((await req('POST', '/api/automation/duplicate-check', { body: { party_ledger_id: elgi, total_amount: 'abc' } })).status === 400, 'Non-numeric amount rejected');
  assert((await req('GET', '/api/automation/unusual?from_date=bad')).status === 400 && (await req('GET', '/api/automation/duplicates?to_date=x')).status === 400, 'Bad range dates rejected');

  console.log('\n--- 2. Duplicate check before posting ---');
  const dc = async (b) => (await req('POST', '/api/automation/duplicate-check', { body: b })).json.data.candidates;
  let c = await dc({ voucher_type: 'Purchase', party_ledger_id: elgi, reference_no: 'inv5001' });
  assert(c.length === 1 && c[0].level === 'high' && c[0].voucher_no === 'AU/1', 'Same party + same invoice number (case/punctuation ignored) => HIGH');
  c = await dc({ voucher_type: 'Purchase', party_ledger_id: bharat, reference_no: '45' });
  assert(c.length === 1 && c[0].level === 'high', 'Leading zeros ignored ("45" = "0045")');
  c = await dc({ voucher_type: 'Purchase', party_ledger_id: bharat, reference_no: '450' });
  assert(c.length === 0, 'A different number is not flagged');
  c = await dc({ voucher_type: 'Purchase', party_ledger_id: elgi, total_amount: 11800, date: addDays(TODAY, -1) });
  assert(c.length === 1 && c[0].level === 'medium' && /Same party and amount/.test(c[0].reasons[0]), 'Same party + amount within 7 days => MEDIUM');
  assert((await dc({ voucher_type: 'Purchase', party_ledger_id: elgi, total_amount: 11800, date: addDays(TODAY, -30) })).length === 0, 'Same amount 27 days apart is not flagged');
  assert((await dc({ voucher_type: 'Purchase', party_ledger_id: bharat, total_amount: 11800, date: addDays(TODAY, -3) })).length === 0, 'Same amount with a different party is not flagged');
  assert((await dc({ voucher_type: 'Sales', party_ledger_id: elgi, total_amount: 11800, date: addDays(TODAY, -3) })).length === 0, 'Different voucher type is not flagged');
  const none = (await req('POST', '/api/automation/duplicate-check', { body: {} })).json.data;
  assert(none.candidates.length === 0 && /Supply/.test(none.note), 'Empty request explains what is needed');

  console.log('\n--- 3. Duplicate scan of posted books ---');
  await sale(addDays(TODAY, -10), chennai, 5000, salesCo, 'DUP-1'); await sale(addDays(TODAY, -9), chennai, 5300, salesCo, 'dup 1');
  await pay(addDays(TODAY, -8), phone, 777, 'x'); await pay(addDays(TODAY, -8), phone, 777, 'y');
  await post('Journal', addDays(TODAY, -8), null, [[rent, 100, 0], [phone, 0, 100]]); await post('Journal', addDays(TODAY, -8), null, [[rent, 100, 0], [phone, 0, 100]]);
  const sd = (await req('GET', '/api/automation/duplicates')).json.data;
  const g1 = sd.groups.find((g) => g.level === 'high' && g.vouchers.some((v) => v.reference_no === 'DUP-1'));
  const g2 = sd.groups.find((g) => g.level === 'medium' && g.amount === 777);
  assert(g1 && g1.vouchers.length === 2, 'Same party + same invoice no. posted twice => HIGH group of 2');
  assert(g2 && g2.vouchers.length === 2, 'Same party + date + amount with no reference => MEDIUM group');
  assert(!sd.groups.some((g) => g.vouchers.some((v) => v.voucher_type === 'Journal')), 'Journals are not scanned');
  assert(sd.groups.length === 2, 'Genuinely distinct vouchers are not flagged (exactly 2 groups)', String(sd.groups.length));
  assert((await req('GET', `/api/automation/duplicates?from_date=${addDays(TODAY, -5)}`)).json.data.groups.length === 0, 'Date range limits the scan');

  console.log('\n--- 4. Categorisation & ledger suggestions ---');
  const cat = (nar) => req('POST', '/api/automation/categorize', { body: { narration: nar } }).then((r) => r.json.data);
  let k = await cat('Office rent for August');
  assert(k.ledger?.name === 'Office Rent' && k.category === 'Indirect Expenses' && k.confidence >= 0.9, 'Rent narration => Office Rent / Indirect Expenses', JSON.stringify(k));
  k = await cat('Airtel broadband charges');
  assert(k.ledger?.name === 'Telephone & Internet Charges' && k.confidence >= 0.9, 'Airtel narration => Telephone & Internet Charges');
  k = await cat('zzxqv unrelated words');
  assert(k.ledger === null && k.confidence === 0, 'Unknown narration => no guess');
  k = await cat('paid for the bill');
  assert(k.ledger === null, 'Only generic words (paid / bill) => no guess');
  assert((await cat('')).ledger === null, 'Empty narration => no guess');
  const sg = (await req('POST', '/api/automation/suggest', { body: { voucher_type: 'Sales', party_ledger_id: southern } })).json.data;
  assert(sg.suggestions[0].name === 'Sales Account - Spares & Lubes' && sg.suggestions[0].confidence === 1, 'Southern Textiles: usual sales ledger is Spares & Lubes (3 of 4 vouchers)', JSON.stringify(sg.suggestions.slice(0, 2)));
  assert(sg.suggestions.some((s) => s.name === 'Sales Account - Compressors') && !sg.suggestions.some((s) => ['Sundry Debtors', 'Duties & Taxes'].includes(s.group)), 'Alternative ledger listed; debtor and tax ledgers never suggested');
  assert(sg.template.from_voucher === 'AU/6' && sg.template.lines.length === 2 && sg.template.typical_amount === 2400, 'Template = most recent sale to this party; typical amount = median (₹2,400)', JSON.stringify(sg.template));
  const sg2 = (await req('POST', '/api/automation/suggest', { body: { voucher_type: 'Payment', narration: 'rent for September' } })).json.data;
  assert(sg2.suggestions[0].name === 'Office Rent', 'Narration alone suggests Office Rent');
  assert(/Suggestions only/.test(sg.method), 'States that nothing is filled or posted');

  console.log('\n--- 5. Unusual transactions ---');
  for (let i = 0; i < 8; i++) await pay(addDays(TODAY, -150 + i * 5), rent, 44000 + (i % 4) * 700, 'Office rent');
  await pay(addDays(TODAY, -4), rent, 450000, 'Office rent advance');
  for (let i = 0; i < 6; i++) await pay(addDays(TODAY, -60 + i * 3), bankCh, 100, 'SMS charges');
  await pay(addDays(TODAY, -2), bankCh, 1000, 'SMS charges?');
  await pay(addDays(TODAY, -6), phone, 15000, 'Cash purchase of router', '', cash);
  await pay(addDays(TODAY, -7), phone, 6000, 'cash a', '', cash); await pay(addDays(TODAY, -7), phone, 6000, 'cash b', '', cash);
  await pay(addDays(TODAY, -7), bankCh, 9000, 'cash small', '', cash);
  await post('Receipt', addDays(TODAY, -5), chennai, [[cash, 250000, 0], [chennai, 0, 250000]]);
  await post('Receipt', addDays(TODAY, -5), southern, [[cash, 150000, 0], [southern, 0, 150000]]);
  const lateDate = addDays(TODAY, -60);
  await pay(lateDate, phone, 321, 'late keyed');
  const newParty = (await req('POST', '/api/masters/ledgers', { body: { name: 'Brand New Customer', group_id: 16, state: 'Tamil Nadu', state_code: '33' } })).json.id;
  await sale(addDays(TODAY, -1), newParty, 400000, salesCo, 'NEWBIG');
  const un = (await req('GET', '/api/automation/unusual')).json.data;
  const has = (code, pred = () => true) => un.findings.some((f) => f.code === code && pred(f));
  assert(has('AMOUNT_OUTLIER', (f) => f.amount === 450000 && f.ledger === 'Office Rent'), 'Rent of ₹4,50,000 (usual ≈ ₹45,000) flagged as an outlier');
  assert(!un.findings.some((f) => f.code === 'AMOUNT_OUTLIER' && f.ledger === 'Office Rent' && f.amount < 100000), 'Normal rent payments are not flagged');
  assert(has('AMOUNT_OUTLIER', (f) => f.amount === 1000 && f.ledger === 'Bank Charges'), 'Bank charge of ₹1,000 vs usual ₹100 flagged (identical history handled)');
  assert(has('CASH_PAYMENT_OVER_10000', (f) => f.amount === 15000 || f.amount === 6000), 'Cash payments above ₹10,000 per party per day flagged');
  assert(un.findings.filter((f) => f.code === 'CASH_PAYMENT_OVER_10000').length === 2, 'Both the single ₹15,000 and the two ₹6,000 payments (₹12,000 total) are caught; ₹9,000 is not');
  assert(has('CASH_RECEIPT_200000', (f) => f.amount === 250000) && !un.findings.some((f) => f.code === 'CASH_RECEIPT_200000' && f.amount === 150000), 'Cash receipt of ₹2.5 lakh flagged; ₹1.5 lakh is not');
  assert(has('NEW_PARTY_LARGE', (f) => f.party === 'Brand New Customer'), 'First-ever large sale to a new customer flagged');
  assert(!un.findings.some((f) => f.code === 'NEW_PARTY_LARGE' && f.party === 'Southern Textiles & Spinning Mills'), 'Established customers are not flagged as new');
  assert(has('LATE_ENTRY', (f) => f.date === lateDate), 'Voucher dated 60 days back but keyed in today flagged as a late entry');
  assert(!has('LATE_ENTRY', (f) => f.date === addDays(TODAY, -2)), 'A 2-day-old voucher is not a late entry');
  assert(has('ROUND_LARGE_AMOUNT', (f) => f.amount === 450000), 'Round large payment flagged for review');
  const sev = un.findings.map((f) => f.severity);
  assert(sev.indexOf('info') === -1 || sev.lastIndexOf('warning') < sev.indexOf('info'), 'Warnings are listed before info items');
  assert(un.methods.some((m) => /not tax advice/.test(m)), 'Cash rules are labelled as screening aids, not tax advice');
  const un2 = (await req('GET', `/api/automation/unusual?from_date=${addDays(TODAY, -4)}`)).json.data;
  assert(un2.findings.every((f) => f.date >= addDays(TODAY, -4)) && un2.findings.some((f) => f.amount === 450000), 'Date range limits findings (history still used for baselines)');

  console.log('\n--- 6. Overdue reminders ---');
  await sale(addDays(TODAY, -130), southern, 10000, salesSp, 'OLD-1', addDays(TODAY, -100));
  await sale(addDays(TODAY, -20), chennai, 7000, salesSp, 'NEW-1', addDays(TODAY, 10));
  const rm = (await req('GET', '/api/automation/reminders')).json.data;
  const cs = rm.customers.find((x) => x.customer.startsWith('Southern'));
  assert(cs && cs.bills.some((b) => b.bill_ref === 'OLD-1' && b.days_overdue === 100) && cs.tone === 'firm', 'Southern: bill 100 days overdue => firm tone');
  assert(!rm.customers.some((x) => x.bills.some((b) => b.bill_ref === 'NEW-1')), 'A bill not yet due is not chased');
  assert(cs.message.includes('OLD-1') && cs.message.includes('Dear Southern') && /₹[\d,]+\.\d\d/.test(cs.message), 'Message names the bill, customer and total in Indian format');
  assert(rm.total_overdue === rm.customers.reduce((s, x) => s + x.total, 0) && rm.customers[0].total >= rm.customers[rm.customers.length - 1].total, 'Total = sum of customers; largest first');
  assert(/does not store customer phone/.test(rm.note), 'States that nothing is sent');
  assert((await req('GET', '/api/automation/reminders?min_days=1000')).json.data.customers.length === 0, 'min_days filter works');

  console.log('\n--- 7. Read-only guarantee ---');
  const pre = await counts();
  for (const [m, u, bd] of [['POST', '/api/automation/duplicate-check', { party_ledger_id: elgi, reference_no: 'INV-5001' }], ['POST', '/api/automation/suggest', { voucher_type: 'Sales', party_ledger_id: southern }],
    ['POST', '/api/automation/categorize', { narration: 'Office rent' }], ['GET', '/api/automation/duplicates'], ['GET', '/api/automation/unusual'], ['GET', '/api/automation/reminders']]) await req(m, u, { body: bd });
  const again = await counts(); const after = pre;
  assert(again.v === after.v && again.e === after.e, 'Analysis calls change no vouchers or ledger entries');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);
  assert(typeof auto.normRef === 'function' && auto.normRef('  0-0A/b ') === 'AB', 'Reference normaliser strips punctuation and leading zeros');

  console.log('\n====================================================');
  console.log(`📊 AUTOMATION RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

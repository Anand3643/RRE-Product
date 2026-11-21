/**
 * Verification for GST tools (validation, tax checks, GSTR-2B reconciliation).
 * Runs against a DISPOSABLE data directory.   npm run test:gst
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_gst_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { parseCsv, parseAmount, parseDate } = require('./core/csv');
const tools = require('./core/gstTools');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb();
  await runMigrations();
  const info = await startServer(5700 + Math.floor(Math.random() * 200), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const admin = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const clerk = createSessionToken({ id: 3, username: 'dataentry', role: 'Data Entry' });
  const viewer = createSessionToken({ id: 5, username: 'viewer', role: 'Viewer' });

  function req(method, p, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request(base + p, {
        method,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }
      }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  const L = async (name) => (await get('SELECT id FROM ledgers WHERE name = ?', [name])).id;

  console.log('\n--- 1. CSV helpers ---');
  const c1 = parseCsv('﻿GSTIN,Invoice No,Taxable\r\n"27AAPFU0939F1ZV","A,1",1000\r\n"x","say ""hi""",2\r\n\r\n');
  assert(c1.headers.join('|') === 'gstin|invoice_no|taxable' && c1.rows.length === 2 && c1.rows[0].invoice_no === 'A,1' && c1.rows[1].invoice_no === 'say "hi"', 'CSV: BOM, quotes, commas, escaped quotes, blank lines');
  let threw = false; try { parseCsv('a,b\n"open,1'); } catch (e) { threw = true; }
  assert(threw, 'CSV: unterminated quote is rejected');
  assert(parseAmount('1,23,456.50') === 123456.5 && parseAmount('(250.00)') === -250 && parseAmount('₹ 500') === 500 && Number.isNaN(parseAmount('12abc')) && parseAmount('') === 0, 'Amount parsing (Indian commas, brackets, symbols, garbage)');
  assert(parseDate('18-05-2026') === '2026-05-18' && parseDate('2026-05-18') === '2026-05-18' && parseDate('18-May-2026') === '2026-05-18' && parseDate('31-02-2026') === null && parseDate('x') === null, 'Date parsing incl. impossible dates');

  console.log('\n--- 2. GSTIN validation ---');
  const ok = tools.validateGstin('27AAPFU0939F1ZV');
  assert(ok.valid && ok.state === 'Maharashtra' && ok.pan === 'AAPFU0939F', 'Valid GSTIN accepted (state + PAN extracted)');
  assert(tools.validateGstin('07AAGFF2194N1Z1').valid, 'Second valid GSTIN accepted');
  assert(tools.validateGstin(' 27aapfu0939f1zv ').valid, 'Lower-case / padded input normalised');
  const badCheck = tools.validateGstin('27AAPFU0939F1ZW');
  assert(!badCheck.valid && badCheck.checks.find((c) => c.name === 'Check digit' && !c.ok), 'Wrong check digit rejected', JSON.stringify(badCheck.checks.filter((c) => !c.ok)));
  assert(!tools.validateGstin('27AAPFU0939F1Z').valid, '14-character GSTIN rejected');
  assert(!tools.validateGstin('00AAPFU0939F1ZV').valid && !tools.validateGstin('00AAPFU0939F1ZV').checks.find((c) => c.name === 'State code').ok, 'Invalid state code 00 rejected');
  assert(!tools.validateGstin('27AAPFU0939F1XV').valid, 'Missing the fixed "Z" rejected');
  assert(!tools.validateGstin('').valid && !tools.validateGstin(null).valid && !tools.validateGstin('<script>').valid, 'Empty / null / junk rejected without throwing');
  assert(/portal/i.test(ok.note), 'Result states that portal confirmation is still required');
  const gen = 'ZZ' + 'ABCDE1234F'.slice(0); void gen;
  const synthetic = '29ABCPE1234F1Z' + tools.gstinCheckChar('29ABCPE1234F1Z');
  assert(tools.validateGstin(synthetic).valid, 'Self-consistent synthetic GSTIN passes (checksum round-trip)');

  console.log('\n--- 3. HSN / SAC validation ---');
  assert(tools.validateHsn('84148011').valid && tools.validateHsn('84148011').kind === 'HSN', '8-digit HSN accepted');
  const h4 = tools.validateHsn('8414');
  assert(h4.valid && h4.issues.some((i) => i.startsWith('Warning')), '4-digit HSN accepted with a warning');
  assert(tools.validateHsn('998314').valid && tools.validateHsn('998314').kind === 'SAC', '6-digit SAC accepted');
  for (const bad of ['12345', 'ABC123', '', '99831', '7701', '00']) assert(!tools.validateHsn(bad).valid, `Invalid HSN/SAC rejected: "${bad}"`);

  console.log('\n--- 4. Master audit ---');
  await run("INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate) VALUES ('Bad HSN Item', 1, 1, '12345', 17)");
  const audit = (await req('GET', '/api/gst/audit-masters', { token: admin })).json.data;
  assert(audit.ledgers_checked > 0 && audit.ledger_issues.some((l) => l.name.startsWith('Chennai Auto')), 'Demo ledgers with fictional GSTINs are flagged (checksum)');
  assert(audit.item_issues.some((i) => i.name === 'Bad HSN Item' && i.problems.length === 2), 'Bad HSN and non-standard GST rate flagged on a stock item');
  assert(!audit.item_issues.some((i) => i.name.startsWith('RRE Screw Compressor')), 'Valid demo items are not flagged');
  await run("UPDATE ledgers SET gstin = '27AAPFU0939F1ZV', state_code = '33' WHERE name = 'Cash'");
  const audit2 = (await req('GET', '/api/gst/audit-masters', { token: admin })).json.data;
  assert(audit2.ledger_issues.find((l) => l.name === 'Cash')?.problems.some((p) => /differs from the ledger/.test(p)), 'GSTIN state vs ledger state mismatch flagged');
  await run("UPDATE ledgers SET gstin = '', state_code = '33' WHERE name = 'Cash'");

  console.log('\n--- 5. Tax calculation validation ---');
  const before = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  let t = (await req('GET', '/api/gst/tax-check', { token: admin })).json.data;
  assert(t.vouchers_with_tax_checked >= 3 && t.errors === 0 && t.warnings === 0, 'Correctly-taxed demo vouchers produce no findings', JSON.stringify(t.findings));
  const oil = (await get("SELECT id FROM stock_items WHERE name LIKE 'Screw Compressor Oil Filter%'")).id;
  const chennai = await L('Chennai Auto Components Pvt Ltd'), bang = await L('Bangalore Machine Tools Ltd');
  const sales = await L('Sales Account - Compressors'), cg = await L('Output CGST 9%'), sg = await L('Output SGST 9%'), ig = await L('Output IGST 18%');
  const post = (no, party, lines) => req('POST', '/api/vouchers', { token: admin, body: {
    voucher_type: 'Sales', voucher_no: no, date: '2026-06-10', party_ledger_id: party,
    entries: lines.map(([lid, dr, cr]) => ({ ledger_id: lid, debit_amount: dr, credit_amount: cr })),
    inventory: [{ stock_item_id: oil, quantity: 1, rate: 100 }] } });
  const dbg = await post('G/IGST-INTRA', chennai, [[chennai, 118, 0], [sales, 0, 100], [ig, 0, 18]]);
  if (!dbg.json.success) console.log('SETUP FAIL', dbg.raw);
  await post('G/WRONG-AMT', chennai, [[chennai, 110, 0], [sales, 0, 100], [cg, 0, 5], [sg, 0, 5]]);
  await post('G/ASYM', chennai, [[chennai, 118, 0], [sales, 0, 100], [cg, 0, 10], [sg, 0, 8]]);
  await post('G/CGST-INTER', bang, [[bang, 118, 0], [sales, 0, 100], [cg, 0, 9], [sg, 0, 9]]);
  await post('G/ROUNDING', chennai, [[chennai, 118.6, 0], [sales, 0, 100], [cg, 0, 9.3], [sg, 0, 9.3]]);
  t = (await req('GET', '/api/gst/tax-check?from_date=2026-06-10&to_date=2026-06-10', { token: admin })).json.data;
  const codes = (no) => t.findings.filter((f) => f.voucher_no === no).map((f) => f.code);
  assert(codes('G/IGST-INTRA').includes('IGST_ON_INTRASTATE'), 'IGST on an intra-state sale detected');
  assert(codes('G/WRONG-AMT').includes('TAX_AMOUNT_MISMATCH'), 'Tax amount that disagrees with the item GST rate detected');
  assert(codes('G/ASYM').includes('CGST_SGST_ASYMMETRY'), 'CGST ≠ SGST detected');
  assert(codes('G/CGST-INTER').includes('CGST_SGST_ON_INTERSTATE'), 'CGST/SGST on an inter-state sale detected');
  assert((await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_no='G/ROUNDING'")).c === 1 && codes('G/ROUNDING').length === 0, 'Sub-rupee rounding (₹0.60) is tolerated, voucher exists and is clean');
  assert(t.assumptions.length >= 3, 'Assumptions are listed with the result');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === before + 5, 'Tax check itself changed no data', 'before=' + before + ' now=' + (await get('SELECT COUNT(*) c FROM vouchers')).c + ' ' + (await all("SELECT voucher_no FROM vouchers WHERE voucher_no LIKE 'G/%'")).map(r => r.voucher_no));
  assert((await req('GET', '/api/gst/tax-check?from_date=bad', { token: admin })).status === 400, 'Bad date parameter rejected');

  console.log('\n--- 6. GSTR-2B reconciliation ---');
  const purch = await L('Purchase Account - Spares & Machines');
  const icg = await L('Input CGST 9%'), isg = await L('Input SGST 9%'), iig = await L('Input IGST 18%');
  const elgi = await L('Elgi Equipments Spares Ltd'), bharat = await L('Bharat Electric Motors Vendor'), pune = await L('Pune Pneumatics Industries');
  async function buy(no, ref, party, taxable, c, s, i, date = '2026-06-12') {
    const total = taxable + c + s + i;
    const lines = [[purch, taxable, 0]]; if (c) lines.push([icg, c, 0]); if (s) lines.push([isg, s, 0]); if (i) lines.push([iig, i, 0]); lines.push([party, 0, total]);
    const r = await req('POST', '/api/vouchers', { token: admin, body: { voucher_type: 'Purchase', voucher_no: no, date, reference_no: ref, party_ledger_id: party,
      entries: lines.map(([lid, dr, cr]) => ({ ledger_id: lid, debit_amount: dr, credit_amount: cr })) } });
    if (!r.json.success) throw new Error('setup failed: ' + r.raw);
  }
  await buy('B/2', 'INV-2', bharat, 10000, 900, 900, 0);
  await buy('B/3', 'BILL-77', bharat, 20000, 1800, 1800, 0, '2026-07-03');
  await buy('B/4', 'X-5', pune, 5000, 0, 0, 900);
  await buy('B/5', 'REF-A', bharat, 7000, 630, 630, 0);
  await buy('B/6', '0045', pune, 3000, 0, 0, 540);
  const G = { elgi: '33AABCE4455P1Z2', bharat: '33AABCB1122M1Z9', pune: '27AABCP5678Q1Z9', other: '29AAACB1234F1Z3' };
  const portal = { data: { docdata: { b2b: [
    { ctin: G.elgi, trdnm: 'Elgi', inv: [{ inum: 'INV-ELGI-9921', dt: '18-05-2026', val: 184080, txval: 156000, igst: 0, cgst: 14040, sgst: 14040, cess: 0 }] },
    { ctin: G.bharat, trdnm: 'Bharat', inv: [
      { inum: 'INV-2', dt: '12-06-2026', val: 12650, txval: 10000, igst: 0, cgst: 900, sgst: 850, cess: 0 },
      { inum: 'REF-B', dt: '12-06-2026', val: 8260, txval: 7000, igst: 0, cgst: 630, sgst: 630, cess: 0 }] },
    { ctin: G.pune, trdnm: 'Pune', inv: [
      { inum: 'x 5', dt: '12-06-2026', txval: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 },
      { inum: '45', dt: '12-06-2026', items: [{ txval: 1000, igst: 180 }, { txval: 2000, igst: 360 }] }] },
    { ctin: G.other, trdnm: 'Stranger', inv: [{ inum: 'INV-ZZZ', dt: '01-06-2026', txval: 999, igst: 180, cgst: 0, sgst: 0, cess: 0 }] }
  ], cdnr: [{ ctin: G.pune, nt: [] }] } } };
  const vBefore = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const rec = await req('POST', '/api/gst/gstr2b/reconcile', { token: admin, body: { format: 'json', content: JSON.stringify(portal), name: 'May-Jun 2026' } });
  assert(rec.status === 200 && rec.json.success, 'Reconciliation runs on a GSTR-2B JSON', rec.raw.slice(0, 200));
  const sm = rec.json.data.summary;
  assert(sm.portal_invoices === 6 && sm.books_purchase_vouchers === 6, 'Counts: 6 portal invoices vs 6 purchase vouchers', JSON.stringify(sm));
  assert(sm.matched === 3, 'Matched: exact, case/punctuation-insensitive ("x 5" = "X-5"), leading zeros ("45" = "0045") and item-level totals', JSON.stringify(sm));
  assert(sm.mismatched === 1 && rec.json.data.mismatched[0].differing_fields.join() === 'sgst' && rec.json.data.mismatched[0].difference.sgst === 50, 'Mismatch: SGST differs by ₹50 and only SGST is reported');
  assert(sm.probable === 1 && /invoice number differs/.test(rec.json.data.probable[0].reason), 'Probable match: same supplier & amounts, different invoice number');
  assert(sm.in_2b_not_in_books === 1 && rec.json.data.in_2b_not_in_books[0].invoice_no === 'INV-ZZZ', 'In 2B but not in books detected');
  assert(sm.in_books_not_in_2b === 1 && rec.json.data.in_books_not_in_2b[0].invoice_no === 'BILL-77' && sm.tax_in_books_not_in_2b_itc_at_risk === 3600, 'In books but not in 2B detected with ITC-at-risk amount (₹3,600)');
  assert(rec.json.data.not_covered.credit_debit_notes_in_file === 1 && rec.json.data.assumptions.length >= 4, 'Uncovered sections and assumptions are disclosed');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === vBefore, 'Reconciliation changed no vouchers');

  const per = await req('POST', '/api/gst/gstr2b/reconcile', { token: admin, body: { format: 'json', period: '2026-05', content: JSON.stringify({ b2b: portal.data.docdata.b2b.slice(0, 1) }) } });
  assert(per.json.data.summary.books_purchase_vouchers === 1 && per.json.data.summary.matched === 1, 'Period filter limits books to that month (2026-05) and bare {b2b} shape is accepted');

  const csv = 'GSTIN,Invoice No,Date,Taxable,IGST,CGST,SGST,CESS\n' +
    `${G.elgi},inv-elgi-9921,18-05-2026,"1,56,000",0,"14,040","14,040",0\n${G.other},NEW-1,01-06-2026,500,90,0,0,0\n`;
  const rc = await req('POST', '/api/gst/gstr2b/reconcile', { token: admin, body: { format: 'csv', content: csv, period: '2026-05' } });
  assert(rc.json.success && rc.json.data.summary.matched === 1 && rc.json.data.summary.in_2b_not_in_books === 1, 'CSV input works (Indian-format numbers, case-insensitive invoice no)');

  for (const [label, body] of [
    ['invalid JSON', { format: 'json', content: '{oops' }], ['JSON without b2b', { format: 'json', content: '{"data":{}}' }],
    ['CSV missing column', { format: 'csv', content: 'gstin,taxable\nx,1' }], ['CSV non-numeric amount', { format: 'csv', content: 'gstin,invoice_no,taxable\nx,1,abc' }],
    ['unknown format', { format: 'xml', content: 'x' }], ['no content', { format: 'json' }], ['bad period', { format: 'json', content: '{}', period: '2026-13x' }]
  ]) assert((await req('POST', '/api/gst/gstr2b/reconcile', { token: admin, body })).status === 400, `Rejected: ${label}`);

  const big = { b2b: [{ ctin: G.other, inv: Array.from({ length: 12000 }, (_, i) => ({ inum: 'N' + i, dt: '01-06-2026', txval: 1, igst: 0.18 })) }] };
  const bigStr = JSON.stringify(big);
  const bg = await req('POST', '/api/gst/gstr2b/reconcile', { token: admin, body: { format: 'json', content: bigStr } });
  assert(bigStr.length > 400000 && bg.status === 200 && bg.json.data.summary.portal_invoices === 12000, `Large file (${Math.round(bigStr.length / 1024)} KB, 12,000 invoices) is accepted`);

  const hist = (await req('GET', '/api/gst/gstr2b/history', { token: admin })).json.data;
  assert(hist.length >= 3 && hist[hist.length - 1].source_name === 'May-Jun 2026' && hist[hist.length - 1].summary.matched === 3, 'Runs are saved with their summaries');
  const one = await req('GET', `/api/gst/gstr2b/history/${hist[hist.length - 1].id}`, { token: admin });
  assert(one.json.data.result.mismatched.length === 1, 'A saved run can be reopened in full');
  assert((await req('GET', '/api/gst/gstr2b/history/99999', { token: admin })).status === 404, 'Unknown run -> 404');

  console.log('\n--- 7. Access control & integrity ---');
  for (const [m, p, b] of [['POST', '/api/gst/validate-gstin', { gstin: 'x' }], ['GET', '/api/gst/audit-masters'], ['GET', '/api/gst/tax-check'], ['POST', '/api/gst/gstr2b/reconcile', { format: 'json', content: '{}' }], ['GET', '/api/gst/gstr2b/history']]) {
    assert((await req(m, p, { body: b })).status === 401, `No token -> 401: ${m} ${p}`);
    assert((await req(m, p, { token: clerk, body: b })).status === 403, `Data Entry -> 403: ${m} ${p}`);
  }
  assert((await req('GET', '/api/gst/audit-masters', { token: viewer })).status === 200, 'Viewer (financial-view role) may use the tools');
  const bl = await req('POST', '/api/gst/validate-gstin', { token: admin, body: { gstins: ['27AAPFU0939F1ZV', 'bad'] } });
  assert(bl.json.data.length === 2 && bl.json.data[0].valid && !bl.json.data[1].valid, 'Batch GSTIN validation');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr after all GST operations', `${dr}/${cr}`);
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 11, 'Migration 004 recorded');

  console.log('\n====================================================');
  console.log(`📊 GST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

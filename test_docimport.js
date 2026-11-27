process.env.RRE_LEGACY_TOKENS = '1';
process.env.RRE_ENFORCE_AUTH = '1';
/**
 * Document import: PDF / Excel / CSV / scanned documents -> classified, previewed (nothing written), imported through the normal posting
 * engine in one transaction; reports compared, never posted; duplicates, invalid rows, retries, permissions, Day Book / ledgers.
 * Test documents are generated in code (test_helpers/docFixtures.js). Runs on a DISPOSABLE data directory.
 *   node test_docimport.js          PostgreSQL:  npm run test:pg -- test_docimport.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_docimport_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const db = require('./core/db');
const { initDb, get, all, run } = db;
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const F = require('./test_helpers/docFixtures');
const { gstinCheckChar } = require('./core/gstTools');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const gstin = (state, pan) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM approval_rules').catch(() => {});
  const OURS = gstin('33', 'AABCR1234F'), APEX = gstin('33', 'AAACA5555K'), ELGI = gstin('29', 'AAACE7777L'), NEWSUP = gstin('33', 'AAFCN4321P');
  await run('UPDATE company_info SET gstin = ?, state_code = ?', [OURS, '33']);
  const srv = await startServer(14400 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const owner = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const call = (method, p, { token = owner, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
    const rq = http.request(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const b = Buffer.concat(chunks); let json = null; try { json = JSON.parse(b.toString()); } catch (e) { /* binary */ } resolve({ status: res.statusCode, json, buf: b, headers: res.headers }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  const upload = (buf, name, token = owner) => call('POST', '/api/doc-import/upload', { token, raw: buf, headers: { 'X-File-Name': encodeURIComponent(name) } });
  const preview = (id, settings) => call('POST', `/api/doc-import/${id}/preview`, { body: { settings: settings || {} } });
  const commit = (id, settings, token = owner) => call('POST', `/api/doc-import/${id}/commit`, { token, body: { settings: settings || {} } });
  const vcount = async () => Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n);
  const unbalanced = async () => (await all('SELECT v.id FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0')).length;
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  // a customer and a supplier already in the books
  await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state_code) VALUES ('Apex Tech Pvt Ltd', ?, 0, 'Dr', ?, '33')", [await grp('Sundry Debtors'), APEX]);
  await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state_code) VALUES ('Elgi Equipments Ltd', ?, 0, 'Cr', ?, '29')", [await grp('Sundry Creditors'), ELGI]);

  console.log('\n--- 1. PDF sales invoice ---');
  const inv = F.makePdf([[
    { x: 40, y: 760, text: 'RRE ENTRIES', size: 14 }, { x: 40, y: 742, text: `GSTIN: ${OURS}` }, { x: 400, y: 760, text: 'TAX INVOICE', size: 14 },
    { x: 400, y: 740, text: 'Invoice No: S-5001' }, { x: 400, y: 726, text: 'Date: 05-06-2026' },
    { x: 40, y: 700, text: 'Bill To: Apex Tech Pvt Ltd' }, { x: 40, y: 686, text: `GSTIN: ${APEX}` },
    { x: 40, y: 650, text: 'Item' }, { x: 260, y: 650, text: 'Qty' }, { x: 320, y: 650, text: 'Rate' }, { x: 420, y: 650, text: 'Amount' },
    { x: 40, y: 634, text: 'Screw Compressor Service' }, { x: 260, y: 634, text: '1' }, { x: 320, y: 634, text: '10000.00' }, { x: 420, y: 634, text: '10000.00' },
    { x: 300, y: 590, text: 'Taxable Value' }, { x: 420, y: 590, text: '10,000.00' }, { x: 300, y: 576, text: 'CGST @ 9%' }, { x: 420, y: 576, text: '900.00' },
    { x: 300, y: 562, text: 'SGST @ 9%' }, { x: 420, y: 562, text: '900.00' }, { x: 300, y: 546, text: 'Grand Total' }, { x: 420, y: 546, text: '11,800.00' }]]);
  const u1 = await upload(inv, 'sales-invoice-S-5001.pdf');
  assert(u1.status === 200 && u1.json.data.kind === 'pdf' && u1.json.data.classification.category === 'sales_invoice', 'PDF read and recognised as a SALES invoice (our GSTIN is the seller\'s)', JSON.stringify(u1.json && (u1.json.data || u1.json.error)).slice(0, 220));
  const p1 = (await preview(u1.json.data.id)).json.data;
  const r1 = p1.records[0];
  assert(r1 && r1.status === 'ok' && r1.data.invoice_no === 'S-5001' && r1.data.date === '2026-06-05' && r1.data.taxable === 10000 && r1.data.cgst === 900 && r1.data.total === 11800 && /Apex Tech/.test(r1.data.party),
    'invoice no, date, party, taxable ₹10,000, CGST ₹900, SGST ₹900, total ₹11,800 extracted; checks pass', JSON.stringify(r1 && { s: r1.status, d: r1.data, e: r1.errors }).slice(0, 300));
  assert(p1.summary.total_debit === 11800 && p1.summary.total_credit === 11800 && p1.summary.gst === 1800 && p1.summary.invoice_total === 11800, 'preview totals: Dr = Cr ₹11,800, GST ₹1,800');
  const before1 = await vcount();
  assert(await vcount() === before1, 'the preview wrote nothing to the books');
  const c1 = await commit(u1.json.data.id);
  const sv = c1.json && c1.json.data && c1.json.data.created.vouchers[0];
  const v1 = sv ? (await call('GET', `/api/vouchers/${sv.id}`)).json.data : null;
  assert(c1.status === 200 && v1 && v1.voucher_type === 'Sales' && v1.reference_no === 'S-5001' && Number(v1.total_amount) === 11800 && v1.party_name === 'Apex Tech Pvt Ltd' && v1.entries.length === 4,
    'imported as a Sales voucher: Dr Apex ₹11,800 / Cr Sales ₹10,000, CGST ₹900, SGST ₹900 (the normal posting engine)', c1.status + ' ' + JSON.stringify(c1.json).slice(0, 200));
  const day = (await call('GET', '/api/reports/daybook?limit=50&summary=1')).json;
  assert(day.data.some((v) => v.id === sv.id), 'the imported invoice is in the Day Book');
  assert((await commit(u1.json.data.id)).json.data.replayed === true && await vcount() === before1 + 1, 'importing the same document again returns the first result; nothing posted twice');

  console.log('\n--- 2. Excel purchase statement ---');
  const purchXlsx = F.workbook({ 'Purchases June': [
    ['ACME Purchase Register - June 2026'], [],
    ['Bill Date', 'Bill No', 'Supplier', 'GSTIN', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Invoice Total'],
    ['2026-06-02', 'EL/771', 'Elgi Equipments Ltd', ELGI, 20000, 0, 0, 3600, 23600],
    ['2026-06-03', 'NS-12', 'Nova Spares Pvt Ltd', NEWSUP, 5000, 450, 450, 0, 5900],
    ['2026-06-04', 'EL/772', 'Elgi Equipments Ltd', ELGI, 1000, 0, 0, 180, 1180]] });
  const u2 = await upload(purchXlsx, 'purchases-june.xlsx');
  assert(u2.json.data.kind === 'excel' && u2.json.data.classification.category === 'purchase_register', 'Excel recognised as a PURCHASE register', JSON.stringify(u2.json.data.classification));
  const p2 = (await preview(u2.json.data.id)).json.data;
  assert(p2.records.length === 3 && p2.records.every((r) => r.status === 'ok') && p2.summary.invoice_total === 30680 && p2.summary.gst === 4680, '3 bills, all valid; total ₹30,680, GST ₹4,680', JSON.stringify(p2.records.map((r) => [r.status, r.errors])).slice(0, 300));
  assert(p2.unknown_ledgers.length === 1 && p2.unknown_ledgers[0].name === 'Nova Spares Pvt Ltd' && p2.unknown_ledgers[0].will_create, 'the new supplier is listed as "will be created" (Sundry Creditors)');
  const c2 = await commit(u2.json.data.id);
  assert(c2.status === 200 && c2.json.data.imported === 3 && c2.json.data.created.ledgers.some((l) => l.name === 'Nova Spares Pvt Ltd' && l.group === 'Sundry Creditors'), '3 Purchase vouchers posted; Nova Spares created under Sundry Creditors', JSON.stringify(c2.json).slice(0, 200));
  const p2b = (await preview(u2.json.data.id)).json.data;
  assert(p2b.records.every((r) => r.status === 'duplicate'), 'after the import, a re-check shows all 3 bills as already in the books, also the one whose supplier the import created', JSON.stringify(p2b.records.map((r) => [r.data.invoice_no, r.status, r.warnings.join(';')])));
  const elgi = await get("SELECT id FROM ledgers WHERE name = 'Elgi Equipments Ltd'");
  const elgiBal = await get('SELECT ROUND(SUM(credit_amount) - SUM(debit_amount), 2) AS b FROM ledger_entries WHERE ledger_id = ?', [elgi.id]);
  assert(Number(elgiBal.b) === 24780, 'the supplier ledger balance follows (Elgi Cr ₹24,780 = 23,600 + 1,180)');
  const igst = await get("SELECT ROUND(SUM(e.debit_amount), 2) AS d FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE l.name LIKE 'Input IGST%'");
  assert(Number(igst.d) === 3780, 'Input IGST ₹3,780 is in the GST ledger (GST reports read it)');

  console.log('\n--- 3. Scanned bank statement (OCR) ---');
  const bankLines = ['STATEMENT OF ACCOUNT', 'Date        Narration              Withdrawal     Deposit      Balance', '05-06-2026  NEFT APEX TECH                         11800.00     61800.00', '06-06-2026  CHQ 4411 ELGI          23600.00                   38200.00', '08-06-2026  BANK CHARGES              150.00                   38050.00'];
  const img = await F.textJpeg(bankLines);
  const u3 = await upload(F.scannedPdf([img]), 'bank-statement-june-scan.pdf');
  assert(u3.json.data.needs_ocr === true && u3.json.data.status === 'needs_ocr', 'a scanned PDF (no text) is recognised and its pages are sent for OCR');
  const ocr = await call('POST', `/api/doc-import/${u3.json.data.id}/ocr-page?page=1`, { raw: img.jpeg });
  assert(ocr.status === 200 && ocr.json.data.done === 1 && ocr.json.data.classification && ocr.json.data.classification.category === 'bank_statement', `page read with OCR (confidence ${ocr.json && ocr.json.data && ocr.json.data.confidence}%) and recognised as a bank statement`, JSON.stringify(ocr.json).slice(0, 220));
  const p3 = (await preview(u3.json.data.id)).json.data;
  const okLines = p3.records.filter((r) => r.status === 'ok');
  assert(okLines.length === 3 && okLines.some((r) => r.data.deposit === 11800) && okLines.some((r) => r.data.withdrawal === 23600) && okLines.some((r) => r.data.withdrawal === 150), '3 statement lines with the right withdrawals / deposits', JSON.stringify(p3.records.map((r) => [r.status, r.data, r.errors])).slice(0, 400));
  const bankL = (await get("SELECT id FROM ledgers WHERE group_id = (SELECT id FROM account_groups WHERE name = 'Bank Accounts') ORDER BY id LIMIT 1")).id;
  const vb = await vcount();
  const c3 = await commit(u3.json.data.id, { bank_ledger_id: bankL });
  assert(c3.status === 200 && c3.json.data.created.bank_import && await vcount() === vb, 'the statement goes to bank reconciliation (no vouchers are posted from a bank statement)', JSON.stringify(c3.json).slice(0, 200));

  console.log('\n--- 4. Multi-sheet Excel day book (posted) and a trial balance (compared, never posted) ---');
  const book = F.workbook({
    April: [['Date', 'Vch No', 'Vch Type', 'Ledger', 'Debit', 'Credit', 'Narration'], ['2026-04-10', 'JV-1', 'Journal', 'Office Rent', 12000, '', 'April rent provision'], ['', 'JV-1', '', 'Elgi Equipments Ltd', '', 12000, ''],
      ['2026-04-12', 'PY-1', 'Payment', 'Elgi Equipments Ltd', 5000, '', 'part payment'], ['', 'PY-1', '', 'Cash', '', 5000, '']],
    May: [['Date', 'Vch No', 'Vch Type', 'Ledger', 'Debit', 'Credit', 'Narration'], ['2026-05-02', 'RC-1', 'Receipt', 'Cash', 3000, '', 'from Apex'], ['', 'RC-1', '', 'Apex Tech Pvt Ltd', '', 3000, '']] });
  if (!(await get("SELECT id FROM ledgers WHERE name = 'Office Rent'"))) await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES ('Office Rent', ?, 0, 'Dr')", [await grp('Indirect Expenses')]);
  const u4 = await upload(book, 'daybook-apr-may.xlsx');
  const p4 = (await preview(u4.json.data.id)).json.data;
  assert(p4.category === 'transactions' && p4.records.length === 3 && p4.records.every((r) => r.status === 'ok') && p4.summary.total_debit === 20000, 'both sheets read: 3 vouchers (Journal, Payment, Receipt), each balanced, total ₹20,000', JSON.stringify({ c: p4.category, r: p4.records.map((r) => [r.status, r.errors]) }).slice(0, 300));
  const c4 = await commit(u4.json.data.id);
  assert(c4.status === 200 && c4.json.data.created.vouchers.map((v) => v.voucher_type).join(',') === 'Journal,Payment,Receipt' && c4.json.data.created.vouchers[0].voucher_no === 'JV-1', 'posted with their own numbers and types');
  const tbXlsx = F.workbook({ TB: [['Trial Balance as on 31-05-2026'], ['Particulars', 'Debit', 'Credit'], ['Office Rent', 12000, ''], ['Apex Tech Pvt Ltd', 99999, ''], ['Elgi Equipments Ltd', '', 31780], ['Total', 111999, 31780]] });
  const vt = await vcount();
  const u5 = await upload(tbXlsx, 'trial-balance.xlsx');
  const p5 = (await preview(u5.json.data.id)).json.data;
  const elgiR = p5.records.find((r) => /Elgi/.test(r.data.name)), apex = p5.records.find((r) => /Apex/.test(r.data.name));
  assert(p5.category === 'trial_balance' && p5.kind === 'report' && elgiR.compare.difference === 0 && elgiR.compare.in_books === -31780 && apex.compare.difference !== 0, 'a trial balance is a REPORT: compared ledger by ledger with the books (Elgi Cr ₹31,780 matches, Apex differs)', JSON.stringify(p5.records.map((r) => r.compare)).slice(0, 300));
  const c5 = await commit(u5.json.data.id);
  assert(c5.status === 400 && /never turned into vouchers/.test(c5.json.error) && await vcount() === vt, 'importing a report is refused: no vouchers are created from a trial balance');

  console.log('\n--- 5. GST report (compared, not posted) ---');
  const gstPdf = F.tablePdf({ title: ['GSTR-1 Summary June 2026'], columns: ['Particulars', 'Taxable', 'IGST', 'CGST', 'SGST'], colX: [40, 220, 300, 380, 460], rows: [['B2B Invoices', '10000.00', '0.00', '900.00', '900.00']] });
  const u6 = await upload(gstPdf, 'gstr1-june.pdf');
  assert(u6.json.data.classification.category === 'gst_report', 'recognised as a GST report');
  const vg = await vcount();
  assert((await commit(u6.json.data.id)).status === 400 && await vcount() === vg, 'a GST report is compared, never posted');

  console.log('\n--- 6. Large multi-page PDF (120 invoices) ---');
  const rows = []; for (let i = 1; i <= 120; i++) { const t = 1000 + i; rows.push([`${String(1 + (i % 28)).padStart(2, '0')}-06-2026`, `SR-${1000 + i}`, i % 2 ? 'Apex Tech Pvt Ltd' : 'Walk-in Customer', t.toFixed(2), (t * 0.09).toFixed(2), (t * 0.09).toFixed(2), (t * 1.18).toFixed(2)]); }
  const big = F.tablePdf({ title: ['Sales Register June 2026'], columns: ['Date', 'Invoice No', 'Party', 'Taxable', 'CGST', 'SGST', 'Total'], colX: [40, 110, 190, 330, 400, 460, 520], rows, perPage: 45 });
  const u7 = await upload(big, 'sales-register-june.pdf');
  assert(u7.json.data.pages === 3 && u7.json.data.classification.category === 'sales_register', `3-page PDF recognised as a sales register (${u7.json.data.pages} pages)`);
  const p7 = (await preview(u7.json.data.id)).json.data;
  const expTotal = r2(rows.reduce((t, r) => t + Number(r[6]), 0));
  assert(p7.records.length === 120 && p7.records.every((r) => r.status === 'ok') && p7.summary.invoice_total === expTotal, `all 120 invoices across 3 pages (the header repeated on each page is skipped), total ₹${expTotal}`, `${p7.records.length} ${p7.summary.invoice_total} ${JSON.stringify(p7.records.filter((r) => r.status !== 'ok').slice(0, 2).map((r) => [r.row, r.errors]))}`);
  const v7 = await vcount();
  const c7 = await commit(u7.json.data.id);
  assert(c7.status === 200 && await vcount() === v7 + 120 && await unbalanced() === 0, '120 Sales vouchers posted in one transaction, all balanced');

  console.log('\n--- 7. Duplicates ---');
  const dupX = F.workbook({ Sales: [['Date', 'Invoice No', 'Customer', 'Taxable', 'CGST', 'SGST', 'Total'], ['2026-06-20', 'D-1', 'Apex Tech Pvt Ltd', 100, 9, 9, 118], ['2026-06-20', 'D-1', 'Apex Tech Pvt Ltd', 100, 9, 9, 118], ['2026-06-21', 'SR-1001', 'Apex Tech Pvt Ltd', 1001, 90.09, 90.09, 1181.18], ['2026-06-22', 'D-2', 'Apex Tech Pvt Ltd', 200, 18, 18, 236]] });
  const u8 = await upload(dupX, 'sales-with-duplicates.xlsx');
  const p8 = (await preview(u8.json.data.id)).json.data;
  const st = p8.records.map((r) => r.status);
  assert(st.join(',') === 'ok,duplicate,duplicate,ok', 'the repeated D-1 and SR-1001 (already in the books) are flagged as duplicates', st.join(','));
  const v8 = await vcount(); const c8 = await commit(u8.json.data.id);
  assert(c8.json.data.imported === 2 && c8.json.data.rejected === 2 && await vcount() === v8 + 2 && c8.json.data.rejected_records.every((r) => /twice|already in the books/i.test(r.reason)), 'only D-1 (once) and D-2 are imported; the 2 duplicates are listed with the reason');
  const again = await upload(dupX, 'sales-with-duplicates (copy).xlsx');
  const pa = (await preview(again.json.data.id)).json.data;
  assert(again.json.data.already_imported && pa.records.every((r) => r.status !== 'ok') && (await commit(again.json.data.id)).status === 400 && await vcount() === v8 + 2, 're-uploading the same file: flagged as already imported, every record is a duplicate, nothing is posted');

  console.log('\n--- 8. Missing and invalid values ---');
  const badX = F.workbook({ Sales: [['Date', 'Invoice No', 'Customer', 'Taxable', 'CGST', 'SGST', 'Total'],
    ['2026-06-25', 'B-1', 'Apex Tech Pvt Ltd', 500, 45, 45, 590],
    ['31-13-2026', 'B-2', 'Apex Tech Pvt Ltd', 500, 45, 45, 590],
    ['2026-06-25', 'B-3', '', 500, 45, 45, 590],
    ['2026-06-25', 'B-4', 'Apex Tech Pvt Ltd', 500, 45, 45, 700],
    ['2026-06-25', 'B-5', 'Apex Tech Pvt Ltd', 'five hundred', 45, 45, 590],
    ['2026-06-25', 'B-6', 'Apex Tech Pvt Ltd', 500, 45, 30, 575],
    ['2030-01-01', 'B-7', 'Apex Tech Pvt Ltd', 500, 45, 45, 590]] });
  const u9 = await upload(badX, 'sales-with-errors.xlsx');
  const p9 = (await preview(u9.json.data.id)).json.data;
  const errs = Object.fromEntries(p9.records.map((r) => [r.data.invoice_no, r.errors.join(' | ')]));
  assert(p9.records[0].status === 'ok' && p9.summary.errors === 6, '1 valid row, 6 rows with errors', JSON.stringify(errs).slice(0, 400));
  assert(/Invalid date "31-13-2026"/.test(errs['B-2']) && /Party name is missing/.test(errs['B-3']) && /does not equal taxable/.test(errs['B-4']) && /not a number/.test(errs['B-5']) && /must be equal/.test(errs['B-6']) && /future/.test(errs['B-7']),
    'each problem is explained: invalid date, missing party, total ≠ taxable + GST, not a number, CGST ≠ SGST, future date');
  assert(p9.records.every((r) => r.row) && p9.records[1].row === 3, 'each record shows its sheet row number (B-2 is row 3)');
  const fixed = await preview(u9.json.data.id, { edits: { 2: { date: '2026-06-26' } } });
  assert(fixed.json.data.records[1].status === 'ok' && fixed.json.data.records[1].edited, 'a value corrected in the preview (B-2\'s date) makes that record valid');
  const v9 = await vcount(); const c9 = await commit(u9.json.data.id, { edits: { 2: { date: '2026-06-26' } } });
  assert(c9.json.data.imported === 2 && c9.json.data.rejected === 5 && await vcount() === v9 + 2, 'the 2 valid records are imported; the 5 invalid ones are rejected with their reasons (nothing silently dropped)');
  const vr = c9.json.data.verification || {};
  assert(vr.vouchers_expected === 2 && vr.vouchers_found === 2 && vr.balanced && vr.dates.includes('2026-06-26') && vr.ledgers.some((l) => l.name === 'Apex Tech Pvt Ltd'),
    'after saving, the vouchers are read back from the books: both found, balanced, on their Day Book dates, with the closing balance of each ledger', JSON.stringify(vr).slice(0, 300));
  const fi = c9.json.data.file_info || {};
  assert(fi.kind === 'excel' && fi.sheets.join() === 'Sales' && fi.rows === 8 && c9.json.data.totals.gst === 180 && c9.json.data.totals.debit === c9.json.data.totals.credit,
    'the result shows the file type, its sheets, the rows read and the Dr / Cr / GST totals of what was imported', JSON.stringify({ fi, t: c9.json.data.totals }));
  // correct two rejected rows AFTER the import and import just those (the 2 already imported are never posted again)
  const fixEdits = { 2: { date: '2026-06-26' }, 3: { party: 'Apex Tech Pvt Ltd' }, 4: { total: '590' } };
  const again9 = await commit(u9.json.data.id, { edits: fixEdits });
  assert(again9.json.data.replayed === true && await vcount() === v9 + 2, 'a second Import click without "correct" returns the first result (nothing posted twice)');
  const cont = await commit(u9.json.data.id, { edits: fixEdits, continue: true });
  assert(cont.status === 200 && cont.json.data.imported_now === 2 && cont.json.data.imported === 4 && cont.json.data.rejected === 3 && await vcount() === v9 + 4,
    'the corrected rejected rows (B-3 party, B-4 total) are imported afterwards; the first 2 are not posted again; 3 still rejected', JSON.stringify(cont.json).slice(0, 300));
  const pv9 = (await preview(u9.json.data.id, { edits: fixEdits })).json.data;
  assert(pv9.records.filter((r) => r.status === 'duplicate').length === 4 && cont.json.data.valid === 4, 'after that, the 4 imported records show as already in the books (duplicates), and the result counts 4 valid (not double)', JSON.stringify(pv9.records.map((r) => [r.data.invoice_no, r.status, r.warnings.join(';')])) + ' valid=' + cont.json.data.valid);
  const cont2 = await commit(u9.json.data.id, { edits: fixEdits, continue: true });
  assert(cont2.status === 400 && await vcount() === v9 + 4, 'running the correction import again posts nothing (everything valid is already in)');
  assert((await get('SELECT imported, rejected FROM import_documents WHERE id = ?', [u9.json.data.id])).imported === 4, 'the import history shows the new total (4 imported)');
  // the same with NEW suppliers over two sheets (as in the browser test)
  const ms = F.workbook({
    April: [['Bill Date', 'Bill No', 'Supplier', 'Taxable Value', 'CGST', 'SGST', 'Invoice Total'], ['2026-04-05', 'PA-1', 'Sheet Supplier One', 2000, 180, 180, 2360], ['2026-04-18', 'PA-2', 'Sheet Supplier One', 3000, 270, 270, 3540], ['2026-04-20', 'PA-3', '', 1000, 90, 90, 1180]],
    May: [['Bill Date', 'Bill No', 'Supplier', 'Taxable Value', 'CGST', 'SGST', 'Invoice Total'], ['2026-05-02', 'PM-1', 'Sheet Supplier Two', 5000, 450, 450, 5900], ['2026-05-09', 'PM-2', 'Sheet Supplier Two', 800, 72, 72, 999]] });
  const ums = await upload(ms, 'purchases-apr-may.xlsx');
  const scGroup = (await get("SELECT id FROM account_groups WHERE name = 'Sundry Creditors'")).id;
  // the screen sends the "create it under Sundry Creditors" choice it showed before the first import
  const msEdits = { 3: { party: 'Sheet Supplier One' }, 5: { total: '944' } }, msMap = { 'Sheet Supplier One': `create:${scGroup}`, 'Sheet Supplier Two': `create:${scGroup}` };
  const cms = await commit(ums.json.data.id, { ledger_map: msMap });
  const pms = (await preview(ums.json.data.id, { edits: msEdits, ledger_map: msMap })).json.data;
  const cms2 = await commit(ums.json.data.id, { edits: msEdits, ledger_map: msMap, continue: true });
  assert(cms.json.data.imported === 3 && cms2.json.data.imported === 5 && cms2.json.data.valid === 5 && pms.records.filter((r) => r.status === 'duplicate').length === 3,
    'two sheets, new suppliers: 3 imported, then the 2 corrected; the result says 5 valid / 5 imported', JSON.stringify({ first: cms.json.data.imported, then: cms2.json.data.imported, valid: cms2.json.data.valid, recs: pms.records.map((r) => [r.n, r.data.invoice_no, r.status, r.warnings.join(';').slice(0, 60)]) }));

  console.log('\n--- customers / suppliers and stock ---');
  const parties = F.csv([['Customer Name', 'GSTIN', 'Mobile', 'Email', 'City'], ['Coimbatore Pumps', gstin('33', 'AAGCC2222Q'), '9840012345', 'buy@cbepumps.example', 'Coimbatore'], ['Apex Tech Pvt Ltd', APEX, '', '', '']]);
  const u10 = await upload(parties, 'customer-list.csv');
  const p10 = (await preview(u10.json.data.id, { party_kind: 'customer' })).json.data;
  assert(p10.category === 'party_list' && p10.records[0].status === 'ok' && p10.records[1].status === 'exists', 'a customer list: the new customer is valid, Apex already exists (left unchanged)');
  const c10 = await commit(u10.json.data.id, { party_kind: 'customer' });
  const cp = await get("SELECT l.name, g.name grp, p.phone, p.email FROM ledgers l JOIN account_groups g ON g.id = l.group_id LEFT JOIN party_profiles p ON p.ledger_id = l.id WHERE l.name = 'Coimbatore Pumps'");
  assert(c10.status === 200 && cp && cp.grp === 'Sundry Debtors' && cp.phone === '9840012345', 'Coimbatore Pumps created as a customer with phone and e-mail');
  const stock = F.csv([['Stock Summary'], ['Item', 'Qty', 'Unit', 'Rate', 'Value'], ['Air Filter AF-20', '40', 'Nos', '250', '10000'], ['Compressor Oil 20L', '12', 'Cans', '3200', '38400']]);
  const u11 = await upload(stock, 'stock-summary.csv');
  const c11 = await commit(u11.json.data.id);
  const af = await get("SELECT opening_qty q, opening_val v FROM stock_items WHERE name = 'Air Filter AF-20'");
  assert(c11.status === 200 && af && Number(af.q) === 40 && Number(af.v) === 10000, 'a stock statement creates the items with their opening quantity and value (40 × ₹250)');

  console.log('\n--- all or nothing; permissions; other devices ---');
  const atomic = F.workbook({ J: [['Date', 'Vch No', 'Vch Type', 'Ledger', 'Debit', 'Credit'], ['2026-06-28', 'AT-1', 'Journal', 'Office Rent', 100, ''], ['', 'AT-1', '', 'Cash', '', 100], ['2026-06-28', 'AT-2', 'Journal', 'Ghost Ledger', 200, ''], ['', 'AT-2', '', 'Cash', '', 200]] });
  const u12 = await upload(atomic, 'atomic.xlsx');
  // the 2nd voucher's new ledger is to be created under a group that does not exist: this fails only WHILE saving, after the 1st was written
  const atomicSettings = { ledger_map: { 'Ghost Ledger': 'create:999999' } };
  const pa12 = (await preview(u12.json.data.id, atomicSettings)).json.data;
  const va = await vcount();
  const c12 = await commit(u12.json.data.id, atomicSettings);
  assert(pa12.records.every((r) => r.status === 'ok') && c12.status >= 400 && await vcount() === va && !(await get("SELECT id FROM vouchers WHERE voucher_no = 'AT-1'")), 'when one voucher fails during the import, NOTHING from that document is posted (one transaction)', `${c12.status} ${JSON.stringify(c12.json).slice(0, 150)}`);
  assert((await get('SELECT status, error FROM import_documents WHERE id = ?', [u12.json.data.id])).status === 'failed', 'the failed import is recorded as failed with its error (it can be retried)');
  assert((await upload(inv, 'x.pdf', viewer)).status === 403, 'a Viewer may not upload documents (403)');
  const clerkJ = F.workbook({ J: [['Date', 'Vch No', 'Vch Type', 'Ledger', 'Debit', 'Credit'], ['2026-06-28', 'CL-1', 'Journal', 'Office Rent', 50, ''], ['', 'CL-1', '', 'Cash', '', 50]] });
  const je = await upload(clerkJ, 'clerk.xlsx', clerk);
  const cj = await commit(je.json.data.id, {}, clerk);
  assert(cj.status === 403 && /Journal/.test(cj.json.error), 'Data Entry may not import Journal vouchers (its role cannot post them)', cj.status + ' ' + JSON.stringify(cj.json).slice(0, 120));
  const hist = (await call('GET', '/api/doc-import', { token: acc })).json.data;
  assert(hist.length >= 12 && hist.some((h) => h.file_name === 'purchases-june.xlsx' && h.status === 'imported' && h.imported === 3 && h.uploaded_by === 'admin'), 'Import History (seen by another user): file, who, when, type, detected / imported / rejected, status');
  const det = (await call('GET', `/api/doc-import/${u2.json.data.id}`, { token: acc })).json.data;
  assert(det.result && det.result.created.vouchers.length === 3, 'the import result (vouchers created) can be opened');
  const orig = await call('GET', `/api/doc-import/${u2.json.data.id}/file`, { token: acc });
  assert(orig.status === 200 && orig.buf.equals(purchXlsx) && /attachment/.test(orig.headers['content-disposition']), 'the original uploaded file is kept and downloads byte-for-byte identical');
  assert((await call('GET', '/api/doc-import', { token: viewer })).status === 200 && (await call('GET', `/api/doc-import/${u2.json.data.id}/file`, { token: clerk })).status === 200, 'roles that may see the books can open the history');
  assert((await get("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'DOCUMENT_IMPORT'")).n >= 6, 'every import is in the audit log');
  assert(await unbalanced() === 0 && Number((await get('SELECT ROUND(SUM(debit_amount) - SUM(credit_amount), 2) d FROM ledger_entries')).d) === 0, 'the books still balance after every import');

  console.log(`\nDocument import: ${passed} passed, ${failed} failed  (database: ${db.isPostgres() ? 'PostgreSQL' : 'SQLite'})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

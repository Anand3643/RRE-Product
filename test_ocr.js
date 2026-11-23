process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Invoice scanning: offline OCR + field extraction + reviewed draft. Uses a real image (test_fixtures/invoice_sample.png).
 * Runs against a DISPOSABLE data directory.   npm run test:ocr
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_ocr_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const ex = require('./core/invoiceExtract');
const ocr = require('./core/ocr');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

// What the OCR engine really returned for the fixture (note the stray space and the letter O in the GSTINs)
const OCR_TEXT = `SHARMA PNEUMATIC SPARES

GSTIN: 27AAPFU0939F 1ZV

TAX INVOICE

Invoice No: SPS/2026/0457

Invoice Date: 14-09-2026

Bill To: RRE Tally GSTIN: O7AAGFF2194N1Z1
Air filter element HSN 84213920 10x1,200.00 12,000.00
Taxable Value 12,000.00

CGST @9% 1,080.00

SGST @9% 1,080.00

Grand Total 14,160.00
`;

function blankPng(w = 200, h = 80) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(10100 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const vcount = async () => (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const fixture = fs.readFileSync(path.join(__dirname, 'test_fixtures', 'invoice_sample.png'));

  console.log('\n--- 1. Extraction from the real OCR text (no matching ledger yet) ---');
  let x = await ex.extractInvoice(OCR_TEXT, { ocrConfidence: 90 });
  const f = x.fields;
  assert(f.supplier_gstin.value === '27AAPFU0939F1ZV' && f.supplier_gstin.confidence === 'medium' && /corrected/.test(f.supplier_gstin.note), 'Supplier GSTIN read as "27AAPFU0939F 1ZV", repaired, and confirmed by the check digit', JSON.stringify(f.supplier_gstin));
  assert(f.buyer_gstin.value === '07AAGFF2194N1Z1', 'Buyer GSTIN "O7AAGF…" (letter O) repaired to 07AAGFF2194N1Z1 and identified as the bill-to party');
  assert(f.invoice_no.value === 'SPS/2026/0457' && f.date.value === '2026-09-14' && f.date.confidence === 'high', 'Invoice number and date (labelled "Invoice Date")');
  assert(f.taxable_value.value === 12000 && f.tax.cgst === 1080 && f.tax.sgst === 1080 && f.tax.igst === 0 && f.tax.rates.cgst === 9 && f.total.value === 14160, 'Taxable ₹12,000; CGST ₹1,080 @9%; SGST ₹1,080; total ₹14,160');
  assert(x.consistent === true && f.hsn[0].code === '84213920' && f.hsn[0].valid, 'Amounts add up; HSN 84213920 recognised and valid');
  assert(x.supplier === null && x.warnings.some((w) => /not in your ledgers/.test(w)) && x.needs_review === true, 'Unknown supplier: warns, and the result is marked "needs review"');
  assert(x.draft_voucher.voucher_type === 'Purchase' && x.draft_voucher.complete === false && x.draft_voucher.entries.at(-1).ledger_id === null, 'The draft is incomplete (supplier ledger not chosen) — it cannot be mistaken for a finished voucher');
  assert(x.draft_voucher.is_balanced && x.draft_voucher.total_amount === 14160, 'Even so, the draft lines balance at ₹14,160');
  assert(/verify|check/i.test(x.note), 'Carries a "check every number" notice');

  console.log('\n--- 2. Matching the supplier ledger ---');
  const sup = await run("INSERT INTO ledgers (name, group_id, gstin) VALUES ('Sharma Pneumatic Spares', 17, '')");
  x = await ex.extractInvoice(OCR_TEXT);
  assert(x.supplier && x.supplier.method === 'name' && x.supplier.name === 'Sharma Pneumatic Spares' && x.supplier.confidence !== 'high', 'No GSTIN on the ledger: matched by NAME with reduced confidence');
  await run("UPDATE ledgers SET gstin = '27AAPFU0939F1ZV' WHERE id = ?", [sup.lastID]);
  x = await ex.extractInvoice(OCR_TEXT);
  assert(x.supplier.method === 'gstin' && x.supplier.confidence === 'high' && x.supplier.ledger_id === sup.lastID, 'With the GSTIN on the ledger: matched by GSTIN (high confidence)');
  const d = x.draft_voucher;
  const byName = Object.fromEntries(d.entries.map((e) => [e.ledger_name, e]));
  assert(d.entries.length === 4 && byName['Purchase Account - Spares & Machines'].debit_amount === 12000 && byName['Input CGST 9%'].debit_amount === 1080 && byName['Input SGST 9%'].debit_amount === 1080 && byName['Sharma Pneumatic Spares'].credit_amount === 14160, 'Draft: Dr Purchase 12,000 + Input CGST 1,080 + Input SGST 1,080; Cr Sharma 14,160');
  assert(d.is_balanced && d.complete && d.party_ledger_id === sup.lastID && d.reference_no === 'SPS/2026/0457' && d.date === '2026-09-14', 'Draft is balanced and complete, with the supplier invoice number as reference and the invoice date');
  assert(/scanned; please verify/.test(d.narration), 'Narration marks the voucher as scanned');
  assert(x.needs_review === false && x.warnings.length === 0, 'All key fields found, amounts consistent, supplier matched: nothing specific is flagged');
  await run("UPDATE company_info SET gstin = '07AAGFF2194N1Z1'");
  x = await ex.extractInvoice(OCR_TEXT);
  assert(x.warnings.length === 0 && x.needs_review === false && x.draft_voucher.confidence_score === 0.9, 'Company GSTIN matches the bill-to GSTIN: no warnings, review flag cleared, confidence 0.9', JSON.stringify(x.warnings));
  await run("UPDATE company_info SET gstin = '29AAACB1234F1Z3'");
  x = await ex.extractInvoice(OCR_TEXT);
  assert(x.warnings.some((w) => /not your company GSTIN/.test(w)) && x.needs_review, 'Invoice addressed to a different GSTIN than yours: warned (ITC at risk)');
  await run("UPDATE company_info SET gstin = '07AAGFF2194N1Z1'");

  console.log('\n--- 3. Duplicate detection ---');
  const before = await vcount();
  await req('POST', '/api/vouchers', { body: { voucher_type: 'Purchase', voucher_no: 'OC/1', date: '2026-09-14', reference_no: 'SPS/2026/0457', party_ledger_id: sup.lastID,
    entries: [{ ledger_id: await L('Purchase Account - Spares & Machines'), debit_amount: 14160 }, { ledger_id: sup.lastID, credit_amount: 14160 }] } });
  x = await ex.extractInvoice(OCR_TEXT);
  assert(x.duplicates.length === 1 && x.duplicates[0].level === 'high' && x.warnings.some((w) => /already recorded/.test(w)) && x.needs_review, 'The same supplier invoice number already in the books is flagged as a duplicate');

  console.log('\n--- 4. Variations ---');
  const igst = await ex.extractInvoice(OCR_TEXT.replace('CGST @9% 1,080.00', 'IGST @18% 2,160.00').replace('SGST @9% 1,080.00', ''));
  assert(igst.fields.tax.igst === 2160 && igst.draft_voucher.entries.some((e) => e.ledger_name === 'Input IGST 18%' && e.debit_amount === 2160) && !igst.draft_voucher.entries.some((e) => /CGST|SGST/.test(e.ledger_name)) && igst.consistent, 'Inter-state invoice: IGST ₹2,160 booked to Input IGST, no CGST/SGST lines');
  const wrong = await ex.extractInvoice(OCR_TEXT.replace('Grand Total 14,160.00', 'Grand Total 15,160.00'));
  assert(wrong.consistent === false && wrong.warnings.some((w) => /12000 \+ tax 2160 = 14160, but the total reads 15160/.test(w)) && wrong.needs_review, 'A misread total is caught: taxable + tax ≠ total');
  const rnd = await ex.extractInvoice(OCR_TEXT.replace('Grand Total 14,160.00', 'Grand Total 14,160.40'));
  assert(rnd.draft_voucher.is_balanced && rnd.draft_voucher.entries.some((e) => e.ledger_name === 'Round Off A/c' && e.debit_amount === 0.4) && rnd.draft_voucher.total_amount === 14160.4, 'A ₹0.40 rounding difference goes to Round Off and the draft still balances');
  const noTaxable = await ex.extractInvoice(OCR_TEXT.replace('Taxable Value 12,000.00', ''));
  assert(noTaxable.fields.taxable_value.value === 12000 && noTaxable.fields.taxable_value.confidence === 'medium' && noTaxable.warnings.some((w) => /worked out as total − tax/.test(w)), 'Taxable value missing: inferred as total − tax, marked medium confidence');
  const badChk = await ex.extractInvoice(OCR_TEXT.replace('27AAPFU0939F 1ZV', '27AAPFU0939F1ZW'));
  assert(badChk.fields.supplier_gstin.confidence === 'low' && badChk.warnings.some((w) => /check digit/.test(w)), 'A GSTIN with a wrong check digit is flagged low-confidence (not silently accepted)');
  const noise = await ex.extractInvoice('REF: ABCDEFGHIJKLMNO\nInvoice No: X-1\nTotal 500.00');
  assert(!noise.fields.supplier_gstin && noise.warnings.some((w) => /No GSTIN/.test(w)), 'Random 15-letter strings are not mistaken for a GSTIN');
  const junk = await ex.extractInvoice('hello world, nothing useful here');
  assert(!junk.fields.total && junk.draft_voucher === null && junk.needs_review && junk.warnings.length >= 3, 'Unrelated text: no fields, no draft, flagged for review');
  const empty = await ex.extractInvoice('');
  assert(empty.draft_voucher === null && empty.needs_review, 'Empty text handled');
  const dated = await ex.extractInvoice('ACME TRADERS\nGSTIN: 27AAPFU0939F1ZV\nBill No: AB-77\nDated 5 Sep 2026\nDue date 05/10/2026\nTotal 1,000.00');
  assert(dated.fields.date.value === '2026-09-05' && dated.fields.invoice_no.value === 'AB-77', 'Other layouts: "Bill No", "Dated 5 Sep 2026" (due date is not taken as the invoice date)');
  assert((await ex.forLegacyParser('no total here at all')) === null, 'Text with no total is left to the original parser');

  console.log('\n--- 5. Existing "Parse Invoice / Bill Document" endpoint ---');
  const lp = await req('POST', '/api/ai/parse-document', { body: { text: OCR_TEXT } });
  const dv = lp.json.document_parsed.draft_voucher;
  assert(lp.status === 200 && lp.json.success && lp.json.document_parsed.invoice_no === 'SPS/2026/0457' && lp.json.document_parsed.detected_amount === 14160 && lp.json.document_parsed.detected_gstin === '27AAPFU0939F1ZV', 'The existing endpoint returns the improved extraction in its original response shape');
  assert(dv.entries.length >= 4 && dv.is_balanced && 'confidence_score' in dv && dv.voucher_type === 'Purchase', 'Its draft voucher keeps the fields the existing screen reads');
  const old = await req('POST', '/api/ai/parse-document', { body: { text: 'Invoice 1045 amount due 5000' } });
  assert(old.status === 200 && old.json.success && old.json.document_parsed.draft_voucher, 'Text the new extractor cannot use still reaches the original parser');
  assert((await req('POST', '/api/ai/parse-document', { token: null, body: { text: OCR_TEXT } })).status === 401, 'Still requires login');

  console.log('\n--- 6. Scanning a real image (offline OCR) ---');
  const scan = (img, token = admin) => req('POST', '/api/ocr/scan', { token, body: { image_base64: Buffer.isBuffer(img) ? img.toString('base64') : img } });
  assert((await scan(fixture, null)).status === 401 && (await scan(fixture, viewer)).status === 403, 'Scanning needs login and a role that can create vouchers');
  const t0 = Date.now();
  const s1 = await scan(fixture, clerk);
  const ms = Date.now() - t0;
  assert(s1.status === 200 && s1.json.data.ocr.confidence >= 70 && /SPS\/2026\/0457/.test(s1.json.data.ocr.text) && /Grand Total/i.test(s1.json.data.ocr.text), `Data Entry can scan; the engine read the invoice (confidence ${s1.json.data?.ocr.confidence}%) in ${ms} ms`, (s1.raw || '').slice(0, 200));
  const sx = s1.json.data.extraction;
  assert(sx.fields.invoice_no.value === 'SPS/2026/0457' && sx.fields.date.value === '2026-09-14' && sx.fields.total.value === 14160 && sx.fields.tax.cgst === 1080 && sx.fields.taxable_value.value === 12000, 'End to end: the PNG gives invoice no., date, taxable, CGST and total');
  assert(sx.fields.supplier_gstin.value === '27AAPFU0939F1ZV' && sx.supplier.method === 'gstin' && sx.draft_voucher.complete, 'End to end: supplier GSTIN found and matched to the ledger; draft complete');
  assert(await vcount() === before + 1, 'Scanning posted nothing (only the one voucher I created in step 3 exists beyond the demo data)');
  const par = await Promise.all([scan(fixture), scan(fixture), scan(fixture)]);
  assert(par.every((r) => r.status === 200 && r.json.data.extraction.fields.total.value === 14160), 'Three simultaneous scans are processed (queued) and all succeed');

  console.log('\n--- 7. Bad input ---');
  assert((await scan('!!!')).status === 400 && (await scan('')).status === 400, 'Invalid / empty base64 rejected');
  assert((await scan(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200)]))).status === 400, 'A PDF is refused with advice (export as an image or paste the text)');
  assert((await scan(Buffer.from('plain text pretending to be an image'))).status === 400, 'Non-image data refused');
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6.5 * 1024 * 1024)]);
  assert((await scan(big)).status === 413, 'An image over 6 MB is refused');
  const blank = await scan(blankPng());
  assert(blank.status === 422 && /No text could be read/.test(blank.json.error), 'A blank image: clear message, no crash');
  const hdrBad = await scan(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('this is not a real png body')]));
  assert(hdrBad.status === 400 && /valid PNG or JPEG/.test(hdrBad.json.error), 'A file with a PNG signature but no valid header is refused up front');
  const body = blankPng(); for (let i = body.length - 40; i < body.length - 16; i++) body[i] ^= 0xff; // keep the header valid, damage the pixel data
  const bodyBad = await scan(body);
  assert([200, 422].includes(bodyBad.status) && (bodyBad.status === 200 || bodyBad.json.success === false), 'A PNG with a valid header but damaged pixel data returns a clean response (an internal OCR error does NOT crash the server)', String(bodyBad.status));
  const bomb = blankPng(); bomb.writeUInt32BE(30000, 16); bomb.writeUInt32BE(30000, 20);
  assert((await scan(bomb)).status === 400, 'A header claiming 30,000 × 30,000 pixels (decompression bomb) is refused');
  const jpgNoFrame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda]), Buffer.alloc(50)]);
  assert((await scan(jpgNoFrame)).status === 400, 'A JPEG without a frame header is refused');
  const imgInfo = ocr.imageInfo(fixture);
  assert(imgInfo.type === 'png' && imgInfo.width === 1500 && imgInfo.height === 1100, 'Image size is read from the header (1500 × 1100)');
  const after = await scan(fixture);
  assert(after.status === 200 && after.json.data.extraction.fields.total.value === 14160, 'After bad inputs the scanner still works (a failure does not block the queue)');

  console.log('\n--- 8. Text endpoint, limits, audit ---');
  const te = await req('POST', '/api/ocr/extract', { token: clerk, body: { text: OCR_TEXT } });
  assert(te.status === 200 && te.json.data.extraction.fields.total.value === 14160, '/extract works on pasted text');
  assert((await req('POST', '/api/ocr/extract', { body: { text: '' } })).status === 400 && (await req('POST', '/api/ocr/extract', { body: { text: 'x'.repeat(60001) } })).status === 413 && (await req('POST', '/api/ocr/extract', { token: viewer, body: { text: 'x' } })).status === 403, '/extract: empty 400, too long 413, Viewer 403');
  const log = (await req('GET', '/api/platform/activity-log?limit=60')).json.data;
  assert(log.some((l) => l.action === 'INVOICE_SCAN' && l.username === 'dataentry' && /ocr_confidence/.test(l.details)), 'Scans are in the activity log (size, OCR confidence, whether review is needed — never the invoice text)');
  assert(!log.some((l) => l.action === 'INVOICE_SCAN' && /SPS\/2026/.test(l.details || '')), 'The activity log does not store invoice contents');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);
  assert(ocr.detect(fixture) === 'png' && ocr.detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])) === 'jpg' && ocr.detect(Buffer.from('GIF89a')) === null, 'Image type is decided from the file bytes (PNG, JPEG only)');

  await ocr.shutdown();
  console.log('\n====================================================');
  console.log(`📊 OCR RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

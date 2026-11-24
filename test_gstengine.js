process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * GSTR-1 / GSTR-3B classification by ledger group (not by label text).
 * Runs against a DISPOSABLE data directory.   npm run test:gstengine
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_gstengine_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { returnEntries } = require('./public/ext/invoice-compose');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(7500 + Math.floor(Math.random() * 200), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const admin = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { Authorization: 'Bearer ' + admin, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const ledgers = (await req('GET', '/api/masters/ledgers')).json.data;
  const L = (n) => ledgers.find((l) => l.name === n);
  const gst = async () => (await req('GET', '/api/reports/gst')).json.data;
  const post = (body) => req('POST', '/api/vouchers', body);

  console.log('\n--- 1. The reported problem: sales booked to "Interstate Sales (IGST)" ---');
  const g0 = await gst();
  // seed: V1 taxable 345,000 (CGST/SGST 31,050 each); V2 interstate taxable 110,000, IGST 19,800
  assert(g0.gstr1.total_taxable === 455000, 'GSTR-1 taxable = ₹4,55,000 (345,000 + 110,000)', String(g0.gstr1.total_taxable));
  assert(g0.gstr1.total_igst === 19800, 'GSTR-1 IGST = ₹19,800 (was ₹1,29,800 — taxable value was being counted as tax)', String(g0.gstr1.total_igst));
  assert(g0.gstr1.total_cgst === 31050 && g0.gstr1.total_sgst === 31050, 'CGST / SGST unchanged (₹31,050 each)');
  const v2 = g0.gstr1.b2b_invoices.find((r) => r.voucher_no === 'RRE/SALES/002');
  assert(v2 && v2.taxable_value === 110000 && v2.igst === 19800 && v2.cgst === 0, 'The inter-state invoice row shows taxable ₹1,10,000 and IGST ₹19,800');
  assert(g0.gstr3b.table_3_1_outward.igst === 19800 && g0.gstr3b.net_payable.igst === 19800, 'GSTR-3B outward IGST and net IGST payable = ₹19,800');
  assert(g0.gstr3b.table_4_itc.cgst === 14040 && g0.gstr3b.table_4_itc.sgst === 14040 && g0.gstr3b.table_4_itc.igst === 0, 'ITC unchanged (₹14,040 + ₹14,040)');
  assert(g0.gstr3b.net_payable.cgst === 31050 - 14040 && g0.gstr3b.net_payable.total_payable === (31050 - 14040) * 2 + 19800, 'Net payable = outward − ITC per head');

  console.log('\n--- 2. Classification no longer depends on label text ---');
  const chennai = L('Chennai Auto Components Pvt Ltd');
  // API-style posting with NO particulars at all: previously invisible to GSTR-1/3B
  const a = await post({ voucher_type: 'Sales', voucher_no: 'GE/1', date: '2026-06-10', party_ledger_id: chennai.id,
    entries: [{ ledger_id: chennai.id, debit_amount: 1180 }, { ledger_id: L('Sales Account - Compressors').id, credit_amount: 1000 }, { ledger_id: L('Output CGST 9%').id, credit_amount: 90 }, { ledger_id: L('Output SGST 9%').id, credit_amount: 90 }] });
  const g1 = await gst();
  assert(a.json.success && r2(g1.gstr1.total_taxable - g0.gstr1.total_taxable) === 1000 && r2(g1.gstr1.total_cgst - g0.gstr1.total_cgst) === 90, 'A sale posted without particulars is now counted (₹1,000 taxable, ₹90 CGST)');
  // a ledger in Sales Accounts whose name has no word "Sales"
  const amc = L('Service & Maintenance AMC Charges');
  await post({ voucher_type: 'Sales', voucher_no: 'GE/2', date: '2026-06-11', party_ledger_id: chennai.id,
    entries: [{ ledger_id: chennai.id, debit_amount: 5900, particulars: chennai.name }, { ledger_id: amc.id, credit_amount: 5000, particulars: amc.name }, { ledger_id: L('Output CGST 9%').id, credit_amount: 450, particulars: 'Output CGST 9%' }, { ledger_id: L('Output SGST 9%').id, credit_amount: 450, particulars: 'Output SGST 9%' }] });
  const g2 = await gst();
  assert(r2(g2.gstr1.total_taxable - g1.gstr1.total_taxable) === 5000, 'AMC/service income (Sales Accounts group) is counted as outward taxable supply');
  // a party whose NAME contains "Sales" or "IGST" must not pollute totals
  const pid = (await req('POST', '/api/masters/ledgers', { name: 'Metro Sales IGST Traders', group_id: 16, state: 'Tamil Nadu', state_code: '33' })).json.id;
  await post({ voucher_type: 'Sales', voucher_no: 'GE/3', date: '2026-06-12', party_ledger_id: pid,
    entries: [{ ledger_id: pid, debit_amount: 1180, particulars: 'Metro Sales IGST Traders' }, { ledger_id: L('Sales Account - Compressors').id, credit_amount: 1000, particulars: 'Sales Account - Compressors' }, { ledger_id: L('Output CGST 9%').id, credit_amount: 90, particulars: 'Output CGST 9%' }, { ledger_id: L('Output SGST 9%').id, credit_amount: 90, particulars: 'Output SGST 9%' }] });
  const g3 = await gst();
  assert(r2(g3.gstr1.total_taxable - g2.gstr1.total_taxable) === 1000 && r2(g3.gstr1.total_igst - g2.gstr1.total_igst) === 0, 'A customer named "…Sales IGST…" does not distort taxable value or IGST');
  // a misleading label on a normal line must not matter
  await post({ voucher_type: 'Sales', voucher_no: 'GE/4', date: '2026-06-13', party_ledger_id: chennai.id,
    entries: [{ ledger_id: chennai.id, debit_amount: 1180, particulars: 'IGST Sales CGST' }, { ledger_id: L('Sales Account - Compressors').id, credit_amount: 1000, particulars: 'IGST' }, { ledger_id: L('Output CGST 9%').id, credit_amount: 90, particulars: 'Sales' }, { ledger_id: L('Output SGST 9%').id, credit_amount: 90, particulars: '' }] });
  const g4 = await gst();
  assert(r2(g4.gstr1.total_taxable - g3.gstr1.total_taxable) === 1000 && r2(g4.gstr1.total_cgst - g3.gstr1.total_cgst) === 90 && r2(g4.gstr1.total_sgst - g3.gstr1.total_sgst) === 90 && r2(g4.gstr1.total_igst - g3.gstr1.total_igst) === 0, 'Misleading labels on ordinary lines are ignored (ledger group decides)');
  // inter-state sale to a new ledger via the same "Interstate Sales" ledger
  const bang = L('Bangalore Machine Tools Ltd');
  await post({ voucher_type: 'Sales', voucher_no: 'GE/5', date: '2026-06-14', party_ledger_id: bang.id,
    entries: [{ ledger_id: bang.id, debit_amount: 11800 }, { ledger_id: L('Interstate Sales (IGST)').id, credit_amount: 10000 }, { ledger_id: L('Output IGST 18%').id, credit_amount: 1800 }] });
  const g5 = await gst();
  assert(r2(g5.gstr1.total_igst - g4.gstr1.total_igst) === 1800 && r2(g5.gstr1.total_taxable - g4.gstr1.total_taxable) === 10000, 'New inter-state sale adds ₹1,800 IGST and ₹10,000 taxable (not ₹11,800 IGST)');

  console.log('\n--- 3. Input tax credit by ledger group ---');
  const elgi = L('Elgi Equipments Spares Ltd');
  await post({ voucher_type: 'Purchase', voucher_no: 'GE/P1', date: '2026-06-15', reference_no: 'S1', party_ledger_id: elgi.id,
    entries: [{ ledger_id: L('Purchase Account - Spares & Machines').id, debit_amount: 2000 }, { ledger_id: L('Input CGST 9%').id, debit_amount: 180 }, { ledger_id: L('Input SGST 9%').id, debit_amount: 180 }, { ledger_id: elgi.id, credit_amount: 2360 }] });
  const g6 = await gst();
  assert(r2(g6.gstr3b.table_4_itc.cgst - g5.gstr3b.table_4_itc.cgst) === 180 && r2(g6.gstr3b.table_4_itc.sgst - g5.gstr3b.table_4_itc.sgst) === 180, 'ITC counted for a purchase posted without particulars');
  await post({ voucher_type: 'Purchase', voucher_no: 'GE/P2', date: '2026-06-16', party_ledger_id: elgi.id,
    entries: [{ ledger_id: L('Purchase Account - Spares & Machines').id, debit_amount: 1000, particulars: 'Input CGST 9%' }, { ledger_id: elgi.id, credit_amount: 1000, particulars: 'Input IGST' }] });
  const g7 = await gst();
  assert(r2(g7.gstr3b.table_4_itc.total_itc - g6.gstr3b.table_4_itc.total_itc) === 0, 'Misleading "Input …" labels on non-tax ledgers do not create ITC');

  console.log('\n--- 4. Credit Notes on the Interstate Sales ledger now correct ---');
  const Lall = ledgers;
  const cn = returnEntries({ voucherType: 'Credit Note', party: bang, partyLedgerId: bang.id, ledgers: Lall, subtotal: 2000, cgst: 0, sgst: 0, igst: 360, grandTotal: 2360, roundOff: 0, isInterState: true });
  const picked = Lall.find((l) => l.id === cn.find((e) => e.debit_amount === 2000).ledger_id).name;
  const rc = await post({ voucher_type: 'Credit Note', voucher_no: 'GE/CN1', date: '2026-06-17', party_ledger_id: bang.id, entries: cn });
  const g8 = await gst();
  assert(rc.json.success && r2(g7.gstr1.total_igst - g8.gstr1.total_igst) === 360 && r2(g7.gstr1.total_taxable - g8.gstr1.total_taxable) === 2000, `Credit note booked to "${picked}" reduces IGST by ₹360 and taxable by ₹2,000 only`, `${g7.gstr1.total_igst}→${g8.gstr1.total_igst}`);

  console.log('\n--- 5. Totals reconcile with the books ---');
  const sumLedger = async (name, side) => (await get(`SELECT COALESCE(SUM(e.${side}_amount),0) s FROM ledger_entries e JOIN ledgers l ON l.id=e.ledger_id JOIN vouchers v ON v.id=e.voucher_id WHERE l.name LIKE ? AND v.voucher_type IN ('Sales','Credit Note')`, [name])).s;
  const outCgst = r2((await sumLedger('Output CGST%', 'credit')) - (await sumLedger('Output CGST%', 'debit')));
  const outIgst = r2((await sumLedger('Output IGST%', 'credit')) - (await sumLedger('Output IGST%', 'debit')));
  assert(outCgst === r2(g8.gstr1.total_cgst) && outIgst === r2(g8.gstr1.total_igst), 'GSTR-1 CGST and IGST equal the net movement on the Output tax ledgers', `${outCgst}/${g8.gstr1.total_cgst} ${outIgst}/${g8.gstr1.total_igst}`);
  const salesNet = r2((await get(`SELECT COALESCE(SUM(e.credit_amount - e.debit_amount),0) s FROM ledger_entries e JOIN ledgers l ON l.id=e.ledger_id JOIN account_groups g ON g.id=l.group_id JOIN vouchers v ON v.id=e.voucher_id WHERE g.name='Sales Accounts' AND v.voucher_type IN ('Sales','Credit Note')`)).s);
  assert(salesNet === r2(g8.gstr1.total_taxable), 'GSTR-1 taxable equals net movement on the Sales Accounts group');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);

  console.log('\n====================================================');
  console.log(`📊 GST ENGINE RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

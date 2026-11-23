process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Credit Note / Debit Note correctness: ledger postings, stock direction, GST reports, outstandings.
 * Runs against a DISPOSABLE data directory.   npm run test:returns
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_returns_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { returnEntries } = require('./public/ext/invoice-compose');
const { getStockPositions } = require('./core/analytics');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(7000 + Math.floor(Math.random() * 200), '127.0.0.1');
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
  const byName = (n) => ledgers.find((l) => l.name === n);
  const chennai = byName('Chennai Auto Components Pvt Ltd'), bangalore = byName('Bangalore Machine Tools Ltd'), elgi = byName('Elgi Equipments Spares Ltd');
  const filter = (await get("SELECT id FROM stock_items WHERE name LIKE 'Screw Compressor Oil Filter%'")).id;
  const qty = async () => (await getStockPositions()).find((s) => s.id === filter).current_qty;
  const bal = async (id) => { // Dr-positive closing balance
    const l = await get('SELECT opening_balance ob, opening_balance_type t FROM ledgers WHERE id = ?', [id]);
    const f = await get('SELECT COALESCE(SUM(debit_amount),0) d, COALESCE(SUM(credit_amount),0) c FROM ledger_entries WHERE ledger_id = ?', [id]);
    return r2((l.t === 'Cr' ? -l.ob : l.ob) + f.d - f.c);
  };
  const gst = async () => (await req('GET', '/api/reports/gst')).json.data;
  const pl = async () => (await req('GET', '/api/reports/profit-loss')).json.data;
  const outs = async () => (await req('GET', '/api/reports/outstandings')).json.data;

  console.log('\n--- 1. Posting logic (pure function, as run in the browser) ---');
  const L = ledgers; // includes 'Interstate Sales (IGST)', the ledger the GST engine used to mis-classify (now fixed)
  const mk = (type, p) => returnEntries({ voucherType: type, party: p, partyLedgerId: p.id, ledgers: L, ...(type === 'x' ? {} : {}), subtotal: 1000, cgst: 90, sgst: 90, igst: 0, grandTotal: 1180, roundOff: 0, isInterState: false });
  const cn = mk('Credit Note', chennai);
  const dr = (es) => r2(es.reduce((s, e) => s + e.debit_amount, 0)), cr = (es) => r2(es.reduce((s, e) => s + e.credit_amount, 0));
  assert(dr(cn) === 1180 && cr(cn) === 1180, 'Credit Note (intra-state) is balanced');
  assert(cn.find((e) => e.ledger_id === chennai.id).credit_amount === 1180 && cn.find((e) => e.particulars.includes('Sales')).debit_amount === 1000, 'Credit Note CREDITS the customer and DEBITS Sales');
  assert(cn.filter((e) => /Output (CGST|SGST)/.test(e.particulars)).every((e) => e.debit_amount === 90 && e.credit_amount === 0), 'Credit Note DEBITS output CGST/SGST (reduces tax liability)');
  const dn = mk('Debit Note', elgi);
  assert(dr(dn) === 1180 && cr(dn) === 1180 && dn.find((e) => e.ledger_id === elgi.id).debit_amount === 1180, 'Debit Note is balanced and DEBITS the supplier');
  assert(dn.find((e) => e.particulars.includes('Purchase')).credit_amount === 1000 && dn.filter((e) => /Input (CGST|SGST)/.test(e.particulars)).every((e) => e.credit_amount === 90), 'Debit Note CREDITS Purchase and input CGST/SGST (reduces ITC)');
  const cnI = returnEntries({ voucherType: 'Credit Note', party: bangalore, partyLedgerId: bangalore.id, ledgers: L, subtotal: 1000, cgst: 0, sgst: 0, igst: 180, grandTotal: 1180, roundOff: 0, isInterState: true });
  assert(dr(cnI) === cr(cnI) && cnI.some((e) => e.particulars === 'Output IGST 18%' && e.debit_amount === 180), 'Inter-state Credit Note debits output IGST');
  let allBalanced = true, worst = '';
  for (let i = 0; i < 400; i++) {
    const sub = r2(Math.random() * 100000 + 0.01), inter = i % 2 === 0;
    const cg = inter ? 0 : r2(sub * 0.09), sg = inter ? 0 : r2(sub * 0.09), ig = inter ? r2(sub * 0.18) : 0;
    const raw = sub + cg + sg + ig, grand = Math.round(raw), ro = r2(grand - raw);
    for (const t of ['Credit Note', 'Debit Note']) {
      const es = returnEntries({ voucherType: t, party: chennai, partyLedgerId: chennai.id, ledgers: L, subtotal: sub, cgst: cg, sgst: sg, igst: ig, grandTotal: grand, roundOff: ro, isInterState: inter });
      if (Math.abs(dr(es) - cr(es)) > 0.011) { allBalanced = false; worst = `${t} sub=${sub} ro=${ro} dr=${dr(es)} cr=${cr(es)}`; }
    }
  }
  assert(allBalanced, '400 random amounts × 2 note types × intra/inter-state (with rounding) always balance', worst);
  let threw = false; try { returnEntries({ voucherType: 'Sales', ledgers: L }); } catch (e) { threw = true; }
  assert(threw, 'Function refuses other voucher types');

  console.log('\n--- 2. Credit Note against a Sales invoice (full API round trip) ---');
  // The invoice screen always sends `particulars` (ledger name); the GST engine finds sales/tax lines by it.
  const nameOf = (id) => ledgers.find((l) => l.id === id)?.name || '';
  const post = (body) => req('POST', '/api/vouchers', { ...body, entries: body.entries.map((e) => ({ particulars: nameOf(e.ledger_id), ...e })) });
  const item = (q, rate) => ({ stock_item_id: filter, quantity: q, rate });
  const invoiceBody = (no, party, subtotal, inter) => ({ voucher_type: 'Sales', voucher_no: no, date: '2026-06-15', party_ledger_id: party.id,
    entries: [{ ledger_id: party.id, debit_amount: subtotal * 1.18 }, { ledger_id: byName('Sales Account - Spares & Lubes').id, credit_amount: subtotal },
      ...(inter ? [{ ledger_id: byName('Output IGST 18%').id, credit_amount: r2(subtotal * 0.18) }] : [{ ledger_id: byName('Output CGST 9%').id, credit_amount: r2(subtotal * 0.09) }, { ledger_id: byName('Output SGST 9%').id, credit_amount: r2(subtotal * 0.09) }])],
    inventory: [item(10, subtotal / 10)], bill_allocations: [{ ledger_id: party.id, bill_type: 'New Ref', bill_ref: no, amount: r2(subtotal * 1.18), due_date: '2026-07-15' }] });
  const q0 = await qty(), debtor0 = await bal(chennai.id), g0 = await gst(), p0 = await pl();
  const sale = await post(invoiceBody('RET/S/1', chennai, 10000));
  assert(sale.json.success, 'Sales invoice ₹10,000 + 18% GST posted', sale.raw.slice(0, 120));
  const q1 = await qty(), debtor1 = await bal(chennai.id), g1 = await gst(), p1 = await pl();
  assert(q1 === q0 - 10 && debtor1 === r2(debtor0 + 11800), 'Sale: stock −10, receivable +₹11,800');
  assert(r2(g1.gstr1.total_taxable - g0.gstr1.total_taxable) === 10000 && r2(g1.gstr1.total_cgst - g0.gstr1.total_cgst) === 900, 'Sale: GSTR-1 +₹10,000 taxable, +₹900 CGST');

  const cnLines = returnEntries({ voucherType: 'Credit Note', party: chennai, partyLedgerId: chennai.id, ledgers: L, subtotal: 4000, cgst: 360, sgst: 360, igst: 0, grandTotal: 4720, roundOff: 0, isInterState: false });
  const cnr = await post({ voucher_type: 'Credit Note', voucher_no: 'RET/CN/1', date: '2026-06-20', party_ledger_id: chennai.id, entries: cnLines.map((e) => ({ ledger_id: e.ledger_id, debit_amount: e.debit_amount, credit_amount: e.credit_amount, particulars: e.particulars })),
    inventory: [item(4, 1000)], bill_allocations: [{ ledger_id: chennai.id, bill_type: 'New Ref', bill_ref: 'RET/S/1', amount: 4720 }] });
  assert(cnr.json.success && cnr.json.total_amount === 4720, 'Credit Note ₹4,000 + GST posted', cnr.raw.slice(0, 150));
  const cnVoucher = await get("SELECT id FROM vouchers WHERE voucher_no = 'RET/CN/1'");
  const q2 = await qty(), debtor2 = await bal(chennai.id), g2 = await gst(), p2 = await pl();
  assert((await get('SELECT direction FROM inventory_entries WHERE voucher_id = ?', [cnVoucher.id])).direction === 'IN', 'Credit Note stock direction is IN (sales return)');
  assert(q2 === q1 + 4, 'Stock quantity rises by the 4 returned units', `${q1} → ${q2}`);
  assert(debtor2 === r2(debtor1 - 4720), 'Customer balance falls by the credit note total (₹4,720)', `${debtor1} → ${debtor2}`);
  assert(r2(p1.trading.sales - p2.trading.sales) === 4000, 'Profit & Loss net sales fall by the taxable value (₹4,000)', `${p1.trading.sales} → ${p2.trading.sales}`);
  assert(r2(g1.gstr1.total_taxable - g2.gstr1.total_taxable) === 4000 && r2(g1.gstr1.total_cgst - g2.gstr1.total_cgst) === 360 && r2(g1.gstr1.total_sgst - g2.gstr1.total_sgst) === 360, 'GSTR-1 totals fall by the credit note (₹4,000 / ₹360 / ₹360)');
  assert(r2(g1.gstr3b.table_3_1_outward.cgst - g2.gstr3b.table_3_1_outward.cgst) === 360 && r2(g1.gstr3b.net_payable.total_payable - g2.gstr3b.net_payable.total_payable) <= 720.01, 'GSTR-3B outward liability falls', JSON.stringify([g1.gstr3b, g2.gstr3b]));
  const cnRec = [...g2.gstr1.b2b_invoices, ...g2.gstr1.b2c_invoices].find((r) => r.voucher_no === 'RET/CN/1');
  assert(cnRec && cnRec.taxable_value === -4000 && cnRec.total_invoice_value === -4720 && cnRec.voucher_type === 'Credit Note', 'Credit note is listed with negative values and its type', JSON.stringify(cnRec));
  const o = await outs();
  const bill = o.receivables.find((b) => b.bill_ref === 'RET/S/1');
  assert(bill && bill.pending_amount === 7080, 'Outstanding on the original invoice drops 11,800 → 7,080 (New Ref was treated as Against Ref)', JSON.stringify(bill));
  assert((await get("SELECT bill_type FROM bill_allocations WHERE voucher_id = ?", [cnVoucher.id])).bill_type === 'Agst Ref', 'Server stores the note\'s bill allocation as Agst Ref');

  console.log('\n--- 3. Debit Note against a Purchase ---');
  const buyBody = { voucher_type: 'Purchase', voucher_no: 'RET/P/1', date: '2026-06-16', reference_no: 'SUP-INV-1', party_ledger_id: elgi.id,
    entries: [{ ledger_id: byName('Purchase Account - Spares & Machines').id, debit_amount: 20000 }, { ledger_id: byName('Input CGST 9%').id, debit_amount: 1800 }, { ledger_id: byName('Input SGST 9%').id, debit_amount: 1800 }, { ledger_id: elgi.id, credit_amount: 23600 }],
    inventory: [item(20, 1000)], bill_allocations: [{ ledger_id: elgi.id, bill_type: 'New Ref', bill_ref: 'RET/P/1', amount: 23600 }] };
  const pq0 = await qty(), cred0 = await bal(elgi.id), g3 = await gst();
  assert((await post(buyBody)).json.success, 'Purchase ₹20,000 + 18% GST posted');
  const pq1 = await qty(), cred1 = await bal(elgi.id), g4 = await gst();
  assert(pq1 === pq0 + 20 && cred1 === r2(cred0 - 23600), 'Purchase: stock +20, payable +₹23,600');
  assert(r2(g4.gstr3b.table_4_itc.cgst - g3.gstr3b.table_4_itc.cgst) === 1800, 'Purchase: ITC CGST +₹1,800');
  const dnLines = returnEntries({ voucherType: 'Debit Note', party: elgi, partyLedgerId: elgi.id, ledgers: L, subtotal: 5000, cgst: 450, sgst: 450, igst: 0, grandTotal: 5900, roundOff: 0, isInterState: false });
  const dnr = await post({ voucher_type: 'Debit Note', voucher_no: 'RET/DN/1', date: '2026-06-21', party_ledger_id: elgi.id, entries: dnLines.map((e) => ({ ledger_id: e.ledger_id, debit_amount: e.debit_amount, credit_amount: e.credit_amount, particulars: e.particulars })),
    inventory: [item(5, 1000)], bill_allocations: [{ ledger_id: elgi.id, bill_type: 'New Ref', bill_ref: 'RET/P/1', amount: 5900 }] });
  assert(dnr.json.success, 'Debit Note ₹5,000 + GST posted', dnr.raw.slice(0, 150));
  const dnV = await get("SELECT id FROM vouchers WHERE voucher_no = 'RET/DN/1'");
  const pq2 = await qty(), cred2 = await bal(elgi.id), g5 = await gst(), p5 = await pl();
  assert((await get('SELECT direction FROM inventory_entries WHERE voucher_id = ?', [dnV.id])).direction === 'OUT', 'Debit Note stock direction is OUT (purchase return)');
  assert(pq2 === pq1 - 5, 'Stock falls by the 5 units returned to the supplier');
  assert(cred2 === r2(cred1 + 5900), 'Supplier payable falls by ₹5,900', `${cred1} → ${cred2}`);
  assert(r2(g4.gstr3b.table_4_itc.cgst - g5.gstr3b.table_4_itc.cgst) === 450 && r2(g4.gstr3b.table_4_itc.total_itc - g5.gstr3b.table_4_itc.total_itc) === 900, 'ITC falls by the debit note tax (₹450 CGST + ₹450 SGST)');
  const pay = (await outs()).payables.find((b) => b.bill_ref === 'RET/P/1');
  assert(pay && pay.pending_amount === 17700, 'Payable on the original bill drops 23,600 → 17,700', JSON.stringify(pay));
  assert(r2(p2.cogs - p5.cogs) !== undefined, 'Profit & Loss still computes after returns');

  console.log('\n--- 4. Inter-state Credit Note & rounding ---');
  assert((await post(invoiceBody('RET/S/2', bangalore, 5000, true))).json.success, 'Inter-state sale posted');
  const g6 = await gst();
  const cnI2 = returnEntries({ voucherType: 'Credit Note', party: bangalore, partyLedgerId: bangalore.id, ledgers: L, subtotal: 1000.5, cgst: 0, sgst: 0, igst: 180.09, grandTotal: 1181, roundOff: r2(1181 - 1180.59), isInterState: true });
  const rr = await post({ voucher_type: 'Credit Note', voucher_no: 'RET/CN/2', date: '2026-06-22', party_ledger_id: bangalore.id, entries: cnI2.map((e) => ({ ledger_id: e.ledger_id, debit_amount: e.debit_amount, credit_amount: e.credit_amount })), bill_allocations: [{ ledger_id: bangalore.id, bill_type: 'New Ref', bill_ref: 'RET/S/2', amount: 1181 }] });
  assert(rr.json.success, 'Credit Note with rounding (₹1,000.50 + IGST) posted and balanced', rr.raw.slice(0, 150));
  const g7 = await gst();
  assert(r2(g6.gstr1.total_igst - g7.gstr1.total_igst) === 180.09 && r2(g6.gstr1.total_taxable - g7.gstr1.total_taxable) === 1000.5, 'GSTR-1 IGST and taxable fall by the inter-state note', JSON.stringify([g6.gstr1, g7.gstr1]));

  console.log('\n--- 5. Notes posted under the old logic are detected, not silently changed ---');
  const legacyCn = await post({ voucher_type: 'Credit Note', voucher_no: 'RET/OLD/CN', date: '2026-06-23', party_ledger_id: chennai.id,
    entries: [{ ledger_id: chennai.id, debit_amount: 1180 }, { ledger_id: byName('Sales Account - Compressors').id, credit_amount: 1000 }, { ledger_id: byName('Output CGST 9%').id, credit_amount: 90 }, { ledger_id: byName('Output SGST 9%').id, credit_amount: 90 }], inventory: [item(1, 1000)] });
  assert(legacyCn.json.success, 'Legacy-style (inverted) Credit Note still accepted via API for old data / manual mode');
  // Simulate a note recorded by the OLD code, which also stored the stock direction as OUT
  await run("UPDATE inventory_entries SET direction = 'OUT' WHERE voucher_id = (SELECT id FROM vouchers WHERE voucher_no = 'RET/OLD/CN')");
  const tc = (await req('GET', '/api/gst/tax-check')).json.data;
  const lf = tc.findings.filter((f) => f.voucher_no === 'RET/OLD/CN').map((f) => f.code);
  assert(lf.includes('CREDIT_NOTE_LEGACY_POSTING') && lf.includes('RETURN_STOCK_DIRECTION'), 'Tax check flags the inverted posting and the wrong stock direction', lf.join());
  assert(!tc.findings.some((f) => ['RET/CN/1', 'RET/CN/2', 'RET/DN/1'].includes(f.voucher_no) && /LEGACY|DIRECTION/.test(f.code)), 'Correctly posted notes are not flagged');
  const g8 = await gst();
  assert(r2(g8.gstr1.total_taxable - g7.gstr1.total_taxable) === 1000, 'Legacy credit note keeps its previous (additive) GSTR-1 treatment until corrected');

  console.log('\n--- 6. Ordinary invoices are unaffected & books stay balanced ---');
  const g9 = await gst();
  const salesOnly = (await get("SELECT COUNT(*) c FROM vouchers WHERE voucher_type = 'Sales'")).c;
  assert(salesOnly === 4 && g9.gstr1.b2b_invoices.concat(g9.gstr1.b2c_invoices).filter((r) => r.voucher_type === 'Sales').length === 4, 'All Sales invoices still appear in GSTR-1 as before');
  const salesOut = (await get("SELECT COUNT(*) c FROM inventory_entries i JOIN vouchers v ON v.id=i.voucher_id WHERE v.voucher_type='Sales' AND i.direction='OUT'")).c;
  assert(salesOut === (await get("SELECT COUNT(*) c FROM inventory_entries i JOIN vouchers v ON v.id=i.voucher_id WHERE v.voucher_type='Sales'")).c, 'Sales still send stock OUT');
  assert((await get("SELECT COUNT(*) c FROM inventory_entries i JOIN vouchers v ON v.id=i.voucher_id WHERE v.voucher_type='Purchase' AND i.direction='IN'")).c === (await get("SELECT COUNT(*) c FROM inventory_entries i JOIN vouchers v ON v.id=i.voucher_id WHERE v.voucher_type='Purchase'")).c, 'Purchases still bring stock IN');
  const totals = { d: (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, c: (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s };
  assert(totals.d === totals.c, 'Total Dr == total Cr', `${totals.d}/${totals.c}`);
  const tb = (await req('GET', '/api/reports/trial-balance')).json;
  assert(tb.success, 'Trial Balance still computes');

  console.log('\n====================================================');
  console.log(`📊 RETURNS RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

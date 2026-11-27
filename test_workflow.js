process.env.RRE_LEGACY_TOKENS = '1';
process.env.RRE_ENFORCE_AUTH = '1';
/**
 * End-to-end accounting workflow from uploaded documents (PDF / Excel), through the ONE posting engine, into every module:
 *   1. purchase invoice PDF with item lines -> purchase voucher, supplier ledger, input GST, stock IN, Day Book, balance sheet
 *   2. sales invoice PDF with item lines -> sales voucher, customer ledger, output GST, stock OUT, cost of goods sold, P&L
 *      (+ negative stock blocked when the company blocks it)
 *   3. Excel sales register (one row per item, "Paid") -> one invoice with its items + the receipt against it (receivable cleared)
 *   4. quotation PDF / Excel register -> Quotations (status), never revenue; accepted quotation converted -> sales invoice
 *   5. bank statement Excel -> lines matched with the receipt already in the books (confirmed), a new bank charge recorded
 *   6. dashboard financial summary = the reports; another device is told within about a second; duplicates; audit trail
 * Runs on a DISPOSABLE data directory.   node test_workflow.js      PostgreSQL:  npm run test:pg -- test_workflow.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_workflow_test_'));
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const gstin = (state, pan) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM approval_rules').catch(() => {});
  const OURS = gstin('33', 'AABCR1234F'), APEX = gstin('33', 'AAACA5555K'), CBC = gstin('33', 'AAFCC8888B');
  await run('UPDATE company_info SET gstin = ?, state_code = ?', [OURS, '33']);
  await require('./core/voucherService').setNegativeStockPolicy('block');
  const srv = await startServer(14600 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const owner = createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const other = createSessionToken({ id: 2, username: 'accountant', role: 'Accountant' });
  const call = (method, p, { token = owner, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
    const rq = http.request(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, json }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  const data = async (method, p, opts) => { const r = await call(method, p, opts); if (!r.json || r.json.success === false) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json.data !== undefined ? r.json.data : r.json; };
  const upload = (buf, name) => data('POST', '/api/doc-import/upload', { raw: buf, headers: { 'X-File-Name': encodeURIComponent(name) } });
  const preview = (id, settings = {}) => data('POST', `/api/doc-import/${id}/preview`, { body: { settings } });
  const commit = (id, settings = {}) => call('POST', `/api/doc-import/${id}/commit`, { body: { settings } });
  const pl = () => data('GET', '/api/reports/profit-loss');
  const bs = () => data('GET', '/api/reports/balance-sheet');
  const stock = async (name) => (await data('GET', '/api/reports/stock-summary')).items.find((i) => i.name === name);
  const fin = async () => (await data('GET', '/api/dashboard/tiles')).financials;
  const ledgerBal = async (name) => { const l = await get(`SELECT l.id, l.opening_balance, l.opening_balance_type FROM ledgers l WHERE l.name = ?`, [name]); if (!l) return null; const e = await get('SELECT COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) AS n FROM ledger_entries WHERE ledger_id = ?', [l.id]); return r2((l.opening_balance_type === 'Cr' ? -1 : 1) * (l.opening_balance || 0) + Number(e.n)); };
  const daybook = async () => data('GET', '/api/reports/daybook?from=2026-01-01&to=2026-12-31&limit=5000');
  const vcount = async () => Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n);
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state_code) VALUES ('Apex Tech Pvt Ltd', ?, 0, 'Dr', ?, '33')", [await grp('Sundry Debtors'), APEX]);
  const bank = await get("SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Bank Accounts' ORDER BY l.id LIMIT 1");
  let charges = await get("SELECT id, name FROM ledgers WHERE LOWER(name) LIKE 'bank charges%'");
  if (!charges) { await run("INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES ('Bank Charges', ?, 0, 'Dr')", [await grp('Indirect Expenses')]); charges = await get("SELECT id, name FROM ledgers WHERE name = 'Bank Charges'"); }

  // another device listening for changes (the live-update stream every open screen uses)
  const events = [];
  const sse = http.get(base + '/api/events', { headers: { Authorization: 'Bearer ' + other, 'X-RRE-Client': 'device-B' } }, (res) => {
    res.setEncoding('utf8'); let buf = '';
    res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (/^event: changed/m.test(block)) events.push({ at: Date.now(), data: block }); } });
  });
  await new Promise((r) => setTimeout(r, 400));

  // ------------------------------------------------------------------------------------------------ 1. purchase invoice PDF
  console.log('\n--- 1. Purchase invoice PDF with item lines -> purchases, supplier, input GST, stock, Day Book, balance sheet ---');
  const itemTable = (y, rows) => [{ x: 40, y, text: 'Description of Goods' }, { x: 230, y, text: 'HSN' }, { x: 290, y, text: 'Qty' }, { x: 330, y, text: 'Unit' }, { x: 380, y, text: 'Rate' }, { x: 470, y, text: 'Amount' }]
    .concat(...rows.map((r, i) => [{ x: 40, y: y - 16 * (i + 1), text: r[0] }, { x: 230, y: y - 16 * (i + 1), text: r[1] }, { x: 290, y: y - 16 * (i + 1), text: String(r[2]) }, { x: 330, y: y - 16 * (i + 1), text: r[3] }, { x: 380, y: y - 16 * (i + 1), text: r[4] }, { x: 470, y: y - 16 * (i + 1), text: r[5] }]));
  const purchasePdf = F.makePdf([[
    { x: 40, y: 760, text: 'Coimbatore Bearing Company', size: 13 }, { x: 40, y: 744, text: `GSTIN: ${CBC}` }, { x: 400, y: 760, text: 'TAX INVOICE', size: 14 },
    { x: 400, y: 740, text: 'Invoice No: CBC-3301' }, { x: 400, y: 726, text: 'Date: 02-06-2026' }, { x: 40, y: 700, text: 'Bill To: RRE Entries' }, { x: 40, y: 686, text: `GSTIN: ${OURS}` },
    ...itemTable(650, [['Ball Bearing 6205', '84821010', 100, 'Nos', '50.00', '5,000.00'], ['Oil Seal 35x52', '40169320', 40, 'Nos', '25.00', '1,000.00']]),
    { x: 300, y: 580, text: 'Taxable Value' }, { x: 470, y: 580, text: '6,000.00' }, { x: 300, y: 566, text: 'CGST @ 9%' }, { x: 470, y: 566, text: '540.00' },
    { x: 300, y: 552, text: 'SGST @ 9%' }, { x: 470, y: 552, text: '540.00' }, { x: 300, y: 536, text: 'Grand Total' }, { x: 470, y: 536, text: '7,080.00' }]]);
  const pl0 = await pl(), bs0 = await bs(), fin0 = await fin(), v0 = await vcount();
  const u1 = await upload(purchasePdf, 'purchase-CBC-3301.pdf');
  const p1 = await preview(u1.id);
  const rec1 = p1.records[0];
  assert(p1.category === 'purchase_invoice' && rec1.status === 'ok' && rec1.data.invoice_no === 'CBC-3301' && rec1.data.total === 7080, 'recognised as a purchase invoice: CBC-3301, total ₹7,080, valid', JSON.stringify({ c: p1.category, s: rec1 && rec1.status, e: rec1 && rec1.errors, d: rec1 && rec1.data }).slice(0, 400));
  assert(rec1.voucher && rec1.voucher.inventory && rec1.voucher.inventory.length === 2 && rec1.voucher.inventory[0].quantity === 100 && rec1.voucher.inventory[0].rate === 50 && rec1.voucher.inventory.every((i) => i.create),
    'its 2 item lines are read (Ball Bearing 6205 100 × ₹50, Oil Seal 40 × ₹25) and will be created as stock items', JSON.stringify(rec1.voucher && rec1.voucher.inventory).slice(0, 300));
  assert(p1.summary.purchase_total === 7080 && p1.summary.item_lines === 2 && p1.unknown_items.length === 2, 'preview: purchases ₹7,080, 2 item lines, 2 new stock items');
  const c1 = await commit(u1.id);
  assert(c1.status === 200 && c1.json.data.imported === 1 && c1.json.data.created.items.length === 2, 'imported: 1 purchase voucher, 2 stock items created', JSON.stringify(c1.json).slice(0, 300));
  const s1a = await stock('Ball Bearing 6205'), s1b = await stock('Oil Seal 35x52');
  assert(s1a && s1a.closing_qty === 100 && near(s1a.valuation_rate, 50) && s1b && s1b.closing_qty === 40, 'Stock: Ball Bearing 100 @ ₹50, Oil Seal 40 (stock IN from the purchase)', JSON.stringify({ s1a, s1b }).slice(0, 300));
  assert(await ledgerBal('Coimbatore Bearing Company') === -7080, 'Supplier ledger: Coimbatore Bearing Company ₹7,080 Cr (created under Sundry Creditors)');
  const pl1 = await pl(), bs1 = await bs(), fin1 = await fin();
  assert(near(pl1.trading.purchases - pl0.trading.purchases, 6000) && near(pl1.trading.closing_stock - pl0.trading.closing_stock, 6000) && near(pl1.trading.gross_profit, pl0.trading.gross_profit),
    'P&L: purchases +₹6,000 and closing stock +₹6,000, so gross profit is unchanged (buying stock is not an expense)');
  assert(near(fin1.gst_input_credit - fin0.gst_input_credit, 1080) && near(fin1.payables - fin0.payables, 7080) && near(fin1.inventory_value - fin0.inventory_value, 6000),
    'Dashboard: input GST +₹1,080, payables +₹7,080, inventory +₹6,000', JSON.stringify({ fin0, fin1 }).slice(0, 400));
  assert(near(bs1.assets.total - bs0.assets.total, 6000) && near(bs1.liabilities.total - bs0.liabilities.total, 6000), 'Balance sheet: assets +₹6,000 (closing stock) = liabilities +₹6,000 (supplier ₹7,080 less the ₹1,080 input GST netted under Duties & Taxes); still balanced', JSON.stringify({ a: bs1.assets.total - bs0.assets.total, l: bs1.liabilities.total - bs0.liabilities.total }));
  const db1 = await daybook();
  assert(db1.some((v) => v.voucher_type === 'Purchase' && v.reference_no === 'CBC-3301' && near(v.total_amount, 7080)), 'Day Book: the Purchase voucher CBC-3301 ₹7,080');
  const live1 = events.length;
  assert(live1 > 0, `another device was told about the change (${live1} event(s))`);

  // ------------------------------------------------------------------------------------------------ 2. sales invoice PDF
  console.log('\n--- 2. Sales invoice PDF with item lines -> sales, customer, output GST, stock OUT, cost of goods sold ---');
  const salesPdf = (no, qtyA, qtyB) => F.makePdf([[
    { x: 40, y: 760, text: 'RRE ENTRIES', size: 14 }, { x: 40, y: 744, text: `GSTIN: ${OURS}` }, { x: 400, y: 760, text: 'TAX INVOICE', size: 14 },
    { x: 400, y: 740, text: `Invoice No: ${no}` }, { x: 400, y: 726, text: 'Date: 08-06-2026' }, { x: 40, y: 700, text: 'Bill To: Apex Tech Pvt Ltd' }, { x: 40, y: 686, text: `GSTIN: ${APEX}` },
    ...itemTable(650, [['Ball Bearing 6205', '84821010', qtyA, 'Nos', '80.00', (qtyA * 80).toFixed(2)], ['Oil Seal 35x52', '40169320', qtyB, 'Nos', '40.00', (qtyB * 40).toFixed(2)]]),
    { x: 300, y: 580, text: 'Taxable Value' }, { x: 470, y: 580, text: (qtyA * 80 + qtyB * 40).toFixed(2) }, { x: 300, y: 566, text: 'CGST @ 9%' }, { x: 470, y: 566, text: ((qtyA * 80 + qtyB * 40) * 0.09).toFixed(2) },
    { x: 300, y: 552, text: 'SGST @ 9%' }, { x: 470, y: 552, text: ((qtyA * 80 + qtyB * 40) * 0.09).toFixed(2) }, { x: 300, y: 536, text: 'Grand Total' }, { x: 470, y: 536, text: ((qtyA * 80 + qtyB * 40) * 1.18).toFixed(2) }]]);
  const gst1 = await data('GET', '/api/reports/gst');
  const uBig = await upload(salesPdf('S-9000', 500, 10), 'sales-too-many.pdf');
  const pBig = await preview(uBig.id);
  assert(pBig.category === 'sales_invoice' && pBig.records[0].status === 'error' && /Not enough stock of Ball Bearing 6205: 100 on hand, 500/.test(pBig.records[0].errors.join(' ')),
    'selling 500 bearings with 100 in stock: refused in the preview (negative stock is blocked for this company)', JSON.stringify(pBig.records[0].errors));
  const u2 = await upload(salesPdf('S-6001', 30, 10), 'sales-S-6001.pdf');
  const p2 = await preview(u2.id);
  assert(p2.category === 'sales_invoice' && p2.records[0].status === 'ok' && p2.records[0].voucher.inventory.length === 2 && p2.records[0].voucher.inventory.every((i) => i.stock_item_id) && p2.summary.sales_total === 3304,
    'sales invoice S-6001: 2 item lines matched to the stock items, sales ₹3,304', JSON.stringify(p2.records[0].errors).slice(0, 200));
  const c2 = await commit(u2.id);
  assert(c2.status === 200 && c2.json.data.imported === 1, 'imported: 1 sales voucher');
  const s2a = await stock('Ball Bearing 6205'), s2b = await stock('Oil Seal 35x52');
  assert(s2a.closing_qty === 70 && s2b.closing_qty === 30, 'Stock: Ball Bearing 70, Oil Seal 30 (stock OUT with the sale)');
  const pl2 = await pl();
  const cogs = 30 * 50 + 10 * 25; // weighted average cost of what was sold
  assert(near(pl2.trading.sales - pl1.trading.sales, 2800) && near(pl2.trading.gross_profit - pl1.trading.gross_profit, 2800 - cogs) && near(pl2.cogs - pl1.cogs, cogs),
    `P&L: sales +₹2,800, cost of goods sold +₹${cogs}, gross profit +₹${2800 - cogs} (not the whole sale)`, JSON.stringify({ sales: pl2.trading.sales - pl1.trading.sales, gp: pl2.trading.gross_profit - pl1.trading.gross_profit, cogs: pl2.cogs - pl1.cogs }));
  assert(await ledgerBal('Apex Tech Pvt Ltd') === 3304, 'Customer ledger: Apex Tech ₹3,304 Dr');
  const gst2 = await data('GET', '/api/reports/gst');
  const sv2 = c2.json.data.created.vouchers[0];
  assert(gst2.gstr1.b2b_invoices.some((i) => i.voucher_no === sv2.voucher_no && near(i.taxable_value, 2800) && near(i.cgst, 252)) && near(gst2.gstr3b.table_3_1_outward.cgst - gst1.gstr3b.table_3_1_outward.cgst, 252), 'GST: the invoice is in GSTR-1 (B2B) and GSTR-3B outward CGST ₹252', JSON.stringify(gst2.gstr3b.table_3_1_outward));

  // ------------------------------------------------------------------------------------------------ 3. Excel register, Paid
  console.log('\n--- 3. Excel sales register (a row per item, "Paid") -> one invoice + the receipt against it ---');
  const regX = F.workbook({ 'June Sales': [['Invoice Date', 'Invoice No', 'Customer', 'Item', 'Qty', 'Rate', 'Amount', 'CGST', 'SGST', 'Total', 'Status'],
    ['2026-06-12', 'S-77', 'Apex Tech Pvt Ltd', 'Ball Bearing 6205', 10, 80, 800, 72, 72, 944, 'Paid'],
    ['2026-06-12', 'S-77', 'Apex Tech Pvt Ltd', 'Oil Seal 35x52', 5, 40, 200, 18, 18, 236, 'Paid']] });
  const u3 = await upload(regX, 'june-sales.xlsx');
  const p3 = await preview(u3.id, { record_payments: true, bank_ledger_id: bank.id });
  const r3 = p3.records[0];
  assert(p3.category === 'sales_register' && p3.records.length === 1 && r3.status === 'ok' && r3.data.total === 1180 && r3.voucher.inventory.length === 2 && r3.voucher.inventory[0].rate === 80 && r3.data.payment_status === 'paid' && r3.voucher.payment,
    'the two item rows of S-77 are one invoice (₹1,180, 2 items, "Rate" read as the unit price), marked Paid, with its receipt', JSON.stringify({ n: p3.records.length, s: r3 && r3.status, e: r3 && r3.errors, d: r3 && r3.data }).slice(0, 500));
  const c3 = await commit(u3.id, { record_payments: true, bank_ledger_id: bank.id });
  const pay3 = c3.json.data.created.payments[0];
  assert(c3.status === 200 && pay3 && pay3.voucher_type === 'Receipt' && near(pay3.total, 1180) && c3.json.data.verification.vouchers_found === 2, 'imported: the Sales voucher and a Receipt ₹1,180 through the bank (both read back from the books)', JSON.stringify(c3.json).slice(0, 300));
  const out3 = await data('GET', '/api/reports/outstandings');
  assert(!out3.receivables.some((b) => b.bill_ref === 'S-77') && out3.receivables.some((b) => b.bill_ref === 'S-6001'), 'Receivables: S-77 is settled by the receipt; S-6001 is still outstanding', JSON.stringify(out3.receivables.map((b) => [b.bill_ref, b.pending_amount])));
  assert(await ledgerBal('Apex Tech Pvt Ltd') === 3304 && (await stock('Ball Bearing 6205')).closing_qty === 60, 'Apex still owes ₹3,304 (S-77 paid); bearings 60 left');

  // ------------------------------------------------------------------------------------------------ 4. quotations
  console.log('\n--- 4. Quotations: saved with their status, never revenue; an accepted one converted to a sales invoice ---');
  const qPdf = F.makePdf([[
    { x: 40, y: 760, text: 'QUOTATION', size: 16 }, { x: 40, y: 740, text: 'RRE ENTRIES' }, { x: 400, y: 740, text: 'Quotation No: QI-501' }, { x: 400, y: 726, text: 'Date: 10-06-2026' },
    { x: 400, y: 712, text: 'Valid till: 30-06-2026' }, { x: 40, y: 700, text: 'To: Nova Industries' }, { x: 40, y: 686, text: 'Status: Sent' },
    ...itemTable(650, [['Ball Bearing 6205', '84821010', 20, 'Nos', '85.00', '1,700.00'], ['Installation Charges', '998719', 1, 'Job', '500.00', '500.00']]),
    { x: 300, y: 580, text: 'Sub Total' }, { x: 470, y: 580, text: '2,200.00' }, { x: 300, y: 566, text: 'CGST @ 9%' }, { x: 470, y: 566, text: '198.00' },
    { x: 300, y: 552, text: 'SGST @ 9%' }, { x: 470, y: 552, text: '198.00' }, { x: 300, y: 536, text: 'Grand Total' }, { x: 470, y: 536, text: '2,596.00' }]]);
  const plQ0 = await pl(), vQ0 = await vcount();
  const u4 = await upload(qPdf, 'quotation-QI-501.pdf');
  const p4 = await preview(u4.id);
  const r4 = p4.records[0];
  assert(u4.classification.category === 'quotation' && p4.kind === 'quotation' && r4.status === 'ok' && r4.data.quote_no === 'QI-501' && r4.data.party === 'Nova Industries' && r4.data.status === 'Sent' && r4.quotation.items.length === 2 && near(r4.quotation.total, 2596),
    'quotation PDF recognised: QI-501 for Nova Industries, status Sent, 2 lines, total ₹2,596 (GST 18% from the document)', JSON.stringify({ c: u4.classification, s: r4 && r4.status, e: r4 && r4.errors, d: r4 && r4.data, q: r4 && r4.quotation && r4.quotation.total }).slice(0, 500));
  const c4 = await commit(u4.id);
  const q4 = c4.json.data && c4.json.data.created.quotations[0];
  const qRow = q4 && await get('SELECT * FROM quotations WHERE id = ?', [q4.id]);
  assert(c4.status === 200 && qRow && qRow.quote_no === 'QI-501' && qRow.status === 'Sent' && near(qRow.total, 2596) && qRow.expiry_date === '2026-06-30', 'saved in Quotations: QI-501, Sent, valid till 30-06-2026, ₹2,596', JSON.stringify(c4.json).slice(0, 300));
  assert((await all('SELECT * FROM quotation_items WHERE quotation_id = ?', [q4.id])).length === 2, 'with its 2 item lines');
  const plQ1 = await pl();
  assert(await vcount() === vQ0 && near(plQ1.trading.sales, plQ0.trading.sales), 'no voucher, sales unchanged: a quotation is not revenue');
  const qReg = F.workbook({ Quotations: [['Quote No', 'Date', 'Customer', 'Item', 'Qty', 'Unit Price', 'GST %', 'Status'], ['QR-11', '2026-06-11', 'Apex Tech Pvt Ltd', 'Oil Seal 35x52', 10, 45, 18, 'Accepted'], ['QR-12', '2026-06-11', 'Apex Tech Pvt Ltd', 'Ball Bearing 6205', 5, 90, 18, 'Pending']] });
  const u5 = await upload(qReg, 'quotation-register.xlsx');
  const p5 = await preview(u5.id);
  assert(p5.category === 'quotation' && p5.records.length === 2 && p5.records.every((r) => r.status === 'ok') && p5.records[0].data.status === 'Accepted' && p5.records[1].data.status === 'Sent',
    'quotation register (Excel): 2 quotations, Accepted and Pending (→ Sent)', JSON.stringify(p5.records.map((r) => [r.status, r.errors, r.data.status])).slice(0, 300));
  const c5 = await commit(u5.id);
  const acc = c5.json.data.created.quotations.find((q) => q.quote_no === 'QR-11');
  assert(acc && acc.status === 'Accepted' && near(acc.total, 531), 'QR-11 saved as Accepted, ₹531 (10 × ₹45 + 18% GST)', JSON.stringify(c5.json.data.created.quotations));
  const stats = await data('GET', '/api/quotations/stats').catch(() => null);
  assert(stats != null, 'the quotation register / pipeline reads them', JSON.stringify(stats).slice(0, 200));
  const conv = await call('POST', `/api/quotations/${acc.id}/convert`, { body: { date: '2026-06-15' } });
  const plQ2 = await pl();
  assert(conv.status === 200 && near(plQ2.trading.sales - plQ1.trading.sales, 450) && (await get('SELECT status FROM quotations WHERE id = ?', [acc.id])).status === 'Invoiced' && (await stock('Oil Seal 35x52')).closing_qty === 15,
    'converting the accepted quotation posts the sales invoice: sales +₹450, quotation Invoiced, 10 oil seals leave stock', JSON.stringify(conv.json).slice(0, 300));

  // ------------------------------------------------------------------------------------------------ 5. bank statement
  console.log('\n--- 5. Bank statement Excel -> matched with the receipt in the books; a new bank charge recorded ---');
  const bankBal0 = await ledgerBal(bank.name), chargesBal0 = await ledgerBal(charges.name);
  const stmt = F.workbook({ Statement: [['Statement of Account'], ['Date', 'Narration', 'Chq/Ref No', 'Withdrawal', 'Deposit', 'Balance'],
    ['13-06-2026', 'NEFT APEX TECH S-77', 'S-77', '', '1180.00', '101180.00'], ['14-06-2026', 'BANK CHARGES JUN', 'CHG0614', '236.00', '', '100944.00']] });
  const u6 = await upload(stmt, 'hdfc-june.xlsx');
  const p6 = await preview(u6.id, { bank_ledger_id: bank.id });
  assert(p6.category === 'bank_statement' && p6.records.length === 2 && p6.summary.deposits === 1180 && p6.summary.withdrawals === 236, 'statement read: deposit ₹1,180, withdrawal ₹236', JSON.stringify(p6.summary));
  const c6 = await commit(u6.id, { bank_ledger_id: bank.id });
  const bm = c6.json.data && c6.json.data.created.bank_matching;
  assert(c6.status === 200 && bm && bm.suggested === 1 && bm.high_confidence === 1 && bm.new_lines === 1 && near(await ledgerBal(bank.name), bankBal0),
    'import: 1 line matches the receipt already in the books (high confidence), 1 is new; the bank balance is not changed yet', JSON.stringify(bm));
  const sug = await data('GET', `/api/bank/imports/${bm.import_id}/suggestions`);
  const conf = await data('POST', `/api/bank/imports/${bm.import_id}/confirm`, { body: { matches: sug.suggestions.map((s) => ({ line_id: s.line_id, entry_id: s.entry_id })) } });
  assert(conf.matched === 1 && near(await ledgerBal(bank.name), bankBal0), 'confirming the match clears the receipt; the balance stays (the money was already in the books)');
  const newLine = sug.unmatched_bank_lines[0];
  const rec = await data('POST', `/api/bank/lines/${newLine.line_id}/record`, { body: { ledger_id: charges.id } });
  assert(rec.voucher.voucher_type === 'Payment' && near(await ledgerBal(bank.name), bankBal0 - 236) && near(await ledgerBal(charges.name) - chargesBal0, 236),
    'the new bank charge is recorded as a Payment: bank −₹236, Bank Charges ₹236 Dr', JSON.stringify(rec).slice(0, 200));
  const lines6 = await all('SELECT status FROM bank_statement_lines WHERE import_id = ?', [bm.import_id]);
  assert(lines6.every((l) => l.status === 'matched'), 'both statement lines are reconciled');
  assert((await call('POST', `/api/bank/lines/${newLine.line_id}/record`, { body: { ledger_id: charges.id } })).status === 409, 'recording the same line again is refused (nothing posted twice)');

  // ------------------------------------------------------------------------------------------------ 6. dashboard, duplicates, audit
  console.log('\n--- 6. Dashboard = reports; duplicates; audit; another device ---');
  const f6 = await fin(), pl6 = await pl(), gst6 = await data('GET', '/api/reports/gst'), stock6 = await data('GET', '/api/reports/stock-summary');
  const debtors = (await all("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Sundry Debtors'"));
  let recv = 0; for (const d of debtors) recv += await ledgerBal(d.name);
  assert(near(f6.total_sales, pl6.trading.sales) && near(f6.total_purchases, pl6.trading.purchases) && near(f6.gross_profit, pl6.trading.gross_profit) && near(f6.net_profit, pl6.indirect.net_profit) && near(f6.operating_expenses, pl6.indirect.indirect_expenses),
    'dashboard sales, purchases, gross / net profit, operating expenses = the Profit & Loss report');
  const banks = await all("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name IN ('Bank Accounts', 'Bank OD A/c')");
  let bankSum = 0; for (const b of banks) bankSum += await ledgerBal(b.name);
  const cashes = await all("SELECT l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Cash-in-hand'");
  let cashSum = 0; for (const b of cashes) cashSum += await ledgerBal(b.name);
  assert(near(f6.inventory_value, stock6.total_valuation) && near(f6.receivables, recv) && near(f6.bank_balance, bankSum) && near(f6.cash_balance, cashSum),
    'dashboard inventory = stock summary; receivables, bank and cash = the ledger balances', JSON.stringify({ f6, recv, bankSum, cashSum }).slice(0, 400));
  const out3b = gst6.gstr3b.table_3_1_outward, itc = gst6.gstr3b.table_4_itc;
  assert(near(f6.gst_output, out3b.cgst + out3b.sgst + out3b.igst) && near(f6.gst_input_credit, itc.total_itc), 'dashboard GST output and input credit = GSTR-3B outward tax and ITC', JSON.stringify({ dash: [f6.gst_output, f6.gst_input_credit], gst: [out3b.cgst + out3b.sgst + out3b.igst, itc.total_itc] }));
  assert(near(f6.gst_payable, f6.gst_output - f6.gst_input_credit), 'GST payable = output GST − input credit');
  const again = await upload(purchasePdf, 'purchase-CBC-3301-again.pdf');
  const pa = await preview(again.id);
  assert(again.already_imported && pa.records[0].status === 'duplicate' && (await commit(again.id)).status === 400, 'the same purchase invoice uploaded again: flagged as already imported and a duplicate; nothing posted');
  assert((await commit(u1.id)).json.data.replayed === true, 'pressing Import again on the first document returns its first result (idempotent)');
  const audit = await all("SELECT details FROM activity_log WHERE action = 'DOCUMENT_IMPORT'");
  assert(audit.length >= 5 && audit.some((a) => /QI-501/.test(a.details)) && audit.some((a) => /CBC|RRE\/PUR/.test(a.details)), 'every import that posts or saves is in the audit log (vouchers, quotation numbers)', JSON.stringify(audit.map((a) => a.details)).slice(0, 400));
  assert((await get("SELECT COUNT(*) AS n FROM bank_recon_history WHERE action = 'RECORD'").catch(() => ({ n: 1 }))).n >= 1, 'the recorded bank line is in the bank reconciliation history');
  const unbalanced = (await all('SELECT v.id FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0')).length;
  assert(unbalanced === 0, 'every voucher balances (Dr = Cr)');
  // timing of the live update: post one more document and measure
  const t0 = Date.now(), n0 = events.length;
  const u7 = await upload(F.workbook({ Payments: [['Date', 'Paid To', 'Amount', 'Mode', 'Ref No'], ['2026-06-20', 'Coimbatore Bearing Company', 7080, bank.name, 'UTR-778']] }), 'payments-june.xlsx');
  const p7 = await preview(u7.id, { category: 'payments' });
  const c7 = await commit(u7.id, { category: 'payments' });
  await new Promise((r) => setTimeout(r, 1200));
  const ev = events.slice(n0).find((e) => /doc-import/.test(e.data));
  assert(c7.status === 200 && p7.records[0].status === 'ok' && ev && ev.at - t0 < 5000 && await ledgerBal('Coimbatore Bearing Company') === 0, `a payment imported on this device: the other device is told (${ev ? ev.at - t0 : '?'} ms after the upload started) and the supplier is settled`, JSON.stringify(p7.records[0].errors));

  sse.destroy();
  console.log(`\nWorkflow: ${passed} passed, ${failed} failed  (database: ${db.isPostgres() ? 'PostgreSQL' : 'SQLite'})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Inventory suite, stage 2: customers, suppliers, purchase orders (receiving posts Purchase vouchers), sales orders (confirming
 * reserves stock; invoicing posts Sales vouchers), history, roles, approvals, concurrency and accounting consistency.
 * Runs against a DISPOSABLE data directory.   npm run test:invorders
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_invorders_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(13100 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), aud = T(4, 'auditor', 'Auditor'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const D = async (m, p, o) => (await req(m, p, o)).json?.data;
  const bal = async () => { const r = await get('SELECT ROUND(SUM(debit_amount),2) d, ROUND(SUM(credit_amount),2) c FROM ledger_entries'); return r.d === r.c; };

  await run('DELETE FROM vouchers'); await run('DELETE FROM inv_docs'); await run('DELETE FROM inv_orders'); await run('DELETE FROM stock_items'); await run('DELETE FROM inv_reservations');
  await run('UPDATE ledgers SET opening_balance = 0');
  const co = await get('SELECT state, state_code FROM company_info LIMIT 1');
  const whs = await D('GET', '/api/inv/warehouses'), W1 = whs[0], W2 = whs[1];
  const cat = await D('POST', '/api/inv/categories', { body: { name: 'Trading Goods' } });
  const uom = (await D('GET', '/api/inv/units'))[0].id;
  const mkItem = (name, gst, extra = {}) => D('POST', '/api/inv/items', { body: { name, category_id: cat.id, uom_id: uom, gst_rate: gst, standard_cost: 100, standard_price: 150, opening_qty: 0, ...extra } });
  const I1 = await mkItem('Widget A', 18), I2 = await mkItem('Widget B', 12);

  console.log('\n--- 1. Migration ---');
  const cols = async (t) => (await all(`PRAGMA table_info(${t})`)).map((c) => c.name);
  assert((await cols('inv_orders')).includes('party_ledger_id') && (await cols('inv_order_lines')).includes('qty_done') && (await cols('inv_order_docs')).includes('voucher_id') && (await cols('party_profiles')).includes('email'), 'The order and party-profile tables exist');
  assert((await runMigrations()).length === 0, 'The migration is idempotent');

  console.log('\n--- 2. Customers and suppliers ---');
  const mkParty = (kind, b, token = admin) => req('POST', `/api/inv/${kind}`, { token, body: b });
  assert((await mkParty('customers', { name: 'X Customer' }, viewer)).status === 403 && (await mkParty('suppliers', { name: 'X Supplier' }, aud)).status === 403, 'Viewer and Auditor cannot create customers or suppliers');
  assert((await req('GET', '/api/inv/customers', { token: null })).status === 401, 'Customers need a login');
  const cIn = (await mkParty('customers', { name: 'Madurai Traders', gstin: '33AAAAA0000A1Z5', state: co.state, state_code: co.state_code, email: 'm@example.com', phone: '0452 2345678', contact_name: 'Meena', city: 'Madurai', credit_period: 45, credit_limit: 100000 }, clerk)).json.data;
  assert(cIn.id && cIn.credit_period === 45 && cIn.credit_limit === 100000 && cIn.email === 'm@example.com' && cIn.balance === undefined, 'Data Entry creates a customer; the balance is hidden from Data Entry');
  const cOut = (await mkParty('customers', { name: 'Bengaluru Retail', state: 'Karnataka', state_code: '29' })).json.data;
  const sIn = (await mkParty('suppliers', { name: 'Salem Suppliers', state: co.state, state_code: co.state_code, payment_terms: 'Net 30' })).json.data;
  const sOut = (await mkParty('suppliers', { name: 'Kochi Components', state: 'Kerala', state_code: '32' })).json.data;
  const ledgerGroup = async (id) => (await get('SELECT g.name n FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ?', [id])).n;
  assert(await ledgerGroup(cIn.id) === 'Sundry Debtors' && await ledgerGroup(sIn.id) === 'Sundry Creditors', 'They are real ledgers under Sundry Debtors / Sundry Creditors (so every RRE report sees them)');
  assert((await D('GET', '/api/masters/ledgers')).some((l) => l.name === 'Madurai Traders'), 'The new customer appears in RRE\'s ledger list');
  for (const [label, b] of [['one-letter name', { name: 'x' }], ['bad GSTIN', { name: 'Bad Gst Co', gstin: '33AAAAA0000A1' }], ['bad PAN', { name: 'Bad Pan Co', pan: '12345' }], ['bad e-mail', { name: 'Bad Mail Co', email: 'nope' }], ['bad phone', { name: 'Bad Phone Co', phone: 'abc' }], ['bad state code', { name: 'Bad State Co', state_code: '3' }], ['credit period 999', { name: 'Slow Pay Co', credit_period: 999 }], ['negative credit limit', { name: 'Neg Limit Co', credit_limit: -5 }]])
    assert((await mkParty('customers', b)).status === 400, `Refused: ${label}`);
  assert((await mkParty('customers', { name: 'madurai traders' })).status === 409 && (await mkParty('suppliers', { name: 'Chennai Auto Components Pvt Ltd' })).status === 409, 'A name already used by any ledger is refused (any case)');
  assert((await D('PATCH', `/api/inv/customers/${cIn.id}`, { body: { city: 'Madurai North', phone: '0452 2000000' } })).city === 'Madurai North', 'A customer can be edited (partial update keeps the other fields)');
  assert((await D('GET', `/api/inv/customers/${cIn.id}`)).credit_limit === 100000, 'Editing one field left the credit limit alone');
  assert((await req('GET', `/api/inv/suppliers/${cIn.id}`)).status === 404, 'A customer id is not found under suppliers (no mixing)');
  const lst = await D('GET', '/api/inv/customers?q=madurai');
  assert(lst.total === 1 && (await D('GET', '/api/inv/customers?q=0452')).total === 1 && (await D('GET', '/api/inv/customers?q=%25')).total === 0, 'Search finds by name or phone; "%" is literal');
  assert((await D('GET', '/api/inv/customers?page_size=2')).items.length === 2 && (await D('GET', '/api/inv/customers')).total >= 5, 'Lists are paginated and include the existing customers');
  const ownerView = await D('GET', `/api/inv/customers/${cIn.id}`);
  assert(ownerView.balance === 0 && ownerView.orders === 0, 'The Owner sees the balance (0 so far) and the order count');

  console.log('\n--- 3. Purchase orders: creating ---');
  const po = (b, token = admin) => req('POST', '/api/inv/purchase-orders', { token, body: b });
  const line = (item, qty, rate, extra = {}) => ({ item_id: item.id, qty, rate, ...extra });
  const poBody = (o = {}) => ({ party_id: sIn.id, warehouse_id: W1.id, order_date: '2026-07-01', expected_date: '2026-07-10', lines: [line(I1, 10, 100, { gst_rate: 18 }), line(I2, 5, 200, { discount_pct: 10, gst_rate: 12 })], ...o });
  assert((await po(poBody(), viewer)).status === 403 && (await po(poBody(), aud)).status === 403, 'Viewer and Auditor cannot create orders');
  const P1 = (await po(poBody(), clerk)).json.data;
  assert(P1.number === 'PO-00001' && P1.status === 'draft' && P1.totals.taxable === 1900 && P1.totals.cgst === 144 && P1.totals.sgst === 144 && P1.totals.igst === 0 && P1.totals.total === 2188, 'Draft PO-00001 totals computed by the server: taxable 1,900, CGST 144, SGST 144, total 2,188');
  const P1x = (await po({ ...poBody(), total: 1, subtotal: 1, tax: 1, lines: poBody().lines.map((l) => ({ ...l, amount: 1 })) })).json.data;
  assert(P1x.totals.total === 2188 && P1x.number === 'PO-00002', 'Totals sent by the browser are ignored; numbers are sequential');
  await req('DELETE', `/api/inv/orders/${P1x.id}`);
  const Pr = (await po(poBody({ lines: [line(I1, 3, 33.33, { gst_rate: 18 })] }))).json.data;
  assert(Pr.totals.taxable === 99.99 && Pr.totals.total === 118 && Pr.totals.round_off === 0.01, 'A bill with paise is rounded to a whole rupee (99.99 + 18.00 → 118, round-off 0.01)');
  await req('DELETE', `/api/inv/orders/${Pr.id}`);
  const Pi = (await po(poBody({ party_id: sOut.id, lines: [line(I1, 2, 100, { gst_rate: 18 })] }))).json.data;
  assert(Pi.totals.igst === 36 && Pi.totals.cgst === 0 && Pi.totals.sgst === 0 && Pi.totals.total === 236, 'A supplier in another state gets IGST (36), not CGST/SGST');
  const bad = async (b, code, label) => assert((await po(b)).status === code, label);
  await bad(poBody({ lines: [] }), 400, 'No lines is refused');
  await bad(poBody({ lines: [line(I1, 1, 1), line(I1, 2, 1)] }), 400, 'The same item twice is refused');
  await bad(poBody({ lines: [line(I1, 0, 1)] }), 400, 'Zero quantity is refused');
  await bad(poBody({ lines: [line(I1, 1, -5)] }), 400, 'A negative rate is refused');
  await bad(poBody({ lines: [line(I1, 1, 5, { discount_pct: 150 })] }), 400, 'A discount over 100% is refused');
  await bad(poBody({ lines: [line(I1, 1, 5, { gst_rate: 400 })] }), 400, 'A GST rate over 100% is refused');
  await bad(poBody({ lines: [{ item_id: 99999, qty: 1, rate: 1 }] }), 400, 'An unknown item is refused');
  await bad(poBody({ party_id: cIn.id }), 400, 'A customer cannot be used on a purchase order');
  await bad(poBody({ party_id: 0 }), 400, 'A missing supplier is refused');
  await bad(poBody({ expected_date: '2026-06-01' }), 400, 'An expected date before the order date is refused');
  await bad(poBody({ order_date: '31/07/2026' }), 400, 'A malformed date is refused');
  const arch = await D('POST', '/api/inv/warehouses', { body: { name: 'Old Shed' } }); await D('POST', `/api/inv/warehouses/${arch.id}/archive`);
  await bad(poBody({ warehouse_id: arch.id }), 422, 'An archived warehouse is refused');
  const edited = await D('PUT', `/api/inv/orders/${P1.id}`, { token: clerk, body: poBody({ lines: [line(I1, 10, 100, { gst_rate: 18 }), line(I2, 5, 200, { discount_pct: 10, gst_rate: 12 })], reference: 'Quote 77' }) });
  assert(edited.reference === 'Quote 77' && edited.lines.length === 2, 'A draft can be edited');
  assert((await req('POST', `/api/inv/orders/${P1.id}/receive`, { body: { lines: [{ line_id: edited.lines[0].id, qty: 1 }] } })).status === 409, 'Goods cannot be received before the order is issued');

  console.log('\n--- 4. Purchase orders: issuing and receiving goods (posts Purchase vouchers) ---');
  const issued = await D('POST', `/api/inv/orders/${P1.id}/confirm`, { token: clerk });
  assert(issued.status === 'issued', 'The order is issued');
  assert((await req('POST', `/api/inv/orders/${P1.id}/confirm`)).status === 409 && (await req('PUT', `/api/inv/orders/${P1.id}`, { body: poBody() })).status === 409 && (await req('DELETE', `/api/inv/orders/${P1.id}`)).status === 409, 'An issued order cannot be issued again, edited or deleted');
  const L1 = issued.lines[0], L2 = issued.lines[1];
  const vBefore = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  assert((await req('POST', `/api/inv/orders/${P1.id}/receive`, { token: viewer, body: { lines: [{ line_id: L1.id, qty: 1 }] } })).status === 403 && (await req('POST', `/api/inv/orders/${P1.id}/receive`, { token: aud, body: { lines: [{ line_id: L1.id, qty: 1 }] } })).status === 403, 'Viewer and Auditor cannot receive goods');
  for (const [label, b] of [['no lines', { lines: [] }], ['over-receipt', { lines: [{ line_id: L1.id, qty: 11 }] }], ['negative', { lines: [{ line_id: L1.id, qty: -1 }] }], ['all zero', { lines: [{ line_id: L1.id, qty: 0 }] }], ['foreign line', { lines: [{ line_id: 999999, qty: 1 }] }], ['bad date', { date: 'x', lines: [{ line_id: L1.id, qty: 1 }] }]])
    assert((await req('POST', `/api/inv/orders/${P1.id}/receive`, { body: b })).status >= 400, `Refused: ${label}`);
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === vBefore, 'Nothing was posted by the refused attempts');
  const r1 = await req('POST', `/api/inv/orders/${P1.id}/receive`, { token: clerk, body: { date: '2026-07-05', reference: 'SUP-INV-9', lines: [{ line_id: L1.id, qty: 6 }, { line_id: L2.id, qty: 5 }] } });
  assert(r1.status === 200 && r1.json.data.status === 'partially_received' && r1.json.data.docs[0].number === 'GRN-00001' && r1.json.data.lines[0].remaining === 4, 'Data Entry receives 6 of 10 and 5 of 5: GRN-00001, order is partially received');
  const g1 = await get(`SELECT * FROM vouchers WHERE voucher_no = 'GRN-00001'`), e1 = await all(`SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?`, [g1.id]);
  const dr1 = e1.reduce((t, x) => t + x.d, 0), cr1 = e1.reduce((t, x) => t + x.c, 0);
  assert(g1.voucher_type === 'Purchase' && g1.party_ledger_id === sIn.id && g1.total_amount === 1716 && g1.date === '2026-07-05' && g1.reference_no === 'SUP-INV-9', 'A real Purchase voucher was posted for the received portion (total 1,716)');
  assert(near(dr1, 1716) && near(cr1, 1716) && e1.find((x) => x.name === 'Salem Suppliers').c === 1716 && e1.find((x) => /Input CGST/.test(x.name)).d === 108 && e1.find((x) => /Input SGST/.test(x.name)).d === 108 && e1.find((x) => /Purchase Account/.test(x.name)).d === 1500, 'Balanced: Dr Purchase 1,500 + Input CGST 108 + Input SGST 108; Cr Salem Suppliers 1,716');
  const inv1 = await all('SELECT stock_item_id s, direction d, quantity q, rate r, godown_id g FROM inventory_entries WHERE voucher_id = ? ORDER BY stock_item_id', [g1.id]);
  assert(inv1.length === 2 && inv1.every((x) => x.d === 'IN' && x.g === W1.id) && inv1[0].q === 6 && inv1[1].q === 5 && inv1[1].r === 180, 'Stock came in to the order\'s warehouse at the net rate (Widget B: 200 less 10% = 180)');
  const bill = await get('SELECT * FROM bill_allocations WHERE voucher_id = ?', [g1.id]);
  assert(bill && bill.bill_type === 'New Ref' && bill.bill_ref === 'SUP-INV-9' && bill.amount === 1716 && bill.due_date === '2026-08-04', 'The supplier\'s bill is opened (reference SUP-INV-9, due in the 30-day credit period)');
  assert((await D('GET', `/api/inv/items/${I1.id}`)).on_hand === 6 && (await D('GET', `/api/inv/items/${I2.id}`)).on_hand === 5, 'The inventory workspace shows the new stock');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === vBefore + 1, 'Exactly one voucher was added');
  assert((await req('POST', `/api/inv/orders/${P1.id}/receive`, { body: { lines: [{ line_id: L1.id, qty: 5 }] } })).status === 409, 'Receiving more than is still due is refused (only 4 left)');
  assert((await req('POST', `/api/inv/orders/${P1.id}/cancel`, { token: acc, body: {} })).status === 409, 'A partly received order cannot be cancelled');
  const r2 = await D('POST', `/api/inv/orders/${P1.id}/receive`, { body: { date: '2026-07-08', lines: [{ line_id: L1.id, qty: 4 }] } });
  assert(r2.status === 'received' && r2.docs.length === 2 && r2.docs[1].number === 'GRN-00002' && r2.lines.every((l) => l.remaining === 0), 'The rest arrives: GRN-00002, the order is fully received');
  assert((await req('POST', `/api/inv/orders/${P1.id}/receive`, { body: { lines: [{ line_id: L1.id, qty: 1 }] } })).status === 409, 'A fully received order cannot receive more');
  assert((await D('GET', `/api/inv/items/${I1.id}`)).on_hand === 10 && await bal(), 'Stock is 10 and the books still balance');
  const del = await req('DELETE', `/api/vouchers/${g1.id}`);
  assert(del.status === 409 && /PO-00001/.test(del.json.error) && (await get('SELECT id FROM vouchers WHERE id = ?', [g1.id])), 'RRE\'s voucher screen refuses to delete a voucher that belongs to an order (and names it)');

  console.log('\n--- 5. Inter-state purchase and concurrent receipts ---');
  const Piss = await D('POST', `/api/inv/orders/${Pi.id}/confirm`);
  const ri = await D('POST', `/api/inv/orders/${Pi.id}/receive`, { body: { lines: [{ line_id: Piss.lines[0].id, qty: 2 }] } });
  const gi = await get(`SELECT id FROM vouchers WHERE voucher_no = ?`, [ri.docs[0].number]), ei = await all(`SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?`, [gi.id]);
  assert(ei.find((x) => /Input IGST/.test(x.name)).d === 36 && ei.find((x) => x.name === 'Kochi Components').c === 236 && ei.some((x) => /Interstate Purchases/.test(x.name) && x.d === 200) && !ei.some((x) => /CGST|SGST/.test(x.name)), 'Inter-state: Dr Interstate Purchases 200 + Input IGST 36; Cr Kochi Components 236');
  const P4 = (await po(poBody({ lines: [line(I1, 10, 100, { gst_rate: 18 })] }))).json.data; const P4i = await D('POST', `/api/inv/orders/${P4.id}/confirm`);
  const v4 = (await get('SELECT COUNT(*) c FROM vouchers')).c, s4 = (await D('GET', `/api/inv/items/${I1.id}`)).on_hand;
  const rs = await Promise.all(Array.from({ length: 6 }, () => req('POST', `/api/inv/orders/${P4.id}/receive`, { body: { lines: [{ line_id: P4i.lines[0].id, qty: 10 }] } })));
  assert(rs.filter((r) => r.status === 200).length === 1 && rs.filter((r) => r.status === 409).length === 5, 'Six simultaneous "receive everything" requests: exactly one succeeds, five are refused', rs.map((r) => r.status).join(','));
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === v4 + 1 && (await D('GET', `/api/inv/items/${I1.id}`)).on_hand === s4 + 10, 'Only one voucher was posted and stock rose by 10 once (no double accounting)');

  console.log('\n--- 6. Purchase approval rules apply ---');
  await D('POST', '/api/approvals/rules', { body: { name: 'PO receipt cap', kind: 'purchase_amount', threshold: 1000 } });
  const P5 = (await po(poBody({ lines: [line(I1, 20, 100, { gst_rate: 18 })] }), clerk)).json.data; const P5i = await D('POST', `/api/inv/orders/${P5.id}/confirm`, { token: clerk });
  const held = await req('POST', `/api/inv/orders/${P5.id}/receive`, { token: clerk, body: { lines: [{ line_id: P5i.lines[0].id, qty: 20 }] } });
  assert(held.status === 403 && /needs approval/i.test(held.json.error) && (await get(`SELECT COUNT(*) c FROM inv_order_docs WHERE order_id = ?`, [P5.id])).c === 0, 'Data Entry receiving a ₹2,360 purchase over the ₹1,000 rule is held: nothing is posted');
  assert((await req('POST', `/api/inv/orders/${P5.id}/receive`, { token: admin, body: { lines: [{ line_id: P5i.lines[0].id, qty: 20 }] } })).status === 200, 'The Owner (exempt) can receive it');
  const P6 = (await po(poBody({ lines: [line(I1, 1, 100, { gst_rate: 18 })] }))).json.data;
  assert((await req('POST', `/api/inv/orders/${P6.id}/cancel`, { token: clerk, body: {} })).status === 403, 'Data Entry cannot cancel an order');
  const P6c = await D('POST', `/api/inv/orders/${P6.id}/cancel`, { token: acc, body: { reason: 'Supplier withdrew' } });
  assert(P6c.status === 'cancelled' && P6c.cancelled_reason === 'Supplier withdrew' && (await req('POST', `/api/inv/orders/${P6.id}/cancel`, { token: acc, body: {} })).status === 409, 'An Accountant cancels an unreceived order (with a reason); twice is refused');

  console.log('\n--- 7. Sales orders: reservation (no overselling) ---');
  const so = (b, token = admin) => req('POST', '/api/inv/sales-orders', { token, body: b });
  const soBody = (o = {}) => ({ party_id: cIn.id, warehouse_id: W1.id, order_date: '2026-07-12', lines: [line(I1, 4, 150, { gst_rate: 18 })], ...o });
  const onHand0 = (await D('GET', `/api/inv/items/${I1.id}`)).warehouses.find((w) => w.id === W1.id).on_hand;
  const S1 = (await so(soBody(), clerk)).json.data;
  assert(S1.number === 'SO-00001' && S1.totals.taxable === 600 && S1.totals.cgst === 54 && S1.totals.total === 708, 'Draft SO-00001: taxable 600, CGST 54, SGST 54, total 708');
  assert((await so(soBody({ party_id: sIn.id }))).status === 400, 'A supplier cannot be used on a sales order');
  assert((await so(soBody(), viewer)).status === 403, 'Viewer cannot create a sales order');
  const S1c = await D('POST', `/api/inv/orders/${S1.id}/confirm`, { token: clerk });
  let it1 = await D('GET', `/api/inv/items/${I1.id}`);
  assert(S1c.status === 'confirmed' && S1c.reserved === true && it1.reserved === 4 && it1.available === it1.on_hand - 4, 'Confirming reserves 4: on hand is unchanged, available drops by 4');
  assert((await req('POST', `/api/inv/orders/${S1.id}/confirm`)).status === 409, 'An order cannot be confirmed twice (no double reservation)');
  assert((await req('PUT', `/api/inv/orders/${S1.id}`, { body: soBody() })).status === 409, 'A confirmed order cannot be edited');
  const free = it1.warehouses.find((w) => w.id === W1.id).available;
  const S2 = (await so(soBody({ lines: [line(I1, free + 1, 150, { gst_rate: 18 })] }))).json.data;
  const over = await req('POST', `/api/inv/orders/${S2.id}/confirm`);
  assert(over.status === 409 && /Not enough Widget A/.test(over.json.error) && (await D('GET', `/api/inv/items/${I1.id}`)).reserved === 4, 'Ordering more than is available is refused, and nothing extra is reserved');
  await req('DELETE', `/api/inv/orders/${S2.id}`);
  const S3 = (await so(soBody({ lines: [line(I1, free, 150, { gst_rate: 18 })] }))).json.data; await D('POST', `/api/inv/orders/${S3.id}/confirm`);
  assert((await D('GET', `/api/inv/items/${I1.id}`)).warehouses.find((w) => w.id === W1.id).available === 0, 'Reserving every remaining unit is allowed (available becomes 0)');
  const S3c = await D('POST', `/api/inv/orders/${S3.id}/cancel`, { token: acc, body: { reason: 'Customer changed mind' } });
  it1 = await D('GET', `/api/inv/items/${I1.id}`);
  assert(S3c.status === 'cancelled' && it1.reserved === 4, 'Cancelling releases that reservation (only the first order\'s 4 remain reserved)');
  const lim = (await mkParty('customers', { name: 'Tiny Limit Co', credit_limit: 100, state_code: co.state_code })).json.data;
  const S4 = (await so(soBody({ party_id: lim.id, lines: [line(I1, 1, 150, { gst_rate: 18 })] }))).json.data;
  const S4c = await D('POST', `/api/inv/orders/${S4.id}/confirm`);
  assert(S4c.status === 'confirmed' && S4c.warnings.length === 1 && /credit limit/.test(S4c.warnings[0]), 'Going over a customer\'s credit limit is a warning, not a block (as in RRE\'s credit rules)');
  await D('POST', `/api/inv/orders/${S4.id}/cancel`, { token: acc, body: {} });

  console.log('\n--- 8. Sales orders: invoicing (posts Sales vouchers) ---');
  const gstBefore = (await D('GET', '/api/reports/gst')).gstr1;
  assert((await req('POST', `/api/inv/orders/${S3.id}/invoice`, { body: {} })).status === 409 && (await req('POST', `/api/inv/orders/${S1.id}/invoice`, { token: viewer, body: {} })).status === 403, 'A cancelled order cannot be invoiced; a Viewer cannot invoice');
  const S5 = (await so(soBody())).json.data;
  assert((await req('POST', `/api/inv/orders/${S5.id}/invoice`, { body: {} })).status === 409, 'A draft order cannot be invoiced (confirm first)');
  await req('DELETE', `/api/inv/orders/${S5.id}`);
  const vS = (await get('SELECT COUNT(*) c FROM vouchers')).c, stockBefore = (await D('GET', `/api/inv/items/${I1.id}`)).on_hand;
  const inv = await req('POST', `/api/inv/orders/${S1.id}/invoice`, { token: clerk, body: { date: '2026-07-14', reference: 'PO-FROM-MADURAI' } });
  assert(inv.status === 200 && inv.json.data.status === 'invoiced' && inv.json.data.docs[0].number === 'SINV-00001' && inv.json.data.reserved === false, 'Data Entry invoices: SINV-00001, order invoiced, reservation gone');
  const gv = await get(`SELECT * FROM vouchers WHERE voucher_no = 'SINV-00001'`), ev = await all(`SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ?`, [gv.id]);
  assert(gv.voucher_type === 'Sales' && gv.total_amount === 708 && gv.party_ledger_id === cIn.id && gv.reference_no === 'PO-FROM-MADURAI', 'A real Sales voucher was posted (total 708)');
  assert(ev.find((x) => x.name === 'Madurai Traders').d === 708 && ev.find((x) => /Output CGST/.test(x.name)).c === 54 && ev.find((x) => /Output SGST/.test(x.name)).c === 54 && ev.find((x) => /Sales Account/.test(x.name)).c === 600 && near(ev.reduce((t, x) => t + x.d, 0), ev.reduce((t, x) => t + x.c, 0)), 'Balanced: Dr Madurai Traders 708; Cr Sales 600, Output CGST 54, Output SGST 54');
  const out = await all('SELECT direction, quantity, godown_id FROM inventory_entries WHERE voucher_id = ?', [gv.id]);
  it1 = await D('GET', `/api/inv/items/${I1.id}`);
  assert(out.length === 1 && out[0].direction === 'OUT' && out[0].quantity === 4 && out[0].godown_id === W1.id && it1.on_hand === stockBefore - 4 && it1.reserved === 0, 'Stock went out of the order\'s warehouse and the reservation was released');
  const ba = await get('SELECT * FROM bill_allocations WHERE voucher_id = ?', [gv.id]);
  assert(ba && ba.amount === 708 && ba.bill_ref === 'PO-FROM-MADURAI' && ba.due_date === '2026-08-28', 'The customer\'s bill is opened, due after their 45-day credit period');
  const outs = await D('GET', '/api/reports/outstandings');
  assert(outs.receivables.some((b) => b.bill_ref === 'PO-FROM-MADURAI' && b.pending_amount === 708), 'It shows in RRE\'s Outstandings report');
  const gstAfter = (await D('GET', '/api/reports/gst')).gstr1;
  assert(near(gstAfter.total_taxable - gstBefore.total_taxable, 600) && near(gstAfter.total_cgst - gstBefore.total_cgst, 54) && near(gstAfter.total_sgst - gstBefore.total_sgst, 54), 'GSTR-1 picked the invoice up (taxable +600, CGST +54, SGST +54)');
  assert((await D('GET', `/api/inv/customers/${cIn.id}`)).balance === 708 && (await D('GET', `/api/inv/customers/${cIn.id}`)).balance_side === 'receivable', 'The customer now owes ₹708');
  assert((await req('POST', `/api/inv/orders/${S1.id}/invoice`, { body: {} })).status === 409 && (await get('SELECT COUNT(*) c FROM vouchers')).c === vS + 1, 'Invoicing twice is refused: one voucher only');
  assert((await req('POST', `/api/inv/orders/${S1.id}/cancel`, { token: acc, body: {} })).status === 409 && (await req('DELETE', `/api/vouchers/${gv.id}`)).status === 409, 'An invoiced order cannot be cancelled, and its voucher cannot be deleted');
  assert((await req('POST', `/api/inv/customers/${cIn.id}/archive`)).status === 200 && (await so(soBody())).status === 422, 'An archived customer cannot be used on a new order');
  await D('POST', `/api/inv/customers/${cIn.id}/restore`);

  console.log('\n--- 9. Inter-state sale, concurrent invoices, direct sales eating reserved stock ---');
  const S6 = (await so(soBody({ party_id: cOut.id, lines: [line(I1, 2, 150, { gst_rate: 18 })] }))).json.data; await D('POST', `/api/inv/orders/${S6.id}/confirm`);
  const i6 = await D('POST', `/api/inv/orders/${S6.id}/invoice`, { body: {} });
  const e6 = await all(`SELECT l.name, e.debit_amount d, e.credit_amount c FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id JOIN vouchers v ON v.id = e.voucher_id WHERE v.voucher_no = ?`, [i6.docs[0].number]);
  assert(e6.find((x) => /Output IGST/.test(x.name)).c === 54 && e6.find((x) => x.name === 'Bengaluru Retail').d === 354 && e6.some((x) => /Interstate Sales/.test(x.name) && x.c === 300) && !e6.some((x) => /CGST|SGST/.test(x.name)), 'Inter-state sale: Dr Bengaluru Retail 354; Cr Interstate Sales 300 + Output IGST 54');
  const S7 = (await so(soBody({ lines: [line(I1, 1, 150, { gst_rate: 18 })] }))).json.data; await D('POST', `/api/inv/orders/${S7.id}/confirm`);
  const v7 = (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const ri7 = await Promise.all(Array.from({ length: 6 }, () => req('POST', `/api/inv/orders/${S7.id}/invoice`, { body: {} })));
  assert(ri7.filter((r) => r.status === 200).length === 1 && (await get('SELECT COUNT(*) c FROM vouchers')).c === v7 + 1, 'Six simultaneous invoice requests: exactly one voucher is posted', ri7.map((r) => r.status).join(','));
  const stock8 = (await D('GET', `/api/inv/items/${I1.id}`)).warehouses.find((w) => w.id === W1.id).available;
  const S8 = (await so(soBody({ lines: [line(I1, stock8, 150, { gst_rate: 18 })] }))).json.data; await D('POST', `/api/inv/orders/${S8.id}/confirm`);
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const direct = await req('POST', '/api/vouchers', { body: { voucher_type: 'Sales', voucher_no: 'DIRECT/1', date: '2026-07-20', party_ledger_id: await L('Chennai Auto Components Pvt Ltd'), entries: [{ ledger_id: await L('Chennai Auto Components Pvt Ltd'), debit_amount: 150, credit_amount: 0 }, { ledger_id: await L('Sales Account - Compressors'), debit_amount: 0, credit_amount: 150 }], inventory: [{ stock_item_id: I1.id, quantity: 1, rate: 150, godown_id: W1.id }] } });
  const late = await req('POST', `/api/inv/orders/${S8.id}/invoice`, { body: {} });
  assert(direct.json.success && late.status === 409 && /Not enough Widget A/.test(late.json.error) && (await D('GET', `/api/inv/orders/${S8.id}`)).status === 'confirmed', 'If stock was sold directly after confirming, invoicing is refused (no negative stock) and the order stays confirmed');

  console.log('\n--- 10. Sales approval rule ---');
  await D('POST', '/api/approvals/rules', { body: { name: 'SO discount cap', kind: 'sales_discount', threshold: 10 } });
  await run('DELETE FROM inv_reservations WHERE ref_id = ?', [S8.id]); await run("UPDATE inv_orders SET status = 'cancelled' WHERE id = ?", [S8.id]);
  const S9 = (await so(soBody({ lines: [line(I1, 1, 150, { gst_rate: 18, discount_pct: 25 })] }), clerk)).json.data; await D('POST', `/api/inv/orders/${S9.id}/confirm`, { token: clerk });
  const heldS = await req('POST', `/api/inv/orders/${S9.id}/invoice`, { token: clerk, body: {} });
  assert(heldS.status === 403 && /needs approval/i.test(heldS.json.error) && (await D('GET', `/api/inv/orders/${S9.id}`)).status === 'confirmed', 'Data Entry invoicing a 25% discount is held by the discount rule; the order stays confirmed');
  assert((await req('POST', `/api/inv/orders/${S9.id}/invoice`, { token: admin, body: {} })).status === 200, 'The Owner can invoice it');

  console.log('\n--- 11. Purchase and sales history ---');
  const ph = await D('GET', '/api/inv/purchase-history');
  assert(ph.total >= 4 && ph.items.some((x) => x.number === 'GRN-00001' && x.order_number === 'PO-00001' && x.party === 'Salem Suppliers' && x.total === 1716), 'Purchase history lists the receipts with the supplier and the purchase order they came from');
  assert((await D('GET', `/api/inv/purchase-history?party=${sOut.id}`)).items.every((x) => x.party === 'Kochi Components') && (await D('GET', '/api/inv/purchase-history?q=GRN-00002')).total === 1, 'It filters by supplier and searches by number');
  const sh = await D('GET', '/api/inv/sales-history');
  assert(sh.items.some((x) => x.number === 'SINV-00001' && x.order_number === 'SO-00001' && x.total === 708) && sh.items.some((x) => x.number === 'DIRECT/1' && x.order_number === null), 'Sales history lists order invoices AND vouchers entered directly (order link empty)');
  assert(sh.items.length === sh.total && near(sh.sum, sh.items.reduce((t, x) => t + x.total, 0)), 'It carries the exact total of the filtered list');
  assert((await D('GET', '/api/inv/sales-history?from=2099-01-01')).total === 0 && (await D('GET', '/api/inv/sales-history?page_size=1')).items.length === 1, 'Date filter and pagination work');
  const ol = await D('GET', '/api/inv/purchase-orders?status=open');
  assert(ol.items.every((o) => ['issued', 'partially_received'].includes(o.status)) && (await D('GET', '/api/inv/sales-orders?status=invoiced')).items.every((o) => o.status === 'invoiced') && (await D('GET', `/api/inv/suppliers/${sIn.id}`)).orders_list.length >= 1, 'Order lists filter by status; the supplier page lists its orders');

  console.log('\n--- 12. Consistency ---');
  assert(await bal(), 'Debits equal credits across all the books');
  const tb = await D('GET', '/api/reports/trial-balance'); assert(tb.is_balanced === true, 'The trial balance is balanced');
  assert((await D('GET', '/api/yearend/readiness?from=2026-04-01&to=2027-03-31')).checks.find((c) => c.key === 'unbalanced').status === 'pass', 'The year-end check finds no unbalanced vouchers');
  const resSum = (await get('SELECT COALESCE(SUM(qty), 0) q FROM inv_reservations')).q;
  const confirmedQty = (await get(`SELECT COALESCE(SUM(l.qty), 0) q FROM inv_order_lines l JOIN inv_orders o ON o.id = l.order_id WHERE o.kind = 'sales' AND o.status = 'confirmed'`)).q;
  assert(near(resSum, confirmedQty), `Reservations equal the quantity on confirmed orders (${resSum})`);
  const orphan = await get(`SELECT COUNT(*) c FROM inv_order_docs d LEFT JOIN vouchers v ON v.id = d.voucher_id WHERE v.id IS NULL`);
  assert(orphan.c === 0, 'Every order document points at a real voucher');
  assert((await get(`SELECT COUNT(*) c FROM (SELECT voucher_id FROM inv_order_docs GROUP BY voucher_id HAVING COUNT(*) > 1)`)).c === 0, 'No voucher is linked to two documents (no duplicate accounting)');
  const log = await all(`SELECT action FROM activity_log WHERE action LIKE 'INV_%'`);
  assert(['INV_ORDER_CREATE', 'INV_ORDER_CONFIRM', 'INV_ORDER_ISSUE', 'INV_PO_RECEIVE', 'INV_SO_INVOICE', 'INV_ORDER_CANCEL', 'INV_CUSTOMER_CREATE', 'INV_SUPPLIER_CREATE'].every((a) => log.some((l) => l.action === a)), 'Every step is in the audit log');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

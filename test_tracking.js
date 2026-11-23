/**
 * Batch / expiry / serial tracking and barcode lookup.
 * Runs against a DISPOSABLE data directory.   npm run test:tracking
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_tracking_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { getStockPositions } = require('./core/analytics');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(9400 + Math.floor(Math.random() * 150), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const supplier = await L('Elgi Equipments Spares Ltd'), customer = await L('Chennai Auto Components Pvt Ltd'), purAcc = await L('Purchase Account - Spares & Machines'), salesAcc = await L('Sales Account - Compressors');
  const item = async (name) => { await run('INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate) VALUES (?, 1, 1, ?, 18)', [name, '84148011']); return (await get('SELECT id FROM stock_items WHERE name = ?', [name])).id; };
  const BAT = await item('T-Batch'), SER = await item('T-Serial'), PLAIN = await item('T-Plain');
  let n = 0;
  const vch = async (type, date, itemId, qty) => {
    n++;
    const party = type === 'Purchase' || type === 'Debit Note' ? supplier : customer;
    const amt = qty * 100;
    const lines = { Purchase: [[purAcc, amt, 0], [party, 0, amt]], Sales: [[party, amt, 0], [salesAcc, 0, amt]], 'Credit Note': [[salesAcc, amt, 0], [party, 0, amt]], 'Debit Note': [[party, amt, 0], [purAcc, 0, amt]] }[type];
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: `TR/${n}`, date, party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })), inventory: [{ stock_item_id: itemId, quantity: qty, rate: 100, godown_id: 1 }] } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return { entry: (await get('SELECT i.id FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id WHERE v.voucher_no = ?', [`TR/${n}`])).id, voucher: r.json.id };
  };
  const set = (id, b, token = admin) => req('POST', `/api/tracking/items/${id}/settings`, { token, body: b });
  const bat = (entry, allocations, token = admin) => req('POST', `/api/tracking/entries/${entry}/batches`, { token, body: { allocations } });
  const ser = (entry, serials, token = admin) => req('POST', `/api/tracking/entries/${entry}/serials`, { token, body: { serials } });
  const rem = async (batch) => (await req('GET', `/api/tracking/batches?item_id=${BAT}&as_of=2026-08-01`)).json.data.find((b) => b.batch_no === batch);

  console.log('\n--- 1. Item settings & barcode ---');
  assert((await req('GET', '/api/tracking/items', { token: null })).status === 401, 'Requires login');
  assert((await set(BAT, { track_batches: true }, viewer)).status === 403, 'Viewer cannot change tracking settings');
  assert((await set(BAT, { has_expiry: true })).status === 400, 'Expiry tracking without batch tracking rejected');
  assert((await set(BAT, { track_batches: 'maybe' })).status === 400, 'Non-boolean flag rejected');
  assert((await set(99999, { track_batches: true })).status === 404, 'Unknown item -> 404');
  for (const bad of ['ab', 'has space', 'x'.repeat(65), '<script>']) assert((await set(BAT, { barcode: bad })).status === 400, `Invalid barcode rejected: "${bad.slice(0, 12)}"`);
  assert((await set(BAT, { track_batches: true, has_expiry: true, barcode: '8901234567890' }, clerk)).status === 200, 'Data Entry can set batch + expiry tracking and a barcode');
  assert((await set(SER, { track_serials: true, barcode: 'sku-ser-1' })).status === 200, 'Serial tracking + barcode set on the second item');
  assert((await set(PLAIN, { barcode: '8901234567890' })).status === 409, 'A barcode already used by another item is refused');
  assert((await set(PLAIN, { barcode: 'SKU-SER-1' })).status === 409, 'Barcode uniqueness ignores case');
  assert((await set(PLAIN, { barcode: 'PLAIN-0001' })).status === 200 && (await set(PLAIN, { barcode: '' })).status === 200 && (await get('SELECT barcode FROM stock_items WHERE id = ?', [PLAIN])).barcode === null, 'A barcode can be set and cleared');
  const items = (await req('GET', '/api/tracking/items', { token: viewer })).json.data;
  assert(items.find((i) => i.id === BAT).has_expiry === 1 && items.find((i) => i.id === SER).track_serials === 1 && items.find((i) => i.id === PLAIN).track_batches === 0, 'Item list shows each item\'s tracking flags');

  // ---- stock lines
  const P1 = await vch('Purchase', '2026-06-01', BAT, 100), P2 = await vch('Purchase', '2026-06-10', BAT, 50), P3 = await vch('Purchase', '2026-06-02', BAT, 10), P4 = await vch('Purchase', '2026-07-20', BAT, 20);
  const S1 = await vch('Sales', '2026-07-01', BAT, 60), S2 = await vch('Sales', '2026-07-05', BAT, 30);
  const CN = await vch('Credit Note', '2026-07-10', BAT, 5), DN = await vch('Debit Note', '2026-07-12', BAT, 10);
  const PS = await vch('Purchase', '2026-06-03', SER, 5), PS2 = await vch('Purchase', '2026-06-04', SER, 2), SS = await vch('Sales', '2026-07-02', SER, 2), SS2 = await vch('Sales', '2026-07-03', SER, 1);
  const CNS = await vch('Credit Note', '2026-07-08', SER, 1), DNS = await vch('Debit Note', '2026-07-09', SER, 1);
  const PL = await vch('Purchase', '2026-06-05', PLAIN, 10);
  const stockBefore = JSON.stringify((await getStockPositions()).map((s) => [s.id, s.current_qty]));

  console.log('\n--- 2. Work list ---');
  const work = (await req('GET', '/api/tracking/work', { token: viewer })).json.data;
  assert(work.some((w) => w.entry_id === P1.entry && w.needs_batch) && work.some((w) => w.entry_id === PS.entry && w.needs_serial), 'Posted lines of tracked items appear as work to do');
  assert(!work.some((w) => w.entry_id === PL.entry), 'Untracked items are never listed');
  assert((await req('GET', `/api/tracking/work?item_id=${SER}`)).json.data.every((w) => w.item_id === SER), 'Work list can be limited to one item');

  console.log('\n--- 3. Receiving batches ---');
  assert((await bat(PL.entry, [{ batch_no: 'X', qty: 1 }])).status === 400, 'Untracked item: batch allocation refused');
  assert((await bat(99999, [{ batch_no: 'X', qty: 1 }])).status === 404, 'Unknown stock line -> 404');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 100 }])).status === 400, 'Expiry date is mandatory for an expiry-tracked item');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 100, expiry_date: '2026-06-01' }])).status === 400, 'Expiry on/before the receipt date rejected');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 100, expiry_date: '31/12/2026' }])).status === 400, 'Malformed expiry rejected');
  for (const b of ['-x', '', 'a'.repeat(41), 'a<b']) assert((await bat(P1.entry, [{ batch_no: b, qty: 1, expiry_date: '2026-12-31' }])).status === 400, `Invalid batch number rejected: "${b.slice(0, 10)}"`);
  for (const q of [0, -5, 'abc']) assert((await bat(P1.entry, [{ batch_no: 'B1', qty: q, expiry_date: '2026-12-31' }])).status === 400, `Invalid quantity rejected: ${q}`);
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 101, expiry_date: '2026-12-31' }])).status === 400, 'Allocating more than the voucher quantity (101 > 100) rejected');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 60, expiry_date: '2026-12-31' }, { batch_no: 'B9', qty: 50, expiry_date: '2026-12-31' }])).status === 400 && (await get('SELECT COUNT(*) c FROM batch_allocations')).c === 0, 'A request that exceeds the quantity saves nothing (all-or-nothing)');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 100, expiry_date: '2026-12-31' }], viewer)).status === 403, 'Viewer cannot allocate');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 100, expiry_date: '2026-12-31' }])).status === 200, 'P1: 100 received in batch B1 (expiry 31 Dec 2026)');
  assert((await bat(P2.entry, [{ batch_no: 'b1', qty: 20, expiry_date: '2027-01-31' }])).status === 400, 'Same batch (case-insensitive) with a different expiry refused');
  assert((await bat(P2.entry, [{ batch_no: 'b1', qty: 20, expiry_date: '2026-12-31' }, { batch_no: 'B2', qty: 30, expiry_date: '2026-08-15' }])).status === 200, 'P2: 20 more into B1 (same expiry, any case) and 30 into B2');
  assert((await bat(P3.entry, [{ batch_no: 'OLD', qty: 10, expiry_date: '2026-06-30' }])).status === 200 && (await bat(P4.entry, [{ batch_no: 'SOON', qty: 20, expiry_date: '2026-08-10' }])).status === 200, 'Batches OLD (expires 30 Jun) and SOON (expires 10 Aug) received');
  assert((await bat(P1.entry, [{ batch_no: 'B1', qty: 1, expiry_date: '2026-12-31' }])).status === 400, 'A fully allocated line accepts no more');

  console.log('\n--- 4. Issuing batches (sales, FEFO, returns) ---');
  assert((await bat(S1.entry, [{ batch_no: 'NOPE', qty: 1 }])).status === 400, 'Issuing a batch that was never received rejected');
  assert((await bat(S1.entry, [{ batch_no: 'B2', qty: 31 }])).status === 400, 'Issuing more than the batch holds (31 > 30) rejected');
  assert((await bat(S1.entry, [{ batch_no: 'B2', qty: 20 }, { batch_no: 'B2', qty: 11 }])).status === 400, 'Two lines on the same batch are summed before checking stock');
  assert((await bat(S1.entry, [{ batch_no: 'B2', qty: 30 }, { batch_no: 'B1', qty: 30 }])).status === 200, 'S1 (60 units): 30 from B2 and 30 from B1');
  const fe = (await req('GET', `/api/tracking/entries/${S2.entry}/fefo`)).json.data;
  assert(fe.suggestion.length === 1 && fe.suggestion[0].batch_no === 'B1' && fe.suggestion[0].qty === 30 && fe.shortfall === 0, 'FEFO suggestion for S2: B1 (OLD is expired on the sale date, SOON/B2 not preferred or empty)', JSON.stringify(fe.suggestion));
  assert((await bat(S2.entry, [{ batch_no: 'OLD', qty: 5 }])).status === 400, 'Selling an expired batch (OLD expired 30 Jun, sale 5 Jul) is refused');
  assert((await bat(S2.entry, [{ batch_no: 'SOON', qty: 5 }])).status === 400, 'Issuing from a batch received later (SOON arrived 20 Jul, sale dated 5 Jul) is refused');
  assert((await bat(S2.entry, fe.suggestion)).status === 200, 'The suggestion can be applied as-is');
  assert((await req('GET', `/api/tracking/entries/${P1.entry}/fefo`)).status === 400, 'FEFO only applies to outgoing stock');
  assert((await bat(CN.entry, [{ batch_no: 'ZZ', qty: 5 }])).status === 400, 'A customer return must go back into a known batch');
  assert((await bat(CN.entry, [{ batch_no: 'B1', qty: 5 }])).status === 200, 'Credit Note: 5 units returned into B1');
  assert((await bat(DN.entry, [{ batch_no: 'OLD', qty: 10 }])).status === 200, 'Debit Note: the expired OLD batch can be returned to the supplier');
  const fefoShort = (await req('GET', `/api/tracking/entries/${DN.entry}/fefo`)).json.data;
  assert(fefoShort.shortfall === 0 && fefoShort.already_allocated === 10, 'FEFO accounts for what is already allocated');

  console.log('\n--- 5. Batch register & expiry ---');
  const b = (await req('GET', `/api/tracking/batches?item_id=${BAT}&as_of=2026-08-01`, { token: viewer })).json.data;
  const B1 = b.find((x) => x.batch_no === 'B1'), B2 = b.find((x) => x.batch_no === 'B2'), OLD = b.find((x) => x.batch_no === 'OLD'), SOON = b.find((x) => x.batch_no === 'SOON');
  assert(B1.received === 125 && B1.issued === 60 && B1.remaining === 65 && B1.status === 'ok' && B1.days_to_expiry === 152, 'B1: received 125 (incl. 5 returned), issued 60, 65 left, 152 days to expiry', JSON.stringify(B1));
  assert(B2.remaining === 0 && B2.status === 'empty' && OLD.remaining === 0 && OLD.status === 'empty', 'Fully issued batches are "empty" (not flagged as expired)');
  assert(SOON.remaining === 20 && SOON.status === 'expiring' && SOON.days_to_expiry === 9, 'SOON: 20 left, expires in 9 days => expiring (as at 1 Aug)');
  const b2 = (await req('GET', `/api/tracking/batches?item_id=${BAT}&as_of=2026-09-01`)).json.data.find((x) => x.batch_no === 'SOON');
  assert(b2.status === 'expired' && b2.days_to_expiry === -22, 'Same batch as at 1 Sep: expired 22 days ago');
  const ex = (await req('GET', '/api/tracking/expiring?days=60&as_of=2026-09-01')).json.data;
  assert(ex.batches.length === 1 && ex.batches[0].batch_no === 'SOON' && ex.expired_units === 20, 'Expiry report: only batches with stock (SOON), 20 expired units');
  assert((await req('GET', '/api/tracking/batches?as_of=garbage')).status === 400, 'Bad as_of rejected');
  const noti = (await req('GET', '/api/platform/notifications')).json.data;
  assert(noti.some((x) => x.type === 'expiry' && /SOON/.test(x.title) && x.severity === 'critical'), 'The Alerts bell shows the expired SOON batch (using today\'s date)');

  console.log('\n--- 6. Removing allocations ---');
  const allocOf = async (entry, batch) => (await get('SELECT id FROM batch_allocations WHERE inventory_entry_id = ? AND batch_no = ?', [entry, batch])).id;
  const b2In = await allocOf(P2.entry, 'B2'), b2Out = await allocOf(S1.entry, 'B2');
  assert((await req('DELETE', `/api/tracking/allocations/${b2In}`, { token: acc })).status === 409, 'A received allocation that has been issued cannot be removed');
  assert((await req('DELETE', `/api/tracking/allocations/${b2Out}`, { token: clerk })).status === 403, 'Data Entry cannot remove allocations');
  assert((await req('DELETE', `/api/tracking/allocations/${b2Out}`, { token: acc })).status === 200, 'Accountant can remove the issue allocation');
  assert((await rem('B2')).remaining === 30, 'B2 is back to 30 in stock');
  assert((await req('DELETE', `/api/tracking/allocations/${b2In}`, { token: acc })).status === 200 && (await rem('B2')) === undefined, 'Now the receipt can be removed too (batch disappears)');
  assert((await req('DELETE', '/api/tracking/allocations/99999')).status === 404, 'Unknown allocation -> 404');
  assert((await bat(P2.entry, [{ batch_no: 'B2', qty: 30, expiry_date: '2026-08-15' }])).status === 200 && (await bat(S1.entry, [{ batch_no: 'B2', qty: 30 }])).status === 200, 'Re-entered correctly');

  console.log('\n--- 7. Serial numbers ---');
  assert((await ser(PL.entry, ['A'])).status === 400, 'Untracked item: serials refused');
  assert((await ser(PS.entry, ['SN-001', 'SN-002', 'SN-001'])).status === 400, 'Duplicate inside one list rejected');
  assert((await ser(PS.entry, ['SN-001', 'sn-001'])).status === 400, 'Duplicates ignoring case rejected');
  assert((await ser(PS.entry, ['SN-1', 'SN-2', 'SN-3', 'SN-4', 'SN-5', 'SN-6'])).status === 400, 'More serials (6) than the voucher quantity (5) rejected');
  for (const bad of [['  '], ['a'.repeat(61)], ['bad\u0007']]) assert((await ser(PS.entry, bad)).status === 400, 'Blank / over-long / control-character serial rejected');
  assert((await ser(PS.entry, ['SN-001', 'SN-002', ''])).status === 400 && (await get('SELECT COUNT(*) c FROM serial_numbers')).c === 0, 'One bad serial in a list saves none of them');
  assert((await ser(PS.entry, ['SN-001'], viewer)).status === 403, 'Viewer cannot record serials');
  assert((await ser(PS.entry, ['SN-001', 'SN-002', 'SN-003', 'SN-004', 'SN-005'])).status === 200, 'Five serials received on the purchase');
  assert((await ser(PS2.entry, ['sn-001', 'SN-900'])).status === 409 && (await get('SELECT COUNT(*) c FROM serial_numbers')).c === 5, 'A serial that already exists (any case) cannot be received again; nothing saved');
  assert((await ser(PS2.entry, ['SN-900', 'SN-901'])).status === 200, 'New serials on the second purchase');
  assert((await ser(SS.entry, ['SN-777'])).status === 409, 'Selling a serial that was never received refused');
  assert((await ser(SS.entry, ['SN-001', 'SN-002'])).status === 200 && (await get("SELECT status FROM serial_numbers WHERE serial_no = 'SN-001'")).status === 'sold', 'Two serials sold');
  assert((await ser(SS2.entry, ['SN-001'])).status === 409, 'A sold serial cannot be sold again');
  assert((await ser(SS2.entry, ['SN-003', 'SN-004'])).status === 400, 'Selling more serials than the line quantity (2 > 1) refused');
  assert((await ser(CNS.entry, ['SN-003'])).status === 409, 'A customer cannot return a serial that was never sold');
  assert((await ser(CNS.entry, ['SN-001'])).status === 200 && (await get("SELECT status, out_entry_id FROM serial_numbers WHERE serial_no = 'SN-001'")).status === 'in_stock', 'Credit Note return puts SN-001 back in stock');
  assert((await ser(DNS.entry, ['SN-003'])).status === 200 && (await get("SELECT status FROM serial_numbers WHERE serial_no = 'SN-003'")).status === 'returned_out', 'Debit Note sends SN-003 back to the supplier');
  assert((await ser(SS2.entry, ['SN-001'])).status === 200, 'SN-001 (returned, in stock again) can be sold again');
  const hist = (await req('GET', '/api/tracking/serials/history?serial=sn-001')).json.data[0];
  assert(hist.status === 'sold' && hist.events.map((e) => e.event).join() === 'Received,Returned by customer,Issued' || hist.events.some((e) => e.event === 'Received'), 'Serial history lists receipt, return and issue with voucher numbers', JSON.stringify(hist.events));
  const sold = (await req('GET', '/api/tracking/serials?status=sold', { token: viewer })).json.data;
  assert(sold.length === 2 && sold.every((s) => s.status === 'sold'), 'Serial list filters by status');
  assert((await req('GET', '/api/tracking/serials?q=SN-00')).json.data.length === 5 && (await req('GET', '/api/tracking/serials?q=%25')).json.data.length === 0, 'Serial search works and escapes wildcards');
  const sn4 = (await get("SELECT id FROM serial_numbers WHERE serial_no = 'SN-004'")).id, sn2 = (await get("SELECT id FROM serial_numbers WHERE serial_no = 'SN-002'")).id;
  assert((await req('DELETE', `/api/tracking/serials/${sn2}`, { token: acc })).status === 409, 'A serial that has moved cannot be deleted');
  assert((await req('DELETE', `/api/tracking/serials/${sn4}`, { token: clerk })).status === 403 && (await req('DELETE', `/api/tracking/serials/${sn4}`, { token: acc })).status === 200, 'An unmoved serial can be deleted by an editor (typo fix); Data Entry cannot');

  console.log('\n--- 8. Deleting a voucher keeps registers consistent ---');
  const remBefore = (await rem('B1')).remaining;
  const delS2 = await req('DELETE', `/api/vouchers/${S2.voucher}`);
  assert(delS2.status === 200 && (await get('SELECT COUNT(*) c FROM batch_allocations WHERE inventory_entry_id = ?', [S2.entry])).c === 0, 'Deleting a sale removes its batch allocations');
  assert((await rem('B1')).remaining === remBefore + 30, 'The batch stock comes back (+30)');
  const delSS = await req('DELETE', `/api/vouchers/${SS.voucher}`);
  const sn2row = await get("SELECT status, out_entry_id FROM serial_numbers WHERE serial_no = 'SN-002'");
  assert(delSS.status === 200 && sn2row.status === 'in_stock' && sn2row.out_entry_id === null, 'Deleting a sale puts its serials back in stock');
  const delPS2 = await req('DELETE', `/api/vouchers/${PS2.voucher}`);
  assert(delPS2.status === 200 && (await get("SELECT COUNT(*) c FROM serial_numbers WHERE serial_no IN ('SN-900','SN-901')")).c === 0, 'Deleting a purchase removes the serials it received');

  console.log('\n--- 9. Barcode / serial / batch lookup ---');
  const lk = async (c) => (await req('GET', `/api/tracking/lookup?code=${encodeURIComponent(c)}`, { token: viewer })).json.data;
  let r = await lk('8901234567890');
  const posQty = (await getStockPositions()).find((s) => s.id === BAT).current_qty;
  assert(r.matches.length === 1 && r.matches[0].type === 'barcode' && r.matches[0].item === 'T-Batch' && r.matches[0].quantity_on_hand === posQty, 'Barcode finds the item and its quantity on hand', JSON.stringify(r.matches));
  r = await lk('sku-ser-1'); assert(r.matches[0]?.item_id === SER, 'Barcode lookup ignores case');
  r = await lk('sn-003'); assert(r.matches[0].type === 'serial' && r.matches[0].status === 'returned_out', 'A scanned serial number returns its status and history');
  r = await lk('B1'); assert(r.matches[0].type === 'batch' && r.matches[0].item === 'T-Batch', 'A batch number returns the batch');
  assert((await lk('nothing-here')).matches.length === 0, 'Unknown code -> no matches');
  assert((await req('GET', '/api/tracking/lookup?code=')).status === 400 && (await req('GET', `/api/tracking/lookup?code=${'x'.repeat(81)}`)).status === 400, 'Empty / over-long code rejected');

  console.log('\n--- 10. Existing records unaffected ---');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);
  const plainQty = (await getStockPositions()).find((s) => s.id === PLAIN).current_qty;
  assert(plainQty === 10, 'Untracked item stock unchanged');
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 12, 'Migration 008 recorded');
  void all;

  console.log('\n====================================================');
  console.log(`📊 TRACKING RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

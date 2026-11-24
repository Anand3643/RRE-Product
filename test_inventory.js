process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Inventory intelligence: reorder suggestions, demand forecast, dead stock, godowns, supplier prices, movements.
 * Runs against a DISPOSABLE data directory.   npm run test:inventory
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_inventory_test_'));
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
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(7800 + Math.floor(Math.random() * 150), '127.0.0.1');
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
  const led = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const supA = await led('Elgi Equipments Spares Ltd'), supB = await led('Bharat Electric Motors Vendor'), cust = await led('Chennai Auto Components Pvt Ltd');
  const purAcc = await led('Purchase Account - Spares & Machines'), salesAcc = await led('Sales Account - Compressors');
  const item = async (name, oq = 0, orate = 0) => {
    await run('INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, opening_qty, opening_rate, opening_val) VALUES (?, 1, 1, ?, 18, ?, ?, ?)', [name, '84148011', oq, orate, oq * orate]);
    return (await get('SELECT id FROM stock_items WHERE name = ?', [name])).id;
  };
  const A = await item('T-Fast'), B = await item('T-Low'), C = await item('T-Out'), D = await item('T-Dead', 40, 100), E = await item('T-Slow'), F = await item('T-Return');
  let n = 0;
  const vch = async (type, date, party, itemId, qty, rate, godown = 1) => {
    const amt = qty * rate; n++;
    const buy = type === 'Purchase' || type === 'Credit Note' ? false : false; void buy;
    // Purchase: Dr purchase / Cr supplier.  Sales: Dr customer / Cr sales.  Credit Note: Dr sales / Cr customer.  Debit Note: Dr supplier / Cr purchase.
    const lines = {
      Purchase: [[purAcc, amt, 0], [party, 0, amt]], Sales: [[party, amt, 0], [salesAcc, 0, amt]],
      'Credit Note': [[salesAcc, amt, 0], [party, 0, amt]], 'Debit Note': [[party, amt, 0], [purAcc, 0, amt]]
    }[type];
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: `INV/${n}`, date, party_ledger_id: party,
      entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })), inventory: [{ stock_item_id: itemId, quantity: qty, rate, godown_id: godown }] } });
    if (!r.json?.success) throw new Error('setup failed: ' + r.raw);
  };
  // Item A: two suppliers, rising price from supplier A; sales concentrated recently
  await vch('Purchase', '2026-06-01', supA, A, 100, 50, 1);
  await vch('Purchase', '2026-07-01', supB, A, 100, 45, 2);
  await vch('Purchase', '2026-08-15', supA, A, 100, 55, 1);
  for (const [d, q] of [['2026-08-05', 30], ['2026-09-05', 30], ['2026-09-20', 30], ['2026-09-25', 10]]) await vch('Sales', d, cust, A, q, 80, 1);
  await vch('Debit Note', '2026-09-26', supB, A, 10, 45, 2); // purchase return: must NOT count as a purchase
  // Item B: low stock, bought into godown 1 but sold from godown 2
  await vch('Purchase', '2026-08-01', supA, B, 50, 20, 1);
  await vch('Sales', '2026-09-05', cust, B, 20, 30, 2); await vch('Sales', '2026-09-20', cust, B, 25, 30, 2);
  // Item E: slow mover
  await vch('Purchase', '2026-05-01', supA, E, 20, 10, 1); await vch('Sales', '2026-06-01', cust, E, 5, 15, 1);
  // Item F: sold then fully returned
  await vch('Purchase', '2026-08-01', supA, F, 50, 10, 1); await vch('Sales', '2026-09-10', cust, F, 20, 15, 1); await vch('Credit Note', '2026-09-12', cust, F, 20, 15, 1);
  await run('UPDATE stock_items SET reorder_level = 5 WHERE id = ?', [C]);

  const AS = 'as_of=2026-09-30';
  const get_ = async (p, token = admin) => (await req('GET', p, { token })).json;
  const mine = (rows) => rows.filter((r) => (r.name || r.item || '').startsWith('T-'));
  const counts0 = { v: (await get('SELECT COUNT(*) c FROM vouchers')).c, i: (await get('SELECT COUNT(*) c FROM inventory_entries')).c, q: (await get('SELECT ROUND(SUM(opening_qty),2) s FROM stock_items')).s };

  console.log('\n--- 1. Access & validation ---');
  assert((await req('GET', '/api/inventory/reorder', { token: null })).status === 401, 'Requires login');
  assert((await req('GET', `/api/inventory/reorder?${AS}`, { token: viewer })).status === 200, 'Viewer can read');
  assert((await req('GET', '/api/inventory/reorder?as_of=30-09-2026')).status === 400, 'Bad as_of date rejected');
  assert((await req('GET', '/api/inventory/movements/99999')).status === 404, 'Unknown item -> 404');
  assert((await req('GET', `/api/inventory/movements/${A}?from_date=bad`)).status === 400, 'Bad movement date rejected');
  const dflt = await get_('/api/inventory/dead-stock');
  assert(dflt.data.as_of === (await get('SELECT MAX(date) d FROM vouchers')).d, 'Default analysis date is the latest voucher date in the books', dflt.data.as_of);

  console.log('\n--- 2. Demand forecast ---');
  const dm = (await get_(`/api/inventory/demand?${AS}`)).data;
  const dA = dm.items.find((i) => i.item_id === A);
  assert(dA.current_qty === 190, 'T-Fast quantity on hand = 300 bought − 100 sold − 10 returned to supplier = 190', String(dA.current_qty));
  assert(dA.recent_30d_qty === 70 && dA.prior_60d_qty === 30 && dA.window_qty === 100 && dA.sale_transactions === 4, 'Recent 70, prior-60d 30, 90-day 100, 4 sale transactions', JSON.stringify(dA));
  assert(near(dA.avg_daily_weighted, (2 * 70 / 30 + 30 / 60) / 3, 0.01) && near(dA.avg_daily_simple, 100 / 90, 0.01), `Weighted daily demand ≈ 1.72 (recent weighs double); simple ≈ 1.11`, `${dA.avg_daily_weighted}/${dA.avg_daily_simple}`);
  assert(near(dA.forecast_qty, 51.7, 0.3) && dA.confidence === 'low', '30-day forecast ≈ 52 units, confidence "low" (4 sales)', `${dA.forecast_qty} ${dA.confidence}`);
  assert(dA.last_6_periods_30d.length === 6 && dA.last_6_periods_30d[5].qty === 70, 'Six 30-day history buckets; newest = 70');
  assert(near(dA.days_of_cover, 190 / dA.avg_daily_weighted, 0.2), 'Days of cover = stock ÷ daily demand');
  const dF = dm.items.find((i) => i.item_id === F);
  assert(dF.window_qty === 0 && dF.avg_daily_weighted === 0, 'A sale fully reversed by a Credit Note leaves zero net demand');
  const dC = dm.items.find((i) => i.item_id === C);
  assert(dC.confidence === 'none' && dC.forecast_qty === 0 && dC.days_of_cover === null, 'No sales => confidence "none", forecast 0, cover n/a');
  assert(dm.assumptions.length >= 3, 'Assumptions disclosed');
  const dm2 = (await get_(`/api/inventory/demand?${AS}&horizon_days=60&lookback_days=60`)).data;
  assert(dm2.horizon_days === 60 && dm2.lookback_days === 60, 'Horizon and lookback parameters honoured');

  console.log('\n--- 3. Supplier price comparison ---');
  const sp = (await get_(`/api/inventory/supplier-prices?item_id=${A}`)).data.items[0];
  const sa = sp.suppliers.find((s) => s.supplier.startsWith('Elgi')), sb = sp.suppliers.find((s) => s.supplier.startsWith('Bharat'));
  assert(sp.best_supplier.startsWith('Bharat') && sp.suppliers[0].supplier.startsWith('Bharat'), 'Cheapest recent rate ranks first (Bharat ₹45 vs Elgi ₹55)');
  assert(sa.purchases === 2 && sa.avg_rate === 52.5 && sa.last_rate === 55 && sa.trend === 'rising', 'Supplier A: 2 purchases, average ₹52.50, last ₹55, price rising');
  assert(sb.purchases === 1 && sb.total_qty === 100, 'Debit Note (purchase return) is not counted as a purchase');
  assert(sp.saving_per_unit_vs_dearest === 10, 'Saving vs dearest = ₹10/unit');
  const spAll = (await get_('/api/inventory/supplier-prices')).data;
  assert(spAll.items.find((i) => i.item_id === E).note?.includes('Only one supplier'), 'Single-supplier items say no comparison is possible');

  console.log('\n--- 4. Reorder suggestions ---');
  const ro = (await get_(`/api/inventory/reorder?${AS}`)).data;
  const rows = mine(ro.items);
  const rA = rows.find((r) => r.item_id === A), rB = rows.find((r) => r.item_id === B), rC = rows.find((r) => r.item_id === C), rD = rows.find((r) => r.item_id === D), rF = rows.find((r) => r.item_id === F);
  assert(rB.status === 'reorder_now' && rB.current_qty === 5 && rB.avg_daily_demand === 1, 'T-Low: 5 units left, demand 1/day => reorder now');
  assert(rB.suggested_order_qty === 46 && rB.suggested_supplier.name.startsWith('Elgi') && rB.estimated_cost === 920, 'Suggest 46 units (51 days of demand − 5 on hand) from Elgi at ₹20 = ₹920', JSON.stringify([rB.suggested_order_qty, rB.estimated_cost]));
  assert(rC.status === 'out_of_stock' && rC.suggested_order_qty === 10 && rC.suggested_supplier === null, 'T-Out: out of stock; falls back to 2× reorder level (10); no supplier history');
  assert(rA.status === 'ok' && rA.suggested_order_qty === 0, 'T-Fast: ample stock => no order');
  assert(rD.status === 'no_recent_demand' && rD.suggested_order_qty === 0 && rF.status === 'no_recent_demand', 'Items without net demand are not auto-ordered');
  const order = rows.map((r) => r.status);
  assert(order.indexOf('out_of_stock') < order.indexOf('reorder_now') && order.indexOf('reorder_now') < order.indexOf('ok'), 'Most urgent first (out of stock → reorder now → ok)');
  const roLead = (await get_(`/api/inventory/reorder?${AS}&lead_time_days=60&safety_days=0`)).data.items.find((r) => r.item_id === A);
  assert(roLead.status === 'ok' || roLead.status === 'reorder_now', 'Lead time / safety parameters accepted');
  const roLong = (await get_(`/api/inventory/reorder?${AS}&lead_time_days=150&safety_days=30`)).data.items.find((r) => r.item_id === A);
  assert(roLong.status === 'reorder_now' && roLong.suggested_order_qty > 0, 'A very long lead time turns T-Fast into "reorder now" (190 units < 180 days of demand)');
  assert(ro.assumptions.some((a) => /suggestions only/i.test(a)), 'States that nothing is ordered or posted');

  console.log('\n--- 5. Reorder level (the only write) ---');
  assert((await req('POST', `/api/inventory/items/${A}/reorder-level`, { token: viewer, body: { reorder_level: 250 } })).status === 403, 'Viewer cannot set reorder level');
  for (const bad of [-1, 'abc', null, 1e12]) assert((await req('POST', `/api/inventory/items/${A}/reorder-level`, { body: { reorder_level: bad } })).status === 400, `Rejected reorder_level=${bad}`);
  assert((await req('POST', '/api/inventory/items/99999/reorder-level', { body: { reorder_level: 5 } })).status === 404, 'Unknown item -> 404');
  assert((await req('POST', `/api/inventory/items/${A}/reorder-level`, { token: clerk, body: { reorder_level: 250 } })).status === 200, 'Data Entry can set reorder level');
  const rA2 = (await get_(`/api/inventory/reorder?${AS}`)).data.items.find((r) => r.item_id === A);
  assert(rA2.status === 'below_reorder_level' && rA2.suggested_order_qty === 310, 'Level 250 > 190 on hand => "below reorder level"; suggests restoring to 2× level (500 − 190 = 310)', JSON.stringify([rA2.status, rA2.suggested_order_qty]));
  const log = (await get_('/api/platform/activity-log?limit=20')).data;
  assert(log.some((l) => l.action === 'REORDER_LEVEL_SET' && l.username === 'dataentry'), 'Reorder-level change is in the activity log');
  const noti = (await get_('/api/platform/notifications')).data;
  assert(noti.some((x) => x.type === 'low_stock' && /T-Fast/.test(x.title)), 'The new level also drives the existing low-stock alert');
  await run('UPDATE stock_items SET reorder_level = 0 WHERE id = ?', [A]);

  console.log('\n--- 6. Dead / slow stock ---');
  const ds = (await get_(`/api/inventory/dead-stock?${AS}&days=90`)).data;
  const dd = mine(ds.items);
  const dD = dd.find((r) => r.item_id === D), dE = dd.find((r) => r.item_id === E);
  assert(dD && dD.category === 'never sold' && dD.value_locked === 4000 && dD.cost_per_unit === 100, 'T-Dead: never sold, ₹4,000 locked (40 × ₹100)');
  assert(dE && dE.category === 'slow-moving' && dE.days_since_last_sale === 121 && dE.current_qty === 15 && dE.value_locked === 150, 'T-Slow: last sale 121 days ago, 15 units × ₹10 = ₹150', JSON.stringify(dE));
  assert(!dd.some((r) => [A, B, C, F].includes(r.item_id)), 'Active, out-of-stock and returned-sale items are not listed');
  assert(ds.total_value_locked === ds.items.reduce((s, r) => s + r.value_locked, 0) && ds.items[0].value_locked >= ds.items[ds.items.length - 1].value_locked, 'Total = sum; sorted by value locked');
  const ds2 = mine((await get_(`/api/inventory/dead-stock?${AS}&days=200`)).data.items);
  assert(ds2.some((r) => r.item_id === D) && !ds2.some((r) => r.item_id === E), 'Threshold of 200 days drops T-Slow (121 days) but keeps never-sold T-Dead');

  console.log('\n--- 7. Godown-wise comparison ---');
  const gs = (await get_('/api/inventory/godown-stock')).data;
  const gA = gs.items.find((i) => i.item_id === A), gB = gs.items.find((i) => i.item_id === B), gD = gs.items.find((i) => i.item_id === D);
  const g1 = (x, id) => x.godowns.find((g) => g.godown_id === id).qty;
  assert(g1(gA, 1) === 100 && g1(gA, 2) === 90 && gA.total_qty === 190, 'T-Fast: godown 1 = 200 in − 100 sold = 100; godown 2 = 100 in − 10 returned = 90; total 190', JSON.stringify(gA.godowns));
  assert(g1(gB, 1) === 50 && g1(gB, 2) === -45 && gB.total_qty === 5 && gB.flags.some((f) => /Negative movement balance/.test(f)), 'T-Low: +50 in godown 1, −45 in godown 2 is flagged; total still 5');
  assert(gD.opening_unallocated === 40 && gD.total_qty === 40 && gD.flags.some((f) => /not assigned to any godown/.test(f)), 'Opening stock is reported as unallocated, with a flag');
  assert(gs.godowns.length >= 3, 'All active godowns listed');

  console.log('\n--- 8. Movement history ---');
  const mv = (await get_(`/api/inventory/movements/${A}`)).data;
  assert(mv.movements.length === 8 && mv.movements[0].balance === 100 && mv.closing_qty === 190, 'T-Fast history: 8 movements, running balance ends at 190', `${mv.movements.length} ${mv.closing_qty}`);
  assert(mv.movements.every((m, i) => i === 0 || mv.movements[i - 1].date <= m.date), 'Chronological order');
  assert(mv.totals.inward === 300 && mv.totals.outward === 110, 'Totals: 300 in, 110 out');
  const dn = mv.movements.find((m) => m.voucher_type === 'Debit Note');
  assert(dn && dn.direction === 'OUT' && dn.balance === 190, 'Debit Note shows as outward (purchase return)');
  const mw = (await get_(`/api/inventory/movements/${A}?from_date=2026-09-01&to_date=2026-09-22`)).data;
  assert(mw.brought_forward === 270 && mw.movements.length === 2 && mw.closing_qty === 210, 'Date window: brought forward 270 (300 bought − 30 sold by 31 Aug); two September sales; closing 210', JSON.stringify([mw.brought_forward, mw.movements.length, mw.closing_qty]));
  const mf = (await get_(`/api/inventory/movements/${F}`)).data;
  assert(mf.movements.map((m) => m.voucher_type).join() === 'Purchase,Sales,Credit Note' && mf.closing_qty === 50, 'Sales return (Credit Note) brings stock back in: 50 → 30 → 50');
  const md = (await get_(`/api/inventory/movements/${D}`)).data;
  assert(md.movements.length === 0 && md.closing_qty === 40, 'Item with only opening stock shows no movements and closing = opening');

  console.log('\n--- 9. Read-only guarantee ---');
  const counts1 = { v: (await get('SELECT COUNT(*) c FROM vouchers')).c, i: (await get('SELECT COUNT(*) c FROM inventory_entries')).c, q: (await get('SELECT ROUND(SUM(opening_qty),2) s FROM stock_items')).s };
  assert(counts1.v === counts0.v && counts1.i === counts0.i && counts1.q === counts0.q, 'No vouchers, inventory entries or opening quantities changed by any analysis call');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);

  console.log('\n====================================================');
  console.log(`📊 INVENTORY RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

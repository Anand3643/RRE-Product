process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Smart search and quick look: vouchers, ledgers, stock items; typo tolerance, amounts, safety, roles, speed.
 * Runs against a DISPOSABLE data directory.   npm run test:search
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_search_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(12300 + Math.floor(Math.random() * 100), '127.0.0.1');
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
  const S = async (q, token) => (await req('GET', '/api/search?q=' + encodeURIComponent(q), { token })).json.data;

  await run('DELETE FROM vouchers'); await run('UPDATE ledgers SET opening_balance = 0');
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const chennai = await L('Chennai Auto Components Pvt Ltd'), southern = await L('Southern Textiles & Spinning Mills'), elgi = await L('Elgi Equipments Spares Ltd');
  const salesAcc = await L('Sales Account - Compressors'), purAcc = await L('Purchase Account - Spares & Machines'), hdfc = await L('HDFC Bank Current A/c'), rent = await L('Office Rent');
  const post = async (type, no, date, party, lines, extra = {}) => {
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: no, date, party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c })), ...extra } });
    if (!r.json?.success) throw new Error('setup ' + r.raw);
    return r.json.id;
  };
  const sv = await post('Sales', 'INV-2026-001', '2026-05-10', chennai, [[chennai, 123456.78, 0], [salesAcc, 0, 123456.78]], { narration: 'Compressor spares for Chennai plant', reference_no: 'PO-7781' });
  const pv = await post('Purchase', 'PUR-001', '2026-05-12', elgi, [[purAcc, 40000, 0], [elgi, 0, 40000]], { narration: 'Quarterly spares' });
  await post('Payment', 'PAY-001', '2026-05-15', null, [[rent, 12000, 0], [hdfc, 0, 12000]], { narration: '100% advance rent (May)' });
  await post('Sales', 'INV-2026-002', '2026-06-01', southern, [[southern, 5000, 0], [salesAcc, 0, 5000]]);
  const uom = (await get('SELECT id FROM units_of_measure LIMIT 1')).id, grp = (await get('SELECT id FROM stock_groups LIMIT 1')).id;
  await run(`INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, opening_qty, opening_rate, opening_val, reorder_level) VALUES ('Screw Compressor Airend 22kW', ?, ?, '84148011', 10, 50000, 500000, 12)`, [grp, uom]);
  const itemId = (await get(`SELECT id FROM stock_items WHERE name LIKE 'Screw Compressor%'`)).id;
  await run(`INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount) VALUES (?, ?, 'OUT', 2, 61728.39, 123456.78)`, [sv, itemId]);

  console.log('\n--- 1. Access and input ---');
  assert((await req('GET', '/api/search?q=chennai', { token: null })).status === 401, 'Search needs a login');
  assert((await S('a')).hint && (await S('a')).vouchers.length === 0 && (await S('')).hint, 'Too-short input returns a hint, not everything');
  assert((await req('GET', '/api/search?q=' + 'x'.repeat(100))).status === 400, 'Very long input is refused');
  assert((await req('GET', '/api/search/voucher/abc')).status === 400 && (await req('GET', '/api/search/voucher/99999')).status === 404 && (await req('GET', '/api/search/ledger/99999')).status === 404 && (await req('GET', '/api/search/item/99999')).status === 404, 'Bad or unknown ids give clear errors');

  console.log('\n--- 2. Vouchers ---');
  let r = await S('INV-2026-001');
  assert(r.vouchers.length === 1 && r.vouchers[0].id === sv && r.vouchers[0].party === 'Chennai Auto Components Pvt Ltd', 'Found by voucher number (with party name)');
  assert((await S('po-7781')).vouchers[0]?.id === sv, 'Found by reference number, any case');
  assert((await S('quarterly spares')).vouchers[0]?.id === pv, 'Found by narration words');
  assert((await S('chennai spares')).vouchers.some((v) => v.id === sv), 'Several words must all match (party + narration)');
  assert((await S('chennai quarterly')).vouchers.length === 0, 'Words that never occur together do not match');
  r = await S('123456.78');
  assert(r.amount_search && r.vouchers[0]?.id === sv, 'Found by exact amount');
  assert((await S('₹1,23,456.78')).vouchers[0]?.id === sv && (await S('123,456.78')).vouchers[0]?.id === sv, 'Amounts with rupee sign and Indian or Western commas work');
  assert((await S('40000')).vouchers.some((v) => v.id === pv), 'An amount on a ledger line is found too (not just the voucher total)');
  assert((await S('2026-06-01')).vouchers.some((v) => v.voucher_no === 'INV-2026-002'), 'Found by date');
  r = await S('sales');
  assert(r.vouchers.length === 2 && r.vouchers[0].date >= r.vouchers[1].date, 'By type; newest first');
  assert((await S('100%')).vouchers.length === 1 && (await S('%%')).vouchers.length === 0 && (await S('a_b')).vouchers.length === 0, 'Percent and underscore are literal characters, not wildcards');
  const inj = await S(`x' OR 1=1 --`);
  assert(inj.vouchers.length === 0 && (await get('SELECT COUNT(*) c FROM vouchers')).c === 4, 'Quote characters are harmless (nothing matched, nothing changed)');

  console.log('\n--- 3. Ledgers, parties and typos ---');
  assert((await S('chennai')).ledgers[0].name === 'Chennai Auto Components Pvt Ltd', 'Party found by part of its name');
  assert((await S('chenai auto')).ledgers[0]?.name === 'Chennai Auto Components Pvt Ltd', 'One missing letter ("chenai") still finds it');
  assert((await S('southren textiles')).ledgers[0]?.name === 'Southern Textiles & Spinning Mills', 'Swapped letters ("southren") still find it');
  assert((await S('textiles southern')).ledgers[0]?.name === 'Southern Textiles & Spinning Mills', 'Word order does not matter');
  assert((await S('ELGI')).ledgers.some((l) => l.name.startsWith('Elgi')), 'Case does not matter');
  assert((await S('qzxwv')).ledgers.length === 0, 'Nonsense finds nothing');
  assert((await S('cash')).ledgers.some((l) => l.name === 'Cash'), 'Exact short names work');
  const gst = (await get(`SELECT id, gstin FROM ledgers WHERE gstin IS NOT NULL AND gstin != '' LIMIT 1`));
  if (gst) assert((await S(gst.gstin.slice(0, 10))).ledgers.some((l) => l.id === gst.id), 'Found by (part of) GSTIN');
  else assert(true, 'No ledger with a GSTIN in this data');

  console.log('\n--- 4. Stock items ---');
  assert((await S('screw compresor')).items[0]?.id === itemId, 'Item found despite a typo');
  assert((await S('84148')).items[0]?.id === itemId, 'Item found by HSN prefix');
  assert((await S('airend 22')).items[0]?.id === itemId, 'Item found by part of its name');

  console.log('\n--- 5. Quick look ---');
  const vl = (await req('GET', `/api/search/voucher/${sv}`)).json.data;
  assert(vl.voucher_no === 'INV-2026-001' && vl.lines.length === 2 && vl.stock.length === 1 && vl.stock[0].name.startsWith('Screw') && vl.party === 'Chennai Auto Components Pvt Ltd' && vl.total_amount === 123456.78, 'Voucher preview: header, ledger lines, stock lines');
  const ll = (await req('GET', `/api/search/ledger/${chennai}`)).json.data;
  assert(ll.balances_visible && ll.closing.amount === 123456.78 && ll.closing.type === 'Dr' && ll.recent.length === 1 && ll.group, 'Ledger preview (Owner): closing balance, recent entries');
  const il = (await req('GET', `/api/search/item/${itemId}`)).json.data;
  assert(il.quantity_on_hand === 8 && il.low === true && il.value_visible && il.rate === 50000 && il.value === 400000, 'Item preview (Owner): quantity 8, flagged low (reorder 12), value at average rate');
  const llc = (await req('GET', `/api/search/ledger/${chennai}`, { token: clerk })).json.data;
  assert(llc.balances_visible === false && llc.closing === undefined && llc.opening === undefined && llc.recent.every((x) => x.debit_amount === undefined && x.credit_amount === undefined), 'Data Entry does not see balances or amounts (same rule as financial reports)');
  const ilc = (await req('GET', `/api/search/item/${itemId}`, { token: clerk })).json.data;
  assert(ilc.quantity_on_hand === 8 && ilc.value === undefined && ilc.rate === undefined, 'Data Entry sees stock quantity but not valuation');

  console.log('\n--- 6. Speed and safety ---');
  const ins = await Promise.all([]);
  await run('BEGIN');
  for (let i = 0; i < 5000; i++) await run(`INSERT INTO vouchers (voucher_type, voucher_no, date, total_amount, narration, party_ledger_id) VALUES ('Sales', ?, '2026-07-01', ?, ?, ?)`, [`BULK-${i}`, 100 + i, `bulk narration ${i}`, southern]);
  await run('COMMIT');
  const t0 = Date.now(); const big = await S('bulk narration 4999'); const ms = Date.now() - t0;
  assert(big.vouchers.length === 1 && ms < 800, `Search across 5,000+ vouchers takes ${ms} ms`);
  const t1 = Date.now(); await S('southern'); assert(Date.now() - t1 < 800, 'Party search stays fast with many vouchers');
  assert((await S('bulk')).vouchers.length === 8, 'Results are capped');
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c === 5004, 'Searching changed nothing');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

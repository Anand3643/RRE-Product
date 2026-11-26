process.env.RRE_LEGACY_TOKENS = '1';
process.env.RRE_ENFORCE_AUTH = '1';
/**
 * Day Book, ledgers and voucher alteration / cancellation: every voucher type flows into the Day Book and the ledgers from the ONE set of
 * voucher rows; altering a voucher changes it everywhere at once (no duplicate, audit trail before/after); cancelling posts a reversal;
 * filters, totals, opening/closing balances; conflicting alterations; permissions; data kept after a restart.
 * Runs on a DISPOSABLE data directory.   node test_daybook.js        PostgreSQL:  npm run test:pg -- test_daybook.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_daybook_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const db = require('./core/db');
const { initDb, get, all, run } = db;
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function main() {
  await initDb(); await runMigrations();
  await run('DELETE FROM approval_rules').catch(() => {});
  const srv = await startServer(14100 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const owner = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = (method, p, { token = owner, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, json, raw: b, headers: res.headers }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  const daybook = async (qs = '') => (await req('GET', '/api/reports/daybook?summary=1' + (qs ? '&' + qs : ''))).json;
  const voucherCount = async () => Number((await get('SELECT COUNT(*) AS n FROM vouchers')).n);
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const balance = async (id) => { const l = await get('SELECT opening_balance ob, opening_balance_type t FROM ledgers WHERE id = ?', [id]); const m = await get('SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS m FROM ledger_entries WHERE ledger_id = ?', [id]); return r2((l.t === 'Cr' ? -1 : 1) * Number(l.ob || 0) + Number(m.m)); };
  const unbalanced = async () => (await all('SELECT v.id FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0')).length;

  console.log('\n--- TEST 1-2: a ledger master is created; it does NOT create a Day Book transaction ---');
  const before = await voucherCount(), dbBefore = (await daybook()).summary.vouchers;
  const mk = await req('POST', '/api/masters/ledgers', { body: { name: 'DB Test Customer', group_id: await grp('Sundry Debtors'), opening_balance: 5000, opening_balance_type: 'Dr' } });
  const cust = mk.json && mk.json.id;
  assert(mk.status === 200 && cust && (await req('GET', '/api/masters/ledgers')).json.data.some((l) => l.id === cust), 'a new ledger (with an opening balance of ₹5,000) appears in the ledger list');
  assert(await voucherCount() === before && (await daybook()).summary.vouchers === dbBefore, 'creating the ledger master alone adds no voucher and no Day Book transaction');
  assert(await balance(cust) === 5000, 'its opening balance is the ledger\'s balance (₹5,000 Dr), without a fake voucher');
  const ob = await daybook();
  const obRow = (ob.openings || []).find((o) => o.ledger_id === cust);
  assert(obRow && obRow.debit_amount === 5000 && obRow.credit_amount === 0 && obRow.ledger_name === 'DB Test Customer' && /^\d{4}-\d{2}-\d{2}$/.test(obRow.date),
    'the Day Book shows it as an "Opening Balance" entry: DB Test Customer, Dr ₹5,000, dated the day it was entered', JSON.stringify(obRow));
  const zero = (await req('POST', '/api/masters/ledgers', { body: { name: 'DB No Opening', group_id: await grp('Sundry Debtors') } })).json.id;
  assert(!(await daybook()).openings.some((o) => o.ledger_id === zero), 'a ledger with no opening balance adds nothing to the Day Book');
  assert(ob.summary.openings && ob.summary.openings.total_debit >= 5000 && typeof ob.summary.openings.difference === 'number', 'the Day Book summary carries the opening-balance totals and their difference');
  assert((await daybook('type=Opening%20Balance')).data.length === 0 && (await daybook('type=Opening%20Balance')).openings.some((o) => o.ledger_id === cust), 'type filter "Opening Balance" shows only opening balances');
  assert(!(await daybook('type=Sales')).openings, 'other type filters do not include opening balances');
  const sales = (await req('POST', '/api/masters/ledgers', { body: { name: 'DB Sales', group_id: await grp('Sales Accounts') } })).json.id;
  const rent = (await req('POST', '/api/masters/ledgers', { body: { name: 'DB Rent', group_id: await grp('Indirect Expenses') } })).json.id;
  const supp = (await req('POST', '/api/masters/ledgers', { body: { name: 'DB Supplier', group_id: await grp('Sundry Creditors') } })).json.id;
  const purch = (await req('POST', '/api/masters/ledgers', { body: { name: 'DB Purchases', group_id: await grp('Purchase Accounts') } })).json.id;
  const cash = await L('Cash'), outC = await L('Output CGST 9%'), outS = await L('Output SGST 9%');
  const bank = (await get("SELECT id FROM ledgers WHERE group_id = (SELECT id FROM account_groups WHERE name = 'Bank Accounts') ORDER BY id LIMIT 1")).id;

  console.log('\n--- TEST 3-4, 9: every voucher type appears in the Day Book with its ledger lines ---');
  const post = (b, token = owner) => req('POST', '/api/vouchers', { token, body: b });
  const s1 = await post({ voucher_type: 'Sales', date: '2026-07-01', narration: 'DB sale one', party_ledger_id: cust, entries: [
    { ledger_id: cust, debit_amount: 1180, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: 1000 }, { ledger_id: outC, debit_amount: 0, credit_amount: 90 }, { ledger_id: outS, debit_amount: 0, credit_amount: 90 }],
    bill_allocations: [{ ledger_id: cust, bill_type: 'New Ref', amount: 1180 }] });
  const p1 = await post({ voucher_type: 'Payment', date: '2026-07-02', narration: 'DB July rent', entries: [{ ledger_id: rent, debit_amount: 15000, credit_amount: 0 }, { ledger_id: bank, debit_amount: 0, credit_amount: 15000 }] });
  const pu = await post({ voucher_type: 'Purchase', date: '2026-07-02', narration: 'DB purchase', party_ledger_id: supp, entries: [{ ledger_id: purch, debit_amount: 800, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 800 }] });
  const rc = await post({ voucher_type: 'Receipt', date: '2026-07-03', narration: 'DB receipt', party_ledger_id: cust, entries: [{ ledger_id: cash, debit_amount: 500, credit_amount: 0 }, { ledger_id: cust, debit_amount: 0, credit_amount: 500 }] });
  const co = await post({ voucher_type: 'Contra', date: '2026-07-03', narration: 'DB cash to bank', entries: [{ ledger_id: bank, debit_amount: 300, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 300 }] });
  const jo = await post({ voucher_type: 'Journal', date: '2026-07-04', narration: 'DB journal', entries: [{ ledger_id: rent, debit_amount: 100, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 100 }] });
  const cn = await post({ voucher_type: 'Credit Note', date: '2026-07-04', narration: 'DB return in', party_ledger_id: cust, entries: [{ ledger_id: sales, debit_amount: 50, credit_amount: 0 }, { ledger_id: cust, debit_amount: 0, credit_amount: 50 }] });
  const dn = await post({ voucher_type: 'Debit Note', date: '2026-07-04', narration: 'DB return out', party_ledger_id: supp, entries: [{ ledger_id: supp, debit_amount: 40, credit_amount: 0 }, { ledger_id: purch, debit_amount: 0, credit_amount: 40 }] });
  const all8 = [s1, p1, pu, rc, co, jo, cn, dn];
  assert(all8.every((x) => x.status === 200), 'Sales, Payment, Purchase, Receipt, Contra, Journal, Credit Note and Debit Note are saved', all8.map((x) => x.status).join(','));
  const book = await daybook('from_date=2026-07-01&to_date=2026-07-31');
  const byId = new Map(book.data.map((v) => [v.id, v]));
  assert(all8.every((x) => byId.has(x.json.id)), 'all 8 appear in the Day Book at once (no separate posting step)');
  const sv = byId.get(s1.json.id);
  assert(sv && sv.date === '2026-07-01' && sv.voucher_no === s1.json.voucher_no && sv.narration === 'DB sale one' && sv.entries.length === 4
    && sv.entries.some((e) => e.ledger_name === 'DB Test Customer' && Number(e.debit_amount) === 1180) && sv.entries.some((e) => e.ledger_name === 'DB Sales' && Number(e.credit_amount) === 1000),
    'the sale shows date, voucher number, narration and each ledger with its debit / credit');
  const pv = byId.get(p1.json.id);
  assert(pv && pv.entries.some((e) => e.ledger_name === 'DB Rent' && Number(e.debit_amount) === 15000) && pv.entries.some((e) => e.ledger_id === bank && Number(e.credit_amount) === 15000), 'the payment shows Dr Rent ₹15,000 / Cr Bank ₹15,000');
  assert(book.data.every((v) => r2(v.entries.reduce((t, e) => t + Number(e.debit_amount), 0)) === r2(v.entries.reduce((t, e) => t + Number(e.credit_amount), 0))) && await unbalanced() === 0, 'every voucher in the Day Book balances (debits = credits)');
  assert(r2(book.summary.total_debit) === r2(book.summary.total_credit) && book.summary.vouchers === 8, `period totals: ${book.summary.vouchers} vouchers, Dr ₹${book.summary.total_debit} = Cr ₹${book.summary.total_credit}`);
  assert(await balance(cust) === r2(5000 + 1180 - 500 - 50), 'the customer ledger balance follows the vouchers (5,000 + 1,180 − 500 − 50 = 5,630)');

  console.log('\n--- Day Book filters, ledger opening / closing ---');
  const onlyPay = await daybook('type=Payment&from_date=2026-07-01');
  assert(onlyPay.data.length >= 1 && onlyPay.data.every((v) => v.voucher_type === 'Payment'), 'filter by voucher type');
  const led = await daybook(`ledger_id=${cust}&from_date=2026-07-02&to_date=2026-07-31`);
  assert(led.data.every((v) => v.entries.some((e) => e.ledger_id === cust)) && led.summary.ledger && led.summary.ledger.opening === 6180 && led.summary.ledger.closing === 5630,
    `ledger filter with opening (₹6,180 = 5,000 + July 1 sale) and closing (₹5,630) balance`, JSON.stringify(led.summary && led.summary.ledger));
  const search = await daybook('q=July%20rent');
  assert(search.data.length === 1 && search.data[0].id === p1.json.id, 'search by narration finds the rent payment');
  const search2 = await daybook('q=DB%20Supplier&from_date=2026-07-01');
  assert(search2.data.length === 3, 'search by ledger name finds every voucher touching that ledger (purchase, journal, debit note)', String(search2.data.length));
  const day = await daybook('from_date=2026-07-02&to_date=2026-07-02');
  assert(day.data.length === 2 && day.summary.total_debit === 15800, 'one day: 2 vouchers, daily total Dr ₹15,800');

  console.log('\n--- TEST 5-8: altering a voucher updates the Day Book, the ledgers and the audit log; no duplicate ---');
  const n0 = await voucherCount();
  const open1 = (await req('GET', `/api/vouchers/${s1.json.id}`)).json.data;
  assert(Number.isInteger(open1.row_version), 'the voucher carries a version number', String(open1.row_version));
  const alter = (id, b, ver, token = owner) => req('PUT', `/api/vouchers/${id}`, { token, body: b, headers: ver != null ? { 'X-Row-Version': String(ver) } : {} });
  const newSale = { voucher_type: 'Sales', date: '2026-07-01', narration: 'DB sale one (corrected)', party_ledger_id: cust, entries: [
    { ledger_id: cust, debit_amount: 2360, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: 2000 }, { ledger_id: outC, debit_amount: 0, credit_amount: 180 }, { ledger_id: outS, debit_amount: 0, credit_amount: 180 }] };
  const a1 = await alter(s1.json.id, newSale, open1.row_version);
  assert(a1.status === 200 && a1.json.id === s1.json.id && a1.json.voucher_no === s1.json.voucher_no && a1.json.total_amount === 2360, 'the sale is altered from ₹1,180 to ₹2,360 (same voucher, same number)', a1.raw.slice(0, 200));
  assert(await voucherCount() === n0, 'no duplicate: the number of vouchers is unchanged');
  const after1 = (await daybook('from_date=2026-07-01&to_date=2026-07-01')).data.find((v) => v.id === s1.json.id);
  assert(after1 && after1.narration === 'DB sale one (corrected)' && after1.entries.length === 4 && after1.entries.some((e) => e.ledger_id === cust && Number(e.debit_amount) === 2360), 'the Day Book shows the altered amounts and narration');
  assert(await balance(cust) === r2(5000 + 2360 - 500 - 50) && await unbalanced() === 0, 'the customer ledger closing balance follows (₹6,810) and everything still balances');
  const billNow = await get("SELECT amount FROM bill_allocations WHERE voucher_id = ? AND bill_type = 'New Ref'", [s1.json.id]);
  assert(billNow && Number(billNow.amount) === 2360, 'the invoice\'s outstanding bill follows the new amount');
  const audit = await get("SELECT details FROM activity_log WHERE action = 'VOUCHER_ALTER' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(s1.json.id)]);
  const ad = audit && JSON.parse(audit.details);
  assert(ad && ad.before.voucher.total_amount == 1180 && ad.after.voucher.total_amount == 2360 && ad.before.entries.length === 4, 'the audit log keeps the complete voucher before (₹1,180) and after (₹2,360)');
  const tb = (await req('GET', '/api/reports/trial-balance')).json;
  assert(JSON.stringify(tb).length > 50 && (await get('SELECT ROUND(SUM(debit_amount) - SUM(credit_amount), 2) d FROM ledger_entries')).d == 0, 'the trial balance (same rows) still balances');

  console.log('\n--- conflicting alterations and permissions ---');
  const stale = await alter(s1.json.id, { ...newSale, narration: 'from an old copy' }, open1.row_version);
  assert(stale.status === 409 && stale.json.code === 'ROW_CONFLICT', 'an alteration made from an older copy is refused (409) and changes nothing', String(stale.status));
  const cur = (await req('GET', `/api/vouchers/${p1.json.id}`)).json.data.row_version;
  const payB = (n) => ({ voucher_type: 'Payment', date: '2026-07-02', narration: n, entries: [{ ledger_id: rent, debit_amount: 16000, credit_amount: 0 }, { ledger_id: bank, debit_amount: 0, credit_amount: 16000 }] });
  const race = await Promise.all([alter(p1.json.id, payB('device A'), cur), alter(p1.json.id, payB('device B'), cur, acc)]);
  assert(race.map((x) => x.status).sort().join(',') === '200,409', 'two users alter the same voucher at the same moment: one is saved, the other gets a conflict', race.map((x) => x.status).join(','));
  assert((await alter(jo.json.id, { voucher_type: 'Journal', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 120, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 120 }] }, null, clerk)).status === 403, 'Data Entry may not alter posted vouchers (403)');
  assert((await alter(jo.json.id, { voucher_type: 'Journal', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 120, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 120 }] }, null, viewer)).status === 403, 'a Viewer may not alter (403)');
  assert((await alter(jo.json.id, { voucher_type: 'Journal', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 120, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 110 }] })).status === 400, 'an unbalanced alteration is refused (400): debits must equal credits');
  assert((await alter(jo.json.id, { voucher_type: 'Payment', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 120, credit_amount: 0 }, { ledger_id: bank, debit_amount: 0, credit_amount: 120 }] })).status === 400, 'the voucher type cannot be changed by an alteration');
  assert((await req('GET', '/api/reports/daybook', { token: clerk })).status !== 401 && (await req('GET', '/api/reports/daybook', { token: viewer })).status === 200, 'employees can view the Day Book (permitted read)');
  // the bill of the sale is settled by a receipt -> its amount may not change any more
  await post({ voucher_type: 'Receipt', date: '2026-07-05', party_ledger_id: cust, entries: [{ ledger_id: cash, debit_amount: 2360, credit_amount: 0 }, { ledger_id: cust, debit_amount: 0, credit_amount: 2360 }],
    bill_allocations: [{ ledger_id: cust, bill_type: 'Agst Ref', bill_ref: (await get("SELECT bill_ref FROM bill_allocations WHERE voucher_id = ?", [s1.json.id])).bill_ref, amount: 2360 }] });
  const v2 = (await req('GET', `/api/vouchers/${s1.json.id}`)).json.data.row_version;
  const settled = await alter(s1.json.id, { ...newSale, entries: [{ ledger_id: cust, debit_amount: 1180, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: 1000 }, { ledger_id: outC, debit_amount: 0, credit_amount: 90 }, { ledger_id: outS, debit_amount: 0, credit_amount: 90 }] }, v2);
  assert(settled.status === 409 && /settled/.test(settled.json.error), 'a bill already settled by a receipt keeps its amount: the alteration is refused with the reason', settled.raw.slice(0, 160));
  const narrOnly = await alter(s1.json.id, { ...newSale, narration: 'narration only' }, v2);
  assert(narrOnly.status === 200, 'changing only the narration of that settled invoice is allowed');

  console.log('\n--- TEST 6: cancelling posts a reversal (nothing silently deleted) ---');
  const n1 = await voucherCount(), rentBefore = await balance(rent);
  const cv = await req('POST', `/api/vouchers/${jo.json.id}/reverse`, { body: { narration: 'Cancellation of journal' } });
  assert(cv.status === 200 && cv.json.voucher_type === 'Journal' && await voucherCount() === n1 + 1, 'cancelling the journal posts a reversal journal; the original stays on record', cv.raw.slice(0, 160));
  assert(await balance(rent) === r2(rentBefore - 100), 'the reversal undoes the journal\'s effect on the ledger (Rent −₹100)');
  const both = (await daybook('q=' + encodeURIComponent(jo.json.voucher_no))).data;
  assert(both.length === 2 && both.some((v) => v.id === jo.json.id) && both.some((v) => v.reference_no === `Reversal of ${jo.json.voucher_no}`), 'the Day Book shows the original and its reversal');
  assert((await alter(jo.json.id, { voucher_type: 'Journal', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 1, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 1 }] })).status === 409, 'a cancelled voucher cannot be altered any more');
  assert((await alter(cv.json.id, { voucher_type: 'Journal', date: '2026-07-04', entries: [{ ledger_id: rent, debit_amount: 1, credit_amount: 0 }, { ledger_id: supp, debit_amount: 0, credit_amount: 1 }] })).status === 409, 'the reversal entry itself cannot be altered');
  assert((await req('POST', `/api/vouchers/${jo.json.id}/reverse`)).status === 409, 'a voucher can be cancelled only once');
  assert(await unbalanced() === 0, 'all vouchers still balance');

  console.log('\n--- stock: altering an invoice moves the stock with it ---');
  const sg = (await get('SELECT id FROM stock_groups ORDER BY id LIMIT 1')).id, uom = (await get('SELECT id FROM units_of_measure ORDER BY id LIMIT 1')).id;
  const item = (await run("INSERT INTO stock_items (name, stock_group_id, uom_id, gst_rate, opening_qty, opening_rate, opening_val) VALUES ('DB Widget', ?, ?, 18, 10, 100, 1000)", [sg, uom])).lastID;
  const onHand = async () => Number((await get("SELECT s.opening_qty + COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) FROM inventory_entries WHERE stock_item_id = s.id), 0) q FROM stock_items s WHERE s.id = ?", [item])).q);
  const saleItems = (q) => ({ voucher_type: 'Sales', date: '2026-07-06', party_ledger_id: cust, entries: [{ ledger_id: cust, debit_amount: q * 150, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: q * 150 }], inventory: [{ stock_item_id: item, quantity: q, rate: 150, amount: q * 150, godown_id: 1 }] });
  const si = await post(saleItems(3));
  assert(si.status === 200 && await onHand() === 7, 'a sale of 3 leaves 7 in stock');
  const siv = (await req('GET', `/api/vouchers/${si.json.id}`)).json.data.row_version;
  const si2 = await alter(si.json.id, saleItems(5), siv);
  assert(si2.status === 200 && await onHand() === 5 && (await all('SELECT id FROM inventory_entries WHERE voucher_id = ?', [si.json.id])).length === 1, 'altered to 5: stock is 5 (the old stock line replaced, not doubled)');
  const keep = await alter(si.json.id, { voucher_type: 'Sales', date: '2026-07-06', narration: 'Dr/Cr only', party_ledger_id: cust, entries: saleItems(5).entries }, (await req('GET', `/api/vouchers/${si.json.id}`)).json.data.row_version);
  assert(keep.status === 200 && await onHand() === 5, 'an alteration that sends only the Dr / Cr lines keeps the existing stock lines');

  console.log('\n--- other devices are told; data survives a restart ---');
  const events = []; const stream = http.request(base + '/api/events', { headers: { Authorization: 'Bearer ' + acc, 'X-RRE-Client': 'other-device' } }, (res) => res.on('data', (c) => events.push(String(c))));
  stream.end(); await sleep(300);
  const v3 = (await req('GET', `/api/vouchers/${p1.json.id}`)).json.data.row_version;
  await alter(p1.json.id, payB('told live'), v3);
  await sleep(500); stream.destroy();
  assert(events.join('').includes('"area":"vouchers"'), 'another open device is told immediately that vouchers changed (its Day Book reloads)');
  if (db.isPostgres()) {
    const { Client } = require('pg'); const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    const r = (await c.query("SELECT narration FROM rre.vouchers WHERE company_no = $1 AND id = $2", [String(db.getCompanyNumber()), p1.json.id])).rows[0]; await c.end();
    assert(r && r.narration === 'told live', 'a new database connection (as after a restart) reads the altered voucher');
  } else {
    const sqlite3 = require('sqlite3'); const d = new sqlite3.Database(path.join(tmp, 'company.db'), sqlite3.OPEN_READONLY);
    const r = await new Promise((res, rej) => d.get('SELECT narration FROM vouchers WHERE id = ?', [p1.json.id], (e, x) => (e ? rej(e) : res(x)))); d.close();
    assert(r && r.narration === 'told live', 'a separate connection to the database file (as after a restart) reads the altered voucher');
  }

  console.log(`\nDay Book: ${passed} passed, ${failed} failed  (database: ${db.isPostgres() ? 'PostgreSQL' : 'SQLite'})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

process.env.RRE_LEGACY_TOKENS = '1';
process.env.RRE_ENFORCE_AUTH = '1';
/**
 * Accounting, inventory, concurrency and security integrity suite - through the real HTTP API, on SQLite or PostgreSQL
 * (npm run test:pg -- test_integrity.js). DISPOSABLE copy of the company.
 *   node test_integrity.js
 * 1. double-entry rules  2. every voucher type, GST, reports agree with the ledger  3. reversal / audited delete
 * 4. inventory (returns, transfers, adjustments, rollback, negative-stock policy)  5. many users at the same moment
 * 6. permissions, sessions, role escalation
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RRE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_integrity_test_'));
process.env.RRE_INVENTORY_SEED = '0'; process.env.RRE_BRIDGE_AUTO = '0';

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken, hashPassword } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}${detail ? ' (' + detail + ')' : ''}`); failed++; } }
const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(14100 + Math.floor(Math.random() * 90), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r, h) => createSessionToken({ id, username: u, role: r }, h);
  const owner = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer');
  const req = async (method, p, { token = owner, body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const L = async (name) => (await get('SELECT id FROM ledgers WHERE name = ?', [name])).id;
  const group = async (name) => (await get('SELECT id FROM account_groups WHERE name = ?', [name])).id;
  const mkLedger = async (name, grp) => (await run('INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES (?, ?, 0, ?)', [name, await group(grp), 'Dr'])).lastID;
  const cash = await L('Cash'), bank = await L('HDFC Bank Current A/c'), outC = await L('Output CGST 9%'), outS = await L('Output SGST 9%'), inC = await L('Input CGST 9%'), inS = await L('Input SGST 9%');
  const sales = await mkLedger('IT Sales', 'Sales Accounts'), purchase = await mkLedger('IT Purchases', 'Purchase Accounts'), rent = await mkLedger('IT Rent', 'Indirect Expenses');
  const debtor = await mkLedger('IT Customer', 'Sundry Debtors'), creditor = await mkLedger('IT Supplier', 'Sundry Creditors');
  const uom = (await get('SELECT id FROM units_of_measure ORDER BY id LIMIT 1')).id, sg = (await get('SELECT id FROM stock_groups ORDER BY id LIMIT 1')).id;
  const item = (await run("INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, opening_qty, opening_rate, opening_val) VALUES ('IT Widget', ?, ?, '8414', 18, 0, 0, 0)", [sg, uom])).lastID;
  const onHand = async (id = item) => Number((await get("SELECT s.opening_qty + COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) FROM inventory_entries WHERE stock_item_id = s.id), 0) AS q FROM stock_items s WHERE s.id = ?", [id])).q);
  const ledgerTotals = async () => { const r = await get('SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2) AS d, ROUND(COALESCE(SUM(credit_amount), 0), 2) AS c FROM ledger_entries'); return { d: Number(r.d), c: Number(r.c) }; };
  const unbalancedVouchers = async () => (await all('SELECT v.id FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0')).length;
  const post = (body, opts = {}) => req('POST', '/api/vouchers', { body, ...opts });
  const sale = (qty, extra = {}) => post({ voucher_type: 'Sales', date: '2026-06-10', party_ledger_id: debtor, entries: [
    { ledger_id: debtor, debit_amount: r2(qty * 118), credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: r2(qty * 100) },
    { ledger_id: outC, debit_amount: 0, credit_amount: r2(qty * 9) }, { ledger_id: outS, debit_amount: 0, credit_amount: r2(qty * 9) }],
  inventory: [{ stock_item_id: item, quantity: qty, rate: 100, amount: qty * 100, godown_id: 1 }], ...extra });
  const purchaseV = (qty, extra = {}) => post({ voucher_type: 'Purchase', date: '2026-06-09', party_ledger_id: creditor, entries: [
    { ledger_id: purchase, debit_amount: r2(qty * 80), credit_amount: 0 }, { ledger_id: inC, debit_amount: r2(qty * 7.2), credit_amount: 0 },
    { ledger_id: inS, debit_amount: r2(qty * 7.2), credit_amount: 0 }, { ledger_id: creditor, debit_amount: 0, credit_amount: r2(qty * 94.4) }],
  inventory: [{ stock_item_id: item, quantity: qty, rate: 80, amount: qty * 80, godown_id: 1 }], ...extra });

  const stocked = await purchaseV(100); // the widget's first 100 units arrive through a real purchase (books stay balanced)
  if (stocked.status !== 200) throw new Error('setup purchase failed: ' + JSON.stringify(stocked.json));

  console.log('\n--- 1. Double-entry rules (enforced by the server) ---');
  const v0 = (await get('SELECT COUNT(*) AS n FROM vouchers')).n, e0 = (await get('SELECT COUNT(*) AS n FROM ledger_entries')).n;
  const bad = [
    ['unbalanced by one paisa', [{ ledger_id: cash, debit_amount: 100, credit_amount: 0 }, { ledger_id: rent, debit_amount: 0, credit_amount: 99.99 }]],
    ['a line with both debit and credit', [{ ledger_id: cash, debit_amount: 100, credit_amount: 100 }, { ledger_id: rent, debit_amount: 0, credit_amount: 0 }]],
    ['a negative amount', [{ ledger_id: cash, debit_amount: -100, credit_amount: 0 }, { ledger_id: rent, debit_amount: -100, credit_amount: 0 }]],
    ['a ledger that does not exist', [{ ledger_id: 999999, debit_amount: 100, credit_amount: 0 }, { ledger_id: rent, debit_amount: 0, credit_amount: 100 }]],
    ['a single line', [{ ledger_id: cash, debit_amount: 100, credit_amount: 0 }]]
  ];
  for (const [what, entries] of bad) { const r = await post({ voucher_type: 'Journal', date: '2026-06-01', entries }); assert(r.status === 400, `Refused: ${what}`, `${r.status} ${r.json && r.json.error}`); }
  assert((await get('SELECT COUNT(*) AS n FROM vouchers')).n === v0 && (await get('SELECT COUNT(*) AS n FROM ledger_entries')).n === e0, 'Nothing at all was written by the refused vouchers');

  console.log('\n--- 2. Every voucher type, GST and the reports ---');
  const stock0 = await onHand();
  const s1 = await sale(10);
  assert(s1.status === 200 && s1.json.total_amount === 1180, 'Sales invoice (10 x ₹100 + 9% CGST + 9% SGST) posted for ₹1,180', JSON.stringify(s1.json));
  const s1e = await all('SELECT ledger_id, debit_amount, credit_amount FROM ledger_entries WHERE voucher_id = ? ORDER BY id', [s1.json.id]);
  assert(s1e.length === 4 && s1e.find((e) => e.ledger_id === debtor).debit_amount === 1180 && s1e.find((e) => e.ledger_id === sales).credit_amount === 1000 && s1e.find((e) => e.ledger_id === outC).credit_amount === 90 && s1e.find((e) => e.ledger_id === outS).credit_amount === 90,
    'Sales entries: customer Dr 1180, sales Cr 1000, output CGST Cr 90, output SGST Cr 90');
  assert(await onHand() === stock0 - 10, 'The sale took 10 units out of stock');
  const p1 = await purchaseV(5);
  const p1e = await all('SELECT ledger_id, debit_amount, credit_amount FROM ledger_entries WHERE voucher_id = ?', [p1.json.id]);
  assert(p1.status === 200 && p1e.find((e) => e.ledger_id === creditor).credit_amount === 472 && p1e.find((e) => e.ledger_id === inC).debit_amount === 36 && await onHand() === stock0 - 5,
    'Purchase (5 x ₹80 + input GST ₹36 + ₹36): supplier Cr 472, input tax claimed, stock up by 5');
  const pay = await post({ voucher_type: 'Payment', date: '2026-06-11', entries: [{ ledger_id: creditor, debit_amount: 472, credit_amount: 0 }, { ledger_id: bank, debit_amount: 0, credit_amount: 472 }] });
  const rec = await post({ voucher_type: 'Receipt', date: '2026-06-12', entries: [{ ledger_id: cash, debit_amount: 1180, credit_amount: 0 }, { ledger_id: debtor, debit_amount: 0, credit_amount: 1180 }] });
  const con = await post({ voucher_type: 'Contra', date: '2026-06-13', entries: [{ ledger_id: bank, debit_amount: 1000, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 1000 }] });
  const jv = await post({ voucher_type: 'Journal', date: '2026-06-14', entries: [{ ledger_id: rent, debit_amount: 250.5, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 250.5 }] });
  assert([pay, rec, con, jv].every((r) => r.status === 200), 'Payment, Receipt, Contra and Journal vouchers posted', [pay, rec, con, jv].map((r) => r.status).join(','));
  const bal = async (id) => { const r = await get('SELECT COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) AS b FROM ledger_entries WHERE ledger_id = ?', [id]); return r2(r.b); };
  assert(await bal(debtor) === 0 && await bal(creditor) === -9440 && await bal(rent) === 250.5, 'The customer is settled (0), the supplier is owed only the opening ₹9,440 purchase (the ₹472 bill was paid), rent shows ₹250.50', `${await bal(debtor)} / ${await bal(creditor)} / ${await bal(rent)}`);
  assert(await unbalancedVouchers() === 0, 'Every voucher in the books balances (debits = credits per voucher)');
  const lt = await ledgerTotals();
  const tb = (await req('GET', '/api/reports/trial-balance')).json.data;
  assert(tb.is_balanced && r2(tb.total_debit) === r2(tb.total_credit), 'Trial balance is balanced', `${tb.total_debit} / ${tb.total_credit}`);
  const opening = await get("SELECT ROUND(COALESCE(SUM(CASE WHEN opening_balance_type = 'Dr' THEN opening_balance ELSE 0 END), 0), 2) AS d, ROUND(COALESCE(SUM(CASE WHEN opening_balance_type = 'Cr' THEN opening_balance ELSE 0 END), 0), 2) AS c FROM ledgers");
  const tbItems = tb.items || [];
  const tbRent = tbItems.find((x) => x.id === rent);
  assert(tbRent && r2(tbRent.debit) === 250.5, 'Trial balance shows each ledger from its entries (rent Dr ₹250.50)', JSON.stringify(tbRent));
  void opening; void lt;
  const pl = (await req('GET', '/api/reports/profit-loss')).json.data;
  const plSales = (pl.trading.sales_items || []).find((x) => x.id === sales);
  assert(plSales && r2(plSales.closing_balance) === 1000, 'Profit & loss includes the ₹1,000 of sales from the invoice');
  const bs = (await req('GET', '/api/reports/balance-sheet')).json.data;
  assert(Number.isFinite(Number(bs.assets.total)) && Math.abs(Number(bs.assets.total) - Number(bs.liabilities.total)) < 0.01 && Number(bs.difference) < 0.01, 'Balance sheet: total assets = total liabilities', `${bs.assets.total} / ${bs.liabilities.total}`);
  const dbk = (await req('GET', '/api/reports/daybook')).json.data;
  const ids = [s1, p1, pay, rec, con, jv].map((r) => r.json.id);
  assert(ids.every((id) => dbk.some((v) => v.id === id)), 'Day book lists every posted voucher');
  const gst = (await req('GET', '/api/reports/gst')).json.data;
  const myInv = gst.gstr1.b2b_invoices.concat(gst.gstr1.b2c_invoices).find((x) => x.voucher_id === s1.json.id);
  assert(myInv && r2(myInv.taxable_value) === 1000 && r2(myInv.cgst) === 90 && r2(myInv.sgst) === 90, 'GST report: the invoice shows taxable ₹1,000, CGST ₹90, SGST ₹90 (exactly 9% + 9%)', JSON.stringify(myInv));

  console.log('\n--- 3. Correcting posted vouchers: reversal and audited delete ---');
  const stockBeforeRev = await onHand();
  const rv = await req('POST', `/api/vouchers/${s1.json.id}/reverse`, { body: { date: '2026-06-20' } });
  assert(rv.status === 200 && rv.json.voucher_type === 'Credit Note', 'A sales invoice is reversed by a Credit Note (the original stays in the books)', JSON.stringify(rv.json));
  assert(await onHand() === stockBeforeRev + 10 && (await get('SELECT id FROM vouchers WHERE id = ?', [s1.json.id])), 'The reversal brings the 10 units back; the original invoice is still there');
  const rvE = await all('SELECT ledger_id, debit_amount, credit_amount FROM ledger_entries WHERE voucher_id = ?', [rv.json.id]);
  assert(rvE.find((e) => e.ledger_id === debtor).credit_amount === 1180 && rvE.find((e) => e.ledger_id === outC).debit_amount === 90, 'The reversal mirrors every line (customer Cr 1180, output CGST Dr 90)');
  assert((await req('POST', `/api/vouchers/${s1.json.id}/reverse`, {})).status === 409, 'The same voucher cannot be reversed twice');
  assert((await req('POST', `/api/vouchers/${jv.json.id}/reverse`, { token: clerk })).status === 403, 'Data Entry cannot reverse posted vouchers');
  const del = await req('DELETE', `/api/vouchers/${jv.json.id}`);
  const audit = await get("SELECT details FROM activity_log WHERE action = 'VOUCHER_DELETE' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(jv.json.id)]);
  const snap = audit ? JSON.parse(audit.details) : null;
  assert(del.status === 200 && snap && snap.voucher.voucher_no === jv.json.voucher_no && snap.entries.length === 2 && snap.entries[0].debit_amount === 250.5, 'Deleting a voucher keeps a complete copy (voucher and every line) in the audit log');
  assert((await req('DELETE', `/api/vouchers/${pay.json.id}`, { token: clerk })).status === 403, 'Data Entry cannot delete vouchers');

  console.log('\n--- 4. Inventory ---');
  const st1 = await onHand();
  const sr = await post({ voucher_type: 'Credit Note', date: '2026-06-21', party_ledger_id: debtor, entries: [{ ledger_id: sales, debit_amount: 200, credit_amount: 0 }, { ledger_id: debtor, debit_amount: 0, credit_amount: 200 }], inventory: [{ stock_item_id: item, quantity: 2, rate: 100, godown_id: 1 }] });
  const pr = await post({ voucher_type: 'Debit Note', date: '2026-06-22', party_ledger_id: creditor, entries: [{ ledger_id: creditor, debit_amount: 80, credit_amount: 0 }, { ledger_id: purchase, debit_amount: 0, credit_amount: 80 }], inventory: [{ stock_item_id: item, quantity: 1, rate: 80, godown_id: 1 }] });
  assert(sr.status === 200 && pr.status === 200 && await onHand() === st1 + 2 - 1, 'Sales return brings 2 back, purchase return sends 1 out');
  const W = (await req('POST', '/api/inv/warehouses', { token: acc, body: { name: 'IT Second Store', code: 'ITS' } })).json;
  const wh2 = W && W.data ? W.data.id : null;
  const tr = await req('POST', '/api/inv/transfers', { token: acc, body: { from_warehouse_id: 1, to_warehouse_id: wh2, lines: [{ item_id: item, qty: 7 }] } });
  const det = (await req('GET', `/api/inv/items/${item}`)).json.data;
  assert(tr.status === 200 && det.on_hand === await onHand() && det.warehouses.find((w) => w.id === wh2).on_hand === 7, 'A transfer of 7 moves stock between warehouses; the total is unchanged', JSON.stringify(tr.json).slice(0, 160));
  const adj = await req('POST', '/api/inv/adjustments', { token: acc, body: { warehouse_id: wh2, reason: 'Damaged goods', lines: [{ item_id: item, delta: -2 }] } });
  assert(adj.status === 200 && (await req('GET', `/api/inv/items/${item}`)).json.data.warehouses.find((w) => w.id === wh2).on_hand === 5, 'A stock adjustment of -2 is recorded with its reason');
  const over = await req('POST', '/api/inv/transfers', { token: acc, body: { from_warehouse_id: wh2, to_warehouse_id: 1, lines: [{ item_id: item, qty: 999 }] } });
  assert(over.status === 409, 'Transferring more than a warehouse holds is refused');
  const ie0 = (await get('SELECT COUNT(*) AS n FROM inventory_entries')).n, le0 = (await get('SELECT COUNT(*) AS n FROM ledger_entries')).n, q0 = await onHand();
  const broken = await post({ voucher_type: 'Sales', date: '2026-06-23', entries: [{ ledger_id: debtor, debit_amount: 100, credit_amount: 0 }, { ledger_id: sales, debit_amount: 0, credit_amount: 100 }], inventory: [{ stock_item_id: 999999, quantity: 1, rate: 100, godown_id: 1 }] });
  assert(broken.status >= 400 && (await get('SELECT COUNT(*) AS n FROM inventory_entries')).n === ie0 && (await get('SELECT COUNT(*) AS n FROM ledger_entries')).n === le0 && await onHand() === q0,
    'A voucher that fails half-way (unknown stock item) leaves no ledger line and no stock movement behind', String(broken.status));
  assert((await req('PUT', '/api/vouchers/settings/negative-stock', { token: acc, body: { negative_stock: 'block' } })).status === 403, 'Only an administrator can change the negative-stock policy');
  assert((await req('PUT', '/api/vouchers/settings/negative-stock', { body: { negative_stock: 'block' } })).status === 200, 'The administrator blocks negative stock for this company');
  const tooMany = await sale(await onHand() + 1);
  assert(tooMany.status === 409 && /Not enough stock/.test(tooMany.json.error), 'Selling more than is on hand is then refused', JSON.stringify(tooMany.json));

  console.log('\n--- 5. Many users at the same moment ---');
  const N = 20;
  const lowerTo = await onHand() - 8; // leave exactly 8 units in stock
  if (lowerTo > 0) await sale(lowerTo, { voucher_no: 'IT-LOWER' });
  assert(await onHand() === 8, 'Stock set to exactly 8 units');
  const t0 = Date.now();
  const race = await Promise.all(Array.from({ length: N }, () => sale(1)));
  const ok = race.filter((r) => r.status === 200), refused = race.filter((r) => r.status === 409);
  assert(ok.length === 8 && refused.length === N - 8 && await onHand() === 0, `${N} people sell the last 8 units at once: exactly 8 sales succeed, ${N - 8} are refused, stock ends at 0 (never negative)`, race.map((r) => r.status).join(','));
  assert(new Set(ok.map((r) => r.json.voucher_no)).size === ok.length, 'Every sale got its own voucher number');
  await req('PUT', '/api/vouchers/settings/negative-stock', { body: { negative_stock: 'allow' } });
  const q1 = await onHand();
  const mixed = await Promise.all([...Array.from({ length: 15 }, () => purchaseV(3)), ...Array.from({ length: 15 }, () => sale(2))]);
  assert(mixed.every((r) => r.status === 200) && await onHand() === q1 + 15 * 3 - 15 * 2, '15 purchases (3 each) and 15 sales (2 each) at once: no stock update is lost (+45, -30)', mixed.map((r) => r.status).join(''));
  const many = await Promise.all(Array.from({ length: 30 }, (_, i) => post({ voucher_type: 'Journal', date: '2026-07-01', narration: 'parallel ' + i, entries: [{ ledger_id: rent, debit_amount: 10 + i, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 10 + i }] }, { token: i % 2 ? acc : owner })));
  const nos = many.map((r) => r.json && r.json.voucher_no);
  assert(many.every((r) => r.status === 200) && new Set(nos).size === 30, '30 journals posted at once by two users: all saved, 30 different voucher numbers', many.map((r) => r.status).join(''));
  const lines = await all(`SELECT voucher_id, COUNT(*) AS n FROM ledger_entries WHERE voucher_id IN (${many.map(() => '?').join(',')}) GROUP BY voucher_id`, many.map((r) => r.json.id));
  assert(lines.length === 30 && lines.every((l) => Number(l.n) === 2), 'Each of them has exactly its 2 lines (no partial and no mixed-up voucher)');
  const same = await Promise.all(Array.from({ length: 10 }, () => post({ voucher_type: 'Journal', voucher_no: 'IT-SAME-NO', date: '2026-07-02', entries: [{ ledger_id: rent, debit_amount: 5, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 5 }] })));
  assert(same.filter((r) => r.status === 200).length === 1 && same.filter((r) => r.status === 409).length === 9 && (await get("SELECT COUNT(*) AS n FROM vouchers WHERE voucher_no = 'IT-SAME-NO'")).n === 1,
    'The same voucher number sent 10 times at once: one voucher, nine clear "already used" answers', same.map((r) => r.status).join(','));
  const key = 'it-double-click-' + Date.now();
  const twice = await Promise.all(Array.from({ length: 5 }, () => post({ voucher_type: 'Journal', date: '2026-07-03', entries: [{ ledger_id: rent, debit_amount: 7, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 7 }] }, { headers: { 'Idempotency-Key': key } })));
  assert(twice.every((r) => r.status === 200) && new Set(twice.map((r) => r.json.id)).size === 1 && twice.filter((r) => r.json.replayed).length === 4, 'One request repeated 5 times with the same Idempotency-Key: ONE voucher, the repeats return it', twice.map((r) => r.json && r.json.id).join(','));
  assert(await unbalancedVouchers() === 0 && (await ledgerTotals()).d === (await ledgerTotals()).c, 'After all of that, every voucher still balances and total debits = total credits');
  const cust = await mkLedger('IT Shared Customer', 'Sundry Debtors'), debtorsGroup = await group('Sundry Debtors');
  const edits = await Promise.all(Array.from({ length: 10 }, (_, i) => req('PATCH', `/api/inv/customers/${cust}`, { token: i % 2 ? acc : owner, body: { name: 'IT Shared Customer', address: 'Edit ' + i } })));
  const finalAddr = (await get('SELECT address FROM ledgers WHERE id = ?', [cust])).address;
  assert(edits.every((r) => r.status === 200) && /^Edit \d$/.test(finalAddr), 'Ten users edit the same customer at once: every save succeeds and the record holds one complete version', `${edits.map((r) => r.status).join(',')} -> ${finalAddr}`);
  const pw = 'Integrity#Pass2026x';
  await run("INSERT INTO users (username, password, full_name, role, email, status) VALUES ('it.user', ?, 'IT User', 'Accountant', 'it.user@example.com', 'Active')", [hashPassword(pw)]);
  const logins = await Promise.all(Array.from({ length: 12 }, () => req('POST', '/api/auth/login', { token: null, body: { identifier: 'it.user@example.com', password: pw, login_type: 'employee' } })));
  const toks = logins.map((r) => r.json && r.json.data && r.json.data.token);
  assert(logins.every((r) => r.status === 200) && new Set(toks).size === 12, '12 sign-ins of the same person at once: 12 separate sessions', logins.map((r) => r.status).join(','));
  await Promise.all(toks.slice(0, 6).map((t) => req('POST', '/api/auth/logout', { token: t })));
  const after = await Promise.all(toks.map((t) => req('GET', '/api/auth/me', { token: t })));
  assert(after.slice(0, 6).every((r) => r.status === 401) && after.slice(6).every((r) => r.status === 200), 'Signing out 6 of them at once ends exactly those 6 sessions; the other 6 keep working');
  console.log(`  (section 5 took ${Date.now() - t0} ms)`);

  console.log('\n--- 6. Permissions, sessions, escalation ---');
  assert((await req('GET', '/api/vouchers', { token: null })).status === 401 && (await req('GET', '/api/reports/trial-balance', { token: null })).status === 401, 'No sign-in: vouchers and reports refused (401)');
  // (PUT /api/masters/ledgers/:id exists since ledger alteration was added, so a really missing address is used here)
  const ghost = await req('PUT', '/api/masters/no-such-master/1', { body: { name: 'x' } });
  assert(ghost.status === 404 && ghost.json && ghost.json.success === false, 'A write to an API address that does not exist answers 404 (not "200 OK" with the web page)', String(ghost.status));
  assert((await req('POST', '/api/vouchers', { token: viewer, body: { voucher_type: 'Journal', entries: [] } })).status === 403, 'A Viewer cannot post vouchers');
  assert((await req('GET', '/api/auth/users', { token: clerk })).status === 403 && (await req('GET', '/api/auth/users', { token: acc })).status === 403, 'Employees cannot open user administration');
  assert((await req('GET', '/api/vouchers', { token: T(1, 'admin', 'Owner', -1) })).status === 401, 'An expired session is refused');
  const forged = owner.slice(0, -4) + (owner.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert((await req('GET', '/api/vouchers', { token: forged })).status === 401, 'A tampered session token is refused');
  const forgedRole = (() => { const [p, sig] = clerk.slice(4).split('.'); const o = JSON.parse(Buffer.from(p, 'base64url').toString()); o.role = 'Owner'; return 'rre_' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.' + sig; })();
  assert((await req('GET', '/api/auth/users', { token: forgedRole })).status === 401, 'Changing the role inside a token (Data Entry -> Owner) is refused');
  const me = (await get("SELECT id FROM users WHERE username = 'it.user'")).id;
  const myTok = toks[11];
  assert([403, 401].includes((await req('PUT', `/api/auth/users/${me}`, { token: myTok, body: { role: 'Owner' } })).status) && (await get('SELECT role FROM users WHERE id = ?', [me])).role === 'Accountant', 'An employee cannot make themselves Owner (role unchanged)');

  srv.server && srv.server.close && srv.server.close();
  console.log(`\nIntegrity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

/**
 * Business assistant, forecasts, trends, health score and daily summary.
 * Runs against a DISPOSABLE data directory with a controlled dataset.   npm run test:insights
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_insights_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const ins = require('./core/insightsEngine');
const assistant = require('./core/assistant');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;
const AS = '2026-09-15';

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(9800 + Math.floor(Math.random() * 100), '127.0.0.1');
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
  const ask = async (q, perms = null) => assistant.ask(q, { as_of: AS, perms });

  // ---------------------------------------------------------------- controlled dataset
  await run('DELETE FROM vouchers');                                 // remove the demo vouchers (masters stay)
  await run('UPDATE stock_items SET is_active = 0');                 // demo stock out of the analysis
  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const hdfc = await L('HDFC Bank Current A/c'), rent = await L('Office Rent'), salary = await L('Staff Salaries & Wages'), phone = await L('Telephone & Internet Charges'), elec = await L('Factory Electricity Charges');
  const chennai = await L('Chennai Auto Components Pvt Ltd'), southern = await L('Southern Textiles & Spinning Mills'), bangalore = await L('Bangalore Machine Tools Ltd');
  const elgi = await L('Elgi Equipments Spares Ltd'), bharat = await L('Bharat Electric Motors Vendor');
  const salesAcc = await L('Sales Account - Compressors'), purAcc = await L('Purchase Account - Spares & Machines');
  const item = async (name, level = 0) => { await run('INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, reorder_level) VALUES (?, 1, 1, ?, 18, ?)', [name, '84148011', level]); return (await get('SELECT id FROM stock_items WHERE name = ?', [name])).id; };
  const W = await item('Widget Alpha'), G = await item('Gadget Beta'), OUTY = await item('Empty Gamma', 10);
  let n = 0;
  const V = async (type, date, party, lines, extra = {}) => {
    n++;
    const r = await req('POST', '/api/vouchers', { body: { voucher_type: type, voucher_no: `IN/${n}`, date, party_ledger_id: party, entries: lines.map(([l, d, c]) => ({ ledger_id: l, debit_amount: d, credit_amount: c, particulars: '' })), ...extra } });
    if (!r.json?.success) throw new Error('setup failed ' + r.raw);
    return r.json.id;
  };
  const buy = (date, party, itemId, qty, rate, bill) => V('Purchase', date, party, [[purAcc, qty * rate, 0], [party, 0, qty * rate]], { inventory: [{ stock_item_id: itemId, quantity: qty, rate, godown_id: 1 }], ...(bill ? { bill_allocations: [{ ledger_id: party, bill_type: 'New Ref', bill_ref: bill.ref, amount: qty * rate, due_date: bill.due }] } : {}) });
  const sell = (date, party, itemId, qty, rate, bill) => V('Sales', date, party, [[party, qty * rate, 0], [salesAcc, 0, qty * rate]], { inventory: [{ stock_item_id: itemId, quantity: qty, rate, godown_id: 1 }], ...(bill ? { bill_allocations: [{ ledger_id: party, bill_type: 'New Ref', bill_ref: bill.ref, amount: qty * rate, due_date: bill.due }] } : {}) });
  const pay = (date, expense, amt) => V('Payment', date, expense, [[expense, amt, 0], [hdfc, 0, amt]]);
  await buy('2026-01-05', elgi, W, 6000, 60); await buy('2026-02-05', bharat, W, 6000, 55); await buy('2026-01-05', elgi, G, 500, 200);
  for (let k = 1; k <= 8; k++) {
    const mm = String(k).padStart(2, '0');
    await sell(`2026-${mm}-10`, chennai, W, 1000 + 100 * (k - 1), 100);
    await pay(`2026-${mm}-01`, rent, 20000); await pay(`2026-${mm}-02`, salary, 30000);
  }
  await pay('2026-08-20', phone, 30000);
  await pay('2026-09-01', rent, 20000); await pay('2026-09-02', salary, 30000); await pay('2026-09-10', elec, 8000);
  await sell('2026-09-15', chennai, W, 50, 100); await sell('2026-09-15', southern, G, 5, 300);
  // receivables / payables (bill-by-bill) for overdue + cash-flow tests
  await sell('2026-08-01', chennai, W, 200, 100, { ref: 'F-0', due: '2026-08-10' });
  await V('Receipt', '2026-08-20', chennai, [[hdfc, 20000, 0], [chennai, 0, 20000]], { bill_allocations: [{ ledger_id: chennai, bill_type: 'Agst Ref', bill_ref: 'F-0', amount: 20000 }] });
  await sell('2026-09-05', chennai, W, 1000, 100, { ref: 'F-1', due: '2026-09-25' });
  await sell('2026-07-02', southern, W, 500, 100, { ref: 'F-2', due: '2026-08-01' });
  await sell('2026-04-01', bangalore, W, 300, 100, { ref: 'F-3', due: '2026-05-01' });
  await buy('2026-09-05', elgi, W, 400, 100, { ref: 'PB-1', due: '2026-09-20' });
  const counts = async () => ({ v: (await get('SELECT COUNT(*) c FROM vouchers')).c, e: (await get('SELECT COUNT(*) c FROM ledger_entries')).c });

  console.log('\n--- 1. Period understanding ---');
  const P = async (t, d) => (await ins.parsePeriod(t, AS, d));
  let p = await P('sales today'); assert(p.from === AS && p.to === AS, '"today"');
  p = await P('what about yesterday'); assert(p.from === '2026-09-14' && p.to === '2026-09-14', '"yesterday"');
  p = await P('this month'); assert(p.from === '2026-09-01' && p.to === AS, '"this month" runs to the books date');
  p = await P('last month'); assert(p.from === '2026-08-01' && p.to === '2026-08-31', '"last month" is the full previous month');
  p = await P('this quarter'); assert(p.from === '2026-07-01' && p.to === AS, '"this quarter" (Jul–Sep)');
  p = await P('last quarter'); assert(p.from === '2026-04-01' && p.to === '2026-06-30', '"last quarter" (Apr–Jun)');
  p = await P('last 30 days'); assert(p.from === '2026-08-17' && p.to === AS, '"last 30 days"');
  p = await P('in june'); assert(p.from === '2026-06-01' && p.to === '2026-06-30', 'Month name (June => 2026)');
  p = await P('december sales'); assert(p.from === '2025-12-01' && p.to === '2025-12-31', 'A month later than the books date means last year');
  p = await P('march 2025'); assert(p.from === '2025-03-01' && p.to === '2025-03-31', 'Month with year');
  p = await P('from 2026-01-01 to 2026-02-28'); assert(p.from === '2026-01-01' && p.to === '2026-02-28', 'Explicit range');
  p = await P('this financial year'); assert(p.from === '2026-04-01' && p.to === AS, 'Financial year from the company\'s FY start (1 April)');
  p = await ins.parsePeriod('this year', '2026-02-10'); assert(p.from === '2025-04-01', 'Early-year dates use the previous FY start');
  p = await P('how much may i earn'); assert(p.label.startsWith('this month'), '"may" the verb is not read as the month of May');
  p = await P('in may'); assert(p.from === '2026-05-01', '"in may" is the month');
  p = await P('nonsense words', 'last 90 days'); assert(p.to === AS && p.from === '2026-06-18', 'Unknown text uses the supplied default');

  console.log('\n--- 2. Statistics ---');
  const lf = ins.linearFit([1, 3, 5, 7, 9]);
  assert(near(lf.slope, 2, 1e-9) && near(lf.intercept, 1, 1e-9) && near(lf.r2, 1, 1e-9), 'Linear fit recovers y = 2x + 1 (R² = 1)');
  const noisy = ins.linearFit([10, 12, 9, 14, 11, 13]);
  assert(noisy.r2 > 0 && noisy.r2 < 0.5 && noisy.sigma > 0, 'A noisy series has low R² and positive residual spread', JSON.stringify(noisy));

  console.log('\n--- 3. Profit (period, cost-of-goods based) ---');
  const jan = await ins.periodProfit('2026-01-01', '2026-01-31'), jul = await ins.periodProfit('2026-07-01', '2026-07-31'), aug = await ins.periodProfit('2026-08-01', '2026-08-31');
  assert(jan.revenue === 100000 && jan.cogs === 60000 && jan.gross_profit === 40000 && jan.net_profit === -10000, 'January: sales 1,00,000; cost at ₹60 (only the first purchase existed); net −10,000', JSON.stringify(jan));
  assert(jul.revenue === 160000 + 50000 && near(jul.cogs, 1600 * 57.5 + 500 * 57.5, 0.01), 'July: weighted-average cost ₹57.50 after both purchases', JSON.stringify(jul));
  assert(aug.revenue === 170000 + 20000 && near(aug.net_profit, aug.gross_profit - 80000), 'August: includes the extra ₹30,000 telephone bill in indirect expenses', JSON.stringify(aug));
  assert(aug.indirect_expenses === 80000 && aug.direct_expenses === 0, 'August indirect expenses = rent 20,000 + salaries 30,000 + telephone 30,000');
  const sep = await ins.periodProfit('2026-09-01', AS);
  assert(sep.direct_expenses === 8000 && sep.indirect_expenses === 50000, 'September to date: electricity 8,000 (direct) and rent + salaries 50,000 (indirect)');
  assert(near(sep.net_profit, sep.revenue - sep.cogs - 8000 - 50000), 'Net profit equals revenue − cost of goods − expenses');

  console.log('\n--- 4. The assistant: the nine questions you listed ---');
  let a = await ask("What are today's total sales?");
  assert(a.intent === 'sales' && /6,500\.00/.test(a.answer) && a.data.invoices === 2, 'Today\'s sales = ₹6,500 from 2 invoices (₹5,000 + ₹1,500)', a.answer);
  assert(a.table.rows.length === 2 && a.assumptions.length > 0, 'Includes a customer table and assumptions');
  a = await ask("What is this month's net profit?");
  assert(a.intent === 'profit' && a.data.from === '2026-09-01' && near(a.data.net_profit, sep.net_profit) && a.table.rows.some((r) => r[0] === 'Net profit'), 'Net profit for this month = the engine figure, with a breakdown table', a.answer);
  assert(/loss/.test(a.answer) === (sep.net_profit < 0), 'Wording says "loss" when negative');
  assert(a.assumptions[0].includes('weighted-average'), 'States how profit was computed (and that it differs from the P&L report)');
  a = await ask('Which products are running out of stock?');
  assert(a.intent === 'low_stock' && a.table.rows.some((r) => r[0] === 'Empty Gamma' && r[2] === 'out of stock'), 'Lists the out-of-stock item', a.answer);
  a = await ask('Which customers have overdue payments?');
  const od = Object.fromEntries(a.table.rows.map((r) => [r[0], r]));
  assert(a.intent === 'overdue' && od['Southern Textiles & Spinning Mills'][1] === 50000 && od['Bangalore Machine Tools Ltd'][1] === 30000 && !od['Chennai Auto Components Pvt Ltd'], 'Southern ₹50,000 and Bangalore ₹30,000 overdue; Chennai (not yet due) is not', JSON.stringify(a.table.rows));
  assert(a.data.total_overdue === 80000 && od['Southern Textiles & Spinning Mills'][2] === 45, 'Total ₹80,000; Southern oldest bill 45 days overdue');
  a = await ask('Which supplier offers the lowest purchase price for Widget Alpha?');
  assert(a.intent === 'supplier_price' && /Bharat/.test(a.answer) && a.table.rows[0][0].startsWith('Bharat') && /55\.00/.test(a.answer), 'Bharat Electric is cheapest for Widget Alpha at ₹55 (the later ₹100 Elgi bill is dearer)', a.answer);
  a = await ask('Which supplier is cheapest?');
  assert(a.intent === 'supplier_price' && a.table.rows.length >= 2, 'Without an item it lists the cheapest supplier per item');
  a = await ask('Show the top 10 selling products');
  assert(a.intent === 'top_products' && a.table.rows[0][0] === 'Widget Alpha' && a.table.rows.some((r) => r[0] === 'Gadget Beta'), 'Top products ranked by value (Widget first, Gadget included)', JSON.stringify(a.table.rows));
  a = await ask('top 1 product');
  assert(a.table.rows.length === 1, '"top 1" returns one row');
  a = await ask("Compare this month's expenses with last month");
  assert(a.intent === 'compare_expenses' && a.data.current.total === 58000 && a.data.previous.total === 50000 && a.data.change === 8000, 'This month to date ₹58,000 vs last month (same 15 days) ₹50,000: +₹8,000', JSON.stringify(a.data.current) + JSON.stringify(a.data.previous));
  a = await ask('Why have my expenses increased?');
  assert(a.intent === 'why_expenses' && a.data.drivers[0].ledger === 'Factory Electricity Charges' && a.data.drivers[0].is_new && /nothing booked last month/.test(a.answer), 'Biggest driver: Factory Electricity (nothing booked last month)', a.answer);
  assert(a.data.drivers.length >= 1 && a.data.drivers.every((d) => d.change > 0), 'Only ledgers that increased are named as drivers');
  assert(a.data.drivers[0].share_of_change_pct === 100, 'The driver\'s share of the change is shown (electricity = 100% of the ₹8,000 increase)', String(a.data.drivers[0].share_of_change_pct));
  a = await ask("Predict next month's cash flow");
  assert(a.intent === 'cashflow' && a.data.horizon_days === 30 && a.table.rows.length === 5, 'Cash-flow forecast for 30 days in 5 weekly rows');

  console.log('\n--- 5. Cash-flow forecast arithmetic ---');
  await run('UPDATE recurring_templates SET is_active = 0'); // none yet; keep deterministic
  const rt = await req('POST', '/api/recurring/templates', { body: { name: 'Rent', voucher_type: 'Payment', party_ledger_id: rent, frequency: 'monthly', start_date: '2026-10-01', entries: [{ ledger_id: rent, debit_amount: 20000 }, { ledger_id: hdfc, credit_amount: 20000 }] } });
  assert(rt.status === 200, 'Recurring rent template (₹20,000 from 1 Oct) created for the forecast');
  // creating it generated drafts up to today's REAL date; put it back as at the books date so the forecast sees 1 Oct as upcoming
  await run('DELETE FROM recurring_drafts'); await run("UPDATE recurring_templates SET next_due = '2026-10-01', is_active = 1");
  const f = await ins.cashflowForecast(AS, { days: 30 });
  const cashNow = (await ins.cashPosition(AS)).total;
  const independent = r2(1325000 - (20000 * 9 + 30000 * 9 + 30000 + 8000) + 20000);
  assert(f.opening_balance === cashNow && near(cashNow, independent), `Opening cash = ₹${cashNow} (opening balances − expense payments + the ₹20,000 receipt)`, `${cashNow} vs ${independent}`);
  const items = f.weeks.flatMap((w) => w.items);
  const find = (re) => items.find((i) => re.test(i.label));
  assert(find(/F-1/)?.amount === 95000 && find(/F-1/).date === '2026-10-05', 'F-1 (₹1,00,000, due 25 Sep): Chennai usually pays 10 days late => 5 Oct, 95% likely = ₹95,000', JSON.stringify(find(/F-1/)));
  assert(find(/F-2/)?.amount === 20000 && find(/F-2/).date === '2026-09-22', 'F-2 (₹50,000, 45 days overdue): 40% likely = ₹20,000 within a week');
  assert(f.not_expected.length === 1 && f.not_expected[0].bill === 'F-3' && f.not_expected[0].amount === 30000, 'F-3 (137 days overdue) is excluded as unlikely and listed separately');
  assert(find(/PB-1/)?.amount === 40000 && find(/PB-1/).kind === 'out' && find(/PB-1/).date === '2026-09-20', 'Supplier bill PB-1 ₹40,000 due 20 Sep is an outflow');
  assert(find(/Recurring: Rent/)?.amount === 20000 && find(/Recurring: Rent/).date === '2026-10-01', 'Recurring rent on 1 Oct is an outflow');
  const weeklyRun = r2((40000 * 12) / 52);
  assert(f.running_costs_per_month === 40000, 'Running costs = average of Jun–Aug expenses not covered by bills/templates: (salaries 90,000 + telephone 30,000) ÷ 3 = ₹40,000', String(f.running_costs_per_month));
  const w1 = f.weeks[0].items.find((i) => /running costs/.test(i.label));
  assert(near(w1.amount, weeklyRun, 0.02), `A full week of running costs ≈ ₹${weeklyRun}`, String(w1.amount));
  assert(f.weeks.every((w, i) => near(w.net, w.inflow - w.outflow) && near(w.closing, (i ? f.weeks[i - 1].closing : f.opening_balance) + w.net)), 'Every week: net = in − out and closing balance rolls forward correctly');
  assert(near(f.closing_balance, f.weeks[f.weeks.length - 1].closing) && f.lowest_point.balance <= f.opening_balance, 'Closing balance and lowest point are consistent');
  const cons = await ins.cashflowForecast(AS, { days: 30, scenario_factor: 0.7 });
  assert(cons.weeks.flatMap((w) => w.items).find((i) => /F-1/.test(i.label)).amount === 66500 && cons.closing_balance < f.closing_balance, 'Conservative scenario scales inflows to 70% (₹66,500)');
  assert((await ins.cashflowForecast(AS, { days: 500 })).horizon_days === 90 && (await ins.cashflowForecast(AS, { days: 1 })).horizon_days === 7, 'Horizon is clamped to 7–90 days');
  assert(f.assumptions.length >= 5 && f.assumptions.some((x) => /Not included/.test(x)), 'Assumptions and exclusions are listed');
  await V('Purchase', '2026-09-10', elgi, [[purAcc, 5000000, 0], [elgi, 0, 5000000]], { bill_allocations: [{ ledger_id: elgi, bill_type: 'New Ref', bill_ref: 'PB-BIG', amount: 5000000, due_date: '2026-09-18' }] });
  const neg = await ins.cashflowForecast(AS, { days: 30 });
  assert(neg.warning && /negative/.test(neg.warning) && neg.lowest_point.balance < 0, 'A large payable pushes the balance negative and the forecast warns');
  await run("DELETE FROM vouchers WHERE voucher_no = ?", [`IN/${n}`]); // remove the big bill again

  console.log('\n--- 6. Trends & sales forecast ---');
  const t = await ins.trends(AS, { metric: 'sales' });
  const monthSales = [];
  for (let k = 1; k <= 8; k++) { const mm = String(k).padStart(2, '0'); monthSales.push((await get(`SELECT COALESCE(SUM(e.credit_amount - e.debit_amount),0) s FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? AND v.date >= ? AND v.date <= ?`, [salesAcc, `2026-${mm}-01`, `2026-${mm}-31`])).s); }
  const ind = ins.linearFit(monthSales);
  assert(t.complete_months_used === 8 && JSON.stringify(t.series.filter((x) => x.complete).slice(-8).map((x) => x.sales)) === JSON.stringify(monthSales), '8 complete months used (part-month September excluded); series equals an independent SQL total', JSON.stringify(monthSales));
  assert(near(t.trend.slope_per_month, ind.slope, 0.02) && near(t.trend.r_squared, ind.r2, 0.01), `Slope (₹${t.trend.slope_per_month}/month) and R² (${t.trend.r_squared}) match an independent least-squares fit`);
  assert(t.trend.direction === 'rising' && t.trend.strength === (ind.r2 >= 0.6 ? 'clear' : ind.r2 >= 0.3 ? 'weak' : 'no real'), 'Direction and strength label follow from the fit');
  const f0 = ind.intercept + ind.slope * 8, band = 1.96 * ind.sigma * Math.sqrt(1 + 1 / 8);
  assert(t.forecast.length === 3 && t.forecast[0].month === '2026-09' && near(t.forecast[0].predicted, f0, 0.02) && near(t.forecast[0].low, f0 - band, 0.02) && near(t.forecast[0].high, f0 + band, 0.02), 'September forecast and its 95% range match the independent calculation', JSON.stringify(t.forecast[0]));
  assert(t.forecast[1].predicted > t.forecast[0].predicted, 'Rising trend gives a rising forecast');
  let seriesMatches = true, mismatch = '';
  for (const row of t.series.filter((x) => x.complete)) {
    const r = ins.monthRange(Number(row.month.slice(0, 4)), Number(row.month.slice(5)));
    const pp = await ins.periodProfit(r.from, r.to);
    const ex = (await ins.expensesByLedger(r.from, r.to)).reduce((s, e) => s + e.amount, 0);
    if (!near(row.sales, pp.revenue) || !near(row.gross_profit, pp.gross_profit) || !near(row.net_profit, pp.net_profit) || !near(row.expenses, ex)) { seriesMatches = false; mismatch = `${row.month}: ${JSON.stringify(row)} vs ${JSON.stringify(pp)}`; }
  }
  assert(seriesMatches, 'The fast monthly series equals the single-period calculation for every month (sales, expenses, gross and net profit)', mismatch);
  const tNo = await ins.trends('2026-03-31', { metric: 'sales' });
  assert(tNo.forecast === null && /At least 6/.test(tNo.note), 'Only 3 months of history: refuses to forecast and says why');
  a = await ask('Forecast my sales for next month');
  assert(a.intent === 'trend' && a.data.forecast.length === 3 && new RegExp(a.data.trend.direction).test(a.answer) && a.assumptions.some((x) => /Seasonality/.test(x)), 'The assistant answers a sales forecast with the trend, range and its limits', a.answer);
  a = await ask('What is the profit forecast');
  assert(a.intent === 'trend' && a.data.metric === 'net_profit', 'Profit forecast uses the net-profit series');
  a = await ask('sales trend'); assert(a.data.metric === 'sales', 'Sales trend question');

  console.log('\n--- 7. Health score ---');
  const h = await ins.healthScore(AS);
  const used = h.components.filter((c) => c.usable);
  assert(h.score >= 0 && h.score <= 100 && h.components.length === 6, 'Score between 0 and 100 with all six components listed');
  assert(h.score === Math.round(used.reduce((s, c) => s + c.score * c.weight, 0) / used.reduce((s, c) => s + c.weight, 0)), 'Score equals the weighted average of the component scores (formula is reproducible)');
  assert(used.every((c) => c.score >= 0 && c.score <= 100 && c.explain.length > 10) && h.method.includes('not a credit rating'), 'Each component explains itself; method says it is not a credit rating');
  const rec = h.components.find((c) => c.key === 'receivables');
  assert(rec.usable && rec.value === r2((80000 / 180000) * 100), 'Receivables component = share of open receivables more than 30 days overdue (80,000 of 1,80,000)', JSON.stringify(rec));
  assert(['strong', 'good', 'needs attention', 'at risk'].includes(h.band), 'A band is given');
  a = await ask('How is my business doing?');
  assert(a.intent === 'health' && /\/100/.test(a.answer) && a.table.rows.length === h.components.length, 'The assistant reports the score with the component table');
  await run('UPDATE ledger_entries SET debit_amount = debit_amount + 5 WHERE id = (SELECT MIN(id) FROM ledger_entries)'); // unbalance one voucher on purpose
  const hBad = await ins.healthScore(AS);
  assert(hBad.components.find((c) => c.key === 'integrity').score === 0 && hBad.score < h.score, 'An unbalanced voucher drops the integrity component to 0 and lowers the score');
  await run('UPDATE ledger_entries SET debit_amount = debit_amount - 5 WHERE id = (SELECT MIN(id) FROM ledger_entries)');

  console.log('\n--- 8. Daily summary & recommendations ---');
  const s = await ins.dailySummary(AS);
  assert(s.today.sales_excl_tax === 6500 && s.today.invoices === 2 && s.cash.total === cashNow, 'Summary numbers match the engine (sales today ₹6,500, cash)');
  assert(s.receivables_overdue.total === 80000 && s.receivables_overdue.customers === 2, 'Overdue receivables ₹80,000 from 2 customers');
  assert(s.recommendations.length >= 3 && s.recommendations.every((r) => r.because.length > 10 && [1, 2, 3].includes(r.priority)), 'Recommendations each state their reason and a priority');
  assert(s.recommendations.map((r) => r.priority).join() === [...s.recommendations.map((r) => r.priority)].sort().join(), 'Most important first');
  assert(s.recommendations.some((r) => /Chase/.test(r.title) && /Southern/.test(r.because)), 'Includes "chase overdue receivables" naming the largest debtor');
  assert(s.recommendations.some((r) => /Reorder/.test(r.title)) && s.recommendations.some((r) => /days old/.test(r.title)), 'Includes reorder and a warning that the books are not up to date');
  assert(s.assumptions[0].includes('not predictions'), 'States that recommendations are rules applied to the numbers');
  a = await ask('Give me a business summary');
  assert(a.intent === 'summary' && /Recommended actions/.test(a.answer), 'The assistant returns the summary');

  console.log('\n--- 9. Natural-language reports & other phrasings ---');
  a = await ask('sales in july');
  assert(a.intent === 'sales' && a.period.from === '2026-07-01' && a.data.net_sales_excl_tax === 210000, 'Sales for a named month (July: 1,60,000 + the 50,000 invoice)', a.answer);
  a = await ask('expenses by ledger last month');
  assert(a.intent === 'expenses' && a.table.rows.find((r) => r[0] === 'Telephone & Internet Charges')[1] === 30000 && a.period.from === '2026-08-01', 'Expenses by ledger for last month (telephone ₹30,000)');
  a = await ask('sales by customer this quarter');
  assert(a.intent === 'sales_by_customer' && a.table.rows[0][0].startsWith('Chennai'), 'Sales by customer');
  a = await ask('sales by month'); assert(a.intent === 'sales_by_month' && a.table.rows.length === 12, 'Sales by month: 12 rows');
  assert((await ask('what is the meaning of life')) === null && (await ask('')) === null && (await ask('hello')) === null, 'Unrecognised or empty questions return nothing (no guessing)');
  let threw = false; try { await ask('x'.repeat(301)); } catch (e) { threw = e.status === 400; }
  assert(threw, 'Over-long questions are rejected');
  a = await ask("Show Robert'); DROP TABLE vouchers;-- sales");
  assert((await get('SELECT COUNT(*) c FROM vouchers')).c > 0, 'SQL-injection text in a question is harmless');
  const rest = await ask('what is my net profit', { role: 'Data Entry', canViewFinancials: false });
  assert(rest.restricted && /not permitted/.test(rest.answer) && !/₹/.test(rest.answer), 'A role without financial-view permission is refused and no figures leak');
  const ok = await ask('top 3 products', { role: 'Data Entry', canViewFinancials: false });
  assert(ok.intent === 'top_products' && !ok.restricted, 'Operational questions (top products) remain available to that role');

  console.log('\n--- 10. HTTP API & integration with the existing assistant ---');
  assert((await req('POST', '/api/insights/ask', { token: null, body: { question: 'sales' } })).status === 401, '/ask requires login');
  const h1 = await req('POST', '/api/insights/ask', { token: viewer, body: { question: 'compare expenses this month', as_of: AS } });
  assert(h1.status === 200 && h1.json.data.intent === 'compare_expenses', '/ask works for a Viewer (financial-view role)');
  assert((await req('POST', '/api/insights/ask', { token: clerk, body: { question: 'net profit this month' } })).json.data.restricted === true, '/ask refuses financial answers for Data Entry');
  assert((await req('POST', '/api/insights/ask', { body: { question: 'what is the meaning of life' } })).json.data.intent === null, 'Unknown question -> intent null');
  for (const p of ['/api/insights/summary', '/api/insights/health', '/api/insights/cashflow', '/api/insights/trends']) {
    assert((await req('GET', p, { token: clerk })).status === 403 && (await req('GET', p, { token: null })).status === 401 && (await req('GET', p + `?as_of=${AS}`, { token: viewer })).status === 200, `${p}: 401 without login, 403 for Data Entry, 200 for Viewer`);
  }
  assert((await req('GET', '/api/insights/summary?as_of=15-09-2026')).status === 400, 'Bad as_of rejected');
  assert((await req('GET', `/api/insights/cashflow?as_of=${AS}&days=14&scenario=0.5`)).json.data.horizon_days === 14, 'Cash-flow API accepts days and scenario');
  assert((await req('GET', `/api/insights/trends?as_of=${AS}&metric=expenses`)).json.data.metric === 'expenses' && (await req('GET', `/api/insights/trends?as_of=${AS}&metric=evil`)).json.data.metric === 'sales', 'Trends API: valid metric used; unknown metric falls back to sales');
  const legacy = await req('POST', '/api/ai/query', { body: { query: "What are today's total sales?" } });
  assert(legacy.status === 200 && /Total sales/.test(legacy.json.data.answer) && legacy.json.data.data.intent === 'sales', 'The existing Copilot endpoint (/api/ai/query) now returns the richer answer');
  const fallback = await req('POST', '/api/ai/query', { body: { query: 'how much cash do I have' } });
  assert(fallback.status === 200 && /Cash-in-Hand/i.test(fallback.json.data.answer), 'Questions the new engine does not handle still reach the original assistant, unchanged');
  assert((await req('POST', '/api/ai/query', { token: null, body: { query: 'sales' } })).status === 401, 'The Copilot endpoint still requires login');
  const clerkQ = await req('POST', '/api/ai/query', { token: clerk, body: { query: 'what is the net profit this month' } });
  assert(/not permitted/.test(clerkQ.json.data.answer), 'The Copilot endpoint also refuses financial answers for Data Entry');

  console.log('\n--- 11. Read-only & integrity ---');
  const before = await counts();
  for (const q of ['top 10 products', 'net profit this month', 'cash flow forecast', 'give me a summary', 'why did expenses increase']) await ask(q);
  await ins.dailySummary(AS); await ins.healthScore(AS); await ins.trends(AS);
  const after = await counts();
  assert(before.v === after.v && before.e === after.e, 'No question or report changes any voucher or entry');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);
  void all;

  console.log('\n====================================================');
  console.log(`📊 INSIGHTS RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });

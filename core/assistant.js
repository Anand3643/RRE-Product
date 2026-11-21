/**
 * RRE Tally — natural-language business assistant (rule-based, offline).
 *
 * Understands a fixed set of business questions (sales, profit, top products, expenses and why they changed,
 * overdue customers, low stock, cheapest supplier, cash-flow and sales forecasts, health score, daily summary)
 * and answers them from the live books. Unknown questions return null — it never guesses or invents figures.
 */
const ins = require('./insightsEngine');
const inventory = require('./inventoryTools');
const { getOpenBills, daysBetween } = require('./analytics');
const { all } = require('./db');

const { inr, r2 } = ins;
const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const norm = (q) => String(q || '').toLowerCase().replace(/[?!.,;:()"]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['which', 'what', 'who', 'the', 'for', 'and', 'with', 'from', 'that', 'this', 'our', 'have', 'has', 'are', 'was', 'offers', 'offer', 'supplier', 'suppliers', 'vendor', 'vendors', 'lowest', 'cheapest', 'cheap', 'price', 'prices', 'rate', 'best', 'purchase', 'buy', 'item', 'items', 'product', 'products', 'least', 'gives', 'give', 'sells', 'sell', 'show', 'tell', 'does', 'can', 'you']);
const RESTRICTED = new Set(['profit', 'expenses', 'compare_expenses', 'why_expenses', 'cashflow', 'trend', 'health', 'summary']);

function tableMd(cols, rows, limit = 5) {
  return rows.slice(0, limit).map((r) => '• ' + r.map((v, i) => (i === 0 ? `**${v}**` : v)).join(' · ')).join('\n');
}
const asTable = (columns, rows) => ({ columns, rows });
const lagNote = (asOf, ageDays) => (ageDays > 7 ? `\n\n_Note: your latest entry is dated ${asOf} (${ageDays} days ago), so this reflects the books as entered._` : '');

async function matchItem(q) {
  const toks = q.split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  if (!toks.length) return null;
  const items = await all('SELECT id, name FROM stock_items WHERE is_active = 1');
  let best = null, bestScore = 0;
  for (const it of items) {
    const name = it.name.toLowerCase();
    const score = toks.filter((t) => name.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 1 ? best : null;
}

function detectIntent(q) {
  const has = (re) => re.test(q);
  if (has(/\bwhy\b.*\b(expense|expenses|cost|costs|spend|spending)\b/) || has(/\b(expense|expenses|cost|costs)\b.*\b(increas|rise|risen|higher|jump|gone up|up)\b.*\bwhy\b/)) return 'why_expenses';
  if (has(/\bcompar\w*\b.*\b(expense|expenses|cost|costs|spend)/) || has(/\b(expense|expenses)\b.*\b(vs|versus|compared)\b/)) return 'compare_expenses';
  if (has(/(cash\s*flow|cashflow|cash position|cash balance|liquidity)\b.*\b(predict|forecast|next|project|expect)/) || has(/\b(predict|forecast|project)\b.*\bcash/) || has(/next (month|week|quarter).*cash/)) return 'cashflow';
  if (has(/\b(predict|forecast|project|trend|trending)\b.*\b(sales|revenue|turnover|profit|profits|profitability|expenses)\b/) || has(/\b(sales|revenue|profit|expenses)\b.*\b(forecast|trend|next month|prediction)\b/)) return 'trend';
  if (has(/\b(health|business score|performance score|how is (my|the|our) (business|company)|how are we doing)\b/)) return 'health';
  if (has(/\b(summary|briefing|insights?|recommendations?|what should i (do|focus)|daily report)\b/)) return 'summary';
  if (has(/\btop\b.*\b(products?|items?)\b|\bbest[- ]sell|\bmost sold\b|\bbest selling\b/)) return 'top_products';
  if (has(/\b(supplier|vendor)s?\b.*\b(lowest|cheapest|least|best price|best rate)\b|\b(lowest|cheapest)\b.*\b(price|rate|purchase|supplier|vendor)/) || has(/\bwho (is|are)? ?(the )?cheapest\b/)) return 'supplier_price';
  if (has(/\b(running out|run out|low stock|out of stock|stock.*(low|finish|shortage)|need to reorder|reorder|shortage)\b/)) return 'low_stock';
  if (has(/\boverdue\b.*\b(customer|customers|payment|payments|receivable|receivables|invoice|invoices|bill|bills)\b|\bwho owes\b|\bowe us\b|\bdefaulters?\b|\blate pay/)) return 'overdue';
  if (has(/\b(net )?profit\b|\bprofitability\b|\bearnings\b/)) return 'profit';
  if (has(/\bexpenses?\b.*\b(by|breakdown|ledger)\b|\b(top|biggest|largest|highest) (expenses?|costs?)\b|\bwhere.*money.*(going|spent)\b|\bexpenses?\b/)) return 'expenses';
  if (has(/\bsales\b.*\b(by|per)\b.*\b(customer|party)/)) return 'sales_by_customer';
  if (has(/\bsales\b.*\b(by|per)\b.*\b(product|item)/)) return 'top_products';
  if (has(/\bsales\b.*\b(by|per)\b.*\bmonth/)) return 'sales_by_month';
  if (has(/\b(sales|revenue|turnover|sold|invoiced)\b/)) return 'sales';
  return null;
}

async function ask(question, { perms = null, as_of } = {}) {
  const raw = String(question || '').trim();
  if (!raw) return null;
  if (raw.length > 300) { const e = new Error('Please keep the question under 300 characters.'); e.status = 400; throw e; }
  const q = norm(raw);
  const intent = detectIntent(q);
  if (!intent) return null;
  if (RESTRICTED.has(intent) && perms && !perms.canViewFinancials) {
    return { intent, answer: `Your role (${perms.role}) is not permitted to view financial results, so I can't answer that.`, table: null, assumptions: [], restricted: true };
  }
  const asOf = await ins.booksDate(as_of);
  const ageDays = daysBetween(asOf, new Date().toISOString().slice(0, 10));
  const nMatch = /\btop\s*(\d{1,2})\b|\b(\d{1,2})\s+(?:best|top|biggest|largest)\b/.exec(q);
  const topN = Math.min(50, Math.max(1, nMatch ? Number(nMatch[1] || nMatch[2]) : 10));
  const out = (o) => ({ intent, as_of: asOf, ...o, answer: o.answer + lagNote(asOf, ageDays) });

  switch (intent) {
    case 'sales': {
      const p = await ins.parsePeriod(q, asOf, /\btoday\b/.test(q) ? 'today' : 'this month');
      const s = await ins.salesBreakdown(p.from, p.to);
      return out({ period: p, data: s, table: asTable(['Customer', 'Net sales (₹)', 'Vouchers'], s.by_customer.slice(0, 10).map((c) => [c.name, c.amount, c.vouchers])),
        answer: `**Total sales for ${p.label}: ${inr(s.net_sales_excl_tax)}** (excluding GST) from ${s.invoices} invoice(s); invoiced value including GST ${inr(s.invoice_total_incl_tax)}.` +
          (s.by_customer.length ? `\n\nTop customers:\n${tableMd(['n', 'a'], s.by_customer.map((c) => [c.name, inr(c.amount)]), 3)}` : ''),
        assumptions: ['Net sales = credits less debits on ledgers in the Sales Accounts group, i.e. after credit-note returns and before GST.'] });
    }
    case 'profit': {
      const p = await ins.parsePeriod(q, asOf, 'this month');
      const pr = await ins.periodProfit(p.from, p.to);
      const rows = [['Sales', pr.revenue], ['Other direct incomes', pr.direct_incomes], ['Cost of goods sold', -pr.cogs], ['Direct expenses', -pr.direct_expenses], ['Gross profit', pr.gross_profit], ['Indirect incomes', pr.indirect_incomes], ['Indirect expenses', -pr.indirect_expenses], ['Net profit', pr.net_profit]];
      return out({ period: p, data: pr, table: asTable(['Item', 'Amount (₹)'], rows),
        answer: `**Net ${pr.net_profit >= 0 ? 'profit' : 'loss'} for ${p.label}: ${inr(Math.abs(pr.net_profit))}**${pr.net_margin_pct !== null ? ` (${pr.net_margin_pct}% of sales ${inr(pr.revenue)})` : ''}.\n` +
          `Gross profit ${inr(pr.gross_profit)} after cost of goods ${inr(pr.cogs)}; indirect expenses ${inr(pr.indirect_expenses)}.`, assumptions: [ins.PROFIT_METHOD] });
    }
    case 'top_products': {
      const p = await ins.parsePeriod(q, asOf, 'last 90 days');
      const rows = (await ins.netSoldByItem(p.from, p.to)).filter((r) => r.qty > 0).sort((a, b) => b.value - a.value).slice(0, topN);
      return out({ period: p, table: asTable(['Product', 'Units sold', 'Sales value (₹)'], rows.map((r) => [r.name, r.qty, r2(r.value)])),
        answer: rows.length ? `**Top ${rows.length} selling product(s), ${p.label}** (by sales value):\n${tableMd(['n'], rows.map((r) => [r.name, `${num(r.qty)} units`, inr(r.value)]), 10)}` : `No product sales were recorded for ${p.label}.`,
        assumptions: ['Ranked by invoice value of stock items (before GST), net of sales returns. Services without stock items are not included.'] });
    }
    case 'low_stock': {
      const r = await inventory.reorderSuggestions({ as_of: asOf });
      const rows = r.items.filter((i) => ['out_of_stock', 'reorder_now', 'below_reorder_level'].includes(i.status)).slice(0, 15);
      return out({ data: r.parameters, table: asTable(['Item', 'On hand', 'Status', 'Cover (days)', 'Suggested order'], rows.map((i) => [i.name, i.current_qty, i.status.replace(/_/g, ' '), i.days_of_cover, i.suggested_order_qty])),
        answer: rows.length ? `**${rows.length} item(s) are running out or below their reorder point:**\n${tableMd(['n'], rows.map((i) => [i.name, `${i.current_qty} on hand`, i.status.replace(/_/g, ' '), i.suggested_order_qty ? `order ≈ ${i.suggested_order_qty}` : '']), 6)}` : 'No item is out of stock or below its reorder point.',
        assumptions: r.assumptions });
    }
    case 'overdue': {
      const { receivables } = await getOpenBills();
      const by = new Map();
      for (const b of receivables) { const d = daysBetween(b.due_date, asOf); if (d <= 0) continue; const c = by.get(b.ledger_id) || { name: b.ledger_name, total: 0, oldest: 0, bills: 0 }; c.total += b.pending_amount; c.oldest = Math.max(c.oldest, d); c.bills++; by.set(b.ledger_id, c); }
      const rows = [...by.values()].sort((a, b) => b.total - a.total);
      const total = r2(rows.reduce((s, c) => s + c.total, 0));
      return out({ data: { total_overdue: total, customers: rows.length }, table: asTable(['Customer', 'Overdue (₹)', 'Oldest (days)', 'Bills'], rows.map((c) => [c.name, r2(c.total), c.oldest, c.bills])),
        answer: rows.length ? `**${rows.length} customer(s) have overdue payments, totalling ${inr(total)}** (as at ${asOf}):\n${tableMd(['n'], rows.map((c) => [c.name, inr(c.total), `${c.oldest} days overdue`]), 6)}` : 'No customer has an overdue payment.',
        assumptions: ['Overdue = open bill whose due date has passed as at the date shown (bill-by-bill outstandings).'] });
    }
    case 'supplier_price': {
      const it = await matchItem(q);
      const sp = await inventory.supplierPrices(it ? it.id : null);
      if (it) {
        const x = sp.items[0];
        if (!x) return out({ table: null, answer: `I found no purchase records for **${it.name}**, so I can't compare suppliers.`, assumptions: sp.assumptions });
        return out({ item: it.name, table: asTable(['Supplier', 'Last rate (₹)', 'Average (₹)', 'Purchases', 'Trend'], x.suppliers.map((s) => [s.supplier, s.last_rate, s.avg_rate, s.purchases, s.trend])),
          answer: `**${x.best_supplier}** has the lowest recent price for **${it.name}**: ${inr(x.suppliers[0].last_rate)} per unit` + (x.saving_per_unit_vs_dearest ? `, ${inr(x.saving_per_unit_vs_dearest)} below the dearest supplier.` : ' (the only supplier on record).'), assumptions: sp.assumptions });
      }
      const rows = sp.items.slice(0, 10);
      return out({ table: asTable(['Item', 'Cheapest supplier', 'Last rate (₹)', 'Saving vs dearest (₹)'], rows.map((x) => [x.item, x.best_supplier, x.suppliers[0].last_rate, x.saving_per_unit_vs_dearest])),
        answer: rows.length ? `Cheapest recent supplier per item:\n${tableMd(['n'], rows.map((x) => [x.item, x.best_supplier, inr(x.suppliers[0].last_rate)]), 6)}\n\nName an item to see every supplier compared.` : 'No purchases are recorded yet.', assumptions: sp.assumptions });
    }
    case 'expenses': {
      const p = await ins.parsePeriod(q, asOf, 'this month');
      const rows = (await ins.expensesByLedger(p.from, p.to)).sort((a, b) => b.amount - a.amount).slice(0, 15);
      const total = r2(rows.reduce((s, r) => s + r.amount, 0));
      return out({ period: p, table: asTable(['Expense ledger', 'Amount (₹)', 'Share %'], rows.map((r) => [r.ledger, r.amount, total ? r2((r.amount / total) * 100) : 0])),
        answer: rows.length ? `**Expenses for ${p.label}: ${inr(total)}.** Largest:\n${tableMd(['n'], rows.map((r) => [r.ledger, inr(r.amount)]), 5)}` : `No expenses were recorded for ${p.label}.`,
        assumptions: ['Expenses = ledgers in Direct Expenses and Indirect Expenses. Purchases of goods for resale are treated as cost of goods, not expenses.'] });
    }
    case 'compare_expenses':
    case 'why_expenses': {
      const m = Number(asOf.slice(5, 7)), y = Number(asOf.slice(0, 4));
      const pm = ins.monthShift(y, m, -1); const pr = ins.monthRange(pm.y, pm.m);
      const cur = { from: `${asOf.slice(0, 7)}-01`, to: asOf, label: 'this month so far' };
      const days = Number(asOf.slice(8));
      const prevSame = { from: pr.from, to: `${pr.from.slice(0, 7)}-${String(Math.min(days, Number(pr.to.slice(8)))).padStart(2, '0')}`, label: `${ins.MONTHS[pm.m - 1]} (same ${days} days)` };
      const c = await ins.compareExpenses(cur, prevSame);
      const fullPrev = (await ins.expensesByLedger(pr.from, pr.to)).reduce((s, r) => s + r.amount, 0);
      const dir = c.change >= 0 ? 'higher' : 'lower';
      const head = `**Expenses ${cur.label}: ${inr(c.current.total)}** vs ${inr(c.previous.total)} in ${prevSame.label} — ${inr(Math.abs(c.change))}${c.change_pct !== null ? ` (${Math.abs(c.change_pct)}%)` : ''} ${dir}. Last month in full: ${inr(fullPrev)}.`;
      let why = '';
      if (intent === 'why_expenses') {
        if (!c.change) why = '\n\nThere is no change to explain.';
        else {
          why = `\n\n**What ${c.change > 0 ? 'drove the increase' : 'explains the fall'}:**\n` + c.drivers.map((d) => `• **${d.ledger}** ${d.change > 0 ? '+' : ''}${inr(d.change)}${d.is_new ? ' (nothing booked last month)' : d.change_pct !== null ? ` (${d.change_pct > 0 ? '+' : ''}${d.change_pct}%)` : ''}${d.share_of_change_pct !== null ? ` — ${d.share_of_change_pct}% of the total change` : ''}`).join('\n');
          const big = c.detail.filter((d) => d.largest_entries.length).map((d) => `• ${d.ledger}: ${d.largest_entries.map((e) => `${inr(Math.abs(e.amount))} on ${e.date} (${e.voucher_no}${e.narration ? ', "' + e.narration.slice(0, 40) + '"' : ''})`).join('; ')}`);
          if (big.length) why += `\n\nLargest entries behind these:\n${big.join('\n')}`;
        }
      }
      return out({ data: c, table: asTable(['Expense ledger', 'This month (₹)', 'Last month, same days (₹)', 'Change (₹)', 'Change %'], c.rows.slice(0, 10).map((r) => [r.ledger, r.current, r.previous, r.change, r.change_pct])), answer: head + why,
        assumptions: ['Compares month-to-date with the same number of days last month so a part-month is not compared with a full month.', 'This explains where the money went (which ledgers and entries). It cannot tell you the business reason behind a payment.'] });
    }
    case 'cashflow': {
      const d = /quarter|90/.test(q) ? 90 : /week/.test(q) ? 7 : /60/.test(q) ? 60 : 30;
      const f = await ins.cashflowForecast(asOf, { days: d });
      return out({ data: f, table: asTable(['Week', 'Cash in (₹)', 'Cash out (₹)', 'Closing balance (₹)'], f.weeks.map((w) => [`${w.from} → ${w.to}`, w.inflow, w.outflow, w.closing])),
        answer: `**Cash forecast, next ${f.horizon_days} days:** from ${inr(f.opening_balance)} today to about **${inr(f.closing_balance)}**; lowest point ${inr(f.lowest_point.balance)} around ${f.lowest_point.date}.` + (f.warning ? `\n\n⚠️ ${f.warning}` : '') +
          (f.not_expected.length ? `\n\n${f.not_expected.length} bill(s) over 90 days overdue (${inr(f.not_expected.reduce((s, x) => s + x.amount, 0))}) are not counted as inflows.` : ''), assumptions: f.assumptions });
    }
    case 'trend': {
      const metric = /profit|profitab/.test(q) ? 'net_profit' : /expens/.test(q) ? 'expenses' : 'sales';
      const t = await ins.trends(asOf, { metric });
      const label = metric === 'net_profit' ? 'net profit' : metric;
      if (!t.forecast) return out({ data: t, table: asTable(['Month', 'Sales (₹)', 'Expenses (₹)', 'Net profit (₹)'], t.series.filter((s) => s.complete).map((s) => [s.month, s.sales, s.expenses, s.net_profit])), answer: `**I can't forecast ${label} yet.** ${t.note}`, assumptions: [t.note] });
      return out({ data: t, table: asTable(['Month', 'Predicted (₹)', 'Likely range (₹)'], t.forecast.map((f) => [f.month, f.predicted, `${num(f.low)} to ${num(f.high)}`])),
        answer: `**${label[0].toUpperCase() + label.slice(1)} is ${t.trend.direction}** by about ${inr(Math.abs(t.trend.slope_per_month))} a month (${t.trend.strength} trend, R² ${t.trend.r_squared}).\nNext month: **${inr(t.forecast[0].predicted)}** (likely ${inr(t.forecast[0].low)} to ${inr(t.forecast[0].high)}).`, assumptions: t.assumptions });
    }
    case 'health': {
      const h = await ins.healthScore(asOf);
      return out({ data: h, table: asTable(['Component', 'Weight', 'Value', 'Score'], h.components.map((c) => [c.label, c.weight, c.value === null ? '—' : `${c.value} ${c.unit}`, c.score === null ? 'n/a' : c.score])),
        answer: h.score === null ? '**Not enough data to score the business yet.**' : `**Business health score: ${h.score}/100 (${h.band}).**\n` + h.components.filter((c) => c.usable).sort((a, b) => a.score - b.score).slice(0, 3).map((c) => `• ${c.label}: ${c.score}/100 — ${c.explain}`).join('\n'), assumptions: [h.method] });
    }
    case 'summary': {
      const s = await ins.dailySummary(asOf);
      return out({ data: s, table: asTable(['Priority', 'Recommendation', 'Because'], s.recommendations.map((r) => [r.priority, r.title, r.because])),
        answer: `**Business summary as at ${asOf}**\n• Sales today ${inr(s.today.sales_excl_tax)}; month to date ${inr(s.month_to_date.sales_excl_tax)} (same days last month ${inr(s.month_to_date.sales_prev_month_same_days)})\n• Net profit this month ${inr(s.month_to_date.net_profit)}\n• Cash and bank ${inr(s.cash.total)}; overdue receivables ${inr(s.receivables_overdue.total)}\n• Health score ${s.health.score ?? 'n/a'} (${s.health.band})\n\n**Recommended actions:**\n` +
          (s.recommendations.length ? s.recommendations.slice(0, 5).map((r, i) => `${i + 1}. **${r.title}** — ${r.because}`).join('\n') : 'Nothing needs attention right now.'), assumptions: s.assumptions });
    }
    case 'sales_by_customer': {
      const p = await ins.parsePeriod(q, asOf, 'this month');
      const s = await ins.salesBreakdown(p.from, p.to);
      return out({ period: p, table: asTable(['Customer', 'Sales incl. GST (₹)', 'Vouchers'], s.by_customer.map((c) => [c.name, c.amount, c.vouchers])), answer: s.by_customer.length ? `**Sales by customer, ${p.label}:**\n${tableMd(['n'], s.by_customer.map((c) => [c.name, inr(c.amount)]), 8)}` : `No sales in ${p.label}.`, assumptions: ['Voucher totals including GST, net of credit notes.'] });
    }
    case 'sales_by_month': {
      const series = await ins.monthlySeries(asOf, 12);
      return out({ table: asTable(['Month', 'Sales (₹)', 'Expenses (₹)', 'Net profit (₹)'], series.map((s) => [s.month + (s.complete ? '' : ' (so far)'), s.sales, s.expenses, s.net_profit])), answer: `**Monthly sales, last 12 months** — latest: ${inr(series[series.length - 1].sales)}.`, assumptions: ['Net sales excluding GST.'] });
    }
    default: return null;
  }
}

module.exports = { ask, detectIntent };

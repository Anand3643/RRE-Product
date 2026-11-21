/**
 * RRE Tally — financial-year closing assistant.
 *
 * READ-ONLY. It never posts, changes or locks anything. It (1) checks whether the books are ready to close,
 * (2) produces a closing snapshot (balances, profit, stock) and (3) prepares opening-balance files for the new year.
 */
const { all, get } = require('./db');
const { calculateAllLedgerBalances, calculateProfitLoss } = require('./accountingEngine');
const { listBackups } = require('./backupEngine');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };

async function period(from, to) {

  const fy = (await get('SELECT financial_year_from f FROM company_info LIMIT 1'))?.f;
  const start = from || fy || `${new Date().getFullYear()}-04-01`;
  if (!ISO.test(start) || Number.isNaN(Date.parse(start))) throw bad('from and to must be YYYY-MM-DD.');
  let end = to;
  if (!end) { const d = new Date(Date.parse(start)); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); end = d.toISOString().slice(0, 10); }
  if (!ISO.test(start) || !ISO.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw bad('from and to must be YYYY-MM-DD.');
  if (end < start) throw bad('The end date is before the start date.');
  return { from: start, to: end };
}

const item = (key, title, status, detail, count = 0, fix = null) => ({ key, title, status, detail, count, fix });

/** Checklist: status is pass | warn | fail. Overall ready = no "fail". */
async function readiness(q = {}) {
  const { from, to } = await period(q.from, q.to);
  const out = [];

  const unbal = await all(`SELECT v.id, v.voucher_no, v.date, ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) AS diff
                           FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id WHERE v.date BETWEEN ? AND ?
                           GROUP BY v.id HAVING ABS(SUM(e.debit_amount) - SUM(e.credit_amount)) > 0.01 LIMIT 20`, [from, to]);
  out.push(unbal.length ? item('unbalanced', 'Every voucher balances', 'fail', `${unbal.length} voucher(s) have debits different from credits: ${unbal.slice(0, 5).map((u) => u.voucher_no).join(', ')}.`, unbal.length, 'Correct these vouchers in Day Book.')
    : item('unbalanced', 'Every voucher balances', 'pass', 'All vouchers in the period have equal debits and credits.'));

  const tb = await calculateAllLedgerBalances(to);
  const dr = r2(tb.reduce((s, l) => s + (l.closing_type === 'Dr' ? l.closing_balance : 0), 0)), cr = r2(tb.reduce((s, l) => s + (l.closing_type === 'Cr' ? l.closing_balance : 0), 0));
  out.push(Math.abs(dr - cr) > 0.05 ? item('trial', 'Trial balance agrees', 'fail', `Debits ₹${dr} and credits ₹${cr} differ by ₹${r2(Math.abs(dr - cr))}. Check opening balances.`, 1, 'Review opening balances in the ledger master.')
    : item('trial', 'Trial balance agrees', 'pass', `Debits and credits both ₹${dr}.`));

  const susp = tb.filter((l) => l.group_name === 'Suspense A/c' && l.closing_balance > 0.005);
  out.push(susp.length ? item('suspense', 'Suspense is cleared', 'warn', `${susp.map((s) => `${s.name} ₹${r2(s.closing_balance)} ${s.closing_type}`).join('; ')} still sits in Suspense.`, susp.length, 'Move these amounts to the right ledgers.')
    : item('suspense', 'Suspense is cleared', 'pass', 'Nothing left in Suspense.'));

  let bankN = 0;
  try { bankN = (await get(`SELECT COUNT(*) c FROM bank_statement_lines WHERE status = 'unmatched' AND is_duplicate = 0 AND line_date BETWEEN ? AND ?`, [from, to])).c; } catch (e) { /* no statements imported */ }
  out.push(bankN ? item('bank', 'Bank statements reconciled', 'warn', `${bankN} imported bank line(s) are not matched to any voucher.`, bankN, 'Open Banking and match or ignore them.')
    : item('bank', 'Bank statements reconciled', 'pass', 'No unmatched bank lines in the period.'));

  const drafts = (await get(`SELECT COUNT(*) c FROM recurring_drafts WHERE status = 'pending' AND due_date <= ?`, [to])).c;
  out.push(drafts ? item('recurring', 'Recurring vouchers confirmed', 'warn', `${drafts} recurring voucher(s) are waiting to be confirmed or skipped.`, drafts, 'Review them in the Data menu.')
    : item('recurring', 'Recurring vouchers confirmed', 'pass', 'No recurring vouchers are waiting.'));

  const appr = (await get(`SELECT COUNT(*) c FROM approval_requests WHERE status = 'pending'`)).c;
  out.push(appr ? item('approvals', 'No vouchers waiting for approval', 'fail', `${appr} voucher(s) are held for approval and are NOT in the books yet.`, appr, 'Approve or reject them in the Data menu.')
    : item('approvals', 'No vouchers waiting for approval', 'pass', 'Nothing is held for approval.'));

  const neg = await all(`SELECT s.name, ROUND(s.opening_qty + COALESCE(SUM(CASE WHEN i.direction='IN' THEN i.quantity ELSE -i.quantity END), 0), 3) AS qty
                         FROM stock_items s LEFT JOIN inventory_entries i ON i.stock_item_id = s.id LEFT JOIN vouchers v ON v.id = i.voucher_id AND v.date <= ?
                         WHERE s.is_active = 1 GROUP BY s.id HAVING qty < 0 ORDER BY qty LIMIT 20`, [to]).catch(() => []);
  out.push(neg.length ? item('stock', 'No negative stock', 'warn', `${neg.length} item(s) show negative stock, e.g. ${neg.slice(0, 3).map((n) => `${n.name} (${n.qty})`).join(', ')}.`, neg.length, 'Check purchase entries or the opening quantity.')
    : item('stock', 'No negative stock', 'pass', 'No item has negative stock.'));

  const after = (await get('SELECT COUNT(*) c FROM vouchers WHERE date > ?', [to])).c;
  out.push(after ? item('future', 'No vouchers dated after year end', 'warn', `${after} voucher(s) are dated after ${to}. They will belong to the next year.`, after)
    : item('future', 'No vouchers dated after year end', 'pass', 'All vouchers fall within the year.'));

  const latest = (() => { try { return listBackups()[0]; } catch (e) { return null; } })();
  const days = latest ? (Date.now() - Date.parse(latest.created_at)) / 86400000 : Infinity;
  out.push(days > 1 ? item('backup', 'Fresh backup taken', 'warn', latest ? `The latest backup is ${Math.floor(days)} day(s) old.` : 'No backup exists.', 1, 'Take a backup before closing the year.')
    : item('backup', 'Fresh backup taken', 'pass', 'A backup was taken within the last day.'));

  const summary = { pass: out.filter((o) => o.status === 'pass').length, warn: out.filter((o) => o.status === 'warn').length, fail: out.filter((o) => o.status === 'fail').length };
  return { from, to, ready: summary.fail === 0, summary, checks: out };
}

/** Closing balances, profit and stock at `to`. Stock value follows the existing weighted-average method. */
async function snapshot(q = {}) {
  const { from, to } = await period(q.from, q.to);
  const bal = await calculateAllLedgerBalances(to);
  const pl = await calculateProfitLoss(to);
  const net = r2(pl.indirect.net_profit);
  const stock = await all(`SELECT s.id, s.name, u.symbol AS uom, s.opening_qty, s.opening_rate, s.opening_val, s.standard_cost,
        COALESCE(SUM(CASE WHEN i.direction='IN' THEN i.quantity END), 0) AS in_qty, COALESCE(SUM(CASE WHEN i.direction='IN' THEN i.amount END), 0) AS in_val,
        COALESCE(SUM(CASE WHEN i.direction='OUT' THEN i.quantity END), 0) AS out_qty
        FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id LEFT JOIN inventory_entries i ON i.stock_item_id = s.id
        LEFT JOIN vouchers v ON v.id = i.voucher_id WHERE s.is_active = 1 AND (v.id IS NULL OR v.date <= ?) GROUP BY s.id ORDER BY s.name`, [to]);
  const stockRows = stock.map((s) => {
    const qty = r2(s.opening_qty + s.in_qty - s.out_qty), availQ = s.opening_qty + s.in_qty;
    const rate = availQ > 0 ? (s.opening_val + s.in_val) / availQ : (s.opening_rate || s.standard_cost || 0);
    return { id: s.id, name: s.name, uom: s.uom, closing_qty: qty, rate: r2(rate), value: r2(Math.max(qty, 0) * rate) };
  });
  const stockTotal = r2(stockRows.reduce((t, s) => t + s.value, 0));
  const balanceSheet = bal.filter((l) => l.group_nature === 'Assets' || l.group_nature === 'Liabilities');
  const plLedgers = bal.filter((l) => l.group_nature === 'Income' || l.group_nature === 'Expenses');
  return {
    from, to, net_profit: net, closing_stock_value: stockTotal,
    balance_sheet_ledgers: balanceSheet.filter((l) => l.closing_balance > 0.005).map((l) => ({ id: l.id, name: l.name, group: l.group_name, balance: r2(l.closing_balance), type: l.closing_type })),
    pl_ledgers: plLedgers.filter((l) => l.closing_balance > 0.005).map((l) => ({ id: l.id, name: l.name, group: l.group_name, balance: r2(l.closing_balance), type: l.closing_type })),
    stock: stockRows
  };
}

const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * Opening balances for the new year, as two CSV files. Profit/loss ledgers are NOT carried (they restart at zero); the year's
 * profit is shown as a separate line to add to the capital/reserves ledger. Nothing is written to the books.
 */
async function openingPack(query = {}) {
  const s = await snapshot(query);
  const rows = s.balance_sheet_ledgers.map((l) => [l.name, l.group, l.balance, l.type]);
  rows.push(['Profit & Loss A/c (carry to Capital/Reserves)', 'Capital Account', Math.abs(s.net_profit), s.net_profit >= 0 ? 'Cr' : 'Dr']);
  const ledgersCsv = ['ledger,group,opening_balance,type', ...rows.map((r) => r.map(q).join(','))].join('\n');
  const stockCsv = ['item,uom,opening_qty,opening_rate,opening_value', ...s.stock.filter((x) => x.closing_qty > 0).map((x) => [x.name, x.uom, x.closing_qty, x.rate, x.value].map(q).join(','))].join('\n');
  return { from: s.from, to: s.to, ledgers_csv: ledgersCsv, stock_csv: stockCsv, net_profit: s.net_profit, note: 'Closing stock is not a ledger: it is carried through the stock file. Outstanding bills must be re-entered or imported against each party in the new year.' };
}

module.exports = { readiness, snapshot, openingPack };

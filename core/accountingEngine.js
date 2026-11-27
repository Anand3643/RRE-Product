const { all, get, run } = require('./db');

// 1. Calculate net closing balance for all ledgers
async function calculateAllLedgerBalances(asOfDate = null) {
  let dateClause = '';
  const params = [];
  // "as on a date": only entries of vouchers dated up to it. The condition belongs in the JOIN: in a WHERE it dropped every ledger
  // without entries by then, together with its opening balance
  if (asOfDate) {
    dateClause = 'AND e.voucher_id IN (SELECT id FROM vouchers WHERE date <= ?)';
    params.push(asOfDate);
  }

  const query = `
    SELECT 
      l.id, l.name, l.opening_balance, l.opening_balance_type,
      g.id as group_id, g.name as group_name, g.nature as group_nature, g.affects_gross_profit,
      COALESCE(SUM(e.debit_amount), 0) as total_debit,
      COALESCE(SUM(e.credit_amount), 0) as total_credit
    FROM ledgers l
    JOIN account_groups g ON l.group_id = g.id
    LEFT JOIN ledger_entries e ON l.id = e.ledger_id ${dateClause}
    GROUP BY l.id
    ORDER BY g.nature, g.name, l.name
  `;

  const rows = await all(query, params);

  return rows.map((l) => {
    const opDr = l.opening_balance_type === 'Dr' ? l.opening_balance : 0;
    const opCr = l.opening_balance_type === 'Cr' ? l.opening_balance : 0;

    const netDebit = opDr + l.total_debit;
    const netCredit = opCr + l.total_credit;

    let closingBalance = 0;
    let closingType = 'Dr';

    if (netDebit >= netCredit) {
      closingBalance = netDebit - netCredit;
      closingType = 'Dr';
    } else {
      closingBalance = netCredit - netDebit;
      closingType = 'Cr';
    }

    return {
      ...l,
      net_debit: netDebit,
      net_credit: netCredit,
      closing_balance: closingBalance,
      closing_type: closingType
    };
  });
}

// 2. Weighted Average Inventory Valuation
async function calculateClosingStockValuation(asOfDate = null) {
  // as on a date: the stock movements of vouchers dated up to it
  const upTo = asOfDate ? 'AND i.voucher_id IN (SELECT id FROM vouchers WHERE date <= ?)' : '';
  const items = await all(`
    SELECT s.id, s.name, s.opening_qty, s.opening_rate, s.opening_val, s.standard_cost, s.hsn_code, s.gst_rate,
      u.symbol as uom_symbol,
      COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN i.quantity ELSE 0 END), 0) as inward_qty,
      COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN i.amount ELSE 0 END), 0) as inward_val,
      COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.quantity ELSE 0 END), 0) as outward_qty,
      COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.amount ELSE 0 END), 0) as outward_val
    FROM stock_items s
    JOIN units_of_measure u ON s.uom_id = u.id
    LEFT JOIN inventory_entries i ON s.id = i.stock_item_id ${upTo}
    GROUP BY s.id
  `, asOfDate ? [asOfDate] : []);

  let totalStockValuation = 0;
  const detailed = items.map((it) => {
    const closingQty = it.opening_qty + it.inward_qty - it.outward_qty;
    const totalAvailQty = it.opening_qty + it.inward_qty;
    const totalAvailVal = it.opening_val + it.inward_val;
    const weightedAvgRate = totalAvailQty > 0 ? (totalAvailVal / totalAvailQty) : (it.opening_rate || it.standard_cost || 0);

    const valuation = closingQty * weightedAvgRate;
    totalStockValuation += valuation;

    return {
      ...it,
      closing_qty: closingQty,
      valuation_rate: weightedAvgRate,
      closing_val: valuation
    };
  });

  return { totalStockValuation, items: detailed };
}

// 3. Profit & Loss / Trading Engine
/** income / expense ledgers for a PERIOD: only the entries of vouchers dated from..to (a period's profit starts from zero) */
async function calculatePeriodBalances(from, to) {
  const params = [from]; let upTo = '';
  if (to) { upTo = 'AND date <= ?'; params.push(to); }
  const rows = await all(`
    SELECT l.id, l.name, g.id as group_id, g.name as group_name, g.nature as group_nature,
      COALESCE(SUM(e.debit_amount), 0) as total_debit, COALESCE(SUM(e.credit_amount), 0) as total_credit
    FROM ledgers l JOIN account_groups g ON l.group_id = g.id
    LEFT JOIN ledger_entries e ON l.id = e.ledger_id AND e.voucher_id IN (SELECT id FROM vouchers WHERE date >= ? ${upTo})
    GROUP BY l.id ORDER BY g.nature, g.name, l.name`, params);
  // an opening balance on an income / expense ledger belongs to the period in which the books begin (as in Tally); later periods start
  // from zero (that profit was earlier years')
  const co = await get('SELECT books_beginning_from, financial_year_from FROM company_info LIMIT 1').catch(() => null);
  const booksBegin = (co && (co.books_beginning_from || co.financial_year_from)) || null;
  const withOpening = !booksBegin || from <= booksBegin;
  const ob = withOpening ? new Map((await all('SELECT id, opening_balance, opening_balance_type FROM ledgers')).map((x) => [x.id, (x.opening_balance_type === 'Cr' ? -1 : 1) * (Number(x.opening_balance) || 0)])) : new Map();
  return rows.map((l) => {
    const net = (ob.get(l.id) || 0) + l.total_debit - l.total_credit;
    return { ...l, opening_balance: 0, opening_balance_type: 'Dr', net_debit: l.total_debit, net_credit: l.total_credit, closing_balance: Math.abs(net), closing_type: net >= 0 ? 'Dr' : 'Cr' };
  });
}
/** the period an income / expense ledger's balance is counted from: its opening balance only in the period where the books begin */
async function nominalOpeningIncluded(from) {
  if (!from) return true;
  const co = await get('SELECT books_beginning_from, financial_year_from FROM company_info LIMIT 1').catch(() => null);
  const booksBegin = (co && (co.books_beginning_from || co.financial_year_from)) || null;
  return !booksBegin || from <= booksBegin;
}
const dayBefore = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

/**
 * Profit & Loss up to `date` (all of it when none). With `from`: for the period from..date only — the incomes and expenses of that
 * period, opening stock = the stock as on the day before it, closing stock = the stock as on `date`.
 */
async function calculateProfitLoss(date = null, from = null) {
  const ledgers = from ? await calculatePeriodBalances(from, date) : await calculateAllLedgerBalances(date);
  const { totalStockValuation } = await calculateClosingStockValuation(date);

  const openingStock = from
    ? (await calculateClosingStockValuation(dayBefore(from))).totalStockValuation
    : ((await get('SELECT SUM(opening_val) as total FROM stock_items')).total || 0);
  const closingStock = totalStockValuation;

  let salesTotal = 0, purchaseTotal = 0, directExpensesTotal = 0, directIncomesTotal = 0;
  let indirectExpensesTotal = 0, indirectIncomesTotal = 0;

  const salesList = [], purchaseList = [], directExpList = [], directIncList = [];
  const indirectExpList = [], indirectIncList = [];

  // Each ledger counts with its SIGN: an income ledger adds its credit balance and subtracts a debit balance (a "Sales Return"
  // ledger under Sales Accounts reduces sales), an expense ledger the other way round (a "Purchase Return" ledger reduces purchases).
  // Adding every balance as positive made a sales return INCREASE sales.
  let salesReturns = 0, purchaseReturns = 0;
  ledgers.forEach((l) => {
    const val = l.closing_balance;
    if (val === 0) return;
    const cr = l.closing_type === 'Cr' ? val : -val; // + = credit balance
    const dr = -cr;                                  // + = debit balance
    const item = (amount) => ({ ...l, closing_balance: amount, unsigned_balance: val });

    if (l.group_name === 'Sales Accounts') { salesTotal += cr; if (cr < 0) salesReturns += -cr; salesList.push(item(cr)); }
    else if (l.group_name === 'Purchase Accounts') { purchaseTotal += dr; if (dr < 0) purchaseReturns += -dr; purchaseList.push(item(dr)); }
    else if (l.group_name === 'Direct Expenses') { directExpensesTotal += dr; directExpList.push(item(dr)); }
    else if (l.group_name === 'Direct Incomes') { directIncomesTotal += cr; directIncList.push(item(cr)); }
    else if (l.group_name === 'Indirect Expenses') { indirectExpensesTotal += dr; indirectExpList.push(item(dr)); }
    else if (l.group_name === 'Indirect Incomes') { indirectIncomesTotal += cr; indirectIncList.push(item(cr)); }
  });

  const cogs = openingStock + purchaseTotal + directExpensesTotal - closingStock;
  const grossProfit = salesTotal + closingStock + directIncomesTotal - (openingStock + purchaseTotal + directExpensesTotal);
  const netProfit = grossProfit + indirectIncomesTotal - indirectExpensesTotal;

  return {
    cogs,
    trading: {
      opening_stock: openingStock,
      purchases: purchaseTotal,
      purchase_items: purchaseList,
      direct_expenses: directExpensesTotal,
      direct_expense_items: directExpList,
      sales: salesTotal,                       // net of sales returns
      gross_sales: salesTotal + salesReturns,
      sales_returns: salesReturns,
      purchase_returns: purchaseReturns,
      sales_items: salesList,
      closing_stock: closingStock,
      direct_incomes: directIncomesTotal,
      gross_profit: grossProfit
    },
    indirect: {
      gross_profit: grossProfit,
      indirect_incomes: indirectIncomesTotal,
      indirect_income_items: indirectIncList,
      indirect_expenses: indirectExpensesTotal,
      indirect_expense_items: indirectExpList,
      net_profit: netProfit
    }
  };
}

// 4. Balance Sheet Engine
async function calculateBalanceSheet(date = null) {
  const plData = await calculateProfitLoss(date);
  const netProfit = plData.indirect.net_profit;
  const { totalStockValuation } = await calculateClosingStockValuation(date);
  const ledgers = await calculateAllLedgerBalances(date);

  const liabilities = {
    capital_account: { total: 0, items: [] },
    loans: { total: 0, items: [] },
    current_liabilities: { total: 0, items: [] }
  };

  const assets = {
    fixed_assets: { total: 0, items: [] },
    investments: { total: 0, items: [] },
    current_assets: { total: 0, items: [] }
  };

  ledgers.forEach((l) => {
    const val = l.closing_balance;
    if (val === 0) return;

    const netLiab = l.closing_type === 'Cr' ? val : -val;
    const netAsset = l.closing_type === 'Dr' ? val : -val;

    if (l.group_nature === 'Liabilities') {
      if (l.group_name === 'Capital Account' || l.group_name === 'Reserves & Surplus') {
        liabilities.capital_account.total += netLiab;
        liabilities.capital_account.items.push(l);
      } else if (l.group_name.includes('Loan') || l.group_name.includes('Bank OD')) {
        liabilities.loans.total += netLiab;
        liabilities.loans.items.push(l);
      } else {
        liabilities.current_liabilities.total += netLiab;
        liabilities.current_liabilities.items.push(l);
      }
    } else if (l.group_nature === 'Assets') {
      if (l.group_name === 'Fixed Assets') {
        assets.fixed_assets.total += netAsset;
        assets.fixed_assets.items.push(l);
      } else if (l.group_name === 'Investments') {
        assets.investments.total += netAsset;
        assets.investments.items.push(l);
      } else if (l.group_name !== 'Stock-in-hand') {
        assets.current_assets.total += netAsset;
        assets.current_assets.items.push(l);
      }
    }
  });

  // Dynamic Closing stock added to Current Assets
  assets.current_assets.total += totalStockValuation;
  assets.current_assets.items.unshift({
    name: 'Closing Stock (Valuation)',
    group_name: 'Stock-in-hand',
    closing_balance: totalStockValuation,
    closing_type: 'Dr'
  });

  // "Difference in opening balances" (as Tally shows it): opening balances that do not balance among themselves, opening stock
  // included (stock entered with an opening value is an asset with no matching capital). Assets − liabilities always equals exactly
  // this, so it is shown on the short side: the sheet balances and the difference stays visible to be corrected.
  // (ledgers under Stock-in-hand are left out: the sheet shows stock at the stock items' value instead)
  const ob = await get("SELECT COALESCE(SUM(CASE WHEN l.opening_balance_type = 'Cr' THEN -l.opening_balance ELSE l.opening_balance END), 0) AS n FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name <> 'Stock-in-hand'");
  const os = await get('SELECT COALESCE(SUM(opening_val), 0) AS n FROM stock_items');
  const openingDifference = Math.round(((Number(ob.n) || 0) + (Number(os.n) || 0)) * 100) / 100; // + = more on the debit (assets) side

  let totalLiabilities = liabilities.capital_account.total + netProfit + liabilities.loans.total + liabilities.current_liabilities.total;
  let totalAssets = assets.fixed_assets.total + assets.investments.total + assets.current_assets.total;
  if (openingDifference > 0) totalLiabilities += openingDifference;
  else if (openingDifference < 0) totalAssets += -openingDifference;

  return {
    opening_difference: { amount: Math.abs(openingDifference), side: openingDifference > 0 ? 'liabilities' : openingDifference < 0 ? 'assets' : null,
      note: openingDifference ? 'Opening balances (including opening stock) do not balance: correct them in Ledger / Stock Item alteration (for example the Capital Account).' : null },
    liabilities: {
      capital_total: liabilities.capital_account.total,
      capital_items: liabilities.capital_account.items,
      net_profit: netProfit,
      loans_total: liabilities.loans.total,
      loans_items: liabilities.loans.items,
      current_liabilities_total: liabilities.current_liabilities.total,
      current_liabilities_items: liabilities.current_liabilities.items,
      total: totalLiabilities
    },
    assets: {
      fixed_assets_total: assets.fixed_assets.total,
      fixed_assets_items: assets.fixed_assets.items,
      investments_total: assets.investments.total,
      investments_items: assets.investments.items,
      current_assets_total: assets.current_assets.total,
      current_assets_items: assets.current_assets.items,
      total: totalAssets
    },
    difference: Math.abs(totalLiabilities - totalAssets)
  };
}

// 5. Ratio Analysis Engine
async function calculateRatioAnalysis() {
  const ledgers = await calculateAllLedgerBalances();
  const { totalStockValuation } = await calculateClosingStockValuation();

  let currentAssets = totalStockValuation;
  let currentLiabilities = 0;
  let totalLoans = 0;
  let capitalAndReserves = 0;
  let sales = 0;
  let purchases = 0;
  let directExp = 0;
  let indirectExp = 0;
  let indirectInc = 0;

  const opStockRow = await get('SELECT SUM(opening_val) as total FROM stock_items');
  const openingStock = opStockRow.total || 0;

  ledgers.forEach((l) => {
    const val = l.closing_balance;
    if (val === 0) return;

    const netLiab = l.closing_type === 'Cr' ? val : -val;
    const netAsset = l.closing_type === 'Dr' ? val : -val;

    if (l.group_nature === 'Assets' && l.group_id !== 4 && l.group_id !== 5 && l.group_id !== 21) {
      currentAssets += netAsset;
    }
    if (l.group_nature === 'Liabilities' && l.group_id !== 1 && l.group_id !== 2 && l.group_id !== 28) {
      currentLiabilities += netLiab;
    }
    if (l.group_id === 2 || l.group_id === 22 || l.group_id === 23) {
      totalLoans += netLiab;
    }
    if (l.group_id === 1 || l.group_id === 28) {
      capitalAndReserves += netLiab;
    }
    // signed, as in the Profit & Loss (a return ledger reduces its group)
    if (l.group_name === 'Sales Accounts') sales += netLiab;
    if (l.group_name === 'Purchase Accounts') purchases += netAsset;
    if (l.group_name === 'Direct Expenses') directExp += netAsset;
    if (l.group_name === 'Indirect Expenses') indirectExp += netAsset;
    if (l.group_name === 'Indirect Incomes') indirectInc += netLiab;
  });

  const cogs = openingStock + purchases + directExp - totalStockValuation;
  const grossProfit = sales - cogs;
  const netProfit = grossProfit + indirectInc - indirectExp;

  const quickAssets = currentAssets - totalStockValuation;
  const currentRatio = currentLiabilities > 0 ? (currentAssets / currentLiabilities) : currentAssets;
  const quickRatio = currentLiabilities > 0 ? (quickAssets / currentLiabilities) : quickAssets;
  const debtEquityRatio = capitalAndReserves > 0 ? (totalLoans / capitalAndReserves) : 0;
  const workingCapital = currentAssets - currentLiabilities;
  const grossProfitMargin = sales > 0 ? ((grossProfit / sales) * 100) : 0;
  const netProfitMargin = sales > 0 ? ((netProfit / sales) * 100) : 0;
  const avgInventory = (openingStock + totalStockValuation) / 2;
  const inventoryTurnover = avgInventory > 0 ? (cogs / avgInventory) : 0;

  return {
    current_assets: currentAssets,
    current_liabilities: currentLiabilities,
    working_capital: workingCapital,
    quick_assets: quickAssets,
    closing_stock: totalStockValuation,
    sales,
    gross_profit: grossProfit,
    net_profit: netProfit,
    ratios: {
      current_ratio: { value: parseFloat(currentRatio.toFixed(2)), benchmark: '2.00', status: currentRatio >= 1.5 ? 'Good' : 'Low' },
      quick_ratio: { value: parseFloat(quickRatio.toFixed(2)), benchmark: '1.00', status: quickRatio >= 1.0 ? 'Good' : 'Low' },
      debt_equity: { value: parseFloat(debtEquityRatio.toFixed(2)), benchmark: '< 1.50', status: debtEquityRatio < 1.5 ? 'Healthy' : 'High Risk' },
      gross_profit_pct: { value: parseFloat(grossProfitMargin.toFixed(2)), unit: '%' },
      net_profit_pct: { value: parseFloat(netProfitMargin.toFixed(2)), unit: '%' },
      inventory_turnover: { value: parseFloat(inventoryTurnover.toFixed(2)), benchmark: '> 4.00' }
    }
  };
}

module.exports = {
  calculateAllLedgerBalances,
  calculateClosingStockValuation,
  calculateProfitLoss,
  calculateBalanceSheet,
  calculateRatioAnalysis,
  nominalOpeningIncluded
};

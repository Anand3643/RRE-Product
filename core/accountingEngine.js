const { all, get, run } = require('./db');

// 1. Calculate net closing balance for all ledgers
async function calculateAllLedgerBalances(asOfDate = null) {
  let dateClause = '';
  const params = [];
  if (asOfDate) {
    dateClause = 'WHERE v.date <= ?';
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
    LEFT JOIN ledger_entries e ON l.id = e.ledger_id
    LEFT JOIN vouchers v ON e.voucher_id = v.id ${dateClause}
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
async function calculateClosingStockValuation() {
  const items = await all(`
    SELECT s.id, s.name, s.opening_qty, s.opening_rate, s.opening_val, s.standard_cost, s.hsn_code, s.gst_rate,
      u.symbol as uom_symbol,
      COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN i.quantity ELSE 0 END), 0) as inward_qty,
      COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN i.amount ELSE 0 END), 0) as inward_val,
      COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.quantity ELSE 0 END), 0) as outward_qty,
      COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.amount ELSE 0 END), 0) as outward_val
    FROM stock_items s
    JOIN units_of_measure u ON s.uom_id = u.id
    LEFT JOIN inventory_entries i ON s.id = i.stock_item_id
    GROUP BY s.id
  `);

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
async function calculateProfitLoss(date = null) {
  const ledgers = await calculateAllLedgerBalances(date);
  const { totalStockValuation } = await calculateClosingStockValuation();

  const openingStockRow = await get('SELECT SUM(opening_val) as total FROM stock_items');
  const openingStock = openingStockRow.total || 0;
  const closingStock = totalStockValuation;

  let salesTotal = 0, purchaseTotal = 0, directExpensesTotal = 0, directIncomesTotal = 0;
  let indirectExpensesTotal = 0, indirectIncomesTotal = 0;

  const salesList = [], purchaseList = [], directExpList = [], directIncList = [];
  const indirectExpList = [], indirectIncList = [];

  ledgers.forEach((l) => {
    const val = l.closing_balance;
    if (val === 0) return;

    if (l.group_name === 'Sales Accounts') { salesTotal += val; salesList.push(l); }
    else if (l.group_name === 'Purchase Accounts') { purchaseTotal += val; purchaseList.push(l); }
    else if (l.group_name === 'Direct Expenses') { directExpensesTotal += val; directExpList.push(l); }
    else if (l.group_name === 'Direct Incomes') { directIncomesTotal += val; directIncList.push(l); }
    else if (l.group_name === 'Indirect Expenses') { indirectExpensesTotal += val; indirectExpList.push(l); }
    else if (l.group_name === 'Indirect Incomes') { indirectIncomesTotal += val; indirectIncList.push(l); }
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
      sales: salesTotal,
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
  const { totalStockValuation } = await calculateClosingStockValuation();
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

  const totalLiabilities = liabilities.capital_account.total + netProfit + liabilities.loans.total + liabilities.current_liabilities.total;
  const totalAssets = assets.fixed_assets.total + assets.investments.total + assets.current_assets.total;

  return {
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
    if (l.group_name === 'Sales Accounts') sales += val;
    if (l.group_name === 'Purchase Accounts') purchases += val;
    if (l.group_name === 'Direct Expenses') directExp += val;
    if (l.group_name === 'Indirect Expenses') indirectExp += val;
    if (l.group_name === 'Indirect Incomes') indirectInc += val;
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
  calculateRatioAnalysis
};

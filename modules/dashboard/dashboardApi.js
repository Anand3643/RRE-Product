const express = require('express');
const router = express.Router();
const { calculateBalanceSheet, calculateProfitLoss, calculateClosingStockValuation } = require('../../core/accountingEngine');
const { all, get } = require('../../core/db');

// TallyPrime Modern Dashboard Data Endpoint
router.get('/tiles', async (req, res) => {
  try {
    const bs = await calculateBalanceSheet();
    const pl = await calculateProfitLoss();
    const stock = await calculateClosingStockValuation();

    // 1. Debtors Outstandings (drilldown-duerecv)
    const debtors = await all(`
      SELECT l.id, l.name, l.opening_balance,
        COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0) as balance
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      LEFT JOIN ledger_entries e ON l.id = e.ledger_id
      WHERE g.name = 'Sundry Debtors'
      GROUP BY l.id
      HAVING balance > 0
      ORDER BY balance DESC
    `);
    const totalDebtors = debtors.reduce((sum, d) => sum + d.balance, 0);

    // 2. Creditors Outstandings (drilldown-duepaya)
    const creditors = await all(`
      SELECT l.id, l.name, l.opening_balance,
        COALESCE(SUM(e.credit_amount), 0) - COALESCE(SUM(e.debit_amount), 0) as balance
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      LEFT JOIN ledger_entries e ON l.id = e.ledger_id
      WHERE g.name = 'Sundry Creditors'
      GROUP BY l.id
      HAVING balance > 0
      ORDER BY balance DESC
    `);
    const totalCreditors = creditors.reduce((sum, c) => sum + c.balance, 0);

    // 3. Cash & Bank Liquid Balances (drilldown-fundsflow)
    const bankAccounts = await all(`
      SELECT l.name, g.name as group_name,
        l.opening_balance + COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0) as balance
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      LEFT JOIN ledger_entries e ON l.id = e.ledger_id
      WHERE g.name IN ('Bank Accounts', 'Cash-in-hand')
      GROUP BY l.id
    `);
    const totalCashBank = bankAccounts.reduce((sum, b) => sum + b.balance, 0);

    // 4. Monthly Inflow vs Outflow
    const cashMovements = await all(`
      SELECT 
        COALESCE(SUM(CASE WHEN e.entry_type = 'Dr' THEN e.debit_amount ELSE 0 END), 0) as total_inflow,
        COALESCE(SUM(CASE WHEN e.entry_type = 'Cr' THEN e.credit_amount ELSE 0 END), 0) as total_outflow
      FROM ledger_entries e
      JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      WHERE g.name IN ('Bank Accounts', 'Cash-in-hand')
    `);
    const inflow = cashMovements[0] ? cashMovements[0].total_inflow : 0;
    const outflow = cashMovements[0] ? cashMovements[0].total_outflow : 0;

    // 5. Cost Centre Breakup (drilldown-costcentre)
    const costCentres = await all(`
      SELECT c.name, COALESCE(SUM(e.debit_amount), 0) as total_expenditure
      FROM cost_centres c
      LEFT JOIN ledger_entries e ON c.id = e.cost_centre_id
      GROUP BY c.id
      ORDER BY total_expenditure DESC
    `);

    res.json({
      success: true,
      data: {
        balance_sheet_tile: {
          drilldown: 'drilldown-BS',
          total_assets: bs.assets.total,
          total_liabilities: bs.liabilities.total,
          fixed_assets: bs.assets.fixed_assets_total,
          current_assets: bs.assets.current_assets_total,
          working_capital: bs.assets.current_assets_total - bs.liabilities.current_liabilities_total
        },
        profit_loss_tile: {
          drilldown: 'drilldown-PandL',
          sales: pl.trading.sales,
          cogs: pl.cogs,
          gross_profit: pl.trading.gross_profit,
          net_profit: pl.indirect.net_profit,
          gp_margin_pct: pl.trading.sales > 0 ? parseFloat(((pl.trading.gross_profit / pl.trading.sales) * 100).toFixed(2)) : 0
        },
        debtors_tile: {
          drilldown: 'drilldown-duerecv',
          total: totalDebtors,
          count: debtors.length,
          top_debtors: debtors.slice(0, 4)
        },
        creditors_tile: {
          drilldown: 'drilldown-duepaya',
          total: totalCreditors,
          count: creditors.length,
          top_creditors: creditors.slice(0, 4)
        },
        funds_flow_tile: {
          drilldown: 'drilldown-fundsflow',
          cash_bank_balance: totalCashBank,
          inflow,
          outflow,
          net_flow: inflow - outflow,
          accounts: bankAccounts
        },
        stock_tile: {
          drilldown: 'drilldown-stock',
          total_valuation: stock.totalStockValuation,
          item_count: stock.items.length,
          top_items: stock.items.slice(0, 4)
        },
        cost_centre_tile: {
          drilldown: 'drilldown-costcentre',
          cost_centres: costCentres
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

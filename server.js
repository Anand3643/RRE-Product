const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, all, get, run } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000; // Running cleanly on port 4000

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. COMPANY & GATEWAY INFO
// ==========================================
app.get('/api/gateway/info', async (req, res) => {
  try {
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    const lastVoucher = await get('SELECT date, voucher_no, voucher_type FROM vouchers ORDER BY date DESC, id DESC LIMIT 1');
    const totalVouchers = await get('SELECT COUNT(*) as count FROM vouchers');

    res.json({
      success: true,
      data: {
        company: comp || { name: 'Ramraj Enterprises' },
        current_date: lastVoucher ? lastVoucher.date : '2026-06-01',
        financial_year: '1-Apr-2026 to 31-Mar-2027',
        last_voucher: lastVoucher || null,
        total_vouchers: totalVouchers.count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. MASTERS: GROUPS, LEDGERS & STOCK ITEMS
// ==========================================
app.get('/api/masters/groups', async (req, res) => {
  try {
    const groups = await all('SELECT * FROM account_groups ORDER BY nature, name');
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/ledgers', async (req, res) => {
  try {
    const ledgers = await all(`
      SELECT l.*, g.name as group_name, g.nature as group_nature
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      ORDER BY l.name ASC
    `);
    res.json({ success: true, data: ledgers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/masters/ledgers', async (req, res) => {
  try {
    const { name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address } = req.body;
    if (!name || !group_id) {
      return res.status(400).json({ success: false, error: 'Ledger name and group are required' });
    }

    const result = await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, group_id,
        parseFloat(opening_balance) || 0,
        opening_balance_type || 'Dr',
        gstin || '', pan || '',
        state || 'Tamil Nadu', state_code || '33',
        address || ''
      ]
    );

    res.json({ success: true, id: result.lastID, message: `Ledger '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/stock-items', async (req, res) => {
  try {
    const items = await all(`
      SELECT s.*, g.name as group_name, u.symbol as uom_symbol
      FROM stock_items s
      JOIN stock_groups g ON s.stock_group_id = g.id
      JOIN units_of_measure u ON s.uom_id = u.id
      ORDER BY s.name ASC
    `);
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/masters/stock-items', async (req, res) => {
  try {
    const { name, stock_group_id, uom_id, hsn_code, gst_rate, standard_cost, standard_price, opening_qty, opening_rate } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Item name is required' });

    const oQty = parseFloat(opening_qty) || 0;
    const oRate = parseFloat(opening_rate) || 0;
    const oVal = oQty * oRate;

    const result = await run(
      `INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, standard_cost, standard_price, opening_qty, opening_rate, opening_val)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, stock_group_id || 1, uom_id || 1, hsn_code || '84148011',
        parseFloat(gst_rate) || 18,
        parseFloat(standard_cost) || 0,
        parseFloat(standard_price) || 0,
        oQty, oRate, oVal
      ]
    );

    res.json({ success: true, id: result.lastID, message: `Stock Item '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. VOUCHER CREATION & TRANSACTION ENGINE
// ==========================================
// List vouchers
app.get('/api/vouchers', async (req, res) => {
  try {
    const { type, from_date, to_date } = req.query;
    let sql = `
      SELECT v.*, p.name as party_name
      FROM vouchers v
      LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (type) {
      sql += ' AND v.voucher_type = ?';
      params.push(type);
    }
    if (from_date) {
      sql += ' AND v.date >= ?';
      params.push(from_date);
    }
    if (to_date) {
      sql += ' AND v.date <= ?';
      params.push(to_date);
    }

    sql += ' ORDER BY v.date DESC, v.id DESC';
    const vouchers = await all(sql, params);
    res.json({ success: true, data: vouchers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single voucher detail with double-entry lines and inventory allocations
app.get('/api/vouchers/:id', async (req, res) => {
  try {
    const voucher = await get(`
      SELECT v.*, p.name as party_name
      FROM vouchers v
      LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE v.id = ?
    `, [req.params.id]);

    if (!voucher) return res.status(404).json({ success: false, error: 'Voucher not found' });

    const entries = await all(`
      SELECT e.*, l.name as ledger_name, g.nature as ledger_nature
      FROM ledger_entries e
      JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      WHERE e.voucher_id = ?
      ORDER BY e.entry_type DESC, e.id ASC
    `, [voucher.id]);

    const inventory = await all(`
      SELECT i.*, s.name as item_name, s.hsn_code, u.symbol as uom_symbol
      FROM inventory_entries i
      JOIN stock_items s ON i.stock_item_id = s.id
      JOIN units_of_measure u ON s.uom_id = u.id
      WHERE i.voucher_id = ?
    `, [voucher.id]);

    res.json({ success: true, data: { ...voucher, entries, inventory } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Post a new Double-Entry Voucher (F4 Contra, F5 Payment, F6 Receipt, F7 Journal, F8 Sales, F9 Purchase)
app.post('/api/vouchers', async (req, res) => {
  try {
    const { voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, entries, inventory } = req.body;

    if (!voucher_type || !entries || !Array.isArray(entries) || entries.length < 2) {
      return res.status(400).json({ success: false, error: 'Voucher type and at least 2 double-entry lines are required' });
    }

    // Double-Entry Verification: Total Debits MUST equal Total Credits!
    let totalDebit = 0;
    let totalCredit = 0;

    const validatedEntries = entries.map((e, idx) => {
      const dr = parseFloat(e.debit_amount) || 0;
      const cr = parseFloat(e.credit_amount) || 0;
      totalDebit += dr;
      totalCredit += cr;

      return {
        ledger_id: parseInt(e.ledger_id, 10),
        entry_type: dr > 0 ? 'Dr' : 'Cr',
        debit_amount: dr,
        credit_amount: cr,
        particulars: e.particulars || ''
      };
    });

    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.05) {
      return res.status(400).json({
        success: false,
        error: `Double-Entry Out of Balance! Total Debits (₹${totalDebit.toFixed(2)}) do not match Total Credits (₹${totalCredit.toFixed(2)}). Difference: ₹${diff.toFixed(2)}`
      });
    }

    const vNo = voucher_no || `RRE/${voucher_type.toUpperCase().slice(0, 3)}/${Date.now().toString().slice(-4)}`;
    const vDate = date || new Date().toISOString().split('T')[0];

    // Begin database transaction
    await run('BEGIN TRANSACTION');

    try {
      const vResult = await run(
        `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [voucher_type, vNo, vDate, reference_no || '', narration || '', party_ledger_id || null, totalDebit]
      );
      const voucherId = vResult.lastID;

      // Insert double-entry ledger lines
      for (const en of validatedEntries) {
        await run(
          `INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [voucherId, en.ledger_id, en.entry_type, en.debit_amount, en.credit_amount, en.particulars]
        );
      }

      // Insert inventory movements if any (Item allocations for Sales / Purchases)
      if (inventory && Array.isArray(inventory)) {
        for (const item of inventory) {
          const qty = parseFloat(item.quantity) || 0;
          const rate = parseFloat(item.rate) || 0;
          const amt = qty * rate;
          const direction = voucher_type === 'Purchase' ? 'IN' : 'OUT';

          if (item.stock_item_id && qty > 0) {
            await run(
              `INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, discount_pct)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [voucherId, item.stock_item_id, direction, qty, rate, amt, parseFloat(item.discount_pct) || 0]
            );
          }
        }
      }

      await run('COMMIT');

      res.json({
        success: true,
        id: voucherId,
        voucher_no: vNo,
        voucher_type,
        total_amount: totalDebit,
        message: `${voucher_type} Voucher ${vNo} posted successfully`
      });
    } catch (txErr) {
      await run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. STATUTORY TALLY REPORTS ENGINE
// ==========================================

// Helper: Calculate net closing balance for every ledger
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

    // Normal balance convention:
    // Assets & Expenses: normal Dr (Positive Dr means Dr balance)
    // Liabilities & Incomes: normal Cr (Positive Cr means Cr balance)
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

// Helper: Calculate current closing stock value
async function calculateClosingStockValuation() {
  const items = await all(`
    SELECT s.id, s.name, s.opening_qty, s.opening_rate, s.opening_val, s.standard_cost,
      COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN i.quantity ELSE 0 END), 0) as inward_qty,
      COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.quantity ELSE 0 END), 0) as outward_qty
    FROM stock_items s
    LEFT JOIN inventory_entries i ON s.id = i.stock_item_id
    GROUP BY s.id
  `);

  let totalStockValuation = 0;
  const detailed = items.map((it) => {
    const closingQty = it.opening_qty + it.inward_qty - it.outward_qty;
    const rate = it.opening_rate || it.standard_cost || 0;
    const valuation = closingQty * rate;
    totalStockValuation += valuation;

    return {
      ...it,
      closing_qty: closingQty,
      valuation_rate: rate,
      closing_val: valuation
    };
  });

  return { totalStockValuation, items: detailed };
}

// 4A. TRIAL BALANCE
app.get('/api/reports/trial-balance', async (req, res) => {
  try {
    const date = req.query.date || null;
    const ledgers = await calculateAllLedgerBalances(date);

    let totalDr = 0;
    let totalCr = 0;

    const items = ledgers.map((l) => {
      const dr = l.closing_type === 'Dr' ? l.closing_balance : 0;
      const cr = l.closing_type === 'Cr' ? l.closing_balance : 0;
      totalDr += dr;
      totalCr += cr;

      return {
        id: l.id,
        name: l.name,
        group_name: l.group_name,
        group_nature: l.group_nature,
        debit: dr,
        credit: cr
      };
    });

    const diff = Math.abs(totalDr - totalCr);

    res.json({
      success: true,
      data: {
        items,
        total_debit: totalDr,
        total_credit: totalCr,
        difference: diff,
        is_balanced: diff < 0.05
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4B. PROFIT & LOSS ACCOUNT (Trading & Income Statement)
app.get('/api/reports/profit-loss', async (req, res) => {
  try {
    const date = req.query.date || null;
    const ledgers = await calculateAllLedgerBalances(date);
    const { totalStockValuation } = await calculateClosingStockValuation();

    // Opening Stock
    const openingStockRow = await get("SELECT SUM(opening_val) as total FROM stock_items");
    const openingStock = openingStockRow.total || 0;
    const closingStock = totalStockValuation;

    let salesTotal = 0;
    let purchaseTotal = 0;
    let directExpensesTotal = 0;
    let directIncomesTotal = 0;
    let indirectExpensesTotal = 0;
    let indirectIncomesTotal = 0;

    const salesList = [];
    const purchaseList = [];
    const directExpList = [];
    const directIncList = [];
    const indirectExpList = [];
    const indirectIncList = [];

    ledgers.forEach((l) => {
      const val = l.closing_balance;
      if (val === 0) return;

      if (l.group_name === 'Sales Accounts') {
        salesTotal += val;
        salesList.push(l);
      } else if (l.group_name === 'Purchase Accounts') {
        purchaseTotal += val;
        purchaseList.push(l);
      } else if (l.group_name === 'Direct Expenses') {
        directExpensesTotal += val;
        directExpList.push(l);
      } else if (l.group_name === 'Direct Incomes') {
        directIncomesTotal += val;
        directIncList.push(l);
      } else if (l.group_name === 'Indirect Expenses') {
        indirectExpensesTotal += val;
        indirectExpList.push(l);
      } else if (l.group_name === 'Indirect Incomes') {
        indirectIncomesTotal += val;
        indirectIncList.push(l);
      }
    });

    // Trading Account:
    // Credit Side: Sales + Closing Stock + Direct Incomes
    const tradingCredit = salesTotal + closingStock + directIncomesTotal;
    // Debit Side: Opening Stock + Purchases + Direct Expenses
    const tradingDebit = openingStock + purchaseTotal + directExpensesTotal;
    const grossProfit = tradingCredit - tradingDebit;

    // Net Profit:
    // Gross Profit + Indirect Incomes - Indirect Expenses
    const netProfit = grossProfit + indirectIncomesTotal - indirectExpensesTotal;

    res.json({
      success: true,
      data: {
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
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4C. BALANCE SHEET (Liabilities vs Assets)
app.get('/api/reports/balance-sheet', async (req, res) => {
  try {
    const date = req.query.date || null;
    const ledgers = await calculateAllLedgerBalances(date);
    const { totalStockValuation } = await calculateClosingStockValuation();

    // 1. Calculate Net Profit from P&L
    const plRes = await (async () => {
      const openingStockRow = await get("SELECT SUM(opening_val) as total FROM stock_items");
      const openingStock = openingStockRow.total || 0;
      let s = 0, p = 0, de = 0, di = 0, ie = 0, ii = 0;
      ledgers.forEach((l) => {
        const val = l.closing_balance;
        if (l.group_name === 'Sales Accounts') s += val;
        else if (l.group_name === 'Purchase Accounts') p += val;
        else if (l.group_name === 'Direct Expenses') de += val;
        else if (l.group_name === 'Direct Incomes') di += val;
        else if (l.group_name === 'Indirect Expenses') ie += val;
        else if (l.group_name === 'Indirect Incomes') ii += val;
      });
      const gp = (s + totalStockValuation + di) - (openingStock + p + de);
      return gp + ii - ie;
    })();

    const netProfit = plRes;

    // 2. Classify Balance Sheet Items
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

      if (l.group_nature === 'Liabilities') {
        if (l.group_name === 'Capital Account' || l.group_name === 'Reserves & Surplus') {
          liabilities.capital_account.total += val;
          liabilities.capital_account.items.push(l);
        } else if (l.group_name.includes('Loan') || l.group_name.includes('Bank OD')) {
          liabilities.loans.total += val;
          liabilities.loans.items.push(l);
        } else {
          liabilities.current_liabilities.total += val;
          liabilities.current_liabilities.items.push(l);
        }
      } else if (l.group_nature === 'Assets') {
        if (l.group_name === 'Fixed Assets') {
          assets.fixed_assets.total += val;
          assets.fixed_assets.items.push(l);
        } else if (l.group_name === 'Investments') {
          assets.investments.total += val;
          assets.investments.items.push(l);
        } else if (l.group_name !== 'Stock-in-hand') { // closing stock calculated from inventory
          assets.current_assets.total += val;
          assets.current_assets.items.push(l);
        }
      }
    });

    // Add Closing Stock to Current Assets
    assets.current_assets.total += totalStockValuation;
    assets.current_assets.items.unshift({
      name: 'Closing Stock (Valuation)',
      group_name: 'Stock-in-hand',
      closing_balance: totalStockValuation,
      closing_type: 'Dr'
    });

    // Add Net Profit to Capital Account
    const totalLiabilities = liabilities.capital_account.total + netProfit + liabilities.loans.total + liabilities.current_liabilities.total;
    const totalAssets = assets.fixed_assets.total + assets.investments.total + assets.current_assets.total;

    res.json({
      success: true,
      data: {
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
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4D. DAY BOOK
app.get('/api/reports/daybook', async (req, res) => {
  try {
    const { date, from_date, to_date } = req.query;
    let sql = `
      SELECT v.*, p.name as party_name
      FROM vouchers v
      LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (date) {
      sql += ' AND v.date = ?';
      params.push(date);
    } else {
      if (from_date) {
        sql += ' AND v.date >= ?';
        params.push(from_date);
      }
      if (to_date) {
        sql += ' AND v.date <= ?';
        params.push(to_date);
      }
    }

    sql += ' ORDER BY v.date DESC, v.id DESC';
    const vouchers = await all(sql, params);

    // Fetch double-entry particulars for each voucher
    const detailed = [];
    for (const v of vouchers) {
      const entries = await all(`
        SELECT e.*, l.name as ledger_name
        FROM ledger_entries e
        JOIN ledgers l ON e.ledger_id = l.id
        WHERE e.voucher_id = ?
        ORDER BY e.entry_type DESC
      `, [v.id]);
      detailed.push({ ...v, entries });
    }

    res.json({ success: true, data: detailed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4E. STOCK SUMMARY
app.get('/api/reports/stock-summary', async (req, res) => {
  try {
    const { totalStockValuation, items } = await calculateClosingStockValuation();
    res.json({
      success: true,
      data: {
        total_valuation: totalStockValuation,
        items
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4F. ACCOUNT STATEMENT / LEDGER KHATA
app.get('/api/reports/ledger-statement/:id', async (req, res) => {
  try {
    const ledger = await get(`
      SELECT l.*, g.name as group_name, g.nature as group_nature
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      WHERE l.id = ?
    `, [req.params.id]);

    if (!ledger) return res.status(404).json({ success: false, error: 'Ledger not found' });

    const entries = await all(`
      SELECT e.id as entry_id, e.entry_type, e.debit_amount, e.credit_amount, e.particulars,
             v.id as voucher_id, v.voucher_type, v.voucher_no, v.date, v.narration
      FROM ledger_entries e
      JOIN vouchers v ON e.voucher_id = v.id
      WHERE e.ledger_id = ?
      ORDER BY v.date ASC, v.id ASC
    `, [ledger.id]);

    let runningBalance = ledger.opening_balance_type === 'Dr' ? ledger.opening_balance : -ledger.opening_balance;
    let totalDebit = 0;
    let totalCredit = 0;

    const statement = entries.map((en) => {
      totalDebit += en.debit_amount;
      totalCredit += en.credit_amount;
      runningBalance += en.debit_amount - en.credit_amount;

      return {
        ...en,
        balance: Math.abs(runningBalance),
        balance_type: runningBalance >= 0 ? 'Dr' : 'Cr'
      };
    });

    res.json({
      success: true,
      data: {
        ledger,
        statement,
        total_debit: totalDebit,
        total_credit: totalCredit,
        closing_balance: Math.abs(runningBalance),
        closing_type: runningBalance >= 0 ? 'Dr' : 'Cr'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to index.html for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Initialization
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`✨ TallyPrime Web Edition — Running Successfully!`);
      console.log(`👉 Access URL: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal: Failed to start Tally server:', err);
    process.exit(1);
  }
}

startServer();

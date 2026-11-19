const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, all, get, run } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

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
    const totalLedgers = await get('SELECT COUNT(*) as count FROM ledgers');
    const totalItems = await get('SELECT COUNT(*) as count FROM stock_items');

    res.json({
      success: true,
      data: {
        company: comp || { name: 'Ramraj Enterprises', gstin: '33ANUPS7331M1Z8', state: 'Tamil Nadu', state_code: '33' },
        current_date: lastVoucher ? lastVoucher.date : '2026-06-01',
        financial_year: '1-Apr-2026 to 31-Mar-2027',
        last_voucher: lastVoucher || null,
        total_vouchers: totalVouchers.count || 0,
        total_ledgers: totalLedgers.count || 0,
        total_items: totalItems.count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. MASTERS CRUD: GROUPS, LEDGERS, ITEMS, GODOWNS, COST CENTRES
// ==========================================
app.get('/api/masters/groups', async (req, res) => {
  try {
    const groups = await all(`
      SELECT g.*, p.name as parent_name
      FROM account_groups g
      LEFT JOIN account_groups p ON g.parent_id = p.id
      ORDER BY g.nature, g.name
    `);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/masters/groups', async (req, res) => {
  try {
    const { name, parent_id, nature, affects_gross_profit } = req.body;
    if (!name || !nature) return res.status(400).json({ success: false, error: 'Group name and nature are required' });

    const result = await run(
      'INSERT INTO account_groups (name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, ?, 0)',
      [name, nature, parent_id || null, affects_gross_profit ? 1 : 0]
    );
    res.json({ success: true, id: result.lastID, message: `Group '${name}' created successfully` });
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
    const { name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc } = req.body;
    if (!name || !group_id) {
      return res.status(400).json({ success: false, error: 'Ledger name and group are required' });
    }

    const result = await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, group_id,
        parseFloat(opening_balance) || 0,
        opening_balance_type || 'Dr',
        gstin || '', pan || '',
        state || 'Tamil Nadu', state_code || '33',
        address || '',
        bank_account_no || null,
        bank_ifsc || null
      ]
    );

    res.json({ success: true, id: result.lastID, message: `Ledger '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/stock-groups', async (req, res) => {
  try {
    const groups = await all('SELECT * FROM stock_groups ORDER BY name ASC');
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/godowns', async (req, res) => {
  try {
    const godowns = await all('SELECT * FROM godowns ORDER BY name ASC');
    res.json({ success: true, data: godowns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/masters/godowns', async (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Godown name is required' });
    const result = await run('INSERT INTO godowns (name, location) VALUES (?, ?)', [name, location || '']);
    res.json({ success: true, id: result.lastID, message: `Godown '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/cost-centres', async (req, res) => {
  try {
    const centres = await all('SELECT * FROM cost_centres ORDER BY name ASC');
    res.json({ success: true, data: centres });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/masters/uom', async (req, res) => {
  try {
    const uoms = await all('SELECT * FROM units_of_measure ORDER BY symbol ASC');
    res.json({ success: true, data: uoms });
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

app.get('/api/vouchers/:id', async (req, res) => {
  try {
    const voucher = await get(`
      SELECT v.*, p.name as party_name, p.gstin as party_gstin, p.state as party_state
      FROM vouchers v
      LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE v.id = ?
    `, [req.params.id]);

    if (!voucher) return res.status(404).json({ success: false, error: 'Voucher not found' });

    const entries = await all(`
      SELECT e.*, l.name as ledger_name, g.name as group_name, g.nature as ledger_nature
      FROM ledger_entries e
      JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      WHERE e.voucher_id = ?
      ORDER BY e.entry_type DESC, e.id ASC
    `, [voucher.id]);

    const inventory = await all(`
      SELECT i.*, s.name as item_name, s.hsn_code, u.symbol as uom_symbol, g.name as godown_name
      FROM inventory_entries i
      JOIN stock_items s ON i.stock_item_id = s.id
      JOIN units_of_measure u ON s.uom_id = u.id
      LEFT JOIN godowns g ON i.godown_id = g.id
      WHERE i.voucher_id = ?
    `, [voucher.id]);

    const billAllocations = await all(`
      SELECT b.*, l.name as ledger_name
      FROM bill_allocations b
      JOIN ledgers l ON b.ledger_id = l.id
      WHERE b.voucher_id = ?
    `, [voucher.id]);

    res.json({ success: true, data: { ...voucher, entries, inventory, bill_allocations: billAllocations } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Master Double-Entry Post Engine
app.post('/api/vouchers', async (req, res) => {
  try {
    const {
      voucher_type,
      voucher_no,
      date,
      reference_no,
      narration,
      party_ledger_id,
      entries,
      inventory,
      bill_allocations
    } = req.body;

    if (!voucher_type || !entries || !Array.isArray(entries) || entries.length < 2) {
      return res.status(400).json({ success: false, error: 'Voucher type and at least 2 double-entry lines are required' });
    }

    // Mathematical Double-Entry Invariant: Sum(Dr) == Sum(Cr)
    let totalDebit = 0;
    let totalCredit = 0;

    const validatedEntries = entries.map((e) => {
      const dr = Math.round((parseFloat(e.debit_amount) || 0) * 100) / 100;
      const cr = Math.round((parseFloat(e.credit_amount) || 0) * 100) / 100;
      totalDebit += dr;
      totalCredit += cr;

      return {
        ledger_id: parseInt(e.ledger_id, 10),
        entry_type: dr > 0 ? 'Dr' : 'Cr',
        debit_amount: dr,
        credit_amount: cr,
        particulars: e.particulars || '',
        cost_centre_id: e.cost_centre_id ? parseInt(e.cost_centre_id, 10) : null
      };
    });

    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.05) {
      return res.status(400).json({
        success: false,
        error: `Tally Invariant Violation: Debits (₹${totalDebit.toFixed(2)}) != Credits (₹${totalCredit.toFixed(2)}). Difference = ₹${diff.toFixed(2)}`
      });
    }

    const vNo = voucher_no || `RRE/${voucher_type.toUpperCase().slice(0, 3)}/${Date.now().toString().slice(-5)}`;
    const vDate = date || new Date().toISOString().split('T')[0];

    await run('BEGIN TRANSACTION');

    try {
      const vResult = await run(
        `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [voucher_type, vNo, vDate, reference_no || '', narration || '', party_ledger_id || null, totalDebit]
      );

      const voucherId = vResult.lastID;

      // 1. Insert Double-Entry Lines & Auto-Queue Bank Reconciliation for Bank Accounts
      for (const en of validatedEntries) {
        const enResult = await run(
          `INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [voucherId, en.ledger_id, en.entry_type, en.debit_amount, en.credit_amount, en.particulars, en.cost_centre_id]
        );

        // Check if ledger is a Bank Account (Group ID 18 or 22)
        const lInfo = await get('SELECT group_id FROM ledgers WHERE id = ?', [en.ledger_id]);
        if (lInfo && (lInfo.group_id === 18 || lInfo.group_id === 22)) {
          await run(
            `INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status)
             VALUES (?, NULL, ?, 'Pending')`,
            [enResult.lastID, reference_no || '']
          );
        }
      }

      // 2. Insert Inventory Movements (Stock In/Out)
      if (inventory && Array.isArray(inventory)) {
        for (const item of inventory) {
          const qty = parseFloat(item.quantity) || 0;
          const rate = parseFloat(item.rate) || 0;
          const amt = qty * rate;
          const direction = ['Purchase', 'Debit Note'].includes(voucher_type) ? 'IN' : 'OUT';

          if (item.stock_item_id && qty > 0) {
            await run(
              `INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, discount_pct, godown_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [voucherId, item.stock_item_id, direction, qty, rate, amt, parseFloat(item.discount_pct) || 0, item.godown_id || 1]
            );
          }
        }
      }

      // 3. Insert Bill-by-Bill Allocations (For Debtors / Creditors)
      if (bill_allocations && Array.isArray(bill_allocations)) {
        for (const b of bill_allocations) {
          if (b.ledger_id && b.amount) {
            await run(
              `INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [voucherId, b.ledger_id, b.bill_type || 'New Ref', b.bill_ref || vNo, parseFloat(b.amount) || 0, b.due_date || null]
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
        message: `${voucher_type} Voucher ${vNo} recorded successfully`
      });
    } catch (txErr) {
      await run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Voucher
app.delete('/api/vouchers/:id', async (req, res) => {
  try {
    const v = await get('SELECT * FROM vouchers WHERE id = ?', [req.params.id]);
    if (!v) return res.status(404).json({ success: false, error: 'Voucher not found' });

    await run('BEGIN TRANSACTION');
    try {
      await run('DELETE FROM ledger_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM inventory_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM bill_allocations WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM vouchers WHERE id = ?', [v.id]);
      await run('COMMIT');
      res.json({ success: true, message: `Voucher ${v.voucher_no} deleted successfully` });
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. STATUTORY TALLY REPORTING & FORMULA ENGINE
// ==========================================

// Helper: Calculate net closing balance for all ledgers
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

// Helper: Weighted Average Valuation for Stock Summary & P&L
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
    
    // Weighted Average Valuation Formula:
    // Rate = (Opening Value + Inward Value) / (Opening Qty + Inward Qty)
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

// 4A. TRIAL BALANCE (True Dr/Cr Equilibrium)
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

// 4B. PROFIT & LOSS ACCOUNT (Trading & Income Statement with COGS)
app.get('/api/reports/profit-loss', async (req, res) => {
  try {
    const date = req.query.date || null;
    const ledgers = await calculateAllLedgerBalances(date);
    const { totalStockValuation } = await calculateClosingStockValuation();

    const openingStockRow = await get('SELECT SUM(opening_val) as total FROM stock_items');
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

    // Cost of Goods Sold (COGS) Formula:
    // COGS = Opening Stock + Purchases + Direct Expenses - Closing Stock
    const cogs = openingStock + purchaseTotal + directExpensesTotal - closingStock;

    // Trading Account:
    // Credit Side = Sales + Closing Stock + Direct Incomes
    // Debit Side = Opening Stock + Purchases + Direct Expenses
    const tradingCredit = salesTotal + closingStock + directIncomesTotal;
    const tradingDebit = openingStock + purchaseTotal + directExpensesTotal;
    const grossProfit = tradingCredit - tradingDebit;

    // Net Profit:
    // Net Profit = Gross Profit + Indirect Incomes - Indirect Expenses
    const netProfit = grossProfit + indirectIncomesTotal - indirectExpensesTotal;

    res.json({
      success: true,
      data: {
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
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4C. BALANCE SHEET (Liabilities vs Assets Verification)
app.get('/api/reports/balance-sheet', async (req, res) => {
  try {
    const date = req.query.date || null;
    const ledgers = await calculateAllLedgerBalances(date);
    const { totalStockValuation } = await calculateClosingStockValuation();

    // 1. Calculate Net Profit
    const openingStockRow = await get('SELECT SUM(opening_val) as total FROM stock_items');
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
    const netProfit = (s + totalStockValuation + di) - (openingStock + p + de) + ii - ie;

    // 2. Classify Liabilities & Assets
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

      // Real Double-Entry Balance Sheet Convention:
      // In Liabilities: Cr balance is positive liability, Dr balance is deducted
      // In Assets: Dr balance is positive asset, Cr balance is deducted
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

    // Add dynamically valued Closing Stock to Current Assets
    assets.current_assets.total += totalStockValuation;
    assets.current_assets.items.unshift({
      name: 'Closing Stock (Valuation)',
      group_name: 'Stock-in-hand',
      closing_balance: totalStockValuation,
      closing_type: 'Dr'
    });

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

// 4G. RATIO ANALYSIS (Complete Tally Financial Ratios)
app.get('/api/reports/ratio-analysis', async (req, res) => {
  try {
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

    res.json({
      success: true,
      data: {
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
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4H. GST RETURNS ENGINE (GSTR-1 & GSTR-3B)
app.get('/api/reports/gst', async (req, res) => {
  try {
    // 1. GSTR-1: Outward Supplies (Sales & Credit Notes)
    const salesVouchers = await all(`
      SELECT v.*, p.name as party_name, p.gstin as party_gstin, p.state as party_state, p.state_code as party_state_code
      FROM vouchers v
      JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE v.voucher_type IN ('Sales', 'Credit Note')
      ORDER BY v.date ASC
    `);

    let gstr1_b2b = [];
    let gstr1_b2c = [];
    let outwardTaxable = 0;
    let outwardCGST = 0;
    let outwardSGST = 0;
    let outwardIGST = 0;

    for (const v of salesVouchers) {
      const entries = await all(`
        SELECT e.*, l.name as ledger_name
        FROM ledger_entries e
        JOIN ledgers l ON e.ledger_id = l.id
        WHERE e.voucher_id = ?
      `, [v.id]);

      let taxable = 0;
      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      entries.forEach((e) => {
        if (e.particulars.includes('Sales')) taxable += e.credit_amount;
        if (e.particulars.includes('CGST')) cgst += e.credit_amount;
        if (e.particulars.includes('SGST')) sgst += e.credit_amount;
        if (e.particulars.includes('IGST')) igst += e.credit_amount;
      });

      outwardTaxable += taxable;
      outwardCGST += cgst;
      outwardSGST += sgst;
      outwardIGST += igst;

      const record = {
        voucher_id: v.id,
        voucher_no: v.voucher_no,
        date: v.date,
        party_name: v.party_name,
        party_gstin: v.party_gstin,
        state: v.party_state,
        taxable_value: taxable,
        cgst,
        sgst,
        igst,
        total_invoice_value: v.total_amount
      };

      if (v.party_gstin && v.party_gstin.trim().length > 5) {
        gstr1_b2b.push(record);
      } else {
        gstr1_b2c.push(record);
      }
    }

    // 2. GSTR-3B: Inward Supplies / Eligible Input Tax Credit (ITC) from Purchases
    const purchaseEntries = await all(`
      SELECT e.particulars, SUM(e.debit_amount) as total_tax
      FROM ledger_entries e
      JOIN vouchers v ON e.voucher_id = v.id
      WHERE v.voucher_type IN ('Purchase', 'Debit Note')
      AND e.particulars LIKE 'Input %'
      GROUP BY e.particulars
    `);

    let itcCGST = 0;
    let itcSGST = 0;
    let itcIGST = 0;

    purchaseEntries.forEach((p) => {
      if (p.particulars.includes('CGST')) itcCGST += p.total_tax;
      if (p.particulars.includes('SGST')) itcSGST += p.total_tax;
      if (p.particulars.includes('IGST')) itcIGST += p.total_tax;
    });

    // Net GST Liability Formula: Outward Tax Liability - Eligible ITC
    const netCGST = outwardCGST - itcCGST;
    const netSGST = outwardSGST - itcSGST;
    const netIGST = outwardIGST - itcIGST;
    const netPayable = (netCGST > 0 ? netCGST : 0) + (netSGST > 0 ? netSGST : 0) + (netIGST > 0 ? netIGST : 0);

    res.json({
      success: true,
      data: {
        gstr1: {
          b2b_invoices: gstr1_b2b,
          b2c_invoices: gstr1_b2c,
          total_taxable: outwardTaxable,
          total_cgst: outwardCGST,
          total_sgst: outwardSGST,
          total_igst: outwardIGST,
          total_outward_tax: outwardCGST + outwardSGST + outwardIGST
        },
        gstr3b: {
          table_3_1_outward: {
            taxable: outwardTaxable,
            cgst: outwardCGST,
            sgst: outwardSGST,
            igst: outwardIGST
          },
          table_4_itc: {
            cgst: itcCGST,
            sgst: itcSGST,
            igst: itcIGST,
            total_itc: itcCGST + itcSGST + itcIGST
          },
          net_payable: {
            cgst: netCGST,
            sgst: netSGST,
            igst: netIGST,
            total_payable: netPayable
          }
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4I. BILL-BY-BILL OUTSTANDINGS (Receivables & Payables Ageing Analysis)
app.get('/api/reports/outstandings', async (req, res) => {
  try {
    const allocations = await all(`
      SELECT b.*, v.voucher_no, v.date, v.voucher_type, l.name as ledger_name, g.name as group_name
      FROM bill_allocations b
      JOIN vouchers v ON b.voucher_id = v.id
      JOIN ledgers l ON b.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      ORDER BY b.bill_ref, b.id ASC
    `);

    // Group allocations by Bill Reference
    const bills = {};
    allocations.forEach((a) => {
      if (!bills[a.bill_ref]) {
        bills[a.bill_ref] = {
          bill_ref: a.bill_ref,
          ledger_id: a.ledger_id,
          ledger_name: a.ledger_name,
          group_name: a.group_name,
          bill_date: a.date,
          due_date: a.due_date || a.date,
          original_amount: 0,
          cleared_amount: 0,
          pending_amount: 0
        };
      }

      if (a.bill_type === 'New Ref') {
        bills[a.bill_ref].original_amount += a.amount;
      } else if (a.bill_type === 'Agst Ref') {
        bills[a.bill_ref].cleared_amount += a.amount;
      }
    });

    const receivables = [];
    const payables = [];

    Object.values(bills).forEach((b) => {
      b.pending_amount = b.original_amount - b.cleared_amount;
      if (b.pending_amount > 0) {
        if (b.group_name === 'Sundry Debtors') {
          receivables.push(b);
        } else {
          payables.push(b);
        }
      }
    });

    res.json({
      success: true,
      data: {
        receivables,
        payables,
        total_receivable: receivables.reduce((sum, r) => sum + r.pending_amount, 0),
        total_payable: payables.reduce((sum, p) => sum + p.pending_amount, 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4J. BANK RECONCILIATION STATEMENT (BRS)
app.get('/api/reports/bank-reconciliation/:id', async (req, res) => {
  try {
    const ledger = await get('SELECT * FROM ledgers WHERE id = ?', [req.params.id]);
    if (!ledger) return res.status(404).json({ success: false, error: 'Bank ledger not found' });

    const entries = await all(`
      SELECT e.id as entry_id, e.entry_type, e.debit_amount, e.credit_amount, e.particulars,
             v.voucher_no, v.date, v.voucher_type,
             r.id as recon_id, r.bank_clearing_date, r.instrument_no, r.status
      FROM ledger_entries e
      JOIN vouchers v ON e.voucher_id = v.id
      LEFT JOIN bank_reconciliation r ON e.id = r.ledger_entry_id
      WHERE e.ledger_id = ?
      ORDER BY v.date ASC, v.id ASC
    `, [ledger.id]);

    let bookBalance = ledger.opening_balance_type === 'Dr' ? ledger.opening_balance : -ledger.opening_balance;
    let bankBalance = bookBalance;

    entries.forEach((e) => {
      bookBalance += (e.debit_amount - e.credit_amount);
      if (e.status === 'Cleared') {
        bankBalance += (e.debit_amount - e.credit_amount);
      }
    });

    res.json({
      success: true,
      data: {
        ledger,
        book_balance: bookBalance,
        bank_balance: bankBalance,
        difference: Math.abs(bookBalance - bankBalance),
        transactions: entries
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clear Bank Reconciliation record
app.post('/api/reports/bank-reconciliation/clear', async (req, res) => {
  try {
    const { entry_id, bank_clearing_date } = req.body;
    if (!entry_id || !bank_clearing_date) {
      return res.status(400).json({ success: false, error: 'Entry ID and clearing date are required' });
    }

    await run(`
      INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, status)
      VALUES (?, ?, 'Cleared')
      ON CONFLICT(ledger_entry_id) DO UPDATE SET
        bank_clearing_date = excluded.bank_clearing_date,
        status = 'Cleared'
    `, [entry_id, bank_clearing_date]);

    res.json({ success: true, message: 'Bank clearing date updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4K. TALLY XML EXPORT (Standard TallyPrime Interoperability XML)
app.get('/api/export/tally-xml', async (req, res) => {
  try {
    const comp = await get('SELECT * FROM company_info LIMIT 1');
    const ledgers = await all('SELECT l.*, g.name as group_name FROM ledgers l JOIN account_groups g ON l.group_id = g.id');
    const vouchers = await all('SELECT * FROM vouchers ORDER BY date ASC');

    let xml = `<?xml version="1.0" encoding="utf-8"?>\n<ENVELOPE>\n  <HEADER>\n    <TALLYREQUEST>Import Data</TALLYREQUEST>\n  </HEADER>\n  <BODY>\n    <IMPORTDATA>\n      <REQUESTDESC>\n        <REPORTNAME>All Masters and Vouchers</REPORTNAME>\n      </REQUESTDESC>\n      <REQUESTDATA>\n        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n          <COMPANY>\n            <NAME>${comp.name}</NAME>\n            <GSTIN>${comp.gstin}</GSTIN>\n          </COMPANY>\n`;

    for (const l of ledgers) {
      xml += `          <LEDGER NAME="${l.name}">\n            <PARENT>${l.group_name}</PARENT>\n            <OPENINGBALANCE>${l.opening_balance_type === 'Cr' ? '-' : ''}${l.opening_balance}</OPENINGBALANCE>\n            <GSTIN>${l.gstin || ''}</GSTIN>\n          </LEDGER>\n`;
    }

    for (const v of vouchers) {
      const entries = await all('SELECT e.*, l.name as ledger_name FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id WHERE e.voucher_id = ?', [v.id]);
      xml += `          <VOUCHER VCHTYPE="${v.voucher_type}">\n            <DATE>${v.date.replace(/-/g, '')}</DATE>\n            <VOUCHERNUMBER>${v.voucher_no}</VOUCHERNUMBER>\n            <NARRATION>${v.narration || ''}</NARRATION>\n`;
      for (const e of entries) {
        xml += `            <ALLLEDGERENTRIES.LIST>\n              <LEDGERNAME>${e.ledger_name}</LEDGERNAME>\n              <ISDEEMEDPOSITIVE>${e.entry_type === 'Dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n              <AMOUNT>${e.entry_type === 'Dr' ? '-' : ''}${e.debit_amount || e.credit_amount}</AMOUNT>\n            </ALLLEDGERENTRIES.LIST>\n`;
      }
      xml += `          </VOUCHER>\n`;
    }

    xml += `        </TALLYMESSAGE>\n      </REQUESTDATA>\n    </IMPORTDATA>\n  </BODY>\n</ENVELOPE>`;

    res.setHeader('Content-Type', 'text/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="TallyPrime_Backup.xml"');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SPA Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Initialization
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`✨ TallyPrime Web Edition — Master Engine Running!`);
      console.log(`👉 Access URL: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal: Failed to start Tally server:', err);
    process.exit(1);
  }
}

startServer();

const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');
const {
  calculateAllLedgerBalances,
  calculateClosingStockValuation,
  calculateProfitLoss,
  calculateBalanceSheet,
  calculateRatioAnalysis
} = require('../../core/accountingEngine');
const { calculateGSTReports } = require('../../core/gstEngine');

// 1. Trial Balance
router.get('/trial-balance', async (req, res) => {
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

// 2. Profit & Loss Account
router.get('/profit-loss', async (req, res) => {
  try {
    const data = await calculateProfitLoss(req.query.date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Balance Sheet
router.get('/balance-sheet', async (req, res) => {
  try {
    const data = await calculateBalanceSheet(req.query.date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Stock Summary
router.get('/stock-summary', async (req, res) => {
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

// 5. Day Book
router.get('/daybook', async (req, res) => {
  try {
    const { date, from_date, to_date, type } = req.query;
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
    // optional paging for large books: ?limit=&offset= (without them, every voucher as before); the total is in X-Total-Count
    const limit = parseInt(req.query.limit, 10), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (limit > 0) {
      const total = await get(`SELECT COUNT(*) AS n FROM (${sql}) AS t`, params);
      res.set('X-Total-Count', String(total.n));
      sql += ' LIMIT ? OFFSET ?'; params.push(Math.min(limit, 1000), offset);
    }
    const vouchers = await all(sql, params);

    // the lines of all these vouchers in a few queries (one query per voucher took seconds on a large book)
    const byVoucher = new Map(vouchers.map((v) => [v.id, []]));
    const ids = req.query.entries === '0' ? [] : vouchers.map((v) => v.id); // ?entries=0: the voucher rows only
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = await all(`
        SELECT e.*, l.name as ledger_name
        FROM ledger_entries e
        JOIN ledgers l ON e.ledger_id = l.id
        WHERE e.voucher_id IN (${part.map(() => '?').join(', ')})
        ORDER BY e.voucher_id, e.entry_type DESC, e.id
      `, part);
      for (const r of rows) byVoucher.get(r.voucher_id).push(r);
    }
    const detailed = vouchers.map((v) => ({ ...v, entries: byVoucher.get(v.id) }));

    res.json({ success: true, data: detailed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Ratio Analysis
router.get('/ratio-analysis', async (req, res) => {
  try {
    const data = await calculateRatioAnalysis();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. GST Reports (GSTR-1 & GSTR-3B)
router.get('/gst', async (req, res) => {
  try {
    const data = await calculateGSTReports();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Outstandings (Receivables & Payables Ageing)
router.get('/outstandings', async (req, res) => {
  try {
    const allocations = await all(`
      SELECT b.*, v.voucher_no, v.date, v.voucher_type, l.name as ledger_name, g.name as group_name
      FROM bill_allocations b
      JOIN vouchers v ON b.voucher_id = v.id
      JOIN ledgers l ON b.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      ORDER BY b.bill_ref, b.id ASC
    `);

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

// 9. Bank Reconciliation Statement (BRS)
router.get('/bank-reconciliation/:id', async (req, res) => {
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

router.post('/bank-reconciliation/clear', async (req, res) => {
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

// 10. Ledger Statement / Khata
router.get('/ledger-statement/:id', async (req, res) => {
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

module.exports = router;

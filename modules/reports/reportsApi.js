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
    const date = req.query.date || null, from = req.query.from || null;
    for (const d of [date, from]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ success: false, error: 'Dates must be YYYY-MM-DD.' });
    if (date && from && from > date) return res.status(400).json({ success: false, error: 'The period starts after it ends.' });
    const data = await calculateProfitLoss(date, from);
    data.period = { from, to: date };
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
    // ?ledger_id=: the vouchers that touch this ledger;  ?q=: voucher no, reference, narration, party or any ledger on the voucher
    const ledgerId = parseInt(req.query.ledger_id, 10) || null;
    if (ledgerId) { sql += ' AND EXISTS (SELECT 1 FROM ledger_entries le WHERE le.voucher_id = v.id AND le.ledger_id = ?)'; params.push(ledgerId); }
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      sql += " AND (v.voucher_no LIKE ? ESCAPE '\\' OR v.reference_no LIKE ? ESCAPE '\\' OR v.narration LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'"
        + " OR EXISTS (SELECT 1 FROM ledger_entries le2 JOIN ledgers l2 ON l2.id = le2.ledger_id WHERE le2.voucher_id = v.id AND l2.name LIKE ? ESCAPE '\\'))";
      params.push(like, like, like, like, like);
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

    // ?summary=1: totals for the WHOLE filter (not only this page); with a ledger, its opening balance (before the period) and closing
    // balance. Amounts are signed: Dr positive, Cr negative.
    let summary;
    if (req.query.summary === '1') {
      const base = sql.replace(/ ORDER BY[\s\S]*$/, '').replace(/^\s*SELECT v\.\*, p\.name as party_name/, 'SELECT v.id');
      const baseParams = limit > 0 ? params.slice(0, -2) : params;
      const t = await get(`SELECT COALESCE(SUM(e.debit_amount), 0) AS dr, COALESCE(SUM(e.credit_amount), 0) AS cr, COUNT(DISTINCT e.voucher_id) AS vouchers
        FROM ledger_entries e WHERE e.voucher_id IN (${base})${ledgerId ? ' AND e.ledger_id = ?' : ''}`, [...baseParams, ...(ledgerId ? [ledgerId] : [])]);
      summary = { total_debit: Math.round(Number(t.dr) * 100) / 100, total_credit: Math.round(Number(t.cr) * 100) / 100, vouchers: Number(t.vouchers) };
      if (ledgerId) {
        const l = await get('SELECT name, opening_balance, opening_balance_type FROM ledgers WHERE id = ?', [ledgerId]);
        const start = date || from_date || null;
        const before = start ? await get('SELECT COALESCE(SUM(e.debit_amount - e.credit_amount), 0) AS m FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? AND v.date < ?', [ledgerId, start]) : { m: 0 };
        const ob = l ? (l.opening_balance_type === 'Cr' ? -1 : 1) * (Number(l.opening_balance) || 0) : 0;
        const opening = Math.round((ob + Number(before.m)) * 100) / 100;
        summary.ledger = { id: ledgerId, name: l ? l.name : null, opening, closing: Math.round((opening + summary.total_debit - summary.total_credit) * 100) / 100 };
      }
    }
    // Opening balances entered on ledgers: shown in the Day Book as "Opening Balance" entries, read from the ledger itself (no voucher is
    // created, so nothing is counted twice: ledger balances and reports already include them). Dated the day they were entered; changing
    // a ledger's opening balance changes this entry. Not part of a single-ledger view (that view has its own opening-balance row).
    let openings;
    if (!ledgerId && (!type || type === 'Opening Balance') && (offset === 0 || !(limit > 0))) {
      const where = ['l.opening_balance <> 0'], op = [];
      const day = "substr(COALESCE(l.created_at, ''), 1, 10)";
      if (date) { where.push(`${day} = ?`); op.push(date); } else { if (from_date) { where.push(`${day} >= ?`); op.push(from_date); } if (to_date) { where.push(`${day} <= ?`); op.push(to_date); } }
      if (q) { where.push("(l.name LIKE ? ESCAPE '\\' OR g.name LIKE ? ESCAPE '\\')"); const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; op.push(like, like); }
      const rows = await all(`SELECT l.id AS ledger_id, l.name AS ledger_name, g.name AS group_name, l.opening_balance, l.opening_balance_type, l.created_at
        FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC`, op);
      const co = await get('SELECT books_beginning_from FROM company_info LIMIT 1').catch(() => null);
      openings = rows.map((r) => ({ ledger_id: r.ledger_id, ledger_name: r.ledger_name, group_name: r.group_name, date: String(r.created_at || '').slice(0, 10) || (co && co.books_beginning_from) || null,
        debit_amount: r.opening_balance_type === 'Cr' ? 0 : Math.round(Number(r.opening_balance) * 100) / 100, credit_amount: r.opening_balance_type === 'Cr' ? Math.round(Number(r.opening_balance) * 100) / 100 : 0,
        as_on: co ? co.books_beginning_from : null }));
      if (summary) {
        const all0 = await get("SELECT ROUND(COALESCE(SUM(CASE WHEN opening_balance_type = 'Cr' THEN 0 ELSE opening_balance END), 0), 2) AS dr, ROUND(COALESCE(SUM(CASE WHEN opening_balance_type = 'Cr' THEN opening_balance ELSE 0 END), 0), 2) AS cr FROM ledgers WHERE opening_balance <> 0");
        summary.openings = { shown: openings.length, total_debit: Number(all0.dr), total_credit: Number(all0.cr), difference: Math.round((Number(all0.dr) - Number(all0.cr)) * 100) / 100 };
      }
    }
    res.json({ success: true, data: detailed, ...(openings ? { openings } : {}), ...(summary ? { summary } : {}) });
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
/**
 * Ledger Vouchers (a ledger's statement), optionally for a period (?from=&to=): the opening balance as on the period start (the ledger's
 * opening balance + everything before it), every entry in the period with the other ledgers of its voucher and the party, a running
 * balance, the period totals and the net for the period (for an income / expense ledger that is its Profit & Loss figure), and the closing.
 */
router.get('/ledger-statement/:id', async (req, res) => {
  try {
    const okd = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
    const from = okd(req.query.from), to = okd(req.query.to);
    if ((req.query.from && !from) || (req.query.to && !to)) return res.status(400).json({ success: false, error: 'Dates must be YYYY-MM-DD.' });
    if (from && to && from > to) return res.status(400).json({ success: false, error: 'The period starts after it ends.' });
    const ledger = await get(`
      SELECT l.*, g.name as group_name, g.nature as group_nature
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      WHERE l.id = ?
    `, [parseInt(req.params.id, 10) || 0]);

    if (!ledger) return res.status(404).json({ success: false, error: 'Ledger not found' });

    let opening = (ledger.opening_balance_type === 'Cr' ? -1 : 1) * (Number(ledger.opening_balance) || 0);
    // an income / expense ledger for a period starts as the Profit & Loss does: from zero, with its opening balance only in the period
    // where the books begin (earlier periods' amounts went to those periods' profit) — so its closing here = its P&L amount
    const nominal = ['Income', 'Expenses'].includes(ledger.group_nature);
    if (from && nominal) {
      if (!(await require('../../core/accountingEngine').nominalOpeningIncluded(from))) opening = 0;
    } else if (from) {
      const before = await get('SELECT COALESCE(SUM(e.debit_amount), 0) - COALESCE(SUM(e.credit_amount), 0) AS n FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? AND v.date < ?', [ledger.id, from]);
      opening += Number(before.n) || 0;
    }
    const params = [ledger.id]; let period = '';
    if (from) { period += ' AND v.date >= ?'; params.push(from); }
    if (to) { period += ' AND v.date <= ?'; params.push(to); }
    const entries = await all(`
      SELECT e.id as entry_id, e.entry_type, e.debit_amount, e.credit_amount, e.particulars,
             v.id as voucher_id, v.voucher_type, v.voucher_no, v.date, v.reference_no, v.narration, p.name AS party
      FROM ledger_entries e
      JOIN vouchers v ON e.voucher_id = v.id
      LEFT JOIN ledgers p ON p.id = v.party_ledger_id
      WHERE e.ledger_id = ?${period}
      ORDER BY v.date ASC, v.id ASC, e.id ASC
    `, params);
    // the other side of each voucher ("Particulars" in Tally's Ledger Vouchers)
    const against = new Map();
    const vids = [...new Set(entries.map((e) => e.voucher_id))];
    for (let i = 0; i < vids.length; i += 500) {
      const chunk = vids.slice(i, i + 500);
      for (const o of await all(`SELECT e.voucher_id, l.name FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id IN (${chunk.map(() => '?').join(',')}) AND e.ledger_id <> ? ORDER BY e.id`, [...chunk, ledger.id])) {
        if (!against.has(o.voucher_id)) against.set(o.voucher_id, []);
        if (!against.get(o.voucher_id).includes(o.name)) against.get(o.voucher_id).push(o.name);
      }
    }

    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    let runningBalance = opening;
    let totalDebit = 0;
    let totalCredit = 0;

    const statement = entries.map((en) => {
      totalDebit += en.debit_amount;
      totalCredit += en.credit_amount;
      runningBalance += en.debit_amount - en.credit_amount;

      return {
        ...en,
        against: (against.get(en.voucher_id) || []).join(', '),
        balance: r2(Math.abs(runningBalance)),
        balance_type: runningBalance >= 0 ? 'Dr' : 'Cr'
      };
    });

    res.json({
      success: true,
      data: {
        ledger,
        period: { from, to },
        opening_balance: r2(Math.abs(opening)),
        opening_type: opening >= 0 ? 'Dr' : 'Cr',
        statement,
        total_debit: r2(totalDebit),
        total_credit: r2(totalCredit),
        net_debit: r2(totalDebit - totalCredit), // the movement in the period (Dr +)
        closing_balance: r2(Math.abs(runningBalance)),
        closing_type: runningBalance >= 0 ? 'Dr' : 'Cr'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

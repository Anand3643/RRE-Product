const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');

// List vouchers with filters
router.get('/', async (req, res) => {
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

// Single voucher detail
router.get('/:id', async (req, res) => {
  try {
    const voucher = await get(`
      SELECT v.*, p.name as party_name, p.gstin as party_gstin, p.state as party_state
      FROM vouchers v
      LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE v.id = ?
    `, [req.params.id]);

    if (!voucher) return res.status(404).json({ success: false, error: 'Voucher not found' });

    const entries = await all(`
      SELECT e.*, l.name as ledger_name, g.name as group_name, g.nature as ledger_nature, c.name as cost_centre_name
      FROM ledger_entries e
      JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      LEFT JOIN cost_centres c ON e.cost_centre_id = c.id
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

// Post Master Double-Entry Voucher
router.post('/', async (req, res) => {
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

    // Mathematical Double-Entry Invariant Guard: Sum(Dr) == Sum(Cr)
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
        error: `Tally Invariant Violation: Total Debits (₹${totalDebit.toFixed(2)}) != Total Credits (₹${totalCredit.toFixed(2)}). Diff: ₹${diff.toFixed(2)}`
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

      // 1. Post Double-Entry Ledger Lines
      for (const en of validatedEntries) {
        const enResult = await run(
          `INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [voucherId, en.ledger_id, en.entry_type, en.debit_amount, en.credit_amount, en.particulars, en.cost_centre_id]
        );

        // Auto-queue for Bank Reconciliation if ledger belongs to Bank Accounts
        const lInfo = await get('SELECT group_id FROM ledgers WHERE id = ?', [en.ledger_id]);
        if (lInfo && (lInfo.group_id === 18 || lInfo.group_id === 22)) {
          await run(
            `INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status)
             VALUES (?, NULL, ?, 'Pending')`,
            [enResult.lastID, reference_no || '']
          );
        }
      }

      // 2. Post Inventory Movements
      if (inventory && Array.isArray(inventory)) {
        for (const item of inventory) {
          const qty = parseFloat(item.quantity) || 0;
          const rate = parseFloat(item.rate) || 0;
          const amt = qty * rate;
          // Purchase and Credit Note (sales return) bring stock IN; Sales and Debit Note (purchase return) send it OUT
          const direction = ['Purchase', 'Credit Note'].includes(voucher_type) ? 'IN' : 'OUT';

          if (item.stock_item_id && qty > 0) {
            await run(
              `INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, discount_pct, godown_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [voucherId, item.stock_item_id, direction, qty, rate, amt, parseFloat(item.discount_pct) || 0, item.godown_id || 1]
            );
          }
        }
      }

      // 3. Post Bill-by-Bill Allocations
      if (bill_allocations && Array.isArray(bill_allocations)) {
        for (const b of bill_allocations) {
          if (b.ledger_id && b.amount) {
            // A Credit/Debit Note settles an existing bill; it can never open a new receivable/payable
            const isReturnNote = ['Credit Note', 'Debit Note'].includes(voucher_type);
            const billType = isReturnNote && (!b.bill_type || b.bill_type === 'New Ref') ? 'Agst Ref' : (b.bill_type || 'New Ref');
            await run(
              `INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [voucherId, b.ledger_id, billType, b.bill_ref || vNo, parseFloat(b.amount) || 0, b.due_date || null]
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
router.delete('/:id', async (req, res) => {
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

module.exports = router;

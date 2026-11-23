const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');
const { postVoucher, VoucherValidationError } = require('../../core/voucherService');

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
    const result = await postVoucher(req.body || {});
    res.json({
      success: true,
      ...result,
      message: `${result.voucher_type} Voucher ${result.voucher_no} recorded successfully`
    });
  } catch (err) {
    const status = err instanceof VoucherValidationError ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Delete Voucher
router.delete('/:id', async (req, res) => {
  try {
    const v = await get('SELECT * FROM vouchers WHERE id = ?', [req.params.id]);
    if (!v) return res.status(404).json({ success: false, error: 'Voucher not found' });

    // A voucher created from a purchase/sales order is part of that order's record: deleting it would leave the order claiming goods
    // that were never received or invoiced. Reverse it with a Debit/Credit Note instead.
    const linked = await get('SELECT o.number AS order_no, d.number AS doc_no FROM inv_order_docs d JOIN inv_orders o ON o.id = d.order_id WHERE d.voucher_id = ?', [v.id]).catch(() => null);
    if (linked) return res.status(409).json({ success: false, error: `Voucher ${v.voucher_no} was created from order ${linked.order_no} (${linked.doc_no}), so it cannot be deleted. Reverse it with a ${v.voucher_type === 'Purchase' ? 'Debit' : 'Credit'} Note instead.` });

    await run('BEGIN TRANSACTION');
    try {
      await run('DELETE FROM ledger_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM inventory_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM bill_allocations WHERE voucher_id = ?', [v.id]);
      await run("UPDATE quotations SET converted_voucher_id = NULL, status = 'Accepted' WHERE converted_voucher_id = ?", [v.id]).catch(() => {});
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

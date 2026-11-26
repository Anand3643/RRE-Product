const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');
const { postVoucher, alterVoucher, snapshotOf, reverseVoucher, negativeStockPolicy, setNegativeStockPolicy, VoucherValidationError, VoucherConflictError } = require('../../core/voucherService');
const { withTransaction } = require('../../core/tx');
const { logActivity } = require('../../core/auth');

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
    // ?limit=&offset= return one page (the dashboard asks for limit=500 and used to receive every voucher); total in X-Total-Count
    const limit = parseInt(req.query.limit, 10), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (limit > 0) {
      res.set('X-Total-Count', String((await get(`SELECT COUNT(*) AS n FROM (${sql}) AS t`, params)).n));
      sql += ' LIMIT ? OFFSET ?'; params.push(Math.min(limit, 1000), offset);
    }
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
    // Idempotency-Key: a retried or double-clicked request with the same key returns the first voucher instead of posting again
    const idem = req.get('Idempotency-Key');
    const result = await postVoucher(req.body || {}, { idempotencyKey: idem || null, userId: req.user ? req.user.userId : null });
    res.json({
      success: true,
      ...result,
      message: result.replayed ? `${result.voucher_type} Voucher ${result.voucher_no} was already recorded (same request)` : `${result.voucher_type} Voucher ${result.voucher_no} recorded successfully`
    });
  } catch (err) {
    const status = err instanceof VoucherValidationError ? (err.status || 400) : err instanceof VoucherConflictError ? 409 : /UNIQUE/.test(String(err.message)) ? 409 : 500;
    res.status(status).json({ success: false, error: status === 409 && !(err instanceof VoucherConflictError) && !(err instanceof VoucherValidationError) ? 'That voucher number is already used. Choose another number.' : err.message });
  }
});

// Alter a posted voucher (Tally "Alter"). Same checks as posting; the Day Book, ledgers, stock and reports change with it in one transaction;
// the voucher before and after is kept in the audit log. A save made from an older copy is refused (409, X-Row-Version: core/rowVersion.js).
router.put('/:id', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next(); // e.g. /settings/... is another route
  try {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    // an alteration is not a way around the approval rules: if the altered voucher would need approval, it is refused here
    const needs = await require('../../core/approvals').evaluate(body, req.user || {}).catch(() => []);
    if (needs && needs.length) {
      return res.status(409).json({ success: false, code: 'NEEDS_APPROVAL', error: `This change would need approval (${needs.map((m) => m.reason).join('; ')}). Cancel the voucher (reversal) and enter it again: the new voucher goes for approval.` });
    }
    const r = await alterVoucher(id, body, { user: req.user, ip: req.ip });
    res.json({ success: true, ...r, message: `${r.voucher_type} Voucher ${r.voucher_no} altered` });
  } catch (err) {
    const status = err instanceof VoucherValidationError ? (err.status || 400) : err instanceof VoucherConflictError ? 409 : /UNIQUE/.test(String(err.message)) ? 409 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Company setting: may sales take stock below zero? ('allow' as Tally does by default, or 'block')
router.get('/settings/negative-stock', async (req, res) => {
  try { res.json({ success: true, data: { negative_stock: await negativeStockPolicy() } }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
router.put('/settings/negative-stock', async (req, res) => {
  try {
    const v = await setNegativeStockPolicy(String((req.body || {}).negative_stock || ''));
    await logActivity({ user: req.user, action: 'SETTING_NEGATIVE_STOCK', entity: 'setting', entityId: 'negative_stock', details: { value: v } });
    res.json({ success: true, data: { negative_stock: v } });
  } catch (err) { res.status(err instanceof VoucherValidationError ? 400 : 500).json({ success: false, error: err.message }); }
});

// Reverse a posted voucher: posts its mirror image (Credit/Debit Note or Journal) and keeps the original - the accounting way to
// correct a posted voucher, with both visible in the books.
router.post('/:id/reverse', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await reverseVoucher(parseInt(req.params.id, 10), { date: b.date, narration: b.narration, userId: req.user ? req.user.userId : null });
    await logActivity({ user: req.user, action: 'VOUCHER_REVERSE', entity: 'voucher', entityId: req.params.id, details: { reversal_voucher: r.voucher_no } });
    res.json({ success: true, ...r, message: `Reversed by ${r.voucher_type} ${r.voucher_no}` });
  } catch (err) {
    const status = err instanceof VoucherValidationError ? (err.status || 400) : err instanceof VoucherConflictError ? 409 : 500;
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

    await withTransaction(async () => {
      // never silent: the complete voucher (lines, stock lines, bills) goes to the audit log in the SAME transaction, so it can be
      // reconstructed; if the audit record cannot be written, nothing is deleted
      const snapshot = {
        voucher: v,
        entries: await all('SELECT ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id FROM ledger_entries WHERE voucher_id = ? ORDER BY id', [v.id]),
        inventory: await all('SELECT stock_item_id, direction, quantity, rate, amount, discount_pct, godown_id FROM inventory_entries WHERE voucher_id = ? ORDER BY id', [v.id]),
        bill_allocations: await all('SELECT ledger_id, bill_type, bill_ref, amount, due_date FROM bill_allocations WHERE voucher_id = ? ORDER BY id', [v.id])
      };
      const u = req.user || {};
      await run('INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [u.userId || null, u.username || 'system', u.role || null, 'VOUCHER_DELETE', 'voucher', String(v.id), JSON.stringify(snapshot), req.ip || null]);
      await run('DELETE FROM ledger_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM inventory_entries WHERE voucher_id = ?', [v.id]);
      await run('DELETE FROM bill_allocations WHERE voucher_id = ?', [v.id]);
      await run("UPDATE quotations SET converted_voucher_id = NULL, status = 'Accepted' WHERE converted_voucher_id = ?", [v.id]).catch(() => {});
      await run('DELETE FROM vouchers WHERE id = ?', [v.id]);
    });
    res.json({ success: true, message: `Voucher ${v.voucher_no} deleted successfully (a full copy is kept in the audit log)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

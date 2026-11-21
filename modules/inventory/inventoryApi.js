/**
 * RRE Tally — inventory intelligence API (new). Mounted at /api/inventory.
 * Reads: any logged-in user. Setting a reorder level needs a role that can create vouchers.
 * Nothing here posts a voucher or changes stock quantities.
 */
const express = require('express');
const router = express.Router();
const { run, get } = require('../../core/db');
const { requireAuth, logActivity } = require('../../core/auth');
const inv = require('../../core/inventoryTools');

const read = requireAuth();
const write = requireAuth('canCreateVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.get('/reorder', read, handle((req) => inv.reorderSuggestions(req.query)));
router.get('/demand', read, handle((req) => inv.demandForecast(req.query)));
router.get('/dead-stock', read, handle((req) => inv.deadStock(req.query)));
router.get('/godown-stock', read, handle(() => inv.godownStock()));
router.get('/supplier-prices', read, handle((req) => inv.supplierPrices(parseInt(req.query.item_id, 10) || null)));
router.get('/movements/:id', read, handle((req) => inv.movementHistory(parseInt(req.params.id, 10), req.query)));

router.post('/items/:id/reorder-level', write, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const raw = req.body?.reorder_level;
    const level = Number(raw);
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean' || !Number.isFinite(level) || level < 0 || level > 1e9) {
      return res.status(400).json({ success: false, error: 'reorder_level must be a number ≥ 0.' });
    }
    const item = await get('SELECT id, name, reorder_level FROM stock_items WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ success: false, error: 'Stock item not found.' });
    await run('UPDATE stock_items SET reorder_level = ? WHERE id = ?', [level, id]);
    await logActivity({ user: req.user, ip: req.ip, action: 'REORDER_LEVEL_SET', entity: 'stock_item', entityId: id, details: { name: item.name, from: item.reorder_level, to: level } });
    res.json({ success: true, data: { id, reorder_level: level } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;

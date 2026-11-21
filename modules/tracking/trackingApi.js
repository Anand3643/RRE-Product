/**
 * RRE Tally — batch / expiry / serial tracking and barcode lookup API. Mounted at /api/tracking.
 * Reads: any logged-in user. Writes: roles that can create vouchers. Removing an allocation/serial: roles that can edit vouchers.
 */
const express = require('express');
const router = express.Router();
const t = require('../../core/trackingTools');
const { requireAuth } = require('../../core/auth');

const read = requireAuth();
const write = requireAuth('canCreateVouchers');
const edit = requireAuth('canEditVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message, details: err.details }); }
};
const pid = (req, k = 'id') => parseInt(req.params[k], 10);

router.get('/items', read, handle(() => t.listItems()));
router.post('/items/:id/settings', write, handle((req) => t.setItemSettings(pid(req), req.body || {}, req.user)));

router.get('/work', read, handle((req) => t.unallocated({ item_id: parseInt(req.query.item_id, 10) || null })));
router.get('/batches', read, handle((req) => t.listBatches({ item_id: parseInt(req.query.item_id, 10) || null, as_of: req.query.as_of })));
router.get('/expiring', read, handle((req) => t.expiring({ days: req.query.days, as_of: req.query.as_of })));
router.get('/entries/:id/fefo', read, handle((req) => t.fefoSuggestion(pid(req))));
router.post('/entries/:id/batches', write, handle((req) => t.allocateBatches(pid(req), req.body?.allocations, req.user)));
router.delete('/allocations/:id', edit, handle(async (req) => { await t.removeAllocation(pid(req), req.user); return { deleted: true }; }));

router.get('/serials', read, handle((req) => t.listSerials({ item_id: parseInt(req.query.item_id, 10) || null, status: req.query.status, q: req.query.q })));
router.get('/serials/history', read, handle((req) => t.serialHistory(String(req.query.serial || ''), parseInt(req.query.item_id, 10) || null)));
router.post('/entries/:id/serials', write, handle((req) => t.addSerials(pid(req), req.body?.serials, req.user)));
router.delete('/serials/:id', edit, handle(async (req) => { await t.removeSerial(pid(req), req.user); return { deleted: true }; }));

router.get('/lookup', read, handle((req) => t.lookup(req.query.code)));

module.exports = router;

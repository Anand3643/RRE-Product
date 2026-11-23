/**
 * RRE Tally — inventory suite API. Mounted at /api/inv. Every route checks the signed-in user's role on the server:
 *   read          any signed-in user (values/costs are hidden from roles that may not see financials)
 *   create/edit   canCreateVouchers (items, categories, units, warehouses)
 *   stock moves   canEditVouchers   (transfers, adjustments, archiving)
 *   delete        canDeleteVouchers
 */
const express = require('express');
const router = express.Router();
const inv = require('../../core/invCore');
const { requireAuth } = require('../../core/auth');

const read = requireAuth();
const write = requireAuth('canCreateVouchers');
const move = requireAuth('canEditVouchers');
const remove = requireAuth('canDeleteVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const id = (req) => { const n = parseInt(req.params.id, 10); if (!Number.isInteger(n) || n < 1) { const e = new Error('Invalid id.'); e.status = 400; throw e; } return n; };

router.get('/dashboard', read, handle((req) => inv.dashboard(req.user)));
router.get('/alerts', read, handle((req) => inv.alerts(req.user)));

router.get('/items', read, handle((req) => inv.listItems(req.query, req.user)));
router.get('/items/:id', read, handle((req) => inv.itemDetail(id(req), req.user)));
router.post('/items', write, handle((req) => inv.createItem(req.body || {}, req.user)));
router.patch('/items/:id', write, handle((req) => inv.updateItem(id(req), req.body || {}, req.user)));
router.post('/items/:id/archive', move, handle((req) => inv.setArchived(id(req), true, req.user)));
router.post('/items/:id/restore', move, handle((req) => inv.setArchived(id(req), false, req.user)));
router.delete('/items/:id', remove, handle((req) => inv.deleteItem(id(req), req.user)));

router.get('/categories', read, handle(() => inv.listCategories()));
router.post('/categories', write, handle((req) => inv.saveCategory(null, req.body || {}, req.user)));
router.patch('/categories/:id', write, handle((req) => inv.saveCategory(id(req), req.body || {}, req.user)));
router.delete('/categories/:id', remove, handle((req) => inv.deleteCategory(id(req), req.user)));

router.get('/units', read, handle(() => inv.listUnits()));
router.post('/units', write, handle((req) => inv.saveUnit(null, req.body || {}, req.user)));
router.patch('/units/:id', write, handle((req) => inv.saveUnit(id(req), req.body || {}, req.user)));
router.delete('/units/:id', remove, handle((req) => inv.deleteUnit(id(req), req.user)));

router.get('/warehouses', read, handle((req) => inv.listWarehouses(req.user)));
router.get('/warehouses/:id', read, handle((req) => inv.warehouseDetail(id(req), req.user)));
router.post('/warehouses', write, handle((req) => inv.saveWarehouse(null, req.body || {}, req.user)));
router.patch('/warehouses/:id', write, handle((req) => inv.saveWarehouse(id(req), req.body || {}, req.user)));
router.post('/warehouses/:id/archive', move, handle((req) => inv.setWarehouseActive(id(req), false, req.user)));
router.post('/warehouses/:id/restore', move, handle((req) => inv.setWarehouseActive(id(req), true, req.user)));

router.get('/stock', read, handle((req) => inv.stockLevels(req.query, req.user)));
router.get('/movements', read, handle((req) => inv.movements(req.query, req.user)));

router.get('/transfers', read, handle((req) => inv.listDocs('transfer', req.query, req.user)));
router.get('/transfers/:id', read, handle((req) => inv.getDoc(id(req), req.user)));
router.post('/transfers', move, handle((req) => inv.createTransfer(req.body || {}, req.user)));

router.get('/adjustments', read, handle((req) => inv.listDocs('adjustment', req.query, req.user)));
router.get('/adjustments/:id', read, handle((req) => inv.getDoc(id(req), req.user)));
router.post('/adjustments', move, handle((req) => inv.createAdjustment(req.body || {}, req.user)));
router.get('/adjustment-reasons', read, handle(async () => inv.ADJUSTMENT_REASONS));

module.exports = router;

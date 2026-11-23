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
const ord = require('../../core/invOrders');
const rep = require('../../core/invReports');
const imp = require('../../core/invImport');
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

// ---- stage 2: customers, suppliers, purchase orders, sales orders, history
const kindOf = { customers: 'customer', suppliers: 'supplier' };
for (const [path, kind] of Object.entries(kindOf)) {
  router.get(`/${path}`, read, handle((req) => ord.listParties(kind, req.query, req.user)));
  router.get(`/${path}/:id`, read, handle((req) => ord.partyDetail(kind, id(req), req.user)));
  router.post(`/${path}`, write, handle((req) => ord.saveParty(kind, null, req.body || {}, req.user)));
  router.patch(`/${path}/:id`, write, handle((req) => ord.saveParty(kind, id(req), req.body || {}, req.user)));
  router.post(`/${path}/:id/archive`, move, handle((req) => ord.setPartyActive(kind, id(req), false, req.user)));
  router.post(`/${path}/:id/restore`, move, handle((req) => ord.setPartyActive(kind, id(req), true, req.user)));
}
for (const [path, kind] of [['purchase-orders', 'purchase'], ['sales-orders', 'sales']]) {
  router.get(`/${path}`, read, handle((req) => ord.listOrders(kind, req.query, req.user)));
  router.post(`/${path}`, write, handle((req) => ord.createOrder(kind, req.body || {}, req.user)));
}
router.get('/orders/:id', read, handle((req) => ord.getOrder(id(req), req.user)));
router.put('/orders/:id', write, handle((req) => ord.updateOrder(id(req), req.body || {}, req.user)));
router.delete('/orders/:id', write, handle((req) => ord.deleteOrder(id(req), req.user)));
router.post('/orders/:id/confirm', write, handle((req) => ord.confirmOrder(id(req), req.user)));
router.post('/orders/:id/cancel', move, handle((req) => ord.cancelOrder(id(req), req.body && req.body.reason, req.user)));
router.post('/orders/:id/receive', write, handle((req) => ord.receiveGoods(id(req), req.body || {}, req.user)));
router.post('/orders/:id/invoice', write, handle((req) => ord.invoiceOrder(id(req), req.body || {}, req.user)));
router.get('/purchase-history', read, handle((req) => ord.history('purchase', req.query, req.user)));
router.get('/sales-history', read, handle((req) => ord.history('sales', req.query, req.user)));

// ---- stage 3: reports and the StockPilot import
router.get('/reports', read, handle((req) => rep.list(req.user)));
router.get('/reports/:rid', read, async (req, res) => {
  try {
    if (req.query.format === 'csv') {
      const c = await rep.csv(req.params.rid, req.query, req.user);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${c.filename}"`);
      return res.send(c.body);
    }
    res.json({ success: true, data: await rep.run(req.params.rid, req.query, req.user) });
  } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});
const owner = requireAuth('canAlterCompany');
router.get('/import/detect', owner, handle(async () => imp.detect()));
router.post('/import/preview', owner, handle((req) => imp.preview(req.body && req.body.path, req.body && req.body.org_id)));
router.post('/import/run', owner, handle((req) => {
  if (!req.body || req.body.confirm !== true) { const e = new Error('Confirm the import after checking the preview.'); e.status = 400; throw e; }
  return imp.importAll(req.body.path, req.body.org_id, req.user);
}));

module.exports = router;

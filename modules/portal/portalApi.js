/**
 * RRE Tally — customer portal API, mounted at /api/portal. Every route runs portalOnly first: only an active "Customer" login that is
 * tied to an active customer account gets in, and every query is scoped to THAT customer (read from the database, never the request).
 */
const express = require('express');
const router = express.Router();
const portal = require('../../core/portal');

const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { if (!err.status) console.error('[Portal] ' + err.message); res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Something went wrong. Please try again.' }); }
};
const id = (req) => { const n = /^\d{1,12}$/.test(req.params.id) ? parseInt(req.params.id, 10) : 0; if (n < 1) { const e = new Error('Not found.'); e.status = 404; throw e; } return n; };

router.use((req, res, next) => require('../../core/db').withCompany(null, next)); // the owner's customers: always the active company
router.use(portal.portalOnly);
router.get('/me', handle((req) => portal.me(req.portal)));
const extra = require('../../core/portalExtra');
router.get('/dashboard', handle((req) => extra.dashboard(req.portal)));
router.get('/packages', handle((req) => extra.packages(req.portal)));
router.get('/history', handle((req) => extra.history(req.portal, req.query)));
router.get('/summary', handle((req) => portal.summary(req.portal)));
router.get('/catalogue', handle((req) => portal.catalogue(req.query)));
router.get('/orders', handle((req) => portal.listOrders(req.portal, req.query)));
router.post('/orders', handle((req) => portal.placeOrder(req.portal, req.body)));
router.get('/orders/:id', handle((req) => portal.getOrder(req.portal, id(req))));
router.post('/orders/:id/cancel', handle((req) => portal.cancelOrder(req.portal, id(req), req.body && req.body.reason)));
router.get('/invoices', handle((req) => portal.listInvoices(req.portal, req.query)));
router.get('/invoices/:id', handle((req) => portal.getInvoice(req.portal, id(req))));

module.exports = router;

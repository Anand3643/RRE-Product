/**
 * RRE Tally — smart search and quick look API. Mounted at /api/search. Read-only; any signed-in user.
 * Amounts and balances follow the same role rules as the financial reports.
 */
const express = require('express');
const router = express.Router();
const s = require('../../core/searchTools');
const { requireAuth } = require('../../core/auth');

const any = requireAuth();
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const pid = (req) => { const n = parseInt(req.params.id, 10); if (!Number.isInteger(n) || n < 1) { const e = new Error('Invalid id.'); e.status = 400; throw e; } return n; };

router.get('/', any, handle((req) => s.search(req.query.q, req.user)));
router.get('/voucher/:id', any, handle((req) => s.voucherLook(pid(req))));
router.get('/ledger/:id', any, handle((req) => s.ledgerLook(pid(req), req.user)));
router.get('/item/:id', any, handle((req) => s.itemLook(pid(req), req.user)));

module.exports = router;

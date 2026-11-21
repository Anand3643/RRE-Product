/**
 * RRE Tally — financial-year closing assistant API. Mounted at /api/yearend. Read-only; needs financial-view permission.
 */
const express = require('express');
const router = express.Router();
const ye = require('../../core/yearEnd');
const { requireAuth } = require('../../core/auth');

const guard = requireAuth('canViewFinancials');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.get('/readiness', guard, handle((req) => ye.readiness(req.query)));
router.get('/snapshot', guard, handle((req) => ye.snapshot(req.query)));
router.get('/opening-pack', guard, handle((req) => ye.openingPack(req.query)));

module.exports = router;

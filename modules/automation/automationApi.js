/**
 * RRE Tally — accounting automation API (read-only analysis). Mounted at /api/automation.
 * Pre-entry helpers (duplicate-check, suggest, categorize) are open to any logged-in user.
 * Books-wide scans (duplicates, unusual, reminders) need the financial-view permission.
 */
const express = require('express');
const router = express.Router();
const auto = require('../../core/automationTools');
const { requireAuth } = require('../../core/auth');

const any = requireAuth();
const fin = requireAuth('canViewFinancials');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.post('/duplicate-check', any, handle((req) => auto.duplicateCheck(req.body || {})));
router.post('/suggest', any, handle((req) => auto.suggestLedgers(req.body || {})));
router.post('/categorize', any, handle((req) => auto.categorize(req.body || {})));
router.get('/duplicates', fin, handle((req) => auto.scanDuplicates(req.query)));
router.get('/unusual', fin, handle((req) => auto.unusualTransactions(req.query)));
router.get('/reminders', fin, handle((req) => auto.overdueReminders({ min_days: parseInt(req.query.min_days, 10) || 1 })));

module.exports = router;

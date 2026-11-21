/**
 * RRE Tally — organisation API: branches, departments, voucher tagging, budgets, credit limits, supplier performance.
 * Mounted at /api/org. Creating/editing masters and tagging need the edit permission (Owner, Accountant);
 * reports need the financial-view permission. Nothing here changes a posting.
 */
const express = require('express');
const router = express.Router();
const org = require('../../core/orgTools');
const { requireAuth } = require('../../core/auth');

const any = requireAuth();
const edit = requireAuth('canEditVouchers');
const fin = requireAuth('canViewFinancials');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const pid = (req) => parseInt(req.params.id, 10);
const kindOf = (req) => (req.params.kind === 'branches' ? 'branch' : req.params.kind === 'departments' ? 'department' : null);
const need = (req) => { const k = kindOf(req); if (!k) { const e = new Error('Unknown resource.'); e.status = 404; throw e; } return k; };

router.get('/units/:kind', any, handle((req) => org.listUnits(need(req))));
router.post('/units/:kind', edit, handle((req) => org.saveUnit(need(req), null, req.body || {}, req.user)));
router.put('/units/:kind/:id', edit, handle((req) => org.saveUnit(need(req), pid(req), req.body || {}, req.user)));
router.post('/units/:kind/:id/active', edit, handle(async (req) => { await org.setUnitActive(need(req), pid(req), req.body?.active !== false, req.user); return { ok: true }; }));

router.post('/tag', edit, handle((req) => org.tagVouchers(req.body || {}, req.user)));
router.get('/defaults', any, handle((req) => org.getDefaults(req.user.username)));
router.post('/defaults', any, handle((req) => org.setDefaults(req.user.username, req.body || {})));

router.get('/expenses', fin, handle((req) => org.expensesBy(req.query.by || 'department', req.query)));
router.get('/branch-summary', fin, handle((req) => org.branchSummary(req.query)));

router.get('/budgets', fin, handle((req) => org.budgetStatus(req.query.as_of)));
router.post('/budgets', edit, handle((req) => org.saveBudget(null, req.body || {}, req.user)));
router.put('/budgets/:id', edit, handle((req) => org.saveBudget(pid(req), req.body || {}, req.user)));
router.delete('/budgets/:id', edit, handle(async (req) => { await org.deleteBudget(pid(req), req.user); return { deleted: true }; }));

router.get('/credit-status', fin, handle((req) => org.creditStatus(req.query.as_of)));
router.post('/credit-limits', edit, handle((req) => org.setCreditLimit(parseInt(req.body?.ledger_id, 10), req.body?.credit_limit, req.user)));
router.post('/credit-check', any, handle((req) => org.creditCheck(parseInt(req.body?.party_ledger_id, 10), req.body?.amount)));

router.get('/supplier-performance', fin, handle((req) => org.supplierPerformance(req.query)));

module.exports = router;

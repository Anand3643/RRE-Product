/**
 * RRE Tally — approvals API. Mounted at /api/approvals.
 * Rules: anyone logged in can read them; only the Owner changes them.
 * Requests: approvers (edit permission) see and decide all of them; everyone sees and can cancel their own.
 * The hold itself happens in the voucher route's gate (core/approvals.js), not here.
 */
const express = require('express');
const router = express.Router();
const ap = require('../../core/approvals');
const { requireAuth } = require('../../core/auth');

const any = requireAuth();
const approver = requireAuth('canEditVouchers');
const owner = requireAuth('canAlterCompany');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const pid = (req) => parseInt(req.params.id, 10);

router.get('/rules', any, handle(async () => ({ rules: await ap.listRules(), kinds: ap.KINDS, roles: ap.ROLES })));
router.post('/rules', owner, handle((req) => ap.saveRule(null, req.body || {}, req.user)));
router.put('/rules/:id', owner, handle((req) => ap.saveRule(pid(req), req.body || {}, req.user)));
router.post('/rules/:id/active', owner, handle(async (req) => { await ap.setRuleActive(pid(req), req.body?.active !== false, req.user); return { ok: true }; }));

router.get('/requests', approver, handle((req) => ap.listRequests({ status: ['pending', 'approved', 'rejected', 'cancelled', 'all'].includes(req.query.status) ? req.query.status : 'pending' })));
router.get('/mine', any, handle((req) => ap.listRequests({ status: 'all', mine: req.user.username })));
router.post('/requests/:id/approve', approver, handle((req) => ap.approve(pid(req), req.user, req.socket.localPort, req.body?.note)));
router.post('/requests/:id/reject', approver, handle(async (req) => { await ap.reject(pid(req), req.user, req.body?.note); return { rejected: true }; }));
router.post('/requests/:id/cancel', any, handle(async (req) => { await ap.cancel(pid(req), req.user); return { cancelled: true }; }));

module.exports = router;

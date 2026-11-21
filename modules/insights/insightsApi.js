/**
 * RRE Tally — insights API (read-only). Mounted at /api/insights.
 * Everything here needs the financial-view permission except /ask, which enforces it per question.
 */
const express = require('express');
const router = express.Router();
const ins = require('../../core/insightsEngine');
const assistant = require('../../core/assistant');
const { requireAuth } = require('../../core/auth');
const { getRolePermissions } = require('../../core/db');

const fin = requireAuth('canViewFinancials');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.post('/ask', requireAuth(), handle(async (req) => {
  const r = await assistant.ask(req.body?.question, { perms: getRolePermissions(req.user.role), as_of: req.body?.as_of });
  return r || { intent: null, answer: null };
}));
router.get('/summary', fin, handle(async (req) => ins.dailySummary(await ins.booksDate(req.query.as_of))));
router.get('/health', fin, handle(async (req) => ins.healthScore(await ins.booksDate(req.query.as_of))));
router.get('/cashflow', fin, handle(async (req) => {
  const f = Number(req.query.scenario);
  return ins.cashflowForecast(await ins.booksDate(req.query.as_of), { days: req.query.days, scenario_factor: Number.isFinite(f) && f > 0 && f <= 2 ? f : 1 });
}));
router.get('/trends', fin, handle(async (req) => {
  const metric = ['sales', 'expenses', 'net_profit', 'gross_profit'].includes(req.query.metric) ? req.query.metric : 'sales';
  return ins.trends(await ins.booksDate(req.query.as_of), { metric });
}));

module.exports = router;

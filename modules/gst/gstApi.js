/**
 * RRE Tally — GST tools API (new). Mounted at /api/gst. All routes require a signed session token
 * with the financial-view permission. Nothing here files returns or calls government systems.
 */
const express = require('express');
const router = express.Router();
const { run, get, all } = require('../../core/db');
const { requireAuth, logActivity } = require('../../core/auth');
const tools = require('../../core/gstTools');

const guard = requireAuth('canViewFinancials');

router.post('/validate-gstin', guard, (req, res) => {
  const list = Array.isArray(req.body?.gstins) ? req.body.gstins.slice(0, 200) : [req.body?.gstin];
  const results = list.map((g) => tools.validateGstin(g));
  res.json({ success: true, data: Array.isArray(req.body?.gstins) ? results : results[0] });
});

router.post('/validate-hsn', guard, (req, res) => {
  res.json({ success: true, data: tools.validateHsn(req.body?.code) });
});

router.get('/audit-masters', guard, async (req, res) => {
  try { res.json({ success: true, data: await tools.auditMasters() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/tax-check', guard, async (req, res) => {
  try {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const { from_date, to_date } = req.query;
    if ((from_date && !iso.test(from_date)) || (to_date && !iso.test(to_date))) {
      return res.status(400).json({ success: false, error: 'Dates must be YYYY-MM-DD.' });
    }
    res.json({ success: true, data: await tools.validateTaxes({ from_date, to_date }) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/gstr2b/reconcile', guard, async (req, res) => {
  try {
    const { content, format, period, name } = req.body || {};
    if (!content || !format) return res.status(400).json({ success: false, error: 'content and format ("json" or "csv") are required.' });
    if (period && !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ success: false, error: 'period must be YYYY-MM.' });
    const result = await tools.reconcileGstr2b(content, format, { period });
    const saved = await run(
      'INSERT INTO gst_recon_runs (created_by, period, source_name, summary, result) VALUES (?, ?, ?, ?, ?)',
      [req.user.username, period || null, String(name || '').slice(0, 120) || null, JSON.stringify(result.summary), JSON.stringify(result)]
    );
    await logActivity({ user: req.user, ip: req.ip, action: 'GSTR2B_RECONCILE', entity: 'gst', entityId: saved.lastID, details: result.summary });
    res.json({ success: true, run_id: saved.lastID, data: result });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.get('/gstr2b/history', guard, async (req, res) => {
  try {
    const rows = await all('SELECT id, created_at, created_by, period, source_name, summary FROM gst_recon_runs ORDER BY id DESC LIMIT 50');
    res.json({ success: true, data: rows.map((r) => ({ ...r, summary: JSON.parse(r.summary) })) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/gstr2b/history/:id', guard, async (req, res) => {
  try {
    const r = await get('SELECT * FROM gst_recon_runs WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (!r) return res.status(404).json({ success: false, error: 'Run not found.' });
    res.json({ success: true, data: { ...r, summary: JSON.parse(r.summary), result: JSON.parse(r.result) } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;

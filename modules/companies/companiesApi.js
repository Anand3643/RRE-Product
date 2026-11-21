/**
 * RRE Tally — companies API. Mounted at /api/companies.
 * Listing: any logged-in user. Creating or switching a company: Owner (company-alteration permission) only.
 * Nothing here deletes a company.
 */
const express = require('express');
const router = express.Router();
const companies = require('../../core/companies');
const { requireAuth } = require('../../core/auth');

const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.get('/', requireAuth(), handle(() => companies.list()));
router.post('/', requireAuth('canAlterCompany'), handle((req) => companies.create(req.body || {}, req.user)));
router.post('/switch', requireAuth('canAlterCompany'), handle((req) => companies.switchTo(String(req.body?.number || ''), req.user)));

module.exports = router;

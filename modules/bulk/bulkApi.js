/**
 * RRE Tally — recurring vouchers (/api/recurring) and CSV voucher import (/api/import).
 * Everything that posts to the books requires a role that can create vouchers AND be allowed that voucher type,
 * and is logged in the activity log. Recurring entries only ever become drafts until a person confirms them.
 */
const express = require('express');
const recurringRouter = express.Router();
const importRouter = express.Router();
const { run, get } = require('../../core/db');
const { requireAuth, logActivity } = require('../../core/auth');
const recurring = require('../../core/recurring');
const importer = require('../../core/importTools');

const read = requireAuth();
const write = requireAuth('canCreateVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const pid = (req) => parseInt(req.params.id, 10);
const notFound = (m) => { const e = new Error(m); e.status = 404; return e; };

// ---------------- recurring ----------------
recurringRouter.get('/templates', read, handle(() => recurring.listTemplates()));
recurringRouter.post('/templates', write, handle(async (req) => {
  const t = await recurring.createTemplate(req.body || {}, req.user);
  await logActivity({ user: req.user, ip: req.ip, action: 'RECURRING_CREATE', entity: 'recurring_template', entityId: t.id, details: { name: t.name } });
  await recurring.generateDueDrafts();
  return t;
}));
recurringRouter.post('/templates/:id/toggle', write, handle(async (req) => {
  const t = await get('SELECT * FROM recurring_templates WHERE id = ?', [pid(req)]);
  if (!t) throw notFound('Template not found.');
  const active = t.is_active ? 0 : 1;
  await run('UPDATE recurring_templates SET is_active = ? WHERE id = ?', [active, t.id]);
  await logActivity({ user: req.user, ip: req.ip, action: active ? 'RECURRING_ENABLE' : 'RECURRING_PAUSE', entity: 'recurring_template', entityId: t.id });
  return { is_active: active };
}));
recurringRouter.delete('/templates/:id', requireAuth('canAlterCompany'), handle(async (req) => {
  const r = await run('DELETE FROM recurring_templates WHERE id = ?', [pid(req)]);
  if (!r.changes) throw notFound('Template not found.');
  await logActivity({ user: req.user, ip: req.ip, action: 'RECURRING_DELETE', entity: 'recurring_template', entityId: pid(req) });
  return { deleted: true };
}));
recurringRouter.get('/drafts', read, handle((req) => recurring.listDrafts(['pending', 'posted', 'skipped', 'all'].includes(req.query.status) ? req.query.status : 'pending')));
recurringRouter.post('/drafts/:id/confirm', write, handle((req) => recurring.confirmDraft(pid(req), req.body || {}, req.user)));
recurringRouter.post('/drafts/:id/skip', write, handle(async (req) => { await recurring.skipDraft(pid(req), req.user); return { skipped: true }; }));
recurringRouter.post('/run', write, handle(() => recurring.generateDueDrafts()));

// ---------------- import ----------------
importRouter.get('/template', read, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="RRE_voucher_import_template.csv"');
  res.send('﻿' + importer.TEMPLATE);
});
importRouter.post('/preview', write, handle((req) => importer.preview(req.body?.content, req.body?.filename, req.user)));
importRouter.get('/batches', read, handle(() => importer.listBatches()));
importRouter.get('/batches/:id', read, handle((req) => importer.getBatch(pid(req))));
importRouter.post('/batches/:id/commit', write, handle((req) => importer.commit(pid(req), { skip_invalid: req.body?.skip_invalid === true, include_warnings: req.body?.include_warnings === true }, req.user)));
importRouter.post('/batches/:id/discard', write, handle(async (req) => { await importer.discard(pid(req), req.user); return { discarded: true }; }));

module.exports = { recurringRouter, importRouter };

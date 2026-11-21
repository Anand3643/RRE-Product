/**
 * RRE Tally — banking API (new). Mounted at /api/bank.
 * Reads: any logged-in user. Writes (import / confirm / unmatch / ignore): roles that can create vouchers.
 * No endpoint here posts or edits a voucher.
 */
const express = require('express');
const router = express.Router();
const { get, all } = require('../../core/db');
const { requireAuth, logActivity } = require('../../core/auth');
const bank = require('../../core/bankTools');

const read = requireAuth();
const write = requireAuth('canCreateVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, ...(await fn(req)) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message, details: err.details }); }
};
const id = (req, k = 'id') => parseInt(req.params[k], 10);

router.get('/ledgers', read, handle(async () => ({
  data: await all(`SELECT l.id, l.name, g.name AS group_name FROM ledgers l JOIN account_groups g ON l.group_id = g.id
                   WHERE g.name IN ('Bank Accounts','Bank OD A/c') ORDER BY l.name`)
})));

router.post('/import', write, handle(async (req) => {
  const r = await bank.importStatement({ bank_ledger_id: parseInt(req.body?.bank_ledger_id, 10), content: req.body?.content, filename: req.body?.filename }, req.user);
  await logActivity({ user: req.user, ip: req.ip, action: 'BANK_STATEMENT_IMPORT', entity: 'bank', entityId: r.import_id, details: { rows: r.rows, duplicates: r.duplicates } });
  return { data: r };
}));

router.get('/imports', read, handle(async (req) => ({ data: await bank.listImports(parseInt(req.query.bank_ledger_id, 10) || null) })));

router.get('/imports/:id/suggestions', read, handle(async (req) => {
  const win = Math.min(60, Math.max(1, parseInt(req.query.window, 10) || 15));
  return { data: await bank.suggestMatches(id(req), { windowDays: win }) };
}));

router.get('/imports/:id/lines', read, handle(async (req) => {
  const st = req.query.status;
  const rows = st
    ? await all('SELECT * FROM bank_statement_lines WHERE import_id = ? AND status = ? ORDER BY line_date, id', [id(req), String(st)])
    : await all('SELECT * FROM bank_statement_lines WHERE import_id = ? ORDER BY line_date, id', [id(req)]);
  return { data: rows };
}));

router.post('/imports/:id/confirm', write, handle(async (req) => {
  const r = await bank.confirmMatches(id(req), req.body?.matches, req.user);
  await logActivity({ user: req.user, ip: req.ip, action: 'BANK_MATCH_CONFIRM', entity: 'bank', entityId: id(req), details: r });
  return { data: r };
}));

router.post('/lines/:id/unmatch', write, handle(async (req) => {
  const r = await bank.unmatchLine(id(req), req.user);
  await logActivity({ user: req.user, ip: req.ip, action: 'BANK_UNMATCH', entity: 'bank', entityId: id(req) });
  return { data: r };
}));

router.post('/lines/:id/ignore', write, handle(async (req) => ({ data: await bank.setIgnored(id(req), true, req.body?.reason, req.user) })));
router.post('/lines/:id/unignore', write, handle(async (req) => ({ data: await bank.setIgnored(id(req), false, null, req.user) })));

router.get('/summary', read, handle(async (req) => ({ data: await bank.bankSummary(parseInt(req.query.bank_ledger_id, 10)) })));

router.get('/payments', read, handle(async (req) => ({
  data: await bank.paymentStatus(parseInt(req.query.bank_ledger_id, 10), { status: req.query.status, limit: parseInt(req.query.limit, 10) || 200 })
})));

router.get('/history', read, handle(async (req) => ({ data: await bank.listHistory(parseInt(req.query.bank_ledger_id, 10) || null, parseInt(req.query.limit, 10) || 100) })));

module.exports = router;

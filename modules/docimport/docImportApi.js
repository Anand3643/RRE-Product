/**
 * RRE Tally — document import API (PDF / Excel / CSV / scans). Mounted at /api/doc-import.
 *   POST /upload                 raw file bytes (header X-File-Name)      -> read + classified; nothing posted
 *   POST /:id/ocr-page?page=n    a PNG of one scanned page (rendered by the browser) -> its text (offline OCR)
 *   GET  /:id/preview, POST /:id/preview {settings} -> every record with its checks (nothing posted)
 *   POST /:id/commit {settings}  -> the valid records, in one transaction; a retry returns the first result
 *   GET  /, GET /:id, GET /:id/file   history, one import's result, the original file
 * Upload / import: a role that may create vouchers (Owner, Administrator, Accountant, Data Entry; voucher types per role).
 * History and originals: a role that may create vouchers or see the financial statements. Customers never reach this (routeGuard).
 */
const express = require('express');
const router = express.Router();
const di = require('../../core/docImport');
const { requireAuth, logActivity } = require('../../core/auth');
const { getRolePermissions } = require('../../core/db');

const canImport = requireAuth('canCreateVouchers');
const canView = (req, res, next) => requireAuth()(req, res, () => {
  const p = getRolePermissions((req.user && req.user.role) || 'Guest');
  if (p.canCreateVouchers || p.canViewFinancials) return next();
  return res.status(403).json({ success: false, error: 'Your role may not see imported documents.' });
});
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) {
    if (req.params && req.params.id && err.status !== 404 && req.method === 'POST' && /commit/.test(req.path)) await di.markFailed(parseInt(req.params.id, 10), err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, ...(err.preview ? { preview: err.preview } : {}) });
  }
};
const id = (req) => { const n = parseInt(req.params.id, 10); if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Invalid id.'), { status: 400 }); return n; };
const raw = (limit) => express.raw({ type: () => true, limit });

router.post('/upload', canImport, raw('30mb'), handle(async (req) => {
  const name = decodeURIComponent(String(req.get('X-File-Name') || 'document')).slice(0, 180);
  const r = await di.upload({ buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), fileName: name, mime: req.get('Content-Type') }, req.user);
  await logActivity({ user: req.user, ip: req.ip, action: 'DOCUMENT_UPLOAD', entity: 'import_document', entityId: r.id, details: { file: r.file_name, kind: r.kind, category: r.classification.category } });
  return r;
}));
router.post('/:id/ocr-page', canImport, raw('8mb'), handle(async (req) => {
  const page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) throw Object.assign(new Error('page must be a page number.'), { status: 400 });
  return di.addOcrPage(id(req), page, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
}));
router.get('/:id/preview', canImport, handle((req) => di.preview(id(req))));
router.post('/:id/preview', canImport, handle((req) => di.preview(id(req), (req.body && req.body.settings) || {})));
router.post('/:id/commit', canImport, handle((req) => di.commit(id(req), (req.body && req.body.settings) || {}, req.user)));
router.get('/', canView, handle(() => di.history()));
router.get('/:id', canView, handle((req) => di.detail(id(req))));
router.get('/:id/file', canView, async (req, res) => {
  try {
    const f = await di.original(id(req));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(f.data);
  } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});

module.exports = router;

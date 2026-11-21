/**
 * RRE Tally — voucher attachments API. Mounted at /api/attachments.
 * Anyone logged in can list/download (same visibility as the voucher itself);
 * adding needs a role that can create vouchers; removing needs a role that can edit vouchers.
 */
const express = require('express');
const router = express.Router();
const att = require('../../core/attachments');
const { requireAuth } = require('../../core/auth');

const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const pid = (req, k = 'id') => parseInt(req.params[k], 10);

router.get('/voucher/:vid', requireAuth(), handle((req) => att.list(pid(req, 'vid'))));
router.post('/voucher/:vid', requireAuth('canCreateVouchers'), handle((req) => att.addAttachment(pid(req, 'vid'), req.body || {}, req.user)));

router.get('/:id/download', requireAuth(), async (req, res) => {
  try {
    const a = await att.read(pid(req));
    const safe = a.filename.replace(/[^\w.\- ]/g, '_');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', a.data.length);
    res.end(a.data);
  } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});

router.delete('/:id', requireAuth('canEditVouchers'), handle(async (req) => { await att.remove(pid(req), req.user); return { deleted: true }; }));

module.exports = router;

/**
 * RRE Tally — invoice scanning API. Mounted at /api/ocr. Needs a role that can create vouchers.
 * It only READS an image or text and returns a draft for review; nothing is posted or saved.
 */
const express = require('express');
const router = express.Router();
const ocr = require('../../core/ocr');
const { extractInvoice } = require('../../core/invoiceExtract');
const { requireAuth, logActivity } = require('../../core/auth');

const guard = requireAuth('canCreateVouchers');
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };

router.post('/scan', guard, handle(async (req) => {
  const b64 = req.body?.image_base64;
  if (typeof b64 !== 'string' || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('image_base64 must be valid base64.');
  if (b64.length > Math.ceil(ocr.MAX_BYTES * 4 / 3) + 8) throw bad('Image is larger than 6 MB.', 413);
  const buf = Buffer.from(b64, 'base64');
  const t0 = Date.now();
  const o = await ocr.recognise(buf);
  if (!o.text.trim()) throw bad('No text could be read from the image. Try a sharper, well-lit, upright photo or a higher-resolution scan.', 422);
  const extraction = await extractInvoice(o.text, { ocrConfidence: o.confidence });
  await logActivity({ user: req.user, ip: req.ip, action: 'INVOICE_SCAN', entity: 'ocr', details: { bytes: buf.length, ocr_confidence: o.confidence, ms: Date.now() - t0, needs_review: extraction.needs_review } });
  return { ocr: { text: o.text, confidence: o.confidence, milliseconds: Date.now() - t0 }, extraction };
}));

router.post('/extract', guard, handle(async (req) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) throw bad('Provide the invoice text.');
  if (text.length > 60000) throw bad('Text is too long (max 60,000 characters).', 413);
  return { extraction: await extractInvoice(text) };
}));

module.exports = router;

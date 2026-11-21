/**
 * RRE Tally — document attachments on vouchers (invoices, bills, cheque images…).
 *
 * Files live INSIDE the company database (table voucher_attachment_data), so:
 *   - every backup / restore includes them,
 *   - deleting a voucher deletes its attachments (foreign-key cascade),
 *   - no loose files can be orphaned or tampered with on disk.
 * Safety: the file type is decided from the file's own bytes (not the name or browser MIME), the extension must
 * agree with it, and downloads are always served as attachments with nosniff (never rendered inline).
 */
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { logActivity } = require('./auth');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_VOUCHER = 20;

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };

const TYPES = {
  pdf: { mime: 'application/pdf', test: (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  csv: { mime: 'text/csv', test: (b) => isText(b) },
  txt: { mime: 'text/plain', test: (b) => isText(b) }
};
const EXT_ALIAS = { jpeg: 'jpg' };

function isText(b) {
  if (b.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch (e) { return false; }
}

function cleanName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F"<>:|?*]/g, '').trim();
  if (!base || base.startsWith('.')) throw bad('A file name is required.');
  return base.slice(0, 120);
}

function classify(filename, buf) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  const ext = m ? (EXT_ALIAS[m[1].toLowerCase()] || m[1].toLowerCase()) : null;
  if (!ext || !TYPES[ext]) throw bad('Allowed file types: PDF, PNG, JPG, WEBP, XLSX, CSV, TXT.');
  if (!TYPES[ext].test(buf)) throw bad(`The file's contents are not a valid ${ext.toUpperCase()}. (The extension must match the real file type.)`);
  return { ext, mime: TYPES[ext].mime };
}

async function addAttachment(voucherId, { filename, content_base64 }, user) {
  const v = await get('SELECT id, voucher_no FROM vouchers WHERE id = ?', [voucherId]);
  if (!v) throw bad('Voucher not found.', 404);
  const name = cleanName(filename);
  if (typeof content_base64 !== 'string' || !content_base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content_base64)) throw bad('content_base64 must be valid base64.');
  if (content_base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw bad(`File is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 413);
  const buf = Buffer.from(content_base64, 'base64');
  if (!buf.length) throw bad('The file is empty.');
  if (buf.length > MAX_BYTES) throw bad(`File is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 413);
  const { ext, mime } = classify(name, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if ((await get('SELECT COUNT(*) c FROM voucher_attachments WHERE voucher_id = ?', [voucherId])).c >= MAX_PER_VOUCHER) throw bad(`A voucher can have at most ${MAX_PER_VOUCHER} attachments.`);
  if (await get('SELECT id FROM voucher_attachments WHERE voucher_id = ? AND sha256 = ?', [voucherId, sha])) throw bad('This exact file is already attached to the voucher.', 409);

  const ins = await run(`INSERT INTO voucher_attachments (voucher_id, filename, mime, ext, size_bytes, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [voucherId, name, mime, ext, buf.length, sha, user?.username || 'unknown']);
  await run('INSERT INTO voucher_attachment_data (attachment_id, data) VALUES (?, ?)', [ins.lastID, buf]);
  await logActivity({ user, action: 'ATTACHMENT_ADD', entity: 'voucher', entityId: voucherId, details: { file: name, bytes: buf.length, voucher_no: v.voucher_no } });
  return { id: ins.lastID, filename: name, mime, size_bytes: buf.length, sha256: sha };
}

function list(voucherId) {
  return all('SELECT id, voucher_id, filename, mime, size_bytes, sha256, uploaded_by, uploaded_at FROM voucher_attachments WHERE voucher_id = ? ORDER BY id', [voucherId]);
}

async function read(id) {
  const a = await get('SELECT a.*, d.data FROM voucher_attachments a JOIN voucher_attachment_data d ON d.attachment_id = a.id WHERE a.id = ?', [id]);
  if (!a) throw bad('Attachment not found.', 404);
  return a;
}

async function remove(id, user) {
  const a = await get('SELECT id, voucher_id, filename FROM voucher_attachments WHERE id = ?', [id]);
  if (!a) throw bad('Attachment not found.', 404);
  await run('DELETE FROM voucher_attachments WHERE id = ?', [id]); // data row cascades
  await logActivity({ user, action: 'ATTACHMENT_DELETE', entity: 'voucher', entityId: a.voucher_id, details: { file: a.filename } });
}

module.exports = { addAttachment, list, read, remove, MAX_BYTES, MAX_PER_VOUCHER };

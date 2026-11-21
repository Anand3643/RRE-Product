/**
 * RRE Tally — offline OCR (Tesseract). Runs entirely on this computer: the English language file is bundled in /ocr
 * and nothing is uploaded anywhere. The engine runs in a SEPARATE PROCESS (core/ocrWorker.js), started on first use and
 * stopped when idle, so the application starts and works without it and a malformed image cannot crash the app.
 *
 * Accepts PNG or JPEG images up to 6 MB and 12,000 px per side (type and size are read from the file's own header).
 * PDFs are not read: export or photograph the invoice as an image, or paste its text into the document parser.
 */
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const MAX_BYTES = 6 * 1024 * 1024; // keeps the base64 upload under the 10 MB request limit
const MAX_SIDE = 12000, MAX_PIXELS = 50e6;
const TIMEOUT_MS = 90 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };

function unpacked(p) { const u = p.replace('app.asar', 'app.asar.unpacked'); return fs.existsSync(u) ? u : p; }
const langDir = () => unpacked(path.resolve(__dirname, '..', 'ocr'));
const workerScript = () => unpacked(path.resolve(__dirname, 'ocrWorker.js'));

/** Reads type and dimensions from the header; returns null if the file is not a well-formed PNG/JPEG header. */
function imageInfo(buf) {
  if (buf.length > 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.subarray(12, 16).toString('latin1') !== 'IHDR' || buf.readUInt32BE(8) !== 13) return null;
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (marker === 0xda) return null; // reached the scan without ever seeing a frame header
      i += 2 + len;
    }
    return null;
  }
  return null;
}
const detect = (buf) => { const i = imageInfo(buf); if (i) return i.type; if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'; if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'; return null; };

// ---------------------------------------------------------------- child process management
let child = null, idleTimer = null, seq = 0;
const pending = new Map();

// Fails only the jobs that were sent to helper `c` (a new helper's jobs must survive an old helper's exit)
function failAll(err, c) { for (const [id, p] of pending) { if (c && p.child !== c) continue; clearTimeout(p.timer); p.reject(err); pending.delete(id); } }

function ensureChild() {
  if (child && child.connected) return child;
  if (!fs.existsSync(path.join(langDir(), 'eng.traineddata'))) throw bad('The bundled OCR language file (ocr/eng.traineddata) is missing.', 501);
  try { require.resolve('tesseract.js'); } catch (e) { throw bad('The OCR engine (tesseract.js) is not installed. Run "npm install" in the application folder.', 501); }
  const c = fork(workerScript(), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  c.on('message', (m) => {
    if (m.fatal) {
      // The helper is about to exit. Drop it NOW so the next scan starts a fresh one instead of being sent to a dying process.
      if (child === c) child = null;
      try { c.kill(); } catch (e) { /* already gone */ }
      failAll(bad('The OCR engine could not read this image (it may be corrupt or unsupported).', 422), c);
      return;
    }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m); else p.reject(bad('The OCR engine could not read this image (it may be corrupt or unsupported).', 422));
  });
  c.on('exit', () => { if (child === c) child = null; failAll(bad('The OCR engine stopped while reading this image (it may be corrupt or unsupported).', 422), c); });
  c.on('error', () => { if (child === c) child = null; failAll(bad('The OCR engine could not be started.', 500), c); });
  child = c;
  return c;
}
function touchIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (child && !pending.size) { child.kill(); child = null; } }, IDLE_MS); idleTimer.unref(); }

let queue = Promise.resolve();

/** Recognises text in an image buffer. Requests are processed one at a time. */
function recognise(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('The image is empty.');
  if (buf.length > MAX_BYTES) throw bad('Image is larger than 6 MB.', 413);
  const info = imageInfo(buf);
  if (!info) throw bad('Only valid PNG or JPEG images can be scanned. For a PDF, export a page as an image or paste its text.');
  if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS) throw bad(`Image dimensions are not supported (${info.width}×${info.height}; up to ${MAX_SIDE}px per side).`);

  const job = queue.then(() => new Promise((resolve, reject) => {
    const c = ensureChild();
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(bad('Scanning took too long and was cancelled.', 504)); try { c.kill(); } catch (e) {} }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, child: c });
    c.send({ id, langPath: langDir(), image: buf.toString('base64') });
  })).then((m) => { touchIdle(); return { text: m.text, confidence: m.confidence, words: 0, image_type: info.type, width: info.width, height: info.height }; });
  queue = job.catch(() => {}); // a failed scan must not block the next one
  return job;
}

async function shutdown() {
  clearTimeout(idleTimer);
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } child = null; }
}

module.exports = { recognise, shutdown, detect, imageInfo, MAX_BYTES };

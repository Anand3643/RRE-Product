/**
 * RRE Tally — OCR child process. Runs Tesseract in its own process so that a malformed image (which makes the engine
 * throw from inside its own worker thread) can only stop THIS helper, never the application. core/ocr.js restarts it.
 * Protocol: parent sends { id, langPath, image(base64) }; child answers { id, ok, text, confidence } or { id, ok:false, error }.
 */
let workerPromise = null;

function getWorker(langPath) {
  if (!workerPromise) {
    workerPromise = require('tesseract.js').createWorker('eng', 1, { langPath, gzip: false, cacheMethod: 'none', logger: () => {} });
  }
  return workerPromise;
}

process.on('message', async (m) => {
  try {
    const w = await getWorker(m.langPath);
    const r = await w.recognize(Buffer.from(m.image, 'base64'));
    process.send({ id: m.id, ok: true, text: r.data.text || '', confidence: Math.round(r.data.confidence || 0) });
  } catch (e) {
    process.send({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
});

function fatal(e) {
  try { process.send({ id: -1, ok: false, fatal: true, error: String((e && e.message) || e) }); } catch (_) { /* parent gone */ }
  setTimeout(() => process.exit(1), 30);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.on('disconnect', () => process.exit(0));

// ========================================================
// PDF Engine — renders document HTML to a real PDF using the
// bundled Chromium (Electron printToPDF). Fully offline.
// When the server runs under plain Node (npm start), PDF is not
// available and callers fall back to the printable HTML view.
// ========================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

function isPdfAvailable() {
  if (!process.versions.electron) return false;
  try {
    const { app } = require('electron');
    return !!(app && app.isReady && app.isReady());
  } catch (e) {
    return false;
  }
}

let queue = Promise.resolve();

/** Serialised so we never spin up several hidden renderers at once. */
function htmlToPdf(html, { landscape = false } = {}) {
  const job = queue.then(() => renderPdf(html, landscape));
  queue = job.catch(() => {});
  return job;
}

async function renderPdf(html, landscape) {
  const { BrowserWindow } = require('electron');
  const tmp = path.join(os.tmpdir(), `rre-doc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  try {
    await win.loadFile(tmp);
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape,
      margins: { marginType: 'none' },
      preferCSSPageSize: true
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.unlink(tmp, () => {});
  }
}

module.exports = { htmlToPdf, isPdfAvailable };

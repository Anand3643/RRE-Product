/**
 * RRE Tally — reads an uploaded accounting document into plain tables and text. Nothing here understands accounting (docClassify /
 * docImport do that); it only turns bytes into rows.
 *
 *   Excel (.xlsx, .xls) and CSV  -> every worksheet, every row (SheetJS, the security-fixed 0.20.x from SheetJS's own site)
 *   PDF                          -> every page's text, rebuilt into lines and cells from the position of each piece of text
 *                                   (Mozilla pdf.js; scripts in the PDF are never run). A PDF with almost no text is a scan:
 *                                   needs_ocr = true, and the browser renders each page for the offline OCR (core/ocr.js).
 *   PNG / JPEG                   -> offline OCR text
 *
 * The file type is decided from the file's own first bytes, not from its name. Limits keep a hostile or huge file from stalling the
 * server: MAX_BYTES, MAX_PAGES, MAX_ROWS.
 */
const XLSX = require('xlsx');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 400;
const MAX_ROWS = 100000;

function sniff(buf, name = '') {
  const b = buf.subarray(0, 8);
  if (b.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'excel'; // .xlsx is a zip; SheetJS refuses a zip that is not a workbook
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'excel';           // .xls (compound file)
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  // text: CSV / TSV / plain
  const head = buf.subarray(0, 4096).toString('utf8');
  if (!/[\x00-\x08\x0e-\x1f]/.test(head.replace(/^﻿/, ''))) return 'csv';
  return 'unknown';
}

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, ' ').trim();
};

// Dates: Excel stores a date as a day number; it is turned into YYYY-MM-DD from that number directly (no time zone: a JS Date would
// make 3 April 00:00 IST into "2 April" in UTC). CSV cells are kept exactly as written (no guessing: "05/04/2026" stays 5 April for
// the importer's own day-first date reading, instead of becoming the American 4 May).
function excelDate(serial) {
  const d = XLSX.SSF.parse_date_code(serial);
  return d && d.y ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : '';
}
function readSheets(buf, kind) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: true, dense: true, raw: kind === 'csv', WTF: false });
  const sheets = [];
  let total = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const data = ws['!data'] || [];
    const clean = [];
    for (const row of data) {
      if (total >= MAX_ROWS) break;
      if (!row) continue;
      const cells = [];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        let v = '';
        if (cell && cell.v != null) {
          if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) v = excelDate(cell.v);
          else if (cell.t === 'd') v = cellText(cell.v);
          else if (cell.t === 'n') v = cell.v;
          else if (cell.t === 'b') v = cell.v ? 'TRUE' : 'FALSE';
          else if (cell.t === 'e') v = '';
          else v = cellText(cell.v);
        }
        cells[c] = v;
      }
      for (let c = 0; c < cells.length; c++) if (cells[c] === undefined) cells[c] = '';
      if (cells.some((c) => c !== '' && c != null)) { clean.push(cells); total++; }
    }
    sheets.push({ name, rows: clean });
  }
  return { sheets, truncated: total >= MAX_ROWS };
}

/**
 * Positioned text pieces (PDF text items, or OCR words) -> lines -> cells. A gap wider than ~2 characters starts a new cell.
 * Returns { rows, xpos }: xpos[r][c] = [left, right] of each cell, so a table can be put back into its columns by POSITION
 * (an empty cell - a statement line with a withdrawal but no deposit - must not shift the next value into the wrong column).
 * y grows upwards (PDF); OCR boxes are passed with y negated.
 */
function piecesToRows(pieces) {
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of pieces) {
    const line = lines.find((l) => Math.abs(l.y - p.y) <= Math.max(2, p.h * 0.45));
    if (line) line.items.push(p); else lines.push({ y: p.y, items: [p] });
  }
  lines.sort((a, b) => b.y - a.y);
  const rows = [], xpos = [];
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    const cells = []; let cur = null;
    for (const p of l.items) {
      const charW = p.s.length ? (p.w / p.s.length) || p.h * 0.5 : p.h * 0.5;
      if (cur && p.x - cur.end <= Math.max(2.2 * charW, 4)) { cur.text += (p.x - cur.end > charW * 0.25 ? ' ' : '') + p.s; cur.end = p.x + p.w; }
      else { cur = { text: p.s, x: p.x, end: p.x + p.w }; cells.push(cur); }
    }
    const kept = cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text);
    rows.push(kept.map((c) => c.text)); xpos.push(kept.map((c) => [Math.round(c.x * 10) / 10, Math.round(c.end * 10) / 10]));
  }
  return { rows, xpos };
}
const pdfPieces = (items) => items.filter((i) => i.str && i.str.trim()).map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || 10, s: i.str }));
const ocrPieces = (boxes) => (boxes || []).map(([s, x0, y0, x1, y1]) => ({ x: x0, y: -y0, w: x1 - x0, h: Math.max(1, y1 - y0), s }));

async function readPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 }).promise;
  const pages = Math.min(doc.numPages, MAX_PAGES);
  const sheets = []; let chars = 0;
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const { rows, xpos } = piecesToRows(pdfPieces(tc.items));
    chars += rows.reduce((t, r) => t + r.join('').length, 0);
    sheets.push({ name: `Page ${n}`, rows, xpos });
    page.cleanup();
  }
  await doc.destroy();
  return { sheets, pages: doc.numPages, truncated: doc.numPages > MAX_PAGES, needs_ocr: chars < 25 * pages };
}

/** Turns OCR text into rows: a run of 2+ spaces or a tab separates cells. */
function textToRows(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\t| {2,}/).map((c) => c.trim()).filter(Boolean));
}

/**
 * -> { kind, sheets: [{ name, rows: [[cell...]] }], text, pages, needs_ocr, truncated, warnings }
 */
async function readDocument(buf, name = '') {
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error(`The file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it into smaller files.`), { status: 413 });
  const kind = sniff(buf, name);
  const warnings = [];
  let out;
  if (kind === 'excel' || kind === 'csv') {
    try { out = readSheets(buf, kind); } catch (e) { throw Object.assign(new Error(`This ${kind === 'csv' ? 'CSV' : 'Excel'} file could not be read (${e.message}). Is it damaged or password protected?`), { status: 422 }); }
  } else if (kind === 'pdf') {
    try { out = await readPdf(buf); } catch (e) { throw Object.assign(new Error(`This PDF could not be read (${e.message}). Is it damaged or password protected?`), { status: 422 }); }
    if (out.needs_ocr) warnings.push('This PDF has (almost) no text: it is a scan. Its pages are read with OCR.');
  } else if (kind === 'image') {
    const ocr = require('./ocr');
    const r = await ocr.recognise(buf);
    out = { sheets: [ocrSheet('Image', r)], ocr_confidence: r.confidence };
    warnings.push(`Read with OCR (confidence ${Math.round(r.confidence || 0)}%). Check the figures in the preview.`);
  } else {
    throw Object.assign(new Error('This file type is not supported. Upload a PDF, Excel (.xlsx / .xls), CSV, PNG or JPEG file.'), { status: 415 });
  }
  if (out.truncated) warnings.push(`Only the first ${kind === 'pdf' ? MAX_PAGES + ' pages' : MAX_ROWS + ' rows'} were read. Split the file to import the rest.`);
  const text = out.sheets.map((s) => s.rows.map((r) => r.join('  ')).join('\n')).join('\n');
  return { kind, sheets: out.sheets, text, pages: out.pages || out.sheets.length, needs_ocr: !!out.needs_ocr, truncated: !!out.truncated, ocr_confidence: out.ocr_confidence ?? null, warnings };
}

/** An OCR result as a sheet: positioned rows from the word boxes (falls back to the plain text). */
function ocrSheet(name, r) {
  if (r && r.boxes && r.boxes.length) { const { rows, xpos } = piecesToRows(ocrPieces(r.boxes)); return { name, rows, xpos }; }
  return { name, rows: textToRows(r && r.text) };
}

module.exports = { readDocument, textToRows, ocrSheet, sniff, MAX_BYTES, MAX_PAGES };

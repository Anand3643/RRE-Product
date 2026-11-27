/**
 * Test documents generated in code (no files from anyone's computer): PDFs with real text tables, a scanned PDF (an image only),
 * Excel workbooks (.xlsx and old .xls) and CSV. Used by test_docimport.js.
 */
const XLSX = require('xlsx');

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** pages: [[{ x, y, text, size? }]] (PDF points; y from the bottom). Helvetica. */
function makePdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const items of pages) {
    const content = items.map((t) => `BT /F1 ${t.size || 10} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  return assemble(objs.map((o) => Buffer.from(o, 'latin1')));
}

function assemble(objBufs) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; let len = parts[0].length; const offs = [];
  objBufs.forEach((o, i) => { offs.push(len); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); len += b.length; });
  const xref = `xref\n0 ${objBufs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objBufs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** A table laid out like a printed report: title lines, then header + rows in columns at the given x positions. Paginates. */
function tablePdf({ title = [], columns, rows, colX, perPage = 40 }) {
  const pages = [];
  for (let i = 0; i < Math.max(1, rows.length); i += perPage) {
    const items = []; let y = 760;
    if (i === 0) for (const t of title) { items.push({ x: 40, y, text: t, size: 12 }); y -= 18; }
    columns.forEach((h, c) => items.push({ x: colX[c], y, text: h })); y -= 14;
    for (const r of rows.slice(i, i + perPage)) { r.forEach((v, c) => { if (v !== '' && v != null) items.push({ x: colX[c], y, text: String(v) }); }); y -= 14; }
    pages.push(items);
  }
  return makePdf(pages);
}

/** A "scanned" PDF: each page is only a JPEG image (no text layer). */
function scannedPdf(jpegs) {
  const objs = []; const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('PAGES');
  const kids = [];
  for (const { jpeg, width, height } of jpegs) {
    const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream', 'latin1')]));
    const content = `q 612 0 0 ${Math.round(612 * height / width)} 0 0 cm /Im1 Do Q`;
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${Math.round(612 * height / width)}] /Contents ${c} 0 R /Resources << /XObject << /Im1 ${img} 0 R >> >> >>`));
  }
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`, 'latin1');
  return assemble(objs);
}

/** sheets: { name: [[cells]] } -> .xlsx (or .xls with bookType 'biff8') */
function workbook(sheets, bookType = 'xlsx') {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), name);
  return XLSX.write(wb, { type: 'buffer', bookType });
}

const csv = (rows) => Buffer.from(rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n'), 'utf8');

/** a JPEG picture of text lines (for the scanned-document tests), drawn with sharp from SVG */
async function textJpeg(lines, { width = 1700, lineH = 54, size = 34 } = {}) {
  const sharp = require('sharp');
  const height = Math.max(400, 120 + lines.length * lineH);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${lines.map((l, i) => `<text x="60" y="${100 + i * lineH}" font-family="Courier New, monospace" font-size="${size}" fill="#000" xml:space="preserve">${String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('')}</svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  return { jpeg, width, height };
}

module.exports = { makePdf, tablePdf, scannedPdf, workbook, csv, textJpeg };

/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM).
 * Returns { headers: string[], rows: object[] } with header names normalised to snake_case.
 */
function parseCsv(text, { maxRows = 50000 } = {}) {
  if (typeof text !== 'string') throw new Error('CSV content must be text.');
  const src = text.replace(/^﻿/, '');
  const records = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) records.push(row);
      row = [];
      if (records.length > maxRows + 1) throw new Error(`File has more than ${maxRows} rows.`);
    } else field += c;
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field.');
  row.push(field);
  if (row.some((v) => v.trim() !== '')) records.push(row);
  if (!records.length) return { headers: [], rows: [] };

  const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const headers = records[0].map(norm);
  const rows = records.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, rows };
}

/** Parses amounts such as "1,23,456.78", "₹ 500", "(250.00)" (negative), "12.5 Dr". Returns NaN if not numeric. */
function parseAmount(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 0;
  let s = String(v).trim().replace(/[₹,\s]|rs\.?|inr/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/(dr|cr)$/i, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  const n = parseFloat(s);
  return neg ? -n : n;
}

/** Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD-MMM-YYYY. Returns ISO date or null. */
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return valid(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) return valid(+m[3], +m[2], +m[1]);
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if ((m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ,]*(\d{2,4})$/.exec(s))) {
    const mon = MON[m[2].toLowerCase()];
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return mon ? valid(y, mon, +m[1]) : null;
  }
  return null;
}
function valid(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

module.exports = { parseCsv, parseAmount, parseDate };

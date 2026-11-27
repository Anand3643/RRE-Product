/**
 * RRE Tally — invoice field extraction from text (pasted, or produced by OCR).
 *
 * Finds supplier GSTIN, invoice number and date, taxable value, CGST/SGST/IGST and total, matches the supplier to an
 * existing ledger, and builds a DRAFT purchase voucher. It never posts: the draft is shown for review, and is saved only
 * through the normal voucher screen. Every field carries a confidence, and OCR-style mistakes in a GSTIN are repaired
 * only when the repaired number passes the GSTIN check digit.
 */
const { all, get } = require('./db');
const { parseAmount, parseDate } = require('./csv');
const gst = require('./gstTools');
const { duplicateCheck } = require('./automationTools');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------- GSTIN repair
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
const KIND = ['d', 'd', 'l', 'l', 'l', 'l', 'l', 'd', 'd', 'd', 'd', 'l', 'a', 'Z', 'a']; // position types of a GSTIN

function repairGstin(chars) {
  let out = '', changed = false;
  for (let i = 0; i < 15; i++) {
    let c = chars[i];
    const k = KIND[i];
    if (k === 'd' && /[A-Z|]/.test(c) && TO_DIGIT[c]) { c = TO_DIGIT[c]; changed = true; }
    else if (k === 'l' && /\d/.test(c) && TO_LETTER[c]) { c = TO_LETTER[c]; changed = true; }
    else if (k === 'Z' && c !== 'Z' && (c === '2' || c === '7')) { c = 'Z'; changed = true; }
    out += c;
  }
  return { value: out, changed };
}

/** Finds GSTINs in a block of text, tolerating spaces and look-alike characters inside the number. */
function findGstins(lines) {
  const found = [];
  lines.forEach((line, li) => {
    const compact = line.toUpperCase().replace(/[^A-Z0-9|]/g, '');
    for (let s = 0; s + 15 <= compact.length; s++) {
      const win = compact.slice(s, s + 15);
      const direct = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(win);
      const fixed = repairGstin(win);
      const cand = direct ? win : fixed.value;
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(cand)) continue;
      const v = gst.validateGstin(cand);
      if (!v.valid && direct === false) { // a repaired candidate must pass the check digit, or it is only a weak guess
        if (!/GST/.test(line.toUpperCase())) continue;
      }
      if (!gst.STATE_NAMES[cand.slice(0, 2)]) continue;
      if (found.some((f) => f.line === li && f.value === cand)) continue;
      // "repaired" also covers a number that only matched after stray spaces/punctuation were removed
      found.push({ value: cand, line: li, valid: v.valid, repaired: (!direct && fixed.changed) || !line.toUpperCase().includes(cand), raw: win });
      s += 14; // skip past this match
    }
  });
  return found;
}

// ---------------------------------------------------------------- number helpers
const amountsOn = (line) => (line.match(/[0-9][0-9,]*(?:\.\d{1,2})?/g) || []).map((s) => ({ s, n: parseAmount(s) })).filter((x) => Number.isFinite(x.n));
function lastAmount(line, { skipPercent = true } = {}) {
  const clean = skipPercent ? line.replace(/@?\s*\d+(?:\.\d+)?\s*%/g, ' ') : line;
  const a = amountsOn(clean);
  const dec = a.filter((x) => /\.\d{2}$/.test(x.s));
  return (dec.length ? dec : a).slice(-1)[0] || null;
}

function labelledAmount(lines, labelRe, { last = false } = {}) {
  const hits = [];
  lines.forEach((l, i) => { if (labelRe.test(l)) { const a = lastAmount(l); if (a && a.n > 0) hits.push({ n: r2(a.n), line: i, text: l.trim() }); } });
  return hits.length ? (last ? hits[hits.length - 1] : hits[0]) : null;
}

async function extractInvoice(rawText, { ocrConfidence = null } = {}) {
  const text = String(rawText || '').replace(/ /g, ' ');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const warnings = [];
  const fields = {};
  const company = (await get('SELECT name, gstin FROM company_info LIMIT 1')) || {};
  const ownGstin = String(company.gstin || '').toUpperCase().replace(/\s/g, '');

  // --- GSTINs: supplier vs buyer
  const gstins = findGstins(lines);
  const buyerCtx = /bill\s*to|buyer|ship\s*to|consignee|recipient|customer|sold\s*to|invoice\s*to/i;
  let supplierG = gstins.find((g) => g.value !== ownGstin && !buyerCtx.test(lines[g.line] || '') && !buyerCtx.test(lines[g.line - 1] || ''));
  if (!supplierG) supplierG = gstins.find((g) => g.value !== ownGstin);
  const buyerG = gstins.find((g) => g !== supplierG && (g.value === ownGstin || buyerCtx.test(lines[g.line] || '')));
  if (supplierG) {
    fields.supplier_gstin = { value: supplierG.value, confidence: supplierG.valid ? (supplierG.repaired ? 'medium' : 'high') : 'low',
      note: supplierG.repaired ? `Read as "${supplierG.raw}" and corrected; the check digit confirms it.` : supplierG.valid ? null : 'Format looks right but the check digit fails; verify against the invoice.' };
    if (!supplierG.valid) warnings.push('The supplier GSTIN did not pass the check digit. Verify it against the paper invoice.');
  } else warnings.push('No GSTIN found for the supplier.');
  if (buyerG) fields.buyer_gstin = { value: buyerG.value, confidence: buyerG.valid ? 'medium' : 'low' };
  if (buyerG && ownGstin && buyerG.value !== ownGstin) warnings.push(`The invoice is addressed to GSTIN ${buyerG.value}, which is not your company GSTIN (${ownGstin}). Input tax credit may not be available.`);

  // --- invoice number
  let invNo = null;
  for (const l of lines) {
    const m = /(?:tax\s+)?(?:invoice|inv|bill)\s*(?:no\.?|number|num|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-.]{2,28})/i.exec(l);
    if (m && !/^(date|dt|dated)$/i.test(m[1])) { invNo = m[1].replace(/[.,;]+$/, ''); break; }
  }
  if (invNo) fields.invoice_no = { value: invNo, confidence: 'high' }; else warnings.push('Invoice number not found.');

  // --- date (prefer one labelled as the invoice date)
  const dateTok = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ,]*\d{2,4})/;
  let date = null, dateConf = 'low';
  for (const l of lines) { if (/date/i.test(l) && !/due|delivery|supply/i.test(l)) { const m = dateTok.exec(l); if (m) { const d = parseDate(m[1].replace(/\./g, '-')); if (d) { date = d; dateConf = 'high'; break; } } } }
  if (!date) for (const l of lines) { const m = dateTok.exec(l); if (m) { const d = parseDate(m[1].replace(/\./g, '-')); if (d) { date = d; break; } } }
  if (date) fields.date = { value: date, confidence: dateConf }; else warnings.push('Invoice date not found.');

  // --- amounts
  const total = labelledAmount(lines, /(grand\s*total|total\s*amount|net\s*payable|amount\s*payable|invoice\s*(total|value)|total\s*invoice\s*value|balance\s*due|amount\s*due)/i, { last: true })
    || labelledAmount(lines, /^\s*total\b/i, { last: true });
  const taxable = labelledAmount(lines, /(taxable\s*(value|amount)|sub\s*-?\s*total|total\s*before\s*tax|net\s*amount|assessable)/i);
  const tax = { cgst: 0, sgst: 0, igst: 0 }; const rates = {};
  lines.forEach((l) => {
    const m = /\b(cgst|sgst|utgst|igst)\b/i.exec(l);
    if (!m) return;
    const a = lastAmount(l); if (!a) return;
    const k = m[1].toLowerCase() === 'utgst' ? 'sgst' : m[1].toLowerCase();
    if (a.n >= 1) { tax[k] += r2(a.n); const rm = /@?\s*(\d+(?:\.\d+)?)\s*%/.exec(l); if (rm) rates[k] = Number(rm[1]); }
  });
  const taxTotal = r2(tax.cgst + tax.sgst + tax.igst);
  if (total) fields.total = { value: total.n, confidence: 'high' }; else warnings.push('Grand total not found.');
  let taxableVal = taxable ? taxable.n : null, taxableConf = 'high';
  if (taxableVal === null && total && taxTotal > 0) { taxableVal = r2(total.n - taxTotal); taxableConf = 'medium'; warnings.push('Taxable value was not printed; it was worked out as total − tax.'); }
  if (taxableVal !== null) fields.taxable_value = { value: taxableVal, confidence: taxableConf };
  if (taxTotal > 0) fields.tax = { cgst: r2(tax.cgst), sgst: r2(tax.sgst), igst: r2(tax.igst), total: taxTotal, rates, confidence: 'high' };
  let consistent = null;
  if (total && taxableVal !== null) {
    consistent = Math.abs(taxableVal + taxTotal - total.n) <= 1.01;
    if (!consistent) warnings.push(`Taxable ${taxableVal} + tax ${taxTotal} = ${r2(taxableVal + taxTotal)}, but the total reads ${total.n}. One of these was misread; check the invoice.`);
  }
  if (tax.cgst && tax.sgst && Math.abs(tax.cgst - tax.sgst) > 0.011) warnings.push('CGST and SGST differ; one of them may be misread.');
  if (tax.igst && (tax.cgst || tax.sgst)) warnings.push('Both IGST and CGST/SGST were found on one invoice; check which applies.');
  if (taxableVal && taxTotal && rates.cgst && Math.abs(taxableVal * (rates.cgst / 100) - tax.cgst) > 1.01) warnings.push(`CGST @${rates.cgst}% of ${taxableVal} should be ${r2(taxableVal * rates.cgst / 100)}, not ${tax.cgst}.`);

  // --- HSN codes
  const hsn = new Set();
  lines.forEach((l) => { if (/hsn|sac/i.test(l)) (l.match(/\b\d{4,8}\b/g) || []).forEach((c) => hsn.add(c)); });
  if (hsn.size) fields.hsn = [...hsn].map((c) => ({ code: c, valid: gst.validateHsn(c).valid }));

  // --- supplier ledger
  let supplier = null;
  if (supplierG) {
    const l = await get(`SELECT l.id, l.name FROM ledgers l WHERE upper(replace(l.gstin, ' ', '')) = ? LIMIT 1`, [supplierG.value]);
    if (l) supplier = { ledger_id: l.id, name: l.name, method: 'gstin', confidence: 'high' };
  }
  // the supplier's name is the first line of text; a document title printed on the same line ("Kovai Motor Spares    TAX INVOICE") is not part of it
  const TITLE = /\b(tax\s+invoice|retail\s+invoice|bill\s+of\s+supply|(original|duplicate|triplicate)\s+for\s+(recipient|transporter|supplier|buyer))\b/gi;
  const EDGE_WORD = /^\s*(invoice|original|duplicate|triplicate)\b|\b(invoice|original|duplicate|triplicate)\s*$/gi; // only at the start / end: "Sri Original Traders" stays whole
  const nameOf = (l) => String(l).split(/\s{3,}/).map((s) => s.replace(TITLE, ' ').replace(/\s+/g, ' ').replace(/^[\s:|-]+|[\s:|-]+$/g, '').replace(EDGE_WORD, '').replace(/^[\s:|-]+|[\s:|-]+$/g, '')).find((s) => /[A-Za-z]{3}/.test(s) && !/^gstin\b/i.test(s)) || null;
  const firstLine = nameOf(lines.find((l) => !/^(tax\s+)?invoice|^gstin|^original|^duplicate|^page/i.test(l) && nameOf(l)) || '');
  if (!supplier && firstLine) {
    const creditors = await all(`SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Sundry Creditors'`);
    const toks = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !['ltd', 'pvt', 'private', 'limited', 'and', 'the', 'co'].includes(t));
    const ft = toks(firstLine);
    let best = null, bs = 0;
    for (const c of creditors) { const ct = toks(c.name); const common = ct.filter((t) => ft.includes(t)).length; const score = ct.length ? common / ct.length : 0; if (common >= 1 && score > bs) { bs = score; best = c; } }
    if (best && bs >= 0.5) supplier = { ledger_id: best.id, name: best.name, method: 'name', confidence: bs >= 0.99 ? 'medium' : 'low' };
  }
  if (!supplier) warnings.push('The supplier is not in your ledgers (matched neither by GSTIN nor by name). Create the ledger first, or choose it manually.');
  const detectedName = firstLine;

  // --- draft purchase voucher (never posted)
  let draft = null;
  const needTotal = total ? total.n : (taxableVal !== null ? r2(taxableVal + taxTotal) : null);
  if (needTotal) {
    // Use the interstate purchase ledger only when the invoice carries IGST; otherwise a local purchase ledger
    // The purchase ledger this company actually uses most (never a returns ledger), not simply the first name in the alphabet:
    // the standard ledgers include a generic "Purchase" and "Purchase Return ..." that would otherwise win.
    const purchaseLedgers = (await all(`SELECT l.id, l.name, (SELECT COUNT(*) FROM ledger_entries e WHERE e.ledger_id = l.id) AS used
      FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Purchase Accounts' ORDER BY used DESC, l.name`)).filter((l) => !/return/i.test(l.name));
    const isInter = (n) => /interstate|igst/i.test(n);
    const purchase = (tax.igst ? purchaseLedgers.find((l) => isInter(l.name)) : purchaseLedgers.find((l) => !isInter(l.name))) || purchaseLedgers[0] || null;
    const inputLedger = async (kind) => {
      const rate = rates[kind];
      const rows = await all(`SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = 'Duties & Taxes' AND upper(l.name) LIKE 'INPUT%' AND upper(l.name) LIKE ?`, [`%${kind.toUpperCase()}%`]);
      return rows.find((r) => rate && r.name.includes(`${rate}%`)) || rows[0] || null;
    };
    const entries = [];
    const base = taxableVal !== null ? taxableVal : needTotal;
    if (purchase) entries.push({ ledger_id: purchase.id, ledger_name: purchase.name, debit_amount: r2(base), credit_amount: 0 });
    for (const k of ['cgst', 'sgst', 'igst']) {
      if (!tax[k]) continue;
      const lg = await inputLedger(k);
      entries.push({ ledger_id: lg ? lg.id : null, ledger_name: lg ? lg.name : `Input ${k.toUpperCase()} (ledger not found)`, debit_amount: r2(tax[k]), credit_amount: 0 });
    }
    const dr = r2(entries.reduce((s, e) => s + e.debit_amount, 0));
    const diff = r2(needTotal - dr);
    if (Math.abs(diff) > 0.005 && Math.abs(diff) <= 1) {
      const ro = await get(`SELECT id, name FROM ledgers WHERE name = 'Round Off A/c'`);
      if (ro) entries.push({ ledger_id: ro.id, ledger_name: ro.name, debit_amount: diff > 0 ? diff : 0, credit_amount: diff < 0 ? -diff : 0 });
    }
    const dr2 = r2(entries.reduce((s, e) => s + e.debit_amount, 0)), cr2 = r2(entries.reduce((s, e) => s + e.credit_amount, 0));
    entries.push({ ledger_id: supplier ? supplier.ledger_id : null, ledger_name: supplier ? supplier.name : (detectedName || 'Supplier (choose a ledger)'), debit_amount: 0, credit_amount: r2(needTotal) });
    const sumDr = r2(dr2), sumCr = r2(cr2 + needTotal);
    draft = { voucher_type: 'Purchase', voucher_no: 'SCAN-' + Date.now().toString().slice(-6), date: date || new Date().toISOString().slice(0, 10), reference_no: invNo || '',
      narration: `Purchase invoice ${invNo || ''} from ${supplier ? supplier.name : (detectedName || 'supplier')} (scanned; please verify)`.replace(/\s+/g, ' '),
      party_ledger_id: supplier ? supplier.ledger_id : null, entries, total_amount: r2(needTotal), is_balanced: Math.abs(sumDr - sumCr) < 0.01,
      complete: !!(supplier && purchase && entries.every((e) => e.ledger_id)), confidence_score: supplier && consistent !== false && invNo && date ? (supplierG && supplierG.valid ? 0.9 : 0.7) : 0.5 };
    if (!draft.is_balanced) warnings.push('The draft does not balance; the amounts read from the invoice do not add up.');
  }

  // --- duplicates
  let duplicates = [];
  if (supplier && invNo) {
    duplicates = (await duplicateCheck({ voucher_type: 'Purchase', party_ledger_id: supplier.ledger_id, reference_no: invNo, total_amount: needTotal, date })).candidates;
    if (duplicates.some((d) => d.level === 'high')) warnings.push(`This invoice number was already recorded for ${supplier.name}: ${duplicates[0].voucher_type} ${duplicates[0].voucher_no} (${duplicates[0].date}).`);
  }

  const keyFields = ['supplier_gstin', 'invoice_no', 'date', 'total'].every((k) => fields[k] && fields[k].confidence !== 'low');
  return { fields, supplier, detected_supplier_name: detectedName, draft_voucher: draft, duplicates, warnings, consistent,
    needs_review: !(keyFields && consistent !== false && supplier && warnings.length === 0), ocr_confidence: ocrConfidence,
    note: 'Fields are read from the image or text automatically and can be wrong. Check every number against the invoice before posting.' };
}

/** Shape expected by the existing "Parse Invoice / Bill Document" screen. Returns null when the text has no usable total. */
async function forLegacyParser(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  const x = await extractInvoice(text);
  if (!x.draft_voucher || !x.fields.total) return null;
  return { success: true, document_parsed: { invoice_no: x.fields.invoice_no ? x.fields.invoice_no.value : '', detected_amount: x.fields.total.value, detected_gstin: x.fields.supplier_gstin ? x.fields.supplier_gstin.value : '',
    raw_preview: String(text).trim().slice(0, 150) + '...', draft_voucher: x.draft_voucher, extraction: x } };
}

module.exports = { extractInvoice, forLegacyParser, findGstins };

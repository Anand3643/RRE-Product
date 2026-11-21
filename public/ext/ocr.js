/**
 * RRE Tally — "Scan Invoice": offline OCR of a photographed or scanned supplier invoice.
 * Adds a Scan Invoice action to the Purchase voucher screen and to the existing AI Invoice / Bill Document Parser.
 * The image is read on this computer; the result is a DRAFT for review — nothing is posted until you save it.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CONF = { high: 'bg-emerald-100 text-emerald-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-red-100 text-red-800' };

  function chooseFile() {
    if (typeof window.openAiDocParserModal === 'function') window.openAiDocParserModal();
    const input = $('ocr-file');
    if (input) { input.value = ''; input.click(); }
  }

  async function scan(file) {
    const status = $('ocr-status'), panel = $('ocr-panel');
    if (!file) return;
    if (!/\.(png|jpe?g)$/i.test(file.name) && !/^image\/(png|jpeg)$/.test(file.type)) { status.innerHTML = '<span class="text-red-700">Choose a PNG or JPEG image. For a PDF, export a page as an image or paste its text below.</span>'; return; }
    if (file.size > 6 * 1024 * 1024) { status.innerHTML = '<span class="text-red-700">The image is larger than 6 MB.</span>'; return; }
    status.innerHTML = '<span class="text-slate-600">Reading the invoice on this computer…</span>'; panel.innerHTML = '';
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
      const resp = await fetch(`${base()}/ocr/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: b64 }) });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j.success === false) throw new Error(j.error || `Scan failed (${resp.status})`);
      const { ocr, extraction: x } = j.data;
      status.innerHTML = `<span class="text-emerald-700">Read ${ocr.text.split(/\n/).filter(Boolean).length} lines in ${(ocr.milliseconds / 1000).toFixed(1)} s (text recognition confidence ${ocr.confidence}%).</span>`;
      const row = (label, f, show) => f ? `<tr><td class="py-0.5 pr-3 text-slate-500">${esc(label)}</td><td class="py-0.5 font-mono font-bold">${esc(show ? show(f) : f.value)}</td><td class="py-0.5"><span class="px-1.5 rounded text-[9px] font-bold ${CONF[f.confidence] || ''}">${esc(f.confidence)}</span></td></tr>` : '';
      panel.innerHTML = `<div class="border ${x.needs_review ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'} rounded-lg p-2.5 space-y-1.5">
        <div class="font-bold">${x.needs_review ? '⚠️ Please check these details against the invoice' : '✔ Details look consistent — still verify before saving'}</div>
        <table class="text-[11px]">${row('Supplier', x.supplier ? { value: `${x.supplier.name} (matched by ${x.supplier.method})`, confidence: x.supplier.confidence } : (x.detected_supplier_name ? { value: `${x.detected_supplier_name} — not in your ledgers`, confidence: 'low' } : null))}
          ${row('Supplier GSTIN', x.fields.supplier_gstin)}${row('Invoice no.', x.fields.invoice_no)}${row('Date', x.fields.date)}${row('Taxable value', x.fields.taxable_value, (f) => '₹' + fmt(f.value))}
          ${x.fields.tax ? row('Tax', x.fields.tax, (f) => `CGST ${fmt(f.cgst)} · SGST ${fmt(f.sgst)} · IGST ${fmt(f.igst)}`) : ''}${row('Total', x.fields.total, (f) => '₹' + fmt(f.value))}</table>
        ${x.warnings.length ? `<ul class="list-disc ml-4 text-amber-800">${x.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${x.duplicates.length ? `<div class="text-red-700 font-semibold">Possible duplicate: ${esc(x.duplicates[0].voucher_type)} ${esc(x.duplicates[0].voucher_no)} dated ${esc(x.duplicates[0].date)}.</div>` : ''}
        <div class="text-[10px] text-slate-500">${esc(x.note)}</div></div>`;
      const ta = $('ai-doc-raw-text');
      if (ta) ta.value = ocr.text.trim();
      if (typeof window.handleAiDocParse === 'function') window.handleAiDocParse(); // existing parser builds the draft voucher from the text
    } catch (e) { status.innerHTML = `<span class="text-red-700">${esc(e.message)}</span>`; }
  }

  function injectModalControls() {
    const modal = $('aiDocParserModal');
    if (!modal || $('ocr-block')) return;
    const ta = $('ai-doc-raw-text');
    if (!ta) return;
    const block = document.createElement('div');
    block.id = 'ocr-block';
    block.className = 'border border-dashed border-indigo-300 rounded-lg p-2.5 bg-indigo-50/40 space-y-1.5';
    block.innerHTML = `<div class="flex items-center justify-between gap-2">
        <div><div class="font-bold text-slate-800">Scan an invoice image (offline OCR)</div><div class="text-[10px] text-slate-500">PNG or JPEG, up to 6 MB. Read on this computer; nothing is uploaded.</div></div>
        <label class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold cursor-pointer whitespace-nowrap">Choose image…<input id="ocr-file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" class="hidden"></label></div>
      <div id="ocr-status" class="text-[11px]"></div><div id="ocr-panel"></div>`;
    ta.parentNode.insertBefore(block, ta);
    $('ocr-file').addEventListener('change', () => scan($('ocr-file').files[0]));
  }

  function injectPurchaseButton() {
    const header = document.querySelector('#view-voucher .flex.items-center.space-x-3.text-xs');
    if (!header || $('btn-scan-invoice')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'btn-scan-invoice';
    b.className = 'px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-[11px] font-bold text-white hidden';
    b.title = 'Read a supplier invoice from a photo or scan (offline OCR)';
    b.textContent = '📷 Scan Invoice';
    b.addEventListener('click', chooseFile);
    header.insertBefore(b, header.firstChild);
    updateVisibility();
  }
  function updateVisibility() {
    const b = $('btn-scan-invoice'); const sel = $('v-select-type');
    if (!b) return;
    const t = sel ? sel.value : '';
    b.classList.toggle('hidden', !(t === 'Purchase' || t === 'Debit Note'));
  }

  function wrap(name) {
    if (typeof window[name] !== 'function' || window[name].__ocrHooked) return;
    const original = window[name];
    const wrapped = function () { const r = original.apply(this, arguments); setTimeout(updateVisibility, 0); return r; };
    wrapped.__ocrHooked = true;
    window[name] = wrapped;
  }

  function boot() {
    injectPurchaseButton();
    if (typeof window.openAiDocParserModal === 'function' && !window.openAiDocParserModal.__ocrHooked) {
      const original = window.openAiDocParserModal;
      const wrapped = function () { const r = original.apply(this, arguments); injectModalControls(); return r; };
      wrapped.__ocrHooked = true;
      window.openAiDocParserModal = wrapped;
    }
    wrap('openVoucherScreen'); wrap('switchVoucherType');
    const sel = $('v-select-type'); if (sel) sel.addEventListener('change', updateVisibility);
    injectModalControls();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

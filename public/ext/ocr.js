/**
 * RRE Tally — "Scan Invoice" on the Purchase / Debit Note voucher screen.
 * It opens the AI Invoice / Bill Document Parser's file upload (public/ext/docimport.js), which reads photos, scans, PDFs and
 * Excel files and shows every record for review before anything is saved. (The old image-only scan box was replaced by that upload.)
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function chooseFile() {
    if (typeof window.openAiDocParserModal === 'function') window.openAiDocParserModal();
    const input = $('di-parser-file');
    if (input) { input.value = ''; input.click(); }
  }

  function injectPurchaseButton() {
    const header = document.querySelector('#view-voucher .flex.items-center.space-x-3.text-xs');
    if (!header || $('btn-scan-invoice')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'btn-scan-invoice';
    b.className = 'px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-[11px] font-bold text-white hidden';
    b.title = 'Read a supplier invoice from a photo, scan, PDF or Excel file';
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
    wrap('openVoucherScreen'); wrap('switchVoucherType');
    const sel = $('v-select-type'); if (sel) sel.addEventListener('change', updateVisibility);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

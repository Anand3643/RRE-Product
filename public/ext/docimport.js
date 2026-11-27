/**
 * RRE Tally — Import Documents screen (Gateway > Utilities > Import Documents, or openDocImport()).
 * Upload PDF / Excel / CSV / scans -> the server reads and classifies them -> a preview with every record and its checks (nothing is
 * written) -> Import (the valid records the person kept, in one transaction, through the normal posting engine) -> Import History.
 * Scanned PDFs: pdf.js draws each page here and the server's offline OCR reads it.
 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || n === '' ? '' : (typeof formatCurrency === 'function' ? formatCurrency(n) : '₹' + Number(n).toFixed(2)));
  const API = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/doc-import';
  const files = []; // { key, file, id, status, progress, info, preview, result, error, settings }
  let active = null, groups = [], ledgers = [];

  async function api(path, opts = {}) {
    const res = await fetch(API() + path, { ...opts, headers: { ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { status: res.status, data: j });
    return j.data;
  }
  const token = () => { try { return (JSON.parse(localStorage.getItem('tally_user_session') || 'null') || {}).token || null; } catch (e) { return null; } };

  // upload with a progress bar (XMLHttpRequest: fetch cannot report upload progress)
  function uploadFile(entry) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API() + '/upload');
      const t = token(); if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(entry.file.name));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { entry.progress = Math.round(e.loaded / e.total * 100); entry.status = `Uploading ${entry.progress}%`; renderList(); } };
      xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ } if (xhr.status >= 200 && xhr.status < 300 && j.success) resolve(j.data); else reject(new Error(j.error || `Upload failed (${xhr.status})`)); };
      xhr.onerror = () => reject(new Error('The connection was lost during the upload. Try again: nothing was imported.'));
      xhr.send(entry.file);
    });
  }

  // a scanned PDF: render every page with pdf.js and send it to the OCR
  let pdfjs = null;
  async function ocrPages(entry) {
    if (!pdfjs) { pdfjs = await import('/vendor/pdfjs/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await entry.file.arrayBuffer()), isEvalSupported: false }).promise;
    for (let n = 1; n <= doc.numPages; n++) {
      entry.status = `Reading scanned page ${n} of ${doc.numPages} (OCR)…`; renderList();
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: Math.min(2.5, 2200 / page.getViewport({ scale: 1 }).width) });
      const canvas = document.createElement('canvas'); canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const r = await api(`/${entry.id}/ocr-page?page=${n}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
      if (r.classification) entry.info.classification = r.classification;
    }
  }

  async function addFiles(list) {
    for (const file of list) {
      const entry = { key: Math.random().toString(36).slice(2), file, status: 'Waiting…', progress: 0, settings: {} };
      files.unshift(entry); renderList();
      try {
        entry.info = await uploadFile(entry); entry.id = entry.info.id;
        if (entry.info.needs_ocr) { if (/\.pdf$/i.test(file.name)) await ocrPages(entry); }
        entry.status = 'Reading the records…'; renderList();
        entry.preview = await api(`/${entry.id}/preview`); entry.status = 'Ready to review';
        if (!active) active = entry;
      } catch (e) { entry.error = e.message; entry.status = 'Failed'; }
      renderList(); renderReview();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- rendering
  const STATUS_CLASS = { ok: 'bg-emerald-100 text-emerald-800', error: 'bg-red-100 text-red-800', duplicate: 'bg-amber-100 text-amber-800', exists: 'bg-slate-200 text-slate-700', reference: 'bg-indigo-100 text-indigo-800' };
  const STATUS_LABEL = { ok: 'valid', error: 'error', duplicate: 'duplicate', exists: 'exists', reference: 'compared' };
  function renderList() {
    const box = $('#di-files'); if (!box) return;
    box.innerHTML = files.length ? files.map((f) => `<button type="button" data-key="${f.key}" class="di-file w-full text-left p-2.5 rounded-lg border ${active === f ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-300'}">
      <div class="flex items-center justify-between gap-2"><span class="font-bold text-slate-800 truncate">${esc(f.file.name)}</span><span class="text-[10px] text-slate-500 whitespace-nowrap">${(f.file.size / 1024).toFixed(0)} KB</span></div>
      <div class="text-[11px] ${f.error ? 'text-red-700' : 'text-slate-600'} mt-0.5">${esc(f.error || f.status)}</div>
      ${f.preview ? `<div class="text-[10px] text-slate-500 mt-0.5">${esc(f.preview.category_label || 'type not recognised')} · ${f.preview.summary.records || 0} record(s)</div>` : ''}
      ${f.progress && f.progress < 100 ? `<div class="h-1 bg-slate-200 rounded mt-1"><div class="h-1 bg-indigo-500 rounded" style="width:${f.progress}%"></div></div>` : ''}
    </button>`).join('') : '<div class="text-slate-400 text-xs p-2">No documents yet.</div>';
    box.querySelectorAll('.di-file').forEach((b) => b.addEventListener('click', () => { active = files.find((f) => f.key === b.dataset.key); renderList(); renderReview(); }));
  }

  const opt = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map((l) => `<option value="${l.id}" ${String(sel) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const COLS = {
    register: [['date', 'Date'], ['invoice_no', 'Invoice'], ['party', 'Party'], ['taxable', 'Taxable', 1], ['cgst', 'CGST', 1], ['sgst', 'SGST', 1], ['igst', 'IGST', 1], ['total', 'Total', 1]],
    payments: [['date', 'Date'], ['party', 'Party'], ['amount', 'Amount', 1], ['mode', 'Mode'], ['reference', 'Ref']],
    transactions: [['date', 'Date'], ['voucher_type', 'Type'], ['voucher_no', 'No.']],
    bank_statement: [['date', 'Date'], ['description', 'Description'], ['withdrawal', 'Withdrawal', 1], ['deposit', 'Deposit', 1], ['balance', 'Balance', 1]],
    party_list: [['name', 'Name'], ['gstin', 'GSTIN'], ['phone', 'Phone'], ['email', 'E-mail'], ['city', 'City']],
    stock_statement: [['name', 'Item'], ['qty', 'Qty', 1], ['unit', 'Unit'], ['rate', 'Rate', 1], ['value', 'Value', 1]],
    report: [['name', 'Name'], ['debit', 'Debit', 1], ['credit', 'Credit', 1]]
  };
  const colsFor = (p) => (/_register$|_invoice$/.test(p.category) ? COLS.register : ['payments', 'receipts'].includes(p.category) ? COLS.payments : COLS[p.category] || (p.kind === 'report' ? COLS.report : []));

  function renderReview() {
    const box = $('#di-review'); if (!box) return;
    const f = active;
    if (!f) { box.innerHTML = '<div class="text-slate-500 text-sm p-6 text-center">Upload a PDF, Excel, CSV or scanned document to see what was found in it.</div>'; return; }
    if (f.result) { box.innerHTML = resultHtml(f); bindResult(f); return; }
    if (!f.preview) { box.innerHTML = `<div class="p-6 text-sm ${f.error ? 'text-red-700' : 'text-slate-600'}">${esc(f.error || f.status)}</div>`; return; }
    const p = f.preview, s = p.summary || {}, cols = colsFor(p), canImport = p.kind !== 'report' && s.valid > 0;
    // the records the person UNticked are remembered (a record that becomes valid after a correction is ticked by default)
    const excluded = new Set((f.settings.excluded || []).map(String));
    const only = new Set(p.records.filter((r) => r.status === 'ok' && !excluded.has(String(r.n))).map((r) => String(r.n)));
    box.innerHTML = `
      <div class="space-y-3">
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-0.5 text-xs"><span class="font-bold text-slate-700">This document is a</span>
            <select id="di-cat" class="border border-slate-300 rounded p-1.5 bg-white font-semibold">${!p.category ? '<option value="">-- choose --</option>' : ''}${p.categories.map((c) => `<option value="${c.id}" ${c.id === p.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          <span class="text-[11px] text-slate-500 pb-1.5">${p.classification && p.classification.category === p.category ? `Recognised (${esc(p.classification.confidence)} confidence): ${esc((p.classification.reasons || []).join('; '))}` : p.category ? 'Chosen by you' : 'Could not tell what kind of document this is: choose it.'}</span>
        </div>
        ${p.already_imported ? `<div class="p-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs">This exact file was already imported (import #${p.already_imported.id}${p.already_imported.at ? ', ' + esc(p.already_imported.at) : ''}). Its records already in the books are marked as duplicates.</div>` : ''}
        ${(p.warnings || []).map((w) => `<div class="p-2 rounded bg-slate-50 border border-slate-200 text-slate-700 text-xs">${esc(w)}</div>`).join('')}
        ${p.kind === 'report' ? '<div class="p-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs">A report is compared with your books line by line. It is never turned into vouchers (that would duplicate the entries it summarises).</div>' : ''}
        ${settingsHtml(f)}
        ${p.unknown_ledgers && p.unknown_ledgers.length ? unknownHtml(f) : ''}
        <div id="di-summary" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded p-2">
          <span><b>${s.records || 0}</b> record(s)</span><span class="text-emerald-700"><b>${s.valid || 0}</b> valid</span><span class="text-red-700"><b>${s.errors || 0}</b> with errors</span><span class="text-amber-700"><b>${s.duplicates || 0}</b> duplicate(s)</span>${s.existing ? `<span><b>${s.existing}</b> already exist</span>` : ''}
          ${p.kind === 'post' ? `<span>Total Dr <b class="font-mono">${money(s.total_debit)}</b></span><span>Total Cr <b class="font-mono">${money(s.total_credit)}</b></span>` : ''}
          ${s.gst ? `<span>GST <b class="font-mono">${money(s.gst)}</b></span>` : ''}${s.invoice_total ? `<span>Invoice total <b class="font-mono">${money(s.invoice_total)}</b></span>` : ''}
          ${s.withdrawals != null ? `<span>Withdrawals <b class="font-mono">${money(s.withdrawals)}</b></span><span>Deposits <b class="font-mono">${money(s.deposits)}</b></span>` : ''}
          ${p.kind === 'report' ? `<span>File Dr <b class="font-mono">${money(s.report_debit)}</b> · Cr <b class="font-mono">${money(s.report_credit)}</b></span><span><b>${s.differences || 0}</b> difference(s) with the books</span>` : ''}
          ${s.missing_fields && s.missing_fields.length ? `<span class="text-red-700">Missing: ${esc(s.missing_fields.join(', '))}</span>` : ''}
        </div>
        <div class="border border-slate-300 rounded-lg overflow-auto max-h-[52vh] text-xs">
          <table class="w-full min-w-[720px]"><thead class="bg-slate-800 text-white sticky top-0"><tr>
            <th class="p-2 w-8">${canImport ? '<input type="checkbox" id="di-all" checked title="Import every valid record">' : ''}</th><th class="p-2 text-left w-16">Row</th><th class="p-2 w-20">Status</th>
            ${cols.map((c) => `<th class="p-2 ${c[2] ? 'text-right' : 'text-left'}">${c[1]}</th>`).join('')}${p.category === 'transactions' ? '<th class="p-2 text-left">Ledger lines</th>' : ''}${p.kind === 'report' ? '<th class="p-2 text-right">In books</th><th class="p-2 text-right">Difference</th>' : ''}
            <th class="p-2 text-left">Notes</th></tr></thead>
          <tbody>${p.records.map((r) => `<tr class="border-t border-slate-200 ${r.status === 'error' ? 'bg-red-50/60' : r.status === 'duplicate' ? 'bg-amber-50/60' : ''}" data-n="${r.n}">
            <td class="p-1.5 text-center">${r.status === 'ok' && canImport ? `<input type="checkbox" class="di-take" value="${r.n}" ${only.has(String(r.n)) ? 'checked' : ''}>` : ''}</td>
            <td class="p-1.5 text-slate-500 whitespace-nowrap">${esc(r.sheet && !/^Page 1|^Image|^Document/.test(r.sheet) ? r.sheet + ' · ' : '')}${r.row ? 'row ' + r.row : ''}</td>
            <td class="p-1.5 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${STATUS_CLASS[r.status] || ''}">${STATUS_LABEL[r.status] || r.status}</span>${r.edited ? '<div class="text-[9px] text-indigo-700">corrected</div>' : ''}</td>
            ${cols.map(([k, , num]) => `<td class="p-1 ${num ? 'text-right font-mono' : ''}"><span ${p.kind !== 'report' ? `contenteditable="true" class="di-cell block min-w-[3rem] px-1 rounded hover:bg-white focus:bg-white focus:outline focus:outline-1 focus:outline-indigo-400" data-k="${k}"` : ''}>${esc(r.data[k] == null ? '' : r.data[k])}</span></td>`).join('')}
            ${p.category === 'transactions' ? `<td class="p-1.5 text-[11px] text-slate-600">${(r.data.lines || []).map((l) => `${l.debit ? 'Dr' : 'Cr'} ${esc(l.ledger)} ${money(l.debit || l.credit)}`).join('<br>')}</td>` : ''}
            ${p.kind === 'report' ? `<td class="p-1.5 text-right font-mono">${r.compare && r.compare.in_books != null ? money(r.compare.in_books) : '—'}</td><td class="p-1.5 text-right font-mono ${r.compare && r.compare.difference ? 'text-red-700 font-bold' : 'text-emerald-700'}">${r.compare && r.compare.difference != null ? money(r.compare.difference) : esc(r.compare && r.compare.note || '')}</td>` : ''}
            <td class="p-1.5 text-[11px]">${r.errors.map((e) => `<div class="text-red-700">${esc(e)}</div>`).join('')}${r.warnings.map((w) => `<div class="text-amber-700">${esc(w)}</div>`).join('')}${r.voucher ? `<div class="text-slate-500">${esc(r.voucher.voucher_type)}: ${r.voucher.lines.map((l) => (l.debit ? 'Dr ' : 'Cr ') + esc(l.ledger)).join(', ')}</div>` : ''}</td>
          </tr>`).join('') || `<tr><td colspan="9" class="p-4 text-center text-slate-400">${p.category ? 'No records found in this document for that type.' : 'Choose what kind of document this is.'}</td></tr>`}</tbody></table>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="di-recheck" class="px-3 py-1.5 rounded border border-slate-300 bg-white font-bold text-slate-700 hover:bg-slate-100 text-xs">Re-check</button>
          <button type="button" id="di-import" ${canImport ? '' : 'disabled'} class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-xs">Import ${p.kind === 'report' ? '' : `<span id="di-count">${only.size}</span> record(s)`}</button>
          <span class="text-[11px] text-slate-500">${p.kind === 'report' ? 'Reports are compared, not imported.' : 'Only valid records are imported, all together or none. Click a value to correct it, then Re-check.'}</span>
          <span id="di-busy" class="text-[11px] text-indigo-700 font-semibold"></span>
        </div>
      </div>`;
    bindReview(f);
  }

  function settingsHtml(f) {
    const p = f.preview, st = f.settings, d = p.defaults || {};
    const of = (g) => ledgers.filter((l) => g.includes(l.group_name));
    const parts = [];
    if (/^sales_/.test(p.category)) parts.push(`<label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">Sales account</span><select class="di-set border border-slate-300 rounded p-1.5 bg-white" data-k="sales_ledger_id">${opt(of(['Sales Accounts']), st.sales_ledger_id || (d.sales_ledger || {}).id)}</select></label>`);
    if (/^purchase_/.test(p.category)) parts.push(`<label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">Purchase account</span><select class="di-set border border-slate-300 rounded p-1.5 bg-white" data-k="purchase_ledger_id">${opt(of(['Purchase Accounts']), st.purchase_ledger_id || (d.purchase_ledger || {}).id)}</select></label>`);
    if (['payments', 'receipts', 'bank_statement'].includes(p.category)) parts.push(`<label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">${p.category === 'bank_statement' ? 'Bank account of this statement' : 'Bank / cash ledger (when the file does not say)'}</span><select class="di-set border border-slate-300 rounded p-1.5 bg-white" data-k="bank_ledger_id">${opt(of(['Bank Accounts', 'Cash-in-hand', 'Bank OD A/c']), st.bank_ledger_id || (d.bank_ledger || {}).id)}</select></label>`);
    if (p.category === 'party_list') parts.push(`<label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">These are</span><select class="di-set border border-slate-300 rounded p-1.5 bg-white" data-k="party_kind"><option value="customer" ${st.party_kind !== 'supplier' ? 'selected' : ''}>Customers</option><option value="supplier" ${st.party_kind === 'supplier' ? 'selected' : ''}>Suppliers</option></select></label>`);
    if (p.category === 'transactions') parts.push(`<label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">Type when the file has none</span><select class="di-set border border-slate-300 rounded p-1.5 bg-white" data-k="default_voucher_type">${['Journal', 'Payment', 'Receipt', 'Contra', 'Sales', 'Purchase'].map((t) => `<option ${st.default_voucher_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`);
    if (['sales_register', 'purchase_register', 'sales_invoice', 'purchase_invoice', 'payments', 'receipts'].includes(p.category)) parts.push(`<label class="flex items-center gap-1.5 pb-1.5"><input type="checkbox" class="di-set" data-k="create_missing_parties" ${st.create_missing_parties !== false ? 'checked' : ''}> Create missing customers / suppliers</label>`);
    return parts.length ? `<div class="flex flex-wrap items-end gap-3 text-xs">${parts.join('')}</div>` : '';
  }
  function unknownHtml(f) {
    const p = f.preview, map = f.settings.ledger_map || {};
    return `<div class="border border-amber-200 bg-amber-50 rounded p-2 text-xs space-y-1.5"><div class="font-bold text-amber-800">Ledgers in the file that are not in your books</div>
      ${p.unknown_ledgers.map((u) => { const cur = map[u.name] || (u.will_create ? `create:${u.suggest_group_id}` : ''); return `<div class="flex flex-wrap items-center gap-2"><span class="font-semibold min-w-[10rem]">${esc(u.name)}</span><span class="text-slate-500">(${u.records} record(s))</span>
        <select class="di-map border border-slate-300 rounded p-1 bg-white" data-name="${esc(u.name)}"><option value="">-- leave out (records stay as errors) --</option>
          <optgroup label="Create it under">${groups.map((g) => `<option value="create:${g.id}" ${cur === 'create:' + g.id ? 'selected' : ''}>Create under ${esc(g.name)}</option>`).join('')}</optgroup>
          <optgroup label="It is an existing ledger">${ledgers.map((l) => `<option value="${l.id}" ${String(cur) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</optgroup></select></div>`; }).join('')}</div>`;
  }

  function collect(f) {
    const box = $('#di-review');
    const cat = $('#di-cat', box); if (cat && cat.value) f.settings.category = cat.value;
    box.querySelectorAll('.di-set').forEach((el) => { f.settings[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    box.querySelectorAll('.di-map').forEach((el) => { f.settings.ledger_map = f.settings.ledger_map || {}; if (el.value) f.settings.ledger_map[el.dataset.name] = el.value; else delete f.settings.ledger_map[el.dataset.name]; });
    const takes = [...box.querySelectorAll('.di-take')];
    if (takes.length) {
      const was = new Set((f.settings.excluded || []).map(String));
      takes.forEach((c) => { if (c.checked) was.delete(c.value); else was.add(c.value); });
      f.settings.excluded = [...was];
      f.settings.only = takes.filter((c) => c.checked).map((c) => c.value); // what the server imports
    }
  }
  async function recheck(f) {
    collect(f);
    const busy = $('#di-busy'); if (busy) busy.textContent = 'Checking…';
    try { f.preview = await api(`/${f.id}/preview`, { method: 'POST', body: JSON.stringify({ settings: f.settings }) }); }
    catch (e) { alert(e.message); }
    renderList(); renderReview();
  }
  function bindReview(f) {
    const box = $('#di-review');
    const cat = $('#di-cat', box); if (cat) cat.addEventListener('change', () => { delete f.settings.only; delete f.settings.edits; delete f.settings.excluded; recheck(f); });
    box.querySelectorAll('.di-set, .di-map').forEach((el) => el.addEventListener('change', () => recheck(f)));
    box.querySelectorAll('.di-cell').forEach((el) => el.addEventListener('blur', () => {
      const n = el.closest('tr').dataset.n, k = el.dataset.k, v = el.textContent.trim();
      const rec = f.preview.records.find((r) => String(r.n) === n); if (!rec || String(rec.data[k] == null ? '' : rec.data[k]) === v) return;
      f.settings.edits = f.settings.edits || {}; f.settings.edits[n] = { ...(f.settings.edits[n] || {}), [k]: v };
      el.classList.add('bg-indigo-50');
    }));
    const all = $('#di-all', box); if (all) all.addEventListener('change', () => { box.querySelectorAll('.di-take').forEach((c) => { c.checked = all.checked; }); count(); });
    const count = () => { const c = $('#di-count', box); if (c) c.textContent = box.querySelectorAll('.di-take:checked').length; };
    box.querySelectorAll('.di-take').forEach((c) => c.addEventListener('change', count));
    $('#di-recheck', box).addEventListener('click', () => recheck(f));
    const imp = $('#di-import', box);
    if (imp) imp.addEventListener('click', async () => {
      collect(f);
      const n = (f.settings.only || []).length;
      if (!n) { alert('Tick at least one valid record to import.'); return; }
      if (!confirm(`Import ${n} record(s) from "${f.file.name}" into your books now?\n\nThey are saved together: if any one fails, none is saved.`)) return;
      imp.disabled = true; $('#di-busy').textContent = 'Importing…';
      try { f.result = await api(`/${f.id}/commit`, { method: 'POST', body: JSON.stringify({ settings: f.settings }) }); f.status = `Imported ${f.result.imported} record(s)`; }
      catch (e) { alert(`Nothing was imported: ${e.message}`); imp.disabled = false; $('#di-busy').textContent = ''; return; }
      renderList(); renderReview();
      if (typeof loadMasters === 'function') loadMasters();
    });
  }
  function resultHtml(f) {
    const r = f.result, c = r.created || {};
    return `<div class="space-y-3 text-xs">
      <div class="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-semibold">${r.replayed ? 'Already imported earlier: ' : ''}${r.imported} record(s) imported from ${esc(r.file_name)} (${esc(r.category_label)}). ${r.rejected ? `${r.rejected} not imported (reasons below).` : ''}</div>
      ${c.vouchers && c.vouchers.length ? `<div><div class="font-bold text-slate-700 mb-1">Vouchers posted (they are in the Day Book, ledgers, GST and reports)</div><div class="flex flex-wrap gap-1.5">${c.vouchers.slice(0, 300).map((v) => `<button type="button" class="di-v px-2 py-0.5 rounded border border-slate-300 bg-white hover:bg-indigo-50 font-mono" data-id="${v.id}">${esc(v.voucher_type)} ${esc(v.voucher_no)} · ${money(v.total)}</button>`).join('')}</div></div>` : ''}
      ${c.ledgers && c.ledgers.length ? `<div>New ledgers: ${c.ledgers.map((l) => `${esc(l.name)} (${esc(l.group)})`).join(', ')}</div>` : ''}
      ${c.parties && c.parties.length ? `<div>Customers / suppliers created: ${c.parties.length}</div>` : ''}${c.items && c.items.length ? `<div>Stock items created: ${c.items.length}</div>` : ''}
      ${c.bank_import ? '<div>The statement lines are in Banking > Bank Reconciliation, ready to match.</div>' : ''}
      ${r.rejected_records && r.rejected_records.length ? `<div><div class="font-bold text-slate-700 mb-1">Not imported</div>${r.rejected_records.map((x) => `<div>${x.row ? 'Row ' + x.row : '#' + x.n}: <span class="text-red-700">${esc(x.reason || x.status)}</span></div>`).join('')}</div>` : ''}
      <div class="flex gap-2"><button type="button" id="di-daybook" class="px-3 py-1.5 rounded bg-indigo-600 text-white font-bold">Open the Day Book</button><button type="button" id="di-history-btn" class="px-3 py-1.5 rounded border border-slate-300 bg-white font-bold">Import History</button></div></div>`;
  }
  function bindResult() {
    const box = $('#di-review');
    box.querySelectorAll('.di-v').forEach((b) => b.addEventListener('click', () => { if (typeof viewVoucherDetail === 'function') viewVoucherDetail(parseInt(b.dataset.id, 10)); }));
    const d = $('#di-daybook', box); if (d) d.addEventListener('click', () => openReport('daybook'));
    const h = $('#di-history-btn', box); if (h) h.addEventListener('click', () => tab('history'));
  }

  // ---------------------------------------------------------------------------------------------------------------- history
  async function renderHistory() {
    const box = $('#di-history'); if (!box) return;
    box.innerHTML = '<div class="p-4 text-slate-500 text-xs">Loading…</div>';
    try {
      const rows = await api('');
      const co = (typeof appState !== 'undefined' && appState.company && appState.company.name) || '';
      box.innerHTML = `<div class="border border-slate-300 rounded-lg overflow-x-auto text-xs"><table class="w-full min-w-[860px]"><thead class="bg-slate-800 text-white"><tr>
        <th class="p-2 text-left">Document</th><th class="p-2 text-left">Uploaded by</th><th class="p-2 text-left">Uploaded</th><th class="p-2 text-left">Company</th><th class="p-2 text-left">Type</th>
        <th class="p-2 text-right">Detected</th><th class="p-2 text-right">Imported</th><th class="p-2 text-right">Rejected</th><th class="p-2 text-left">Status</th><th class="p-2 text-left">Error</th><th class="p-2"></th></tr></thead><tbody>
        ${rows.map((h) => `<tr class="border-t border-slate-200"><td class="p-2 font-semibold">${esc(h.file_name)}</td><td class="p-2">${esc(h.uploaded_by)}</td><td class="p-2 font-mono">${esc(h.uploaded_at)}</td><td class="p-2">${esc(co)}</td><td class="p-2">${esc(h.category || '—')}</td>
          <td class="p-2 text-right">${h.detected || 0}</td><td class="p-2 text-right">${h.imported || 0}</td><td class="p-2 text-right">${h.rejected || 0}</td>
          <td class="p-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${h.status === 'imported' ? 'bg-emerald-100 text-emerald-800' : h.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-slate-200 text-slate-700'}">${esc(h.status)}</span>${h.imported_at ? `<div class="text-[10px] text-slate-500">${esc(h.imported_by || '')} ${esc(h.imported_at)}</div>` : ''}</td>
          <td class="p-2 text-red-700 max-w-[16rem]">${esc(h.error || '')}</td>
          <td class="p-2 whitespace-nowrap"><button type="button" class="di-dl px-1.5 py-0.5 rounded border border-slate-300 text-[10px] font-bold" data-id="${h.id}" data-name="${esc(h.file_name)}">Original</button> ${h.status === 'imported' ? `<button type="button" class="di-res px-1.5 py-0.5 rounded border border-slate-300 text-[10px] font-bold" data-id="${h.id}">Result</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="p-4 text-center text-slate-400">No documents imported yet.</td></tr>'}
      </tbody></table></div>`;
      box.querySelectorAll('.di-dl').forEach((b) => b.addEventListener('click', async () => {
        const res = await fetch(`${API()}/${b.dataset.id}/file`); if (!res.ok) { alert('The original file could not be opened.'); return; }
        const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.dataset.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }));
      box.querySelectorAll('.di-res').forEach((b) => b.addEventListener('click', async () => {
        const d = await api(`/${b.dataset.id}`); const entry = { key: 'h' + d.id, file: { name: d.file_name, size: d.size || 0 }, id: d.id, status: `Imported ${d.imported} record(s)`, result: d.result, settings: {} };
        files.unshift(entry); active = entry; tab('import'); renderList(); renderReview();
      }));
    } catch (e) { box.innerHTML = `<div class="p-4 text-red-700 text-xs">${esc(e.message)}</div>`; }
  }

  function tab(which) {
    const imp = which !== 'history';
    $('#di-tab-import').classList.toggle('hidden', !imp); $('#di-history').classList.toggle('hidden', imp);
    $('#di-t1').className = `px-3 py-1 rounded text-xs font-bold ${imp ? 'bg-amber-500 text-slate-900' : 'text-slate-300 hover:text-white'}`;
    $('#di-t2').className = `px-3 py-1 rounded text-xs font-bold ${!imp ? 'bg-amber-500 text-slate-900' : 'text-slate-300 hover:text-white'}`;
    if (!imp) renderHistory();
  }

  function build() {
    if ($('#view-doc-import')) return;
    const anchor = document.getElementById('view-daybook') || document.getElementById('view-gateway');
    const sec = document.createElement('section');
    sec.id = 'view-doc-import';
    sec.className = 'w-full max-w-6xl bg-white border border-slate-300 rounded-lg shadow-xl overflow-hidden hidden fade-in';
    sec.innerHTML = `
      <div class="bg-[#1f3a52] text-white px-5 py-2.5 flex flex-wrap gap-2 justify-between items-center">
        <div><h2 class="text-sm font-bold uppercase tracking-wider">Import Documents</h2><p class="text-[10px] text-slate-300">PDF · Excel · CSV · scanned documents → checked, previewed, then saved into the right place</p></div>
        <div class="flex items-center gap-1.5"><button type="button" id="di-t1">Import</button><button type="button" id="di-t2">History</button>
          <button type="button" onclick="showGateway()" class="ml-2 px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-semibold">Esc</button></div>
      </div>
      <div id="di-tab-import" class="p-4 grid grid-cols-1 lg:grid-cols-[17rem_1fr] gap-4">
        <div class="space-y-2">
          <label id="di-drop" class="block border-2 border-dashed border-slate-300 rounded-lg p-4 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/40">
            <input type="file" id="di-input" class="hidden" multiple accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg">
            <div class="font-bold text-slate-700 text-sm">Drop files here or click to choose</div>
            <div class="text-[11px] text-slate-500 mt-1">Invoices, registers, payments, receipts, Day Book, bank statements, customer / supplier lists, stock statements, trial balance, GST reports. Up to 25 MB each.</div>
          </label>
          <div id="di-files" class="space-y-1.5 max-h-[60vh] overflow-y-auto"></div>
        </div>
        <div id="di-review" class="min-w-0"></div>
      </div>
      <div id="di-history" class="p-4 hidden"></div>`;
    anchor.parentElement.insertBefore(sec, anchor.nextSibling);
    try { if (typeof VIEWS !== 'undefined' && !VIEWS.includes('view-doc-import')) VIEWS.push('view-doc-import'); if (typeof VIEW_BREADCRUMBS !== 'undefined') VIEW_BREADCRUMBS['view-doc-import'] = 'Gateway of RRE Entries > Import Documents'; } catch (e) { /* ignore */ }
    $('#di-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
    const drop = $('#di-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('border-indigo-500'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('border-indigo-500'); }));
    drop.addEventListener('drop', (e) => addFiles([...(e.dataTransfer && e.dataTransfer.files || [])]));
    $('#di-t1').addEventListener('click', () => tab('import')); $('#di-t2').addEventListener('click', () => tab('history'));
  }

  async function openDocImport(which) {
    build();
    showView('view-doc-import');
    tab(which === 'history' ? 'history' : 'import');
    try {
      const base = typeof API_BASE !== 'undefined' ? API_BASE : '/api';
      const [g, l] = await Promise.all([fetch(base + '/masters/groups').then((r) => r.json()), fetch(base + '/masters/ledgers').then((r) => r.json())]);
      groups = (g.data || []).sort((a, b) => a.name.localeCompare(b.name)); ledgers = (l.data || []).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { /* lists stay empty; the preview still works */ }
    renderList(); renderReview();
  }
  window.openDocImport = openDocImport;
  window.RREDocImport = { open: openDocImport, _files: files };
})();

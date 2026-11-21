/**
 * RRE Tally — Recurring vouchers and CSV voucher import, inside the Data (Alt+Y) menu.
 * Recurring entries become DRAFTS that a person confirms; imports are previewed before anything is posted.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const say = (id, html, cls) => { const el = $(id); if (el) { el.className = 'text-[10px] ' + (cls || 'text-slate-500'); el.innerHTML = html; } };
  let ledgerOptions = '';

  // ------------------------------------------------------------ recurring
  async function renderRecurring() {
    const box = $('bk2-rec'); if (!box) return;
    try {
      const [drafts, tpls] = await Promise.all([call('/recurring/drafts?status=pending'), call('/recurring/templates')]);
      box.innerHTML =
        `<div class="font-bold">Waiting for your confirmation (${drafts.length})</div>` +
        (drafts.length ? drafts.map((d) => `
          <div class="flex flex-wrap items-center justify-between gap-2 bg-white border border-amber-300 rounded p-2">
            <div><strong>${esc(d.name)}</strong> · ${esc(d.voucher_type)} · due ${esc(d.due_date)} · ₹${fmt(d.amount)}</div>
            <div class="space-x-1">
              <input type="number" step="0.01" min="0" placeholder="amount" data-amt="${d.id}" class="w-24 border border-slate-300 rounded p-0.5" title="Optional: change the amount for this occurrence (simple two-line templates)">
              <button type="button" data-conf="${d.id}" class="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Confirm &amp; post</button>
              <button type="button" data-skip="${d.id}" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Skip</button>
            </div></div>`).join('') : '<div class="text-slate-500">Nothing is waiting.</div>') +
        `<div class="font-bold pt-2">Recurring templates (${tpls.length})</div>` +
        (tpls.length ? tpls.map((t) => `
          <div class="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded p-2">
            <div><strong>${esc(t.name)}</strong> · ${esc(t.voucher_type)} · ${esc(t.frequency)} · ₹${fmt(t.amount)} ·
              ${t.is_active ? 'next ' + esc(t.next_due || '—') : '<em>paused / ended</em>'} · posted ${t.posted_count}</div>
            <div class="space-x-1"><button type="button" data-tog="${t.id}" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold">${t.is_active ? 'Pause' : 'Resume'}</button>
              <button type="button" data-del="${t.id}" class="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded font-bold">Delete</button></div></div>`).join('') : '<div class="text-slate-500">No templates yet.</div>');
      box.querySelectorAll('[data-conf]').forEach((b) => b.addEventListener('click', async () => {
        const amt = box.querySelector(`[data-amt="${b.dataset.conf}"]`).value;
        try { const r = await call(`/recurring/drafts/${b.dataset.conf}/confirm`, { method: 'POST', body: JSON.stringify(amt ? { amount: Number(amt) } : {}) }); say('bk2-rec-msg', `Posted ${esc(r.voucher_no)} (₹${fmt(r.total_amount)}).`, 'text-emerald-700'); renderRecurring(); }
        catch (e) { say('bk2-rec-msg', esc(e.message), 'text-red-700'); }
      }));
      box.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', async () => { try { await call(`/recurring/drafts/${b.dataset.skip}/skip`, { method: 'POST', body: '{}' }); renderRecurring(); } catch (e) { say('bk2-rec-msg', esc(e.message), 'text-red-700'); } }));
      box.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', async () => { try { await call(`/recurring/templates/${b.dataset.tog}/toggle`, { method: 'POST', body: '{}' }); renderRecurring(); } catch (e) { say('bk2-rec-msg', esc(e.message), 'text-red-700'); } }));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this template and its pending drafts? Vouchers already posted are not affected.')) return; try { await call(`/recurring/templates/${b.dataset.del}`, { method: 'DELETE' }); renderRecurring(); } catch (e) { say('bk2-rec-msg', esc(e.message), 'text-red-700'); } }));
    } catch (e) { box.innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function addTemplate() {
    try {
      const amount = Number($('bk2-amt').value);
      const body = { name: $('bk2-name').value, voucher_type: $('bk2-type').value, frequency: $('bk2-freq').value, start_date: $('bk2-start').value, narration: $('bk2-nar').value,
        entries: [{ ledger_id: Number($('bk2-dr').value), debit_amount: amount }, { ledger_id: Number($('bk2-cr').value), credit_amount: amount }] };
      const t = await call('/recurring/templates', { method: 'POST', body: JSON.stringify(body) });
      say('bk2-rec-msg', `Template "${esc(t.name)}" created. Drafts appear when they fall due; nothing posts until you confirm.`, 'text-emerald-700');
      $('bk2-name').value = ''; renderRecurring();
    } catch (e) { say('bk2-rec-msg', esc(e.message), 'text-red-700'); }
  }

  // ------------------------------------------------------------ import
  let batch = null;
  async function downloadTemplate() {
    try {
      const res = await fetch(`${base()}/import/template`);
      if (!res.ok) throw new Error('Could not download the template.');
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = 'RRE_voucher_import_template.csv';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { say('bk2-imp-msg', esc(e.message), 'text-red-700'); }
  }

  async function preview() {
    const f = $('bk2-file').files[0];
    if (!f) return say('bk2-imp-msg', 'Choose a CSV file first (Excel: File → Save As → CSV).', 'text-red-700');
    if (f.size > 8 * 1024 * 1024) return say('bk2-imp-msg', 'File is larger than 8 MB.', 'text-red-700');
    say('bk2-imp-msg', 'Checking the file…');
    try {
      batch = await call('/import/preview', { method: 'POST', body: JSON.stringify({ content: await f.text(), filename: f.name }) });
      const s = batch.summary;
      const rows = batch.results.map((r) => `<tr class="${r.status === 'error' ? 'bg-red-50' : r.status === 'warning' ? 'bg-amber-50' : ''}">
        <td class="p-1">${esc(r.ref)}</td><td class="p-1">${esc(r.voucher_type || '')} ${esc(r.date || '')}</td><td class="p-1 text-right font-mono">${r.total ? fmt(r.total) : ''}</td>
        <td class="p-1 font-bold ${r.status === 'error' ? 'text-red-700' : r.status === 'warning' ? 'text-amber-700' : 'text-emerald-700'}">${esc(r.status)}</td>
        <td class="p-1">${esc(r.errors.concat(r.warnings).join(' '))}</td></tr>`).join('');
      $('bk2-imp-out').innerHTML = `<div class="font-bold">${s.vouchers} voucher(s): ${s.ok} ok · ${s.warnings} warning · ${s.errors} error — total ₹${fmt(s.total_amount)}. <span class="font-normal text-slate-500">Nothing has been posted yet.</span></div>
        <div class="max-h-48 overflow-y-auto border border-slate-300 rounded"><table class="w-full text-[10px]"><thead class="bg-slate-100 sticky top-0"><tr><th class="p-1 text-left">Ref</th><th class="p-1 text-left">Voucher</th><th class="p-1 text-right">Amount</th><th class="p-1 text-left">Status</th><th class="p-1 text-left">Details</th></tr></thead><tbody class="divide-y">${rows}</tbody></table></div>
        <div class="flex flex-wrap items-center gap-2 pt-1">
          ${s.warnings ? '<label><input type="checkbox" id="bk2-inc-warn"> include vouchers with warnings</label>' : ''}
          ${s.errors ? '<label><input type="checkbox" id="bk2-skip-bad"> import the valid ones and skip the vouchers with errors</label>' : ''}
          <button type="button" id="bk2-commit" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Post to books</button>
          <button type="button" id="bk2-discard" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Discard</button>
        </div>`;
      say('bk2-imp-msg', '');
      $('bk2-commit').addEventListener('click', commit); $('bk2-discard').addEventListener('click', discard);
    } catch (e) { say('bk2-imp-msg', esc(e.message), 'text-red-700'); }
  }

  async function commit() {
    if (!batch) return;
    const body = { skip_invalid: !!($('bk2-skip-bad') && $('bk2-skip-bad').checked), include_warnings: !!($('bk2-inc-warn') && $('bk2-inc-warn').checked) };
    if (!confirm(`Post these vouchers to your books now? All are posted together or none are.`)) return;
    try {
      const r = await call(`/import/batches/${batch.batch_id}/commit`, { method: 'POST', body: JSON.stringify(body) });
      $('bk2-imp-out').innerHTML = '';
      say('bk2-imp-msg', `Posted ${r.posted_count} voucher(s)${r.skipped ? `, ${r.skipped} skipped` : ''}. Batch #${r.batch_id}.`, 'text-emerald-700');
      batch = null; $('bk2-file').value = '';
    } catch (e) { say('bk2-imp-msg', esc(e.message), 'text-red-700'); }
  }
  async function discard() {
    if (!batch) return;
    try { await call(`/import/batches/${batch.batch_id}/discard`, { method: 'POST', body: '{}' }); } catch (e) { /* ignore */ }
    batch = null; $('bk2-imp-out').innerHTML = ''; say('bk2-imp-msg', 'Discarded. Nothing was posted.');
  }

  // ------------------------------------------------------------ inject
  async function inject() {
    const modal = $('dataMenuModal');
    if (!modal || $('ext-bulk-tools')) return;
    const body = modal.querySelector('.p-5'); if (!body) return;
    try {
      const l = await (await fetch(`${base()}/masters/ledgers`)).json();
      ledgerOptions = (l.data || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch (e) { ledgerOptions = ''; }
    const sec = document.createElement('div');
    sec.id = 'ext-bulk-tools';
    sec.className = 'bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2 text-[11px]';
    sec.innerHTML = `
      <div class="font-bold text-slate-800 text-xs">Recurring Vouchers</div>
      <div class="text-[10px] text-slate-500">Rent, salaries, subscriptions. When one falls due it appears below as a draft — nothing posts until you confirm it.</div>
      <div id="bk2-rec" class="space-y-1"></div>
      <div class="flex flex-wrap items-center gap-1 pt-1">
        <input id="bk2-name" maxlength="80" placeholder="Name (e.g. Monthly rent)" class="border border-slate-300 rounded p-1 w-44 bg-white">
        <select id="bk2-type" class="border border-slate-300 rounded p-1 bg-white"><option>Payment</option><option>Receipt</option><option>Journal</option><option>Contra</option></select>
        <select id="bk2-dr" class="border border-slate-300 rounded p-1 bg-white max-w-[11rem]" title="Debit ledger">${ledgerOptions}</select>
        <select id="bk2-cr" class="border border-slate-300 rounded p-1 bg-white max-w-[11rem]" title="Credit ledger">${ledgerOptions}</select>
        <input id="bk2-amt" type="number" min="0.01" step="0.01" placeholder="Amount" class="border border-slate-300 rounded p-1 w-24 bg-white">
        <select id="bk2-freq" class="border border-slate-300 rounded p-1 bg-white"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select>
        <input id="bk2-start" type="date" class="border border-slate-300 rounded p-1 bg-white" title="First due date">
        <input id="bk2-nar" maxlength="300" placeholder="Narration" class="border border-slate-300 rounded p-1 w-44 bg-white">
        <button type="button" id="bk2-add" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Add template</button>
      </div>
      <div id="bk2-rec-msg" class="text-[10px] text-slate-500"></div>
      <div class="font-bold text-slate-800 text-xs pt-2">Import Vouchers from CSV</div>
      <div class="text-[10px] text-slate-500">One row per ledger line; rows with the same <code>voucher_ref</code> form one voucher. The file is checked first and nothing is posted until you press "Post to books".</div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="bk2-tpl" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Download template</button>
        <input id="bk2-file" type="file" accept=".csv,text/csv" class="text-[11px]">
        <button type="button" id="bk2-prev" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Check file</button>
      </div>
      <div id="bk2-imp-msg" class="text-[10px] text-slate-500"></div>
      <div id="bk2-imp-out" class="space-y-1"></div>`;
    body.insertBefore(sec, body.firstChild.nextSibling || null);
    $('bk2-add').addEventListener('click', addTemplate); $('bk2-tpl').addEventListener('click', downloadTemplate); $('bk2-prev').addEventListener('click', preview);
    const st = $('bk2-start'); if (!st.value) st.value = new Date().toISOString().slice(0, 10);
    renderRecurring();
  }

  function boot() {
    if (typeof window.openDataMenuModal === 'function' && !window.openDataMenuModal.__bulkHooked) {
      const original = window.openDataMenuModal;
      const wrapped = function () { const r = original.apply(this, arguments); inject().then(renderRecurring); return r; };
      wrapped.__bulkHooked = true;
      window.openDataMenuModal = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

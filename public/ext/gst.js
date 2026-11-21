/**
 * RRE Tally — GST compliance tools, added inside the existing GST Portal view.
 * Offline validation and reconciliation only. Nothing is filed or sent to any government system.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');

  async function call(path, opts = {}) {
    // auth-bridge.js attaches the session token to every local /api call
    const res = await fetch(`${base()}/gst${path}`, {
      ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j;
  }
  const out = () => document.getElementById('gst-tools-out');
  const busy = (msg) => { out().innerHTML = `<div class="text-slate-500">${esc(msg)}</div>`; };
  const fail = (e) => { out().innerHTML = `<div class="text-red-700 font-semibold">${esc(e.message)}</div>`; };

  const table = (cols, rows) => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="text-slate-500">None.</div>';
  const section = (title, count, body, open) => `<details class="border border-slate-200 rounded" ${open ? 'open' : ''}><summary class="cursor-pointer p-2 font-bold bg-slate-50">${esc(title)} <span class="text-slate-500">(${count})</span></summary><div class="p-2">${body}</div></details>`;
  const sevCls = { error: 'bg-red-100 text-red-800', warning: 'bg-amber-100 text-amber-800', info: 'bg-blue-100 text-blue-800' };

  async function validateOne() {
    const v = document.getElementById('gst-quick-input').value.trim();
    if (!v) return;
    try {
      const isGstin = /^[A-Za-z0-9]{15}$/.test(v) || /[A-Za-z]/.test(v) && v.length > 8;
      const j = await call(isGstin ? '/validate-gstin' : '/validate-hsn', { method: 'POST', body: JSON.stringify(isGstin ? { gstin: v } : { code: v }) });
      const d = j.data;
      if (isGstin) {
        out().innerHTML = `<div class="font-bold ${d.valid ? 'text-emerald-700' : 'text-red-700'}">${d.valid ? '✔ Structurally valid' : '✖ Invalid'} — ${esc(d.gstin)}${d.state ? ' · ' + esc(d.state) : ''}</div>` +
          d.checks.map((c) => `<div class="${c.ok ? 'text-slate-700' : 'text-red-700'}">${c.ok ? '✔' : '✖'} ${esc(c.name)} — ${esc(c.detail)}</div>`).join('') +
          `<div class="text-[10px] text-slate-500 mt-1">${esc(d.note)}</div>`;
      } else {
        out().innerHTML = `<div class="font-bold ${d.valid ? 'text-emerald-700' : 'text-red-700'}">${d.valid ? '✔ Looks valid' : '✖ Invalid'} ${d.kind ? '(' + esc(d.kind) + ')' : ''} — ${esc(d.code)}</div>` +
          d.issues.map((i) => `<div class="${i.startsWith('Warning') ? 'text-amber-700' : 'text-red-700'}">• ${esc(i)}</div>`).join('') +
          `<div class="text-[10px] text-slate-500 mt-1">${esc(d.note)}</div>`;
      }
    } catch (e) { fail(e); }
  }

  async function auditMasters() {
    busy('Checking GSTIN and HSN on all masters…');
    try {
      const d = (await call('/audit-masters')).data;
      out().innerHTML =
        section('Ledgers with GSTIN problems', d.ledger_issues.length,
          table(['Ledger', 'Group', 'GSTIN', 'Problems'], d.ledger_issues.map((l) => [esc(l.name), esc(l.group), esc(l.gstin), esc(l.problems.join('; '))])), d.ledger_issues.length > 0) +
        section('Customers / suppliers without a GSTIN', d.parties_without_gstin.length,
          table(['Ledger'], d.parties_without_gstin.map((l) => [esc(l.name)])), false) +
        section('Stock items with HSN / rate problems', d.item_issues.length,
          table(['Item', 'HSN', 'GST %', 'Problems'], d.item_issues.map((i) => [esc(i.name), esc(i.hsn_code), esc(i.gst_rate), esc(i.problems.join('; '))])), d.item_issues.length > 0) +
        `<div class="text-[10px] text-slate-500 mt-1">Checked ${d.ledgers_checked} GSTINs and ${d.items_checked} items. ${esc(d.note)}</div>`;
    } catch (e) { fail(e); }
  }

  async function taxCheck() {
    busy('Validating tax calculations on posted vouchers…');
    try {
      const f = document.getElementById('gst-tax-from').value, t = document.getElementById('gst-tax-to').value;
      const q = new URLSearchParams(); if (f) q.set('from_date', f); if (t) q.set('to_date', t);
      const d = (await call('/tax-check?' + q.toString())).data;
      out().innerHTML =
        `<div class="font-bold ${d.errors ? 'text-red-700' : 'text-emerald-700'}">${d.vouchers_with_tax_checked} voucher(s) checked · ${d.errors} error(s) · ${d.warnings} warning(s)${d.truncated ? ` — showing the first ${d.findings.length} of ${d.findings_total}; narrow the date range to see the rest` : ''}</div>` +
        table(['Date', 'Voucher', 'Type', 'Party', 'Severity', 'Finding'], d.findings.map((x) => [esc(x.date), esc(x.voucher_no), esc(x.type), esc(x.party || ''),
          `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${sevCls[x.severity] || ''}">${esc(x.severity)}</span>`, `<span class="font-sans">${esc(x.message)}</span>`])) +
        `<div class="text-[10px] text-slate-500 mt-1"><strong>Assumptions:</strong> ${d.assumptions.map(esc).join(' ')}</div>`;
    } catch (e) { fail(e); }
  }

  function renderRecon(r, runId) {
    const s = r.summary;
    const inv = (x) => `${esc(x.invoice_no)} <span class="text-slate-500">${esc(x.date || '')}</span>`;
    const tile = (label, v, cls) => `<div class="p-2 rounded border ${cls}"><div class="text-[10px] uppercase font-sans">${label}</div><div class="text-lg font-black">${v}</div></div>`;
    out().innerHTML =
      `<div class="grid grid-cols-2 md:grid-cols-5 gap-2 font-mono">` +
      tile('Matched', s.matched, 'bg-emerald-50 border-emerald-200 text-emerald-800') + tile('Amount mismatch', s.mismatched, 'bg-amber-50 border-amber-200 text-amber-800') +
      tile('Probable', s.probable, 'bg-blue-50 border-blue-200 text-blue-800') + tile('In 2B, not in books', s.in_2b_not_in_books, 'bg-red-50 border-red-200 text-red-800') +
      tile('In books, not in 2B', s.in_books_not_in_2b, 'bg-red-50 border-red-200 text-red-800') + `</div>` +
      `<div class="mt-2 font-bold">ITC at risk (books but not in 2B): ₹${fmt(s.tax_in_books_not_in_2b_itc_at_risk)} · Tax in 2B missing from books: ₹${fmt(s.tax_in_2b_not_in_books)}${runId ? ' · saved as run #' + runId : ''}</div>` +
      section('Amount mismatches', r.mismatched.length, table(['Supplier GSTIN', 'Invoice', 'Fields', 'Books − 2B'], r.mismatched.map((m) => [esc(m.portal.gstin), inv(m.portal), esc(m.differing_fields.join(', ')),
        esc(m.differing_fields.map((f) => `${f} ${fmt(m.difference[f])}`).join(' · '))])), r.mismatched.length > 0) +
      section('Probable matches (invoice number differs)', r.probable.length, table(['Supplier GSTIN', '2B invoice', 'Books voucher', 'Books ref'], r.probable.map((m) => [esc(m.portal.gstin), inv(m.portal), esc(m.books.voucher_no), esc(m.books.invoice_no)])), r.probable.length > 0) +
      section('In 2B but not in books (possible missing purchase entry)', r.in_2b_not_in_books.length, table(['Supplier', 'GSTIN', 'Invoice', 'Taxable', 'Tax'], r.in_2b_not_in_books.map((x) => [esc(x.supplier), esc(x.gstin), inv(x), fmt(x.taxable), fmt(x.igst + x.cgst + x.sgst + x.cess)])), r.in_2b_not_in_books.length > 0) +
      section('In books but not in 2B (ITC at risk — supplier may not have filed)', r.in_books_not_in_2b.length, table(['Voucher', 'Supplier', 'Invoice', 'Taxable', 'Tax'], r.in_books_not_in_2b.map((x) => [esc(x.voucher_no), esc(x.supplier), inv(x), fmt(x.taxable), fmt(x.igst + x.cgst + x.sgst + x.cess)])), r.in_books_not_in_2b.length > 0) +
      section('Matched', r.matched.length, table(['Supplier GSTIN', 'Invoice', 'Voucher'], r.matched.map((m) => [esc(m.portal.gstin), inv(m.portal), esc(m.books.voucher_no)])), false) +
      `<div class="text-[10px] text-slate-500 mt-2"><strong>Assumptions:</strong> ${r.assumptions.map(esc).join(' ')} <strong>Not covered:</strong> ${esc(r.not_covered.note)}</div>`;
  }

  async function reconcile() {
    const file = document.getElementById('gst-2b-file').files[0];
    if (!file) { out().innerHTML = '<div class="text-red-700">Choose a GSTR-2B file (.json from the GST portal, or .csv) first.</div>'; return; }
    if (file.size > 8 * 1024 * 1024) { out().innerHTML = '<div class="text-red-700">File is larger than 8 MB.</div>'; return; }
    busy('Reconciling…');
    try {
      const content = await file.text();
      const format = /\.csv$/i.test(file.name) ? 'csv' : 'json';
      const period = document.getElementById('gst-2b-period').value || undefined;
      const j = await call('/gstr2b/reconcile', { method: 'POST', body: JSON.stringify({ content, format, period, name: file.name }) });
      renderRecon(j.data, j.run_id);
      loadHistory();
    } catch (e) { fail(e); }
  }

  async function loadHistory() {
    const sel = document.getElementById('gst-2b-history');
    if (!sel) return;
    try {
      const rows = (await call('/gstr2b/history')).data;
      sel.innerHTML = '<option value="">Previous reconciliations…</option>' + rows.map((r) =>
        `<option value="${r.id}">#${r.id} · ${esc(new Date(r.created_at + 'Z').toLocaleString())} · ${esc(r.source_name || 'file')} · ${r.summary.matched}/${r.summary.portal_invoices} matched</option>`).join('');
    } catch (e) { /* history is optional */ }
  }

  async function openHistory() {
    const id = document.getElementById('gst-2b-history').value;
    if (!id) return;
    busy('Loading saved run…');
    try { renderRecon((await call('/gstr2b/history/' + id)).data.result, id); } catch (e) { fail(e); }
  }

  function inject() {
    const view = document.getElementById('view-gst');
    if (!view || document.getElementById('gst-tools-card')) return;
    const host = view.querySelector('.p-6');
    if (!host) return;
    const card = document.createElement('div');
    card.id = 'gst-tools-card';
    card.className = 'border border-slate-300 rounded-lg overflow-hidden';
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">GST Compliance Tools — Validation &amp; GSTR-2B Reconciliation</div>
      <div class="p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <input id="gst-quick-input" type="text" maxlength="20" placeholder="GSTIN or HSN/SAC code" class="border border-slate-300 rounded p-1.5 bg-white font-mono w-56">
          <button type="button" id="gst-quick-btn" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Validate</button>
          <button type="button" id="gst-audit-btn" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Audit GSTIN / HSN masters</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-bold text-slate-700">Tax check:</span>
          <input id="gst-tax-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to
          <input id="gst-tax-to" type="date" class="border border-slate-300 rounded p-1 bg-white">
          <button type="button" id="gst-tax-btn" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Validate tax calculations</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-bold text-slate-700">GSTR-2B:</span>
          <input id="gst-2b-file" type="file" accept=".json,.csv,application/json,text/csv" class="text-[11px]">
          <input id="gst-2b-period" type="month" title="Optional: limit books to this month" class="border border-slate-300 rounded p-1 bg-white">
          <button type="button" id="gst-2b-btn" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Reconcile with purchases</button>
          <select id="gst-2b-history" class="border border-slate-300 rounded p-1 bg-white max-w-xs"></select>
        </div>
        <div class="text-[10px] text-slate-500">Download the GSTR-2B JSON from the GST portal and upload it here. This tool only compares and reports; it does not file returns or contact any government system. A GSTIN that passes validation is structurally valid, not confirmed active.</div>
        <div id="gst-tools-out" class="space-y-2"></div>
      </div>`;
    host.appendChild(card);
    card.querySelector('#gst-quick-btn').addEventListener('click', validateOne);
    card.querySelector('#gst-quick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') validateOne(); });
    card.querySelector('#gst-audit-btn').addEventListener('click', auditMasters);
    card.querySelector('#gst-tax-btn').addEventListener('click', taxCheck);
    card.querySelector('#gst-2b-btn').addEventListener('click', reconcile);
    card.querySelector('#gst-2b-history').addEventListener('change', openHistory);
    loadHistory();
  }

  function boot() {
    inject();
    if (typeof window.loadGSTReport === 'function' && !window.loadGSTReport.__hooked) {
      const original = window.loadGSTReport;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); loadHistory(); return r; };
      wrapped.__hooked = true;
      window.loadGSTReport = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

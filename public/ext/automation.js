/**
 * RRE Tally — accounting automation helpers (analysis only; nothing is posted or sent automatically):
 *   1. Duplicate warning before a voucher is posted (same party + same reference number)
 *   2. Ledger suggestion under the Narration box, learned from earlier vouchers
 *   3. "Books Review" card in the Day Book: duplicates, unusual transactions, overdue reminders
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/automation${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }

  // ---------------------------------------------------------------- 1. duplicate warning before posting
  function hookSave() {
    if (typeof window.handleSaveVoucher !== 'function' || window.handleSaveVoucher.__hooked) return;
    const original = window.handleSaveVoucher;
    const wrapped = async function (e) {
      if (e && e.preventDefault) e.preventDefault(); // must happen before any await
      try {
        const ref = ($('v-ref') && $('v-ref').value || '').trim();
        const party = parseInt($('v-party-ledger') && $('v-party-ledger').value, 10);
        if (ref && party) {
          const d = await call('/duplicate-check', { method: 'POST', body: JSON.stringify({
            voucher_type: $('v-select-type').value, party_ledger_id: party, reference_no: ref, date: $('v-date').value }) });
          const high = d.candidates.filter((c) => c.level === 'high');
          if (high.length) {
            const list = high.slice(0, 3).map((c) => `• ${c.voucher_type} ${c.voucher_no} dated ${c.date}, ₹${fmt(c.total_amount)}`).join('\n');
            if (!confirm(`Possible DUPLICATE: reference "${ref}" was already used for this party:\n\n${list}\n\nPost this voucher anyway?`)) return;
          }
        }
      } catch (err) { /* the check is advisory; never block saving because it failed */ }
      return original.call(this, e);
    };
    wrapped.__hooked = true;
    window.handleSaveVoucher = wrapped;
  }

  // ---------------------------------------------------------------- 2. ledger hint under the narration
  let hintSeq = 0;
  function hookNarration() {
    const input = $('v-narration');
    if (!input || input.__hinted) return;
    input.__hinted = true;
    const hint = document.createElement('div');
    hint.id = 'ext-narr-hint';
    hint.className = 'text-[10px] text-slate-500 mt-1 hidden';
    input.parentNode.appendChild(hint);
    input.addEventListener('blur', async () => {
      const text = input.value.trim(); const my = ++hintSeq;
      if (text.length < 8) { hint.classList.add('hidden'); return; }
      try {
        const k = await call('/categorize', { method: 'POST', body: JSON.stringify({ narration: text }) });
        if (my !== hintSeq) return;
        if (k.ledger && k.confidence >= 0.5) {
          hint.innerHTML = `💡 Similar earlier entries used <strong>${esc(k.ledger.name)}</strong> (${esc(k.category)}) — ${Math.round(k.confidence * 100)}% match from ${k.based_on_vouchers} voucher(s). Suggestion only.`;
          hint.classList.remove('hidden');
        } else hint.classList.add('hidden');
      } catch (e) { hint.classList.add('hidden'); }
    });
  }

  // ---------------------------------------------------------------- 3. Books Review card in Day Book
  const out = () => $('rv-out');
  const busy = (m) => { out().innerHTML = `<div class="text-slate-500">${esc(m)}</div>`; };
  const fail = (e) => { out().innerHTML = `<div class="text-red-700 font-semibold">${esc(e.message)}</div>`; };
  const table = (cols, rows, empty) => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="text-emerald-700">${esc(empty)}</div>`;
  const rangeQ = () => { const f = $('rv-from').value, t = $('rv-to').value; const q = new URLSearchParams(); if (f) q.set('from_date', f); if (t) q.set('to_date', t); const s = q.toString(); return s ? '?' + s : ''; };
  const SEV = { warning: 'bg-amber-100 text-amber-800', info: 'bg-blue-100 text-blue-800' };

  async function duplicates() {
    busy('Scanning for duplicate vouchers…');
    try {
      const d = await call('/duplicates' + rangeQ());
      out().innerHTML = `<div class="font-bold">${d.groups.length} possible duplicate group(s) in ${d.vouchers_scanned} vouchers</div>` +
        (d.groups.length ? d.groups.map((g) => `<div class="mt-2"><span class="px-1.5 py-0.5 rounded font-bold ${g.level === 'high' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}">${esc(g.level)}</span> ${esc(g.reason)} — ₹${fmt(g.amount)}</div>` +
          table(['Date', 'Voucher', 'Type', 'Party', 'Reference', 'Amount'], g.vouchers.map((v) => [esc(v.date), esc(v.voucher_no), esc(v.voucher_type), esc(v.party || ''), esc(v.reference_no || ''), fmt(v.total_amount)]))).join('') : '<div class="text-emerald-700">No duplicates found.</div>') +
        `<div class="text-[10px] text-slate-500 mt-1">${esc(d.note)}</div>`;
    } catch (e) { fail(e); }
  }

  async function unusual() {
    busy('Reviewing transactions…');
    try {
      const d = await call('/unusual' + rangeQ());
      out().innerHTML = `<div class="font-bold">${d.findings_total} item(s) to review (from ${d.entries_analysed} ledger entries)${d.truncated ? ` — showing the ${d.findings.length} most important; narrow the period to see the rest` : ''}</div>` +
        table(['Date', 'Voucher', 'Party / ledger', 'Amount', 'Severity', 'Why flagged'], d.findings.map((f) => [esc(f.date), esc(f.voucher_no), esc((f.party || '') + (f.ledger ? ' · ' + f.ledger : '')), fmt(f.amount),
          `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${SEV[f.severity] || ''}">${esc(f.severity)}</span>`, `<span class="font-sans">${esc(f.message)}</span>`]), 'Nothing unusual found.') +
        `<div class="text-[10px] text-slate-500 mt-1"><strong>Methods:</strong> ${d.methods.map(esc).join(' ')}</div>`;
    } catch (e) { fail(e); }
  }

  async function reminders() {
    busy('Preparing reminders…');
    try {
      const d = await call('/reminders');
      out().innerHTML = `<div class="font-bold">₹${fmt(d.total_overdue)} overdue from ${d.customers.length} customer(s) (as at ${esc(d.as_of)})</div>` +
        (d.customers.length ? d.customers.map((c, i) => `<div class="border border-slate-300 rounded p-2 mt-2">
          <div class="flex items-center justify-between"><strong>${esc(c.customer)}</strong><span>₹${fmt(c.total)} · ${c.max_days} days overdue · <em>${esc(c.tone)}</em></span></div>
          <pre class="whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded p-2 mt-1 font-sans text-[11px]" id="rv-msg-${i}">${esc(c.message)}</pre>
          <div class="flex flex-wrap items-center gap-2 mt-1">
            <button type="button" class="rv-copy px-2 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold" data-i="${i}">Copy message</button>
            <input type="tel" placeholder="Customer mobile (10 digits)" class="rv-phone border border-slate-300 rounded p-1 w-44" data-i="${i}">
            <button type="button" class="rv-wa px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold" data-i="${i}">Open in WhatsApp</button>
          </div></div>`).join('') : '<div class="text-emerald-700">No overdue payments.</div>') +
        `<div class="text-[10px] text-slate-500 mt-2">${esc(d.note)}</div>`;
      out().querySelectorAll('.rv-copy').forEach((b) => b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(d.customers[b.dataset.i].message); b.textContent = 'Copied ✓'; } catch (e) { b.textContent = 'Select the text and copy manually'; }
      }));
      out().querySelectorAll('.rv-wa').forEach((b) => b.addEventListener('click', () => {
        let ph = (out().querySelector(`.rv-phone[data-i="${b.dataset.i}"]`).value || '').replace(/\D/g, '');
        if (ph.length === 10) ph = '91' + ph;
        if (ph.length < 11 || ph.length > 15) { alert('Enter the customer\'s mobile number first (10 digits).'); return; }
        window.open(`https://wa.me/${ph}?text=${encodeURIComponent(d.customers[b.dataset.i].message)}`, '_blank', 'noopener');
      }));
    } catch (e) { fail(e); }
  }

  function injectReview() {
    const view = $('view-daybook');
    if (!view || $('rv-card')) return;
    const host = view.querySelector('.p-6');
    if (!host) return;
    const card = document.createElement('div');
    card.id = 'rv-card';
    card.className = 'border border-slate-300 rounded-lg overflow-hidden text-xs';
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">Books Review — Duplicates, Unusual Transactions &amp; Payment Reminders</div>
      <div class="p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="rv-dup" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Find duplicates</button>
          <button type="button" id="rv-unu" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Unusual transactions</button>
          <button type="button" id="rv-rem" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Overdue payment reminders</button>
          <span class="text-slate-500">Period:</span><input id="rv-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to <input id="rv-to" type="date" class="border border-slate-300 rounded p-1 bg-white">
        </div>
        <div class="text-[10px] text-slate-500">Analysis only: nothing is changed, posted or sent. Findings are leads to review, not conclusions.</div>
        <div id="rv-out" class="space-y-1"></div>
      </div>`;
    host.appendChild(card);
    $('rv-dup').addEventListener('click', duplicates); $('rv-unu').addEventListener('click', unusual); $('rv-rem').addEventListener('click', reminders);
  }

  function boot() {
    hookSave(); hookNarration();
    if (typeof window.loadDaybook === 'function' && !window.loadDaybook.__hooked) {
      const original = window.loadDaybook;
      const wrapped = function () { const r = original.apply(this, arguments); injectReview(); return r; };
      wrapped.__hooked = true;
      window.loadDaybook = wrapped;
    }
    // the voucher form is created at load time, but be safe if it is built later
    setTimeout(hookNarration, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

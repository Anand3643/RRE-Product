/**
 * RRE Tally — Ledger Vouchers: one ledger's transactions for a period, as in Tally (opened from a Profit & Loss amount, or
 * openLedgerStatement(ledgerId, { from, to, back })). Opening balance, every voucher with its other ledgers, party and narration,
 * debit / credit, running balance, the period total and the closing balance. Click a line to open its voucher.
 * Data: GET /api/reports/ledger-statement/:id?from=&to= (the same ledger entries every report reads).
 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (typeof formatCurrency === 'function' ? formatCurrency(n) : '₹' + Number(n || 0).toFixed(2));
  const day = (d) => (typeof formatDateDisplay === 'function' ? formatDateDisplay(d) : d);
  const BACK = {
    'profit-loss': ['Profit & Loss', () => openReport('profit-loss')],
    'balance-sheet': ['Balance Sheet', () => openReport('balance-sheet')],
    'trial-balance': ['Trial Balance', () => openReport('trial-balance')]
  };
  let state = { id: null, from: null, to: null, back: null };

  function build() {
    if ($('#view-ledger-vouchers')) return;
    const anchor = document.getElementById('view-profit-loss') || document.getElementById('view-daybook');
    const sec = document.createElement('section');
    sec.id = 'view-ledger-vouchers';
    sec.className = 'w-full max-w-6xl bg-white border border-slate-300 rounded-lg shadow-xl overflow-hidden hidden fade-in';
    sec.innerHTML = `
      <div class="bg-[#1f3a52] text-white px-5 py-2.5 flex flex-wrap gap-2 justify-between items-center">
        <div class="min-w-0"><h2 class="text-sm font-bold uppercase tracking-wider truncate" id="lv-title">Ledger Vouchers</h2><p class="text-[10px] text-slate-300" id="lv-sub"></p></div>
        <div class="flex flex-wrap items-center gap-1.5">
          <button type="button" id="lv-back" class="hidden px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-900 rounded text-xs font-bold">← Back</button>
          <button type="button" onclick="showGateway()" class="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-semibold">Esc</button>
        </div>
      </div>
      <div class="p-4 space-y-3 text-xs">
        <div class="flex flex-wrap items-end gap-2 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
          <label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">From</span><input type="date" id="lv-from" class="border border-slate-300 rounded p-1.5 bg-white"></label>
          <label class="flex flex-col gap-0.5"><span class="font-bold text-slate-700">To</span><input type="date" id="lv-to" class="border border-slate-300 rounded p-1.5 bg-white"></label>
          <button type="button" id="lv-apply" class="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Show</button>
          <span id="lv-facts" class="ml-auto text-slate-600"></span>
        </div>
        <div class="border border-slate-300 rounded-lg overflow-x-auto"><table class="w-full min-w-[760px]">
          <thead class="bg-slate-800 text-white"><tr><th class="p-2 text-left w-24">Date</th><th class="p-2 text-left">Particulars</th><th class="p-2 text-left w-28">Voucher</th><th class="p-2 text-left">Narration</th><th class="p-2 text-right w-28">Debit</th><th class="p-2 text-right w-28">Credit</th><th class="p-2 text-right w-32">Balance</th></tr></thead>
          <tbody id="lv-body"></tbody></table></div>
        <div class="text-[10px] text-slate-500">Click a line to open its voucher. Amounts come from the posted vouchers; the opening balance is the ledger's opening balance plus everything before the period.</div>
      </div>`;
    anchor.parentElement.insertBefore(sec, anchor.nextSibling);
    try { if (typeof VIEWS !== 'undefined' && !VIEWS.includes('view-ledger-vouchers')) VIEWS.push('view-ledger-vouchers'); if (typeof VIEW_BREADCRUMBS !== 'undefined') VIEW_BREADCRUMBS['view-ledger-vouchers'] = 'Gateway of RRE Entries > Ledger Vouchers'; } catch (e) { /* ignore */ }
    $('#lv-apply').addEventListener('click', () => { state.from = $('#lv-from').value || null; state.to = $('#lv-to').value || null; load(); });
    $('#lv-back').addEventListener('click', () => { const b = BACK[state.back]; if (b) b[1](); else showGateway(); });
    $('#lv-body').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-vid]'); if (tr && typeof window.viewVoucherDetail === 'function') window.viewVoucherDetail(parseInt(tr.dataset.vid, 10)); });
  }

  async function load() {
    const body = $('#lv-body');
    body.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-500">Loading…</td></tr>';
    const qs = new URLSearchParams(); if (state.from) qs.set('from', state.from); if (state.to) qs.set('to', state.to);
    try {
      const base = typeof API_BASE !== 'undefined' ? API_BASE : '/api';
      const res = await fetch(`${base}/reports/ledger-statement/${state.id}?${qs}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) throw new Error(j.error || `Could not load the ledger (${res.status})`);
      const d = j.data, L = d.ledger;
      $('#lv-title').textContent = `Ledger Vouchers — ${L.name}`;
      $('#lv-sub').textContent = `${L.group_name}${state.from || state.to ? ` · ${state.from ? day(state.from) : 'beginning'} to ${state.to ? day(state.to) : 'today'}` : ' · all dates'}`;
      const sign = (amt, type) => `${money(amt)} ${type}`;
      const rows = d.statement.map((s) => `<tr data-vid="${s.voucher_id}" class="border-t border-slate-200 hover:bg-indigo-50 cursor-pointer" title="Open ${esc(s.voucher_type)} ${esc(s.voucher_no)}">
        <td class="p-2 whitespace-nowrap font-mono">${esc(day(s.date))}</td>
        <td class="p-2"><div class="font-semibold text-slate-800">${esc(s.against || s.particulars || '')}</div>${s.party && !String(s.against || '').includes(s.party) ? `<div class="text-[10px] text-slate-500">Party: ${esc(s.party)}</div>` : ''}</td>
        <td class="p-2 whitespace-nowrap"><div class="font-mono text-indigo-700">${esc(s.voucher_no)}</div><div class="text-[10px] text-slate-500">${esc(s.voucher_type)}${s.reference_no ? ' · ' + esc(s.reference_no) : ''}</div></td>
        <td class="p-2 text-slate-600 max-w-[18rem]">${esc(s.narration || '')}</td>
        <td class="p-2 text-right font-mono">${s.debit_amount ? money(s.debit_amount) : ''}</td>
        <td class="p-2 text-right font-mono">${s.credit_amount ? money(s.credit_amount) : ''}</td>
        <td class="p-2 text-right font-mono whitespace-nowrap">${sign(s.balance, s.balance_type)}</td></tr>`).join('');
      const net = d.net_debit;
      body.innerHTML = `<tr class="bg-slate-50 font-semibold"><td class="p-2" colspan="6">Opening balance${state.from ? ` as on ${esc(day(state.from))}` : ''}</td><td class="p-2 text-right font-mono whitespace-nowrap">${sign(d.opening_balance, d.opening_type)}</td></tr>
        ${rows || '<tr><td colspan="7" class="p-4 text-center text-slate-500">No transactions in this period.</td></tr>'}
        <tr class="border-t-2 border-slate-300 bg-slate-100 font-bold"><td class="p-2" colspan="4">Total for the period</td><td class="p-2 text-right font-mono">${money(d.total_debit)}</td><td class="p-2 text-right font-mono">${money(d.total_credit)}</td><td></td></tr>
        <tr class="bg-slate-100 font-bold"><td class="p-2" colspan="6">Net for the period</td><td class="p-2 text-right font-mono whitespace-nowrap" id="lv-net">${sign(Math.abs(net), net >= 0 ? 'Dr' : 'Cr')}</td></tr>
        <tr class="bg-[#1f3a52] text-white font-bold"><td class="p-2" colspan="6">Closing balance</td><td class="p-2 text-right font-mono whitespace-nowrap" id="lv-closing">${sign(d.closing_balance, d.closing_type)}</td></tr>`;
      $('#lv-facts').textContent = `${d.statement.length} transaction(s)`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-red-700">${esc(e.message)}</td></tr>`;
    }
  }

  /** open a ledger's vouchers: ledgerId (a real ledger id), { from, to } (the period of the report it was opened from), back ('profit-loss' ...) */
  async function openLedgerStatement(ledgerId, opts = {}) {
    const id = parseInt(ledgerId, 10); if (!id) return;
    build();
    state = { id, from: opts.from || null, to: opts.to || null, back: opts.back || null };
    $('#lv-from').value = state.from || ''; $('#lv-to').value = state.to || '';
    const b = BACK[state.back]; const bb = $('#lv-back');
    bb.classList.toggle('hidden', !b); if (b) bb.textContent = `← Back to ${b[0]}`;
    showView('view-ledger-vouchers');
    window.scrollTo(0, 0);
    await load();
  }
  window.openLedgerStatement = openLedgerStatement;
  window.reloadLedgerVouchers = () => (state.id ? load() : null); // live-sync: another device posted something
  window.RRELedgerVouchers = { open: openLedgerStatement, reload: () => (state.id ? load() : null) };
})();

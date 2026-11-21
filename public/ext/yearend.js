/**
 * RRE Tally — Year-End Closing assistant, added to the Data menu (Alt+Y).
 * Read-only: it checks the books, shows closing figures and downloads opening-balance files. It never posts or locks anything.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  const ST = { pass: ['bg-emerald-100 text-emerald-800', 'OK'], warn: ['bg-amber-100 text-amber-800', 'Check'], fail: ['bg-red-100 text-red-800', 'Fix'] };

  async function call(path) {
    const res = await fetch(`${base()}/yearend${path}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const qs = () => { const f = $('ye-from').value, t = $('ye-to').value; return `?${f ? 'from=' + f + '&' : ''}${t ? 'to=' + t : ''}`; };
  const msg = (h, cls) => { const el = $('ye-msg'); el.className = 'text-[10px] ' + (cls || 'text-slate-500'); el.innerHTML = h; };

  async function check() {
    msg('Checking…');
    try {
      const r = await call('/readiness' + qs());
      $('ye-from').value = r.from; $('ye-to').value = r.to;
      $('ye-out').innerHTML = `<div class="font-bold ${r.ready ? 'text-emerald-700' : 'text-red-700'}">${r.ready ? 'Ready to close' : 'Not ready — fix the red items first'} <span class="font-normal text-slate-500">(${r.summary.pass} OK, ${r.summary.warn} to check, ${r.summary.fail} to fix)</span></div>` +
        r.checks.map((c) => `<div class="border border-slate-200 rounded bg-white p-1.5"><span class="px-1.5 py-0.5 rounded font-bold ${ST[c.status][0]}">${ST[c.status][1]}</span> <span class="font-bold">${esc(c.title)}</span>
          <div class="text-[10px] text-slate-600">${esc(c.detail)}${c.fix && c.status !== 'pass' ? ' <i>' + esc(c.fix) + '</i>' : ''}</div></div>`).join('');
      msg('');
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  async function snapshot() {
    msg('Preparing…');
    try {
      const s = await call('/snapshot' + qs());
      $('ye-out').innerHTML = `<div class="font-bold">Closing position on ${esc(s.to)}</div>
        <div>Net profit for the year: <b class="font-mono">₹${num(s.net_profit)}</b> · Closing stock: <b class="font-mono">₹${num(s.closing_stock_value)}</b></div>
        <div class="border border-slate-300 rounded overflow-x-auto max-h-56 overflow-y-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 sticky top-0"><tr><th class="p-1 text-left">Ledger</th><th class="p-1 text-left">Group</th><th class="p-1 text-right">Balance</th></tr></thead>
        <tbody class="divide-y divide-slate-200 font-mono">${s.balance_sheet_ledgers.map((l) => `<tr><td class="p-1">${esc(l.name)}</td><td class="p-1">${esc(l.group)}</td><td class="p-1 text-right">${num(l.balance)} ${l.type}</td></tr>`).join('')}</tbody></table></div>`;
      msg('');
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  function save(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function pack() {
    try {
      const p = await call('/opening-pack' + qs());
      save(`opening_balances_${p.to}.csv`, p.ledgers_csv); save(`opening_stock_${p.to}.csv`, p.stock_csv);
      msg(esc(p.note), 'text-emerald-700');
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  function inject() {
    const modal = $('dataMenuModal');
    if (!modal || $('ext-yearend')) return;
    const body = modal.querySelector('.p-5'); if (!body) return;
    const sec = document.createElement('div');
    sec.id = 'ext-yearend';
    sec.className = 'bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2 text-[11px]';
    sec.innerHTML = `
      <div class="font-bold text-slate-800 text-xs">Year-End Closing</div>
      <div class="text-[10px] text-slate-500">Checks that the books are ready, shows the closing position and prepares opening-balance files for next year. It does not post, lock or change anything.</div>
      <div class="flex flex-wrap items-center gap-1">
        <input id="ye-from" type="date" class="border border-slate-300 rounded p-1 bg-white" title="Year start"> to <input id="ye-to" type="date" class="border border-slate-300 rounded p-1 bg-white" title="Year end">
        <button type="button" id="ye-check" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Check readiness</button>
        <button type="button" id="ye-snap" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Closing position</button>
        <button type="button" id="ye-pack" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Download opening balances</button>
      </div>
      <div id="ye-msg" class="text-[10px] text-slate-500"></div><div id="ye-out" class="space-y-1"></div>`;
    body.insertBefore(sec, body.firstChild.nextSibling || null);
    $('ye-check').addEventListener('click', check); $('ye-snap').addEventListener('click', snapshot); $('ye-pack').addEventListener('click', pack);
  }

  function boot() {
    if (typeof window.openDataMenuModal === 'function' && !window.openDataMenuModal.__yearendHooked) {
      const original = window.openDataMenuModal;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__yearendHooked = true;
      window.openDataMenuModal = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

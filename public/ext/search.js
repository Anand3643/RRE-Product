/**
 * RRE Tally — smart search inside the existing Ctrl+K palette, plus a read-only "quick look" preview.
 * The palette still lists commands exactly as before; when you type two or more characters it also lists matching vouchers,
 * parties/ledgers and stock items (typos are tolerated; an exact amount finds vouchers). Selecting one opens a preview.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  let seq = 0, timer = null;

  async function api(path) {
    const res = await fetch(`${base()}/search${path}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }

  // ------------------------------------------------------------------ quick look panel
  function panel(title, bodyHtml) {
    let o = document.getElementById('ql-overlay');
    if (!o) {
      o = document.createElement('div'); o.id = 'ql-overlay';
      o.className = 'fixed inset-0 z-[60] bg-black/50 flex items-start justify-center pt-16 px-3';
      o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
      document.body.appendChild(o);
    }
    o.innerHTML = `<div class="bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[78vh] overflow-y-auto text-xs border border-slate-300">
      <div class="bg-slate-800 text-white font-bold p-2.5 flex items-center justify-between rounded-t-lg"><span>${esc(title)}</span><button type="button" id="ql-close" class="px-1.5 hover:bg-slate-600 rounded" title="Close (Esc)">✕</button></div>
      <div class="p-3 space-y-2">${bodyHtml}</div></div>`;
    document.getElementById('ql-close').addEventListener('click', () => o.remove());
  }
  const row = (k, v) => `<div class="flex justify-between gap-3 border-b border-slate-100 py-0.5"><span class="text-slate-500">${esc(k)}</span><span class="font-semibold text-right">${v}</span></div>`;
  const dc = (d, c) => (d > 0 ? `${money(d)} Dr` : c > 0 ? `${money(c)} Cr` : '');

  async function lookVoucher(id) {
    try {
      const v = await api(`/voucher/${id}`);
      panel(`${v.voucher_type} ${v.voucher_no}`,
        row('Date', esc(v.date)) + (v.party ? row('Party', esc(v.party)) : '') + row('Total', money(v.total_amount)) + (v.reference_no ? row('Reference', esc(v.reference_no)) : '') + (v.narration ? row('Narration', esc(v.narration)) : '') +
        `<table class="w-full text-[11px] mt-1"><thead class="bg-slate-100"><tr><th class="p-1 text-left">Ledger</th><th class="p-1 text-right">Debit</th><th class="p-1 text-right">Credit</th></tr></thead><tbody class="divide-y divide-slate-100 font-mono">` +
        v.lines.map((l) => `<tr><td class="p-1">${esc(l.ledger)}</td><td class="p-1 text-right">${l.debit_amount ? money(l.debit_amount) : ''}</td><td class="p-1 text-right">${l.credit_amount ? money(l.credit_amount) : ''}</td></tr>`).join('') + '</tbody></table>' +
        (v.stock.length ? `<div class="font-bold mt-1">Stock items</div>` + v.stock.map((s) => `<div class="flex justify-between"><span>${esc(s.name)}</span><span class="font-mono">${s.direction === 'IN' ? '+' : '−'}${esc(s.quantity)} @ ${money(s.rate)}</span></div>`).join('') : ''));
    } catch (e) { panel('Voucher', `<div class="text-red-700">${esc(e.message)}</div>`); }
  }

  async function lookLedger(id) {
    try {
      const l = await api(`/ledger/${id}`);
      panel(l.name,
        row('Group', esc(l.group)) + (l.gstin ? row('GSTIN', esc(l.gstin)) : '') + (l.state ? row('State', esc(l.state)) : '') +
        (l.balances_visible ? row('Closing balance', `<b>${money(l.closing.amount)} ${l.closing.type}</b>`) + row('Entries', esc(l.entries)) : '<div class="text-[10px] text-slate-500">Balances are shown to roles that may view financial reports.</div>') +
        `<div class="font-bold mt-1">Recent entries</div>` + (l.recent.length ? l.recent.map((r) => `<div class="flex justify-between"><span>${esc(r.date)} · ${esc(r.voucher_type)} ${esc(r.voucher_no)}</span><span class="font-mono">${l.balances_visible ? dc(r.debit_amount, r.credit_amount) : ''}</span></div>`).join('') : '<div class="text-slate-500">None yet.</div>'));
    } catch (e) { panel('Ledger', `<div class="text-red-700">${esc(e.message)}</div>`); }
  }

  async function lookItem(id) {
    try {
      const s = await api(`/item/${id}`);
      panel(s.name,
        row('In stock', `<b class="${s.low ? 'text-red-700' : ''}">${esc(s.quantity_on_hand)} ${esc(s.uom)}</b>${s.low ? ' (at or below reorder level ' + esc(s.reorder_level) + ')' : ''}`) + (s.hsn_code ? row('HSN', esc(s.hsn_code)) : '') + row('GST rate', esc(s.gst_rate) + '%') +
        (s.value_visible ? row('Average rate', money(s.rate)) + row('Stock value', money(s.value)) : '') +
        `<div class="font-bold mt-1">Recent movements</div>` + (s.recent.length ? s.recent.map((m) => `<div class="flex justify-between"><span>${esc(m.date)} · ${esc(m.voucher_type)} ${esc(m.voucher_no)}</span><span class="font-mono">${m.direction === 'IN' ? '+' : '−'}${esc(m.quantity)}</span></div>`).join('') : '<div class="text-slate-500">No movements yet.</div>'));
    } catch (e) { panel('Stock item', `<div class="text-red-700">${esc(e.message)}</div>`); }
  }

  // ------------------------------------------------------------------ palette integration
  function toItems(r) {
    const out = [];
    for (const v of r.vouchers) out.push({ title: `${v.voucher_type} ${v.voucher_no} · ${v.date} · ${money(v.total_amount)}${v.party ? ' · ' + v.party : ''}`, category: 'Voucher', hotkey: 'View', action: () => lookVoucher(v.id) });
    for (const l of r.ledgers) out.push({ title: l.name, category: l.grp || 'Ledger', hotkey: 'View', action: () => lookLedger(l.id) });
    for (const i of r.items) out.push({ title: `${i.name}${i.hsn_code ? ' · HSN ' + i.hsn_code : ''}`, category: 'Stock item', hotkey: 'View', action: () => lookItem(i.id) });
    return out;
  }

  function hook() {
    if (typeof window.handleOmniSearchInput !== 'function' || window.handleOmniSearchInput.__searchHooked) return;
    const original = window.handleOmniSearchInput;
    const wrapped = function (e) {
      const r = original.apply(this, arguments); // the usual command list renders first, unchanged
      const q = ((e && e.target && e.target.value) || '').trim();
      clearTimeout(timer);
      if (q.length < 2) return r;
      const mine = ++seq;
      timer = setTimeout(async () => {
        try {
          const res = await api(`?q=${encodeURIComponent(q)}`);
          if (mine !== seq || typeof renderOmniResults !== 'function') return; // a newer keystroke superseded this one
          const extra = toItems(res);
          if (!extra.length) return;
          renderOmniResults([...(window._activeOmniList || []), ...extra]);
        } catch (err) { /* search is a bonus; the command list still works */ }
      }, 180);
      return r;
    };
    wrapped.__searchHooked = true;
    window.handleOmniSearchInput = wrapped;
  }

  function boot() {
    hook();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const o = document.getElementById('ql-overlay'); if (o) { o.remove(); e.stopPropagation(); } } }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

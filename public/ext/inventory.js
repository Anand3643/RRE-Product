/**
 * RRE Tally — inventory intelligence, added inside the existing Stock Summary view.
 * Read-only analysis; the only write is setting an item's reorder level.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/inventory${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const out = () => $('inv-out');
  const busy = (m) => { out().innerHTML = `<div class="text-slate-500">${esc(m)}</div>`; };
  const fail = (e) => { out().innerHTML = `<div class="text-red-700 font-semibold">${esc(e.message)}</div>`; };
  const table = (cols, rows, empty = 'Nothing to show.') => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="text-slate-500">${esc(empty)}</div>`;
  const assumptions = (a) => `<div class="text-[10px] text-slate-500 mt-2"><strong>Assumptions:</strong> ${a.map(esc).join(' ')}</div>`;
  const STATUS = {
    out_of_stock: ['Out of stock', 'bg-red-100 text-red-800'], reorder_now: ['Reorder now', 'bg-red-100 text-red-800'],
    below_reorder_level: ['Below reorder level', 'bg-amber-100 text-amber-800'], ok: ['OK', 'bg-emerald-100 text-emerald-800'], no_recent_demand: ['No recent demand', 'bg-slate-200 text-slate-700']
  };
  const badge = (s) => `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
  const asOfQ = () => ($('inv-asof').value ? `as_of=${encodeURIComponent($('inv-asof').value)}` : '');
  const q = (...parts) => '?' + parts.filter(Boolean).join('&');

  async function reorder() {
    busy('Calculating reorder suggestions…');
    try {
      const lead = $('inv-lead').value || 14, safety = $('inv-safety').value || 7;
      const d = await call('/reorder' + q(asOfQ(), `lead_time_days=${encodeURIComponent(lead)}`, `safety_days=${encodeURIComponent(safety)}`));
      out().innerHTML = `<div class="text-[11px] text-slate-500">As at ${esc(d.as_of)} · lead time ${d.parameters.lead_time_days} d · safety ${d.parameters.safety_days} d</div>` +
        table(['Item', 'On hand', 'Reorder level', 'Demand / day', 'Cover (days)', 'Status', 'Suggested order', 'Best supplier (last rate)', 'Est. cost (ex-GST)', ''],
          d.items.map((r) => [esc(r.name), num(r.current_qty) + ' ' + esc(r.uom), `<input type="number" min="0" step="any" value="${r.reorder_level}" data-lvl="${r.item_id}" class="inv-lvl w-20 border border-slate-300 rounded p-0.5">`,
            num(r.avg_daily_demand), r.days_of_cover === null ? '—' : num(r.days_of_cover), badge(r.status),
            r.suggested_order_qty ? `<strong>${num(r.suggested_order_qty)}</strong>` : '—',
            r.suggested_supplier ? `${esc(r.suggested_supplier.name)} (₹${fmt(r.suggested_supplier.last_rate)})` : '—', r.estimated_cost === null ? '—' : '₹' + fmt(r.estimated_cost),
            `<button type="button" data-save="${r.item_id}" class="inv-save px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-sans font-bold">Save level</button>`])) + assumptions(d.assumptions);
      out().querySelectorAll('.inv-save').forEach((b) => b.addEventListener('click', async () => {
        const v = out().querySelector(`.inv-lvl[data-lvl="${b.dataset.save}"]`).value;
        try { await call(`/items/${b.dataset.save}/reorder-level`, { method: 'POST', body: JSON.stringify({ reorder_level: v === '' ? null : Number(v) }) }); b.textContent = 'Saved ✓'; setTimeout(reorder, 600); }
        catch (e) { b.textContent = 'Error'; b.title = e.message; }
      }));
    } catch (e) { fail(e); }
  }

  async function demand() {
    busy('Forecasting demand…');
    try {
      const d = await call('/demand' + q(asOfQ()));
      out().innerHTML = `<div class="text-[11px] text-slate-500">As at ${esc(d.as_of)} · lookback ${d.lookback_days} d · horizon ${d.horizon_days} d</div>` +
        table(['Item', 'On hand', 'Sold (last 30 d)', 'Sold (prior 60 d)', 'Demand / day', `Forecast (${d.horizon_days} d)`, 'Cover (days)', 'Confidence', 'Last six 30-day periods (oldest → newest)'],
          d.items.map((r) => [esc(r.name), num(r.current_qty), num(r.recent_30d_qty), num(r.prior_60d_qty), num(r.avg_daily_weighted), `<strong>${num(r.forecast_qty)}</strong>`,
            r.days_of_cover === null ? '—' : num(r.days_of_cover), esc(r.confidence), r.last_6_periods_30d.map((p) => num(p.qty)).join(' · ')])) + assumptions(d.assumptions);
    } catch (e) { fail(e); }
  }

  async function dead() {
    busy('Finding slow and dead stock…');
    try {
      const d = await call('/dead-stock' + q(asOfQ(), `days=${encodeURIComponent($('inv-days').value || 90)}`));
      out().innerHTML = `<div class="font-bold">₹${fmt(d.total_value_locked)} tied up in ${d.items.length} item(s) with no sale in ${d.threshold_days}+ days (as at ${esc(d.as_of)})</div>` +
        table(['Item', 'On hand', 'Cost / unit', 'Value locked', 'Last sale', 'Days since', 'Category'],
          d.items.map((r) => [esc(r.name), num(r.current_qty), fmt(r.cost_per_unit), fmt(r.value_locked), esc(r.last_sale_date || '—'), r.days_since_last_sale === null ? '—' : r.days_since_last_sale, esc(r.category)]), 'No dead or slow-moving stock.') + assumptions(d.assumptions);
    } catch (e) { fail(e); }
  }

  async function godowns() {
    busy('Comparing godowns…');
    try {
      const d = await call('/godown-stock');
      out().innerHTML = table(['Item', 'Opening (unallocated)', ...d.godowns.map((g) => g.name), 'No godown', 'Total', 'Notes'],
        d.items.map((r) => [esc(r.name), num(r.opening_unallocated), ...r.godowns.map((g) => g.qty < 0 ? `<span class="text-red-700">${num(g.qty)}</span>` : num(g.qty)), num(r.no_godown), `<strong>${num(r.total_qty)}</strong>`,
          `<span class="font-sans text-amber-700">${esc(r.flags.join(' '))}</span>`])) + assumptions(d.assumptions);
    } catch (e) { fail(e); }
  }

  async function suppliers() {
    busy('Comparing supplier prices…');
    try {
      const d = await call('/supplier-prices');
      out().innerHTML = (d.items.length ? d.items.map((it) =>
        `<div class="font-bold mt-2">${esc(it.item)} <span class="text-emerald-700 font-normal">— best: ${esc(it.best_supplier)}${it.saving_per_unit_vs_dearest ? ' (saves ₹' + fmt(it.saving_per_unit_vs_dearest) + '/unit vs dearest)' : ''}</span></div>` +
        table(['Supplier', 'Purchases', 'Total qty', 'Average rate', 'Last rate', 'Lowest', 'Highest', 'Last bought', 'Trend'],
          it.suppliers.map((s) => [esc(s.supplier), s.purchases, num(s.total_qty), fmt(s.avg_rate), `<strong>${fmt(s.last_rate)}</strong>`, fmt(s.min_rate), fmt(s.max_rate), esc(s.last_date), esc(s.trend)])) +
        (it.note ? `<div class="text-[10px] text-slate-500">${esc(it.note)}</div>` : '')).join('') : '<div class="text-slate-500">No purchases recorded yet.</div>') + assumptions(d.assumptions);
    } catch (e) { fail(e); }
  }

  async function movements() {
    const id = $('inv-item').value;
    if (!id) return (out().innerHTML = '<div class="text-red-700">Pick an item first.</div>');
    busy('Loading movement history…');
    try {
      const d = await call(`/movements/${id}` + q($('inv-from').value && `from_date=${$('inv-from').value}`, $('inv-to').value && `to_date=${$('inv-to').value}`));
      out().innerHTML = `<div class="font-bold">${esc(d.item.name)} — brought forward ${num(d.brought_forward)} ${esc(d.item.uom)} · in ${num(d.totals.inward)} · out ${num(d.totals.outward)} · closing ${num(d.closing_qty)}</div>` +
        table(['Date', 'Voucher', 'Type', 'Party', 'Godown', 'In', 'Out', 'Rate', 'Balance'],
          d.movements.map((m) => [esc(m.date), esc(m.voucher_no), esc(m.voucher_type), esc(m.party || ''), esc(m.godown || ''), m.direction === 'IN' ? num(m.quantity) : '', m.direction === 'OUT' ? num(m.quantity) : '', fmt(m.rate), `<strong>${num(m.balance)}</strong>`]), 'No movements in this period.');
    } catch (e) { fail(e); }
  }

  async function loadItems() {
    try {
      const res = await fetch(`${base()}/masters/stock-items`); const j = await res.json();
      $('inv-item').innerHTML = '<option value="">Item for movement history…</option>' + (j.data || []).map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
    } catch (e) { /* optional */ }
  }

  function inject() {
    const view = $('view-stock-summary');
    if (!view || $('inv-tools-card')) return;
    const host = view.querySelector('.p-6');
    if (!host) return;
    const card = document.createElement('div');
    card.id = 'inv-tools-card';
    card.className = 'border border-slate-300 rounded-lg overflow-hidden text-xs mt-4';
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">Inventory Intelligence — Reorder, Demand, Dead Stock, Godowns &amp; Suppliers</div>
      <div class="p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="inv-b-reorder" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Reorder suggestions</button>
          <button type="button" id="inv-b-demand" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Demand forecast</button>
          <button type="button" id="inv-b-dead" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Dead / slow stock</button>
          <button type="button" id="inv-b-godown" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Godown comparison</button>
          <button type="button" id="inv-b-supp" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Supplier prices</button>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-[11px]">
          <label>As at <input id="inv-asof" type="date" title="Blank = latest voucher date in the books" class="border border-slate-300 rounded p-1 bg-white"></label>
          <label>Lead time (d) <input id="inv-lead" type="number" min="0" value="14" class="w-14 border border-slate-300 rounded p-1 bg-white"></label>
          <label>Safety (d) <input id="inv-safety" type="number" min="0" value="7" class="w-14 border border-slate-300 rounded p-1 bg-white"></label>
          <label>Dead after (d) <input id="inv-days" type="number" min="30" value="90" class="w-16 border border-slate-300 rounded p-1 bg-white"></label>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-[11px]">
          <select id="inv-item" class="border border-slate-300 rounded p-1 bg-white max-w-xs"></select>
          <input id="inv-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to <input id="inv-to" type="date" class="border border-slate-300 rounded p-1 bg-white">
          <button type="button" id="inv-b-move" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Movement history</button>
        </div>
        <div class="text-[10px] text-slate-500">Analysis only — nothing is ordered or posted. "As at" defaults to the latest voucher date in your books.</div>
        <div id="inv-out" class="space-y-2"></div>
      </div>`;
    host.appendChild(card);
    $('inv-b-reorder').addEventListener('click', reorder); $('inv-b-demand').addEventListener('click', demand); $('inv-b-dead').addEventListener('click', dead);
    $('inv-b-godown').addEventListener('click', godowns); $('inv-b-supp').addEventListener('click', suppliers); $('inv-b-move').addEventListener('click', movements);
    loadItems();
  }

  function boot() {
    if (typeof window.loadStockSummary === 'function' && !window.loadStockSummary.__hooked) {
      const original = window.loadStockSummary;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__hooked = true;
      window.loadStockSummary = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

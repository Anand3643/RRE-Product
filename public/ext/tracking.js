/**
 * RRE Tally — batch / expiry / serial tracking and barcode lookup, added inside the Stock Summary view.
 * Recording batches or serials never changes stock quantities; it only labels the units on posted stock lines.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/tracking${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.details = j.details; throw e; }
    return j.data;
  }
  const msg = (html, cls) => { const el = $('tk-msg'); el.className = 'text-[11px] ' + (cls || 'text-slate-600'); el.innerHTML = html; };
  const table = (cols, rows, empty) => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="text-slate-500">${esc(empty || 'Nothing to show.')}</div>`;
  const ST = { ok: 'bg-emerald-100 text-emerald-800', expiring: 'bg-amber-100 text-amber-800', expired: 'bg-red-100 text-red-800', empty: 'bg-slate-200 text-slate-600', negative: 'bg-red-100 text-red-800' };
  const badge = (s) => `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${ST[s] || ''}">${esc(s)}</span>`;
  let items = [];

  // ----------------------------------------------------------- lookup (works with USB / Bluetooth scanners that "type" the code + Enter)
  async function lookup() {
    const code = $('tk-code').value.trim();
    if (!code) return;
    try {
      const d = await call('/lookup?code=' + encodeURIComponent(code));
      $('tk-out').innerHTML = d.matches.length ? d.matches.map((m) => {
        if (m.type === 'barcode') return `<div class="border rounded p-2 bg-white">📦 <strong>${esc(m.item)}</strong> (barcode) — on hand <strong>${num(m.quantity_on_hand)}</strong>${m.hsn_code ? ' · HSN ' + esc(m.hsn_code) : ''}</div>`;
        if (m.type === 'serial') return `<div class="border rounded p-2 bg-white">🔢 Serial <strong>${esc(m.serial_no)}</strong> of ${esc(m.item)} — <strong>${esc(m.status)}</strong><div class="text-slate-500">${m.events.map((e) => `${esc(e.event)}: ${esc(e.voucher_type)} ${esc(e.voucher_no)} (${esc(e.date)}${e.party ? ', ' + esc(e.party) : ''})`).join(' → ')}</div></div>`;
        return `<div class="border rounded p-2 bg-white">🏷️ Batch <strong>${esc(m.batch_no)}</strong> of ${esc(m.item)} — ${num(m.remaining)} in stock${m.expiry_date ? ', expires ' + esc(m.expiry_date) : ''} ${badge(m.status)}</div>`;
      }).join('') : `<div class="text-slate-500">No item, serial number or batch matches "${esc(code)}".</div>`;
      msg('');
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
    $('tk-code').select();
  }

  // ----------------------------------------------------------- settings
  async function loadItems() {
    items = await call('/items');
    $('tk-item').innerHTML = '<option value="">Choose an item…</option>' + items.map((i) => `<option value="${i.id}">${esc(i.name)}${i.track_batches || i.track_serials ? ' ●' : ''}</option>`).join('');
  }
  function fillSettings() {
    const it = items.find((i) => String(i.id) === $('tk-item').value);
    $('tk-batches').checked = !!(it && it.track_batches); $('tk-expiry').checked = !!(it && it.has_expiry);
    $('tk-serials').checked = !!(it && it.track_serials); $('tk-barcode').value = (it && it.barcode) || '';
  }
  async function saveSettings() {
    const id = $('tk-item').value; if (!id) return msg('Choose an item first.', 'text-red-700');
    try {
      await call(`/items/${id}/settings`, { method: 'POST', body: JSON.stringify({ track_batches: $('tk-batches').checked, has_expiry: $('tk-expiry').checked, track_serials: $('tk-serials').checked, barcode: $('tk-barcode').value.trim() }) });
      msg('Saved.', 'text-emerald-700'); await loadItems(); $('tk-item').value = id; await showWork(); await showBatches();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  // ----------------------------------------------------------- work list & assignment
  async function showWork() {
    const box = $('tk-work');
    try {
      const w = await call('/work' + ($('tk-item').value ? '?item_id=' + $('tk-item').value : ''));
      box.innerHTML = `<div class="font-bold">Stock lines waiting for batch / serial details (${w.length})</div>` + table(['Date', 'Voucher', 'Item', 'Direction', 'Qty', 'Batches', 'Serials', ''],
        w.map((r) => [esc(r.date), esc(r.voucher_no) + ' <span class="text-slate-500">' + esc(r.voucher_type) + '</span>', esc(r.item), r.direction === 'IN' ? 'In' : 'Out', num(r.quantity),
          r.track_batches ? `${num(r.batch_allocated)} / ${num(r.quantity)}` : '—', r.track_serials ? `${r.serial_count} / ${num(r.quantity)}` : '—',
          `<button type="button" data-assign="${r.entry_id}" data-dir="${r.direction}" data-bat="${r.needs_batch ? 1 : 0}" data-ser="${r.needs_serial ? 1 : 0}" data-exp="${r.has_expiry ? 1 : 0}" data-qty="${r.quantity}" class="tk-assign px-1.5 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-sans font-bold">Assign</button>`]),
        'All tracked stock lines are fully assigned.');
      box.querySelectorAll('.tk-assign').forEach((b) => b.addEventListener('click', () => openAssign(b.dataset)));
    } catch (e) { box.innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function openAssign(d) {
    const panel = $('tk-assign'); const entry = d.assign; const out = d.dir === 'OUT';
    let html = `<div class="border border-blue-300 bg-blue-50 rounded p-2 space-y-2"><div class="font-bold">Assign for stock line #${esc(entry)} (${out ? 'going out' : 'coming in'}, quantity ${esc(d.qty)})</div>`;
    if (d.bat === '1') {
      html += `<div><div class="font-semibold">Batches</div><div id="tk-bat-rows" class="space-y-1"></div>
        <div class="space-x-2 pt-1"><button type="button" id="tk-addrow" class="px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold">+ line</button>
        ${out ? '<button type="button" id="tk-fefo" class="px-1.5 py-0.5 bg-amber-200 hover:bg-amber-300 rounded font-bold">Suggest (earliest expiry first)</button>' : ''}
        <button type="button" id="tk-savebat" class="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Save batches</button></div></div>`;
    }
    if (d.ser === '1') {
      html += `<div><div class="font-semibold">Serial numbers <span class="font-normal text-slate-500">(one per line — a barcode scanner can type them in, one per Enter)</span></div>
        <textarea id="tk-serials-text" rows="4" class="w-full border border-slate-300 rounded p-1 font-mono bg-white"></textarea>
        <button type="button" id="tk-saveser" class="mt-1 px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Save serial numbers</button></div>`;
    }
    panel.innerHTML = html + '</div>';
    const rowsBox = $('tk-bat-rows');
    const addRow = (v = {}) => {
      if (!rowsBox) return;
      const r = document.createElement('div'); r.className = 'flex flex-wrap items-center gap-1';
      r.innerHTML = `<input class="tk-b-no border border-slate-300 rounded p-1 w-36 bg-white" placeholder="Batch no." value="${esc(v.batch_no || '')}"><input class="tk-b-qty border border-slate-300 rounded p-1 w-20 bg-white" type="number" step="any" min="0" placeholder="Qty" value="${esc(v.qty || '')}">` +
        (!out && d.exp === '1' ? `<input class="tk-b-exp border border-slate-300 rounded p-1 bg-white" type="date" title="Expiry date" value="${esc(v.expiry_date || '')}">` : (v.expiry_date ? `<span class="text-slate-500">exp ${esc(v.expiry_date)}</span>` : ''));
      rowsBox.appendChild(r);
    };
    if (rowsBox) { addRow(); $('tk-addrow').addEventListener('click', () => addRow()); }
    if ($('tk-fefo')) $('tk-fefo').addEventListener('click', async () => {
      try { const s = await call(`/entries/${entry}/fefo`); rowsBox.innerHTML = ''; s.suggestion.forEach((p) => addRow(p)); if (!s.suggestion.length) addRow();
        msg(s.shortfall ? `Only part can be covered: shortfall ${num(s.shortfall)}. ${esc(s.method)}` : esc(s.method), s.shortfall ? 'text-amber-700' : 'text-slate-600'); } catch (e) { msg(esc(e.message), 'text-red-700'); }
    });
    if ($('tk-savebat')) $('tk-savebat').addEventListener('click', async () => {
      const allocations = [...rowsBox.children].map((r) => ({ batch_no: r.querySelector('.tk-b-no').value, qty: Number(r.querySelector('.tk-b-qty').value), expiry_date: (r.querySelector('.tk-b-exp') || {}).value || undefined })).filter((a) => a.batch_no || a.qty);
      try { const r = await call(`/entries/${entry}/batches`, { method: 'POST', body: JSON.stringify({ allocations }) }); msg(`Saved ${r.saved} batch line(s). Allocated ${num(r.allocated)} of ${num(r.voucher_quantity)}.`, 'text-emerald-700'); panel.innerHTML = ''; showWork(); showBatches(); }
      catch (e) { msg(esc(e.message), 'text-red-700'); }
    });
    if ($('tk-saveser')) $('tk-saveser').addEventListener('click', async () => {
      const serials = $('tk-serials-text').value.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
      try { const r = await call(`/entries/${entry}/serials`, { method: 'POST', body: JSON.stringify({ serials }) }); msg(`Saved ${r.saved} serial number(s). ${r.recorded_on_line} of ${num(r.voucher_quantity)} recorded.`, 'text-emerald-700'); panel.innerHTML = ''; showWork(); }
      catch (e) { msg(esc(e.message), 'text-red-700'); }
    });
  }

  // ----------------------------------------------------------- batch register & expiry
  async function showBatches() {
    const id = $('tk-item').value;
    try {
      const b = await call('/batches' + (id ? '?item_id=' + id : ''));
      $('tk-reg').innerHTML = `<div class="font-bold">Batch register${id ? '' : ' (all tracked items)'} — today's date used for expiry</div>` +
        table(['Item', 'Batch', 'Expiry', 'Received', 'Issued', 'In stock', 'Days left', 'Status'], b.map((x) => [esc(x.item), esc(x.batch_no), esc(x.expiry_date || '—'), num(x.received), num(x.issued), `<strong>${num(x.remaining)}</strong>`, x.days_to_expiry === null ? '—' : x.days_to_expiry, badge(x.status)]), 'No batches recorded yet.');
    } catch (e) { $('tk-reg').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }
  async function showExpiring() {
    try {
      const d = await call('/expiring?days=90');
      $('tk-reg').innerHTML = `<div class="font-bold">Expired or expiring within 90 days (${d.batches.length}) — ${num(d.expired_units)} unit(s) already expired</div>` +
        table(['Item', 'Batch', 'Expiry', 'In stock', 'Days left', 'Status'], d.batches.map((x) => [esc(x.item), esc(x.batch_no), esc(x.expiry_date), `<strong>${num(x.remaining)}</strong>`, x.days_to_expiry, badge(x.status)]), 'No stock is expired or close to expiry.');
    } catch (e) { $('tk-reg').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }
  async function showSerials() {
    const id = $('tk-item').value;
    try {
      const s = await call('/serials' + (id ? '?item_id=' + id : ''));
      $('tk-reg').innerHTML = `<div class="font-bold">Serial numbers (${s.length}${s.length === 500 ? '+, showing first 500' : ''})</div>` +
        table(['Item', 'Serial', 'Status', 'Received', 'Issued'], s.map((x) => [esc(x.item), esc(x.serial_no), esc(x.status), esc((x.received_on || '') + (x.received_date ? ' · ' + x.received_date : '')), esc((x.issued_on || '') + (x.issued_date ? ' · ' + x.issued_date : ''))]), 'No serial numbers recorded yet.');
    } catch (e) { $('tk-reg').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  function inject() {
    const view = $('view-stock-summary');
    if (!view || $('tk-card')) return;
    const host = view.querySelector('.p-6'); if (!host) return;
    const card = document.createElement('div');
    card.id = 'tk-card'; card.className = 'border border-slate-300 rounded-lg overflow-hidden text-xs mt-4';
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">Batches, Expiry, Serial Numbers &amp; Barcode</div>
      <div class="p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-bold">Scan / look up:</span>
          <input id="tk-code" type="text" maxlength="80" placeholder="Scan or type a barcode, serial or batch no. and press Enter" class="border border-slate-300 rounded p-1.5 bg-white w-96 font-mono">
          <button type="button" id="tk-go" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Look up</button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <select id="tk-item" class="border border-slate-300 rounded p-1 bg-white max-w-xs"></select>
          <label><input type="checkbox" id="tk-batches"> Track batches</label>
          <label><input type="checkbox" id="tk-expiry"> with expiry dates</label>
          <label><input type="checkbox" id="tk-serials"> Track serial numbers</label>
          <input id="tk-barcode" maxlength="64" placeholder="Barcode" class="border border-slate-300 rounded p-1 bg-white w-40 font-mono">
          <button type="button" id="tk-save" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Save item settings</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="tk-b-reg" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Batch register</button>
          <button type="button" id="tk-b-exp" class="px-2 py-1 bg-amber-200 hover:bg-amber-300 rounded font-bold">Expiry report</button>
          <button type="button" id="tk-b-ser" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Serial numbers</button>
          <button type="button" id="tk-b-work" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Lines to assign</button>
        </div>
        <div class="text-[10px] text-slate-500">Recording batches or serial numbers never changes stock quantities. Barcode scanners that act like a keyboard work in the box above (camera scanning is not included).</div>
        <div id="tk-msg" class="text-[11px]"></div>
        <div id="tk-out" class="space-y-1"></div>
        <div id="tk-assign"></div>
        <div id="tk-work" class="space-y-1"></div>
        <div id="tk-reg" class="space-y-1"></div>
      </div>`;
    host.appendChild(card);
    $('tk-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
    $('tk-go').addEventListener('click', lookup); $('tk-save').addEventListener('click', saveSettings);
    $('tk-item').addEventListener('change', () => { fillSettings(); showWork(); showBatches(); });
    $('tk-b-reg').addEventListener('click', showBatches); $('tk-b-exp').addEventListener('click', showExpiring); $('tk-b-ser').addEventListener('click', showSerials); $('tk-b-work').addEventListener('click', showWork);
    loadItems().then(() => { showWork(); showBatches(); }).catch((e) => msg(esc(e.message), 'text-red-700'));
  }

  function boot() {
    if (typeof window.loadStockSummary === 'function' && !window.loadStockSummary.__trackHooked) {
      const original = window.loadStockSummary;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__trackHooked = true;
      window.loadStockSummary = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

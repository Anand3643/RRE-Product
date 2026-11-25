/**
 * RRE Tally — Phase 3 additions (loaded after app.js).
 * Adds, without altering any existing screen:
 *   1. Notification centre (bell next to the existing header buttons)
 *   2. Global search results inside the existing Ctrl+K palette
 *   3. One-click CSV export + backup verification inside the existing Data (Alt+Y) menu
 * Uses the existing modal / button / table styling.
 */
(function () {
  'use strict';

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function token() {
    try {
      const s = JSON.parse(localStorage.getItem('tally_user_session') || 'null');
      const t = s && s.token;
      return t && t.startsWith('rre_') ? t : null; // offline_token_* sessions have no server identity
    } catch (e) { return null; }
  }
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');

  async function api(path, opts = {}) {
    const t = token();
    const headers = { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(`${base()}/platform${path}`, {
      ...opts,
      headers
    });
    if (res.status === 401) { const e = new Error('Authorization required.'); e.status = 401; throw e; }
    return res;
  }
  async function apiJson(path, opts) {
    const res = await api(path, opts);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j;
  }

  // ------------------------------------------------------------------ 1. Notifications
  const SEV = {
    critical: 'bg-red-100 text-red-800 border-red-300',
    warning: 'bg-amber-100 text-amber-800 border-amber-300',
    info: 'bg-blue-100 text-blue-800 border-blue-300'
  };
  const VIEW_TO_REPORT = {
    'view-stock-summary': 'stock-summary', 'view-outstandings': 'outstandings', 'view-daybook': 'daybook',
    'view-gst': 'gst', 'view-bank-recon': 'bank-recon'
  };
  let notifCache = [];

  function ensureNotificationUi() {
    if (document.getElementById('btn-notif-bell')) return;
    const anchor = document.getElementById('btn-ai-view-toggle');
    if (!anchor) return;

    const btn = document.createElement('button');
    btn.id = 'btn-notif-bell';
    btn.type = 'button';
    btn.title = 'Notification Centre';
    btn.className = 'px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 rounded text-[10px] font-bold flex items-center space-x-1 transition';
    btn.innerHTML = '<i data-lucide="bell" class="w-3 h-3 text-amber-300"></i><span>Alerts</span>' +
      '<span id="notif-badge" class="hidden px-1 rounded bg-red-600 text-white text-[9px] font-extrabold">0</span>';
    btn.addEventListener('click', openNotificationCentre);
    anchor.parentNode.insertBefore(btn, anchor);

    const modal = document.createElement('div');
    modal.id = 'notificationCenterModal';
    modal.className = 'modal-backdrop hidden';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full border border-slate-300 overflow-hidden text-xs">
        <div class="bg-[#1f3a52] text-white px-5 py-3 font-bold flex justify-between items-center">
          <div class="flex items-center space-x-2"><i data-lucide="bell" class="w-4 h-4 text-amber-300"></i><span>Notification Centre</span></div>
          <button type="button" id="notif-close" class="text-slate-300 hover:text-white">✕</button>
        </div>
        <div class="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <div class="flex items-center justify-between">
            <span class="text-slate-600" id="notif-summary">Loading…</span>
            <button type="button" id="notif-readall" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">Mark all read</button>
          </div>
          <div id="notif-list" class="space-y-2"></div>
          <p class="text-[10px] text-slate-500">Alerts are computed from your live company data and clear automatically once the condition is resolved.</p>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#notif-close').addEventListener('click', () => modal.classList.add('hidden'));
    modal.querySelector('#notif-readall').addEventListener('click', async () => {
      try { await apiJson('/notifications/read-all', { method: 'POST' }); await refreshNotifications(true); } catch (e) {}
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    if (window.lucide) window.lucide.createIcons();
  }

  function setBadge(n) {
    const b = document.getElementById('notif-badge');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
  }

  async function refreshNotifications(render) {
    try {
      const j = await apiJson('/notifications');
      notifCache = j.data;
      setBadge(j.unread);
      if (render) renderNotifications(j.unread);
    } catch (e) {
      setBadge(0);
      if (render) {
        const list = document.getElementById('notif-list');
        if (list) list.innerHTML = `<div class="p-3 text-center text-slate-500">${esc(e.message)}</div>`;
        const sm = document.getElementById('notif-summary');
        if (sm) sm.textContent = '';
      }
    }
  }

  function renderNotifications(unread) {
    const list = document.getElementById('notif-list');
    const sm = document.getElementById('notif-summary');
    if (!list) return;
    sm.textContent = `${notifCache.length} active alert(s), ${unread} unread`;
    if (!notifCache.length) {
      list.innerHTML = '<div class="p-4 text-center text-slate-500">All clear — nothing needs your attention.</div>';
      return;
    }
    list.innerHTML = notifCache.map((n) => `
      <div class="border rounded-lg p-2.5 flex items-start justify-between gap-3 ${n.is_read ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-300 shadow-sm'}">
        <div>
          <div class="flex items-center space-x-2">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase ${SEV[n.severity] || SEV.info}">${esc(n.severity)}</span>
            <span class="font-bold text-slate-900">${esc(n.title)}</span>
          </div>
          <div class="text-slate-600 mt-1">${esc(n.message)}</div>
        </div>
        <div class="flex flex-col space-y-1 shrink-0">
          ${VIEW_TO_REPORT[n.link_view] ? `<button type="button" data-open="${esc(n.link_view)}" data-id="${n.id}" class="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-bold">Open</button>` : ''}
          ${n.is_read ? '' : `<button type="button" data-read="${n.id}" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">Mark read</button>`}
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-read]').forEach((el) =>
      el.addEventListener('click', async () => {
        try { await apiJson(`/notifications/${el.dataset.read}/read`, { method: 'POST' }); await refreshNotifications(true); } catch (e) {}
      }));
    list.querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', async () => {
        try { await apiJson(`/notifications/${el.dataset.id}/read`, { method: 'POST' }); } catch (e) {}
        document.getElementById('notificationCenterModal').classList.add('hidden');
        if (typeof openReport === 'function') openReport(VIEW_TO_REPORT[el.dataset.open]);
        refreshNotifications(false);
      }));
  }

  async function openNotificationCentre() {
    ensureNotificationUi();
    document.getElementById('notificationCenterModal').classList.remove('hidden');
    document.getElementById('notif-summary').textContent = 'Loading…';
    await refreshNotifications(true);
  }

  // ------------------------------------------------------------------ 2. Global search in Ctrl+K
  let searchTimer = null;
  let searchSeq = 0;
  function hookOmniSearch() {
    if (typeof window.handleOmniSearchInput !== 'function' || window.handleOmniSearchInput.__hooked) return;
    const original = window.handleOmniSearchInput;
    const wrapped = function (e) {
      original.apply(this, arguments);
      const input = e && e.target;
      const q = input ? (input.value || '').trim() : '';
      clearTimeout(searchTimer);
      if (q.length < 2 || !token()) return;
      const my = ++searchSeq;
      searchTimer = setTimeout(async () => {
        try {
          const j = await apiJson('/search?q=' + encodeURIComponent(q));
          if (my !== searchSeq || (input.value || '').trim() !== q) return; // stale response
          const extra = [];
          j.data.vouchers.forEach((v) => extra.push({
            title: esc(`${v.voucher_type} ${v.voucher_no} · ${v.date} · ₹${Number(v.total_amount).toLocaleString('en-IN')}${v.party_name ? ' · ' + v.party_name : ''}`),
            category: 'Voucher', hotkey: 'Open', action: () => openReport('daybook')
          }));
          j.data.ledgers.forEach((l) => extra.push({
            title: esc(`${l.name}${l.gstin ? ' · ' + l.gstin : ''}`), category: l.kind,
            hotkey: 'Open', action: () => openReport(l.kind === 'Ledger' ? 'chart-accounts' : 'outstandings')
          }));
          j.data.items.forEach((i) => extra.push({
            title: esc(`${i.name}${i.hsn_code ? ' · HSN ' + i.hsn_code : ''}`), category: 'Stock Item',
            hotkey: 'Open', action: () => openReport('stock-summary')
          }));
          if (extra.length && typeof renderOmniResults === 'function') {
            renderOmniResults((window._activeOmniList || []).concat(extra));
          }
        } catch (err) { /* search is best-effort */ }
      }, 250);
    };
    wrapped.__hooked = true;
    window.handleOmniSearchInput = wrapped;
  }

  // ------------------------------------------------------------------ 3. Data menu: export + verify
  const EXPORTS = [
    ['vouchers', 'All Vouchers'], ['ledgers', 'Ledger Masters'], ['stock-items', 'Stock Items & Quantities'], ['outstandings', 'Outstandings']
  ];

  async function download(dataset) {
    const status = document.getElementById('ext-export-status');
    try {
      const res = await api(`/export/${dataset}`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Export failed (${res.status})`); }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `RRE_${dataset}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      if (status) status.textContent = `Exported ${dataset}.`;
    } catch (e) { if (status) status.textContent = e.message; }
  }

  async function verifyBackup() {
    const out = document.getElementById('ext-verify-result');
    out.innerHTML = '<span class="text-slate-500">Verifying latest snapshot…</span>';
    try {
      const j = await apiJson('/backup/verify', { method: 'POST', body: JSON.stringify({}) });
      const d = j.data;
      out.innerHTML = `<div class="font-bold ${d.ok ? 'text-emerald-700' : 'text-red-700'}">${d.ok ? '✔ Snapshot verified' : '✖ Snapshot has problems'} — ${esc(d.filename)}</div>` +
        d.checks.map((c) => `<div class="${c.ok === false ? 'text-red-700' : c.ok === null ? 'text-slate-500' : 'text-slate-700'}">${c.ok === false ? '✖' : c.ok === null ? '•' : '✔'} ${esc(c.name)} — ${esc(c.detail)}</div>`).join('');
    } catch (e) { out.innerHTML = `<span class="text-red-700">${esc(e.message)}</span>`; }
  }

  // ------------------------------------------------------------------ 3b. Scheduled reports
  async function saveBlob(path, filename) {
    const res = await api(path);
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Download failed (${res.status})`); }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function renderSchedules() {
    const box = document.getElementById('ext-sched-list');
    if (!box) return;
    try {
      const j = await apiJson('/schedules');
      box.innerHTML = j.data.length ? j.data.map((s) => `
        <div class="flex items-center justify-between bg-white border border-slate-200 rounded p-2 gap-2">
          <div>
            <span class="font-bold text-slate-900">${esc(s.name)}</span>
            <span class="text-slate-500"> · ${esc(s.dataset)} · ${esc(s.frequency)} at ${String(s.hour).padStart(2, '0')}:00 ·
              ${s.is_active ? 'next ' + esc(new Date(s.next_run_at).toLocaleString()) : 'paused'}${s.last_run_at ? ' · last ' + esc(new Date(s.last_run_at).toLocaleString()) : ''}</span>
          </div>
          <div class="space-x-1 shrink-0">
            <button type="button" data-sact="run" data-id="${s.id}" class="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-bold">Run now</button>
            <button type="button" data-sact="latest" data-id="${s.id}" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">Download latest</button>
            <button type="button" data-sact="toggle" data-id="${s.id}" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">${s.is_active ? 'Pause' : 'Resume'}</button>
            <button type="button" data-sact="delete" data-id="${s.id}" class="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-bold">Delete</button>
          </div>
        </div>`).join('') : '<div class="text-slate-500">No scheduled reports yet.</div>';
      const sel = document.getElementById('ext-sched-dataset');
      if (sel && !sel.options.length) sel.innerHTML = j.datasets.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    } catch (e) { box.innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function onSchedAction(ev) {
    const b = ev.target.closest('[data-sact]');
    if (!b) return;
    const id = b.dataset.id, st = document.getElementById('ext-sched-status');
    try {
      if (b.dataset.sact === 'run') {
        const j = await apiJson(`/schedules/${id}/run`, { method: 'POST' });
        st.textContent = j.data.status === 'ok' ? `Generated ${j.data.filename} (${j.data.rows} rows).` : `Report failed: ${j.data.message}`;
      } else if (b.dataset.sact === 'toggle') {
        await apiJson(`/schedules/${id}/toggle`, { method: 'POST' });
      } else if (b.dataset.sact === 'delete') {
        if (!confirm('Delete this schedule and its stored outputs?')) return;
        await apiJson(`/schedules/${id}`, { method: 'DELETE' });
      } else if (b.dataset.sact === 'latest') {
        const o = (await apiJson(`/schedules/${id}/outputs`)).data.find((x) => x.status === 'ok');
        if (!o) { st.textContent = 'No generated report yet. Use "Run now".'; return; }
        await saveBlob(`/outputs/${o.id}/download`, o.filename);
      }
      await renderSchedules();
    } catch (e) { st.textContent = e.message; }
  }

  async function addSchedule() {
    const st = document.getElementById('ext-sched-status');
    try {
      await apiJson('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('ext-sched-name').value,
          dataset: document.getElementById('ext-sched-dataset').value,
          frequency: document.getElementById('ext-sched-freq').value,
          hour: Number(document.getElementById('ext-sched-hour').value)
        })
      });
      document.getElementById('ext-sched-name').value = '';
      st.textContent = 'Schedule added. Reports are generated while RRE Tally is running.';
      await renderSchedules();
    } catch (e) { st.textContent = e.message; }
  }

  function injectDataMenuSection() {
    const modal = document.getElementById('dataMenuModal');
    if (!modal || document.getElementById('ext-data-tools')) return;
    const body = modal.querySelector('.p-5');
    if (!body) return;
    const sec = document.createElement('div');
    sec.id = 'ext-data-tools';
    sec.className = 'bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2';
    sec.innerHTML = `
      <div class="font-bold text-slate-800 flex items-center space-x-1.5"><i data-lucide="download" class="w-3.5 h-3.5 text-blue-600"></i><span>One-Click Export (CSV, opens in Excel)</span></div>
      <div class="flex flex-wrap gap-2">${EXPORTS.map(([k, l]) => `<button type="button" data-export="${k}" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">${esc(l)}</button>`).join('')}</div>
      <div id="ext-export-status" class="text-[10px] text-slate-500"></div>
      <div class="font-bold text-slate-800 flex items-center space-x-1.5 pt-2"><i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-600"></i><span>Backup Verification</span>
        <button type="button" id="ext-verify-btn" class="ml-2 px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold">Verify Latest Snapshot</button></div>
      <div id="ext-verify-result" class="text-[10px] space-y-0.5"></div>
      <div class="font-bold text-slate-800 flex items-center space-x-1.5 pt-2"><i data-lucide="calendar-clock" class="w-3.5 h-3.5 text-purple-600"></i><span>Scheduled Reports</span></div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="ext-sched-name" type="text" maxlength="80" placeholder="Report name" class="border border-slate-300 rounded p-1 bg-white text-[11px]">
        <select id="ext-sched-dataset" class="border border-slate-300 rounded p-1 bg-white text-[11px]"></select>
        <select id="ext-sched-freq" class="border border-slate-300 rounded p-1 bg-white text-[11px]">
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
        <select id="ext-sched-hour" class="border border-slate-300 rounded p-1 bg-white text-[11px]">
          ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 8 ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
        <button type="button" id="ext-sched-add" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold">Add schedule</button>
      </div>
      <div id="ext-sched-status" class="text-[10px] text-slate-500"></div>
      <div id="ext-sched-list" class="space-y-1 text-[10px]"></div>`;
    body.insertBefore(sec, body.firstChild.nextSibling || null);
    sec.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => download(b.dataset.export)));
    sec.querySelector('#ext-verify-btn').addEventListener('click', verifyBackup);
    sec.querySelector('#ext-sched-add').addEventListener('click', addSchedule);
    sec.querySelector('#ext-sched-list').addEventListener('click', onSchedAction);
    if (window.lucide) window.lucide.createIcons();
  }

  function hookDataMenu() {
    if (typeof window.openDataMenuModal !== 'function' || window.openDataMenuModal.__hooked) return;
    const original = window.openDataMenuModal;
    const wrapped = function () {
      const r = original.apply(this, arguments);
      injectDataMenuSection();
      renderSchedules();
      return r;
    };
    wrapped.__hooked = true;
    window.openDataMenuModal = wrapped;
  }

  // ------------------------------------------------------------------ 4. Voucher detail + printable invoice
  // The Day Book already calls viewVoucherDetail(id) on row click, but the function was never defined.
  const INVOICE_TYPES = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'];
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function printInvoice(id) {
    const st = document.getElementById('ext-vd-status');
    try {
      const res = await api(`/invoice/${id}`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Failed (${res.status})`); }
      const html = await res.text();
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(frame);
      frame.srcdoc = html;
      frame.onload = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { if (st) st.textContent = 'Could not open print dialog.'; }
        setTimeout(() => frame.remove(), 60000);
      };
    } catch (e) { if (st) st.textContent = e.message; }
  }

  // ---- attachments (documents stored with the voucher) ----
  const fileSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  async function attCall(path, opts = {}) {
    const res = await fetch(`${base()}/attachments${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    return res;
  }
  async function renderAttachments(voucherId) {
    const box = document.getElementById('ext-vd-att');
    if (!box) return;
    try {
      const res = await attCall(`/voucher/${voucherId}`); const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not load attachments');
      box.innerHTML = (j.data.length ? j.data.map((a) => `
        <div class="flex items-center justify-between border border-slate-200 rounded p-1.5">
          <span>📎 <strong>${esc(a.filename)}</strong> <span class="text-slate-500">${fileSize(a.size_bytes)} · ${esc(a.uploaded_by || '')} · ${esc(String(a.uploaded_at || '').slice(0, 10))}</span></span>
          <span class="space-x-1"><button type="button" data-dl="${a.id}" data-name="${esc(a.filename)}" class="px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold">Download</button>
            <button type="button" data-rm="${a.id}" class="px-1.5 py-0.5 bg-red-100 hover:bg-red-200 text-red-800 rounded font-bold">Remove</button></span>
        </div>`).join('') : '<div class="text-slate-500">No documents attached.</div>');
      box.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', async () => {
        const r = await attCall(`/${b.dataset.dl}/download`);
        if (!r.ok) { const e = await r.json().catch(() => ({})); return alert(e.error || 'Download failed'); }
        const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = b.dataset.name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }));
      box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Remove this attachment?')) return;
        const r = await attCall(`/${b.dataset.rm}`, { method: 'DELETE' });
        if (!r.ok) { const e = await r.json().catch(() => ({})); return alert(e.error || 'Could not remove'); }
        renderAttachments(voucherId);
      }));
    } catch (e) { box.innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }
  function uploadAttachment(voucherId, file) {
    const st = document.getElementById('ext-vd-status');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { if (st) st.textContent = 'File is larger than 5 MB.'; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = String(reader.result).split(',')[1] || '';
        const r = await attCall(`/voucher/${voucherId}`, { method: 'POST', body: JSON.stringify({ filename: file.name, content_base64: b64 }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Upload failed');
        if (st) st.textContent = 'Attached ✓';
        renderAttachments(voucherId);
      } catch (e) { if (st) st.textContent = e.message; }
    };
    reader.readAsDataURL(file);
  }

  async function viewVoucherDetailImpl(id) {
    let modal = document.getElementById('voucherDetailModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'voucherDetailModal';
      modal.className = 'modal-backdrop hidden';
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    modal.classList.remove('hidden');
    modal.innerHTML = '<div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full border border-slate-300 p-6 text-xs">Loading…</div>';
    try {
      const res = await fetch(`${base()}/vouchers/${id}`);
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'Voucher not found');
      const v = j.data;
      modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full border border-slate-300 overflow-hidden text-xs">
        <div class="bg-[#1f3a52] text-white px-5 py-3 font-bold flex justify-between items-center">
          <span>${esc(v.voucher_type)} Voucher ${esc(v.voucher_no)} &mdash; ${esc(v.date)}</span>
          <button type="button" data-close class="text-slate-300 hover:text-white">✕</button>
        </div>
        <div class="p-5 space-y-3 max-h-[75vh] overflow-y-auto">
          <div class="text-slate-600">${v.party_name ? 'Party: <strong class="text-slate-900">' + esc(v.party_name) + '</strong> · ' : ''}Amount: <strong class="text-slate-900 font-mono">₹${fmt(v.total_amount)}</strong>${v.reference_no ? ' · Ref: ' + esc(v.reference_no) : ''}</div>
          ${v.narration ? `<div class="text-slate-600">Narration: ${esc(v.narration)}</div>` : ''}
          <table class="w-full border border-slate-300"><thead class="bg-slate-800 text-white"><tr><th class="p-2 text-left">Ledger</th><th class="p-2 text-right">Debit</th><th class="p-2 text-right">Credit</th></tr></thead>
            <tbody class="divide-y divide-slate-200">${v.entries.map((e) => `<tr><td class="p-2">${esc(e.ledger_name)}</td><td class="p-2 text-right font-mono">${e.debit_amount ? fmt(e.debit_amount) : ''}</td><td class="p-2 text-right font-mono">${e.credit_amount ? fmt(e.credit_amount) : ''}</td></tr>`).join('')}</tbody></table>
          ${v.inventory && v.inventory.length ? `<table class="w-full border border-slate-300"><thead class="bg-slate-100"><tr><th class="p-2 text-left">Item</th><th class="p-2 text-right">Qty</th><th class="p-2 text-right">Rate</th><th class="p-2 text-right">Amount</th></tr></thead>
            <tbody class="divide-y divide-slate-200">${v.inventory.map((i) => `<tr><td class="p-2">${esc(i.item_name)}</td><td class="p-2 text-right font-mono">${i.quantity} ${esc(i.uom_symbol)}</td><td class="p-2 text-right font-mono">${fmt(i.rate)}</td><td class="p-2 text-right font-mono">${fmt(i.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
          <div class="border border-slate-200 rounded p-2 space-y-1">
            <div class="flex items-center justify-between"><span class="font-bold text-slate-700">Attached documents</span>
              <label class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold cursor-pointer">Attach file…<input type="file" id="ext-vd-file" class="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv,.txt"></label></div>
            <div id="ext-vd-att" class="space-y-1 text-[11px]"></div>
            <div class="text-[10px] text-slate-500">PDF, images, Excel, CSV or text, up to 5 MB. Stored inside your company data and included in backups.</div>
          </div>
          <div class="flex items-center justify-between">
            <span id="ext-vd-status" class="text-[10px] text-slate-500"></span>
            <div class="space-x-2">
              ${INVOICE_TYPES.includes(v.voucher_type) ? `<button type="button" data-print class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Print Invoice / Save as PDF</button>` : ''}
              <button type="button" data-close class="px-3 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Close</button>
            </div>
          </div>
        </div>
      </div>`;
      modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => modal.classList.add('hidden')));
      const pb = modal.querySelector('[data-print]');
      if (pb) pb.addEventListener('click', () => printInvoice(id));
      const fi = modal.querySelector('#ext-vd-file');
      if (fi) fi.addEventListener('change', () => { uploadAttachment(id, fi.files[0]); fi.value = ''; });
      renderAttachments(id);
    } catch (e) {
      modal.innerHTML = `<div class="bg-white rounded-xl shadow-2xl max-w-md w-full border border-slate-300 p-6 text-xs">${esc(e.message)}
        <div class="mt-3 text-right"><button type="button" class="px-3 py-1 bg-slate-200 rounded font-bold" onclick="document.getElementById('voucherDetailModal').classList.add('hidden')">Close</button></div></div>`;
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (typeof window.viewVoucherDetail !== 'function') window.viewVoucherDetail = viewVoucherDetailImpl;
    ensureNotificationUi();
    hookOmniSearch();
    hookDataMenu();
    refreshNotifications(false);
    setInterval(() => { if (token()) refreshNotifications(false); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

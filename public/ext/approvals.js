/**
 * RRE Tally — Approvals, added to the Data menu (Alt+Y).
 * Approvers see vouchers waiting for a decision; everyone sees their own requests; the Owner manages the rules.
 * The server enforces every permission — this panel only shows what the person is allowed to use.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  let meta = { kinds: {}, roles: [] };

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/approvals${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return j.data;
  }
  const msg = (h, cls) => { const el = $('apr-msg'); if (el) { el.className = 'text-[10px] ' + (cls || 'text-slate-500'); el.innerHTML = h; } };
  const STATUS = { pending: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', rejected: 'bg-red-100 text-red-800', approving: 'bg-blue-100 text-blue-800', cancelled: 'bg-slate-200 text-slate-600' };
  const badge = (s) => `<span class="px-1.5 py-0.5 rounded font-bold ${STATUS[s] || ''}">${esc(s)}</span>`;
  const btn = (attrs, label, cls) => `<button type="button" ${attrs} class="px-1.5 py-0.5 rounded font-bold ${cls}">${esc(label)}</button>`;

  function requestRow(r, canDecide, mineView) {
    const s = r.summary || {};
    const actions = r.status === 'pending'
      ? (mineView ? btn(`data-act="cancel" data-id="${r.id}"`, 'Cancel', 'bg-slate-200 hover:bg-slate-300')
        : (canDecide ? btn(`data-act="approve" data-id="${r.id}"`, 'Approve', 'bg-emerald-600 hover:bg-emerald-700 text-white') + ' ' + btn(`data-act="reject" data-id="${r.id}"`, 'Reject', 'bg-red-600 hover:bg-red-700 text-white') : ''))
      : '';
    return `<div class="border border-slate-200 rounded bg-white p-1.5">
      <div class="flex flex-wrap items-center gap-2"><span class="font-bold">#${r.id} ${esc(r.voucher_type)}</span>${badge(r.status)}<span class="font-mono">₹${num(s.total)}</span>
        <span class="text-slate-500">${esc(s.party || '')} ${s.voucher_no ? '· ' + esc(s.voucher_no) : ''}</span><span class="ml-auto">${actions}</span></div>
      <div class="text-[10px] text-slate-500">By ${esc(r.requested_by)} (${esc(r.requested_role || '')}) on ${esc(String(r.requested_at).slice(0, 16))} — ${esc((s.reasons || []).join('; '))}</div>
      ${r.decided_by ? `<div class="text-[10px] text-slate-500">${esc(r.status)} by ${esc(r.decided_by)}${r.decision_note ? ': ' + esc(r.decision_note) : ''}</div>` : ''}
      ${r.error ? `<div class="text-[10px] text-red-700">Last attempt failed: ${esc(r.error)}</div>` : ''}</div>`;
  }

  async function render() {
    const sec = $('ext-approvals'); if (!sec) return;
    let pending = [], canDecide = true;
    try { pending = await call('/requests?status=pending'); } catch (e) { if (e.status === 403) canDecide = false; else { msg(esc(e.message), 'text-red-700'); } }
    const mine = await call('/mine').catch(() => []);
    const rules = await call('/rules').catch(() => ({ rules: [], kinds: {}, roles: [] }));
    meta = rules;
    $('apr-pending').innerHTML = canDecide
      ? (pending.length ? pending.map((r) => requestRow(r, true, false)).join('') : '<div class="text-slate-500">Nothing is waiting for approval.</div>')
      : '<div class="text-slate-500">Only an Owner or Accountant can approve vouchers.</div>';
    const myList = mine.slice(0, 15);
    $('apr-mine').innerHTML = myList.length ? myList.map((r) => requestRow(r, false, true)).join('') : '<div class="text-slate-500">You have not sent anything for approval.</div>';
    $('apr-rules').innerHTML = rules.rules.length
      ? rules.rules.map((r) => `<div class="flex flex-wrap items-center gap-2 border border-slate-200 rounded bg-white p-1.5"><span class="font-bold">${esc(r.name)}</span><span class="text-slate-500">${esc((meta.kinds[r.kind] || {}).label || r.kind)}: ${esc(num(r.threshold))}${r.kind === 'sales_discount' ? '%' : ''}</span><span class="text-[10px] text-slate-500">exempt: ${esc(r.exempt_roles || 'none')}</span>${badge(r.is_active ? 'approved' : 'cancelled').replace(r.is_active ? 'approved' : 'cancelled', r.is_active ? 'on' : 'off')}<span class="ml-auto">${btn(`data-rule="${r.id}:${r.is_active ? 0 : 1}"`, r.is_active ? 'Switch off' : 'Switch on', 'bg-slate-200 hover:bg-slate-300')}</span></div>`).join('')
      : '<div class="text-slate-500">No rules yet. Without rules every voucher posts immediately, as before.</div>';
    $('apr-kind').innerHTML = Object.entries(meta.kinds).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    sec.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.act, parseInt(b.dataset.id, 10))));
    sec.querySelectorAll('[data-rule]').forEach((b) => b.addEventListener('click', async () => {
      const [id, on] = b.dataset.rule.split(':');
      try { await call(`/rules/${id}/active`, { method: 'POST', body: JSON.stringify({ active: on === '1' }) }); render(); } catch (e) { msg(esc(e.message), 'text-red-700'); }
    }));
  }

  async function decide(act, id) {
    try {
      if (act === 'approve') {
        if (!confirm(`Approve request #${id}? The voucher will be posted to the books exactly as it was entered.`)) return;
        const r = await call(`/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
        msg(`Approved and posted as voucher ${esc(r.voucher_no)}.`, 'text-emerald-700');
      } else if (act === 'reject') {
        const note = prompt('Reason for rejecting (the requester will see this):');
        if (note === null) return;
        await call(`/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
        msg('Rejected. Nothing was posted.', 'text-emerald-700');
      } else if (act === 'cancel') {
        if (!confirm('Withdraw this request? Nothing will be posted.')) return;
        await call(`/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
        msg('Request withdrawn.', 'text-emerald-700');
      }
      render();
    } catch (e) { msg(esc(e.message), 'text-red-700'); render(); }
  }

  async function addRule() {
    try {
      const exempt = [...document.querySelectorAll('.apr-ex:checked')].map((c) => c.value);
      await call('/rules', { method: 'POST', body: JSON.stringify({ name: $('apr-name').value, kind: $('apr-kind').value, threshold: $('apr-th').value === '' ? null : Number($('apr-th').value), exempt_roles: exempt }) });
      $('apr-name').value = ''; $('apr-th').value = '';
      msg('Rule saved.', 'text-emerald-700'); render();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  function inject() {
    const modal = $('dataMenuModal');
    if (!modal || $('ext-approvals')) return;
    const body = modal.querySelector('.p-5'); if (!body) return;
    const sec = document.createElement('div');
    sec.id = 'ext-approvals';
    sec.className = 'bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2 text-[11px]';
    sec.innerHTML = `
      <div class="font-bold text-slate-800 text-xs">Approvals</div>
      <div class="text-[10px] text-slate-500">A voucher that breaks an approval rule is held, not posted, until an Owner or Accountant other than the requester approves it.</div>
      <div class="font-bold">Waiting for approval</div><div id="apr-pending" class="space-y-1"></div>
      <div class="font-bold pt-1">My requests</div><div id="apr-mine" class="space-y-1"></div>
      <div class="font-bold pt-1">Rules</div><div id="apr-rules" class="space-y-1"></div>
      <div class="flex flex-wrap items-center gap-1 pt-1">
        <input id="apr-name" maxlength="80" placeholder="Rule name" class="border border-slate-300 rounded p-1 w-40 bg-white">
        <select id="apr-kind" class="border border-slate-300 rounded p-1 bg-white"></select>
        <input id="apr-th" type="number" min="0.01" step="0.01" placeholder="Limit (₹ or %)" class="border border-slate-300 rounded p-1 w-28 bg-white">
        <span class="text-slate-500">exempt:</span>
        ${['Owner', 'Accountant', 'Data Entry'].map((r) => `<label><input type="checkbox" class="apr-ex" value="${r}" ${r !== 'Data Entry' ? 'checked' : ''}> ${r}</label>`).join('')}
        <button type="button" id="apr-add" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Add rule</button>
      </div>
      <div id="apr-msg" class="text-[10px] text-slate-500">Only the Owner can add or switch rules.</div>`;
    body.insertBefore(sec, body.firstChild.nextSibling || null);
    $('apr-add').addEventListener('click', addRule);
    render();
  }

  function boot() {
    if (typeof window.openDataMenuModal === 'function' && !window.openDataMenuModal.__approvalsHooked) {
      const original = window.openDataMenuModal;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__approvalsHooked = true;
      window.openDataMenuModal = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

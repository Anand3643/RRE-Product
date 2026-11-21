/**
 * RRE Tally — Multiple companies: list, switch and create, from a "Companies" button beside the company name.
 * Each company has its own data. Switching signs everyone out (sessions belong to one company).
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/companies${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const msg = (html, cls) => { const el = $('co-msg'); if (el) { el.className = 'text-[11px] ' + (cls || 'text-slate-600'); el.innerHTML = html; } };

  async function render() {
    const box = $('co-list'); if (!box) return;
    try {
      const d = await call('');
      box.innerHTML = d.companies.map((c) => `
        <div class="flex items-center justify-between border ${c.active ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'} rounded p-2">
          <div><strong>${esc(c.name)}</strong> <span class="text-slate-500">· No. ${esc(c.number)}${c.created_at ? ' · created ' + esc(c.created_at.slice(0, 10)) : ''}</span>
            ${c.active ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[9px] font-bold">OPEN NOW</span>' : ''}</div>
          ${c.active ? '' : `<button type="button" data-switch="${esc(c.number)}" data-name="${esc(c.name)}" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Switch to this company</button>`}
        </div>`).join('');
      box.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => doSwitch(b.dataset.switch, b.dataset.name)));
      $('co-create-card').classList.toggle('hidden', !d.can_create);
    } catch (e) { box.innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function doSwitch(number, name) {
    if (!confirm(`Open "${name}"?\n\nEveryone using RRE Tally on this computer is signed out and must sign in to that company. Your data in the current company is not changed.`)) return;
    msg('Switching…');
    try {
      await call('/switch', { method: 'POST', body: JSON.stringify({ number }) });
      try { localStorage.removeItem('tally_user_session'); localStorage.removeItem('tally_cached_users'); } catch (e) { /* ignore */ }
      window.location.reload();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  async function create() {
    const g = (id) => $(id).value;
    msg('Creating the company…');
    try {
      const r = await call('', { method: 'POST', body: JSON.stringify({ name: g('co-name'), financial_year_from: g('co-fy') || undefined, state: g('co-state') || undefined, state_code: g('co-state-code') || undefined,
        gstin: g('co-gstin') || undefined, owner_username: g('co-user'), owner_full_name: g('co-fullname') || undefined, owner_password: g('co-pass') }) });
      ['co-name', 'co-gstin', 'co-user', 'co-fullname', 'co-pass'].forEach((id) => { $(id).value = ''; });
      msg(`Created "${esc(r.name)}" (No. ${esc(r.number)}). Use "Switch to this company" to open it, then sign in with the owner account you just set.`, 'text-emerald-700');
      render();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  function openModal() {
    let m = $('companiesModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'companiesModal'; m.className = 'modal-backdrop hidden';
      m.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full border border-slate-300 overflow-hidden text-xs">
          <div class="bg-[#1f3a52] text-white px-5 py-3 font-bold flex justify-between items-center"><span>Companies</span><button type="button" id="co-close" class="text-slate-300 hover:text-white">✕</button></div>
          <div class="p-5 space-y-3 max-h-[75vh] overflow-y-auto">
            <div class="text-slate-600">Each company keeps its own books, users, backups and settings. Only the Owner can create or switch companies.</div>
            <div id="co-list" class="space-y-1.5"></div>
            <div id="co-create-card" class="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
              <div class="font-bold text-slate-800">Create a new company</div>
              <div class="grid grid-cols-2 gap-2">
                <input id="co-name" maxlength="80" placeholder="Company name" class="border border-slate-300 rounded p-1.5 bg-white col-span-2">
                <label class="text-[10px] text-slate-500">Financial year starts<input id="co-fy" type="date" class="w-full border border-slate-300 rounded p-1.5 bg-white"></label>
                <input id="co-gstin" maxlength="15" placeholder="GSTIN (optional)" class="border border-slate-300 rounded p-1.5 bg-white font-mono self-end">
                <input id="co-state" placeholder="State (default Tamil Nadu)" class="border border-slate-300 rounded p-1.5 bg-white"><input id="co-state-code" maxlength="2" placeholder="State code (33)" class="border border-slate-300 rounded p-1.5 bg-white">
                <input id="co-user" maxlength="30" placeholder="Owner username" class="border border-slate-300 rounded p-1.5 bg-white"><input id="co-fullname" maxlength="80" placeholder="Owner full name" class="border border-slate-300 rounded p-1.5 bg-white">
                <input id="co-pass" type="password" maxlength="100" placeholder="Owner password (8+ characters)" class="border border-slate-300 rounded p-1.5 bg-white col-span-2">
              </div>
              <button type="button" id="co-create" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Create company</button>
              <div class="text-[10px] text-slate-500">The new company starts with clean books and only this owner account. Creating it does not change the company you are in.</div>
            </div>
            <div id="co-msg" class="text-[11px]"></div>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
      $('co-close').addEventListener('click', () => m.classList.add('hidden'));
      $('co-create').addEventListener('click', create);
      const fy = $('co-fy'); const y = new Date().getFullYear(); fy.value = `${new Date().getMonth() >= 3 ? y : y - 1}-04-01`;
    }
    m.classList.remove('hidden'); msg(''); render();
  }

  function inject() {
    const nameEl = $('top-company-name');
    if (!nameEl || $('btn-companies')) return;
    const b = document.createElement('button');
    b.id = 'btn-companies'; b.type = 'button';
    b.className = 'ml-2 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-500 rounded text-[10px] font-bold';
    b.title = 'Switch or create companies';
    b.textContent = '⇄ Companies';
    b.addEventListener('click', openModal);
    nameEl.insertAdjacentElement('afterend', b);
    refreshNumber();
  }

  // The top bar has a fixed "(No: 100000)"; show the real number of the company that is open
  async function refreshNumber() {
    try {
      const j = await (await fetch(`${base()}/gateway/info`)).json();
      const num = j && j.data && j.data.company && j.data.company.company_number;
      const el = $('top-company-name') && $('top-company-name').nextElementSibling;
      if (num && el && el !== $('btn-companies')) el.textContent = `(No: ${num})`;
      else if (num && el === $('btn-companies') && el.nextElementSibling) el.nextElementSibling.textContent = `(No: ${num})`;
    } catch (e) { /* cosmetic only */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();

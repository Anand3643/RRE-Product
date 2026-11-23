/**
 * RRE Tally — first-time administrator setup and forced password change.
 * No default credentials exist: on a fresh installation the person installing the application chooses the administrator
 * password here; accounts that still use an old shipped password (or a temporary one set by an administrator) must choose
 * a new one before anything else works. The server enforces both; this only provides the screens.
 */
(function () {
  'use strict';
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let open = false;

  function overlay(title, intro, fields, submitLabel, onSubmit) {
    const old = document.getElementById('acct-overlay'); if (old) old.remove();
    const o = document.createElement('div');
    o.id = 'acct-overlay';
    o.className = 'fixed inset-0 z-[80] bg-slate-900/80 flex items-center justify-center px-3';
    o.innerHTML = `<form id="acct-form" class="bg-white rounded-lg shadow-2xl w-full max-w-sm text-xs border border-slate-300" autocomplete="off">
      <div class="bg-slate-800 text-white font-bold p-3 rounded-t-lg">${esc(title)}</div>
      <div class="p-4 space-y-3">
        <div class="text-slate-600">${intro}</div>
        ${fields.map((f) => `<label class="block"><span class="font-bold text-slate-700">${esc(f.label)}</span>
          <input type="password" id="${f.id}" autocomplete="${f.auto}" class="mt-1 w-full border border-slate-300 rounded p-2 bg-white" required></label>`).join('')}
        <div class="text-[10px] text-slate-500">At least 10 characters, with letters and numbers. Avoid common words and your username.</div>
        <div id="acct-err" class="hidden p-2 bg-rose-50 border border-rose-200 text-rose-800 rounded font-semibold"></div>
        <button type="submit" class="w-full py-2.5 bg-[#1f3a52] hover:bg-[#162a3b] text-white rounded font-bold uppercase tracking-wider">${esc(submitLabel)}</button>
      </div></form>`;
    document.body.appendChild(o);
    const form = document.getElementById('acct-form');
    const err = (m) => { const e = document.getElementById('acct-err'); e.textContent = m; e.classList.remove('hidden'); };
    form.addEventListener('submit', async (ev) => { ev.preventDefault(); document.getElementById('acct-err').classList.add('hidden'); try { await onSubmit(err); } catch (e) { err(e.message); } });
    setTimeout(() => { const f = o.querySelector('input'); if (f) f.focus(); }, 50);
    return o;
  }

  async function post(path, body) {
    const res = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }

  function storeSession(d) {
    try { localStorage.setItem('tally_user_session', JSON.stringify({ user: d.user, permissions: d.permissions, token: d.token })); } catch (e) { /* ignore */ }
    if (typeof appState !== 'undefined') { appState.currentUser = d.user; appState.permissions = d.permissions; }
  }

  /** Forced change: shown right after login (or whenever the server says it is required). */
  function promptPasswordChange() {
    if (open) return; open = true;
    overlay('Choose a new password', 'For your security you must choose a new password before you continue.',
      [{ id: 'acct-cur', label: 'Current password', auto: 'current-password' }, { id: 'acct-new', label: 'New password', auto: 'new-password' }, { id: 'acct-new2', label: 'Repeat new password', auto: 'new-password' }],
      'Save new password', async (err) => {
        const cur = document.getElementById('acct-cur').value, n1 = document.getElementById('acct-new').value, n2 = document.getElementById('acct-new2').value;
        if (n1 !== n2) return err('The two new passwords are not the same.');
        const d = await post('/auth/change-password', { current_password: cur, new_password: n1 });
        storeSession(d);
        document.getElementById('acct-overlay').remove(); open = false;
        try { if (typeof window.loadMasters === 'function') window.loadMasters(); } catch (e) { /* ignore */ }
      });
  }

  /** First start on a new installation: choose the administrator password. */
  function promptSetup() {
    overlay('Welcome — set up RRE Tally', 'Choose the password for the <b>admin</b> account. There is no default password: nobody can sign in until you do this.',
      [{ id: 'acct-new', label: 'Administrator password', auto: 'new-password' }, { id: 'acct-new2', label: 'Repeat password', auto: 'new-password' }],
      'Create administrator', async (err) => {
        const n1 = document.getElementById('acct-new').value, n2 = document.getElementById('acct-new2').value;
        if (n1 !== n2) return err('The two passwords are not the same.');
        await post('/auth/setup', { password: n1 });
        document.getElementById('acct-overlay').remove();
        // sign in through the normal login screen so everything behaves exactly as a regular login
        const u = document.getElementById('login-username'), p = document.getElementById('login-password');
        if (u && p && typeof window.handleLogin === 'function') { u.value = 'admin'; p.value = n1; await window.handleLogin(); p.value = ''; }
      });
  }

  function showGuestButton(on) { const b = document.getElementById('btn-guest-login'); if (b) b.classList.toggle('hidden', !on); }

  async function refreshGuestButton() {
    try { const r = await (await fetch(`${base()}/auth/setup-status`)).json(); showGuestButton(!!(r && r.data && r.data.guest_access && !r.data.setup_required)); return r.data; } catch (e) { return null; }
  }

  /** One-click read-only entry. The server issues a guest session; nothing secret lives in this page. */
  async function continueAsGuest() {
    const errEl = document.getElementById('login-error-msg'), errText = document.getElementById('login-error-text');
    try {
      const d = await post('/auth/guest', {});
      storeSession(d);
      if (errEl) errEl.classList.add('hidden');
      const ribbon = document.getElementById('header-ribbon'); if (ribbon) ribbon.classList.remove('opacity-40');
      if (typeof updateUserDisplay === 'function') updateUserDisplay();
      if (typeof applyRolePermissions === 'function') applyRolePermissions();
      if (typeof showGateway === 'function') showGateway();
      try { if (typeof window.loadMasters === 'function') window.loadMasters(); } catch (e) { /* ignore */ }
    } catch (e) { if (errEl) errEl.classList.remove('hidden'); if (errText) errText.textContent = e.message; }
  }

  /** Owner: allow or stop one-click guest entry (shown inside Users & Passwords). */
  async function setGuestAccess(enabled) {
    try { await post('/auth/guest-access', { enabled: !!enabled }); showGuestButton(false); } catch (e) { alert(e.message); }
    const r = await refreshGuestButton(); const c = document.getElementById('chk-guest-access'); if (c && r) c.checked = !!r.guest_access;
  }

  async function syncGuestToggle() {
    const r = await refreshGuestButton(); const c = document.getElementById('chk-guest-access'); if (c && r) c.checked = !!r.guest_access;
  }

  async function boot() {
    try {
      const res = await fetch(`${base()}/auth/setup-status`);
      const j = await res.json();
      if (j && j.success && j.data && j.data.setup_required) promptSetup();
      showGuestButton(!!(j && j.data && j.data.guest_access && !j.data.setup_required));
    } catch (e) { /* server not reachable yet: the login screen reports that */ }
  }

  window.RREAccounts = { promptPasswordChange, promptSetup, continueAsGuest, setGuestAccess };
  // keep the login screen and the Owner's switch in step with the setting
  const wrapOnce = (name, after) => { const f = window[name]; if (typeof f !== 'function' || f.__acctWrapped) return; const w = function () { const r = f.apply(this, arguments); try { after(); } catch (e) { /* ignore */ } return r; }; w.__acctWrapped = true; window[name] = w; };
  window.addEventListener('load', () => { wrapOnce('startWithFreshLogin', () => setTimeout(refreshGuestButton, 50)); wrapOnce('openUserManagement', () => setTimeout(syncGuestToggle, 50)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

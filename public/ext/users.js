/**
 * RRE Entries — centralized user management (administrators only; the server refuses everyone else).
 * One list for administrators, employees and customers: create accounts, roles, module access, activate / deactivate,
 * unlock, send a password link by e-mail, see last login and sign-in activity. Passwords are never shown anywhere:
 * nobody (administrators included) can read or look up a password, and an administrator cannot choose one for another person
 * unless they hand over a one-time temporary password that the person must replace at first sign-in.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMP_ROLES = ['Accountant', 'Data Entry', 'Auditor', 'Viewer'];
  const ROLE_NOTE = { Accountant: 'Posts and edits vouchers, sees reports', 'Data Entry': 'Enters vouchers, limited reports', Auditor: 'Read-only, sees the audit trail', Viewer: 'Read-only' };
  let list = [], filter = 'all', query = '', tab = 'people', meta = { mail: true, modules: [] };

  async function api(method, path, body) {
    const res = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || 'Request failed (' + res.status + ')'); e.code = j.code; throw e; }
    return j;
  }
  const when = (s) => { if (!s) return 'Never'; const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  const day = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString([], { dateStyle: 'medium' }); };

  function css() {
    if (document.getElementById('um-css')) return;
    const s = document.createElement('style'); s.id = 'um-css';
    s.textContent = `
#um-root{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(5,9,22,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-family:Inter,"Segoe UI",system-ui,sans-serif;--u-bg:#ffffff;--u-ink:#0f1a30;--u-ink2:#51607f;--u-line:rgba(26,42,68,.12);--u-soft:#f2f5fc;--u-accent:#1a2a44}
[data-au="dark"] #um-root,[data-theme="aurora"][data-au="dark"] #um-root{--u-bg:#0f1830;--u-ink:#eef3ff;--u-ink2:#a9b6d3;--u-line:rgba(150,175,255,.18);--u-soft:rgba(150,175,255,.08);--u-accent:#f59e0b}
#um-root *{box-sizing:border-box}
#um{width:min(1120px,100%);max-height:calc(100vh - 28px);display:flex;flex-direction:column;background:var(--u-bg);color:var(--u-ink);border:1px solid var(--u-line);border-radius:20px;box-shadow:0 40px 90px -30px rgba(0,0,0,.7);overflow:hidden}
#um header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--u-line);flex-wrap:wrap}
#um header h2{margin:0;font:800 18px Manrope,Inter,system-ui,sans-serif;flex:1;min-width:160px}#um header h2 small{display:block;font:500 12px Inter,system-ui;color:var(--u-ink2);margin-top:2px}
#um .tabs{display:flex;gap:4px;padding:10px 20px 0;border-bottom:1px solid var(--u-line);flex-wrap:wrap}
#um .tabs button{border:0;background:none;color:var(--u-ink2);font:700 13px Inter,system-ui;padding:9px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
#um .tabs button.on{color:var(--u-ink);border-color:#f59e0b}
#um .bar{display:flex;gap:10px;padding:14px 20px;flex-wrap:wrap;align-items:center}
#um input,#um select{font:500 13px Inter,system-ui;padding:9px 11px;border-radius:10px;border:1px solid var(--u-line);background:var(--u-soft);color:var(--u-ink);min-width:0}
#um input:focus,#um select:focus{outline:2px solid #f59e0b;outline-offset:0}
#um .btn{font:700 12.5px Inter,system-ui;padding:9px 14px;border-radius:10px;border:1px solid var(--u-line);background:var(--u-soft);color:var(--u-ink);cursor:pointer}
#um .btn:hover{border-color:#f59e0b}#um .btn.pri{background:linear-gradient(135deg,#f59e0b,#fcd34d);color:#1a1305;border-color:transparent}#um .btn.dng{color:#e11d48}#um .btn.sm{padding:5px 9px;font-size:11.5px}
#um .chips{display:flex;gap:6px;flex-wrap:wrap}#um .chip{padding:6px 12px;border-radius:999px;border:1px solid var(--u-line);background:none;color:var(--u-ink2);font:700 12px Inter,system-ui;cursor:pointer}#um .chip.on{background:var(--u-accent);color:#fff;border-color:transparent}[data-au="dark"] #um .chip.on{color:#1a1305}
#um .body{overflow:auto;padding:0 20px 18px;flex:1}
#um table{width:100%;border-collapse:collapse;font-size:13px}#um th{position:sticky;top:0;background:var(--u-bg);text-align:left;font:700 11px Inter,system-ui;letter-spacing:.06em;text-transform:uppercase;color:var(--u-ink2);padding:9px 8px;border-bottom:1px solid var(--u-line)}
#um td{padding:11px 8px;border-bottom:1px solid var(--u-line);vertical-align:middle}#um tr:hover td{background:var(--u-soft)}
#um .nm b{display:block}#um .nm span{color:var(--u-ink2);font-size:12px}
#um .tag{display:inline-block;padding:2px 9px;border-radius:999px;font:700 11px Inter,system-ui;background:var(--u-soft);border:1px solid var(--u-line)}
#um .tag.admin{background:rgba(124,58,237,.16);color:#7c3aed}#um .tag.employee{background:rgba(59,130,246,.16);color:#2563eb}#um .tag.customer{background:rgba(16,185,129,.16);color:#059669}#um .tag.off{background:rgba(244,63,94,.14);color:#e11d48}#um .tag.on{background:rgba(16,185,129,.16);color:#059669}#um .tag.warn{background:rgba(245,158,11,.2);color:#b45309}
#um .acts{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
#um .empty{padding:40px;text-align:center;color:var(--u-ink2)}
#um .note{margin:0 20px 10px;padding:10px 14px;border-radius:12px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);font-size:12.5px}
#um .err{margin:0 20px 10px;padding:10px 14px;border-radius:12px;background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.4);color:#e11d48;font-size:13px}
#um .ok{margin:0 20px 10px;padding:10px 14px;border-radius:12px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.4);color:#059669;font-size:13px}
#um-dlg{position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(5,9,22,.55)}
#um-dlg form{width:min(520px,100%);max-height:calc(100vh - 28px);overflow:auto;background:var(--u-bg,#fff);color:var(--u-ink,#0f1a30);border:1px solid var(--u-line,#ddd);border-radius:18px;padding:20px;display:grid;gap:12px}
#um-dlg h3{margin:0;font:800 17px Manrope,Inter,system-ui}#um-dlg label{display:grid;gap:5px;font:700 12px Inter,system-ui;color:var(--u-ink2,#555)}
#um-dlg input,#um-dlg select{font:500 14px Inter,system-ui;padding:10px 11px;border-radius:10px;border:1px solid var(--u-line);background:var(--u-soft);color:var(--u-ink)}
#um-dlg .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:520px){#um-dlg .grid{grid-template-columns:1fr}}
#um-dlg .mods{display:flex;gap:8px;flex-wrap:wrap}#um-dlg .mods label{display:flex;flex-direction:row;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--u-line);border-radius:10px;font-weight:600;color:var(--u-ink)}
#um-dlg .hint{font:500 12px Inter,system-ui;color:var(--u-ink2)}#um-dlg .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
#um-dlg .sug{border:1px solid var(--u-line);border-radius:10px;max-height:140px;overflow:auto}#um-dlg .sug button{display:block;width:100%;text-align:left;border:0;background:none;color:var(--u-ink);padding:8px 10px;cursor:pointer;font:500 13px Inter,system-ui}#um-dlg .sug button:hover{background:var(--u-soft)}
@media(max-width:760px){#um th:nth-child(4),#um td:nth-child(4),#um th:nth-child(5),#um td:nth-child(5){display:none}}`;
    document.head.appendChild(s);
  }

  function root() { return document.getElementById('um-root'); }
  function close() { const r = root(); if (r) r.remove(); const d = document.getElementById('um-dlg'); if (d) d.remove(); document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); const d = document.getElementById('um-dlg'); if (d) d.remove(); else close(); } }

  async function open() {
    css(); close();
    const me = window.RRESession && window.RRESession.user();
    if (me && !(window.RRESession.isAdmin() || (window.RRESession.permissions() || {}).canManageUsers)) { alert('Only an administrator can manage users.'); return; }
    const r = document.createElement('div'); r.id = 'um-root'; r.setAttribute('role', 'dialog'); r.setAttribute('aria-modal', 'true'); r.setAttribute('aria-label', 'User management');
    r.innerHTML = '<div id="um"></div>'; document.body.appendChild(r);
    r.addEventListener('mousedown', (e) => { if (e.target === r) close(); });
    document.addEventListener('keydown', onKey, true);
    tab = 'people'; filter = 'all'; query = '';
    try { const c = await api('GET', '/auth/config'); meta.mail = !!c.data.mail_configured; meta.guest = !!c.data.guest_access; } catch (e) { /* shown below */ }
    try { meta.modules = (await api('GET', '/auth/modules')).data; } catch (e) { meta.modules = []; }
    await refresh();
  }

  async function refresh(message, kind) {
    const box = document.getElementById('um'); if (!box) return;
    try { list = (await api('GET', '/auth/users')).data; } catch (e) { box.innerHTML = `<header><h2>User management</h2><button class="btn" data-x>Close</button></header><div class="err" style="margin-top:14px">${esc(e.message)}</div>`; box.querySelector('[data-x]').onclick = close; return; }
    draw(message, kind);
  }

  function matches(u) {
    if (filter === 'admin' && u.login_type !== 'admin') return false; if (filter === 'employee' && u.login_type !== 'employee') return false; if (filter === 'customer' && u.login_type !== 'customer') return false;
    if (filter === 'inactive' && u.status === 'Active') return false;
    if (query) { const q = query.toLowerCase(); if (!(`${u.full_name} ${u.username} ${u.email} ${u.customer || ''}`.toLowerCase().includes(q))) return false; }
    return u.role !== 'Guest';
  }

  function draw(message, kind) {
    const box = document.getElementById('um'); if (!box) return;
    const people = list.filter((u) => u.role !== 'Guest'), c = (t) => people.filter((u) => u.login_type === t).length;
    box.innerHTML = `<header><h2>User management<small>${people.length} accounts · one list for administrators, employees and customers</small></h2>
        <button class="btn pri" id="um-new">+ Add user</button><button class="btn" id="um-x">Close</button></header>
      <div class="tabs"><button data-t="people" class="${tab === 'people' ? 'on' : ''}">People</button><button data-t="activity" class="${tab === 'activity' ? 'on' : ''}">Sign-in activity</button><button data-t="settings" class="${tab === 'settings' ? 'on' : ''}">Access settings</button></div>
      ${message ? `<div class="${kind === 'err' ? 'err' : 'ok'}" style="margin-top:12px" role="status">${esc(message)}</div>` : ''}
      <div id="um-main" style="display:flex;flex-direction:column;min-height:0;flex:1"></div>`;
    box.querySelector('#um-x').onclick = close; box.querySelector('#um-new').onclick = () => form(null);
    box.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => { tab = b.dataset.t; draw(); }; });
    const main = box.querySelector('#um-main');
    if (tab === 'activity') return activity(main);
    if (tab === 'settings') return settings(main);
    if (!meta.mail) main.insertAdjacentHTML('beforebegin', '<div class="note">E-mail is not set up on this computer, so password links cannot be sent. You can still create accounts with a temporary password. To set up e-mail, follow the Gmail steps in <b>.env.example</b>.</div>');
    main.innerHTML = `<div class="bar"><div class="chips">${[['all', `All (${people.length})`], ['admin', `Admins (${c('admin')})`], ['employee', `Employees (${c('employee')})`], ['customer', `Customers (${c('customer')})`], ['inactive', 'Deactivated']].map(([k, t]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
        <input id="um-q" type="search" placeholder="Search name, e-mail, customer…" value="${esc(query)}" style="flex:1;min-width:180px"></div>
      <div class="body"><table><thead><tr><th>Person</th><th>Login type / role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th></th></tr></thead><tbody id="um-rows"></tbody></table></div>`;
    main.querySelectorAll('.chip').forEach((b) => { b.onclick = () => { filter = b.dataset.f; draw(); }; });
    const q = main.querySelector('#um-q'); q.oninput = () => { query = q.value; rows(); }; rows();
    if (query) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  function rows() {
    const tb = document.getElementById('um-rows'); if (!tb) return;
    const me = window.RRESession && window.RRESession.user();
    const items = list.filter(matches);
    if (!items.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No accounts match.</td></tr>'; return; }
    tb.innerHTML = items.map((u) => {
      const self = me && me.id === u.id;
      const mods = u.login_type === 'employee' && u.modules ? ` <span class="tag warn" title="Limited to: ${esc(u.modules.join(', '))}">${u.modules.length} module${u.modules.length === 1 ? '' : 's'}</span>` : '';
      return `<tr data-id="${u.id}"><td class="nm"><b>${esc(u.full_name)}${self ? ' (you)' : ''}</b><span>${esc(u.email || u.username)}${u.customer ? ' · ' + esc(u.customer) : ''}</span></td>
        <td><span class="tag ${u.login_type}">${u.login_type === 'admin' ? 'Admin' : u.login_type === 'customer' ? 'Customer' : 'Employee'}</span> <span style="color:var(--u-ink2);font-size:12px">${esc(u.role)}</span>${mods}${u.needs_review ? ' <span class="tag warn" title="Imported: check the role">review</span>' : ''}</td>
        <td><span class="tag ${u.status === 'Active' ? 'on' : (u.status === 'Pending' || u.status === 'Invited') ? 'warn' : 'off'}">${esc(u.status === 'Pending' ? 'Awaiting e-mail confirmation' : u.status === 'Invited' ? 'Invited' : u.status)}</span>${u.locked ? ' <span class="tag off">locked</span>' : ''}${u.must_change_password || u.reset_pending ? ' <span class="tag warn">password pending</span>' : ''}</td>
        <td>${esc(when(u.last_login))}<br><span style="color:var(--u-ink2);font-size:12px">${u.login_count} sign-in${u.login_count === 1 ? '' : 's'}${u.open_sessions ? ' · ' + u.open_sessions + ' open' : ''}</span></td>
        <td>${esc(day(u.created_at))}</td>
        <td><div class="acts"><button class="btn sm" data-a="edit">Edit</button>${u.email && u.status === 'Active' ? '<button class="btn sm" data-a="reset" title="E-mail a link to choose a new password">Send reset link</button>' : ''}${u.email && u.status === 'Invited' ? '<button class="btn sm" data-a="reset" title="E-mail the invitation again">Resend invitation</button>' : ''}${u.locked ? '<button class="btn sm" data-a="unlock">Unlock</button>' : ''}${u.open_sessions ? '<button class="btn sm" data-a="signout">Sign out</button>' : ''}${self || u.status === 'Pending' || u.status === 'Invited' ? (self ? '' : '<button class="btn sm dng" data-a="toggle">Deactivate</button>') : `<button class="btn sm ${u.status === 'Active' ? 'dng' : ''}" data-a="toggle">${u.status === 'Active' ? 'Deactivate' : 'Activate'}</button>`}</div></td></tr>`;
    }).join('');
    tb.querySelectorAll('button[data-a]').forEach((b) => { b.onclick = () => act(+b.closest('tr').dataset.id, b.dataset.a); });
  }

  async function act(id, a) {
    const u = list.find((x) => x.id === id); if (!u) return;
    try {
      if (a === 'edit') return form(u);
      if (a === 'reset') { if (!meta.mail) return refresh('E-mail is not set up on this computer (see .env.example).', 'err'); const j = await api('POST', `/auth/users/${id}/send-reset`); return refresh(j.message); }
      if (a === 'unlock') { await api('POST', `/auth/users/${id}/unlock`); return refresh('Account unlocked.'); }
      if (a === 'signout') { await api('POST', `/auth/users/${id}/sign-out`); return refresh('All sessions of this person were ended.'); }
      if (a === 'toggle') {
        const off = u.status !== 'Inactive';
        if (off && !confirm(`Deactivate ${u.full_name}? They are signed out immediately and cannot sign in. Their records are kept and you can activate the account again.`)) return;
        await api('PUT', `/auth/users/${id}`, { status: off ? 'Inactive' : 'Active' }); return refresh(`${u.full_name} ${off ? 'deactivated' : 'activated'}.`);
      }
    } catch (e) { refresh(e.message, 'err'); }
  }

  // ---------------------------------------------------------------- add / edit
  function form(u) {
    const editing = !!u, d = document.createElement('div'); d.id = 'um-dlg';
    const type0 = u ? u.login_type : 'employee';
    d.innerHTML = `<form autocomplete="off"><h3>${editing ? 'Edit ' + esc(u.full_name) : 'Add a user'}</h3>
      ${editing ? '' : `<label>Login type<select id="f-type"><option value="employee">Employee</option><option value="customer">Customer</option><option value="admin">Admin</option></select></label>`}
      <div class="grid"><label>Full name<input id="f-name" required maxlength="80" value="${esc(u ? u.full_name : '')}"></label>
        <label>E-mail<input id="f-email" type="email" ${editing ? '' : 'required'} value="${esc(u ? u.email : '')}" placeholder="name@company.com"></label></div>
      <div class="grid"><label>Phone<input id="f-phone" value="${esc(u ? u.phone || '' : '')}"></label>
        <label id="f-role-w">Role<select id="f-role">${EMP_ROLES.map((r) => `<option ${u && u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label></div>
      <div class="hint" id="f-role-h"></div>
      <div id="f-cust-w" hidden><label>Customer account<input id="f-cust" placeholder="Type to search customers…" autocomplete="off" value="${esc(u && u.customer ? u.customer : '')}" ${editing ? 'disabled' : ''}></label><div class="sug" id="f-sug" hidden></div><input type="hidden" id="f-party" value="${u && u.party_id ? u.party_id : ''}"></div>
      <div id="f-mods-w" hidden><label>Modules this employee can use <span class="hint">(leave all ticked for no limit)</span></label><div class="mods">${meta.modules.map((m) => `<label><input type="checkbox" data-m="${m.key}" ${!u || !u.modules || u.modules.includes(m.key) ? 'checked' : ''}> ${esc(m.label)}</label>`).join('')}</div></div>
      ${editing ? '' : `<div id="f-pw-w"><label><span>How should they get their password?</span><select id="f-how"><option value="invite" ${meta.mail ? '' : 'disabled'}>E-mail them a link to choose it (recommended)</option><option value="temp" ${meta.mail ? '' : 'selected'}>I will give them a temporary password</option></select></label>
        <label id="f-temp-w" hidden>Temporary password<input id="f-temp" type="text" autocomplete="off" placeholder="At least 10 characters, letters and numbers"></label>
        <div class="hint">Nobody, including you, can read a password later. A temporary password must be changed at first sign-in.</div></div>`}
      <div class="err" id="f-err" hidden style="margin:0"></div>
      <div class="row"><button type="button" class="btn" id="f-cancel">Cancel</button><button class="btn pri" id="f-save">${editing ? 'Save changes' : 'Create account'}</button></div></form>`;
    document.body.appendChild(d);
    const $ = (id) => d.querySelector('#' + id);
    const typeSel = $('f-type'); if (typeSel) typeSel.value = type0;
    const sync = () => {
      const t = typeSel ? typeSel.value : type0;
      $('f-role-w').hidden = t !== 'employee'; $('f-cust-w').hidden = t !== 'customer'; $('f-mods-w').hidden = t !== 'employee';
      $('f-role-h').textContent = t === 'employee' ? ROLE_NOTE[$('f-role').value] || '' : t === 'admin' ? 'Administrators can do everything, including managing users and every module.' : 'Customers only see their own orders, invoices and profile in the customer portal.';
    };
    if (typeSel) typeSel.onchange = sync; $('f-role').onchange = sync; sync();
    const how = $('f-how'); if (how) { const s2 = () => { $('f-temp-w').hidden = how.value !== 'temp'; }; how.onchange = s2; s2(); }
    // customer search
    const cu = $('f-cust'); let timer = null;
    if (cu && !editing) cu.oninput = () => { clearTimeout(timer); $('f-party').value = ''; timer = setTimeout(async () => {
      try { const j = await api('GET', '/inv/customers?page_size=8&q=' + encodeURIComponent(cu.value.trim())); const s = $('f-sug'); const items = (j.data && j.data.items) || [];
        s.hidden = !items.length; s.innerHTML = items.map((c) => `<button type="button" data-id="${c.id}" data-n="${esc(c.name)}">${esc(c.name)}</button>`).join('');
        s.querySelectorAll('button').forEach((b) => { b.onclick = () => { $('f-party').value = b.dataset.id; cu.value = b.dataset.n; s.hidden = true; }; }); } catch (e) { /* ignore */ }
    }, 220); };
    $('f-cancel').onclick = () => d.remove();
    d.addEventListener('mousedown', (e) => { if (e.target === d) d.remove(); });
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const er = $('f-err'); er.hidden = true;
      const t = typeSel ? typeSel.value : type0;
      const body = { full_name: $('f-name').value.trim(), email: $('f-email').value.trim(), phone: $('f-phone').value.trim() };
      if (t === 'employee') { body.role = $('f-role').value; const checks = [...d.querySelectorAll('[data-m]')]; const on = checks.filter((c) => c.checked).map((c) => c.dataset.m); body.modules = on.length === checks.length ? null : on; }
      if (!editing) { body.role = t === 'admin' ? 'Owner' : t === 'customer' ? 'Customer' : body.role; if (t === 'customer') body.party_id = $('f-party').value; if (how && how.value === 'temp') body.password = $('f-temp').value; }
      try {
        const j = editing ? await api('PUT', '/auth/users/' + u.id, body) : await api('POST', '/auth/users', body);
        d.remove(); refresh(j.message || 'Saved.');
      } catch (x) { er.textContent = x.message; er.hidden = false; }
    };
    setTimeout(() => $('f-name').focus(), 40);
  }

  // ---------------------------------------------------------------- activity + settings
  async function activity(main) {
    main.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const a = (await api('GET', '/auth/login-activity?limit=80')).data;
      const lab = { AUTH_LOGIN_FAILED: 'Failed sign-in', AUTH_LOGIN_BLOCKED: 'Blocked sign-in', AUTH_LOGIN_TYPE_MISMATCH: 'Wrong login type', AUTH_PASSWORD_RESET: 'Password reset', AUTH_RESET_REQUESTED: 'Reset requested', AUTH_RESET_SENT_BY_ADMIN: 'Reset link sent by admin', AUTH_USER_CREATE: 'Account created', AUTH_USER_UPDATE: 'Account changed', AUTH_LOGOUT: 'Sign-out', AUTH_RESET_THROTTLED: 'Reset throttled', AUTH_PASSWORD_SET_BY_ADMIN: 'Temporary password set', AUTH_PASSWORD_CHANGED: 'Password changed' };
      main.innerHTML = `<div class="body" style="padding-top:14px"><h4 style="margin:0 0 8px">Recent sign-ins</h4><table><thead><tr><th>When</th><th>Who</th><th>Role</th><th>From</th></tr></thead><tbody>${a.logins.map((l) => `<tr><td>${esc(when(l.login_time))}</td><td>${esc(l.username)}</td><td>${esc(l.role)}</td><td>${esc(l.ip_address || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No sign-ins yet.</td></tr>'}</tbody></table>
        <h4 style="margin:18px 0 8px">Security events</h4><table><thead><tr><th>When</th><th>Event</th><th>Account</th><th>From</th></tr></thead><tbody>${a.events.map((l) => `<tr><td>${esc(when(l.created_at))}</td><td>${esc(lab[l.action] || l.action)}</td><td>${esc(l.username || '')}</td><td>${esc(l.ip_address || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>'}</tbody></table></div>`;
    } catch (e) { main.innerHTML = `<div class="err" style="margin-top:14px">${esc(e.message)}</div>`; }
  }
  function settings(main) {
    main.innerHTML = `<div class="body" style="padding-top:16px;display:grid;gap:14px;align-content:start">
      <div class="tag ${meta.mail ? 'on' : 'warn'}" style="justify-self:start;padding:6px 12px">E-mail for password links: ${meta.mail ? 'set up' : 'not set up'}</div>
      <p style="margin:0;color:var(--u-ink2);font-size:13px">${meta.mail ? 'Password reset and invitation e-mails are sent through the Gmail account configured in this computer\'s <b>.env</b> file.' : 'To send password links, put a Gmail address and a Google app password in the <b>.env</b> file (see <b>.env.example</b> for the steps), then restart the application.'}</p>
      <label style="display:flex;gap:10px;align-items:center;font-size:14px"><input type="checkbox" id="chk-guest-access" ${meta.guest ? 'checked' : ''}> Allow one-click read-only guest entry on this computer</label>
      <p style="margin:0;color:var(--u-ink2);font-size:12.5px">Guests cannot change anything and see no inventory, user or customer data.</p>
      <hr style="border:0;border-top:1px solid var(--u-line);width:100%">
      <div><b>Bring existing inventory accounts into this list</b><p style="margin:4px 0 10px;color:var(--u-ink2);font-size:12.5px">Matches people by identical e-mail only. Nobody becomes an administrator, passwords are not copied (they use "Forgot password"), nothing is deleted. Preview first.</p>
        <button class="btn" id="um-mig-prev">Preview</button> <button class="btn pri" id="um-mig-apply" disabled>Apply</button><div id="um-mig-out" style="margin-top:12px;font-size:13px"></div></div></div>`;
    const out = main.querySelector('#um-mig-out'), apply = main.querySelector('#um-mig-apply');
    const show = (r) => { const s = r.summary; out.innerHTML = `<b>${r.applied ? 'Done' : 'Preview'}:</b> ${s.inventory_linked} linked to existing accounts, ${s.inventory_created + s.customers_linked} ${r.applied ? 'created' : 'would be created'} (flagged for review), ${s.skipped} skipped${s.duplicate_emails ? `, <span style="color:#e11d48">${s.duplicate_emails} duplicate e-mail address(es) in RRE to fix</span>` : ''}${s.without_email ? `, ${s.without_email} account(s) without an e-mail` : ''}.${(r.inventory.skipped || []).slice(0, 6).map((x) => `<div style="color:var(--u-ink2)">• ${esc(x.email || '(no e-mail)')}: ${esc(x.reason)}</div>`).join('')}`; };
    main.querySelector('#um-mig-prev').onclick = async () => { try { const j = await api('POST', '/auth/migration', {}); show(j.data); apply.disabled = false; } catch (e) { out.textContent = e.message; } };
    apply.onclick = async () => { if (!confirm('Create the missing accounts now? Nothing is deleted.')) return; try { const j = await api('POST', '/auth/migration', { apply: true }); show(j.data); apply.disabled = true; refresh0(); } catch (e) { out.textContent = e.message; } };
    const refresh0 = () => api('GET', '/auth/users').then((j) => { list = j.data; }).catch(() => {});
    const c = main.querySelector('#chk-guest-access'); c.onchange = async () => { try { await api('POST', '/auth/guest-access', { enabled: c.checked }); meta.guest = c.checked; } catch (e) { c.checked = !c.checked; alert(e.message); } };
  }

  window.openUserManagement = open;
  window.RREUsers = { open, close };
})();

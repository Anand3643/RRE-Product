/**
 * RRE Entries — who is signed in: a name / role chip with "Sign out" in the header, and the navigation limited to what the
 * account may use (an administrator can limit an employee to chosen modules). The server enforces every limit again on each
 * request; hiding an item here is only courtesy.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null, perms = null;

  const isAdmin = () => !!me && (me.role === 'Owner' || me.role === 'Administrator');
  const allowedModule = (m) => isAdmin() || !me || !Array.isArray(me.modules) || me.modules.includes(m);

  function chip() {
    const host = document.getElementById('rre-who'); if (!host || !me) return;
    const type = me.role === 'Owner' || me.role === 'Administrator' ? 'Admin' : me.role === 'Customer' ? 'Customer' : me.role === 'Guest' ? 'Guest' : 'Employee';
    host.innerHTML = `<span class="rre-chip" title="${esc(me.email || me.username)}"><span class="rre-av">${esc((me.full_name || me.username || '?').trim().charAt(0).toUpperCase())}</span>`
      + `<span class="rre-nm"><b>${esc(me.full_name || me.username)}</b><i>${esc(type)} · ${esc(me.role)}</i></span></span>`
      + `<button type="button" class="rre-out" id="rre-signout" title="Sign out">Sign out</button>`;
    const b = document.getElementById('rre-signout'); if (b) b.onclick = () => { if (typeof window.handleLogout === 'function') window.handleLogout(); };
  }

  function limitNavigation() {
    if (!me) return;
    const canUsers = !!(perms && perms.canManageUsers);
    document.querySelectorAll('#au-rail [data-act="users"]').forEach((b) => { b.style.display = canUsers ? '' : 'none'; });
    const inv = document.querySelector('#au-rail button.item.inv'), sub = document.getElementById('au-inv-sub');
    const invOk = allowedModule('inventory') && !(me.role === 'Customer' && !me.own_company); // every person with books of their own has their own inventory
    const canCompanies = canUsers || (me.role !== 'Customer' && Array.isArray(me.extras) && me.extras.includes('companies'));
    const co = document.getElementById('btn-companies'); if (co) co.style.display = canCompanies ? '' : 'none';
    if (inv) inv.style.display = invOk ? '' : 'none'; if (sub && !invOk) sub.style.display = 'none';
    document.querySelectorAll('#au-tabbar button.inv').forEach((b) => { b.style.display = invOk ? '' : 'none'; });
    // inventory sub-list: the inventory application's own user screen is not used (users are managed in RRE)
    document.querySelectorAll('#au-inv-sub button[data-path="/team"]').forEach((b) => b.remove());
  }

  function css() {
    if (document.getElementById('rre-who-css')) return;
    const s = document.createElement('style'); s.id = 'rre-who-css';
    s.textContent = 'html.rre-customer #au-rail,html.rre-customer #au-tabbar,html.rre-customer #header-ribbon,html.rre-customer aside{display:none!important}.rre-chip{display:inline-flex;align-items:center;gap:8px;padding:2px 12px 2px 3px;border-radius:999px;background:rgba(148,163,255,.14);border:1px solid rgba(148,163,255,.35);color:inherit}'
      + '.rre-av{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#1a1305;background:linear-gradient(135deg,#f59e0b,#fcd34d)}'
      + '.rre-nm{display:flex;flex-direction:column;line-height:1.1;text-align:left;max-width:150px}.rre-nm b{font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rre-nm i{font-style:normal;font-size:9px;opacity:.75;text-transform:uppercase;letter-spacing:.06em}'
      + '.rre-out{padding:4px 12px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid rgba(244,63,94,.5);background:rgba(244,63,94,.14);color:#fda4af;cursor:pointer}.rre-out:hover{background:rgba(244,63,94,.3);color:#fff}'
      + '[data-au="light"] .rre-out{color:#be123c}[data-au="light"] .rre-chip{background:#eef1ff}'
      + '@media(max-width:640px){.rre-nm{display:none}}';
    document.head.appendChild(s);
  }

  function apply(detail) {
    me = detail.user; perms = detail.permissions; css(); chip(); limitNavigation();
    if (me.role === 'Customer' && !me.own_company) { // a customer linked to the owner's customer account: their own dashboard only (the server refuses every staff route)
      document.documentElement.classList.add('rre-customer');
      const open = () => { if (window.RREPortal) window.RREPortal.open(); else setTimeout(open, 150); }; open();
    }
  }
  window.addEventListener('rre:session', (e) => apply(e.detail));
  // the navigation rail is built a moment after the page: keep trimming it until it settles
  let n = 0; const t = setInterval(() => { limitNavigation(); if (++n > 40) clearInterval(t); }, 250);
  new MutationObserver(limitNavigation).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-au'] });
  window.RRESession = { user: () => me, permissions: () => perms, isAdmin, allowedModule };
})();

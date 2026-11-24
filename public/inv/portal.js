/**
 * RRE Tally — Customer portal. A signed-in customer browses the catalogue (selling price and availability only), sends order requests,
 * and sees their own orders and invoices. All data comes from /api/portal; the server decides who the customer is and which records
 * belong to them, so nothing in this file is a security boundary.
 */
(function () {
  'use strict';
  if (window.RREPortal) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 3) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: d });
  const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const root = () => document.getElementById('pt-app');
  const view = () => document.getElementById('pt-view');
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/portal';
  const icons = () => { try { if (window.lucide) window.lucide.createIcons(); } catch (e) { /* decoration */ } };
  const ic = (n) => `<i data-lucide="${n}" style="width:16px;height:16px"></i>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const today = () => new Date().toISOString().slice(0, 10);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  async function api(path, opts = {}) {
    const res = await fetch(base() + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.status = res.status; e.code = j.code; throw e; }
    return j.data;
  }

  // ------------------------------------------------------------------ small UI kit (same look as the Inventory workspace)
  function toast(text, kind = 'ok') {
    const box = root().querySelector('.toasts'), t = document.createElement('div');
    t.className = `card toast ${kind === 'err' ? 'err' : ''}`; t.textContent = text; box.appendChild(t); setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
  }
  function modal(title, body, o = {}) {
    if (o.drawer) root().querySelectorAll('.ov.right').forEach((x) => x.remove()); // one side panel at a time
    const ov = document.createElement('div'); ov.className = `ov ${o.drawer ? 'right' : ''}`;
    ov.innerHTML = o.drawer ? `<div class="drawer" role="dialog" aria-label="${esc(title)}">${body}</div>` : `<div class="card dlg ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row between mb"><h2 style="margin:0;font-size:15px">${esc(title)}</h2><button class="btn flat sm" data-x aria-label="Close">✕</button></div>${body}</div>`;
    const close = () => { ov.remove(); root().removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && ov === [...root().querySelectorAll('.ov')].pop()) close(); };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) close(); });
    root().addEventListener('keydown', onKey); root().appendChild(ov); icons();
    const first = ov.querySelector('input:not([type=hidden]),select,textarea'); if (first && !o.drawer) first.focus();
    return { el: ov, close };
  }
  const skel = (n = 5) => `<div class="card">${'<div class="skel"></div>'.repeat(n)}</div>`;
  const empty = (t, h, action = '') => `<div class="empty"><b>${esc(t)}</b>${h ? `<div>${esc(h)}</div>` : ''}${action ? `<div style="margin-top:10px">${action}</div>` : ''}</div>`;
  const field = (label, inner, full) => `<div class="${full ? 'full' : ''}"><label class="lbl">${esc(label)}</label>${inner}</div>`;
  const pager = (d, key) => (d.pages <= 1 ? `<div class="pager"><span>${d.total} record${d.total === 1 ? '' : 's'}</span><span></span></div>` : `<div class="pager"><span>${d.total} records · page ${d.page} of ${d.pages}</span><span class="row"><button class="btn sm" data-pg="${key}:${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-pg="${key}:${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>Next</button></span></div>`);
  const STATUS_BADGE = { draft: 'b-warn', confirmed: 'b-ok', invoiced: 'b-ok', cancelled: 'b-n' };
  const statusBadge = (o) => `<span class="badge ${STATUS_BADGE[o.status] || 'b-n'}">${esc(o.status_label)}</span>`;
  const AV = { in_stock: ['b-ok', 'In stock'], limited: ['b-warn', 'Limited stock'], out: ['b-bad', 'Out of stock'] };

  // ------------------------------------------------------------------ state
  const S = { route: 'home', q: {}, me: null, cart: new Map() }; // cart: item id -> { id, name, sku, uom, price, gst_rate, decimals, qty }
  const cartKey = () => 'pt-cart:' + ((S.me && S.me.username) || '');
  function saveCart() { store.set(cartKey(), JSON.stringify([...S.cart.values()])); updateCartBadge(); }
  function loadCart() { S.cart = new Map(); try { for (const l of JSON.parse(store.get(cartKey()) || '[]')) if (l && l.id && l.qty > 0) S.cart.set(l.id, l); } catch (e) { /* start empty */ } }
  function updateCartBadge() { const n = S.cart.size, b = root() && root().querySelector('.pt-count'); if (b) { b.textContent = n; b.hidden = !n; } }
  const TABS = [['home', 'Dashboard'], ['catalogue', 'Browse Products'], ['orders', 'My Orders'], ['packages', 'Track Packages'], ['history', 'Purchase History'], ['invoices', 'My Invoices'], ['profile', 'My Profile']];

  function build() {
    if (root()) return;
    const el = document.createElement('div'); el.id = 'pt-app';
    const rreDark = () => document.documentElement.getAttribute('data-au') === 'dark'; // RRE's own Light / Dark choice
    if (rreDark()) el.classList.add('dark');
    new MutationObserver(() => el.classList.toggle('dark', rreDark())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-au'] });
    el.innerHTML = `<div class="pt-main"><header class="pt-top"><div class="pt-brand"><span class="sp-logo">${ic('store')}</span><span>RRE Entries</span></div>
      <nav class="pt-tabs">${TABS.map(([k, t]) => `<button class="pt-tab" data-go="${k}">${t}</button>`).join('')}</nav>
      <button class="btn pt-cart-btn" id="pt-cart" aria-label="Your order request">${ic('shopping-cart')} Order request<span class="pt-count" hidden>0</span></button>
      <div class="pt-who"><b id="pt-name"></b><div id="pt-cust"></div></div>
      <button class="btn flat sm" id="pt-theme" aria-label="Light / dark">${ic('moon')}</button><button class="btn sm" id="pt-out">${ic('log-out')} Sign out</button></header>
      <div class="sp-view" id="pt-view"></div></div><div class="toasts" role="status" aria-live="polite"></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.querySelector('#pt-cart').onclick = openCart;
    el.querySelector('#pt-theme').onclick = () => { const t = document.querySelector('#au-mode [data-m]:not(.on)'); if (t) t.click(); else el.classList.toggle('dark'); };
    el.querySelector('#pt-out').onclick = signOut;
    // keystrokes here must not reach RRE's global shortcuts (Esc at RRE's gateway signs out)
    el.addEventListener('keydown', (e) => e.stopPropagation()); el.addEventListener('keyup', (e) => e.stopPropagation()); el.addEventListener('keypress', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (!root() || !root().classList.contains('open') || root().contains(e.target)) return;
      e.stopPropagation();
      if (e.key === 'Escape') { const ovs = root().querySelectorAll('.ov'); if (ovs.length) ovs[ovs.length - 1].remove(); e.preventDefault(); }
    }, true);
    el.tabIndex = -1; icons();
  }

  async function open() {
    build(); root().classList.add('open'); root().focus({ preventScroll: true });
    view().innerHTML = skel();
    try { S.me = await api('/me'); } catch (e) {
      if (e.code === 'PASSWORD_CHANGE_REQUIRED') { view().innerHTML = `<div class="sp-wrap card">${empty('Choose a new password', 'For your security, please choose a new password to continue.')}</div>`; waitForPasswordChange(); return; }
      view().innerHTML = `<div class="sp-wrap card">${empty('Cannot open the portal', e.message, '<button class="btn" id="pt-retry">Try again</button>')}</div>`; const r = view().querySelector('#pt-retry'); if (r) r.onclick = open; return;
    }
    root().querySelector('#pt-name').textContent = S.me.full_name || S.me.username; root().querySelector('#pt-cust').textContent = S.me.customer.name;
    loadCart(); updateCartBadge(); go('home');
  }
  function waitForPasswordChange() { const t = setInterval(() => { if (!document.getElementById('acct-overlay')) { clearInterval(t); open(); } }, 600); }
  function close() { const r = root(); if (r) r.remove(); S.me = null; S.q = {}; }
  function signOut() { close(); if (typeof window.handleLogout === 'function') window.handleLogout(); else if (typeof window.startWithFreshLogin === 'function') window.startWithFreshLogin(); }

  function go(route, param = null) {
    S.route = route; S.param = param;
    root().querySelectorAll('.pt-tab').forEach((b) => b.classList.toggle('on', b.dataset.go === route));
    view().innerHTML = skel(); view().scrollTop = 0;
    Promise.resolve(PAGES[route](view())).then(icons).catch((e) => {
      if (e.status === 401) return signOut();
      view().innerHTML = `<div class="card">${empty('Could not load this page', e.message, `<button class="btn" data-go="${route}">Try again</button>`)}</div>`;
    });
  }
  const reload = () => go(S.route, S.param);
  function onClick(e) {
    const g = e.target.closest('[data-go]'); if (g && !g.closest('.ov')) { go(g.dataset.go, g.dataset.param || null); return; }
    const p = e.target.closest('[data-pg]'); if (p) { const [k, n] = p.dataset.pg.split(':'); S.q[k] = { ...(S.q[k] || {}), page: parseInt(n, 10) }; reload(); }
  }
  function bindFilters(key) {
    S.q[key] = { ...(S.q[key] || {}) };
    view().querySelectorAll('[data-f]').forEach((el) => {
      const apply = () => { S.q[key] = { ...S.q[key], [el.dataset.f]: el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value, page: 1 }; reload(); };
      el.addEventListener(el.tagName === 'INPUT' && el.type === 'search' ? 'keydown' : 'change', (ev) => { if (ev.type === 'keydown' && ev.key !== 'Enter') return; apply(); });
    });
  }

  // ------------------------------------------------------------------ pages
  const PAGES = {};
  const ordersTable = (rows, empt) => (rows.length ? `<table><thead><tr><th>Order</th><th>Date</th><th>Your reference</th><th>Status</th><th class="num">Items</th><th class="num">Total</th></tr></thead><tbody>${rows.map((o) => `<tr class="click" data-order="${o.id}"><td class="mono">${esc(o.number)}</td><td class="small">${esc(o.order_date)}</td><td class="small sub">${esc(o.reference || '')}</td><td>${statusBadge(o)}</td><td class="num">${o.lines}</td><td class="num">${inr(o.total)}</td></tr>`).join('')}</tbody></table>` : empty(empt, ''));
  const invoicesTable = (rows, empt) => (rows.length ? `<table><thead><tr><th>Invoice</th><th>Date</th><th>Order</th><th>Your reference</th><th class="num">Total</th></tr></thead><tbody>${rows.map((i) => `<tr class="click" data-invoice="${i.id}"><td class="mono">${esc(i.number)}${i.type === 'Credit Note' ? ' <span class="badge b-n">Credit note</span>' : ''}</td><td class="small">${esc(i.date)}</td><td class="mono small">${esc(i.order_number || '—')}</td><td class="small sub">${esc(i.reference || '')}</td><td class="num">${inr(i.total)}</td></tr>`).join('')}</tbody></table>` : empty(empt, ''));
  const bindRows = (scope) => { scope.querySelectorAll('[data-order]').forEach((r) => r.addEventListener('click', () => orderDrawer(+r.dataset.order))); scope.querySelectorAll('[data-invoice]').forEach((r) => r.addEventListener('click', () => invoiceDrawer(+r.dataset.invoice))); };

  const PKG_BADGE = { delivered: 'b-ok', shipped: 'b-warn', dispatched: 'b-warn', out_for_delivery: 'b-warn', packed: 'b-warn', processing: 'b-n', placed: 'b-n', cancelled: 'b-bad' };
  PAGES.home = async (v) => {
    const d = await api('/dashboard');
    v.innerHTML = `<div class="sp-wrap"><div class="row between mb wrap"><div><h2 style="margin:0;font-size:20px">Welcome, ${esc(d.full_name || S.me.full_name || S.me.username)}</h2><div class="sub small">${esc(d.customer)}</div></div><button class="btn primary" data-go="catalogue">${ic('shopping-bag')} Browse products</button></div>
      <div class="grid g3 mb"><div class="card kpi"><div class="l">Total orders</div><div class="v">${d.orders.total}</div></div><div class="card kpi"><div class="l">Pending orders</div><div class="v">${d.orders.pending}</div></div><div class="card kpi"><div class="l">Completed orders</div><div class="v">${d.orders.completed}</div></div></div>
      <div class="grid g3 mb"><div class="card kpi" data-go="packages" style="cursor:pointer"><div class="l">Packages in transit</div><div class="v">${d.packages.in_transit}</div></div><div class="card kpi" data-go="packages" style="cursor:pointer"><div class="l">Delivered</div><div class="v">${d.packages.delivered}</div></div><div class="card kpi"><div class="l">Total billed</div><div class="v">${inr(d.orders.spent)}</div></div></div>
      <div class="grid g2 mb"><div class="card" style="padding:14px"><b>Your profile</b><div class="small" style="margin-top:8px;line-height:1.9"><div>Name: ${esc(d.full_name || '')}</div><div>E-mail: ${esc(d.email || '')}</div><div>Phone: ${esc(d.phone || '—')}</div><div>Customer account: ${esc(d.customer)}</div><div>Member since: ${esc(d.member_since || '')}</div></div><div style="margin-top:10px"><button class="btn flat sm" data-go="profile">Edit profile</button></div></div>
        <div class="card" style="padding:14px"><b>Notifications and updates</b>${d.notifications.length ? `<div class="small" style="margin-top:8px;display:grid;gap:8px">${d.notifications.map((n) => `<div>${ic('bell')} ${esc(n.text)} <span class="sub">${esc(n.at || '')}</span></div>`).join('')}</div>` : '<div class="sub small" style="margin-top:8px">Nothing new. Updates about your orders, packages and invoices appear here.</div>'}</div></div>
      <div class="card scroll-x"><div class="row between" style="padding:12px 14px"><b>Recent purchases</b><button class="btn flat sm" data-go="history">Full history</button></div>${historyTable(d.recent_purchases, 'No purchases yet. Pick items from the catalogue to send your first order request.')}</div></div>`;
    bindHistory(v);
  };

  // purchase history rows (orders and invoices together); a row opens its own detail drawer
  const historyTable = (rows, empt) => (rows.length ? `<table><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Status</th><th class="num">Items</th><th class="num">Total</th></tr></thead><tbody>${rows.map((r) => `<tr class="click" data-hk="${r.kind}" data-hid="${r.id}"><td><b>${esc(r.number)}</b></td><td>${esc(r.date)}</td><td>${r.kind === 'order' ? 'Order' : 'Invoice'}</td><td><span class="badge ${r.status === 'invoiced' || r.status === 'confirmed' ? 'b-ok' : r.status === 'cancelled' ? 'b-bad' : 'b-n'}">${esc(r.status_label)}</span></td><td class="num">${r.items || 0}</td><td class="num">${inr(r.total)}</td></tr>`).join('')}</tbody></table>` : empty('Nothing here', empt));
  const bindHistory = (scope) => scope.querySelectorAll('[data-hk]').forEach((r) => r.addEventListener('click', () => (r.dataset.hk === 'order' ? orderDrawer(+r.dataset.hid) : invoiceDrawer(+r.dataset.hid))));

  PAGES.history = async (v) => {
    const q = S.q.history = { ...(S.q.history || {}) };
    const d = await api(`/history?${qs({ q: q.q, from: q.from, to: q.to, status: q.status })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" type="search" data-f="q" placeholder="Order or invoice number…" value="${esc(q.q || '')}" style="max-width:240px"><input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To">
      <select class="input" data-f="status" style="width:180px"><option value="">All</option>${[['draft', 'Awaiting confirmation'], ['confirmed', 'Confirmed'], ['invoiced', 'Invoiced orders'], ['cancelled', 'Cancelled'], ['invoice', 'Invoices only']].map(([k, t]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="card scroll-x">${historyTable(d.items, 'No purchases match.')}</div><div class="sub small" style="margin-top:8px">${d.total} record${d.total === 1 ? '' : 's'}</div></div>`;
    bindFilters('history'); bindHistory(v);
  };

  const STEP_ORDER = ['placed', 'processing', 'packed', 'dispatched', 'shipped', 'out_for_delivery', 'delivered'];
  const STEP_LABEL = { placed: 'Order confirmed', processing: 'Processing', packed: 'Packed', dispatched: 'Dispatched', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered' };
  PAGES.packages = async (v) => {
    const d = await api('/packages');
    const card = (p) => {
      const at = Math.max(0, STEP_ORDER.indexOf(p.status === 'confirmed' ? 'processing' : p.status));
      const bar = p.status === 'cancelled' ? '<span class="badge b-bad">Cancelled</span>' : `<div style="display:flex;gap:4px;margin:10px 0 4px">${STEP_ORDER.map((k, i) => `<div title="${STEP_LABEL[k]}" style="flex:1;height:6px;border-radius:6px;background:${i <= at ? 'rgb(var(--brand))' : 'rgb(var(--line))'}"></div>`).join('')}</div><div class="small sub">${STEP_LABEL[STEP_ORDER[at]] || ''}</div>`;
      return `<div class="card" style="padding:14px"><div class="row between wrap"><div><b>${esc(p.number)}</b> <span class="badge ${PKG_BADGE[p.status] || 'b-n'}">${esc(p.status_label)}</span><div class="sub small">Order ${esc(p.order_number)}${p.order_date ? ' · placed ' + esc(p.order_date) : ''}</div></div>${p.total ? `<b>${inr(p.total)}</b>` : ''}</div>${bar}
        <div class="small" style="display:grid;gap:3px;margin-top:8px">${p.carrier ? `<div>Courier: <b>${esc(p.carrier)}</b></div>` : ''}${p.tracking_number ? `<div>Tracking number: <b>${esc(p.tracking_number)}</b></div>` : ''}${p.shipped_on ? `<div>Shipped: ${esc(p.shipped_on)}</div>` : ''}${p.expected_delivery ? `<div>Estimated delivery: <b>${esc(p.expected_delivery)}</b></div>` : ''}${p.delivered_on ? `<div>Delivered: ${esc(p.delivered_on)}</div>` : ''}</div>
        ${p.tracking_url ? `<div style="margin-top:8px"><a class="btn sm" href="${esc(p.tracking_url)}" target="_blank" rel="noopener noreferrer">${ic('external-link')} Open courier tracking</a></div>` : ''}
        ${p.events.length ? `<details style="margin-top:8px"><summary class="small" style="cursor:pointer">Tracking history</summary><div class="small" style="margin-top:6px;display:grid;gap:4px">${p.events.map((e) => `<div>${esc(String(e.at || '').slice(0, 16).replace('T', ' '))} — ${esc(e.status)}${e.location ? ', ' + esc(e.location) : ''}${e.note ? ' (' + esc(e.note) + ')' : ''}</div>`).join('')}</div></details>` : ''}</div>`;
    };
    v.innerHTML = `<div class="sp-wrap"><div class="grid g3 mb"><div class="card kpi"><div class="l">Pending</div><div class="v">${d.counts.pending}</div></div><div class="card kpi"><div class="l">In transit</div><div class="v">${d.counts.in_transit}</div></div><div class="card kpi"><div class="l">Delivered</div><div class="v">${d.counts.delivered}</div></div></div>
      ${d.items.length ? `<div class="grid g2">${d.items.map(card).join('')}</div>` : `<div class="card">${empty('No packages yet', 'Your orders and their delivery progress will appear here.')}</div>`}</div>`;
  };


  PAGES.catalogue = async (v) => {
    const q = S.q.catalogue = { page: 1, ...(S.q.catalogue || {}) };
    const d = await api(`/catalogue?${qs({ q: q.q, category: q.category, available: q.available, page: q.page, page_size: 24 })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" type="search" data-f="q" placeholder="Search by name, SKU or brand…" value="${esc(q.q || '')}" style="max-width:300px">
      <select class="input" data-f="category" style="width:200px"><option value="">All categories</option>${d.categories.map((c) => `<option value="${c.id}" ${String(q.category) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label class="row small" style="gap:6px"><input type="checkbox" data-f="available" ${q.available ? 'checked' : ''}> In stock only</label><span class="grow"></span><span class="sub small">Prices are per unit, before GST.</span></div>
      ${d.items.length ? `<div class="pt-cards">${d.items.map((it) => { const av = AV[it.availability], inCart = S.cart.get(it.id), can = it.orderable && it.availability !== 'out';
        return `<div class="card pt-prod"><div class="row between"><b>${esc(it.name)}</b></div><div class="sub small">${esc(it.sku)}${it.brand ? ' · ' + esc(it.brand) : ''} · ${esc(it.category)}</div>${it.description ? `<div class="small">${esc(it.description)}</div>` : ''}
          <div class="row between" style="margin-top:auto"><div>${it.price == null ? '<span class="sub">Price on request</span>' : `<div class="pt-price">${inr(it.price)}</div><div class="sub small">per ${esc(it.uom)} + ${num(it.gst_rate, 2)}% GST</div>`}</div><span class="badge ${av[0]}">${av[1]}</span></div>
          <div class="row" style="gap:6px"><input class="input" type="number" min="${it.decimals ? '0.001' : '1'}" step="${it.decimals ? 'any' : '1'}" value="${inCart ? inCart.qty : 1}" style="width:90px" data-qty="${it.id}" aria-label="Quantity" ${can ? '' : 'disabled'}><button class="btn primary grow" data-add="${it.id}" ${can ? '' : 'disabled'}>${inCart ? 'Update order request' : 'Add to order request'}</button></div></div>`; }).join('')}</div>${pager(d, 'catalogue')}` : `<div class="card">${empty('Nothing found', 'Try a different search or category.')}</div>`}</div>`;
    bindFilters('catalogue');
    const byId = new Map(d.items.map((i) => [i.id, i]));
    v.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const it = byId.get(+b.dataset.add), qty = Number(v.querySelector(`[data-qty="${it.id}"]`).value);
      if (!(qty > 0)) return toast('Enter a quantity.', 'err'); if (!it.decimals && !Number.isInteger(qty)) return toast(`${it.name} is sold in whole units.`, 'err');
      S.cart.set(it.id, { id: it.id, name: it.name, sku: it.sku, uom: it.uom, price: it.price, gst_rate: it.gst_rate, decimals: it.decimals, qty }); saveCart(); toast(`${it.name} added to your order request`); b.textContent = 'Update order request';
    }));
  };

  function openCart() {
    if (!S.cart.size) { modal('Your order request', `${empty('Your order request is empty', 'Add items from the catalogue.')}<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-x data-go-cat>Browse the catalogue</button></div>`).el.querySelector('[data-go-cat]').addEventListener('click', () => go('catalogue')); return; }
    const lines = [...S.cart.values()];
    const m = modal('Your order request', `<form id="cf"><div class="card scroll-x"><table><thead><tr><th>Item</th><th class="num">Price</th><th>Quantity</th><th class="num">Amount</th><th></th></tr></thead><tbody>${lines.map((l) => `<tr data-line="${l.id}"><td>${esc(l.name)}<div class="sub small">${esc(l.sku)}</div></td><td class="num">${inr(l.price)}</td><td><input class="input" type="number" min="${l.decimals ? '0.001' : '1'}" step="${l.decimals ? 'any' : '1'}" value="${l.qty}" style="width:90px" data-cq="${l.id}"></td><td class="num" data-amt="${l.id}">${inr(l.price * l.qty)}</td><td><button type="button" class="btn flat sm" data-rm="${l.id}" aria-label="Remove ${esc(l.name)}">✕</button></td></tr>`).join('')}</tbody></table></div>
      <div class="row between mt" style="margin:10px 2px"><span class="sub small">GST is added when the order is confirmed.</span><b id="cf-sub"></b></div>
      <div class="formgrid">${field('Your reference / PO no.', '<input class="input" name="reference" maxlength="60" placeholder="Optional">')}${field('Delivery needed by', `<input class="input" type="date" name="expected_date" min="${today()}">`)}${field('Notes for us', '<textarea class="input" name="notes" rows="2" maxlength="500" placeholder="Optional"></textarea>', true)}</div>
      <p class="hint">This sends a request to the company. It is not an invoice: they will confirm it, and you can follow it under My orders. You can cancel it until it is confirmed.</p><div class="errtxt" id="cf-err" hidden></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Keep shopping</button><button class="btn primary">Send order request</button></div></form>`, { wide: true });
    const sub = () => { m.el.querySelector('#cf-sub').textContent = 'Subtotal ' + inr([...S.cart.values()].reduce((t, l) => t + l.price * l.qty, 0)); }; sub();
    m.el.addEventListener('input', (e) => { const i = e.target.closest('[data-cq]'); if (!i) return; const l = S.cart.get(+i.dataset.cq), q = Number(i.value); if (l && q > 0) { l.qty = q; m.el.querySelector(`[data-amt="${l.id}"]`).textContent = inr(l.price * q); saveCart(); sub(); } });
    m.el.addEventListener('click', (e) => { const r = e.target.closest('[data-rm]'); if (!r) return; S.cart.delete(+r.dataset.rm); saveCart(); m.close(); openCart(); });
    m.el.querySelector('#cf').onsubmit = async (ev) => {
      ev.preventDefault(); const btn = ev.target.querySelector('.primary'); btn.classList.add('busy'); const err = m.el.querySelector('#cf-err'); err.hidden = true;
      try {
        const o = await api('/orders', { method: 'POST', body: { lines: [...S.cart.values()].map((l) => ({ item_id: l.id, qty: l.qty })), reference: ev.target.reference.value, expected_date: ev.target.expected_date.value || undefined, notes: ev.target.notes.value } });
        S.cart.clear(); saveCart(); m.close(); toast(`Order request ${o.number} sent`); go('orders'); setTimeout(() => orderDrawer(o.id), 400);
      } catch (e) { btn.classList.remove('busy'); err.hidden = false; err.textContent = e.message; }
    };
  }

  PAGES.orders = async (v) => {
    const q = S.q.orders = { page: 1, ...(S.q.orders || {}) };
    const d = await api(`/orders?${qs({ q: q.q, status: q.status, from: q.from, to: q.to, page: q.page, page_size: 20 })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" type="search" data-f="q" placeholder="Order or reference no…" value="${esc(q.q || '')}" style="max-width:260px"><select class="input" data-f="status" style="width:190px"><option value="">All statuses</option>${[['draft', 'Awaiting confirmation'], ['confirmed', 'Confirmed'], ['invoiced', 'Invoiced'], ['cancelled', 'Cancelled']].map(([k, l]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To"></div>
      <div class="card scroll-x">${ordersTable(d.items, 'No orders found.')}${d.items.length ? pager(d, 'orders') : ''}</div></div>`;
    bindFilters('orders'); bindRows(v);
  };

  PAGES.invoices = async (v) => {
    const q = S.q.invoices = { page: 1, ...(S.q.invoices || {}) };
    const d = await api(`/invoices?${qs({ q: q.q, from: q.from, to: q.to, page: q.page, page_size: 20 })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" type="search" data-f="q" placeholder="Invoice or reference no…" value="${esc(q.q || '')}" style="max-width:260px"><input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To"></div>
      <div class="card scroll-x">${invoicesTable(d.items, 'No invoices found.')}${d.items.length ? pager(d, 'invoices') : ''}</div></div>`;
    bindFilters('invoices'); bindRows(v);
  };

  // the customer's own profile (the same account they signed in with: one login for everything) and their own password
  async function authApi(method, path, body) {
    const res = await fetch('/api/auth' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
    return j;
  }
  PAGES.profile = async (v) => {
    const me = (await authApi('GET', '/me')).data.user;
    v.innerHTML = `<div class="sp-wrap"><h2 style="margin:0 0 12px;font-size:18px">My profile</h2><div class="grid g2">
      <form class="card" id="pf-form" style="padding:16px;display:grid;gap:10px"><b>Your details</b>
        <label class="lbl">Name<input class="input" id="pf-name" value="${esc(me.full_name || '')}" maxlength="80" required></label>
        <label class="lbl">Phone<input class="input" id="pf-phone" value="${esc(me.phone || '')}" maxlength="30"></label>
        <label class="lbl">E-mail (your sign-in)<input class="input" value="${esc(me.email || me.username)}" disabled></label>
        <label class="lbl">Customer account<input class="input" value="${esc(me.customer ? me.customer.name : '')}" disabled></label>
        <div class="sub small">Signed up ${esc(String(me.created_at || '').slice(0, 10))}. To change your e-mail address, ask the business.</div>
        <div><button class="btn primary" type="submit">Save</button></div></form>
      <form class="card" id="pw-form" style="padding:16px;display:grid;gap:10px"><b>Change your password</b>
        <label class="lbl">Current password<input class="input" id="pw-cur" type="password" autocomplete="current-password" required></label>
        <label class="lbl">New password<input class="input" id="pw-new" type="password" autocomplete="new-password" required></label>
        <div class="sub small">At least 10 characters, with letters and numbers.</div>
        <div><button class="btn primary" type="submit">Change password</button></div></form></div></div>`;
    v.querySelector('#pf-form').onsubmit = async (e) => { e.preventDefault(); try { await authApi('PUT', '/me', { full_name: v.querySelector('#pf-name').value, phone: v.querySelector('#pf-phone').value }); S.me.full_name = v.querySelector('#pf-name').value; root().querySelector('#pt-name').textContent = S.me.full_name; toast('Profile saved.'); } catch (x) { toast(x.message, 'err'); } };
    v.querySelector('#pw-form').onsubmit = async (e) => { e.preventDefault(); try {
      const j = await authApi('POST', '/change-password', { current_password: v.querySelector('#pw-cur').value, new_password: v.querySelector('#pw-new').value });
      try { const old = JSON.parse(localStorage.getItem('tally_user_session') || '{}'); localStorage.setItem('tally_user_session', JSON.stringify({ ...old, user: j.data.user, permissions: j.data.permissions, token: j.data.token })); } catch (x) { /* ignore */ }
      v.querySelector('#pw-cur').value = ''; v.querySelector('#pw-new').value = ''; toast('Password changed.'); } catch (x) { toast(x.message, 'err'); } };
  };

  async function orderDrawer(id) {
    const m = modal('Order', `<div class="skel"></div><div class="skel"></div>`, { drawer: true });
    try {
      const o = await api(`/orders/${id}`);
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><b style="font-size:16px">${esc(o.number)}</b> ${statusBadge(o)}</div><button class="btn flat sm" data-x aria-label="Close">✕</button></div>
        <div class="sub small mb">Placed ${esc(o.order_date)}${o.expected_date ? ' · needed by ' + esc(o.expected_date) : ''}${o.reference ? ' · your reference ' + esc(o.reference) : ''}</div>
        <div class="card scroll-x"><table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th></tr></thead><tbody>${o.lines.map((l) => `<tr><td>${esc(l.item)}<div class="sub small">${esc(l.sku)}</div></td><td class="num">${num(l.qty)} ${esc(l.uom)}</td><td class="num">${inr(l.rate)}</td><td class="num">${num(l.gst_rate, 2)}%</td><td class="num">${inr(l.amount)}</td></tr>`).join('')}</tbody></table></div>
        <div style="margin:12px 2px;text-align:right" class="small"><div>Taxable value ${inr(o.totals.taxable)}</div><div>GST ${inr(o.totals.tax)}</div>${o.totals.round_off ? `<div>Round off ${inr(o.totals.round_off)}</div>` : ''}<div style="font-size:16px;margin-top:4px"><b>Total ${inr(o.totals.total)}</b></div></div>
        ${o.notes ? `<div class="card" style="padding:10px 12px;margin-bottom:10px"><div class="sub small">Your notes</div>${esc(o.notes)}</div>` : ''}${o.cancelled_reason ? `<div class="hint">${esc(o.cancelled_reason)}</div>` : ''}
        ${o.invoices.length ? `<div class="mb"><b class="small">Invoices</b>${o.invoices.map((i) => `<div class="row between small" style="padding:6px 0;border-bottom:1px solid rgb(var(--line))"><a href="#" data-inv="${i.id}">${esc(i.number)}</a><span>${esc(i.date)} · ${inr(i.total)}</span></div>`).join('')}</div>` : ''}
        ${o.status === 'draft' ? `<p class="hint">Waiting for the company to confirm. You can cancel until then.</p><button class="btn danger" id="pt-cancel">Cancel this order</button>` : o.status === 'confirmed' ? '<p class="hint">Confirmed. To change this order, please contact the company.</p>' : ''}`;
      m.el.querySelectorAll('[data-inv]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); m.close(); invoiceDrawer(+a.dataset.inv); }));
      const c = m.el.querySelector('#pt-cancel');
      if (c) c.onclick = () => { const mm = modal('Cancel order', `<form id="xf"><label class="lbl">Reason (optional)</label><input class="input" name="reason" maxlength="150"><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Keep order</button><button class="btn danger">Cancel order</button></div></form>`);
        mm.el.querySelector('#xf').onsubmit = async (ev) => { ev.preventDefault(); try { await api(`/orders/${id}/cancel`, { method: 'POST', body: { reason: ev.target.reason.value } }); mm.close(); m.close(); toast('Order cancelled'); reload(); } catch (e) { toast(e.message, 'err'); } }; };
    } catch (e) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load the order', e.message)}`; }
  }

  async function invoiceDrawer(id) {
    const m = modal('Invoice', `<div class="skel"></div><div class="skel"></div>`, { drawer: true });
    try {
      const i = await api(`/invoices/${id}`);
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><b style="font-size:16px">${esc(i.number)}</b> ${i.type === 'Credit Note' ? '<span class="badge b-n">Credit note</span>' : ''}</div><button class="btn flat sm" data-x aria-label="Close">✕</button></div>
        <div class="sub small mb">${esc(i.date)}${i.order ? ' · order ' + esc(i.order.number) : ''}${i.reference ? ' · your reference ' + esc(i.reference) : ''}</div>
        <div class="card scroll-x">${i.items.length ? `<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${i.items.map((l) => `<tr><td>${esc(l.item)}<div class="sub small">${esc(l.sku)}</div></td><td class="num">${num(l.qty)} ${esc(l.uom)}</td><td class="num">${inr(l.rate)}</td><td class="num">${inr(l.amount)}</td></tr>`).join('')}</tbody></table>` : empty('No item lines', 'This document has no item details.')}</div>
        <div style="margin:12px 2px;text-align:right" class="small">${i.items.length ? `<div>Taxable value ${inr(i.taxable)}</div><div>GST and rounding ${inr(i.tax_and_rounding)}</div>` : ''}<div style="font-size:16px;margin-top:4px"><b>Total ${inr(i.total)}</b></div></div>
        <button class="btn" onclick="window.print()">${ic('printer')} Print</button>`; icons();
    } catch (e) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load the invoice', e.message)}`; }
  }

  window.RREPortal = { open, close, go, _state: S };
})();

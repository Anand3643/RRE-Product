/**
 * RRE Tally — Inventory workspace (StockPilot features and look, running on RRE's own data).
 * Opens as a full-screen workspace from the Gateway menu; the rest of RRE is not touched. All data comes from /api/inv and every
 * permission is enforced by the server — hiding a button here is a convenience, not security.
 */
(function () {
  'use strict';
  if (window.StockPilotInv) return;

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 3) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: d });
  const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const root = () => document.getElementById('sp-app');
  const view = () => document.getElementById('sp-view');
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/inv';
  const perms = () => (typeof appState !== 'undefined' && appState.permissions) || {};
  const can = { write: () => !!perms().canCreateVouchers, move: () => !!perms().canEditVouchers, remove: () => !!perms().canDeleteVouchers, value: () => !!perms().canViewFinancials };
  const icons = () => { try { if (window.lucide) window.lucide.createIcons(); } catch (e) { /* icons are decoration */ } };
  const ic = (n, cls = '') => `<i data-lucide="${n}" class="${cls}" style="width:16px;height:16px"></i>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const today = () => new Date().toISOString().slice(0, 10);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

  async function api(path, opts = {}) {
    const res = await fetch(base() + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return j.data;
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  function toast(text, kind = 'ok') {
    const box = root().querySelector('.toasts'); const t = document.createElement('div');
    t.className = `card toast ${kind === 'err' ? 'err' : ''}`; t.textContent = text; box.appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
  }

  function modal(title, body, o = {}) {
    const ov = document.createElement('div'); ov.className = `ov ${o.drawer ? 'right' : ''}`;
    ov.innerHTML = o.drawer ? `<div class="drawer" role="dialog" aria-label="${esc(title)}">${body}</div>`
      : `<div class="card dlg ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row between mb"><h2 style="margin:0;font-size:15px">${esc(title)}</h2><button class="btn flat sm" data-x aria-label="Close">✕</button></div>${body}</div>`;
    const close = () => { ov.remove(); root().removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && ov === [...root().querySelectorAll('.ov')].pop()) close(); };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) close(); });
    root().addEventListener('keydown', onKey);
    root().appendChild(ov); icons();
    const first = ov.querySelector('input:not([type=hidden]),select,textarea'); if (first && !o.drawer) first.focus();
    return { el: ov, close };
  }

  async function confirmBox(title, text, action, fn) {
    const m = modal(title, `<p class="sub" style="margin:0 0 16px">${esc(text)}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancel</button><button class="btn danger" id="sp-go">${esc(action)}</button></div>`);
    m.el.querySelector('#sp-go').onclick = async (e) => { e.target.classList.add('busy'); try { await fn(); m.close(); } catch (err) { e.target.classList.remove('busy'); toast(err.message, 'err'); } };
  }

  const skel = (n = 6) => `<div class="card">${'<div class="skel"></div>'.repeat(n)}</div>`;
  const empty = (t, h, action = '') => `<div class="empty"><b>${esc(t)}</b>${h ? `<div>${esc(h)}</div>` : ''}${action ? `<div style="margin-top:10px">${action}</div>` : ''}</div>`;
  const badge = (s) => ({ ok: '<span class="badge b-ok">In stock</span>', low: '<span class="badge b-warn">Low</span>', out: '<span class="badge b-bad">Out</span>' }[s] || '');
  const status = (active) => (active ? '<span class="badge b-ok">Active</span>' : '<span class="badge b-n">Archived</span>');
  const pager = (d, key) => d.pages <= 1 && d.total <= d.page_size ? `<div class="pager"><span>${d.total} record${d.total === 1 ? '' : 's'}</span><span></span></div>`
    : `<div class="pager"><span>${d.total} records · page ${d.page} of ${d.pages}</span><span class="row"><button class="btn sm" data-pg="${key}:${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-pg="${key}:${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>Next</button></span></div>`;
  const field = (label, inner, full, hint) => `<div class="${full ? 'full' : ''}"><label class="lbl">${esc(label)}</label>${inner}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  const opts = (list, val, sel, ph) => (ph != null ? `<option value="">${esc(ph)}</option>` : '') + list.map((x) => `<option value="${esc(val(x))}" ${String(val(x)) === String(sel) ? 'selected' : ''}>${esc(sel === undefined && false ? '' : x.__label || x.name || x.symbol)}</option>`).join('');

  // ------------------------------------------------------------------ state, shell, router
  const S = { route: 'dashboard', param: null, q: {}, cats: [], units: [], whs: [] };
  const NAV = [
    ['', [['dashboard', 'Dashboard', 'layout-dashboard'], ['alerts', 'Low stock alerts', 'bell-ring']]],
    ['Sales', [['customers', 'Customers', 'contact'], ['sales-orders', 'Sales orders', 'shopping-cart'], ['sales-history', 'Sales history', 'receipt'], ['portal-users', 'Customer portal logins', 'key-round']]],
    ['Purchases', [['suppliers', 'Suppliers', 'store'], ['purchase-orders', 'Purchase orders', 'clipboard-list'], ['purchase-history', 'Purchase history', 'history']]],
    ['Items', [['items', 'Items', 'package'], ['categories', 'Categories', 'folder-tree'], ['units', 'Units', 'ruler']]],
    ['Inventory', [['stock', 'Stock levels', 'boxes'], ['movements', 'Movement history', 'arrow-left-right'], ['warehouses', 'Warehouses', 'warehouse'], ['transfers', 'Transfers', 'arrow-right-left'], ['adjustments', 'Adjustments', 'sliders-horizontal']]],
    ['Reports', [['reports', 'Reports', 'bar-chart-3']]],
    ['Tools', [['import', 'Import from StockPilot', 'database-backup']]]
  ];
  const TITLES = {}; NAV.forEach(([, l]) => l.forEach(([k, t]) => { TITLES[k] = t; }));

  function build() {
    if (root()) return;
    const el = document.createElement('div'); el.id = 'sp-app';
    if (store.get('sp-theme') === 'dark') el.classList.add('dark');
    el.innerHTML = `<aside class="sp-side"><div class="sp-brand"><span class="sp-logo">${ic('boxes')}</span><span class="sp-lbl">Inventory</span></div>
      <nav>${NAV.map(([g, links]) => `${g ? `<div class="sp-grp">${g}</div>` : ''}${links.map(([k, t, i]) => `<button class="sp-nav" data-go="${k}" title="${t}"><span class="sp-ic">${ic(i)}</span><span class="sp-lbl">${t}</span></button>`).join('')}`).join('')}</nav>
      <div style="padding:8px;border-top:1px solid rgb(var(--line))"><button class="sp-nav" id="sp-collapse"><span class="sp-ic">${ic('chevrons-left')}</span><span class="sp-lbl">Collapse</span></button></div></aside>
      <div class="sp-main"><header class="sp-top"><button class="btn sm" id="sp-back" data-tip="Back to RRE Tally">${ic('arrow-left')} RRE Tally</button><h1 id="sp-title"></h1>
        <input class="input" id="sp-quick" placeholder="Search items…  ( / )" style="width:220px" aria-label="Search items"><button class="btn flat sm" id="sp-theme" data-tip="Light / dark">${ic('moon')}</button></header>
        <div class="sp-view" id="sp-view"></div></div><div class="toasts" role="status" aria-live="polite"></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.querySelector('#sp-back').onclick = close;
    el.querySelector('#sp-collapse').onclick = () => el.classList.toggle('collapsed');
    el.querySelector('#sp-theme').onclick = () => { el.classList.toggle('dark'); store.set('sp-theme', el.classList.contains('dark') ? 'dark' : 'light'); };
    el.querySelector('#sp-quick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.q.items = { ...(S.q.items || {}), q: e.target.value, page: 1 }; go('items'); } });
    // Keystrokes inside the workspace stay inside it: RRE's own global shortcuts (Esc leaves the screen, letters open menus) must not react.
    el.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); el.querySelector('#sp-quick').focus(); } e.stopPropagation(); });
    el.addEventListener('keyup', (e) => e.stopPropagation()); el.addEventListener('keypress', (e) => e.stopPropagation());
    // If focus has slipped to the page behind (nothing inside the workspace is focused), the key must still not reach RRE:
    // Esc at RRE's gateway signs the user out. A capture-phase guard handles that case; Esc also closes the top dialog.
    window.addEventListener('keydown', (e) => {
      if (!root() || !root().classList.contains('open') || root().contains(e.target)) return;
      e.stopPropagation();
      if (e.key === 'Escape') { const ovs = root().querySelectorAll('.ov'); if (ovs.length) ovs[ovs.length - 1].remove(); e.preventDefault(); }
    }, true);
    el.tabIndex = -1; // clicks on plain areas keep keyboard focus inside the workspace
    // Esc with nothing open closes nothing and must not fall through to RRE; a click outside any dialog does nothing either.
    icons();
  }

  function open(route = 'dashboard', param = null) { build(); root().classList.add('open'); root().focus({ preventScroll: true }); go(route, param); }
  function close() { if (root()) root().classList.remove('open'); }
  function go(route, param = null) {
    if (!PAGES[route]) route = 'dashboard';
    if (route === 'import' && !perms().canAlterCompany) route = 'dashboard';
    if (route === 'portal-users' && !perms().canManageUsers) route = 'dashboard';
    S.route = route; S.param = param;
    { const imp = root().querySelector('.sp-nav[data-go="import"]'); if (imp) { const show = !!perms().canAlterCompany; imp.hidden = !show; if (imp.previousElementSibling) imp.previousElementSibling.hidden = !show; } }
    { const pu = root().querySelector('.sp-nav[data-go="portal-users"]'); if (pu) pu.hidden = !perms().canManageUsers; }
    root().querySelectorAll('.sp-nav[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === (route === 'warehouse' ? 'warehouses' : route === 'report' ? 'reports' : route)));
    root().querySelector('#sp-title').textContent = route === 'warehouse' ? 'Warehouse' : route === 'report' ? 'Report' : TITLES[route] || '';
    view().innerHTML = skel(); view().scrollTop = 0;
    Promise.resolve(PAGES[route](view())).then(icons).catch((e) => { view().innerHTML = `<div class="card">${empty('Could not load this page', e.message, '<button class="btn" data-go="' + route + '">Try again</button>')}</div>`; });
  }
  const reload = () => go(S.route, S.param);

  function onClick(e) {
    const g = e.target.closest('[data-go]'); if (g && !g.closest('.ov')) { go(g.dataset.go, g.dataset.param || null); return; }
    const p = e.target.closest('[data-pg]'); if (p) { const [k, n] = p.dataset.pg.split(':'); S.q[k] = { ...(S.q[k] || {}), page: parseInt(n, 10) }; reload(); return; }
    const t = e.target.closest('[data-tab]'); if (t) { S.q.tab = t.dataset.tab; reload(); }
  }
  async function lookups() {
    const [cats, units, whs] = await Promise.all([api('/categories'), api('/units'), api('/warehouses')]);
    S.cats = cats; S.units = units; S.whs = whs; return { cats, units, whs };
  }
  const activeWhs = () => S.whs.filter((w) => w.is_active);

  // generic filter bar binding: inputs carry data-f="name"; changing any of them re-queries
  function bindFilters(key, defaults = {}) {
    const q = (S.q[key] = { ...defaults, ...(S.q[key] || {}) });
    view().querySelectorAll('[data-f]').forEach((el) => {
      const apply = () => { S.q[key] = { ...S.q[key], [el.dataset.f]: el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value, page: 1 }; reload(); };
      el.addEventListener(el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'date' ? 'keydown' : 'change', (ev) => { if (ev.type === 'keydown' && ev.key !== 'Enter') return; apply(); });
    });
    return q;
  }

  // ------------------------------------------------------------------ item picker (type to search; resolves to an id)
  function picker(id, ph = 'Type a name or SKU…') { return `<input class="input" list="${id}-dl" data-picker="${id}" placeholder="${esc(ph)}" autocomplete="off"><datalist id="${id}-dl"></datalist>`; }
  function bindPickers(scope, extra = '') {
    const map = new Map();
    const fill = debounce(async (inp) => {
      try {
        const d = await api(`/items?${qs({ q: inp.value, page_size: 15 })}`);
        const dl = scope.querySelector(`#${inp.dataset.picker}-dl`); dl.innerHTML = '';
        for (const it of d.items) { const label = `${it.name} · ${it.sku}`; map.set(label, it); const o = document.createElement('option'); o.value = label; dl.appendChild(o); }
      } catch (e) { /* the list simply stays as it was */ }
    }, 200);
    scope.addEventListener('input', (e) => { if (e.target.matches('[data-picker]')) fill(e.target); });
    return (inp) => map.get(inp.value.trim());
  }

  // ------------------------------------------------------------------ pages
  const PAGES = {};

  PAGES.dashboard = async (v) => {
    const d = await api('/dashboard'), k = d.kpis, tile = (l, val, sub, tone = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v" ${tone ? `style="color:${tone}"` : ''}>${val}</div><div class="small sub">${sub || ''}</div></div>`;
    const maxS = Math.max(1, ...d.series.map((s) => Math.max(s.qin, s.qout))), W = 560, H = 150, bw = d.series.length ? Math.max(4, Math.min(22, (W - 20) / d.series.length - 4)) : 10;
    const bars = d.series.map((s, i) => { const x = 10 + i * ((W - 20) / Math.max(1, d.series.length)); const hi = (s.qin / maxS) * (H - 24), ho = (s.qout / maxS) * (H - 24);
      return `<g><title>${esc(s.d)}: in ${num(s.qin)}, out ${num(s.qout)}</title><rect x="${x}" y="${H - 14 - hi}" width="${bw / 2}" height="${hi}" rx="2" fill="rgb(var(--brand))"/><rect x="${x + bw / 2}" y="${H - 14 - ho}" width="${bw / 2}" height="${ho}" rx="2" fill="#f59e0b"/></g>`; }).join('');
    const maxW = Math.max(1, ...d.warehouses.map((w) => w.units));
    v.innerHTML = `<div class="sp-wrap"><div class="grid g5 mb">${tile('Items', num(k.items), 'active items')}${can.value() && k.stock_value !== undefined ? tile('Stock value', inr(k.stock_value), 'at average cost') : tile('Units in stock', num(k.units), 'all warehouses')}
      ${tile('Low stock', k.low, 'at or below reorder level', k.low ? '#d97706' : '')}${tile('Out of stock', k.out, 'with a reorder level', k.out ? '#dc2626' : '')}${tile('Warehouses', k.warehouses, 'active')}</div>
      <div class="grid g2 mb"><div class="card p"><h2>Stock movement — last 30 days</h2>${d.series.length ? `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Stock in and out per day">${bars}<line x1="8" x2="${W - 8}" y1="${H - 14}" y2="${H - 14}" stroke="rgb(var(--line))"/><text x="10" y="${H - 2}">${esc(d.series[0].d)}</text><text x="${W - 10}" y="${H - 2}" text-anchor="end">${esc(d.series[d.series.length - 1].d)}</text></svg><div class="small sub row"><span style="width:10px;height:10px;background:rgb(var(--brand));border-radius:2px"></span> In <span style="width:10px;height:10px;background:#f59e0b;border-radius:2px;margin-left:10px"></span> Out</div>` : empty('No movements yet', 'Stock in and out will appear here.')}</div>
      <div class="card p"><h2>Stock by warehouse</h2>${d.warehouses.length ? d.warehouses.map((w) => `<div style="margin:8px 0"><div class="row between small"><a href="#" data-go="warehouse" data-param="${w.id}" onclick="return false">${esc(w.name)}</a><span class="sub">${num(w.units)} units · ${w.items} items${w.low ? ` · <span class="badge b-warn">${w.low} low</span>` : ''}</span></div><div class="bar"><i style="width:${Math.round((w.units / maxW) * 100)}%"></i></div></div>`).join('') : empty('No warehouses')}</div></div>
      <div class="grid g2"><div class="card"><div class="p row between" style="padding-bottom:0"><h2>Needs attention</h2><button class="btn sm flat" data-go="alerts">View all</button></div>
        ${d.low_stock.length ? `<table><thead><tr><th>Item</th><th class="num">Available</th><th class="num">Reorder</th><th>Status</th></tr></thead><tbody>${d.low_stock.map((a) => `<tr><td>${esc(a.name)}<div class="small sub mono">${esc(a.sku)}</div></td><td class="num">${num(a.available)} ${esc(a.uom)}</td><td class="num">${num(a.reorder_level)}</td><td>${badge(a.status)}</td></tr>`).join('')}</tbody></table>` : empty('Nothing is running low', 'Items at or below their reorder level appear here.')}</div>
        <div class="card"><div class="p row between" style="padding-bottom:0"><h2>Recent movements</h2><button class="btn sm flat" data-go="movements">View all</button></div>
        ${d.recent.length ? `<table><thead><tr><th>Date</th><th>Item</th><th>Document</th><th class="num">Qty</th></tr></thead><tbody>${d.recent.map((m) => `<tr><td class="small">${esc(m.date)}</td><td>${esc(m.item)}</td><td class="small"><span class="badge b-n">${esc(m.type)}</span> ${esc(m.number)}</td><td class="num" style="color:${m.direction === 'IN' ? '#059669' : '#d97706'}">${m.direction === 'IN' ? '+' : '−'}${num(m.quantity)}</td></tr>`).join('')}</tbody></table>` : empty('No movements yet')}</div></div></div>`;
  };

  PAGES.alerts = async (v) => {
    const d = await api('/alerts');
    v.innerHTML = `<div class="sp-wrap"><div class="row mb"><span class="badge b-bad">${d.out} out of stock</span><span class="badge b-warn">${d.low} low</span></div><div class="card scroll-x">
      ${d.items.length ? `<table><thead><tr><th>Item</th><th>Category</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">Reorder level</th><th class="num">Shortfall</th><th>Status</th><th></th></tr></thead><tbody>
      ${d.items.map((a) => `<tr><td>${esc(a.name)}<div class="small sub mono">${esc(a.sku)}</div></td><td>${esc(a.category)}</td><td class="num">${num(a.on_hand)} ${esc(a.uom)}</td><td class="num">${num(a.reserved)}</td><td class="num">${num(a.available)}</td><td class="num">${num(a.reorder_level)}</td><td class="num">${num(a.shortfall)}</td><td>${badge(a.status)}</td>
      <td class="num">${can.move() ? `<button class="btn sm" data-adj="${a.id}">Adjust</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('Everything is stocked', 'No item is at or below its reorder level.')}</div></div>`;
    v.querySelectorAll('[data-adj]').forEach((b) => { b.onclick = async () => { await lookups(); adjustmentForm(parseInt(b.dataset.adj, 10)); }; });
  };

  // ---- items
  PAGES.items = async (v) => {
    const { cats, whs } = await lookups();
    const q = S.q.items = { page: 1, ...(S.q.items || {}) };
    const d = await api(`/items?${qs({ q: q.q, category: q.category, status: q.status, warehouse: q.warehouse, archived: q.archived, page: q.page, page_size: 25, sort: q.sort })}`);
    const val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input grow" data-f="q" placeholder="Search name, SKU, barcode, HSN, brand…" value="${esc(q.q || '')}" style="max-width:300px">
      <select data-f="category" style="width:170px"><option value="">All categories</option>${cats.map((c) => `<option value="${c.id}" ${String(q.category) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select data-f="warehouse" style="width:170px"><option value="">All warehouses</option>${whs.map((w) => `<option value="${w.id}" ${String(q.warehouse) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-f="status" style="width:130px"><option value="">Any stock</option>${[['ok', 'In stock'], ['low', 'Low'], ['out', 'Out']].map(([k2, l]) => `<option value="${k2}" ${q.status === k2 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" data-f="archived" ${q.archived ? 'checked' : ''}> Archived</label><span class="grow"></span>${can.write() ? '<button class="btn primary" id="sp-new">+ New item</button>' : ''}</div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Item</th><th>Category</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">Reorder</th>${val ? '<th class="num">Value</th>' : ''}<th>Status</th></tr></thead><tbody>
      ${d.items.map((i) => `<tr class="click" data-id="${i.id}"><td>${esc(i.name)}<div class="small sub mono">${esc(i.sku)}${i.barcode ? ' · ' + esc(i.barcode) : ''}</div></td><td>${esc(i.category)}</td><td class="num">${num(i.on_hand)} <span class="sub">${esc(i.uom)}</span></td><td class="num">${num(i.reserved)}</td><td class="num">${num(i.available)}</td><td class="num">${num(i.reorder_level)}</td>${val ? `<td class="num">${inr(i.value)}</td>` : ''}<td>${i.is_active ? badge(i.status) : status(false)}</td></tr>`).join('')}</tbody></table>${pager(d, 'items')}`
      : empty(q.q || q.category || q.status || q.warehouse ? 'No items match' : 'No items yet', q.q ? 'Try a different search or clear the filters.' : 'Create your first item to start tracking stock.', can.write() ? '<button class="btn primary" id="sp-new2">+ New item</button>' : '')}</div></div>`;
    bindFilters('items');
    const nw = () => itemForm(); v.querySelector('#sp-new')?.addEventListener('click', nw); v.querySelector('#sp-new2')?.addEventListener('click', nw);
    v.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => itemDrawer(parseInt(r.dataset.id, 10))));
  };

  function itemForm(it) {
    const e = !!it, c = S.cats, u = S.units;
    const m = modal(e ? 'Edit item' : 'New item', `<form id="f" class="formgrid" novalidate>
      ${field('Name', `<input class="input" name="name" value="${esc(it?.name)}" maxlength="120" required>`, true)}
      ${field('SKU', `<input class="input" name="sku" value="${esc(it?.sku)}" placeholder="Automatic if empty" maxlength="40">`)}${field('Barcode', `<input class="input" name="barcode" value="${esc(it?.barcode)}" placeholder="Optional">${e ? '' : '<label class="chk" style="margin-top:6px"><input type="checkbox" name="auto_barcode"> Generate an EAN-13</label>'}`)}
      ${field('Category', `<select name="category_id">${c.map((x) => `<option value="${x.id}" ${it?.category_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}${field('Unit', `<select name="uom_id">${u.map((x) => `<option value="${x.id}" ${it?.uom_id === x.id ? 'selected' : ''}>${esc(x.symbol)} — ${esc(x.formal_name)}</option>`).join('')}</select>`)}
      ${field('Brand', `<input class="input" name="brand" value="${esc(it?.brand)}" maxlength="60">`)}${field('HSN / SAC', `<input class="input" name="hsn_code" value="${esc(it?.hsn_code)}" placeholder="4–8 digits">`)}
      ${field('GST rate %', `<input class="input" name="gst_rate" type="number" min="0" max="100" step="0.01" value="${it ? it.gst_rate : 18}">`)}${field('Reorder level', `<input class="input" name="reorder_level" type="number" min="0" step="any" value="${it ? it.reorder_level : 0}">`, false, 'Alert when available stock reaches this')}
      ${can.value() ? `${field('Selling price (₹)', `<input class="input" name="standard_price" type="number" min="0" step="0.01" value="${it?.price ?? 0}">`)}${field('Cost (₹)', `<input class="input" name="standard_cost" type="number" min="0" step="0.01" value="${it ? it.cost : 0}">`)}` : ''}
      ${e ? '' : `${field('Opening quantity', `<input class="input" name="opening_qty" type="number" min="0" step="any" value="0">`, false, 'Goes into the first warehouse')}${field('Opening rate (₹)', `<input class="input" name="opening_rate" type="number" min="0" step="0.01" value="0">`)}`}
      ${field('Description', `<textarea name="description" rows="2" maxlength="500">${esc(it?.description)}</textarea>`, true)}
      <div class="full errtxt" id="err" hidden></div><div class="full row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">${e ? 'Save changes' : 'Create item'}</button></div></form>`, { wide: true });
    m.el.querySelector('#f').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const f = ev.target, b = {}; new FormData(f).forEach((val, k2) => { b[k2] = val; }); if (f.auto_barcode) b.auto_barcode = f.auto_barcode.checked;
      const btn = f.querySelector('.primary'); btn.classList.add('busy');
      try { const saved = await api(e ? `/items/${it.id}` : '/items', { method: e ? 'PATCH' : 'POST', body: b }); m.close(); toast(e ? 'Item saved' : `Item created (${saved.sku})`); reload(); }
      catch (err) { btn.classList.remove('busy'); const er = f.querySelector('#err'); er.hidden = false; er.textContent = err.message; }
    });
  }

  async function itemDrawer(id) {
    const m = modal('Item', skel(5), { drawer: true });
    try {
      const it = await api(`/items/${id}`), val = can.value();
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><h2 style="font-size:16px;margin:0">${esc(it.name)}</h2><div class="small sub mono">${esc(it.sku)}${it.barcode ? ' · ' + esc(it.barcode) : ''}</div></div><button class="btn flat sm" data-x>✕</button></div>
        <div class="row wrap mb">${it.is_active ? badge(it.status) : status(false)}<span class="badge b-n">${esc(it.category)}</span>${it.brand ? `<span class="badge b-n">${esc(it.brand)}</span>` : ''}</div>
        <div class="grid g3 mb"><div class="card kpi"><div class="l">On hand</div><div class="v">${num(it.on_hand)}</div><div class="small sub">${esc(it.uom)}</div></div><div class="card kpi"><div class="l">Reserved</div><div class="v">${num(it.reserved)}</div></div><div class="card kpi"><div class="l">Available</div><div class="v">${num(it.available)}</div></div></div>
        <div class="small sub mb">${val ? `Cost ${inr(it.cost)} · Selling ${inr(it.price)} · Value ${inr(it.value)} · ` : ''}GST ${num(it.gst_rate, 2)}%${it.hsn_code ? ' · HSN ' + esc(it.hsn_code) : ''} · Reorder at ${num(it.reorder_level)}</div>
        ${it.description ? `<p class="small">${esc(it.description)}</p>` : ''}
        <h2>By warehouse</h2><div class="card mb scroll-x"><table><thead><tr><th>Warehouse</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th></tr></thead><tbody>${it.warehouses.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${num(w.on_hand)}</td><td class="num">${num(w.reserved)}</td><td class="num">${num(w.available)}</td></tr>`).join('')}</tbody></table></div>
        <h2>Recent movements</h2><div class="card mb scroll-x">${it.recent.length ? `<table><tbody>${it.recent.map((r) => `<tr><td class="small">${esc(r.date)}</td><td class="small"><span class="badge b-n">${esc(r.type)}</span> ${esc(r.number)}</td><td class="small">${esc(r.warehouse)}</td><td class="num" style="color:${r.direction === 'IN' ? '#059669' : '#d97706'}">${r.direction === 'IN' ? '+' : '−'}${num(r.quantity)}</td></tr>`).join('')}</tbody></table>` : empty('No movements yet')}</div>
        <div class="row wrap">${can.write() ? '<button class="btn" id="d-edit">Edit</button>' : ''}${can.move() && it.is_active ? '<button class="btn" id="d-adj">Adjust stock</button><button class="btn" id="d-tr">Transfer</button>' : ''}${can.move() ? `<button class="btn" id="d-arch">${it.is_active ? 'Archive' : 'Restore'}</button>` : ''}${can.remove() && !it.used ? '<button class="btn danger" id="d-del">Delete</button>' : ''}
        <button class="btn" id="d-mv">All movements</button></div>`;
      const $ = (s) => m.el.querySelector(s);
      $('#d-edit')?.addEventListener('click', () => { m.close(); itemForm(it); });
      $('#d-adj')?.addEventListener('click', () => { m.close(); adjustmentForm(it.id); });
      $('#d-tr')?.addEventListener('click', () => { m.close(); transferForm(it.id); });
      $('#d-mv')?.addEventListener('click', () => { m.close(); S.q.movements = { item: it.id, item_label: it.name, page: 1 }; go('movements'); });
      $('#d-arch')?.addEventListener('click', () => confirmBox(it.is_active ? 'Archive item' : 'Restore item', it.is_active ? `${it.name} will be hidden from the item list. Its history is kept.` : `${it.name} will become active again.`, it.is_active ? 'Archive' : 'Restore', async () => { await api(`/items/${it.id}/${it.is_active ? 'archive' : 'restore'}`, { method: 'POST' }); m.close(); toast('Done'); reload(); }));
      $('#d-del')?.addEventListener('click', () => confirmBox('Delete item', `Delete ${it.name}? This cannot be undone.`, 'Delete', async () => { await api(`/items/${it.id}`, { method: 'DELETE' }); m.close(); toast('Item deleted'); reload(); }));
    } catch (err) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load the item', err.message)}`; }
  }

  // ---- categories and units
  PAGES.categories = async (v) => {
    const rows = await api('/categories'); S.cats = rows;
    v.innerHTML = `<div class="sp-wrap"><div class="row between mb"><span class="sub">${rows.length} categories</span>${can.write() ? '<button class="btn primary" id="n">+ New category</button>' : ''}</div><div class="card scroll-x">
      ${rows.length ? `<table><thead><tr><th>Name</th><th>Parent</th><th class="num">Items</th><th></th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.name)}</td><td class="sub">${esc(c.parent || '—')}</td><td class="num">${c.items}</td><td class="num">${can.write() ? `<button class="btn sm" data-e="${c.id}">Edit</button>` : ''} ${can.remove() && !c.items && !c.children ? `<button class="btn sm danger" data-d="${c.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('No categories yet')}</div></div>`;
    const form = (c) => { const m = modal(c ? 'Edit category' : 'New category', `<form id="f">${field('Name', `<input class="input" name="name" value="${esc(c?.name)}" maxlength="60">`)}<div style="height:10px"></div>${field('Parent category', `<select name="parent_id"><option value="">None</option>${rows.filter((x) => !c || x.id !== c.id).map((x) => `<option value="${x.id}" ${c?.parent_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}<div class="errtxt" id="err" hidden></div><div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
      m.el.querySelector('#f').onsubmit = async (ev) => { ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); try { await api(c ? `/categories/${c.id}` : '/categories', { method: c ? 'PATCH' : 'POST', body: b }); m.close(); toast('Saved'); reload(); } catch (er) { const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } }; };
    v.querySelector('#n')?.addEventListener('click', () => form());
    v.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => form(rows.find((c) => c.id === +b.dataset.e))));
    v.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => confirmBox('Delete category', 'Delete this empty category?', 'Delete', async () => { await api(`/categories/${b.dataset.d}`, { method: 'DELETE' }); toast('Deleted'); reload(); })));
  };

  PAGES.units = async (v) => {
    const rows = await api('/units'); S.units = rows;
    v.innerHTML = `<div class="sp-wrap"><div class="row between mb"><span class="sub">${rows.length} units</span>${can.write() ? '<button class="btn primary" id="n">+ New unit</button>' : ''}</div><div class="card scroll-x">
      ${rows.length ? `<table><thead><tr><th>Symbol</th><th>Name</th><th class="num">Decimals</th><th class="num">Items</th><th></th></tr></thead><tbody>${rows.map((u) => `<tr><td class="mono">${esc(u.symbol)}</td><td>${esc(u.formal_name)}</td><td class="num">${u.decimal_places}</td><td class="num">${u.items}</td><td class="num">${can.write() ? `<button class="btn sm" data-e="${u.id}">Edit</button>` : ''} ${can.remove() && !u.items ? `<button class="btn sm danger" data-d="${u.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('No units yet')}</div></div>`;
    const form = (u) => { const m = modal(u ? 'Edit unit' : 'New unit', `<form id="f" class="formgrid">${field('Symbol', `<input class="input" name="symbol" value="${esc(u?.symbol)}" maxlength="12">`)}${field('Name', `<input class="input" name="formal_name" value="${esc(u?.formal_name)}" maxlength="60">`)}${field('Decimal places', `<input class="input" name="decimal_places" type="number" min="0" max="4" value="${u ? u.decimal_places : 0}">`)}<div class="full errtxt" id="err" hidden></div><div class="full row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
      m.el.querySelector('#f').onsubmit = async (ev) => { ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); try { await api(u ? `/units/${u.id}` : '/units', { method: u ? 'PATCH' : 'POST', body: b }); m.close(); toast('Saved'); reload(); } catch (er) { const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } }; };
    v.querySelector('#n')?.addEventListener('click', () => form());
    v.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => form(rows.find((x) => x.id === +b.dataset.e))));
    v.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => confirmBox('Delete unit', 'Delete this unused unit?', 'Delete', async () => { await api(`/units/${b.dataset.d}`, { method: 'DELETE' }); toast('Deleted'); reload(); })));
  };

  // ---- warehouses
  PAGES.warehouses = async (v) => {
    const rows = await api('/warehouses'); S.whs = rows; const val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row between mb"><span class="sub">${rows.filter((w) => w.is_active).length} active · ${rows.filter((w) => !w.is_active).length} archived</span>${can.write() ? '<button class="btn primary" id="n">+ New warehouse</button>' : ''}</div>
      <div class="grid g3">${rows.map((w) => `<div class="card p ${w.is_active ? '' : 'sub'}" style="${w.is_active ? '' : 'opacity:.7'}"><div class="row between"><div><b>${esc(w.name)}</b><div class="small sub mono">${esc(w.code)}</div></div>${status(w.is_active)}</div>
        <div class="small sub" style="margin:6px 0">${esc([w.address, w.city || w.location].filter(Boolean).join(', ') || 'No address')}</div>
        <div class="row small" style="gap:16px"><span><b>${w.items}</b> items</span><span><b>${num(w.units)}</b> units</span>${val ? `<span><b>${inr(w.value)}</b></span>` : ''}${w.low ? `<span class="badge b-warn">${w.low} low</span>` : ''}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" data-go="warehouse" data-param="${w.id}">Open</button>${can.write() ? `<button class="btn sm" data-e="${w.id}">Edit</button>` : ''}${can.move() ? `<button class="btn sm" data-a="${w.id}:${w.is_active ? 0 : 1}">${w.is_active ? 'Archive' : 'Restore'}</button>` : ''}</div></div>`).join('')}</div></div>`;
    const form = (w) => { const m = modal(w ? 'Edit warehouse' : 'New warehouse', `<form id="f" class="formgrid">${field('Name', `<input class="input" name="name" value="${esc(w?.name)}" maxlength="60">`)}${field('Code', `<input class="input" name="code" value="${esc(w?.code)}" placeholder="Automatic" maxlength="12">`)}${field('Address', `<input class="input" name="address" value="${esc(w?.address)}">`, true)}${field('City', `<input class="input" name="city" value="${esc(w?.city)}">`)}${field('Contact person', `<input class="input" name="contact_name" value="${esc(w?.contact_name)}">`)}${field('Phone', `<input class="input" name="phone" value="${esc(w?.phone)}">`)}${field('E-mail', `<input class="input" name="email" value="${esc(w?.email)}">`)}<div class="full errtxt" id="err" hidden></div><div class="full row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`, { wide: true });
      m.el.querySelector('#f').onsubmit = async (ev) => { ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); try { await api(w ? `/warehouses/${w.id}` : '/warehouses', { method: w ? 'PATCH' : 'POST', body: b }); m.close(); toast('Saved'); reload(); } catch (er) { const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } }; };
    v.querySelector('#n')?.addEventListener('click', () => form());
    v.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => form(rows.find((x) => x.id === +b.dataset.e))));
    v.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => { const [id, on] = b.dataset.a.split(':'); try { await api(`/warehouses/${id}/${on === '1' ? 'restore' : 'archive'}`, { method: 'POST' }); toast(on === '1' ? 'Restored' : 'Archived'); reload(); } catch (er) { toast(er.message, 'err'); } }));
  };

  PAGES.warehouse = async (v) => {
    const w = await api(`/warehouses/${S.param}`), val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row mb"><button class="btn sm" data-go="warehouses">← Warehouses</button><h2 style="margin:0">${esc(w.name)}</h2><span class="mono sub">${esc(w.code)}</span>${status(w.is_active)}</div>
      <div class="grid g4 mb"><div class="card kpi"><div class="l">Items stocked</div><div class="v">${w.items}</div></div><div class="card kpi"><div class="l">Units</div><div class="v">${num(w.units)}</div></div>${val ? `<div class="card kpi"><div class="l">Value</div><div class="v">${inr(w.value)}</div></div>` : ''}<div class="card kpi"><div class="l">Low stock</div><div class="v">${w.low}</div></div></div>
      <div class="small sub mb">${esc([w.address, w.city, w.contact_name, w.phone, w.email].filter(Boolean).join(' · '))}</div>
      <div class="card scroll-x mb">${w.stock.length ? `<table><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th>${val ? '<th class="num">Value</th>' : ''}<th>Status</th></tr></thead><tbody>${w.stock.map((s) => `<tr><td>${esc(s.name)}<div class="small sub mono">${esc(s.sku)}</div></td><td class="num">${num(s.on_hand)} ${esc(s.uom)}</td><td class="num">${num(s.reserved)}</td><td class="num">${num(s.available)}</td>${val ? `<td class="num">${inr(s.value)}</td>` : ''}<td>${badge(s.status)}</td></tr>`).join('')}</tbody></table>` : empty('No stock here yet', 'Receive stock with a purchase, an adjustment or a transfer.')}</div>
      <h2>Recent movements</h2><div class="card scroll-x">${w.recent.length ? `<table><tbody>${w.recent.map((r) => `<tr><td class="small">${esc(r.date)}</td><td>${esc(r.item)}</td><td class="small"><span class="badge b-n">${esc(r.type)}</span> ${esc(r.number)}</td><td class="num" style="color:${r.direction === 'IN' ? '#059669' : '#d97706'}">${r.direction === 'IN' ? '+' : '−'}${num(r.quantity)}</td></tr>`).join('')}</tbody></table>` : empty('No movements yet')}</div></div>`;
  };

  // ---- stock levels
  PAGES.stock = async (v) => {
    const { whs } = await lookups();
    const q = S.q.stock = { page: 1, ...(S.q.stock || {}) };
    const d = await api(`/stock?${qs({ q: q.q, warehouse: q.warehouse, status: q.status, page: q.page, page_size: 30 })}`), val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Search item or SKU…" value="${esc(q.q || '')}" style="max-width:280px">
      <select data-f="warehouse" style="width:190px"><option value="">All warehouses</option>${whs.map((w) => `<option value="${w.id}" ${String(q.warehouse) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-f="status" style="width:130px"><option value="">Any stock</option>${[['ok', 'In stock'], ['low', 'Low'], ['out', 'Out']].map(([k2, l]) => `<option value="${k2}" ${q.status === k2 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Item</th><th>Warehouse</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">Reorder</th>${val ? '<th class="num">Value</th>' : ''}<th>Status</th></tr></thead><tbody>
      ${d.items.map((r) => `<tr><td>${esc(r.item)}<div class="small sub mono">${esc(r.sku)}</div></td><td>${esc(r.warehouse)}</td><td class="num">${num(r.on_hand)} ${esc(r.uom)}</td><td class="num">${num(r.reserved)}</td><td class="num">${num(r.available)}</td><td class="num">${num(r.reorder_level)}</td>${val ? `<td class="num">${inr(r.value)}</td>` : ''}<td>${badge(r.status)}</td></tr>`).join('')}</tbody></table>${pager(d, 'stock')}` : empty('No stock found', 'Nothing matches these filters.')}</div></div>`;
    bindFilters('stock');
  };

  // ---- movement history
  PAGES.movements = async (v) => {
    const { whs } = await lookups();
    const q = S.q.movements = { page: 1, ...(S.q.movements || {}) };
    const d = await api(`/movements?${qs({ q: q.q, item: q.item, warehouse: q.warehouse, type: q.type, direction: q.direction, from: q.from, to: q.to, page: q.page, page_size: 30 })}`), val = can.value();
    const types = ['Purchase', 'Sales', 'Credit Note', 'Debit Note', 'Stock Journal'];
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Item, SKU or document no…" value="${esc(q.q || '')}" style="max-width:230px">${q.item ? `<span class="badge b-info">Item: ${esc(q.item_label || '#' + q.item)} <a href="#" id="clr" onclick="return false">✕</a></span>` : ''}
      <select data-f="warehouse" style="width:170px"><option value="">All warehouses</option>${whs.map((w) => `<option value="${w.id}" ${String(q.warehouse) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-f="type" style="width:140px"><option value="">All documents</option>${types.map((t) => `<option ${q.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select data-f="direction" style="width:110px"><option value="">In &amp; out</option><option value="IN" ${q.direction === 'IN' ? 'selected' : ''}>In</option><option value="OUT" ${q.direction === 'OUT' ? 'selected' : ''}>Out</option></select>
      <input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To"></div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Date</th><th>Document</th><th>Item</th><th>Warehouse</th><th class="num">In / out</th>${val ? '<th class="num">Rate</th><th class="num">Value</th>' : ''}${q.item && q.warehouse ? '<th class="num">Balance</th>' : ''}</tr></thead><tbody>
      ${d.items.map((m) => `<tr><td class="small">${esc(m.date)}</td><td class="small"><span class="badge b-n">${esc(m.type)}</span> ${esc(m.number)}</td><td>${esc(m.item)}<div class="small sub mono">${esc(m.sku)}</div></td><td>${esc(m.warehouse)}</td><td class="num" style="color:${m.direction === 'IN' ? '#059669' : '#d97706'}">${m.direction === 'IN' ? '+' : '−'}${num(m.quantity)}</td>${val ? `<td class="num">${inr(m.rate)}</td><td class="num">${inr(m.amount)}</td>` : ''}${q.item && q.warehouse ? `<td class="num">${num(m.balance)}</td>` : ''}</tr>`).join('')}</tbody></table>${pager(d, 'movements')}` : empty('No movements found', 'Purchases, sales, transfers and adjustments appear here.')}</div></div>`;
    bindFilters('movements'); v.querySelector('#clr')?.addEventListener('click', () => { S.q.movements = { ...q, item: '', item_label: '', page: 1 }; reload(); });
  };

  // ---- transfers
  PAGES.transfers = async (v) => {
    await lookups();
    const q = S.q.transfers = { page: 1, ...(S.q.transfers || {}) };
    const d = await api(`/transfers?${qs({ q: q.q, page: q.page, page_size: 25 })}`), val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Search number or note…" value="${esc(q.q || '')}" style="max-width:260px"><span class="grow"></span>${can.move() ? '<button class="btn primary" id="n">+ New transfer</button>' : ''}</div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Number</th><th>Date</th><th>From</th><th>To</th><th class="num">Items</th>${val ? '<th class="num">Value</th>' : ''}<th>Note</th></tr></thead><tbody>${d.items.map((t) => `<tr class="click" data-id="${t.id}"><td class="mono">${esc(t.number)}</td><td>${esc(t.date)}</td><td>${esc(t.from_warehouse)}</td><td>${esc(t.to_warehouse)}</td><td class="num">${t.lines}</td>${val ? `<td class="num">${inr(t.value)}</td>` : ''}<td class="sub small">${esc(t.note || '')}</td></tr>`).join('')}</tbody></table>${pager(d, 'transfers')}` : empty('No transfers yet', 'Move stock between warehouses; it is recorded in the books as a Stock Journal.', can.move() ? '<button class="btn primary" id="n2">+ New transfer</button>' : '')}</div></div>`;
    bindFilters('transfers'); v.querySelector('#n')?.addEventListener('click', () => transferForm()); v.querySelector('#n2')?.addEventListener('click', () => transferForm());
    v.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => docDrawer(r.dataset.id, 'Transfer')));
  };

  async function docDrawer(id, kind) {
    const m = modal(kind, skel(4), { drawer: true });
    try {
      const d = await api(`/${kind === 'Transfer' ? 'transfers' : 'adjustments'}/${id}`), val = can.value();
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><h2 style="font-size:16px;margin:0">${esc(d.number)}</h2><div class="small sub">${esc(d.date)} · by ${esc(d.created_by)}</div></div><button class="btn flat sm" data-x>✕</button></div>
        <div class="small mb">${d.kind === 'transfer' ? `<b>${esc(d.from_warehouse)}</b> → <b>${esc(d.to_warehouse)}</b>` : `<b>${esc(d.to_warehouse)}</b> · <span class="badge b-info">${esc(d.reason)}</span>`}${d.note ? `<div class="sub" style="margin-top:4px">${esc(d.note)}</div>` : ''}</div>
        <div class="card scroll-x"><table><thead><tr><th>Item</th><th>Warehouse</th><th class="num">Qty</th>${val ? '<th class="num">Value</th>' : ''}</tr></thead><tbody>${d.lines.map((l) => `<tr><td>${esc(l.item)}<div class="small sub mono">${esc(l.sku)}</div></td><td>${esc(l.warehouse)}</td><td class="num" style="color:${l.direction === 'IN' ? '#059669' : '#d97706'}">${l.direction === 'IN' ? '+' : '−'}${num(l.quantity)} ${esc(l.uom)}</td>${val ? `<td class="num">${inr(l.amount)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    } catch (err) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load', err.message)}`; }
  }

  function lineRow(kind) {
    return `<tr class="ln"><td style="min-width:230px">${picker('p' + Math.random().toString(36).slice(2, 7))}</td>${kind === 'adj' ? '<td style="width:110px"><select class="mode"><option value="delta">Change by</option><option value="count">Counted</option></select></td>' : ''}<td style="width:120px"><input class="input q" type="number" step="any" ${kind === 'tr' ? 'min="0"' : ''} placeholder="${kind === 'adj' ? '+/- or count' : 'Qty'}"></td><td class="hint av" style="width:150px"></td><td style="width:30px"><button type="button" class="btn flat sm rm" aria-label="Remove line">✕</button></td></tr>`;
  }

  function transferForm(itemId) {
    const w = activeWhs(); if (w.length < 2) { toast('You need at least two active warehouses to transfer stock.', 'err'); return; }
    const m = modal('New stock transfer', `<form id="f">
      <div class="formgrid">${field('From warehouse', `<select name="from">${w.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>`)}${field('To warehouse', `<select name="to">${w.map((x, i) => `<option value="${x.id}" ${i === 1 ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}${field('Date', `<input class="input" type="date" name="date" value="${today()}">`)}${field('Note', `<input class="input" name="note" maxlength="300" placeholder="Optional">`)}</div>
      <div class="card mt scroll-x"><table><thead><tr><th>Item</th><th>Quantity</th><th>Available</th><th></th></tr></thead><tbody id="lines">${lineRow('tr')}</tbody></table></div>
      <button type="button" class="btn sm mt" id="add">+ Add line</button><div class="errtxt" id="err" hidden></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Transfer stock</button></div></form>`, { wide: true });
    const f = m.el.querySelector('#f'), resolve = bindPickers(f), tb = f.querySelector('#lines');
    const avail = async (tr) => { const it = resolve(tr.querySelector('[data-picker]')); const cell = tr.querySelector('.av'); if (!it) { cell.textContent = ''; return; } try { const d = await api(`/items/${it.id}`); const wh = d.warehouses.find((x) => String(x.id) === f.from.value); cell.textContent = `${num(wh ? wh.available : 0)} ${d.uom} in source`; } catch (e) { cell.textContent = ''; } };
    f.addEventListener('change', (e) => { if (e.target.matches('[data-picker],[name=from]')) f.querySelectorAll('.ln').forEach(avail); });
    f.querySelector('#add').onclick = () => { tb.insertAdjacentHTML('beforeend', lineRow('tr')); };
    f.addEventListener('click', (e) => { if (e.target.closest('.rm') && tb.children.length > 1) e.target.closest('.ln').remove(); });
    if (itemId) api(`/items/${itemId}`).then((it) => { const inp = tb.querySelector('[data-picker]'); inp.value = `${it.name} · ${it.sku}`; const dl = f.querySelector(`#${inp.dataset.picker}-dl`); dl.innerHTML = `<option value="${esc(inp.value)}">`; return api(`/items?${qs({ q: it.sku, page_size: 5 })}`).then((r) => { r.items.forEach((x) => { const o = document.createElement('option'); o.value = `${x.name} · ${x.sku}`; dl.appendChild(o); }); f.querySelector('input[data-picker]').dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => f.querySelectorAll('.ln').forEach(avail), 450); }); }).catch(() => {});
    f.onsubmit = async (ev) => {
      ev.preventDefault(); const er = f.querySelector('#err'); er.hidden = true;
      const lines = []; for (const tr of f.querySelectorAll('.ln')) { const it = resolve(tr.querySelector('[data-picker]')); const qn = tr.querySelector('.q').value; if (!it && !qn) continue; if (!it) { er.hidden = false; er.textContent = 'Choose each item from the suggestions as you type.'; return; } lines.push({ item_id: it.id, qty: qn }); }
      const btn = f.querySelector('.primary'); btn.classList.add('busy');
      try { const r = await api('/transfers', { method: 'POST', body: { from_warehouse_id: +f.from.value, to_warehouse_id: +f.to.value, date: f.date.value, note: f.note.value, lines } }); m.close(); toast(`Transfer ${r.number} recorded`); go('transfers'); }
      catch (err) { btn.classList.remove('busy'); er.hidden = false; er.textContent = err.message; }
    };
  }

  // ---- adjustments
  PAGES.adjustments = async (v) => {
    await lookups();
    const q = S.q.adjustments = { page: 1, ...(S.q.adjustments || {}) };
    const d = await api(`/adjustments?${qs({ q: q.q, page: q.page, page_size: 25 })}`), val = can.value();
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Search number or note…" value="${esc(q.q || '')}" style="max-width:260px"><span class="grow"></span>${can.move() ? '<button class="btn primary" id="n">+ New adjustment</button>' : ''}</div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Number</th><th>Date</th><th>Warehouse</th><th>Reason</th><th class="num">Items</th>${val ? '<th class="num">Value</th>' : ''}<th>By</th></tr></thead><tbody>${d.items.map((t) => `<tr class="click" data-id="${t.id}"><td class="mono">${esc(t.number)}</td><td>${esc(t.date)}</td><td>${esc(t.to_warehouse)}</td><td><span class="badge b-info">${esc(t.reason)}</span></td><td class="num">${t.lines}</td>${val ? `<td class="num">${inr(t.value)}</td>` : ''}<td class="sub">${esc(t.created_by)}</td></tr>`).join('')}</tbody></table>${pager(d, 'adjustments')}` : empty('No adjustments yet', 'Correct stock after a count, damage or a find. Each one is recorded with a reason.', can.move() ? '<button class="btn primary" id="n2">+ New adjustment</button>' : '')}</div></div>`;
    bindFilters('adjustments'); v.querySelector('#n')?.addEventListener('click', () => adjustmentForm()); v.querySelector('#n2')?.addEventListener('click', () => adjustmentForm());
    v.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => docDrawer(r.dataset.id, 'Adjustment')));
  };

  async function adjustmentForm(itemId) {
    const w = activeWhs(); const reasons = await api('/adjustment-reasons');
    const m = modal('New stock adjustment', `<form id="f">
      <div class="formgrid">${field('Warehouse', `<select name="wh">${w.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>`)}${field('Reason', `<select name="reason">${reasons.map((r) => `<option>${esc(r)}</option>`).join('')}</select>`)}${field('Date', `<input class="input" type="date" name="date" value="${today()}">`)}${field('Note', `<input class="input" name="note" maxlength="300" placeholder="Optional">`)}</div>
      <div class="card mt scroll-x"><table><thead><tr><th>Item</th><th>Type</th><th>Quantity</th><th>In this warehouse</th><th></th></tr></thead><tbody id="lines">${lineRow('adj')}</tbody></table></div>
      <button type="button" class="btn sm mt" id="add">+ Add line</button><div class="hint">“Change by” adds or removes that quantity (use a minus sign to remove). “Counted” sets the stock to what you counted.</div><div class="errtxt" id="err" hidden></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Record adjustment</button></div></form>`, { wide: true });
    const f = m.el.querySelector('#f'), resolve = bindPickers(f), tb = f.querySelector('#lines');
    const avail = async (tr) => { const it = resolve(tr.querySelector('[data-picker]')); const cell = tr.querySelector('.av'); if (!it) { cell.textContent = ''; return; } try { const d = await api(`/items/${it.id}`); const wh = d.warehouses.find((x) => String(x.id) === f.wh.value); cell.textContent = `${num(wh ? wh.on_hand : 0)} ${d.uom}`; } catch (e) { cell.textContent = ''; } };
    f.addEventListener('change', (e) => { if (e.target.matches('[data-picker],[name=wh]')) f.querySelectorAll('.ln').forEach(avail); });
    f.querySelector('#add').onclick = () => { tb.insertAdjacentHTML('beforeend', lineRow('adj')); };
    f.addEventListener('click', (e) => { if (e.target.closest('.rm') && tb.children.length > 1) e.target.closest('.ln').remove(); });
    if (itemId) { try { const it = await api(`/items/${itemId}`); const inp = tb.querySelector('[data-picker]'); inp.value = `${it.name} · ${it.sku}`; const dl = f.querySelector(`#${inp.dataset.picker}-dl`); dl.innerHTML = `<option value="${esc(inp.value)}">`; const r = await api(`/items?${qs({ q: it.sku, page_size: 5 })}`); r.items.forEach((x) => { const o = document.createElement('option'); o.value = `${x.name} · ${x.sku}`; dl.appendChild(o); }); inp.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => f.querySelectorAll('.ln').forEach(avail), 450); } catch (e) { /* the user can pick it by hand */ } }
    f.onsubmit = async (ev) => {
      ev.preventDefault(); const er = f.querySelector('#err'); er.hidden = true;
      const lines = []; for (const tr of f.querySelectorAll('.ln')) { const it = resolve(tr.querySelector('[data-picker]')); const qn = tr.querySelector('.q').value; if (!it && !qn) continue; if (!it) { er.hidden = false; er.textContent = 'Choose each item from the suggestions as you type.'; return; } lines.push(tr.querySelector('.mode').value === 'count' ? { item_id: it.id, new_qty: qn } : { item_id: it.id, delta: qn }); }
      const btn = f.querySelector('.primary'); btn.classList.add('busy');
      try { const r = await api('/adjustments', { method: 'POST', body: { warehouse_id: +f.wh.value, reason: f.reason.value, date: f.date.value, note: f.note.value, lines } }); m.close(); toast(`Adjustment ${r.number} recorded`); go('adjustments'); }
      catch (err) { btn.classList.remove('busy'); er.hidden = false; er.textContent = err.message; }
    };
  }

  // ================================================================== stage 2: customers, suppliers, orders, history
  const ORDER_BADGE = { draft: 'b-n', issued: 'b-info', partially_received: 'b-warn', received: 'b-ok', confirmed: 'b-info', invoiced: 'b-ok', cancelled: 'b-bad' };
  const obadge = (s) => `<span class="badge ${ORDER_BADGE[s] || 'b-n'}">${esc(String(s).replace('_', ' '))}</span>`;
  const KIND = { customers: { one: 'customer', many: 'Customers', order: 'sales-orders', hist: 'sales-history' }, suppliers: { one: 'supplier', many: 'Suppliers', order: 'purchase-orders', hist: 'purchase-history' } };

  /** Type-to-search picker for customers/suppliers; resolves the typed label back to an id. */
  function partyPicker(id, path, ph) { return `<input class="input" list="${id}-dl" data-party-picker="${path}" data-for="${id}" placeholder="${esc(ph || 'Type a name…')}" autocomplete="off"><datalist id="${id}-dl"></datalist>`; }
  function bindPartyPicker(scope) {
    const map = new Map();
    const fill = debounce(async (inp) => {
      try {
        const d = await api(`/${inp.dataset.partyPicker}?${qs({ q: inp.value, page_size: 15 })}`); const dl = scope.querySelector(`#${inp.dataset.for}-dl`); dl.innerHTML = '';
        for (const p of d.items) { const label = `${p.name}${p.city ? ' · ' + p.city : ''}`; map.set(label, p); const o = document.createElement('option'); o.value = label; dl.appendChild(o); }
      } catch (e) { /* the list stays as it was */ }
    }, 200);
    scope.addEventListener('input', (e) => { if (e.target.matches('[data-party-picker]')) fill(e.target); });
    return (inp) => map.get(inp.value.trim());
  }

  // ---- customers / suppliers
  async function partiesPage(v, path) {
    const K = KIND[path], q = S.q[path] = { page: 1, ...(S.q[path] || {}) }, val = can.value();
    const d = await api(`/${path}?${qs({ q: q.q, archived: q.archived, page: q.page, page_size: 25 })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Search name, GSTIN, phone, city…" value="${esc(q.q || '')}" style="max-width:300px"><label class="chk"><input type="checkbox" data-f="archived" ${q.archived ? 'checked' : ''}> Archived</label><span class="grow"></span>${can.write() ? `<button class="btn primary" id="n">+ New ${K.one}</button>` : ''}</div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>${K.one === 'customer' ? 'Customer' : 'Supplier'}</th><th>Contact</th><th>GSTIN</th><th class="num">Credit days</th>${path === 'customers' ? '<th class="num">Credit limit</th>' : ''}${val ? '<th class="num">Balance</th>' : ''}<th class="num">Orders</th></tr></thead><tbody>
      ${d.items.map((p) => `<tr class="click" data-id="${p.id}"><td>${esc(p.name)}<div class="small sub">${esc([p.city, p.state].filter(Boolean).join(', '))}</div></td><td class="small">${esc(p.contact_name || '')}<div class="sub">${esc(p.phone || p.email || '')}</div></td><td class="mono">${esc(p.gstin || '—')}</td><td class="num">${p.credit_period ?? ''}</td>${path === 'customers' ? `<td class="num">${p.credit_limit ? inr(p.credit_limit) : '—'}</td>` : ''}${val ? `<td class="num">${inr(p.balance)} <span class="small sub">${esc(p.balance_side === 'receivable' ? 'to receive' : p.balance_side === 'payable' ? 'to pay' : p.balance ? 'advance' : '')}</span></td>` : ''}<td class="num">${p.orders}${p.open_orders ? ` <span class="badge b-info">${p.open_orders} open</span>` : ''}</td></tr>`).join('')}</tbody></table>${pager(d, path)}`
      : empty(q.q ? 'No match' : `No ${K.many.toLowerCase()} yet`, q.q ? 'Try a different search.' : `Add your first ${K.one}.`, can.write() ? `<button class="btn primary" id="n2">+ New ${K.one}</button>` : '')}</div></div>`;
    bindFilters(path);
    v.querySelector('#n')?.addEventListener('click', () => partyForm(path)); v.querySelector('#n2')?.addEventListener('click', () => partyForm(path));
    v.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => partyDrawer(path, parseInt(r.dataset.id, 10))));
  }
  PAGES.customers = (v) => partiesPage(v, 'customers');
  PAGES.suppliers = (v) => partiesPage(v, 'suppliers');

  function partyForm(path, p) {
    const K = KIND[path], e = !!p;
    const m = modal(e ? `Edit ${K.one}` : `New ${K.one}`, `<form id="f" class="formgrid" novalidate>
      ${field('Name', `<input class="input" name="name" value="${esc(p?.name)}" maxlength="120">`, true)}${field('GSTIN', `<input class="input" name="gstin" value="${esc(p?.gstin)}" maxlength="15" placeholder="15 characters">`)}${field('PAN', `<input class="input" name="pan" value="${esc(p?.pan)}" maxlength="10">`)}
      ${field('State', `<input class="input" name="state" value="${esc(p?.state)}">`)}${field('State code', `<input class="input" name="state_code" value="${esc(p?.state_code)}" maxlength="2" placeholder="e.g. 33">`, false, 'Decides CGST+SGST (same state) or IGST')}
      ${field('Contact person', `<input class="input" name="contact_name" value="${esc(p?.contact_name)}">`)}${field('Phone', `<input class="input" name="phone" value="${esc(p?.phone)}">`)}${field('E-mail', `<input class="input" name="email" value="${esc(p?.email)}">`)}${field('City', `<input class="input" name="city" value="${esc(p?.city)}">`)}
      ${field('Address', `<input class="input" name="address" value="${esc(p?.address)}">`, true)}${field('Credit period (days)', `<input class="input" type="number" min="0" max="365" name="credit_period" value="${p ? p.credit_period : 30}">`)}
      ${path === 'customers' ? field('Credit limit (₹)', `<input class="input" type="number" min="0" step="0.01" name="credit_limit" value="${p ? p.credit_limit : 0}">`, false, 'A warning only, as elsewhere in RRE') : field('Payment terms', `<input class="input" name="payment_terms" value="${esc(p?.payment_terms)}" placeholder="e.g. Net 30">`)}
      ${field('Notes', `<textarea name="notes" rows="2" maxlength="500">${esc(p?.notes)}</textarea>`, true)}
      <div class="full errtxt" id="err" hidden></div><div class="full row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${e ? 'Save changes' : `Create ${K.one}`}</button></div></form>`, { wide: true });
    m.el.querySelector('#f').onsubmit = async (ev) => {
      ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); const btn = ev.target.querySelector('.primary'); btn.classList.add('busy');
      try { await api(e ? `/${path}/${p.id}` : `/${path}`, { method: e ? 'PATCH' : 'POST', body: b }); m.close(); toast('Saved'); reload(); }
      catch (er) { btn.classList.remove('busy'); const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; }
    };
  }

  async function partyDrawer(path, id) {
    const K = KIND[path], m = modal(K.one, skel(5), { drawer: true });
    try {
      const p = await api(`/${path}/${id}`), val = can.value();
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><h2 style="font-size:16px;margin:0">${esc(p.name)}</h2><div class="small sub">${esc([p.city, p.state].filter(Boolean).join(', '))}</div></div><button class="btn flat sm" data-x>✕</button></div>
        <div class="row wrap mb">${status(p.is_active)}${p.gstin ? `<span class="badge b-n mono">${esc(p.gstin)}</span>` : ''}</div>
        ${val ? `<div class="grid g2 mb"><div class="card kpi"><div class="l">${path === 'customers' ? 'Owes you' : 'You owe'}</div><div class="v">${inr(p.balance)}</div><div class="small sub">${esc(p.balance_side || '')}</div></div><div class="card kpi"><div class="l">Orders</div><div class="v">${p.orders}</div><div class="small sub">${p.open_orders} open</div></div></div>` : ''}
        <div class="small mb">${esc([p.contact_name, p.phone, p.email].filter(Boolean).join(' · ')) || '<span class="sub">No contact details</span>'}<div class="sub">${esc(p.address || '')}</div><div class="sub">Credit ${p.credit_period ?? 0} days${path === 'customers' && p.credit_limit ? ` · limit ${inr(p.credit_limit)}` : ''}${p.payment_terms ? ' · ' + esc(p.payment_terms) : ''}</div></div>
        <h2>Orders</h2><div class="card mb scroll-x">${p.orders_list.length ? `<table><tbody>${p.orders_list.map((o) => `<tr class="click" data-o="${o.id}"><td class="mono">${esc(o.number)}</td><td class="small">${esc(o.order_date)}</td><td>${obadge(o.status)}</td><td class="num">${inr(o.total)}</td></tr>`).join('')}</tbody></table>` : empty('No orders yet')}</div>
        <h2>Recent vouchers</h2><div class="card mb scroll-x">${p.vouchers.length ? `<table><tbody>${p.vouchers.map((x) => `<tr><td class="small">${esc(x.date)}</td><td class="small"><span class="badge b-n">${esc(x.type)}</span> ${esc(x.number)}</td><td class="num">${inr(x.total)}</td></tr>`).join('')}</tbody></table>` : empty('No vouchers yet')}</div>
        <div class="row wrap">${can.write() && p.is_active ? `<button class="btn primary" id="d-order">New ${path === 'customers' ? 'sales' : 'purchase'} order</button>` : ''}${can.write() ? '<button class="btn" id="d-edit">Edit</button>' : ''}${can.move() ? `<button class="btn" id="d-arch">${p.is_active ? 'Archive' : 'Restore'}</button>` : ''}</div>`;
      const $ = (s) => m.el.querySelector(s);
      $('#d-edit')?.addEventListener('click', () => { m.close(); partyForm(path, p); });
      $('#d-order')?.addEventListener('click', async () => { m.close(); await lookups(); orderForm(K.order, null, p); });
      $('#d-arch')?.addEventListener('click', () => confirmBox(p.is_active ? 'Archive' : 'Restore', p.is_active ? `${p.name} will be hidden from new orders. History is kept.` : `${p.name} will become active again.`, p.is_active ? 'Archive' : 'Restore', async () => { await api(`/${path}/${id}/${p.is_active ? 'archive' : 'restore'}`, { method: 'POST' }); m.close(); toast('Done'); reload(); }));
      m.el.querySelectorAll('tr[data-o]').forEach((r) => r.addEventListener('click', () => { m.close(); orderDrawer(parseInt(r.dataset.o, 10)); }));
    } catch (err) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load', err.message)}`; }
  }

  // ---- orders
  async function ordersPage(v, kind) {
    await lookups();
    const key = kind === 'purchase-orders' ? 'po' : 'so', K = kind === 'purchase-orders' ? { word: 'purchase', party: 'Supplier' } : { word: 'sales', party: 'Customer' };
    const q = S.q[kind] = { page: 1, ...(S.q[kind] || {}) };
    const d = await api(`/${kind}?${qs({ q: q.q, status: q.status, from: q.from, to: q.to, page: q.page, page_size: 25 })}`);
    const states = kind === 'purchase-orders' ? ['draft', 'issued', 'partially_received', 'received', 'cancelled'] : ['draft', 'confirmed', 'invoiced', 'cancelled'];
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Search number, ${K.party.toLowerCase()} or reference…" value="${esc(q.q || '')}" style="max-width:280px">
      <select data-f="status" style="width:170px"><option value="">Any status</option><option value="open" ${q.status === 'open' ? 'selected' : ''}>Open</option>${states.map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>
      <input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To"><span class="grow"></span>${can.write() ? `<button class="btn primary" id="n">+ New ${K.word} order</button>` : ''}</div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Number</th><th>Date</th><th>${K.party}</th><th>Warehouse</th><th class="num">Lines</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${d.items.map((o) => `<tr class="click" data-id="${o.id}"><td class="mono">${esc(o.number)}${o.portal ? ' <span class="badge b-n" title="Requested by the customer through the portal">Portal</span>' : ''}</td><td class="small">${esc(o.order_date)}${o.expected_date ? `<div class="sub">due ${esc(o.expected_date)}</div>` : ''}</td><td>${esc(o.party)}</td><td class="small">${esc(o.warehouse)}</td><td class="num">${o.lines}</td><td class="num">${inr(o.total)}</td><td>${obadge(o.status)}${o.overdue ? ' <span class="badge b-bad">overdue</span>' : ''}</td></tr>`).join('')}</tbody></table>${pager(d, kind)}`
      : empty(`No ${K.word} orders`, q.q || q.status ? 'Nothing matches these filters.' : kind === 'purchase-orders' ? 'Order goods from a supplier; receiving them adds stock and posts a Purchase voucher.' : 'Confirming an order reserves the stock; invoicing it posts a Sales voucher.', can.write() ? `<button class="btn primary" id="n2">+ New ${K.word} order</button>` : '')}</div></div>`;
    bindFilters(kind);
    v.querySelector('#n')?.addEventListener('click', () => orderForm(kind)); v.querySelector('#n2')?.addEventListener('click', () => orderForm(kind));
    v.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => orderDrawer(parseInt(r.dataset.id, 10))));
  }
  PAGES['purchase-orders'] = (v) => ordersPage(v, 'purchase-orders');
  PAGES['sales-orders'] = (v) => ordersPage(v, 'sales-orders');

  function orderLineRow(sales) {
    return `<tr class="ln"><td style="min-width:200px">${picker('o' + Math.random().toString(36).slice(2, 7))}</td><td style="width:90px"><input class="input q" type="number" min="0" step="any" placeholder="Qty"></td><td style="width:105px"><input class="input rt" type="number" min="0" step="0.01" placeholder="Default"></td><td style="width:80px"><input class="input ds" type="number" min="0" max="100" step="0.01" placeholder="0"></td><td style="width:80px"><input class="input gs" type="number" min="0" max="100" step="0.01" placeholder="GST %"></td><td class="num am" style="width:100px"></td><td style="width:30px"><button type="button" class="btn flat sm rm" aria-label="Remove line">✕</button></td></tr>`;
  }

  async function orderForm(kind, o, party) {
    const sales = kind === 'sales-orders', path = sales ? 'customers' : 'suppliers', w = activeWhs(), e = !!o;
    const m = modal(e ? `Edit ${o.number}` : `New ${sales ? 'sales' : 'purchase'} order`, `<form id="f">
      <div class="formgrid">${field(sales ? 'Customer' : 'Supplier', partyPicker('pp', path, 'Type to search…'))}${field('Warehouse', `<select name="wh">${w.map((x) => `<option value="${x.id}" ${o?.warehouse_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`, false, sales ? 'Stock is reserved here' : 'Goods are received here')}
        ${field('Order date', `<input class="input" type="date" name="order_date" value="${esc(o?.order_date || today())}">`)}${field(sales ? 'Delivery date' : 'Expected date', `<input class="input" type="date" name="expected_date" value="${esc(o?.expected_date || '')}">`)}${field('Reference', `<input class="input" name="reference" value="${esc(o?.reference)}" maxlength="60" placeholder="${sales ? "Customer's PO number" : 'Quote / request number'}">`)}${field('Notes', `<input class="input" name="notes" value="${esc(o?.notes)}" maxlength="500">`)}</div>
      <div class="card mt scroll-x"><table><thead><tr><th>Item</th><th>Qty</th><th>Rate (₹)</th><th>Disc %</th><th>GST %</th><th class="num">Amount</th><th></th></tr></thead><tbody id="lines">${orderLineRow(sales)}</tbody></table></div>
      <div class="row between mt"><button type="button" class="btn sm" id="add">+ Add line</button><span class="small sub" id="est"></span></div>
      <div class="hint">Leave the rate empty to use the item's ${sales ? 'selling price' : 'cost'}. The server works out GST (CGST+SGST in your state, IGST otherwise) and the final total.</div>
      <div class="errtxt" id="err" hidden></div><div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${e ? 'Save changes' : 'Save as draft'}</button></div></form>`, { wide: true });
    const f = m.el.querySelector('#f'), resolveItem = bindPickers(f), resolveParty = bindPartyPicker(f), tb = f.querySelector('#lines');
    const refresh = () => { let sub = 0, tax = 0; tb.querySelectorAll('.ln').forEach((tr) => { const q = +tr.querySelector('.q').value || 0, r = +tr.querySelector('.rt').value || 0, d = +tr.querySelector('.ds').value || 0, g = +tr.querySelector('.gs').value || 0; const a = q * r * (1 - d / 100); tr.querySelector('.am').textContent = a ? inr(a) : ''; sub += a; tax += a * g / 100; }); f.querySelector('#est').textContent = sub ? `About ${inr(sub)} + GST ${inr(tax)} = ${inr(sub + tax)}` : ''; };
    f.addEventListener('input', (ev) => { if (ev.target.matches('.q,.rt,.ds,.gs')) refresh(); });
    f.addEventListener('change', async (ev) => {
      if (!ev.target.matches('[data-picker]')) return; const tr = ev.target.closest('.ln'), it = resolveItem(ev.target); if (!it) return;
      tr.querySelector('.gs').value = it.gst_rate ?? ''; if (can.value() && !tr.querySelector('.rt').value) tr.querySelector('.rt').value = (sales ? it.price : it.cost) || ''; if (!tr.querySelector('.q').value) tr.querySelector('.q').value = 1; refresh();
    });
    f.querySelector('#add').onclick = () => tb.insertAdjacentHTML('beforeend', orderLineRow(sales));
    f.addEventListener('click', (ev) => { if (ev.target.closest('.rm') && tb.children.length > 1) { ev.target.closest('.ln').remove(); refresh(); } });
    // pre-fill: an existing order, or a chosen party
    const setParty = (p) => { const inp = f.querySelector('[data-party-picker]'); inp.value = `${p.name}${p.city ? ' · ' + p.city : ''}`; f.querySelector('#pp-dl').innerHTML = `<option value="${esc(inp.value)}">`; inp.dataset.id = p.id; };
    if (party) setParty(party);
    if (o) {
      try { const p = await api(`/${path}/${o.party_ledger_id}`); setParty(p); } catch (er) { /* the user can pick again */ }
      tb.innerHTML = ''; for (const l of o.lines) { tb.insertAdjacentHTML('beforeend', orderLineRow(sales)); const tr = tb.lastElementChild, inp = tr.querySelector('[data-picker]'); inp.value = `${l.item} · ${l.sku}`; inp.dataset.id = l.item_id; tr.querySelector('.q').value = l.qty; tr.querySelector('.rt').value = l.rate; tr.querySelector('.ds').value = l.discount_pct || ''; tr.querySelector('.gs').value = l.gst_rate; }
      refresh();
    }
    f.onsubmit = async (ev) => {
      ev.preventDefault(); const er = f.querySelector('#err'); er.hidden = true;
      const pInp = f.querySelector('[data-party-picker]'), pRes = resolveParty(pInp), partyId = pRes ? pRes.id : (pInp.dataset.id ? +pInp.dataset.id : 0);
      if (!partyId) { er.hidden = false; er.textContent = `Choose the ${sales ? 'customer' : 'supplier'} from the suggestions as you type.`; return; }
      const lines = []; for (const tr of tb.querySelectorAll('.ln')) {
        const inp = tr.querySelector('[data-picker]'), it = resolveItem(inp), id = it ? it.id : (inp.dataset.id ? +inp.dataset.id : 0), q = tr.querySelector('.q').value; if (!id && !q) continue;
        if (!id) { er.hidden = false; er.textContent = 'Choose each item from the suggestions as you type.'; return; }
        lines.push({ item_id: id, qty: q, rate: tr.querySelector('.rt').value, discount_pct: tr.querySelector('.ds').value, gst_rate: tr.querySelector('.gs').value });
      }
      const body = { party_id: partyId, warehouse_id: +f.wh.value, order_date: f.order_date.value, expected_date: f.expected_date.value, reference: f.reference.value, notes: f.notes.value, lines };
      const btn = f.querySelector('.primary'); btn.classList.add('busy');
      try { const r = await api(e ? `/orders/${o.id}` : `/${kind}`, { method: e ? 'PUT' : 'POST', body }); m.close(); toast(`${r.number} saved as a draft`); go(kind); setTimeout(() => orderDrawer(r.id), 400); }
      catch (err) { btn.classList.remove('busy'); er.hidden = false; er.textContent = err.message; }
    };
  }

  async function orderDrawer(id) {
    const m = modal('Order', skel(6), { drawer: true });
    try {
      const o = await api(`/orders/${id}`), sales = o.kind === 'sales', T = o.totals, kindPath = sales ? 'sales-orders' : 'purchase-orders';
      const canPost = can.write(), canCancel = can.move();
      const actions = [];
      if (o.status === 'draft' && canPost) actions.push(`<button class="btn primary" id="a-conf">${sales ? 'Confirm &amp; reserve stock' : 'Issue to supplier'}</button><button class="btn" id="a-edit">Edit</button><button class="btn danger" id="a-del">Delete</button>`);
      if (!sales && ['issued', 'partially_received'].includes(o.status) && canPost) actions.push('<button class="btn primary" id="a-recv">Receive goods</button>');
      if (sales && o.status === 'confirmed' && canPost) actions.push('<button class="btn primary" id="a-inv">Create invoice</button>');
      if (!['cancelled', 'received', 'invoiced'].includes(o.status) && !o.lines.some((l) => l.qty_done > 0) && canCancel) actions.push('<button class="btn" id="a-cancel">Cancel order</button>');
      m.el.querySelector('.drawer').innerHTML = `<div class="row between mb"><div><h2 style="font-size:16px;margin:0">${esc(o.number)}</h2><div class="small sub">${esc(o.order_date)} · by ${esc(o.created_by)}${o.expected_date ? ` · due ${esc(o.expected_date)}` : ''}</div></div><button class="btn flat sm" data-x>✕</button></div>
        <div class="row wrap mb">${obadge(o.status)}${o.reserved ? '<span class="badge b-info">stock reserved</span>' : ''}<span class="badge b-n">${esc(o.warehouse)}</span></div>
        <div class="small mb"><b>${esc(o.party)}</b>${o.reference ? `<div class="sub">Ref: ${esc(o.reference)}</div>` : ''}${o.notes ? `<div class="sub">${esc(o.notes)}</div>` : ''}${o.cancelled_reason ? `<div class="errtxt">Cancelled: ${esc(o.cancelled_reason)}</div>` : ''}</div>
        <div class="card mb scroll-x"><table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc</th><th class="num">GST</th><th class="num">Amount</th><th class="num">${sales ? 'Invoiced' : 'Received'}</th></tr></thead><tbody>
        ${o.lines.map((l) => `<tr><td>${esc(l.item)}<div class="small sub mono">${esc(l.sku)}</div></td><td class="num">${num(l.qty)} ${esc(l.uom)}</td><td class="num">${inr(l.rate)}</td><td class="num">${l.discount_pct ? num(l.discount_pct, 2) + '%' : '—'}</td><td class="num">${num(l.gst_rate, 2)}%</td><td class="num">${inr(l.amount)}</td><td class="num">${num(l.qty_done)}</td></tr>`).join('')}</tbody></table></div>
        <div class="card p mb small"><div class="row between"><span class="sub">Taxable</span><span>${inr(T.taxable)}</span></div>${T.cgst ? `<div class="row between"><span class="sub">CGST</span><span>${inr(T.cgst)}</span></div><div class="row between"><span class="sub">SGST</span><span>${inr(T.sgst)}</span></div>` : ''}${T.igst ? `<div class="row between"><span class="sub">IGST</span><span>${inr(T.igst)}</span></div>` : ''}${T.round_off ? `<div class="row between"><span class="sub">Round off</span><span>${inr(T.round_off)}</span></div>` : ''}<div class="row between" style="margin-top:6px;font-weight:700;font-size:14px"><span>Total</span><span>${inr(T.total)}</span></div></div>
        ${o.docs.length ? `<h2>${sales ? 'Invoices' : 'Goods receipts'}</h2><div class="card mb scroll-x"><table><tbody>${o.docs.map((d) => `<tr><td class="mono">${esc(d.number)}</td><td class="small">${esc(d.doc_date)}</td><td class="small sub">Voucher ${esc(d.voucher_no)}</td><td class="num">${inr(d.total_amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="row wrap">${actions.join('') || '<span class="sub small">No further actions.</span>'}</div>`;
      const $ = (s) => m.el.querySelector(s);
      $('#a-edit')?.addEventListener('click', async () => { m.close(); await lookups(); orderForm(kindPath, o); });
      $('#a-del')?.addEventListener('click', () => confirmBox('Delete draft', `Delete ${o.number}? This cannot be undone.`, 'Delete', async () => { await api(`/orders/${id}`, { method: 'DELETE' }); m.close(); toast('Deleted'); reload(); }));
      $('#a-conf')?.addEventListener('click', async (e) => { e.target.classList.add('busy'); try { const r = await api(`/orders/${id}/confirm`, { method: 'POST' }); m.close(); toast(sales ? `${o.number} confirmed — stock reserved` : `${o.number} issued`); (r.warnings || []).forEach((w) => toast(w, 'err')); reload(); setTimeout(() => orderDrawer(id), 300); } catch (er) { e.target.classList.remove('busy'); toast(er.message, 'err'); } });
      $('#a-cancel')?.addEventListener('click', () => { const mm = modal('Cancel order', `<form id="cf">${field('Reason (optional)', '<input class="input" name="reason" maxlength="200">')}<p class="hint">${sales ? 'Reserved stock will be released.' : 'The order will be closed.'}</p><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Keep order</button><button class="btn danger">Cancel order</button></div></form>`); mm.el.querySelector('#cf').onsubmit = async (ev) => { ev.preventDefault(); try { await api(`/orders/${id}/cancel`, { method: 'POST', body: { reason: ev.target.reason.value } }); mm.close(); m.close(); toast('Order cancelled'); reload(); } catch (er) { toast(er.message, 'err'); } }; });
      $('#a-recv')?.addEventListener('click', () => {
        const mm = modal('Receive goods', `<form id="rf"><div class="formgrid">${field('Receipt date', `<input class="input" type="date" name="date" value="${today()}">`)}${field("Supplier's invoice no.", '<input class="input" name="reference" maxlength="60" placeholder="Optional">')}</div>
          <div class="card mt scroll-x"><table><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Still due</th><th>Receiving now</th></tr></thead><tbody>${o.lines.map((l) => `<tr><td>${esc(l.item)}</td><td class="num">${num(l.qty)}</td><td class="num">${num(l.remaining)}</td><td><input class="input" type="number" min="0" max="${l.remaining}" step="any" data-line="${l.id}" value="${l.remaining}" ${l.remaining <= 0 ? 'disabled' : ''}></td></tr>`).join('')}</tbody></table></div>
          <p class="hint">This posts a Purchase voucher: stock comes in to ${esc(o.warehouse)}, the supplier's bill is opened and input GST is recorded.</p><div class="errtxt" id="err" hidden></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Receive &amp; post</button></div></form>`, { wide: true });
        mm.el.querySelector('#rf').onsubmit = async (ev) => { ev.preventDefault(); const btn = ev.target.querySelector('.primary'); btn.classList.add('busy'); const lines = [...ev.target.querySelectorAll('[data-line]')].map((i) => ({ line_id: +i.dataset.line, qty: i.value })).filter((l) => +l.qty > 0);
          try { const r = await api(`/orders/${id}/receive`, { method: 'POST', body: { date: ev.target.date.value, reference: ev.target.reference.value, lines } }); mm.close(); m.close(); toast(`Goods received (${r.docs[r.docs.length - 1].number})`); reload(); setTimeout(() => orderDrawer(id), 300); } catch (er) { btn.classList.remove('busy'); const x = mm.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } };
      });
      $('#a-inv')?.addEventListener('click', () => {
        const mm = modal('Create invoice', `<form id="vf"><div class="formgrid">${field('Invoice date', `<input class="input" type="date" name="date" value="${today()}">`)}${field("Customer's PO no.", '<input class="input" name="reference" maxlength="60" placeholder="Optional">')}</div>
          <p class="hint">This posts a Sales voucher for ${inr(T.total)}: stock goes out of ${esc(o.warehouse)}, the customer's bill is opened and output GST is recorded. The reservation is released.</p><div class="errtxt" id="err" hidden></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Invoice &amp; post</button></div></form>`);
        mm.el.querySelector('#vf').onsubmit = async (ev) => { ev.preventDefault(); const btn = ev.target.querySelector('.primary'); btn.classList.add('busy');
          try { const r = await api(`/orders/${id}/invoice`, { method: 'POST', body: { date: ev.target.date.value, reference: ev.target.reference.value } }); mm.close(); m.close(); toast(`Invoice ${r.docs[r.docs.length - 1].number} posted`); reload(); setTimeout(() => orderDrawer(id), 300); } catch (er) { btn.classList.remove('busy'); const x = mm.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } };
      });
    } catch (err) { m.el.querySelector('.drawer').innerHTML = `<button class="btn flat sm" data-x>✕</button>${empty('Could not load the order', err.message)}`; }
  }

  // ---- purchase and sales history
  async function historyPage(v, kind) {
    const sales = kind === 'sales-history', q = S.q[kind] = { page: 1, ...(S.q[kind] || {}) };
    const d = await api(`/${kind}?${qs({ q: q.q, from: q.from, to: q.to, page: q.page, page_size: 30 })}`);
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><input class="input" data-f="q" placeholder="Voucher, ${sales ? 'customer' : 'supplier'} or order no…" value="${esc(q.q || '')}" style="max-width:280px"><input class="input" type="date" data-f="from" value="${esc(q.from || '')}" style="width:140px" aria-label="From"><input class="input" type="date" data-f="to" value="${esc(q.to || '')}" style="width:140px" aria-label="To"><span class="grow"></span><span class="badge b-n">${d.total} vouchers · ${inr(d.sum)}</span></div>
      <div class="card scroll-x">${d.items.length ? `<table><thead><tr><th>Date</th><th>Voucher</th><th>${sales ? 'Customer' : 'Supplier'}</th><th>Reference</th><th>Order</th><th class="num">Qty</th><th class="num">Total</th></tr></thead><tbody>
      ${d.items.map((r) => `<tr><td class="small">${esc(r.date)}</td><td class="mono">${esc(r.number)}</td><td>${esc(r.party || '—')}</td><td class="small sub">${esc(r.reference || '')}</td><td>${r.order_number ? `<a href="#" data-o="${r.order_id}" onclick="return false">${esc(r.order_number)}</a>` : '<span class="sub small">direct entry</span>'}</td><td class="num">${num(r.quantity)}</td><td class="num">${inr(r.total)}</td></tr>`).join('')}</tbody></table>${pager(d, kind)}` : empty('No vouchers found', 'Posted vouchers appear here, whether entered directly or created from an order.')}</div></div>`;
    bindFilters(kind); v.querySelectorAll('a[data-o]').forEach((a) => a.addEventListener('click', () => orderDrawer(+a.dataset.o)));
  }
  PAGES['sales-history'] = (v) => historyPage(v, 'sales-history');
  PAGES['purchase-history'] = (v) => historyPage(v, 'purchase-history');

  // ---- customer portal logins (administrators only; the server enforces this too)
  PAGES['portal-users'] = async (v) => {
    const list = await api('/portal-users');
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><span class="sub small grow">Give a customer a login to the customer portal: they see the catalogue (selling price and availability only), send order requests, and see only their own orders and invoices. Customers sign in at <b>${esc(location.origin)}/portal.html</b>.</span><button class="btn primary" id="pu-new">+ New portal login</button></div>
      <div class="card scroll-x">${list.length ? `<table><thead><tr><th>Customer</th><th>Login</th><th>Status</th><th class="num">Orders placed</th><th>Last sign-in</th><th></th></tr></thead><tbody>${list.map((u) => `<tr><td>${esc(u.customer || '—')}</td><td>${esc(u.username)}<div class="small sub">${esc(u.full_name)}${u.email ? ' · ' + esc(u.email) : ''}</div></td><td>${u.status === 'Active' ? '<span class="badge b-ok">Active</span>' : '<span class="badge b-n">Disabled</span>'}${u.must_change ? ' <span class="badge b-warn" title="Has not chosen their own password yet">Temporary password</span>' : ''}</td><td class="num">${u.orders}</td><td class="small">${u.last_login ? esc(String(u.last_login).slice(0, 16).replace('T', ' ')) : '<span class="sub">never</span>'}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-reset="${u.id}">Reset password</button> <button class="btn sm ${u.status === 'Active' ? 'danger' : ''}" data-toggle="${u.id}" data-on="${u.status === 'Active' ? 1 : 0}">${u.status === 'Active' ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</tbody></table>` : empty('No portal logins yet', 'Create one for a customer who should be able to order online.', '<button class="btn primary" id="pu-new2">+ New portal login</button>')}</div></div>`;
    const create = async () => {
      const cs = (await api('/customers?page_size=500')).items;
      const m = modal('New portal login', `<form id="f" class="formgrid" novalidate>${field('Customer', `<select class="input" name="party_id"><option value="">Choose a customer…</option>${cs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`, true)}
        ${field('Login name', '<input class="input" name="username" maxlength="40" autocomplete="off" placeholder="e.g. acme.purchasing">')}${field('Person\'s name', '<input class="input" name="full_name" maxlength="80" placeholder="Optional">')}
        ${field('Temporary password', '<input class="input" type="text" name="password" autocomplete="off" placeholder="At least 10 characters">', true)}${field('E-mail', '<input class="input" name="email" maxlength="100" placeholder="Optional">', true)}
        <p class="full hint">Give the customer the login name and this temporary password. They are made to choose their own the first time they sign in. They can see only their own orders and invoices.</p><div class="full errtxt" id="err" hidden></div><div class="full row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Create login</button></div></form>`);
      m.el.querySelector('#f').onsubmit = async (ev) => { ev.preventDefault(); const btn = ev.target.querySelector('.primary'); btn.classList.add('busy');
        try { await api('/portal-users', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); m.close(); toast('Portal login created'); reload(); } catch (er) { btn.classList.remove('busy'); const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } };
    };
    v.querySelector('#pu-new')?.addEventListener('click', create); v.querySelector('#pu-new2')?.addEventListener('click', create);
    v.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const on = b.dataset.on === '1', id = b.dataset.toggle;
      const doit = async () => { await api(`/portal-users/${id}/${on ? 'disable' : 'enable'}`, { method: 'POST' }); toast(on ? 'Login disabled' : 'Login enabled'); reload(); };
      if (on) confirmBox('Disable this login?', 'The customer is signed out straight away and cannot sign in again until you enable it. Their orders and invoices are kept.', 'Disable', doit); else doit().catch((e) => toast(e.message, 'err'));
    }));
    v.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
      const m = modal('Reset password', `<form id="f"><label class="lbl">New temporary password</label><input class="input" type="text" name="password" autocomplete="off" placeholder="At least 10 characters"><p class="hint">The customer must choose their own password the next time they sign in. Their current password stops working now.</p><div class="errtxt" id="err" hidden></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Reset password</button></div></form>`);
      m.el.querySelector('#f').onsubmit = async (ev) => { ev.preventDefault(); try { await api(`/portal-users/${b.dataset.reset}/reset-password`, { method: 'POST', body: { password: ev.target.password.value } }); m.close(); toast('Password reset'); reload(); } catch (er) { const x = m.el.querySelector('#err'); x.hidden = false; x.textContent = er.message; } };
    }));
  };

  // ---- reports (stage 3)
  PAGES.reports = async (v) => {
    const list = await api('/reports'), groups = {};
    list.forEach((r) => { (groups[r.group || 'Reports'] = groups[r.group || 'Reports'] || []).push(r); });
    v.innerHTML = `<div class="sp-wrap">${Object.entries(groups).map(([g, rs]) => `<div class="sp-grp" style="padding:8px 0">${esc(g)}</div><div class="rep-grid mb">${rs.map((r) => `<button class="card rep-card" ${r.available ? `data-go="report" data-param="${r.id}"` : 'disabled'}><b>${esc(r.title)}</b><div class="sub small" style="margin-top:4px">${esc(r.description || '')}</div>${r.available ? '' : '<div class="small" style="margin-top:6px">Needs permission to view costs and values</div>'}</button>`).join('')}</div>`).join('')}</div>`;
  };
  const isNum = (c) => c.type === 'money' || c.type === 'number';
  const cell = (c, x) => (x == null || x === '' ? '' : c.type === 'money' ? inr(x) : c.type === 'number' ? num(x) : c.type === 'badge' ? `<span class="badge b-n">${esc(x)}</span>` : esc(x));
  PAGES.report = async (v) => {
    const id = S.param, meta = (await api('/reports')).find((r) => r.id === id);
    if (!meta) { v.innerHTML = `<div class="card">${empty('Report not found', '', '<button class="btn" data-go="reports">All reports</button>')}</div>`; return; }
    await lookups();
    const key = 'report:' + id, q = S.q[key] = { ...(S.q[key] || {}) };
    if (!q.as_of && meta.filters.some((f) => f.key === 'as_of')) q.as_of = today();
    const input = (f) => {
      const val = q[f.key] || '';
      if (f.type === 'date') return `<input class="input" type="date" data-r="${f.key}" value="${esc(val)}">`;
      if (f.type === 'number') return `<input class="input" type="number" min="1" data-r="${f.key}" value="${esc(val)}" style="width:120px">`;
      if (f.type === 'category') return `<select class="input" data-r="${f.key}"><option value="">All categories</option>${S.cats.map((c) => `<option value="${c.id}" ${String(val) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
      if (f.type === 'warehouse') return `<select class="input" data-r="${f.key}"><option value="">All warehouses</option>${S.whs.map((w) => `<option value="${w.id}" ${String(val) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>`;
      if (f.type === 'select') return `<select class="input" data-r="${f.key}">${f.options.map(([k, l]) => `<option value="${k}" ${String(val) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      return `<input class="input" data-r="${f.key}" value="${esc(val)}">`;
    };
    v.innerHTML = `<div class="sp-wrap"><div class="row wrap mb"><button class="btn sm" data-go="reports">${ic('arrow-left')} All reports</button><b style="font-size:15px">${esc(meta.title)}</b><span class="grow"></span><button class="btn sm" id="r-csv">${ic('download')} Download CSV</button></div>
      <div class="card mb"><div class="row wrap" style="gap:12px;align-items:flex-end">${meta.filters.map((f) => `<div><label class="lbl">${esc(f.label)}</label>${input(f)}</div>`).join('')}<button class="btn primary" id="r-run">Show report</button></div></div><div id="r-out">${skel(4)}</div></div>`;
    const params = () => { const o = {}; v.querySelectorAll('[data-r]').forEach((el) => { o[el.dataset.r] = el.value; S.q[key][el.dataset.r] = el.value; }); return qs(o); };
    const show = async () => {
      const out = v.querySelector('#r-out'); out.innerHTML = skel(4);
      try {
        const d = await api(`/reports/${id}?${params()}`), cols = d.columns, cls = (c) => (isNum(c) ? 'num' : '');
        out.innerHTML = `<div class="card scroll-x">${d.rows.length ? `<table><thead><tr>${cols.map((c) => `<th class="${cls(c)}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${d.rows.map((r) => `<tr>${cols.map((c) => `<td class="${cls(c)}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>${d.totals ? `<tfoot><tr>${cols.map((c) => `<td class="${cls(c)}"><b>${cell(c, d.totals[c.key])}</b></td>`).join('')}</tr></tfoot>` : ''}</table>` : empty('Nothing to show', 'No records match these filters.')}</div>
          ${(d.notes || []).length ? `<ul class="hint" style="margin:10px 4px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}<div class="hint" style="margin:4px">Generated ${esc(d.generated)} · ${d.rows.length} row${d.rows.length === 1 ? '' : 's'}</div>`;
      } catch (e) { out.innerHTML = `<div class="card">${empty('Could not run the report', e.message)}</div>`; }
    };
    v.querySelector('#r-run').onclick = show;
    v.querySelector('#r-csv').onclick = async () => {
      const btn = v.querySelector('#r-csv'); btn.classList.add('busy');
      try {
        const res = await fetch(`${base()}/reports/${id}?${params()}&format=csv`);
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Download failed (${res.status})`); }
        const blob = await res.blob(), a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || `${id}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (er) { toast(er.message, 'err'); }
      btn.classList.remove('busy');
    };
    show();
  };

  // ---- import from StockPilot (Owner only; the server enforces this too)
  PAGES.import = async (v) => {
    const found = await api('/import/detect');
    const st = S.imp = S.imp || { path: '', org: '', pv: null, result: null };
    if (!st.path && found.length) st.path = found[0].path;
    const err = (m) => { const x = v.querySelector('#i-err'); if (x) { x.hidden = !m; x.textContent = m || ''; } };
    const row = (label, s) => `<tr><td>${label}</td><td class="num">${s.total}</td><td class="num">${s.new}</td><td class="num">${s.exists}</td><td class="num">${s.imported}</td><td class="num">${s.invalid}</td></tr>`;
    const list = (title, arr, f) => (arr.length ? `<div class="card mb"><b>${title}</b><ul class="small" style="margin:8px 0 0 18px">${arr.map(f).join('')}</ul></div>` : '');
    const check = async (org) => {
      st.path = v.querySelector('#i-path').value.trim(); st.result = null; err(''); v.querySelector('#i-find').classList.add('busy');
      try { st.pv = await api('/import/preview', { method: 'POST', body: { path: st.path, org_id: org || undefined } }); st.org = org || ''; showPreview(); } catch (e) { st.pv = null; v.querySelector('#i-out').innerHTML = ''; err(e.message); }
      v.querySelector('#i-find').classList.remove('busy');
    };
    const showPreview = () => {
      const d = st.pv, out = v.querySelector('#i-out');
      if (d.step === 'choose_organisation') {
        out.innerHTML = `<div class="card"><b>Which organisation?</b><p class="sub small" style="margin:4px 0 10px">This file holds ${d.organisations.length} organisation(s). Choose the one to bring into RRE.</p><table><thead><tr><th>Organisation</th><th class="num">Items</th><th class="num">Warehouses</th><th class="num">Customers</th><th class="num">Suppliers</th><th></th></tr></thead><tbody>${d.organisations.map((o) => `<tr><td>${esc(o.name)}</td><td class="num">${o.items}</td><td class="num">${o.warehouses}</td><td class="num">${o.customers}</td><td class="num">${o.suppliers}</td><td><button class="btn sm" data-org="${o.id}">Preview</button></td></tr>`).join('')}</tbody></table></div>`;
        out.querySelectorAll('[data-org]').forEach((b) => { b.onclick = () => check(b.dataset.org); }); return;
      }
      const s = d.summary, todo = s.items.new + s.customers.new + s.suppliers.new + s.warehouses.new + s.stock_lines;
      const label = { new: 'Will add', exists: 'Already in RRE', imported: 'Imported before', invalid: 'Skipped' };
      out.innerHTML = `<div class="card mb"><div class="row between"><b>Preview — ${esc(d.organisation.name)}</b><button class="btn flat sm" id="i-other">Choose another organisation</button></div>
        <div class="card scroll-x mt"><table><thead><tr><th></th><th class="num">In file</th><th class="num">Will be added</th><th class="num">Already in RRE</th><th class="num">Imported before</th><th class="num">Skipped</th></tr></thead><tbody>${row('Items', s.items)}${row('Customers', s.customers)}${row('Suppliers', s.suppliers)}${row('Warehouses', s.warehouses)}${row('Categories', s.categories)}${row('Units', s.units)}</tbody></table></div>
        <p class="small" style="margin:10px 0 0">Stock on hand: <b>${s.stock_lines}</b> line(s), <b>${num(s.stock_units)}</b> units, entered as “Opening balance fix” adjustments so they show in Movement history.</p></div>
        ${list('Not imported', d.not_imported, (n) => `<li><b>${esc(n.what)}</b> (${n.count}) — ${esc(n.reason)}</li>`)}
        ${list(`Please note (${d.warnings_total})`, d.warnings, (w) => `<li>${esc(w)}</li>`)}
        ${d.items.length ? `<div class="card mb scroll-x"><b>Items${s.items.total > d.items.length ? ` (first ${d.items.length} of ${s.items.total})` : ''}</b><table class="mt"><thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Unit</th><th>Status</th></tr></thead><tbody>${d.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="mono small">${esc(i.sku || '(new)')}</td><td>${esc(i.category || '')}</td><td>${esc(i.unit || '')}</td><td><span class="badge ${i.status === 'new' ? 'b-ok' : i.status === 'invalid' ? 'b-bad' : 'b-n'}">${label[i.status]}</span>${i.reason ? ` <span class="sub small">${esc(i.reason)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="card"><div class="row between wrap"><span class="small">${todo ? 'Nothing has been written yet. Review the preview, then confirm.' : 'Everything in this file is already in RRE. There is nothing to add.'}</span><button class="btn primary" id="i-run" ${todo ? '' : 'disabled'}>Import now</button></div></div>`;
      out.querySelector('#i-other').onclick = () => check();
      out.querySelector('#i-run').onclick = () => confirmBox('Import from StockPilot?', `This adds ${s.items.new} item(s), ${s.customers.new} customer(s), ${s.suppliers.new} supplier(s), ${s.warehouses.new} warehouse(s) and ${s.stock_lines} stock line(s) to RRE. Existing RRE data is not changed or deleted.`, 'Import', async () => {
        st.result = await api('/import/run', { method: 'POST', body: { path: st.path, org_id: +st.org, confirm: true } }); st.pv = null; toast('Import finished'); showResult();
      });
    };
    const showResult = () => {
      const r = st.result, c = r.created;
      v.querySelector('#i-out').innerHTML = `<div class="card mb"><b>Import finished</b><p class="small" style="margin:8px 0 0">Added <b>${c.items}</b> item(s), <b>${c.customers}</b> customer(s), <b>${c.suppliers}</b> supplier(s), <b>${c.warehouses}</b> warehouse(s), <b>${c.categories}</b> categor${c.categories === 1 ? 'y' : 'ies'}, <b>${c.units}</b> unit(s) and <b>${c.stock_documents}</b> stock document(s). Matched with existing records: ${r.matched.items} item(s), ${r.matched.parties} customer/supplier(s).</p></div>
        ${list(`Could not import (${r.failed.length})`, r.failed, (f) => `<li>${esc(f.kind)} “${esc(f.name)}” — ${esc(f.reason)}</li>`)}
        ${list(`Skipped (${r.skipped.length})`, r.skipped, (f) => `<li>${esc(f.kind)} “${esc(f.name)}” — ${esc(f.reason)}</li>`)}
        ${list('Notes', r.warnings, (w) => `<li>${esc(w)}</li>`)}
        <div class="row"><button class="btn primary" data-go="items">View items</button><button class="btn" data-go="movements">View movement history</button><button class="btn" id="i-again">Import another file</button></div>`;
      v.querySelector('#i-again').onclick = () => { st.result = null; st.pv = null; v.querySelector('#i-out').innerHTML = ''; };
    };
    v.innerHTML = `<div class="sp-wrap"><div class="card mb"><b>Import from StockPilot</b><p class="sub small" style="margin:6px 0 12px">Brings items, categories, units, warehouses, customers, suppliers and stock on hand from your StockPilot database into RRE. The StockPilot file is only read, never changed. You see exactly what will happen before anything is written, and running it again never creates duplicates.</p>
      <label class="lbl">StockPilot database file</label><div class="row"><input class="input grow" id="i-path" value="${esc(st.path)}" placeholder="C:\\…\\stockpilot.db" spellcheck="false"><button class="btn primary" id="i-find">Check file</button></div>
      ${found.length ? `<div class="hint">Found on this computer: ${found.map((f) => `<a href="#" data-p="${esc(f.path)}">${esc(f.path)}</a> (${f.size_mb} MB)`).join(', ')}</div>` : '<div class="hint">Type the full path of stockpilot.db (it is in the inventory app’s backend folder).</div>'}<div class="errtxt" id="i-err" hidden></div></div><div id="i-out"></div></div>`;
    v.querySelector('#i-find').onclick = () => check();
    v.querySelectorAll('a[data-p]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); st.path = a.dataset.p; v.querySelector('#i-path').value = st.path; }; });
    if (st.result) showResult(); else if (st.pv) showPreview();
  };

  window.StockPilotInv = { open, close, go, _state: S };
})();

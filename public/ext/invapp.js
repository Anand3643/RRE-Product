/**
 * RRE Tally — Inventory as its own feature. Three entry points, all opening the ORIGINAL inventory application (see inventory_host.js):
 *   1. an "Inventory" menu in the top ribbon, always visible, listing every inventory feature;
 *   2. a dedicated "Inventory (StockPilot)" section on the Gateway with a direct link to each feature;
 *   3. Go To / Ask AI commands for each feature.
 * The inventory application itself is untouched; this file only adds the entries.
 */
(function () {
  'use strict';
  // paths are the original application's own routes
  const GROUPS = [
    ['Overview', [['Dashboard', '/admin', 'layout-dashboard'], ['Operations', '/', 'activity']]],
    ['Items', [['Items (Products)', '/products', 'package'], ['Adjustments', '/adjustments', 'sliders-horizontal']]],
    ['Sales', [['Customers', '/customers', 'contact'], ['Sales Orders', '/sales-orders', 'shopping-cart'], ['Packages', '/packages', 'box'], ['Shipments', '/shipments', 'truck']]],
    ['Purchases', [['Vendors', '/vendors', 'store'], ['Purchase Orders', '/purchase-orders', 'clipboard-list']]],
    ['Stock', [['Stock levels', '/inventory', 'arrow-left-right'], ['Warehouses', '/warehouses', 'warehouse'], ['Transfers', '/transfers', 'arrow-right-left']]],
    ['Insights', [['Reports', '/reports', 'bar-chart-3'], ['AI Insights', '/insights', 'sparkles']]],
    ['Admin', [['Users', '/team', 'users'], ['Login history', '/login-activity', 'history'], ['Support tickets', '/support', 'life-buoy'], ['Settings', '/settings', 'settings']]]
  ];
  const openInv = (route) => { closeMenu(); if (window.RREInventory) window.RREInventory.open(route || '/'); };
  window.RREInventoryGo = openInv;
  const icons = () => { try { if (window.lucide) window.lucide.createIcons(); } catch (e) { /* decoration */ } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ 1. the ribbon menu
  function closeMenu() { const m = document.getElementById('rre-inv-menu'); if (m) m.style.display = 'none'; const b = document.getElementById('rre-inv-menu-btn'); if (b) b.setAttribute('aria-expanded', 'false'); }
  function toggleMenu() {
    const m = document.getElementById('rre-inv-menu'), b = document.getElementById('rre-inv-menu-btn'); if (!m || !b) return;
    if (m.style.display === 'block') return closeMenu();
    const r = b.getBoundingClientRect();
    m.style.top = Math.round(r.bottom + 4) + 'px'; m.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 580)) + 'px';
    m.style.display = 'block'; b.setAttribute('aria-expanded', 'true'); icons();
  }
  function addRibbonMenu() {
    if (document.getElementById('rre-inv-menu-btn')) return;
    // put it in the first visible ribbon row, next to the AI buttons (the ribbon's centre row is hidden in some builds)
    const btns = Array.from(document.querySelectorAll('#header-ribbon button')).filter((x) => x.offsetParent !== null);
    const ask = ['AI Workspace', 'Alerts', 'AI Copilot', 'Ask AI'].map((t) => btns.find((x) => x.textContent.includes(t))).find(Boolean);
    if (!ask) return;
    const style = document.createElement('style');
    style.textContent = `#rre-inv-menu-btn{display:inline-flex;align-items:center;gap:9px;padding:9px 20px;border-radius:9px;background:linear-gradient(135deg,#f59e0b 0%,#ea580c 100%);color:#fff;font-weight:800;font-size:15px;letter-spacing:.03em;text-transform:uppercase;border:2px solid #fde68a;cursor:pointer;box-shadow:0 0 0 0 rgba(251,191,36,.7),0 4px 14px rgba(234,88,12,.55);animation:rreInvPulse 2.4s ease-out infinite;white-space:nowrap}
#rre-inv-menu-btn:hover{filter:brightness(1.1);transform:translateY(-1px)}#rre-inv-menu-btn:focus-visible{outline:3px solid #fff;outline-offset:2px}
#rre-inv-menu-btn i{width:20px!important;height:20px!important}
@keyframes rreInvPulse{0%{box-shadow:0 0 0 0 rgba(251,191,36,.75),0 4px 14px rgba(234,88,12,.55)}70%{box-shadow:0 0 0 12px rgba(251,191,36,0),0 4px 14px rgba(234,88,12,.55)}100%{box-shadow:0 0 0 0 rgba(251,191,36,0),0 4px 14px rgba(234,88,12,.55)}}
@media (prefers-reduced-motion:reduce){#rre-inv-menu-btn{animation:none}}
#rre-inv-banner{display:flex;align-items:center;gap:14px;width:100%;margin:0 0 8px;padding:14px 18px;border:0;border-radius:11px;background:linear-gradient(135deg,#f59e0b 0%,#ea580c 100%);color:#fff;text-align:left;cursor:pointer;box-shadow:0 6px 18px rgba(234,88,12,.4)}
#rre-inv-banner:hover{filter:brightness(1.08)}#rre-inv-banner b{display:block;font-size:17px;letter-spacing:.04em;text-transform:uppercase}#rre-inv-banner small{display:block;font-size:11.5px;opacity:.95;margin-top:2px}
#rre-inv-banner i{width:34px!important;height:34px!important;flex:none}#rre-inv-banner .go{margin-left:auto;font-weight:800;font-size:13px;background:rgba(255,255,255,.22);padding:7px 14px;border-radius:7px;white-space:nowrap}
#rre-inv-menu{position:fixed;z-index:75;display:none;width:min(560px,calc(100vw - 16px));background:#fff;color:#1f2937;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 18px 40px -8px rgba(15,23,42,.35);padding:12px 14px;font-size:12px}
#rre-inv-menu .hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e2e8f0}
#rre-inv-menu .hd b{font-size:13px}#rre-inv-menu .cols{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 18px}
#rre-inv-menu .g{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:8px 0 2px}
#rre-inv-menu a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:inherit;text-decoration:none;cursor:pointer}
#rre-inv-menu a:hover{background:#ecfdf5;color:#065f46}#rre-inv-menu a i{width:14px;height:14px;color:#0f766e;flex:none}`;
    document.head.appendChild(style);
    const wrap = document.createElement('div'); wrap.className = 'relative'; wrap.id = 'rre-inv-menu-wrap';
    wrap.innerHTML = '<button type="button" id="rre-inv-menu-btn" title="Inventory (StockPilot): products, stock, orders, warehouses, reports" aria-haspopup="true" aria-expanded="false"><i data-lucide="boxes"></i><span>Inventory</span><span aria-hidden="true">▾</span></button>';
    ask.parentNode.insertBefore(wrap, ask);
    const menu = document.createElement('div'); menu.id = 'rre-inv-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="hd"><b>Inventory <span style="font-weight:500;color:#64748b">· StockPilot</span></b><a data-go="/" style="font-weight:600;color:#0f766e">Open Inventory ›</a></div><div class="cols">${GROUPS.map(([g, items]) => `<div><div class="g">${esc(g)}</div>${items.map(([t, p, i]) => `<a role="menuitem" data-go="${esc(p)}"><i data-lucide="${i}"></i>${esc(t)}</a>`).join('')}</div>`).join('')}</div>`;
    document.body.appendChild(menu);
    wrap.querySelector('#rre-inv-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    menu.addEventListener('click', (e) => { const a = e.target.closest('[data-go]'); if (a) openInv(a.dataset.go); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#rre-inv-menu') && !e.target.closest('#rre-inv-menu-btn')) closeMenu(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.style.display === 'block') { closeMenu(); e.stopPropagation(); e.preventDefault(); } }, true);
    window.addEventListener('resize', closeMenu);
    icons();
  }

  // ------------------------------------------------------------------ 2. its own section on the Gateway
  function addGatewaySection() {
    if (document.getElementById('gw-inventory-section') && document.getElementById('rre-inv-banner-wrap')) return;
    if (document.getElementById('gw-inventory-section')) document.getElementById('gw-inventory-section').remove();
    const label = Array.from(document.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Inventory & Statutory' && d.className.includes('uppercase'));
    if (!label || !label.parentElement) return;
    const sec = document.createElement('div'); sec.id = 'gw-inventory-section';
    const row = (t, p, hot, tag) => `<div class="gateway-item" onclick="RREInventoryGo('${p}')"><span>${hot ? `<span class="hotkey">${hot}</span>` : ''}${esc(t)}</span><span class="text-[10px] text-slate-400 font-mono">${esc(tag || '')}</span></div>`;
    sec.innerHTML = `<div class="text-[10px] font-black text-teal-600 uppercase tracking-widest px-3 mb-1">Inventory Management (StockPilot)</div><div class="space-y-0.5">
      ${row('Inventory Dashboard', '/admin', 'M', 'Overview')}${row('Items (Products)', '/products', '', 'Catalogue')}${row('Stock levels', '/inventory', '', 'On hand')}${row('Warehouses', '/warehouses', '', 'Locations')}
      ${row('Stock Transfers', '/transfers', '', 'Between warehouses')}${row('Stock Adjustments', '/adjustments', '', 'Corrections')}${row('Sales Orders', '/sales-orders', '', 'Sell')}${row('Purchase Orders', '/purchase-orders', '', 'Buy')}
      ${row('Customers', '/customers', '', 'Parties')}${row('Vendors', '/vendors', '', 'Parties')}${row('Packages & Shipments', '/shipments', '', 'Dispatch')}${row('Inventory Reports', '/reports', '', 'Reports')}${row('AI Insights', '/insights', '', 'Forecasts')}${row('Inventory Users & Settings', '/team', '', 'Admin')}</div>`;
    const container = label.parentElement.parentElement;
    container.insertBefore(sec, label.parentElement);
    // a big, hard-to-miss entry at the very top of the Gateway menu
    if (!document.getElementById('rre-inv-banner-wrap')) { const wrap = document.createElement('div'); wrap.id = 'rre-inv-banner-wrap'; wrap.innerHTML = `<button type="button" id="rre-inv-banner" onclick="RREInventoryGo('/admin')"><i data-lucide="boxes"></i><span><b>Inventory</b><small>Products · Stock · Orders · Warehouses · Transfers · Reports</small></span><span class="go">Open Inventory ›</span></button>`; container.insertBefore(wrap, container.firstChild); }
    const old = document.getElementById('gw-inventory-suite'); if (old) old.remove();
    icons();
  }

  // ------------------------------------------------------------------ 3. Go To / Ask AI commands
  function addCommands() {
    const add = (arr, entry) => { if (Array.isArray(arr) && !arr.some((x) => x.title === entry.title)) arr.push(entry); };
    try {
      for (const [, items] of GROUPS) for (const [t, p] of items) {
        const title = 'Inventory — ' + t;
        if (typeof GOTO_REGISTRY !== 'undefined') add(GOTO_REGISTRY, { title, category: 'Inventory', action: () => openInv(p), hotkey: '' });
        if (typeof OMNI_COMMANDS !== 'undefined') add(OMNI_COMMANDS, { title, category: 'Inventory', action: () => openInv(p), hotkey: '' });
      }
    } catch (e) { /* the palette entries are a convenience */ }
  }

  function boot() { addRibbonMenu(); addGatewaySection(); addCommands(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('load', boot);
  // the Gateway is rebuilt when the person returns to it: put the section back if it is missing
  setInterval(() => { if (!document.getElementById('gw-inventory-section') || !document.getElementById('rre-inv-banner-wrap')) addGatewaySection(); }, 1500);
})();

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
    style.textContent = `#rre-inv-menu-btn{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:5px;background:#0f766e;color:#fff;font-weight:700;font-size:12px;border:1px solid rgba(255,255,255,.35);cursor:pointer}
#rre-inv-menu-btn:hover{background:#0d9488}
#rre-inv-menu{position:fixed;z-index:75;display:none;width:min(560px,calc(100vw - 16px));background:#fff;color:#1f2937;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 18px 40px -8px rgba(15,23,42,.35);padding:12px 14px;font-size:12px}
#rre-inv-menu .hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e2e8f0}
#rre-inv-menu .hd b{font-size:13px}#rre-inv-menu .cols{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 18px}
#rre-inv-menu .g{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:8px 0 2px}
#rre-inv-menu a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:inherit;text-decoration:none;cursor:pointer}
#rre-inv-menu a:hover{background:#ecfdf5;color:#065f46}#rre-inv-menu a i{width:14px;height:14px;color:#0f766e;flex:none}`;
    document.head.appendChild(style);
    const wrap = document.createElement('div'); wrap.className = 'relative'; wrap.id = 'rre-inv-menu-wrap';
    wrap.innerHTML = '<button type="button" id="rre-inv-menu-btn" title="Inventory (StockPilot): products, stock, orders, warehouses, reports" aria-haspopup="true" aria-expanded="false"><i data-lucide="boxes" style="width:14px;height:14px"></i><span>Inventory</span><span aria-hidden="true">▾</span></button>';
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
    if (document.getElementById('gw-inventory-section')) return;
    const label = Array.from(document.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Inventory & Statutory' && d.className.includes('uppercase'));
    if (!label || !label.parentElement) return;
    const sec = document.createElement('div'); sec.id = 'gw-inventory-section';
    const row = (t, p, hot, tag) => `<div class="gateway-item" onclick="RREInventoryGo('${p}')"><span>${hot ? `<span class="hotkey">${hot}</span>` : ''}${esc(t)}</span><span class="text-[10px] text-slate-400 font-mono">${esc(tag || '')}</span></div>`;
    sec.innerHTML = `<div class="text-[10px] font-black text-teal-600 uppercase tracking-widest px-3 mb-1">Inventory Management (StockPilot)</div><div class="space-y-0.5">
      ${row('Inventory Dashboard', '/admin', 'M', 'Overview')}${row('Items (Products)', '/products', '', 'Catalogue')}${row('Stock levels', '/inventory', '', 'On hand')}${row('Warehouses', '/warehouses', '', 'Locations')}
      ${row('Stock Transfers', '/transfers', '', 'Between warehouses')}${row('Stock Adjustments', '/adjustments', '', 'Corrections')}${row('Sales Orders', '/sales-orders', '', 'Sell')}${row('Purchase Orders', '/purchase-orders', '', 'Buy')}
      ${row('Customers', '/customers', '', 'Parties')}${row('Vendors', '/vendors', '', 'Parties')}${row('Packages & Shipments', '/shipments', '', 'Dispatch')}${row('Inventory Reports', '/reports', '', 'Reports')}${row('AI Insights', '/insights', '', 'Forecasts')}${row('Inventory Users & Settings', '/team', '', 'Admin')}</div>`;
    label.parentElement.parentElement.insertBefore(sec, label.parentElement);
    const old = document.getElementById('gw-inventory-suite'); if (old) old.remove();
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
  setInterval(() => { if (!document.getElementById('gw-inventory-section')) addGatewaySection(); }, 1500);
})();

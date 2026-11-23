/**
 * RRE Tally — entry points to the Inventory workspace (StockPilot features): a Gateway menu item and Alt+G / Ctrl+K commands.
 * The workspace itself is public/inv/inv.js; nothing else in RRE changes.
 */
(function () {
  'use strict';
  // The Inventory entry opens the ORIGINAL inventory application (public/ext/inventory_host.js). `route` is a path inside that application.
  function openInv(route) { if (window.RREInventory) window.RREInventory.open(route || '/'); }

  function addGatewayItem() {
    const host = Array.from(document.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Inventory & Statutory' && d.className.includes('uppercase'));
    if (!host || document.getElementById('gw-inventory-suite')) return;
    const list = host.nextElementSibling; if (!list) return;
    const item = document.createElement('div');
    item.id = 'gw-inventory-suite'; item.className = 'gateway-item'; item.setAttribute('onclick', "RREInventory.open('/')");
    item.innerHTML = '<span><span class="hotkey">M</span>Inventory Management (Products, Stock, Orders, Warehouses, Reports)</span><span class="text-[10px] text-slate-400 font-mono">StockPilot</span>';
    list.insertBefore(item, list.firstChild);
  }

  function addCommands() {
    const add = (arr, entry) => { if (Array.isArray(arr) && !arr.some((x) => x.title === entry.title)) arr.push(entry); };
    try {
      const cmds = [['Inventory Management — Dashboard', '/'], ['Inventory — Products', '/products'], ['Inventory — Stock', '/inventory'], ['Inventory — Warehouses', '/warehouses'], ['Inventory — Stock Transfers', '/transfers'], ['Inventory — Stock Adjustments', '/adjustments'], ['Inventory — Sales Orders', '/sales-orders'], ['Inventory — Purchase Orders', '/purchase-orders'], ['Inventory — Customers', '/customers'], ['Inventory — Suppliers', '/vendors'], ['Inventory — Shipments', '/shipments'], ['Inventory — Reports', '/reports'], ['Inventory — Insights', '/insights'], ['Inventory — Users & Team', '/team']];
      for (const [title, route] of cmds) {
        if (typeof GOTO_REGISTRY !== 'undefined') add(GOTO_REGISTRY, { title, category: 'Inventory', action: () => openInv(route), hotkey: '' });
        if (typeof OMNI_COMMANDS !== 'undefined') add(OMNI_COMMANDS, { title, category: 'Inventory', action: () => openInv(route), hotkey: '' });
      }
    } catch (e) { /* the palette entries are a convenience */ }
  }

  function boot() { addGatewayItem(); addCommands(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('load', boot);
})();

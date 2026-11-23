/**
 * RRE Tally — entry points to the Inventory workspace (StockPilot features): a Gateway menu item and Alt+G / Ctrl+K commands.
 * The workspace itself is public/inv/inv.js; nothing else in RRE changes.
 */
(function () {
  'use strict';
  function openInv(route) { if (!window.StockPilotInv) return; if (Array.isArray(route)) window.StockPilotInv.open(route[0], route[1]); else window.StockPilotInv.open(route || 'dashboard'); }

  function addGatewayItem() {
    const host = Array.from(document.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Inventory & Statutory' && d.className.includes('uppercase'));
    if (!host || document.getElementById('gw-inventory-suite')) return;
    const list = host.nextElementSibling; if (!list) return;
    const item = document.createElement('div');
    item.id = 'gw-inventory-suite'; item.className = 'gateway-item'; item.setAttribute('onclick', "StockPilotInv.open('dashboard')");
    item.innerHTML = '<span><span class="hotkey">M</span>Inventory Management (Items, Warehouses, Transfers)</span><span class="text-[10px] text-slate-400 font-mono">Workspace</span>';
    list.insertBefore(item, list.firstChild);
  }

  function addCommands() {
    const add = (arr, entry) => { if (Array.isArray(arr) && !arr.some((x) => x.title === entry.title)) arr.push(entry); };
    try {
      const cmds = [['Inventory Management — Dashboard', 'dashboard'], ['Inventory — Items', 'items'], ['Inventory — Warehouses', 'warehouses'], ['Inventory — Stock Transfers', 'transfers'], ['Inventory — Stock Adjustments', 'adjustments'], ['Inventory — Movement History', 'movements'], ['Inventory — Low Stock Alerts', 'alerts'], ['Inventory — Sales Orders', 'sales-orders'], ['Inventory — Purchase Orders', 'purchase-orders'], ['Inventory — Customers', 'customers'], ['Inventory — Suppliers', 'suppliers'], ['Inventory — Sales History', 'sales-history'], ['Inventory — Purchase History', 'purchase-history'], ['Inventory — Reports', 'reports'], ['Inventory — Stock Valuation Report', ['report', 'stock-valuation']], ['Inventory — Import from StockPilot', 'import']];
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

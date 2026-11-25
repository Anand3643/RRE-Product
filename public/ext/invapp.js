/**
 * RRE Tally — entry points to RRE Inventory (RRE's own inventory screens on the company's books, see inventory_host.js and inv/inv.js).
 *   - In the Aurora theme Inventory lives in the side rail only (an expandable entry listing its features; see theme/aurora.js).
 *   - Go To (Alt+G) / Ask AI commands for every inventory feature, in every theme.
 *   - Older themes have no side rail, so they keep a dedicated Inventory section on the Gateway (hidden in Aurora).
 */
(function () {
  'use strict';
  // paths are the original application's own routes
  const GROUPS = [
    ['Overview', [['Dashboard', '/admin'], ['Low stock alerts', '/alerts']]],
    ['Items', [['Items', '/products'], ['Categories', '/categories'], ['Units', '/units']]],
    ['Sales', [['Customers', '/customers'], ['Sales Orders', '/sales-orders'], ['Sales history', '/sales-history']]],
    ['Purchases', [['Suppliers', '/vendors'], ['Purchase Orders', '/purchase-orders'], ['Purchase history', '/purchase-history']]],
    ['Stock', [['Stock levels', '/inventory'], ['Movement history', '/movements'], ['Warehouses', '/warehouses'], ['Transfers', '/transfers'], ['Adjustments', '/adjustments']]],
    ['Insights', [['Reports', '/reports']]]
  ];
  const openInv = (route) => { if (window.RREInventory) window.RREInventory.open(route || '/'); };
  window.RREInventoryGo = openInv;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ Gateway section (themes without the side rail)
  function addGatewaySection() {
    if (document.getElementById('gw-inventory-section')) return;
    const label = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent.trim() === 'Inventory & Statutory' || d.textContent.trim() === 'RRE Inventory & Statutory') && d.className.includes('uppercase'));
    if (!label || !label.parentElement) return;
    const sec = document.createElement('div'); sec.id = 'gw-inventory-section';
    const row = (t, p, hot, tag) => `<div class="gateway-item" onclick="RREInventoryGo('${p}')"><span>${hot ? `<span class="hotkey">${hot}</span>` : ''}${esc(t)}</span><span class="text-[10px] text-slate-400 font-mono">${esc(tag || '')}</span></div>`;
    sec.innerHTML = `<div class="text-[10px] font-black text-teal-600 uppercase tracking-widest px-3 mb-1">RRE Inventory</div><div class="space-y-0.5">
      ${row('RRE Inventory Dashboard', '/admin', 'M', 'Overview')}${row('Items', '/products', '', 'Catalogue')}${row('Stock levels', '/inventory', '', 'On hand')}${row('Warehouses', '/warehouses', '', 'Locations')}${row('Stock Transfers', '/transfers', '', 'Between warehouses')}${row('Stock Adjustments', '/adjustments', '', 'Corrections')}${row('Sales Orders', '/sales-orders', '', 'Sell')}${row('Purchase Orders', '/purchase-orders', '', 'Buy')}${row('Customers', '/customers', '', 'Parties')}${row('Suppliers', '/vendors', '', 'Parties')}${row('Inventory Reports', '/reports', '', 'Reports')}</div>`;
    label.parentElement.parentElement.insertBefore(sec, label.parentElement);
    const old = document.getElementById('gw-inventory-suite'); if (old) old.remove();
  }

  // ------------------------------------------------------------------ Go To / Ask AI commands
  function addCommands() {
    const add = (arr, entry) => { if (Array.isArray(arr) && !arr.some((x) => x.title === entry.title)) arr.push(entry); };
    try {
      for (const [, items] of GROUPS) for (const [t, p] of items) {
        const title = 'RRE Inventory — ' + t;
        if (typeof GOTO_REGISTRY !== 'undefined') add(GOTO_REGISTRY, { title, category: 'RRE Inventory', action: () => openInv(p), hotkey: '' });
        if (typeof OMNI_COMMANDS !== 'undefined') add(OMNI_COMMANDS, { title, category: 'RRE Inventory', action: () => openInv(p), hotkey: '' });
      }
    } catch (e) { /* the palette entries are a convenience */ }
  }

  function boot() { addGatewaySection(); addCommands(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('load', boot);
  // the Gateway is rebuilt when the person returns to it: put the section back if it is missing
  setInterval(() => { if (!document.getElementById('gw-inventory-section')) addGatewaySection(); }, 1500);
})();

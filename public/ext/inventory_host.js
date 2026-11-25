/**
 * RRE Inventory — one feature of RRE, not a separate application.
 * Every "RRE Inventory" entry (side bar, its feature list, Gateway, Go To / Ask AI, dashboard links) opens RRE's own inventory screens
 * (public/inv/inv.js). They work directly on the company's books: the same database, the same stock items, customers (Sundry
 * Debtors) and suppliers (Sundry Creditors) as the accounts; a sales or purchase order becomes a voucher at once, a transfer or an
 * adjustment changes the stock the reports show at once. Nothing is copied or synchronised.
 * Older entry points pass the former inventory application's addresses (/products, /vendors, ...): they are mapped to the same screens.
 */
(function () {
  'use strict';
  if (window.RREInventory) return;
  const MAP = {
    '/': 'dashboard', '/admin': 'dashboard', '/insights': 'dashboard', '/products': 'items', '/inventory': 'stock', '/vendors': 'suppliers',
    '/packages': 'sales-orders', '/shipments': 'sales-orders', '/warehouses': 'warehouses', '/transfers': 'transfers', '/adjustments': 'adjustments',
    '/sales-orders': 'sales-orders', '/purchase-orders': 'purchase-orders', '/customers': 'customers', '/reports': 'reports'
  };
  const route = (p) => {
    if (!p) return 'dashboard';
    const k = String(p).split('?')[0].replace(/\/+$/, '') || '/';
    return MAP[k] || k.replace(/^\//, '');
  };
  const screen = () => document.getElementById('sp-app');
  function open(path) { if (window.StockPilotInv) window.StockPilotInv.open(route(path)); document.dispatchEvent(new CustomEvent('rre-inventory')); }
  function close() { if (window.StockPilotInv) window.StockPilotInv.close(); }
  function isOpen() { const el = screen(); return !!(el && el.classList.contains('open')); }
  window.RREInventory = { open, close, reset: close, signOut: close, isOpen, route };
})();

// TallyPrime Web Edition — Core Application Controller

const API_BASE = '/api';

// Global State
let state = {
  currentView: 'gateway',
  groups: [],
  ledgers: [],
  stockItems: [],
  activeVoucherType: 'Sales',
  companyInfo: null
};

// Currency & Date Formatters
const formatINR = (val) => {
  const num = parseFloat(val) || 0;
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatDate = (dateStr) => {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
};

// Document Ready Initialization
document.addEventListener('DOMContentLoaded', () => {
  initKeyboardShortcuts();
  loadGatewayInfo();
  loadMasters();
});

// ==========================================
// 1. KEYBOARD NAVIGATION & SHORTCUTS (TALLY UX)
// ==========================================
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // If user is currently typing in an input/textarea/select, don't trigger global hotkeys
    const tag = e.target.tagName.toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';

    // F-Keys (Work everywhere)
    if (e.key === 'F4') { e.preventDefault(); openVoucherScreen('Contra'); }
    else if (e.key === 'F5') { e.preventDefault(); openVoucherScreen('Payment'); }
    else if (e.key === 'F6') { e.preventDefault(); openVoucherScreen('Receipt'); }
    else if (e.key === 'F7') { e.preventDefault(); openVoucherScreen('Journal'); }
    else if (e.key === 'F8') { e.preventDefault(); openVoucherScreen('Sales'); }
    else if (e.key === 'F9') { e.preventDefault(); openVoucherScreen('Purchase'); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      // If modal is open, close it; else go back to Gateway
      const openModal = document.querySelector('.fixed:not(.hidden)');
      if (openModal) {
        openModal.classList.add('hidden');
      } else {
        showGateway();
      }
    }

    // Hotkeys when on Gateway of Tally (and not typing)
    if (!isTyping && state.currentView === 'gateway') {
      const k = e.key.toLowerCase();
      if (k === 'v') openVoucherScreen('Sales');
      else if (k === 'b') openReport('balance-sheet');
      else if (k === 'p') openReport('profit-loss');
      else if (k === 't') openReport('trial-balance');
      else if (k === 'd') openReport('daybook');
      else if (k === 's') openReport('stock-summary');
      else if (k === 'c') openModal('createLedgerModal');
    }
  });
}

// ==========================================
// 2. VIEW CONTROLLERS
// ==========================================
function hideAllViews() {
  const views = [
    'view-gateway',
    'view-voucher',
    'view-balance-sheet',
    'view-profit-loss',
    'view-trial-balance',
    'view-daybook',
    'view-stock-summary',
    'view-ledger-statement'
  ];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  document.querySelectorAll('.fn-btn').forEach(btn => btn.classList.remove('active'));
}

function showGateway() {
  hideAllViews();
  state.currentView = 'gateway';
  document.getElementById('view-gateway').classList.remove('hidden');
  loadGatewayInfo();
}

function openReport(reportType) {
  hideAllViews();
  state.currentView = reportType;
  const viewId = `view-${reportType}`;
  const el = document.getElementById(viewId);
  if (el) el.classList.remove('hidden');

  if (reportType === 'balance-sheet') loadBalanceSheet();
  else if (reportType === 'profit-loss') loadProfitLoss();
  else if (reportType === 'trial-balance') loadTrialBalance();
  else if (reportType === 'daybook') loadDayBook();
  else if (reportType === 'stock-summary') loadStockSummary();
  else if (reportType === 'chart-accounts') {
    // Open Ledger Statement for first ledger
    if (state.ledgers.length > 0) openLedgerStatement(state.ledgers[0].id);
  }
}

// Load Gateway Info
async function loadGatewayInfo() {
  try {
    const res = await fetch(`${API_BASE}/gateway/info`);
    const json = await res.json();
    if (!json.success) return;

    state.companyInfo = json.data.company;
    document.getElementById('top-current-date').innerText = formatDate(json.data.current_date);
    document.getElementById('gateway-date').innerText = formatDate(json.data.current_date);
    document.getElementById('gateway-last-voucher').innerText = json.data.last_voucher
      ? `${json.data.last_voucher.voucher_no} (${formatDate(json.data.last_voucher.date)})`
      : 'None';
    document.getElementById('gateway-vouchers-count').innerText = json.data.total_vouchers;
  } catch (err) {
    console.error('Failed to load gateway info:', err);
  }
}

// Load Ledgers, Groups & Stock Items Masters
async function loadMasters() {
  try {
    const [groupsRes, ledgersRes, itemsRes] = await Promise.all([
      fetch(`${API_BASE}/masters/groups`),
      fetch(`${API_BASE}/masters/ledgers`),
      fetch(`${API_BASE}/masters/stock-items`)
    ]);

    const groupsJson = await groupsRes.json();
    const ledgersJson = await ledgersRes.json();
    const itemsJson = await itemsRes.json();

    if (groupsJson.success) state.groups = groupsJson.data;
    if (ledgersJson.success) state.ledgers = ledgersJson.data;
    if (itemsJson.success) state.stockItems = itemsJson.data;

    // Populate Master Create Ledger Group Select
    const grpSelect = document.getElementById('m-ledger-group');
    if (grpSelect) {
      grpSelect.innerHTML = state.groups.map(g => `<option value="${g.id}">${g.name} (${g.nature})</option>`).join('');
    }

    // Populate Khata dropdown
    const khataSelect = document.getElementById('khata-ledger-select');
    if (khataSelect) {
      khataSelect.innerHTML = state.ledgers.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
    }
  } catch (err) {
    console.error('Failed to load masters:', err);
  }
}

// ==========================================
// 3. VOUCHER CREATION ENGINE (F4 TO F9)
// ==========================================
function openVoucherScreen(voucherType = 'Sales') {
  hideAllViews();
  state.currentView = 'voucher';
  state.activeVoucherType = voucherType;

  const view = document.getElementById('view-voucher');
  if (view) view.classList.remove('hidden');

  switchVoucherType(voucherType);
}

function switchVoucherType(type) {
  state.activeVoucherType = type;
  document.getElementById('v-select-type').value = type;

  // Active Function Button highlight
  document.querySelectorAll('.fn-btn').forEach(btn => btn.classList.remove('active'));
  const fnMap = { Contra: 'fn-contra', Payment: 'fn-payment', Receipt: 'fn-receipt', Journal: 'fn-journal', Sales: 'fn-sales', Purchase: 'fn-purchase' };
  const activeBtn = document.getElementById(fnMap[type]);
  if (activeBtn) activeBtn.classList.add('active');

  // Title & Badges
  const typeTitles = {
    Sales: 'F8: Sales (Tax Invoice)',
    Purchase: 'F9: Purchase (Inward Bill)',
    Payment: 'F5: Payment Voucher',
    Receipt: 'F6: Receipt Voucher',
    Contra: 'F4: Contra Voucher',
    Journal: 'F7: Journal Entry'
  };
  document.getElementById('v-type-badge').innerText = typeTitles[type] || type;
  document.getElementById('v-title').innerText = `${type} Voucher Creation`;

  // Auto Generate Voucher Number & Set Date
  const prefix = type.toUpperCase().slice(0, 3);
  document.getElementById('v-no').value = `RRE/${prefix}/${Date.now().toString().slice(-4)}`;
  document.getElementById('v-date').value = new Date().toISOString().split('T')[0];

  // Set default Double-Entry Rows based on Voucher Type
  setupDefaultVoucherRows(type);

  // Show/Hide Inventory Section (Relevant for Sales & Purchase)
  const invSection = document.getElementById('voucher-inventory-section');
  if (invSection) {
    if (type === 'Sales' || type === 'Purchase') {
      invSection.classList.remove('hidden');
      document.getElementById('voucher-inventory-tbody').innerHTML = '';
      addInventoryRow();
    } else {
      invSection.classList.add('hidden');
    }
  }
}

function setupDefaultVoucherRows(type) {
  const tbody = document.getElementById('voucher-entries-tbody');
  tbody.innerHTML = '';

  if (type === 'Payment') {
    // Dr. Expense/Party, Cr. Bank/Cash
    addDoubleEntryRow('Dr');
    addDoubleEntryRow('Cr', findLedgerIdByName('HDFC Bank Current A/c'));
  } else if (type === 'Receipt') {
    // Dr. Bank/Cash, Cr. Party
    addDoubleEntryRow('Dr', findLedgerIdByName('HDFC Bank Current A/c'));
    addDoubleEntryRow('Cr');
  } else if (type === 'Contra') {
    // Dr. Cash, Cr. Bank (or vice-versa)
    addDoubleEntryRow('Dr', findLedgerIdByName('Cash'));
    addDoubleEntryRow('Cr', findLedgerIdByName('HDFC Bank Current A/c'));
  } else if (type === 'Sales') {
    // Dr. Customer, Cr. Sales Account, Cr. Output CGST 9%, Cr. Output SGST 9%
    addDoubleEntryRow('Dr'); // Customer
    addDoubleEntryRow('Cr', findLedgerIdByName('Sales Account - Compressors'));
    addDoubleEntryRow('Cr', findLedgerIdByName('Output CGST 9%'));
    addDoubleEntryRow('Cr', findLedgerIdByName('Output SGST 9%'));
  } else if (type === 'Purchase') {
    // Dr. Purchase Account, Dr. Input CGST 9%, Dr. Input SGST 9%, Cr. Vendor
    addDoubleEntryRow('Dr', findLedgerIdByName('Purchase Account - Spares & Machines'));
    addDoubleEntryRow('Dr', findLedgerIdByName('Input CGST 9%'));
    addDoubleEntryRow('Dr', findLedgerIdByName('Input SGST 9%'));
    addDoubleEntryRow('Cr'); // Vendor
  } else {
    // General Journal
    addDoubleEntryRow('Dr');
    addDoubleEntryRow('Cr');
  }

  recalculateVoucherTotals();
}

function findLedgerIdByName(name) {
  const l = state.ledgers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return l ? l.id : '';
}

function addDoubleEntryRow(defaultType = 'Dr', defaultLedgerId = '') {
  const tbody = document.getElementById('voucher-entries-tbody');
  const rowId = 'dr-cr-' + Date.now() + Math.random().toString(36).substr(2, 4);

  const ledgerOptions = state.ledgers.map(l => `
    <option value="${l.id}" ${l.id == defaultLedgerId ? 'selected' : ''}>
      ${l.name} (${l.group_name})
    </option>
  `).join('');

  const html = `
    <tr id="${rowId}" class="hover:bg-slate-50 transition text-xs">
      <td class="p-2 text-center">
        <select class="row-type border border-slate-300 rounded p-1 font-bold ${defaultType === 'Dr' ? 'text-blue-700' : 'text-red-700'}" onchange="onRowTypeChange('${rowId}', this)">
          <option value="Dr" ${defaultType === 'Dr' ? 'selected' : ''}>Dr</option>
          <option value="Cr" ${defaultType === 'Cr' ? 'selected' : ''}>Cr</option>
        </select>
      </td>
      <td class="p-2">
        <select class="row-ledger w-full border border-slate-300 rounded p-1.5 bg-white font-medium">
          <option value="">-- Select Ledger Account --</option>
          ${ledgerOptions}
        </select>
      </td>
      <td class="p-2">
        <input type="number" step="any" min="0" placeholder="0.00" class="row-dr w-full border border-slate-300 rounded p-1.5 text-right font-mono ${defaultType === 'Cr' ? 'bg-slate-100 text-slate-400' : 'bg-white font-bold'}" ${defaultType === 'Cr' ? 'disabled' : ''} oninput="recalculateVoucherTotals()">
      </td>
      <td class="p-2">
        <input type="number" step="any" min="0" placeholder="0.00" class="row-cr w-full border border-slate-300 rounded p-1.5 text-right font-mono ${defaultType === 'Dr' ? 'bg-slate-100 text-slate-400' : 'bg-white font-bold'}" ${defaultType === 'Dr' ? 'disabled' : ''} oninput="recalculateVoucherTotals()">
      </td>
      <td class="p-2 text-center">
        <button type="button" onclick="document.getElementById('${rowId}').remove(); recalculateVoucherTotals();" class="text-slate-400 hover:text-red-600 font-bold">✕</button>
      </td>
    </tr>
  `;

  tbody.insertAdjacentHTML('beforeend', html);
}

function onRowTypeChange(rowId, selectEl) {
  const row = document.getElementById(rowId);
  if (!row) return;

  const isDr = selectEl.value === 'Dr';
  const drInput = row.querySelector('.row-dr');
  const crInput = row.querySelector('.row-cr');

  if (isDr) {
    drInput.disabled = false;
    drInput.classList.remove('bg-slate-100', 'text-slate-400');
    drInput.classList.add('bg-white', 'font-bold');

    crInput.value = '';
    crInput.disabled = true;
    crInput.classList.add('bg-slate-100', 'text-slate-400');
    crInput.classList.remove('bg-white', 'font-bold');
  } else {
    crInput.disabled = false;
    crInput.classList.remove('bg-slate-100', 'text-slate-400');
    crInput.classList.add('bg-white', 'font-bold');

    drInput.value = '';
    drInput.disabled = true;
    drInput.classList.add('bg-slate-100', 'text-slate-400');
    drInput.classList.remove('bg-white', 'font-bold');
  }

  recalculateVoucherTotals();
}

function recalculateVoucherTotals() {
  const rows = document.querySelectorAll('#voucher-entries-tbody tr');
  let totalDr = 0;
  let totalCr = 0;

  rows.forEach(r => {
    const dr = parseFloat(r.querySelector('.row-dr')?.value) || 0;
    const cr = parseFloat(r.querySelector('.row-cr')?.value) || 0;
    totalDr += dr;
    totalCredit = totalCr += cr;
  });

  document.getElementById('v-total-dr').innerText = formatINR(totalDr);
  document.getElementById('v-total-cr').innerText = formatINR(totalCr);

  const diff = Math.abs(totalDr - totalCr);
  const ind = document.getElementById('v-balance-indicator');
  const btn = document.getElementById('btn-save-voucher');

  if (diff < 0.05 && totalDr > 0) {
    ind.className = 'text-xs font-bold px-3 py-1 rounded bg-emerald-100 text-emerald-800';
    ind.innerText = '✓ Balanced (Dr = Cr)';
    btn.disabled = false;
    btn.classList.remove('opacity-50', 'cursor-not-allowed');
  } else {
    ind.className = 'text-xs font-bold px-3 py-1 rounded bg-red-100 text-red-700';
    ind.innerText = `Out of Balance! Difference: ₹${diff.toFixed(2)}`;
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
  }
}

// Inventory rows for Sales/Purchase
function addInventoryRow() {
  const tbody = document.getElementById('voucher-inventory-tbody');
  const rowId = 'inv-' + Date.now() + Math.random().toString(36).substr(2, 4);

  const itemOptions = state.stockItems.map(it => `
    <option value="${it.id}" data-price="${it.standard_price || it.opening_rate || 0}">
      ${it.name} (${it.uom_symbol})
    </option>
  `).join('');

  const html = `
    <tr id="${rowId}" class="text-xs">
      <td class="p-2">
        <select onchange="onStockItemChange('${rowId}', this)" class="w-full border border-slate-300 rounded p-1 bg-white">
          <option value="">-- Select Stock Item --</option>
          ${itemOptions}
        </select>
      </td>
      <td class="p-2">
        <input type="number" step="any" min="1" value="1" placeholder="Qty" oninput="calcItemAmount('${rowId}')" class="inv-qty w-full border border-slate-300 rounded p-1 text-center font-bold">
      </td>
      <td class="p-2">
        <input type="number" step="any" min="0" placeholder="0.00" oninput="calcItemAmount('${rowId}')" class="inv-rate w-full border border-slate-300 rounded p-1 text-right font-mono">
      </td>
      <td class="p-2">
        <input type="text" readonly placeholder="0.00" class="inv-amount w-full border border-slate-200 bg-slate-50 rounded p-1 text-right font-mono font-bold text-slate-800">
      </td>
      <td class="p-2 text-center">
        <button type="button" onclick="document.getElementById('${rowId}').remove(); autoCalculateSalesTaxes();" class="text-slate-400 hover:text-red-600 font-bold">✕</button>
      </td>
    </tr>
  `;

  tbody.insertAdjacentHTML('beforeend', html);
}

function onStockItemChange(rowId, selectEl) {
  const row = document.getElementById(rowId);
  const opt = selectEl.options[selectEl.selectedIndex];
  if (opt && opt.value) {
    const price = opt.getAttribute('data-price') || 0;
    row.querySelector('.inv-rate').value = price;
    calcItemAmount(rowId);
  }
}

function calcItemAmount(rowId) {
  const row = document.getElementById(rowId);
  const qty = parseFloat(row.querySelector('.inv-qty').value) || 0;
  const rate = parseFloat(row.querySelector('.inv-rate').value) || 0;
  const amt = qty * rate;
  row.querySelector('.inv-amount').value = amt.toFixed(2);

  autoCalculateSalesTaxes();
}

// Auto populate Double Entry rows when item invoice changes!
function autoCalculateSalesTaxes() {
  if (state.activeVoucherType !== 'Sales' && state.activeVoucherType !== 'Purchase') return;

  let totalItemValue = 0;
  document.querySelectorAll('#voucher-inventory-tbody tr').forEach(r => {
    const val = parseFloat(r.querySelector('.inv-amount')?.value) || 0;
    totalItemValue += val;
  });

  if (totalItemValue <= 0) return;

  const cgst = totalItemValue * 0.09;
  const sgst = totalItemValue * 0.09;
  const grandTotal = totalItemValue + cgst + sgst;

  const rows = document.querySelectorAll('#voucher-entries-tbody tr');

  if (state.activeVoucherType === 'Sales') {
    // Row 0: Customer (Dr)
    if (rows[0]) rows[0].querySelector('.row-dr').value = grandTotal.toFixed(2);
    // Row 1: Sales Account (Cr)
    if (rows[1]) rows[1].querySelector('.row-cr').value = totalItemValue.toFixed(2);
    // Row 2: Output CGST (Cr)
    if (rows[2]) rows[2].querySelector('.row-cr').value = cgst.toFixed(2);
    // Row 3: Output SGST (Cr)
    if (rows[3]) rows[3].querySelector('.row-cr').value = sgst.toFixed(2);
  } else if (state.activeVoucherType === 'Purchase') {
    // Row 0: Purchase Account (Dr)
    if (rows[0]) rows[0].querySelector('.row-dr').value = totalItemValue.toFixed(2);
    // Row 1: Input CGST (Dr)
    if (rows[1]) rows[1].querySelector('.row-dr').value = cgst.toFixed(2);
    // Row 2: Input SGST (Dr)
    if (rows[2]) rows[2].querySelector('.row-dr').value = sgst.toFixed(2);
    // Row 3: Vendor (Cr)
    if (rows[3]) rows[3].querySelector('.row-cr').value = grandTotal.toFixed(2);
  }

  recalculateVoucherTotals();
}

// Save Voucher Handler
async function handleSaveVoucher(e) {
  e.preventDefault();

  const voucherType = document.getElementById('v-select-type').value;
  const voucherNo = document.getElementById('v-no').value;
  const voucherDate = document.getElementById('v-date').value;
  const refNo = document.getElementById('v-ref').value;
  const narration = document.getElementById('v-narration').value;

  const entryRows = document.querySelectorAll('#voucher-entries-tbody tr');
  const entries = [];

  entryRows.forEach(r => {
    const ledgerId = r.querySelector('.row-ledger').value;
    const type = r.querySelector('.row-type').value;
    const dr = parseFloat(r.querySelector('.row-dr').value) || 0;
    const cr = parseFloat(r.querySelector('.row-cr').value) || 0;

    if (ledgerId && (dr > 0 || cr > 0)) {
      entries.push({
        ledger_id: ledgerId,
        debit_amount: dr,
        credit_amount: cr,
        entry_type: type
      });
    }
  });

  if (entries.length < 2) {
    return alert('Please specify at least 2 double-entry ledger lines with amounts');
  }

  // Inventory entries
  const inventory = [];
  document.querySelectorAll('#voucher-inventory-tbody tr').forEach(r => {
    const itemId = r.querySelector('select')?.value;
    const qty = parseFloat(r.querySelector('.inv-qty')?.value) || 0;
    const rate = parseFloat(r.querySelector('.inv-rate')?.value) || 0;
    if (itemId && qty > 0) {
      inventory.push({ stock_item_id: itemId, quantity: qty, rate });
    }
  });

  const payload = {
    voucher_type: voucherType,
    voucher_no: voucherNo,
    date: voucherDate,
    reference_no: refNo,
    narration,
    party_ledger_id: entries[0].ledger_id,
    entries,
    inventory
  };

  try {
    const res = await fetch(`${API_BASE}/vouchers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      alert(`Success! ${json.message}`);
      showGateway();
    } else {
      alert(json.error || 'Failed to post voucher');
    }
  } catch (err) {
    alert('Error posting voucher: ' + err.message);
  }
}

// ==========================================
// 4. STATUTORY TALLY REPORTS
// ==========================================

// 4A. Balance Sheet
async function loadBalanceSheet() {
  try {
    const res = await fetch(`${API_BASE}/reports/balance-sheet`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    // Render Liabilities
    const lDiv = document.getElementById('bs-liabilities-content');
    let lHtml = `
      <div>
        <div class="flex justify-between font-bold text-slate-900 border-b border-slate-200 pb-1">
          <span>Capital Account</span>
          <span class="font-mono">${formatINR(d.liabilities.capital_total + d.liabilities.net_profit)}</span>
        </div>
        <div class="pl-3 pt-1 space-y-0.5 text-slate-600">
          ${d.liabilities.capital_items.map(i => `<div class="flex justify-between"><span>${i.name}</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>`).join('')}
          <div class="flex justify-between text-emerald-700 font-semibold">
            <span>Add: Nett Profit (from P&amp;L)</span>
            <span class="font-mono">+${formatINR(d.liabilities.net_profit)}</span>
          </div>
        </div>
      </div>

      <div>
        <div class="flex justify-between font-bold text-slate-900 border-b border-slate-200 pb-1">
          <span>Loans (Liability)</span>
          <span class="font-mono">${formatINR(d.liabilities.loans_total)}</span>
        </div>
        <div class="pl-3 pt-1 space-y-0.5 text-slate-600">
          ${d.liabilities.loans_items.map(i => `<div class="flex justify-between"><span>${i.name}</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>`).join('')}
        </div>
      </div>

      <div>
        <div class="flex justify-between font-bold text-slate-900 border-b border-slate-200 pb-1">
          <span>Current Liabilities</span>
          <span class="font-mono">${formatINR(d.liabilities.current_liabilities_total)}</span>
        </div>
        <div class="pl-3 pt-1 space-y-0.5 text-slate-600">
          ${d.liabilities.current_liabilities_items.map(i => `<div class="flex justify-between"><span>${i.name} (${i.group_name})</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>`).join('')}
        </div>
      </div>
    `;
    lDiv.innerHTML = lHtml;
    document.getElementById('bs-total-liabilities').innerText = formatINR(d.liabilities.total);

    // Render Assets
    const aDiv = document.getElementById('bs-assets-content');
    let aHtml = `
      <div>
        <div class="flex justify-between font-bold text-slate-900 border-b border-slate-200 pb-1">
          <span>Fixed Assets</span>
          <span class="font-mono">${formatINR(d.assets.fixed_assets_total)}</span>
        </div>
        <div class="pl-3 pt-1 space-y-0.5 text-slate-600">
          ${d.assets.fixed_assets_items.map(i => `<div class="flex justify-between"><span>${i.name}</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>`).join('')}
        </div>
      </div>

      <div>
        <div class="flex justify-between font-bold text-slate-900 border-b border-slate-200 pb-1">
          <span>Current Assets</span>
          <span class="font-mono">${formatINR(d.assets.current_assets_total)}</span>
        </div>
        <div class="pl-3 pt-1 space-y-0.5 text-slate-600">
          ${d.assets.current_assets_items.map(i => `<div class="flex justify-between"><span>${i.name} (${i.group_name})</span><span class="font-mono font-semibold">${formatINR(i.closing_balance)}</span></div>`).join('')}
        </div>
      </div>
    `;
    aDiv.innerHTML = aHtml;
    document.getElementById('bs-total-assets').innerText = formatINR(d.assets.total);

  } catch (err) {
    console.error('Failed to load Balance Sheet:', err);
  }
}

// 4B. Profit & Loss Account
async function loadProfitLoss() {
  try {
    const res = await fetch(`${API_BASE}/reports/profit-loss`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    document.getElementById('pl-opening-stock').innerText = formatINR(d.trading.opening_stock);
    document.getElementById('pl-purchases').innerText = formatINR(d.trading.purchases);
    document.getElementById('pl-direct-expenses').innerText = formatINR(d.trading.direct_expenses);
    document.getElementById('pl-gross-profit-left').innerText = formatINR(d.trading.gross_profit);

    document.getElementById('pl-sales').innerText = formatINR(d.trading.sales);
    document.getElementById('pl-closing-stock').innerText = formatINR(d.trading.closing_stock);
    document.getElementById('pl-direct-incomes').innerText = formatINR(d.trading.direct_incomes);

    document.getElementById('pl-gross-profit-right').innerText = formatINR(d.indirect.gross_profit);
    document.getElementById('pl-total-indirect-expenses').innerText = formatINR(d.indirect.indirect_expenses);
    document.getElementById('pl-net-profit').innerText = formatINR(d.indirect.net_profit);

    // List items
    document.getElementById('pl-indirect-expenses-list').innerHTML = d.indirect.indirect_expense_items.map(i => `
      <div class="flex justify-between"><span>${i.name}</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>
    `).join('') || '<div class="text-slate-400">None</div>';

    document.getElementById('pl-indirect-incomes-list').innerHTML = d.indirect.indirect_income_items.map(i => `
      <div class="flex justify-between"><span>${i.name}</span><span class="font-mono">${formatINR(i.closing_balance)}</span></div>
    `).join('') || '<div class="text-slate-400">None</div>';

  } catch (err) {
    console.error('Failed to load P&L:', err);
  }
}

// 4C. Trial Balance
async function loadTrialBalance() {
  try {
    const res = await fetch(`${API_BASE}/reports/trial-balance`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    const tbody = document.getElementById('tb-tbody');
    tbody.innerHTML = d.items.map(i => `
      <tr onclick="openLedgerStatement(${i.id})" class="cursor-pointer">
        <td class="font-bold text-slate-800 hover:text-blue-600">${i.name}</td>
        <td class="text-slate-500 font-semibold">${i.group_name}</td>
        <td class="text-right font-mono">${i.debit > 0 ? formatINR(i.debit) : ''}</td>
        <td class="text-right font-mono">${i.credit > 0 ? formatINR(i.credit) : ''}</td>
      </tr>
    `).join('');

    document.getElementById('tb-total-dr').innerText = formatINR(d.total_debit);
    document.getElementById('tb-total-cr').innerText = formatINR(d.total_credit);
  } catch (err) {
    console.error('Failed to load Trial Balance:', err);
  }
}

// 4D. Day Book
async function loadDayBook() {
  try {
    const res = await fetch(`${API_BASE}/reports/daybook`);
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('daybook-tbody');
    tbody.innerHTML = json.data.map(v => {
      const particulars = v.entries.map(e => `${e.particulars || e.ledger_name} (${e.entry_type})`).join(', ');
      return `
        <tr class="hover:bg-slate-50">
          <td class="font-mono text-slate-600">${formatDate(v.date)}</td>
          <td class="font-medium text-slate-900">
            <div>${v.party_name || v.narration || particulars}</div>
            <div class="text-[11px] text-slate-500">${v.narration || ''}</div>
          </td>
          <td class="text-center font-bold text-blue-700">${v.voucher_type}</td>
          <td class="font-mono text-slate-700">${v.voucher_no}</td>
          <td class="text-right font-mono font-bold">${formatINR(v.total_amount)}</td>
          <td class="text-right font-mono font-bold">${formatINR(v.total_amount)}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load Day Book:', err);
  }
}

// 4E. Stock Summary
async function loadStockSummary() {
  try {
    const res = await fetch(`${API_BASE}/reports/stock-summary`);
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('stock-tbody');
    tbody.innerHTML = json.data.items.map(it => `
      <tr>
        <td class="font-bold text-slate-800">${it.name}</td>
        <td class="font-mono text-slate-600">${it.hsn_code || '-'}</td>
        <td class="text-center font-bold text-sm text-blue-700 font-mono">${it.closing_qty}</td>
        <td class="text-right font-mono">${formatINR(it.valuation_rate)}</td>
        <td class="text-right font-mono font-bold text-slate-900">${formatINR(it.closing_val)}</td>
      </tr>
    `).join('');

    document.getElementById('stock-total-val').innerText = formatINR(json.data.total_valuation);
  } catch (err) {
    console.error('Failed to load Stock Summary:', err);
  }
}

// 4F. Ledger Statement (Khata)
async function openLedgerStatement(ledgerId) {
  hideAllViews();
  state.currentView = 'ledger-statement';
  document.getElementById('view-ledger-statement').classList.remove('hidden');

  const sel = document.getElementById('khata-ledger-select');
  if (sel) sel.value = ledgerId;

  loadLedgerStatement(ledgerId);
}

async function loadLedgerStatement(ledgerId) {
  try {
    const res = await fetch(`${API_BASE}/reports/ledger-statement/${ledgerId}`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    document.getElementById('khata-title').innerText = `${d.ledger.name} — Statement of Account`;
    document.getElementById('khata-group').innerText = `Group: ${d.ledger.group_name} (${d.ledger.group_nature})`;
    document.getElementById('khata-opening-bal').innerText = `${formatINR(d.ledger.opening_balance)} ${d.ledger.opening_balance_type}`;
    document.getElementById('khata-closing-bal').innerText = `${formatINR(d.closing_balance)} ${d.closing_type}`;

    const tbody = document.getElementById('khata-tbody');
    tbody.innerHTML = d.statement.map(s => `
      <tr>
        <td class="font-mono text-slate-600">${formatDate(s.date)}</td>
        <td class="font-medium text-slate-900">
          <div>${s.particulars || '-'}</div>
          <div class="text-[10px] text-slate-500">${s.narration || ''}</div>
        </td>
        <td class="text-center font-bold text-blue-600">${s.voucher_type}</td>
        <td class="font-mono text-slate-700">${s.voucher_no}</td>
        <td class="text-right font-mono font-bold text-slate-900">${s.debit_amount > 0 ? formatINR(s.debit_amount) : ''}</td>
        <td class="text-right font-mono font-bold text-slate-900">${s.credit_amount > 0 ? formatINR(s.credit_amount) : ''}</td>
        <td class="text-right font-mono font-black ${s.balance_type === 'Dr' ? 'text-blue-700' : 'text-amber-700'}">${formatINR(s.balance)} ${s.balance_type}</td>
      </tr>
    `).join('') || `<tr><td colspan="7" class="p-4 text-center text-slate-400">No vouchers recorded for this ledger</td></tr>`;
  } catch (err) {
    console.error('Failed to load ledger statement:', err);
  }
}

// ==========================================
// 5. MASTER CREATION MODALS
// ==========================================
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

async function handleCreateLedger(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('m-ledger-name').value,
    group_id: document.getElementById('m-ledger-group').value,
    opening_balance: document.getElementById('m-ledger-opbal').value,
    opening_balance_type: document.getElementById('m-ledger-optype').value,
    gstin: document.getElementById('m-ledger-gstin').value,
    pan: document.getElementById('m-ledger-pan').value
  };

  try {
    const res = await fetch(`${API_BASE}/masters/ledgers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      closeModal('createLedgerModal');
      document.getElementById('form-create-ledger').reset();
      loadMasters();
    } else {
      alert(json.error || 'Failed to create ledger');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ========================================================
// TALLYPRIME GOLD — MASTER APPLICATION ENGINE
// ========================================================

const API_BASE = '/api';

// Application State
let appState = {
  company: {},
  ledgers: [],
  stockItems: [],
  stockGroups: [],
  godowns: [],
  costCentres: [],
  uoms: [],
  voucherMode: 'invoice', // 'invoice' or 'manual'
  currentVoucherType: 'Sales',
  currentView: 'view-gateway',
  activeBankLedgerId: null,
  currentUser: null,
  permissions: null
};

// ========================================================
// 1. TALLY SECURITY CONTROL & MULTI-USER ENGINE
// ========================================================

const QUICK_USERS = {
  admin: {
    username: 'admin',
    password: 'admin123',
    role: 'Owner',
    desc: '<strong>Owner Permissions:</strong> Full Administrative access to all vouchers, financial reports, user security & company alteration.'
  },
  accountant: {
    username: 'accountant',
    password: 'acc123',
    role: 'Accountant',
    desc: '<strong>Accountant Permissions:</strong> Create & edit all vouchers, view Balance Sheet, P&L, BRS, GST. Restricted from security and company alteration.'
  },
  dataentry: {
    username: 'dataentry',
    password: 'data123',
    role: 'Data Entry',
    desc: '<strong>Data Entry Permissions:</strong> Operational entry only (Sales, Purchases, Payments, Receipts, Contra). Financial statements restricted.'
  },
  auditor: {
    username: 'auditor',
    password: 'audit123',
    role: 'Auditor',
    desc: '<strong>Auditor Permissions:</strong> Statutory inspection mode. Complete read-only view of Ledgers, Day Book, Balance Sheet, GST. Cannot record vouchers.'
  },
  viewer: {
    username: 'viewer',
    password: 'view123',
    role: 'Viewer',
    desc: '<strong>Viewer Permissions:</strong> Executive summary of Dashboard, key ratios, and financial statements. Read-only; cannot record transactions.'
  }
};

function selectQuickUser(roleKey) {
  const profile = QUICK_USERS[roleKey];
  if (!profile) return;

  // Highlight selected button
  document.querySelectorAll('#quick-user-selector .qu-btn').forEach(btn => {
    btn.classList.remove('active', 'border-purple-400', 'bg-purple-50', 'border-blue-400', 'bg-blue-50', 'border-amber-400', 'bg-amber-50', 'border-emerald-400', 'bg-emerald-50', 'border-slate-400', 'bg-slate-100');
    btn.classList.add('border-slate-200', 'bg-slate-50');
  });

  const activeBtn = document.getElementById(`qu-${roleKey}`);
  if (activeBtn) {
    activeBtn.classList.remove('border-slate-200', 'bg-slate-50');
    if (roleKey === 'admin') activeBtn.classList.add('active', 'border-purple-400', 'bg-purple-50');
    else if (roleKey === 'accountant') activeBtn.classList.add('active', 'border-blue-400', 'bg-blue-50');
    else if (roleKey === 'dataentry') activeBtn.classList.add('active', 'border-amber-400', 'bg-amber-50');
    else if (roleKey === 'auditor') activeBtn.classList.add('active', 'border-emerald-400', 'bg-emerald-50');
    else if (roleKey === 'viewer') activeBtn.classList.add('active', 'border-slate-400', 'bg-slate-100');
  }

  // Populate inputs
  const uInput = document.getElementById('login-username');
  const pInput = document.getElementById('login-password');
  const hintEl = document.getElementById('pwd-hint');
  const descEl = document.getElementById('role-desc-text');
  const errEl = document.getElementById('login-error-msg');

  if (uInput) uInput.value = profile.username;
  if (pInput) pInput.value = profile.password;
  if (hintEl) hintEl.textContent = `Password: ${profile.password}`;
  if (descEl) descEl.innerHTML = profile.desc;
  if (errEl) errEl.classList.add('hidden');
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(`eye-${inputId}`);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    if (icon) icon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide) window.lucide.createIcons();
}

// ========================================================
// 2. INITIALIZATION & SESSION LOADING
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) window.lucide.createIcons();
  await loadMasters();
  await loadGatewayInfo();
  setupKeyboardShortcuts();

  // Restore saved multi-user session if available
  const savedSessionStr = localStorage.getItem('tally_user_session');
  if (savedSessionStr) {
    try {
      const session = JSON.parse(savedSessionStr);
      if (session && session.user && session.permissions) {
        appState.currentUser = session.user;
        appState.permissions = session.permissions;
        updateUserDisplay();
        applyRolePermissions();
        showGateway();
        return;
      }
    } catch (e) {
      localStorage.removeItem('tally_user_session');
    }
  }

  showLoginView();
});

function updateUserDisplay() {
  const user = appState.currentUser || { username: 'admin', role: 'Owner' };
  const userEl = document.getElementById('top-user-name');
  const roleEl = document.getElementById('top-user-role');

  if (userEl) userEl.textContent = user.username;
  if (roleEl) {
    roleEl.textContent = user.role;
    // Apply role-specific color classes
    roleEl.className = 'px-1.5 py-0.2 rounded text-[9px] font-extrabold uppercase border ';
    switch (user.role) {
      case 'Owner':
        roleEl.className += 'bg-purple-500/30 text-purple-300 border-purple-500/40';
        break;
      case 'Accountant':
        roleEl.className += 'bg-blue-500/30 text-blue-300 border-blue-500/40';
        break;
      case 'Data Entry':
        roleEl.className += 'bg-amber-500/30 text-amber-300 border-amber-500/40';
        break;
      case 'Auditor':
        roleEl.className += 'bg-emerald-500/30 text-emerald-300 border-emerald-500/40';
        break;
      case 'Viewer':
      default:
        roleEl.className += 'bg-slate-500/30 text-slate-300 border-slate-500/40';
        break;
    }
  }
}

function applyRolePermissions() {
  const perms = appState.permissions || {};
  const isOwner = (appState.currentUser?.role === 'Owner');

  // Top header user security button
  const topUsersBtn = document.getElementById('btn-top-users');
  if (topUsersBtn) {
    if (perms.canManageUsers || isOwner) topUsersBtn.classList.remove('hidden');
    else topUsersBtn.classList.add('hidden');
  }

  // Gateway items
  const gwSecurity = document.getElementById('gw-user-security');
  if (gwSecurity) {
    if (perms.canManageUsers || isOwner) gwSecurity.classList.remove('hidden');
    else gwSecurity.classList.add('hidden');
  }

  const gwClean = document.getElementById('gw-clean-slate');
  if (gwClean) {
    if (perms.canCleanSlate || isOwner) gwClean.classList.remove('hidden');
    else gwClean.classList.add('hidden');
  }

  const gwAlter = document.getElementById('gw-alter-company');
  if (gwAlter) {
    if (perms.canAlterCompany || isOwner) gwAlter.classList.remove('hidden');
    else gwAlter.classList.add('hidden');
  }

  // Voucher submission button badge
  const btnSaveVoucher = document.getElementById('btn-save-voucher');
  if (btnSaveVoucher) {
    if (perms.canCreateVouchers) {
      btnSaveVoucher.disabled = false;
      btnSaveVoucher.classList.remove('opacity-50', 'cursor-not-allowed', 'bg-slate-600');
      btnSaveVoucher.classList.add('bg-[#1f3a52]', 'hover:bg-[#162a3b]');
      btnSaveVoucher.innerHTML = '<span>Accept / Save (Enter)</span><i data-lucide="check" class="w-4 h-4 text-emerald-400"></i>';
    } else {
      btnSaveVoucher.disabled = true;
      btnSaveVoucher.classList.add('opacity-50', 'cursor-not-allowed', 'bg-slate-600');
      btnSaveVoucher.classList.remove('bg-[#1f3a52]', 'hover:bg-[#162a3b]');
      btnSaveVoucher.innerHTML = '<span>Read-Only Account</span><i data-lucide="lock" class="w-4 h-4 text-rose-300"></i>';
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

function checkPermission(permKey, actionName) {
  const perms = appState.permissions || {};
  if (perms[permKey] === true) {
    return true;
  }

  // Access Denied
  const titleEl = document.getElementById('denied-title');
  const msgEl = document.getElementById('denied-message');
  const userEl = document.getElementById('denied-user');
  const roleEl = document.getElementById('denied-role');

  if (titleEl) titleEl.textContent = `Access Restricted: ${actionName}`;
  if (msgEl) {
    const role = appState.currentUser?.role || 'Guest';
    let detail = `Your assigned role "${role}" does not have authorization to access ${actionName}.`;
    if (role === 'Data Entry') {
      detail += ' Data Entry operators are restricted to accounting vouchers and cannot access Financial Statements or Alter Company.';
    } else if (role === 'Auditor' || role === 'Viewer') {
      detail += ' This account is configured for inspection/viewing only.';
    }
    msgEl.textContent = detail;
  }
  if (userEl) userEl.textContent = appState.currentUser?.username || 'user';
  if (roleEl) roleEl.textContent = appState.currentUser?.role || 'Data Entry';

  openModal('accessDeniedModal');
  return false;
}

function showLoginView() {
  showView('view-login');
  const ribbon = document.getElementById('header-ribbon');
  if (ribbon) ribbon.classList.add('opacity-40');
  setTimeout(() => {
    const input = document.getElementById('login-username');
    if (input) input.focus();
  }, 100);
}

async function handleLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById('login-username')?.value?.trim() || 'admin';
  const password = document.getElementById('login-password')?.value || '';
  const errEl = document.getElementById('login-error-msg');
  const errText = document.getElementById('login-error-text');

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      if (errEl) errEl.classList.remove('hidden');
      if (errText) errText.textContent = data.error || 'Invalid credentials or inactive user account.';
      return;
    }

    if (errEl) errEl.classList.add('hidden');

    appState.currentUser = data.data.user;
    appState.permissions = data.data.permissions;

    localStorage.setItem('tally_user_session', JSON.stringify({
      user: data.data.user,
      permissions: data.data.permissions,
      token: data.data.token
    }));

    const ribbon = document.getElementById('header-ribbon');
    if (ribbon) ribbon.classList.remove('opacity-40');

    updateUserDisplay();
    applyRolePermissions();
    showGateway();
  } catch (err) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Connection error: ' + err.message;
  }
}

function handleLogout() {
  localStorage.removeItem('tally_user_session');
  appState.currentUser = null;
  appState.permissions = null;
  showLoginView();
}

function openAlterCompany() {
  if (!checkPermission('canAlterCompany', 'Company Alteration Profile')) return;
  openModal('alterCompanyModal');
}

async function startCleanSlate() {
  if (!checkPermission('canCleanSlate', 'Clean Slate / Books Wipe')) return;
  if (!confirm("Wipe demo vouchers and start with Clean Production Slate? This gives you 0 vouchers and ₹0.00 balances, ready for entering your real business data.")) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/company/clean-slate`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert("Clean slate ready! Your accounting book now has 0 vouchers and ₹0 balances.");
      await loadMasters();
      await loadGatewayInfo();
      if (appState.currentView === 'view-login') {
        handleLogin();
      } else {
        showGateway();
      }
    } else {
      alert("Error: " + (json.error || 'Failed to clean slate'));
    }
  } catch (err) {
    alert("Error resetting to clean slate: " + err.message);
  }
}

async function loadDemoData() {
  if (!checkPermission('canCleanSlate', 'Load Sample Demo Data')) return;
  if (!confirm("Load Sample Demo Data? This will populate the system with sample screw compressor transactions for demonstration and practice.")) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/company/load-demo`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert("Sample demo data loaded!");
      await loadMasters();
      await loadGatewayInfo();
      if (appState.currentView === 'view-login') {
        handleLogin();
      } else {
        showGateway();
      }
    } else {
      alert("Error: " + (json.error || 'Failed to load demo data'));
    }
  } catch (err) {
    alert("Error loading demo data: " + err.message);
  }
}

async function handleUpdateCompany(e) {
  e.preventDefault();
  const form = document.getElementById('form-alter-company');
  const payload = {
    name: form['company_name'].value,
    formal_name: form['formal_name'].value,
    gstin: form['company_gstin'].value,
    pan: form['company_pan'].value,
    state: form['company_state'].value,
    state_code: form['company_state_code'].value,
    address: form['company_address'].value,
    pin_code: form['company_pin'].value
  };

  try {
    const res = await fetch(`${API_BASE}/company/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      closeModal('alterCompanyModal');
      await loadGatewayInfo();
      alert("Company profile updated successfully!");
    } else {
      alert("Error updating company: " + json.error);
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function loadGatewayInfo() {
  try {
    const res = await fetch(`${API_BASE}/gateway/info`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    appState.company = d.company;

    // Update Top & Gateway DOM
    const companyTitle = d.company.name || 'Ramraj Enterprises';
    document.getElementById('top-company-name').textContent = companyTitle;
    document.getElementById('gw-company-name').textContent = companyTitle;
    document.getElementById('login-company-name').textContent = companyTitle;

    const detailsStr = `Company No: ${d.company.company_number || '100000'} | ${d.company.state || 'Tamil Nadu'} (${d.company.state_code || '33'})`;
    document.getElementById('login-company-details').textContent = detailsStr;

    // Status Badges
    const isClean = d.is_clean_slate;
    const badgeText = isClean ? 'Clean Slate (₹0)' : 'Sample Demo Data';
    const badgeClass = isClean
      ? 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
      : 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';

    const topBadge = document.getElementById('top-company-badge');
    if (topBadge) {
      topBadge.textContent = badgeText;
      topBadge.className = badgeClass;
    }

    const loginBadge = document.getElementById('login-status-badge');
    if (loginBadge) {
      loginBadge.textContent = isClean ? 'Clean Production Slate' : 'Sample Demo Data';
      loginBadge.className = isClean
        ? 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800'
        : 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800';
    }

    document.getElementById('top-current-date').textContent = formatDateDisplay(d.current_date);
    document.getElementById('gateway-date').textContent = formatDateDisplay(d.current_date);
    document.getElementById('gateway-vouchers-count').textContent = d.total_vouchers;
    document.getElementById('gateway-ledgers-count').textContent = d.total_ledgers;

    if (d.company.gstin) {
      document.getElementById('gw-company-gstin').textContent = `GSTIN: ${d.company.gstin}`;
    }

    if (d.last_voucher) {
      document.getElementById('gateway-last-voucher').textContent = `${formatDateDisplay(d.last_voucher.date)} (${d.last_voucher.voucher_no})`;
    } else {
      document.getElementById('gateway-last-voucher').textContent = 'None';
    }

    // Populate Alter Company inputs
    const altForm = document.getElementById('form-alter-company');
    if (altForm && d.company) {
      altForm['company_name'].value = d.company.name || '';
      altForm['formal_name'].value = d.company.formal_name || '';
      altForm['company_gstin'].value = d.company.gstin || '';
      altForm['company_pan'].value = d.company.pan || '';
      altForm['company_state'].value = d.company.state || 'Tamil Nadu';
      altForm['company_state_code'].value = d.company.state_code || '33';
      altForm['company_address'].value = d.company.address || '';
      altForm['company_pin'].value = d.company.pin_code || '';
    }
  } catch (err) {
    console.error('Failed to load gateway info:', err);
  }
}

async function loadMasters() {
  try {
    const [ledgersRes, itemsRes, groupsRes, godownsRes, uomRes, centresRes] = await Promise.all([
      fetch(`${API_BASE}/masters/ledgers`).then(r => r.json()),
      fetch(`${API_BASE}/masters/stock-items`).then(r => r.json()),
      fetch(`${API_BASE}/masters/groups`).then(r => r.json()),
      fetch(`${API_BASE}/masters/godowns`).then(r => r.json()),
      fetch(`${API_BASE}/masters/uom`).then(r => r.json()),
      fetch(`${API_BASE}/masters/cost-centres`).then(r => r.json())
    ]);

    if (ledgersRes.success) appState.ledgers = ledgersRes.data;
    if (itemsRes.success) appState.stockItems = itemsRes.data;
    if (groupsRes.success) appState.groups = groupsRes.data;
    if (godownsRes.success) appState.godowns = godownsRes.data;
    if (uomRes.success) appState.uoms = uomRes.data;
    if (centresRes.success) appState.costCentres = centresRes.data;

    populateLedgerDropdowns();
    populateStockDropdowns();
  } catch (err) {
    console.error('Failed to load masters:', err);
  }
}

// Populate Modal Selects
function populateLedgerDropdowns() {
  const modalGroupSelect = document.getElementById('m-ledger-group');
  if (modalGroupSelect && appState.groups) {
    modalGroupSelect.innerHTML = appState.groups.map(g => `<option value="${g.id}">${g.name} (${g.nature})</option>`).join('');
  }
}

function populateStockDropdowns() {
  const itemGroupSelect = document.getElementById('m-item-group');
  const itemUomSelect = document.getElementById('m-item-uom');

  if (itemGroupSelect && appState.stockGroups) {
    itemGroupSelect.innerHTML = appState.stockGroups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
  }
  if (itemUomSelect && appState.uoms) {
    itemUomSelect.innerHTML = appState.uoms.map(u => `<option value="${u.id}">${u.formal_name} (${u.symbol})</option>`).join('');
  }
}

// ========================================================
// 2. VIEW MANAGEMENT (GATEWAY, DASHBOARD & REPORTS)
// ========================================================
const VIEWS = [
  'view-login',
  'view-dashboard',
  'view-gateway',
  'view-voucher',
  'view-balance-sheet',
  'view-profit-loss',
  'view-trial-balance',
  'view-stock-summary',
  'view-daybook',
  'view-ratio-analysis',
  'view-gst',
  'view-outstandings',
  'view-bank-recon',
  'view-chart-accounts'
];

function showView(viewId) {
  VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const target = document.getElementById(viewId);
  if (target) {
    target.classList.remove('hidden');
    appState.currentView = viewId;
  }
  if (window.lucide) window.lucide.createIcons();
}

function showGateway() {
  showView('view-gateway');
  loadGatewayInfo();
}

function toggleDashboard() {
  if (appState.currentView === 'view-dashboard') {
    showGateway();
  } else {
    showView('view-dashboard');
    loadDashboard();
  }
}

async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/tiles`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    // Balance Sheet
    document.getElementById('dash-bs-assets').textContent = formatCurrency(d.balance_sheet_tile.total_assets);
    document.getElementById('dash-bs-liab').textContent = formatCurrency(d.balance_sheet_tile.total_liabilities);
    document.getElementById('dash-bs-wc').textContent = formatCurrency(d.balance_sheet_tile.working_capital);

    // P&L
    document.getElementById('dash-pl-sales').textContent = formatCurrency(d.profit_loss_tile.sales);
    document.getElementById('dash-pl-gp').textContent = formatCurrency(d.profit_loss_tile.gross_profit);
    document.getElementById('dash-pl-np').textContent = formatCurrency(d.profit_loss_tile.net_profit);

    // Debtors
    document.getElementById('dash-debtors-total').textContent = formatCurrency(d.debtors_tile.total);
    document.getElementById('dash-debtors-list').innerHTML = (d.debtors_tile.top_debtors || []).map(deb => `
      <div class="flex justify-between border-b border-slate-100 py-0.5">
        <span class="truncate max-w-[170px] text-slate-700">${deb.name}</span>
        <span class="font-mono text-slate-900 font-bold">${formatCurrency(deb.balance)}</span>
      </div>
    `).join('') || '<div class="text-slate-400">No overdue receivables</div>';

    // Creditors
    document.getElementById('dash-creditors-total').textContent = formatCurrency(d.creditors_tile.total);
    document.getElementById('dash-creditors-list').innerHTML = (d.creditors_tile.top_creditors || []).map(crd => `
      <div class="flex justify-between border-b border-slate-100 py-0.5">
        <span class="truncate max-w-[170px] text-slate-700">${crd.name}</span>
        <span class="font-mono text-slate-900 font-bold">${formatCurrency(crd.balance)}</span>
      </div>
    `).join('') || '<div class="text-slate-400">No pending payables</div>';

    // Cash & Funds
    document.getElementById('dash-cash-total').textContent = formatCurrency(d.funds_flow_tile.cash_bank_balance);
    document.getElementById('dash-inflow').textContent = formatCurrency(d.funds_flow_tile.inflow);
    document.getElementById('dash-outflow').textContent = formatCurrency(d.funds_flow_tile.outflow);

    // Stock
    document.getElementById('dash-stock-val').textContent = formatCurrency(d.stock_tile.total_valuation);
    document.getElementById('dash-stock-list').innerHTML = (d.stock_tile.top_items || []).map(it => `
      <div class="flex justify-between border-b border-slate-100 py-0.5">
        <span class="truncate max-w-[170px] text-slate-700">${it.name}</span>
        <span class="font-mono text-blue-700 font-bold">${it.closing_qty} ${it.uom_symbol}</span>
      </div>
    `).join('') || '<div class="text-slate-400">No stock items</div>';

  } catch (err) {
    console.error('Failed to load Dashboard tiles:', err);
  }
}

function openReport(reportType) {
  if (['balance-sheet', 'profit-loss', 'trial-balance', 'ratio-analysis'].includes(reportType)) {
    if (!checkPermission('canViewFinancials', 'Financial Statements & Ratio Analysis')) return;
  }
  if (reportType === 'balance-sheet') {
    showView('view-balance-sheet');
    loadBalanceSheet();
  } else if (reportType === 'profit-loss') {
    showView('view-profit-loss');
    loadProfitLoss();
  } else if (reportType === 'trial-balance') {
    showView('view-trial-balance');
    loadTrialBalance();
  } else if (reportType === 'stock-summary') {
    showView('view-stock-summary');
    loadStockSummary();
  } else if (reportType === 'daybook') {
    showView('view-daybook');
    loadDaybook();
  } else if (reportType === 'ratio-analysis') {
    showView('view-ratio-analysis');
    loadRatioAnalysis();
  } else if (reportType === 'gst') {
    showView('view-gst');
    loadGSTReport();
  } else if (reportType === 'outstandings') {
    showView('view-outstandings');
    loadOutstandings();
  } else if (reportType === 'bank-recon') {
    showView('view-bank-recon');
    loadBankReconciliation();
  } else if (reportType === 'chart-accounts') {
    showView('view-chart-accounts');
    loadChartOfAccountsTree();
  }
}

// ========================================================
// 3. VOUCHER CREATION & ITEM INVOICING ENGINE
// ========================================================
function openVoucherScreen(type = 'Sales') {
  appState.currentVoucherType = type;
  showView('view-voucher');

  const select = document.getElementById('v-select-type');
  if (select) select.value = type;

  // Set default mode: Sales/Purchase default to 'invoice', others default to 'manual'
  if (['Sales', 'Purchase'].includes(type)) {
    setVoucherMode('invoice');
  } else {
    setVoucherMode('manual');
  }

  // Update Badge & Voucher Number
  updateVoucherMeta(type);
  populatePartyDropdown();

  // Reset Tables
  document.getElementById('invoice-items-tbody').innerHTML = '';
  document.getElementById('voucher-entries-tbody').innerHTML = '';

  if (appState.voucherMode === 'invoice') {
    addInvoiceItemRow();
  } else {
    initAccountingVoucherEntries(type);
  }
}

function switchVoucherType(type) {
  openVoucherScreen(type);
}

function setVoucherMode(mode) {
  appState.voucherMode = mode;
  const btnInv = document.getElementById('btn-mode-invoice');
  const btnMan = document.getElementById('btn-mode-manual');
  const secInv = document.getElementById('section-item-invoice');
  const secMan = document.getElementById('section-accounting-voucher');

  if (mode === 'invoice') {
    btnInv.className = 'px-2.5 py-1 rounded text-[11px] font-bold bg-amber-500 text-slate-900 transition';
    btnMan.className = 'px-2.5 py-1 rounded text-[11px] font-semibold text-slate-300 hover:text-white transition';
    secInv.classList.remove('hidden');
    secMan.classList.add('hidden');
    if (document.getElementById('invoice-items-tbody').children.length === 0) {
      addInvoiceItemRow();
    }
  } else {
    btnMan.className = 'px-2.5 py-1 rounded text-[11px] font-bold bg-amber-500 text-slate-900 transition';
    btnInv.className = 'px-2.5 py-1 rounded text-[11px] font-semibold text-slate-300 hover:text-white transition';
    secMan.classList.remove('hidden');
    secInv.classList.add('hidden');
    if (document.getElementById('voucher-entries-tbody').children.length === 0) {
      initAccountingVoucherEntries(appState.currentVoucherType);
    }
  }
}

function updateVoucherMeta(type) {
  const badge = document.getElementById('v-type-badge');
  const title = document.getElementById('v-title');
  const vNo = document.getElementById('v-no');
  const vDate = document.getElementById('v-date');
  const vRef = document.getElementById('bill-ref-name');

  const shortCode = type.toUpperCase().slice(0, 3);
  const randomSuffix = Math.floor(100 + Math.random() * 900);
  const generatedNo = `RRE/${shortCode}/0${randomSuffix}`;

  badge.textContent = `${getFunctionKey(type)}: ${type}`;
  title.textContent = `${type} Voucher Creation`;
  vNo.value = generatedNo;
  vRef.value = generatedNo;
  vDate.value = new Date().toISOString().split('T')[0];
  document.getElementById('bill-due-date').value = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function getFunctionKey(type) {
  const map = { Contra: 'F4', Payment: 'F5', Receipt: 'F6', Journal: 'F7', Sales: 'F8', Purchase: 'F9', 'Credit Note': 'Alt+F6', 'Debit Note': 'Alt+F5' };
  return map[type] || 'F8';
}

function populatePartyDropdown() {
  const partySelect = document.getElementById('v-party-ledger');
  const type = appState.currentVoucherType;

  let filtered = appState.ledgers;
  if (['Sales', 'Credit Note'].includes(type)) {
    filtered = appState.ledgers.filter(l => l.group_name === 'Sundry Debtors' || l.group_name === 'Cash-in-hand' || l.group_name === 'Bank Accounts');
  } else if (['Purchase', 'Debit Note'].includes(type)) {
    filtered = appState.ledgers.filter(l => l.group_name === 'Sundry Creditors' || l.group_name === 'Cash-in-hand' || l.group_name === 'Bank Accounts');
  } else if (type === 'Payment') {
    filtered = appState.ledgers.filter(l => l.group_nature === 'Expenses' || l.group_name === 'Sundry Creditors');
  } else if (type === 'Receipt') {
    filtered = appState.ledgers.filter(l => l.group_name === 'Sundry Debtors' || l.group_nature === 'Income');
  }

  partySelect.innerHTML = filtered.map(l => `<option value="${l.id}">${l.name} (${l.group_name})</option>`).join('');
  handlePartyChange();
}

function handlePartyChange() {
  const partySelect = document.getElementById('v-party-ledger');
  const selectedId = parseInt(partySelect.value, 10);
  const party = appState.ledgers.find(l => l.id === selectedId);

  const stateEl = document.getElementById('v-party-state');
  const gstinEl = document.getElementById('v-party-gstin');
  const typeEl = document.getElementById('v-party-gst-type');

  if (party) {
    stateEl.textContent = `${party.state || 'Tamil Nadu'} (${party.state_code || '33'})`;
    gstinEl.textContent = party.gstin || 'Unregistered / Consumer';

    const isInterState = (party.state_code && party.state_code !== '33');
    if (isInterState) {
      typeEl.textContent = 'Inter-State (IGST 18%)';
      typeEl.className = 'text-amber-700 font-bold';
    } else {
      typeEl.textContent = 'Intra-State (CGST 9% + SGST 9%)';
      typeEl.className = 'text-emerald-700 font-bold';
    }
  }

  recalculateInvoiceTaxes();
}

// ----------------------------------------------------
// ITEM INVOICE ROWS & AUTOMATIC TAX COMPUTATION
// ----------------------------------------------------
function addInvoiceItemRow() {
  const tbody = document.getElementById('invoice-items-tbody');
  const rowId = `item-row-${Date.now()}-${Math.floor(Math.random()*1000)}`;

  const itemOptions = appState.stockItems.map(i => `<option value="${i.id}" data-rate="${i.standard_price || i.standard_cost || 0}">${i.name}</option>`).join('');
  const godownOptions = appState.godowns.map(g => `<option value="${g.id}">${g.name}</option>`).join('');

  const firstItem = appState.stockItems[0];
  const initialRate = firstItem ? (firstItem.standard_price || firstItem.standard_cost || 0) : 0;

  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td class="p-2">
      <select onchange="updateRowItemRate(this)" class="w-full border border-slate-300 rounded p-1 bg-white font-medium item-select">
        ${itemOptions}
      </select>
    </td>
    <td class="p-2">
      <select class="w-full border border-slate-300 rounded p-1 bg-white item-godown">
        ${godownOptions}
      </select>
    </td>
    <td class="p-2">
      <input type="number" step="1" value="1" min="1" oninput="recalculateInvoiceTaxes()" class="w-full border border-slate-300 rounded p-1 text-center font-mono item-qty">
    </td>
    <td class="p-2">
      <input type="number" step="0.01" value="${initialRate}" oninput="recalculateInvoiceTaxes()" class="w-full border border-slate-300 rounded p-1 text-right font-mono item-rate">
    </td>
    <td class="p-2">
      <input type="number" step="0.1" value="0" min="0" max="100" oninput="recalculateInvoiceTaxes()" class="w-full border border-slate-300 rounded p-1 text-center font-mono item-disc">
    </td>
    <td class="p-2 text-right font-mono font-bold text-slate-800 item-amount">
      ${formatCurrency(initialRate)}
    </td>
    <td class="p-2 text-center">
      <button type="button" onclick="removeInvoiceRow('${rowId}')" class="text-red-500 hover:text-red-700 font-bold">✕</button>
    </td>
  `;

  tbody.appendChild(tr);
  recalculateInvoiceTaxes();
}

function updateRowItemRate(selectEl) {
  const tr = selectEl.closest('tr');
  const selectedOption = selectEl.options[selectEl.selectedIndex];
  const rateInput = tr.querySelector('.item-rate');
  const rate = parseFloat(selectedOption.getAttribute('data-rate')) || 0;
  rateInput.value = rate;
  recalculateInvoiceTaxes();
}

function removeInvoiceRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  recalculateInvoiceTaxes();
}

// Automatic GST & Total Calculation
function recalculateInvoiceTaxes() {
  const tbody = document.getElementById('invoice-items-tbody');
  const rows = tbody.querySelectorAll('tr');

  let subtotal = 0;

  rows.forEach(r => {
    const qty = parseFloat(r.querySelector('.item-qty').value) || 0;
    const rate = parseFloat(r.querySelector('.item-rate').value) || 0;
    const disc = parseFloat(r.querySelector('.item-disc').value) || 0;

    let lineAmt = qty * rate;
    if (disc > 0) lineAmt = lineAmt - (lineAmt * (disc / 100));

    subtotal += lineAmt;
    r.querySelector('.item-amount').textContent = formatCurrency(lineAmt);
  });

  // Determine GST type based on party state
  const partySelect = document.getElementById('v-party-ledger');
  const party = appState.ledgers.find(l => l.id === parseInt(partySelect.value, 10));
  const isInterState = party && party.state_code && party.state_code !== '33';

  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  const isSales = ['Sales', 'Credit Note'].includes(appState.currentVoucherType);
  const taxPrefix = isSales ? 'Output' : 'Input';

  document.getElementById('inv-cgst-label').textContent = `${taxPrefix} CGST (9%):`;
  document.getElementById('inv-sgst-label').textContent = `${taxPrefix} SGST (9%):`;
  document.getElementById('inv-igst-label').textContent = `${taxPrefix} IGST (18%):`;

  if (isInterState) {
    igst = subtotal * 0.18;
    document.getElementById('inv-cgst-row').classList.add('hidden');
    document.getElementById('inv-sgst-row').classList.add('hidden');
    document.getElementById('inv-igst-row').classList.remove('hidden');
    document.getElementById('inv-igst-val').textContent = formatCurrency(igst);
  } else {
    cgst = subtotal * 0.09;
    sgst = subtotal * 0.09;
    document.getElementById('inv-cgst-row').classList.remove('hidden');
    document.getElementById('inv-sgst-row').classList.remove('hidden');
    document.getElementById('inv-igst-row').classList.add('hidden');
    document.getElementById('inv-cgst-val').textContent = formatCurrency(cgst);
    document.getElementById('inv-sgst-val').textContent = formatCurrency(sgst);
  }

  const rawTotal = subtotal + cgst + sgst + igst;
  const roundedTotal = Math.round(rawTotal);
  const roundOff = roundedTotal - rawTotal;

  document.getElementById('inv-subtotal').textContent = formatCurrency(subtotal);
  document.getElementById('inv-roundoff').textContent = (roundOff >= 0 ? `+${formatCurrency(roundOff)}` : formatCurrency(roundOff));
  document.getElementById('inv-grand-total').textContent = formatCurrency(roundedTotal);
}

// ----------------------------------------------------
// ACCOUNTING VOUCHER (MANUAL DR/CR GRID)
// ----------------------------------------------------
function initAccountingVoucherEntries(type) {
  const tbody = document.getElementById('voucher-entries-tbody');
  tbody.innerHTML = '';

  if (type === 'Contra') {
    addDoubleEntryRow('Dr', 'Cash', 0);
    addDoubleEntryRow('Cr', 'HDFC Bank Current A/c', 0);
  } else if (type === 'Payment') {
    addDoubleEntryRow('Dr', 'Office Rent', 0);
    addDoubleEntryRow('Cr', 'HDFC Bank Current A/c', 0);
  } else if (type === 'Receipt') {
    addDoubleEntryRow('Dr', 'HDFC Bank Current A/c', 0);
    addDoubleEntryRow('Cr', 'Chennai Auto Components Pvt Ltd', 0);
  } else if (type === 'Journal') {
    addDoubleEntryRow('Dr', 'Depreciation on Assets', 0);
    addDoubleEntryRow('Cr', 'Plant & Machinery', 0);
  } else {
    addDoubleEntryRow('Dr', '', 0);
    addDoubleEntryRow('Cr', '', 0);
  }
}

function addDoubleEntryRow(defaultType = 'Dr', defaultLedger = '', defaultAmt = 0) {
  const tbody = document.getElementById('voucher-entries-tbody');
  const rowId = `entry-row-${Date.now()}-${Math.floor(Math.random()*1000)}`;

  const ledgerOptions = appState.ledgers.map(l => `<option value="${l.id}" ${l.name === defaultLedger ? 'selected' : ''}>${l.name} (${l.group_name})</option>`).join('');
  const costCentreOptions = `<option value="">None</option>` + (appState.costCentres || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td class="p-2 text-center">
      <select onchange="handleEntryTypeChange(this)" class="border border-slate-300 rounded p-1 font-bold ${defaultType === 'Dr' ? 'text-blue-700' : 'text-emerald-700'} entry-type">
        <option value="Dr" ${defaultType === 'Dr' ? 'selected' : ''}>Dr</option>
        <option value="Cr" ${defaultType === 'Cr' ? 'selected' : ''}>Cr</option>
      </select>
    </td>
    <td class="p-2">
      <select class="w-full border border-slate-300 rounded p-1 bg-white font-medium entry-ledger">
        ${ledgerOptions}
      </select>
    </td>
    <td class="p-2">
      <select class="w-full border border-slate-300 rounded p-1 bg-white text-[11px] entry-cc">
        ${costCentreOptions}
      </select>
    </td>
    <td class="p-2">
      <input type="number" step="0.01" value="${defaultType === 'Dr' ? defaultAmt : 0}" oninput="recalculateAccountingTotals()" class="w-full border border-slate-300 rounded p-1 text-right font-mono entry-dr ${defaultType === 'Cr' ? 'bg-slate-100 text-slate-400' : ''}" ${defaultType === 'Cr' ? 'readonly' : ''}>
    </td>
    <td class="p-2">
      <input type="number" step="0.01" value="${defaultType === 'Cr' ? defaultAmt : 0}" oninput="recalculateAccountingTotals()" class="w-full border border-slate-300 rounded p-1 text-right font-mono entry-cr ${defaultType === 'Dr' ? 'bg-slate-100 text-slate-400' : ''}" ${defaultType === 'Dr' ? 'readonly' : ''}>
    </td>
    <td class="p-2 text-center">
      <button type="button" onclick="removeDoubleEntryRow('${rowId}')" class="text-red-500 hover:text-red-700 font-bold">✕</button>
    </td>
  `;

  tbody.appendChild(tr);
  recalculateAccountingTotals();
}

function handleEntryTypeChange(selectEl) {
  const tr = selectEl.closest('tr');
  const type = selectEl.value;
  const drInput = tr.querySelector('.entry-dr');
  const crInput = tr.querySelector('.entry-cr');

  if (type === 'Dr') {
    selectEl.className = 'border border-slate-300 rounded p-1 font-bold text-blue-700 entry-type';
    drInput.readOnly = false;
    drInput.classList.remove('bg-slate-100', 'text-slate-400');
    crInput.value = 0;
    crInput.readOnly = true;
    crInput.classList.add('bg-slate-100', 'text-slate-400');
  } else {
    selectEl.className = 'border border-slate-300 rounded p-1 font-bold text-emerald-700 entry-type';
    crInput.readOnly = false;
    crInput.classList.remove('bg-slate-100', 'text-slate-400');
    drInput.value = 0;
    drInput.readOnly = true;
    drInput.classList.add('bg-slate-100', 'text-slate-400');
  }

  recalculateAccountingTotals();
}

function removeDoubleEntryRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  recalculateAccountingTotals();
}

function recalculateAccountingTotals() {
  const tbody = document.getElementById('voucher-entries-tbody');
  const rows = tbody.querySelectorAll('tr');

  let totalDr = 0;
  let totalCr = 0;

  rows.forEach(r => {
    const dr = parseFloat(r.querySelector('.entry-dr').value) || 0;
    const cr = parseFloat(r.querySelector('.entry-cr').value) || 0;
    totalDr += dr;
    totalCr += cr;
  });

  document.getElementById('v-total-dr').textContent = formatCurrency(totalDr);
  document.getElementById('v-total-cr').textContent = formatCurrency(totalCr);

  const diff = Math.abs(totalDr - totalCr);
  const ind = document.getElementById('v-balance-indicator');

  if (diff < 0.05) {
    ind.className = 'text-xs font-bold px-3 py-1 rounded bg-emerald-100 text-emerald-800';
    ind.textContent = `Balanced: Total Dr = Total Cr = ${formatCurrency(totalDr)}`;
  } else {
    ind.className = 'text-xs font-bold px-3 py-1 rounded bg-red-100 text-red-800';
    ind.textContent = `Out of Balance! Difference: ${formatCurrency(diff)}`;
  }
}

// ----------------------------------------------------
// VOUCHER SUBMIT & POSTING HANDLER
// ----------------------------------------------------
async function handleSaveVoucher(e) {
  e.preventDefault();

  if (!checkPermission('canCreateVouchers', 'Accounting Voucher Entry')) {
    return;
  }

  const voucherType = document.getElementById('v-select-type').value;
  const voucherNo = document.getElementById('v-no').value;
  const voucherDate = document.getElementById('v-date').value;
  const referenceNo = document.getElementById('v-ref').value;
  const narration = document.getElementById('v-narration').value;
  const partyLedgerId = parseInt(document.getElementById('v-party-ledger').value, 10);

  let entries = [];
  let inventory = [];
  let billAllocations = [];

  if (appState.voucherMode === 'invoice') {
    // Convert Item Invoice Mode to Strict Double-Entry Ledger Lines
    const itemRows = document.querySelectorAll('#invoice-items-tbody tr');
    if (itemRows.length === 0) {
      alert('Please add at least one stock item to the invoice.');
      return;
    }

    let subtotal = 0;
    itemRows.forEach(r => {
      const itemId = parseInt(r.querySelector('.item-select').value, 10);
      const godownId = parseInt(r.querySelector('.item-godown').value, 10);
      const qty = parseFloat(r.querySelector('.item-qty').value) || 0;
      const rate = parseFloat(r.querySelector('.item-rate').value) || 0;
      const disc = parseFloat(r.querySelector('.item-disc').value) || 0;
      let lineAmt = qty * rate;
      if (disc > 0) lineAmt = lineAmt - (lineAmt * (disc / 100));

      subtotal += lineAmt;
      inventory.push({
        stock_item_id: itemId,
        godown_id: godownId,
        quantity: qty,
        rate,
        discount_pct: disc,
        amount: lineAmt
      });
    });

    const party = appState.ledgers.find(l => l.id === partyLedgerId);
    const isInterState = party && party.state_code && party.state_code !== '33';

    let cgst = 0, sgst = 0, igst = 0;
    if (isInterState) {
      igst = subtotal * 0.18;
    } else {
      cgst = subtotal * 0.09;
      sgst = subtotal * 0.09;
    }

    const rawTotal = subtotal + cgst + sgst + igst;
    const grandTotal = Math.round(rawTotal);
    const roundOff = Math.round((grandTotal - rawTotal) * 100) / 100;

    const isSales = ['Sales', 'Credit Note'].includes(voucherType);

    // Ledger lookups
    const salesLedger = appState.ledgers.find(l => l.name.includes('Sales Account') || l.group_name === 'Sales Accounts');
    const purchaseLedger = appState.ledgers.find(l => l.name.includes('Purchase Account') || l.group_name === 'Purchase Accounts');
    const cgstLedger = appState.ledgers.find(l => l.name === (isSales ? 'Output CGST 9%' : 'Input CGST 9%'));
    const sgstLedger = appState.ledgers.find(l => l.name === (isSales ? 'Output SGST 9%' : 'Input SGST 9%'));
    const igstLedger = appState.ledgers.find(l => l.name === (isSales ? 'Output IGST 18%' : 'Input IGST 18%'));
    const roundLedger = appState.ledgers.find(l => l.name === 'Round Off A/c');

    if (isSales) {
      // Dr. Party (Grand Total)
      entries.push({ ledger_id: partyLedgerId, debit_amount: grandTotal, credit_amount: 0, particulars: party.name });
      // Cr. Sales (Subtotal)
      entries.push({ ledger_id: salesLedger ? salesLedger.id : 14, debit_amount: 0, credit_amount: subtotal, particulars: salesLedger ? salesLedger.name : 'Sales Account' });
      // Cr. Taxes
      if (isInterState) {
        entries.push({ ledger_id: igstLedger ? igstLedger.id : 12, debit_amount: 0, credit_amount: igst, particulars: 'Output IGST 18%' });
      } else {
        entries.push({ ledger_id: cgstLedger ? cgstLedger.id : 10, debit_amount: 0, credit_amount: cgst, particulars: 'Output CGST 9%' });
        entries.push({ ledger_id: sgstLedger ? sgstLedger.id : 11, debit_amount: 0, credit_amount: sgst, particulars: 'Output SGST 9%' });
      }
      // Round off
      if (Math.abs(roundOff) > 0.001) {
        if (roundOff > 0) {
          entries.push({ ledger_id: roundLedger ? roundLedger.id : 13, debit_amount: 0, credit_amount: roundOff, particulars: 'Round Off A/c' });
        } else {
          entries.push({ ledger_id: roundLedger ? roundLedger.id : 13, debit_amount: Math.abs(roundOff), credit_amount: 0, particulars: 'Round Off A/c' });
        }
      }
    } else {
      // Purchase: Dr. Purchase + Taxes, Cr. Party
      entries.push({ ledger_id: purchaseLedger ? purchaseLedger.id : 15, debit_amount: subtotal, credit_amount: 0, particulars: 'Purchase Account' });
      if (isInterState) {
        entries.push({ ledger_id: igstLedger ? igstLedger.id : 9, debit_amount: igst, credit_amount: 0, particulars: 'Input IGST 18%' });
      } else {
        entries.push({ ledger_id: cgstLedger ? cgstLedger.id : 7, debit_amount: cgst, credit_amount: 0, particulars: 'Input CGST 9%' });
        entries.push({ ledger_id: sgstLedger ? sgstLedger.id : 8, debit_amount: sgst, credit_amount: 0, particulars: 'Input SGST 9%' });
      }
      entries.push({ ledger_id: partyLedgerId, debit_amount: 0, credit_amount: grandTotal, particulars: party.name });
    }

    // Bill Allocation
    const billType = document.getElementById('bill-ref-type').value;
    const billRef = document.getElementById('bill-ref-name').value || voucherNo;
    const dueDate = document.getElementById('bill-due-date').value;
    billAllocations.push({
      ledger_id: partyLedgerId,
      bill_type: billType,
      bill_ref: billRef,
      amount: grandTotal,
      due_date: dueDate
    });

  } else {
    // Manual Accounting Voucher Mode
    const entryRows = document.querySelectorAll('#voucher-entries-tbody tr');
    entryRows.forEach(r => {
      const type = r.querySelector('.entry-type').value;
      const ledgerId = parseInt(r.querySelector('.entry-ledger').value, 10);
      const ccId = r.querySelector('.entry-cc').value ? parseInt(r.querySelector('.entry-cc').value, 10) : null;
      const dr = parseFloat(r.querySelector('.entry-dr').value) || 0;
      const cr = parseFloat(r.querySelector('.entry-cr').value) || 0;

      const ledger = appState.ledgers.find(l => l.id === ledgerId);
      entries.push({
        ledger_id: ledgerId,
        cost_centre_id: ccId,
        entry_type: type,
        debit_amount: dr,
        credit_amount: cr,
        particulars: ledger ? ledger.name : ''
      });
    });
  }

  // Double-Entry Verification check on client side
  let sumDr = entries.reduce((s, e) => s + (e.debit_amount || 0), 0);
  let sumCr = entries.reduce((s, e) => s + (e.credit_amount || 0), 0);
  if (Math.abs(sumDr - sumCr) > 0.05) {
    alert(`Double-entry out of balance! Dr: ${formatCurrency(sumDr)}, Cr: ${formatCurrency(sumCr)}. Diff: ${formatCurrency(Math.abs(sumDr - sumCr))}`);
    return;
  }

  try {
    const payload = {
      voucher_type: voucherType,
      voucher_no: voucherNo,
      date: voucherDate,
      reference_no: referenceNo,
      narration: narration,
      party_ledger_id: partyLedgerId,
      entries,
      inventory,
      bill_allocations: billAllocations
    };

    const res = await fetch(`${API_BASE}/vouchers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (json.success) {
      alert(`✨ ${voucherType} Voucher ${voucherNo} ACCEPTED & POSTED!\nTotal Amount: ${formatCurrency(json.total_amount)}`);
      showGateway();
    } else {
      alert(`Error: ${json.error}`);
    }
  } catch (err) {
    alert(`Failed to save voucher: ${err.message}`);
  }
}

// ========================================================
// 4. STATUTORY FINANCIAL REPORTS
// ========================================================

// 4A. BALANCE SHEET
async function loadBalanceSheet() {
  try {
    const res = await fetch(`${API_BASE}/reports/balance-sheet`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    const lDiv = document.getElementById('bs-liabilities-content');
    const aDiv = document.getElementById('bs-assets-content');

    // Render Liabilities
    let lHtml = '';
    lHtml += renderBSGroup('Capital Account', d.liabilities.capital_total, d.liabilities.capital_items);
    if (d.liabilities.net_profit !== 0) {
      lHtml += `
        <div class="border-b border-slate-200 pb-2">
          <div class="font-bold text-slate-800 flex justify-between">
            <span>Profit &amp; Loss A/c (Current Period Net Profit)</span>
            <span class="font-mono text-emerald-700">${formatCurrency(d.liabilities.net_profit)}</span>
          </div>
        </div>
      `;
    }
    lHtml += renderBSGroup('Loans (Liability)', d.liabilities.loans_total, d.liabilities.loans_items);
    lHtml += renderBSGroup('Current Liabilities', d.liabilities.current_liabilities_total, d.liabilities.current_liabilities_items);
    lDiv.innerHTML = lHtml;

    // Render Assets
    let aHtml = '';
    aHtml += renderBSGroup('Fixed Assets', d.assets.fixed_assets_total, d.assets.fixed_assets_items);
    aHtml += renderBSGroup('Investments', d.assets.investments_total, d.assets.investments_items);
    aHtml += renderBSGroup('Current Assets (including Closing Stock)', d.assets.current_assets_total, d.assets.current_assets_items);
    aDiv.innerHTML = aHtml;

    document.getElementById('bs-total-liabilities').textContent = formatCurrency(d.liabilities.total);
    document.getElementById('bs-total-assets').textContent = formatCurrency(d.assets.total);

    const diffEl = document.getElementById('bs-diff-val');
    if (d.difference < 0.05) {
      diffEl.textContent = 'Difference: ₹0.00 (Perfect Equilibrium)';
      diffEl.className = 'font-bold text-emerald-800';
    } else {
      diffEl.textContent = `Difference: ${formatCurrency(d.difference)} (Out of Balance)`;
      diffEl.className = 'font-bold text-red-800';
    }
  } catch (err) {
    console.error('Failed to load Balance Sheet:', err);
  }
}

function renderBSGroup(title, total, items) {
  let subHtml = (items || []).map(i => `
    <div class="flex justify-between pl-4 text-slate-600 text-[11px] py-0.5">
      <span>${i.name}</span>
      <span class="font-mono">${formatCurrency(i.closing_balance || i.closing_val || 0)}</span>
    </div>
  `).join('');

  return `
    <div class="border-b border-slate-200 pb-2">
      <div class="font-bold text-slate-800 flex justify-between">
        <span>${title}</span>
        <span class="font-mono text-blue-800">${formatCurrency(total)}</span>
      </div>
      <div class="mt-1 space-y-0.5">${subHtml}</div>
    </div>
  `;
}

// 4B. PROFIT & LOSS ACCOUNT
async function loadProfitLoss() {
  try {
    const res = await fetch(`${API_BASE}/reports/profit-loss`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;

    // Trading Account Debit Side
    let tdHtml = `
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1">
        <span>To Opening Stock</span>
        <span class="font-mono">${formatCurrency(d.trading.opening_stock)}</span>
      </div>
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1">
        <span>To Purchases</span>
        <span class="font-mono">${formatCurrency(d.trading.purchases)}</span>
      </div>
      ${(d.trading.purchase_items || []).map(i => `<div class="flex justify-between pl-4 text-slate-500 text-[11px]"><span>${i.name}</span><span class="font-mono">${formatCurrency(i.closing_balance)}</span></div>`).join('')}
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1 pt-1">
        <span>To Direct Expenses</span>
        <span class="font-mono">${formatCurrency(d.trading.direct_expenses)}</span>
      </div>
      ${(d.trading.direct_expense_items || []).map(i => `<div class="flex justify-between pl-4 text-slate-500 text-[11px]"><span>${i.name}</span><span class="font-mono">${formatCurrency(i.closing_balance)}</span></div>`).join('')}
    `;
    document.getElementById('pl-trading-debit').innerHTML = tdHtml;

    // Trading Account Credit Side
    let tcHtml = `
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1">
        <span>By Sales Accounts</span>
        <span class="font-mono">${formatCurrency(d.trading.sales)}</span>
      </div>
      ${(d.trading.sales_items || []).map(i => `<div class="flex justify-between pl-4 text-slate-500 text-[11px]"><span>${i.name}</span><span class="font-mono">${formatCurrency(i.closing_balance)}</span></div>`).join('')}
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1 pt-1">
        <span>By Closing Stock</span>
        <span class="font-mono text-blue-700">${formatCurrency(d.trading.closing_stock)}</span>
      </div>
    `;
    document.getElementById('pl-trading-credit').innerHTML = tcHtml;
    document.getElementById('pl-gross-profit').textContent = formatCurrency(d.trading.gross_profit);

    // Indirect Statement
    let idHtml = `
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1">
        <span>To Indirect Expenses</span>
        <span class="font-mono">${formatCurrency(d.indirect.indirect_expenses)}</span>
      </div>
      ${(d.indirect.indirect_expense_items || []).map(i => `<div class="flex justify-between pl-4 text-slate-500 text-[11px]"><span>${i.name}</span><span class="font-mono">${formatCurrency(i.closing_balance)}</span></div>`).join('')}
    `;
    document.getElementById('pl-indirect-debit').innerHTML = idHtml;

    let icHtml = `
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1">
        <span>By Gross Profit b/d</span>
        <span class="font-mono">${formatCurrency(d.indirect.gross_profit)}</span>
      </div>
      <div class="flex justify-between font-bold border-b border-slate-200 pb-1 pt-1">
        <span>By Indirect Incomes</span>
        <span class="font-mono">${formatCurrency(d.indirect.indirect_incomes)}</span>
      </div>
      ${(d.indirect.indirect_income_items || []).map(i => `<div class="flex justify-between pl-4 text-slate-500 text-[11px]"><span>${i.name}</span><span class="font-mono">${formatCurrency(i.closing_balance)}</span></div>`).join('')}
    `;
    document.getElementById('pl-indirect-credit').innerHTML = icHtml;
    document.getElementById('pl-net-profit').textContent = formatCurrency(d.indirect.net_profit);
  } catch (err) {
    console.error('Failed to load P&L Account:', err);
  }
}

// 4C. TRIAL BALANCE
async function loadTrialBalance() {
  try {
    const res = await fetch(`${API_BASE}/reports/trial-balance`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    const tbody = document.getElementById('tb-tbody');
    tbody.innerHTML = d.items.map(i => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 font-sans font-medium text-slate-800">${i.name}</td>
        <td class="p-2 text-slate-500 font-sans">${i.group_name}</td>
        <td class="p-2 text-right ${i.debit > 0 ? 'text-blue-700 font-bold' : 'text-slate-300'}">${i.debit > 0 ? formatCurrency(i.debit) : '-'}</td>
        <td class="p-2 text-right ${i.credit > 0 ? 'text-emerald-700 font-bold' : 'text-slate-300'}">${i.credit > 0 ? formatCurrency(i.credit) : '-'}</td>
      </tr>
    `).join('');

    document.getElementById('tb-total-dr').textContent = formatCurrency(d.total_debit);
    document.getElementById('tb-total-cr').textContent = formatCurrency(d.total_credit);

    const badge = document.getElementById('tb-status-badge');
    if (d.is_balanced) {
      badge.textContent = `Trial Balance In Equilibrium: Total Dr (${formatCurrency(d.total_debit)}) == Total Cr (${formatCurrency(d.total_credit)})`;
      badge.className = 'mt-4 p-3 rounded-lg text-xs font-bold text-center bg-emerald-100 text-emerald-800 border border-emerald-200';
    } else {
      badge.textContent = `Trial Balance Out of Balance! Difference: ${formatCurrency(d.difference)}`;
      badge.className = 'mt-4 p-3 rounded-lg text-xs font-bold text-center bg-red-100 text-red-800 border border-red-200';
    }
  } catch (err) {
    console.error('Failed to load Trial Balance:', err);
  }
}

// 4D. STOCK SUMMARY
async function loadStockSummary() {
  try {
    const res = await fetch(`${API_BASE}/reports/stock-summary`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    const tbody = document.getElementById('stock-tbody');
    tbody.innerHTML = d.items.map(i => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 font-sans font-medium text-slate-800">${i.name}</td>
        <td class="p-2 text-center text-slate-500 font-mono">${i.hsn_code || '-'}</td>
        <td class="p-2 text-center text-slate-600 font-mono">${i.gst_rate}%</td>
        <td class="p-2 text-right text-emerald-700 font-mono">${i.inward_qty}</td>
        <td class="p-2 text-right text-amber-700 font-mono">${i.outward_qty}</td>
        <td class="p-2 text-right font-bold text-blue-800 font-mono">${i.closing_qty} ${i.uom_symbol}</td>
        <td class="p-2 text-right font-mono">${formatCurrency(i.valuation_rate)}</td>
        <td class="p-2 text-right font-mono font-bold text-slate-900">${formatCurrency(i.closing_val)}</td>
      </tr>
    `).join('');

    document.getElementById('stock-total-val').textContent = formatCurrency(d.total_valuation);
  } catch (err) {
    console.error('Failed to load Stock Summary:', err);
  }
}

// 4E. DAY BOOK
async function loadDaybook() {
  try {
    const typeFilter = document.getElementById('daybook-type-filter').value;
    const url = typeFilter ? `${API_BASE}/reports/daybook?type=${encodeURIComponent(typeFilter)}` : `${API_BASE}/reports/daybook`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('daybook-tbody');
    tbody.innerHTML = json.data.map(v => `
      <tr class="hover:bg-slate-50 cursor-pointer" onclick="viewVoucherDetail(${v.id})">
        <td class="p-2.5 text-center font-mono text-slate-600">${formatDateDisplay(v.date)}</td>
        <td class="p-2.5 font-mono font-bold text-blue-700">${v.voucher_no}</td>
        <td class="p-2.5 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${getVoucherBadgeColor(v.voucher_type)}">${v.voucher_type}</span></td>
        <td class="p-2.5 text-slate-800 font-medium">${v.party_name || v.narration || '-'}</td>
        <td class="p-2.5 text-right font-mono font-bold text-slate-900">${formatCurrency(v.total_amount)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load Day Book:', err);
  }
}

function getVoucherBadgeColor(type) {
  const map = {
    Sales: 'bg-emerald-100 text-emerald-800',
    Purchase: 'bg-blue-100 text-blue-800',
    Payment: 'bg-red-100 text-red-800',
    Receipt: 'bg-purple-100 text-purple-800',
    Contra: 'bg-amber-100 text-amber-800',
    Journal: 'bg-slate-200 text-slate-800'
  };
  return map[type] || 'bg-slate-100 text-slate-700';
}

// 4F. RATIO ANALYSIS
async function loadRatioAnalysis() {
  try {
    const res = await fetch(`${API_BASE}/reports/ratio-analysis`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    const r = d.ratios;

    const cards = [
      { title: 'Current Ratio', value: `${r.current_ratio.value} : 1`, bench: `Benchmark: ${r.current_ratio.benchmark}`, formula: 'Current Assets / Current Liabilities', status: r.current_ratio.status },
      { title: 'Quick (Acid-Test) Ratio', value: `${r.quick_ratio.value} : 1`, bench: `Benchmark: ${r.quick_ratio.benchmark}`, formula: '(Current Assets - Closing Stock) / CL', status: r.quick_ratio.status },
      { title: 'Debt to Equity Ratio', value: `${r.debt_equity.value} : 1`, bench: `Benchmark: ${r.debt_equity.benchmark}`, formula: 'Total Loans / Capital Employed', status: r.debt_equity.status },
      { title: 'Gross Profit Margin', value: `${r.gross_profit_pct.value}%`, bench: 'Margin on Net Sales', formula: '(Gross Profit / Sales) * 100', status: 'Healthy' },
      { title: 'Net Profit Margin', value: `${r.net_profit_pct.value}%`, bench: 'Bottom-line Profitability', formula: '(Net Profit / Sales) * 100', status: 'Healthy' },
      { title: 'Inventory Turnover', value: `${r.inventory_turnover.value} times`, bench: `Benchmark: ${r.inventory_turnover.benchmark}`, formula: 'COGS / Average Stock', status: 'Active' }
    ];

    document.getElementById('ratio-cards-container').innerHTML = cards.map(c => `
      <div class="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-1 shadow-sm">
        <div class="flex justify-between items-center">
          <span class="text-xs font-bold text-slate-700">${c.title}</span>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">${c.status}</span>
        </div>
        <div class="text-xl font-black text-slate-900 font-mono mt-1">${c.value}</div>
        <div class="text-[10px] text-slate-500 font-medium">${c.bench}</div>
        <div class="text-[10px] text-blue-700 font-mono mt-1 pt-1 border-t border-slate-200">${c.formula}</div>
      </div>
    `).join('');

    document.getElementById('ra-ca').textContent = formatCurrency(d.current_assets);
    document.getElementById('ra-cl').textContent = formatCurrency(d.current_liabilities);
    document.getElementById('ra-wc').textContent = formatCurrency(d.working_capital);
    document.getElementById('ra-sales').textContent = formatCurrency(d.sales);
  } catch (err) {
    console.error('Failed to load Ratio Analysis:', err);
  }
}

// 4G. GST PORTAL (GSTR-1 & GSTR-3B)
async function loadGSTReport() {
  try {
    const res = await fetch(`${API_BASE}/reports/gst`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    const g1 = d.gstr1;
    const g3 = d.gstr3b;

    document.getElementById('gst-gstr1-total').textContent = `Total Tax: ${formatCurrency(g1.total_outward_tax)}`;

    const b2bTbody = document.getElementById('gst-b2b-tbody');
    b2bTbody.innerHTML = g1.b2b_invoices.map(i => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 font-bold text-blue-700">${i.voucher_no}</td>
        <td class="p-2 text-center text-slate-500">${formatDateDisplay(i.date)}</td>
        <td class="p-2 font-sans font-medium">${i.party_name}</td>
        <td class="p-2 text-center font-mono">${i.party_gstin}</td>
        <td class="p-2 text-right">${formatCurrency(i.taxable_value)}</td>
        <td class="p-2 text-right">${formatCurrency(i.cgst)}</td>
        <td class="p-2 text-right">${formatCurrency(i.sgst)}</td>
        <td class="p-2 text-right">${formatCurrency(i.igst)}</td>
        <td class="p-2 text-right font-bold text-slate-900">${formatCurrency(i.total_invoice_value)}</td>
      </tr>
    `).join('');

    document.getElementById('gstr3b-outward').textContent = formatCurrency(g3.table_3_1_outward.cgst + g3.table_3_1_outward.sgst + g3.table_3_1_outward.igst);
    document.getElementById('gstr3b-itc').textContent = formatCurrency(g3.table_4_itc.total_itc);
    document.getElementById('gstr3b-net').textContent = formatCurrency(g3.net_payable.total_payable);
  } catch (err) {
    console.error('Failed to load GST reports:', err);
  }
}

// 4H. STATEMENT OF OUTSTANDINGS (AGEING)
async function loadOutstandings() {
  try {
    const res = await fetch(`${API_BASE}/reports/outstandings`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    document.getElementById('out-total-rec').textContent = `Total Receivables: ${formatCurrency(d.total_receivable)}`;
    document.getElementById('out-total-pay').textContent = `Total Payables: ${formatCurrency(d.total_payable)}`;

    const recTbody = document.getElementById('out-rec-tbody');
    recTbody.innerHTML = (d.receivables || []).map(r => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 font-bold text-blue-700">${r.bill_ref}</td>
        <td class="p-2 text-center text-slate-500">${formatDateDisplay(r.bill_date)}</td>
        <td class="p-2 font-sans font-medium">${r.ledger_name}</td>
        <td class="p-2 text-right">${formatCurrency(r.original_amount)}</td>
        <td class="p-2 text-right text-emerald-700">${formatCurrency(r.cleared_amount)}</td>
        <td class="p-2 text-right font-bold text-red-700">${formatCurrency(r.pending_amount)}</td>
      </tr>
    `).join('');

    const payTbody = document.getElementById('out-pay-tbody');
    payTbody.innerHTML = (d.payables || []).map(p => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 font-bold text-blue-700">${p.bill_ref}</td>
        <td class="p-2 text-center text-slate-500">${formatDateDisplay(p.bill_date)}</td>
        <td class="p-2 font-sans font-medium">${p.ledger_name}</td>
        <td class="p-2 text-right">${formatCurrency(p.original_amount)}</td>
        <td class="p-2 text-right text-emerald-700">${formatCurrency(p.cleared_amount)}</td>
        <td class="p-2 text-right font-bold text-amber-800">${formatCurrency(p.pending_amount)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load Outstandings:', err);
  }
}

// 4I. BANK RECONCILIATION STATEMENT (BRS)
async function loadBankReconciliation() {
  try {
    const bankLedgers = appState.ledgers.filter(l => l.group_name === 'Bank Accounts' || l.group_name === 'Bank OD A/c');
    const targetLedgerId = appState.activeBankLedgerId || (bankLedgers[0] ? bankLedgers[0].id : 2);

    const res = await fetch(`${API_BASE}/reports/bank-reconciliation/${targetLedgerId}`);
    const json = await res.json();
    if (!json.success) return;

    const d = json.data;
    document.getElementById('brs-book-balance').textContent = formatCurrency(d.book_balance);
    document.getElementById('brs-bank-balance').textContent = formatCurrency(d.bank_balance);
    document.getElementById('brs-diff').textContent = formatCurrency(d.difference);

    const tbody = document.getElementById('brs-tbody');
    tbody.innerHTML = d.transactions.map(t => `
      <tr class="hover:bg-slate-50">
        <td class="p-2 text-center text-slate-500">${formatDateDisplay(t.date)}</td>
        <td class="p-2 font-sans font-medium text-slate-800">${t.particulars}</td>
        <td class="p-2 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${getVoucherBadgeColor(t.voucher_type)}">${t.voucher_type}</span></td>
        <td class="p-2 text-slate-600">${t.instrument_no || '-'}</td>
        <td class="p-2 text-right ${t.debit_amount > 0 ? 'text-blue-700 font-bold' : 'text-slate-300'}">${t.debit_amount > 0 ? formatCurrency(t.debit_amount) : '-'}</td>
        <td class="p-2 text-right ${t.credit_amount > 0 ? 'text-emerald-700 font-bold' : 'text-slate-300'}">${t.credit_amount > 0 ? formatCurrency(t.credit_amount) : '-'}</td>
        <td class="p-2 text-center">
          <input type="date" value="${t.bank_clearing_date || ''}" id="bank-date-${t.entry_id}" class="border border-slate-300 rounded p-1 text-[11px] font-mono">
        </td>
        <td class="p-2 text-center">
          <button onclick="clearBankEntry(${t.entry_id})" class="px-2 py-1 bg-[#1f3a52] hover:bg-[#162a3b] text-white rounded text-[10px] font-bold">
            ${t.status === 'Cleared' ? 'Update' : 'Clear'}
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load BRS:', err);
  }
}

async function clearBankEntry(entryId) {
  const dateInput = document.getElementById(`bank-date-${entryId}`);
  if (!dateInput || !dateInput.value) {
    alert('Please choose a bank clearing date.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/reports/bank-reconciliation/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_id: entryId, bank_clearing_date: dateInput.value })
    });
    const json = await res.json();
    if (json.success) {
      loadBankReconciliation();
    }
  } catch (err) {
    alert(`Failed to update clearing date: ${err.message}`);
  }
}

// 4J. CHART OF ACCOUNTS (TREE VIEW)
async function loadChartOfAccountsTree() {
  try {
    const container = document.getElementById('coa-tree-container');
    const primaryGroups = (appState.groups || []).filter(g => g.is_primary === 1);

    container.innerHTML = primaryGroups.map(pg => {
      const subGroups = (appState.groups || []).filter(sg => sg.parent_id === pg.id);
      const pgLedgers = (appState.ledgers || []).filter(l => l.group_id === pg.id);

      return `
        <div class="border border-slate-200 rounded-lg p-3 bg-white shadow-sm">
          <div class="font-bold text-slate-900 text-sm flex items-center space-x-2">
            <span class="w-2.5 h-2.5 rounded-full ${pg.nature === 'Assets' ? 'bg-blue-500' : pg.nature === 'Liabilities' ? 'bg-purple-500' : pg.nature === 'Income' ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
            <span>${pg.name}</span>
            <span class="text-[10px] text-slate-400">(${pg.nature})</span>
          </div>

          <!-- Ledgers in Primary Group -->
          <div class="ml-5 mt-1 space-y-0.5">
            ${pgLedgers.map(l => `<div class="text-slate-700 text-xs flex justify-between py-0.5 border-b border-slate-100"><span>• ${l.name}</span><span class="font-mono text-slate-500">${formatCurrency(l.opening_balance)} ${l.opening_balance_type}</span></div>`).join('')}
          </div>

          <!-- Sub Groups -->
          <div class="ml-5 mt-2 space-y-2">
            ${subGroups.map(sg => {
              const sgLedgers = (appState.ledgers || []).filter(l => l.group_id === sg.id);
              return `
                <div class="bg-slate-50 p-2 rounded border border-slate-200">
                  <div class="font-bold text-xs text-slate-800">↳ ${sg.name}</div>
                  <div class="ml-4 mt-1 space-y-0.5">
                    ${sgLedgers.map(l => `<div class="text-slate-600 text-[11px] flex justify-between py-0.5"><span>- ${l.name}</span><span class="font-mono">${formatCurrency(l.opening_balance)} ${l.opening_balance_type}</span></div>`).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load Chart of Accounts:', err);
  }
}

// ========================================================
// 5. MASTER CREATION MODALS (LEDGER & STOCK)
// ========================================================
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

async function handleSaveLedger(e) {
  e.preventDefault();
  const name = document.getElementById('m-ledger-name').value;
  const groupId = parseInt(document.getElementById('m-ledger-group').value, 10);
  const opBal = parseFloat(document.getElementById('m-ledger-opbal').value) || 0;
  const opType = document.getElementById('m-ledger-optype').value;
  const gstin = document.getElementById('m-ledger-gstin').value;
  const stateVal = document.getElementById('m-ledger-state').value.split('|');
  const state = stateVal[0];
  const stateCode = stateVal[1];

  try {
    const res = await fetch(`${API_BASE}/masters/ledgers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, group_id: groupId, opening_balance: opBal, opening_balance_type: opType, gstin, state, state_code: stateCode })
    });
    const json = await res.json();
    if (json.success) {
      alert(`Ledger '${name}' created successfully!`);
      closeModal('createLedgerModal');
      await loadMasters();
      populatePartyDropdown();
    } else {
      alert(`Error: ${json.error}`);
    }
  } catch (err) {
    alert(`Failed to save ledger: ${err.message}`);
  }
}

async function handleSaveStockItem(e) {
  e.preventDefault();
  const name = document.getElementById('m-item-name').value;
  const groupId = parseInt(document.getElementById('m-item-group').value, 10);
  const uomId = parseInt(document.getElementById('m-item-uom').value, 10);
  const hsn = document.getElementById('m-item-hsn').value;
  const gst = parseFloat(document.getElementById('m-item-gst').value) || 18;
  const opQty = parseFloat(document.getElementById('m-item-opqty').value) || 0;
  const opRate = parseFloat(document.getElementById('m-item-oprate').value) || 0;

  try {
    const res = await fetch(`${API_BASE}/masters/stock-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stock_group_id: groupId, uom_id: uomId, hsn_code: hsn, gst_rate: gst, opening_qty: opQty, opening_rate: opRate })
    });
    const json = await res.json();
    if (json.success) {
      alert(`Stock Item '${name}' created successfully!`);
      closeModal('createStockModal');
      await loadMasters();
    } else {
      alert(`Error: ${json.error}`);
    }
  } catch (err) {
    alert(`Failed to save stock item: ${err.message}`);
  }
}

// ========================================================
// 6. KEYBOARD SHORTCUTS & INTERACTIVE ASSISTANT
// ========================================================
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // If typing inside an input or select, skip hotkeys except Esc & Enter
    const isInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal('createLedgerModal');
      closeModal('createStockModal');
      showGateway();
      return;
    }

    if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      toggleCalculator();
      return;
    }

    if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      toggleDashboard();
      return;
    }

    if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      openModal('createLedgerModal');
      return;
    }

    if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && appState.currentView === 'view-voucher') {
      e.preventDefault();
      document.getElementById('form-voucher').dispatchEvent(new Event('submit'));
      return;
    }

    if (e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openUserManagement();
      return;
    }

    // Function keys (F3 to F9)
    if (e.ctrlKey && (e.key === 'F3')) { e.preventDefault(); showLoginView(); return; }
    if (e.key === 'F3') { e.preventDefault(); openAlterCompany(); return; }
    if (e.key === 'F4') { e.preventDefault(); openVoucherScreen('Contra'); }
    if (e.key === 'F5') { e.preventDefault(); openVoucherScreen('Payment'); }
    if (e.key === 'F6') { e.preventDefault(); openVoucherScreen('Receipt'); }
    if (e.key === 'F7') { e.preventDefault(); openVoucherScreen('Journal'); }
    if (e.key === 'F8') { e.preventDefault(); openVoucherScreen('Sales'); }
    if (e.key === 'F9') { e.preventDefault(); openVoucherScreen('Purchase'); }

    // Gateway Single-Key Shortcuts (when on Gateway screen and not typing)
    if (!isInput && appState.currentView === 'view-gateway') {
      const k = e.key.toUpperCase();
      if (k === 'V') openVoucherScreen('Sales');
      if (k === 'B') openReport('balance-sheet');
      if (k === 'P') openReport('profit-loss');
      if (k === 'T') openReport('trial-balance');
      if (k === 'S') openReport('stock-summary');
      if (k === 'D') openReport('daybook');
      if (k === 'R') openReport('ratio-analysis');
      if (k === 'G') openReport('gst');
      if (k === 'O') openReport('outstandings');
      if (k === 'K') openReport('bank-recon');
      if (k === 'A') openReport('chart-accounts');
      if (k === 'C') openModal('createLedgerModal');
      if (k === 'I') openModal('createStockModal');
      if (k === 'U') openUserManagement();
      if (k === 'W') startCleanSlate();
      if (k === 'Q') showLoginView();
    }
  });
}

// ========================================================
// 7. TALLY CALCULATOR LOGIC (CTRL+N)
// ========================================================
let calcExpression = '';

function toggleCalculator() {
  const el = document.getElementById('calculator-drawer');
  el.classList.toggle('hidden');
}

function calcPress(val) {
  const display = document.getElementById('calc-display');
  if (val === 'C') {
    calcExpression = '';
    display.value = '0';
  } else if (val === '=') {
    try {
      const sanitized = calcExpression.replace(/[^0-9+\-*/.]/g, '');
      const res = Function(`'use strict'; return (${sanitized})`)();
      display.value = res;
      calcExpression = res.toString();
    } catch {
      display.value = 'Error';
      calcExpression = '';
    }
  } else {
    calcExpression += val;
    display.value = calcExpression;
  }
}

// ========================================================
// 8. FORMATTING HELPERS
// ========================================================
function formatCurrency(val) {
  const num = parseFloat(val) || 0;
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateDisplay(dStr) {
  if (!dStr) return '';
  const d = new Date(dStr);
  if (isNaN(d.getTime())) return dStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// ========================================================
// 9. TALLY USER MANAGEMENT & SECURITY CONTROL
// ========================================================

let cachedUsers = [];

async function openUserManagement() {
  if (!checkPermission('canManageUsers', 'Security Control & User Management')) return;
  openModal('userManagementModal');
  switchUserTab('users');
  await loadUsersList();
}

function switchUserTab(tabName) {
  const tabs = ['users', 'audit', 'roles'];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const sec = document.getElementById(`sec-tab-${t}`);
    if (btn) {
      if (t === tabName) {
        btn.className = 'px-3 py-1.5 rounded-t font-bold border-b-2 border-blue-600 bg-white text-blue-900 shadow-sm';
      } else {
        btn.className = 'px-3 py-1.5 rounded-t font-semibold text-slate-600 hover:text-slate-900';
      }
    }
    if (sec) {
      if (t === tabName) sec.classList.remove('hidden');
      else sec.classList.add('hidden');
    }
  });

  if (tabName === 'audit') {
    loadAuditTrail();
  }
}

async function loadUsersList() {
  const tbody = document.getElementById('user-accounts-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400">Loading user accounts...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/auth/users`);
    const data = await res.json();
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-rose-500">${data.error || 'Failed to load users'}</td></tr>`;
      return;
    }

    cachedUsers = data.data || [];
    if (cachedUsers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400">No users configured.</td></tr>';
      return;
    }

    tbody.innerHTML = cachedUsers.map(u => {
      let roleBadgeClass = 'bg-slate-100 text-slate-800';
      if (u.role === 'Owner') roleBadgeClass = 'bg-purple-100 text-purple-900 font-black';
      else if (u.role === 'Accountant') roleBadgeClass = 'bg-blue-100 text-blue-900 font-bold';
      else if (u.role === 'Data Entry') roleBadgeClass = 'bg-amber-100 text-amber-900 font-bold';
      else if (u.role === 'Auditor') roleBadgeClass = 'bg-emerald-100 text-emerald-900 font-bold';

      const statusBadge = u.status === 'Active'
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">Active</span>'
        : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">Inactive</span>';

      const backdatedBadge = u.allow_backdated_entries
        ? '<span class="text-emerald-700 font-bold">Yes</span>'
        : '<span class="text-slate-400 font-bold">No</span>';

      const lastLoginStr = u.last_login ? new Date(u.last_login).toLocaleString('en-IN') : 'Never';

      return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="p-2.5 font-bold text-slate-900">${u.username}</td>
          <td class="p-2.5 text-slate-700">${u.full_name}</td>
          <td class="p-2.5">
            <span class="px-2 py-0.5 rounded text-[10px] ${roleBadgeClass}">${u.role}</span>
          </td>
          <td class="p-2.5">${statusBadge}</td>
          <td class="p-2.5">${backdatedBadge}</td>
          <td class="p-2.5 text-slate-500 text-[11px]">${lastLoginStr}</td>
          <td class="p-2.5 text-right space-x-1.5">
            <button onclick="openEditUserModal(${u.id})" class="text-blue-600 hover:text-blue-800 font-bold hover:underline">Edit</button>
            <button onclick="toggleUserStatus(${u.id}, '${u.status}')" class="text-amber-600 hover:text-amber-800 font-bold hover:underline">${u.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
            ${u.role !== 'Owner' ? `<button onclick="handleDeleteUser(${u.id}, '${u.username}')" class="text-rose-600 hover:text-rose-800 font-bold hover:underline">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-rose-500">Error: ${err.message}</td></tr>`;
  }
}

function openCreateUserModal() {
  document.getElementById('user-edit-modal-title').textContent = 'Create New User';
  document.getElementById('edit-user-id').value = '';
  document.getElementById('edit-username').value = '';
  document.getElementById('edit-username').disabled = false;
  document.getElementById('edit-password').value = '';
  document.getElementById('edit-password').placeholder = 'Enter password';
  document.getElementById('edit-pwd-note').classList.add('hidden');
  document.getElementById('edit-fullname').value = '';
  document.getElementById('edit-role').value = 'Data Entry';
  document.getElementById('edit-status').value = 'Active';
  document.getElementById('edit-email').value = '';
  document.getElementById('edit-phone').value = '';
  document.getElementById('edit-backdated').checked = true;
  openModal('userEditModal');
}

function openEditUserModal(userId) {
  const user = cachedUsers.find(u => u.id === userId);
  if (!user) return;

  document.getElementById('user-edit-modal-title').textContent = `Edit User: ${user.username}`;
  document.getElementById('edit-user-id').value = user.id;
  document.getElementById('edit-username').value = user.username;
  document.getElementById('edit-username').disabled = true;
  document.getElementById('edit-password').value = '';
  document.getElementById('edit-password').placeholder = '•••••••• (unchanged)';
  document.getElementById('edit-pwd-note').classList.remove('hidden');
  document.getElementById('edit-fullname').value = user.full_name;
  document.getElementById('edit-role').value = user.role;
  document.getElementById('edit-status').value = user.status;
  document.getElementById('edit-email').value = user.email || '';
  document.getElementById('edit-phone').value = user.phone || '';
  document.getElementById('edit-backdated').checked = !!user.allow_backdated_entries;
  openModal('userEditModal');
}

async function handleSaveUser(e) {
  e.preventDefault();
  const id = document.getElementById('edit-user-id').value;
  const username = document.getElementById('edit-username').value.trim();
  const password = document.getElementById('edit-password').value.trim();
  const full_name = document.getElementById('edit-fullname').value.trim();
  const role = document.getElementById('edit-role').value;
  const status = document.getElementById('edit-status').value;
  const email = document.getElementById('edit-email').value.trim();
  const phone = document.getElementById('edit-phone').value.trim();
  const allow_backdated_entries = document.getElementById('edit-backdated').checked ? 1 : 0;

  try {
    let res, data;
    if (id) {
      res = await fetch(`${API_BASE}/auth/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name, role, status, email, phone, allow_backdated_entries, password })
      });
      data = await res.json();
    } else {
      if (!password) {
        alert('Password is required for new users.');
        return;
      }
      res = await fetch(`${API_BASE}/auth/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, full_name, role, status, email, phone, allow_backdated_entries })
      });
      data = await res.json();
    }

    if (!res.ok || !data.success) {
      alert(`Error: ${data.error || 'Failed to save user'}`);
      return;
    }

    alert(data.message || 'User saved successfully.');
    closeModal('userEditModal');
    await loadUsersList();
  } catch (err) {
    alert(`Request failed: ${err.message}`);
  }
}

async function toggleUserStatus(userId, currentStatus) {
  const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
  if (!confirm(`Are you sure you want to change user status to "${newStatus}"?`)) return;

  try {
    const res = await fetch(`${API_BASE}/auth/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(`Error: ${data.error || 'Failed to update status'}`);
      return;
    }
    await loadUsersList();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function handleDeleteUser(userId, username) {
  if (!confirm(`Permanently delete user account "${username}"? This action cannot be undone.`)) return;

  try {
    const res = await fetch(`${API_BASE}/auth/users/${userId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(`Error: ${data.error || 'Failed to delete user'}`);
      return;
    }
    alert(data.message || 'User deleted.');
    await loadUsersList();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function loadAuditTrail() {
  const tbody = document.getElementById('audit-trail-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">Loading audit trail...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/auth/audit-log?limit=50`);
    const data = await res.json();
    if (!data.success || !data.data || data.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">No login events recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = data.data.map(l => {
      let roleBadge = 'bg-slate-100 text-slate-800';
      if (l.role === 'Owner') roleBadge = 'bg-purple-100 text-purple-900 font-black';
      else if (l.role === 'Accountant') roleBadge = 'bg-blue-100 text-blue-900 font-bold';
      else if (l.role === 'Data Entry') roleBadge = 'bg-amber-100 text-amber-900 font-bold';
      else if (l.role === 'Auditor') roleBadge = 'bg-emerald-100 text-emerald-900 font-bold';

      const timeStr = new Date(l.login_time).toLocaleString('en-IN');

      return `
        <tr class="hover:bg-slate-50 border-b border-slate-100">
          <td class="p-2.5 text-slate-800 font-mono text-[11px]">${timeStr}</td>
          <td class="p-2.5 font-bold text-slate-900">${l.username}</td>
          <td class="p-2.5"><span class="px-2 py-0.5 rounded text-[10px] ${roleBadge}">${l.role}</span></td>
          <td class="p-2.5 text-slate-600 font-mono">${l.ip_address || '127.0.0.1'}</td>
          <td class="p-2.5 text-slate-500 truncate max-w-xs text-[10px]">${l.user_agent || 'Desktop'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-rose-500">Error loading audit: ${err.message}</td></tr>`;
  }
}

// Window Global Bindings
window.showLoginView = showLoginView;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.selectQuickUser = selectQuickUser;
window.togglePasswordVisibility = togglePasswordVisibility;
window.startCleanSlate = startCleanSlate;
window.loadDemoData = loadDemoData;
window.handleUpdateCompany = handleUpdateCompany;
window.openAlterCompany = openAlterCompany;
window.openUserManagement = openUserManagement;
window.switchUserTab = switchUserTab;
window.loadUsersList = loadUsersList;
window.openCreateUserModal = openCreateUserModal;
window.openEditUserModal = openEditUserModal;
window.handleSaveUser = handleSaveUser;
window.toggleUserStatus = toggleUserStatus;
window.handleDeleteUser = handleDeleteUser;
window.loadAuditTrail = loadAuditTrail;
window.showGateway = showGateway;
window.toggleDashboard = toggleDashboard;
window.openModal = openModal;
window.closeModal = closeModal;

// ========================================================
// RRE ENTRIES — MASTER APPLICATION ENGINE
// ========================================================

// Production Global Error Boundaries
window.addEventListener('error', (event) => {
  console.warn('[RRE Entries Runtime Error Caught]', event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.warn('[RRE Entries Async Rejection Caught]', event.reason);
});

let currentApiOrigin = (function() {
  if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:4000';
})();

let API_BASE = currentApiOrigin + '/api';

async function fetchApi(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    if (url.includes(':4000')) {
      const altUrl = url.replace(':4000', ':4001');
      try {
        const altRes = await fetch(altUrl, options);
        API_BASE = 'http://127.0.0.1:4001/api';
        return altRes;
      } catch (altErr) {}
    }
    throw err;
  }
}

function getOfflineRolePermissions(role) {
  switch (role) {
    case 'Owner':
    case 'Administrator':
      return {
        role: 'Owner',
        canCreateVouchers: true,
        canEditVouchers: true,
        canDeleteVouchers: true,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: true,
        canAlterCompany: true,
        canCleanSlate: true,
        badgeColor: 'purple',
        allowedVoucherTypes: ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note']
      };
    case 'Accountant':
      return {
        role: 'Accountant',
        canCreateVouchers: true,
        canEditVouchers: true,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'blue',
        allowedVoucherTypes: ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note']
      };
    case 'Data Entry':
      return {
        role: 'Data Entry',
        canCreateVouchers: true,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: false,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'amber',
        allowedVoucherTypes: ['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra']
      };
    case 'Auditor':
      return {
        role: 'Auditor',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'emerald',
        allowedVoucherTypes: []
      };
    case 'Guest':
      return {
        role: 'Guest',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'teal',
        allowedVoucherTypes: []
      };
    case 'Viewer':
    default:
      return {
        role: 'Viewer',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'slate',
        allowedVoucherTypes: []
      };
  }
}

// Application State with Resilient Offline Defaults
let appState = {
  company: {
    name: 'RRE Entries',
    company_number: '100000',
    formal_name: 'M/s. RRE ENTRIES',
    financial_year_from: '2026-04-01',
    books_beginning_from: '2026-04-01',
    gstin: '',
    state: 'Tamil Nadu',
    state_code: '33',
    currency_symbol: '₹'
  },
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
  currentUser: { id: 1, username: 'Administrator', role: 'Owner' },
  permissions: getOfflineRolePermissions('Owner')
};

// ========================================================
// 1. TALLY SECURITY CONTROL & MULTI-USER ENGINE
// ========================================================

const QUICK_USERS = {
  admin: {
    username: 'admin',
    role: 'Owner',
    desc: '<strong>Owner Permissions:</strong> Full Administrative access to all vouchers, financial reports, user security & company alteration.'
  },
  accountant: {
    username: 'accountant',
    role: 'Accountant',
    desc: '<strong>Accountant Permissions:</strong> Create & edit all vouchers, view Balance Sheet, P&L, BRS, GST. Restricted from security and company alteration.'
  },
  dataentry: {
    username: 'dataentry',
    role: 'Data Entry',
    desc: '<strong>Data Entry Permissions:</strong> Operational entry only (Sales, Purchases, Payments, Receipts, Contra). Financial statements restricted.'
  },
  auditor: {
    username: 'auditor',
    role: 'Auditor',
    desc: '<strong>Auditor Permissions:</strong> Statutory inspection mode. Complete read-only view of Ledgers, Day Book, Balance Sheet, GST. Cannot record vouchers.'
  },
  viewer: {
    username: 'viewer',
    role: 'Viewer',
    desc: '<strong>Viewer Permissions:</strong> Executive summary of Dashboard, key ratios, and financial statements. Read-only; cannot record transactions.'
  }
};

// One-click read-only guest entry: the server issues a guest session (no password exists anywhere in the page)
function loginAsGuest() {
  if (window.RREAccounts) window.RREAccounts.continueAsGuest();
}

function selectQuickUser(roleKey) {
  const profile = QUICK_USERS[roleKey];
  if (!profile) return;

  // Highlight selected button
  document.querySelectorAll('#quick-user-selector .qu-btn').forEach(btn => {
    btn.classList.remove('active', 'border-purple-400', 'bg-purple-50', 'border-blue-400', 'bg-blue-50', 'border-amber-400', 'bg-amber-50', 'border-emerald-400', 'bg-emerald-50', 'border-slate-400', 'bg-slate-100', 'border-teal-400', 'bg-teal-50');
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
  if (pInput) pInput.value = '';
  if (hintEl) hintEl.textContent = 'Enter your password';
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
// THEME & COLOR PALETTE ENGINE
// ========================================================

const THEMES = ['aurora', 'tally-gold', 'retro-green', 'midnight-dark', 'ruby-red', 'nordic-light', 'solar-amber'];

function initTheme() {
  let savedTheme = localStorage.getItem('tally_theme');
  // One time only: the new Aurora look becomes the default. Anyone can pick another theme (Alt+T) and it is remembered from then on.
  if (!localStorage.getItem('rre_aurora_default_v1')) { localStorage.setItem('rre_aurora_default_v1', '1'); savedTheme = 'aurora'; }
  applyTheme(savedTheme || 'aurora', false);
}

function applyTheme(themeId, notify = false) {
  if (!THEMES.includes(themeId)) themeId = 'tally-gold';

  document.documentElement.setAttribute('data-theme', themeId);
  document.body.setAttribute('data-theme', themeId);
  localStorage.setItem('tally_theme', themeId);

  // Update theme swatch cards in modal
  THEMES.forEach(t => {
    const card = document.getElementById(`theme-card-${t}`);
    if (card) {
      const activeTag = card.querySelector('.theme-active-tag');
      if (t === themeId) {
        card.classList.add('active');
        if (activeTag) activeTag.classList.remove('hidden');
      } else {
        card.classList.remove('active');
        if (activeTag) activeTag.classList.add('hidden');
      }
    }
  });

  if (window.lucide) window.lucide.createIcons();
}

function openThemeSelectorModal() {
  const currentTheme = localStorage.getItem('tally_theme') || 'aurora';
  applyTheme(currentTheme, false);
  openModal('themeSelectorModal');
}

function cycleNextTheme() {
  const current = localStorage.getItem('tally_theme') || 'tally-gold';
  const currentIndex = THEMES.indexOf(current);
  const nextTheme = THEMES[(currentIndex + 1) % THEMES.length];
  applyTheme(nextTheme, true);
}

// ========================================================
// 2. INITIALIZATION & SESSION LOADING
// ========================================================
document.addEventListener('DOMContentLoaded', () => {
  try {
    initTheme();
    setupKeyboardShortcuts();
    if (window.lucide) window.lucide.createIcons();

    // Direct Standalone Access (Logins removed - Default Full Administrator Access)
    appState.currentUser = { id: 1, username: 'Administrator', role: 'Owner' };
    appState.permissions = getOfflineRolePermissions('Owner');
    updateUserDisplay();
    applyRolePermissions();
    showGateway();
  } catch (initErr) {
    console.error('Initial mount error:', initErr);
    showGateway();
  } finally {
    // Asynchronously load backend data in background without blocking UI rendering
    Promise.allSettled([loadGatewayInfo(), loadMasters()]).then(() => {
      if (window.lucide) window.lucide.createIcons();
    });
  }
});

function updateUserDisplay() {
  const user = appState.currentUser;
  const userEl = document.getElementById('top-user-name');
  const roleEl = document.getElementById('top-user-role');
  const topUsersBtn = document.getElementById('btn-top-users');

  if (!user) {
    if (userEl) userEl.textContent = 'Not Logged In';
    if (roleEl) {
      roleEl.textContent = 'Login Required';
      roleEl.className = 'px-1.5 py-0.2 rounded text-[9px] font-extrabold uppercase border bg-slate-700 text-slate-300 border-slate-600';
    }
    if (topUsersBtn) topUsersBtn.classList.add('hidden');
    return;
  }

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
      case 'Guest':
        roleEl.className += 'bg-teal-500/30 text-teal-300 border-teal-500/40';
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
  return true;
}

function showLoginView() {
  showGateway();
}

function startWithFreshLogin() {
  showGateway();
}

function toggleFreshLoginStartup(checked) {
  // Direct standalone access mode
}

async function handleLogin(e) {
  if (e) e.preventDefault();
  const username = (document.getElementById('login-username')?.value || 'admin').trim();
  const password = document.getElementById('login-password')?.value || '';
  const errEl = document.getElementById('login-error-msg');
  const errText = document.getElementById('login-error-text');

  if (errEl) errEl.classList.add('hidden');

  let loginData = null;

  try {
    const res = await fetchApi('/auth/login', {
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

    loginData = data.data;
  } catch (netErr) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Cannot reach the RRE Entries server. Please make sure the application is running, then try again.';
    return;
  }

  if (loginData) {
    if (errEl) errEl.classList.add('hidden');

    appState.currentUser = loginData.user;
    appState.permissions = loginData.permissions;

    localStorage.setItem('tally_user_session', JSON.stringify({
      user: loginData.user,
      permissions: loginData.permissions,
      token: loginData.token
    }));

    const ribbon = document.getElementById('header-ribbon');
    if (ribbon) ribbon.classList.remove('opacity-40');

    updateUserDisplay();
    applyRolePermissions();
    showGateway();
    if (loginData.must_change_password && window.RREAccounts) window.RREAccounts.promptPasswordChange();
  }
}

function handleLogout() {
  startWithFreshLogin();
}

function openRegisterModal() {
  openModal('registerModal');
  const nameInput = document.getElementById('reg-fullname');
  if (nameInput) nameInput.focus();
  const errEl = document.getElementById('reg-error-msg');
  if (errEl) errEl.classList.add('hidden');
}

function openGoogleLoginModal() {
  openModal('googleLoginModal');
  const emailInput = document.getElementById('google-email');
  if (emailInput) emailInput.focus();
  const errEl = document.getElementById('google-error-msg');
  if (errEl) errEl.classList.add('hidden');
}

function fillGoogleProfile(email, name, role) {
  const emailInput = document.getElementById('google-email');
  const nameInput = document.getElementById('google-name');
  const roleInput = document.getElementById('google-role');
  if (emailInput) emailInput.value = email;
  if (nameInput) nameInput.value = name;
  if (roleInput) roleInput.value = role;
}

async function handleRegister(e) {
  if (e) e.preventDefault();
  const full_name = (document.getElementById('reg-fullname')?.value || '').trim();
  const email = (document.getElementById('reg-email')?.value || '').trim();
  const username = (document.getElementById('reg-username')?.value || '').trim();
  const password = (document.getElementById('reg-password')?.value || '').trim();
  const role = document.getElementById('reg-role')?.value || 'Accountant';
  const errEl = document.getElementById('reg-error-msg');
  const errText = document.getElementById('reg-error-text');
  const submitBtn = document.getElementById('btn-reg-submit');

  if (errEl) errEl.classList.add('hidden');
  if (!full_name || !email || !password) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Please fill in your full name, email address, and password.';
    return;
  }

  const origBtnText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="inline-block animate-spin mr-1">⌛</span> Registering in Authenticator...';
  }

  let authData = null;

  try {
    const res = await fetchApi('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name, email, username, password, role })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (errEl) errEl.classList.remove('hidden');
      if (errText) errText.textContent = data.error || 'Registration failed.';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnText; }
      return;
    }
    authData = data.data;
    if (authData && authData.pending) {
      authData = null;
      closeModal('registerModal');
      alert(data.data.message);
    }
  } catch (err) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Cannot reach the RRE Entries server. Please make sure the application is running, then try again.';
    } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnText; }
  }

  if (authData) {
    closeModal('registerModal');
    appState.currentUser = authData.user;
    appState.permissions = authData.permissions;

    localStorage.setItem('tally_user_session', JSON.stringify({
      user: authData.user,
      permissions: authData.permissions,
      token: authData.token
    }));

    const ribbon = document.getElementById('header-ribbon');
    if (ribbon) ribbon.classList.remove('opacity-40');

    updateUserDisplay();
    applyRolePermissions();
    showGateway();
  }
}

async function handleGoogleAuthSubmit(e) {
  if (e) e.preventDefault();
  const email = (document.getElementById('google-email')?.value || '').trim();
  const name = (document.getElementById('google-name')?.value || '').trim();
  const role = document.getElementById('google-role')?.value || 'Accountant';
  const errEl = document.getElementById('google-error-msg');
  const errText = document.getElementById('google-error-text');
  const submitBtn = document.getElementById('btn-google-submit');

  if (errEl) errEl.classList.add('hidden');
  if (!email) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Please enter a valid Google account email.';
    return;
  }

  const origBtnText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="inline-block animate-spin mr-1">⌛</span> Authenticating with Google...';
  }

  let authData = null;

  try {
    const res = await fetchApi('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: name || email.split('@')[0],
        role,
        google_id: 'g_' + Math.abs(email.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0)).toString(16)
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (errEl) errEl.classList.remove('hidden');
      if (errText) errText.textContent = data.error || 'Google authentication failed.';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnText; }
      return;
    }
    authData = data.data;
  } catch (err) {
    if (errEl) errEl.classList.remove('hidden');
    if (errText) errText.textContent = 'Cannot reach the RRE Entries server. Please make sure the application is running, then try again.';
    } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnText; }
  }

  if (authData) {
    closeModal('googleLoginModal');
    appState.currentUser = authData.user;
    appState.permissions = authData.permissions;

    localStorage.setItem('tally_user_session', JSON.stringify({
      user: authData.user,
      permissions: authData.permissions,
      token: authData.token
    }));

    const ribbon = document.getElementById('header-ribbon');
    if (ribbon) ribbon.classList.remove('opacity-40');

    updateUserDisplay();
    applyRolePermissions();
    showGateway();
  }
}

function openAlterCompany() {
  if (appState.currentView === 'view-login' || !appState.currentUser) {
    selectQuickUser('admin');
    const uInput = document.getElementById('login-username');
    if (uInput) uInput.focus();
    return;
  }
  if (!checkPermission('canAlterCompany', 'Company Alteration Profile')) return;
  openModal('alterCompanyModal');
}

async function startCleanSlate() {
  if (appState.currentView !== 'view-login' && !checkPermission('canCleanSlate', 'Clean Slate / Books Wipe')) return;
  if (!confirm("Wipe demo vouchers and start with Clean Production Slate? This gives you 0 vouchers and ₹0.00 balances, ready for entering your real business data.")) {
    return;
  }
  try {
    const res = await fetchApi('/company/clean-slate', { method: 'POST' });
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
  if (appState.currentView !== 'view-login' && !checkPermission('canCleanSlate', 'Load Sample Demo Data')) return;
  if (!confirm("Load Sample Demo Data? This will populate the system with sample screw compressor transactions for demonstration and practice.")) {
    return;
  }
  try {
    const res = await fetchApi('/company/load-demo', { method: 'POST' });
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

    // Update Top & Gateway DOM safely
    const companyTitle = d.company?.name || 'RRE Entries';
    const setElText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    setElText('top-company-name', companyTitle);
    setElText('gw-company-name', companyTitle);
    setElText('login-company-name', companyTitle);

    const detailsStr = `Company No: ${d.company?.company_number || '100000'} | ${d.company?.state || 'Tamil Nadu'} (${d.company?.state_code || '33'})`;
    setElText('login-company-details', detailsStr);

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

    if (d.current_date) {
      setElText('top-current-date', formatDateDisplay(d.current_date));
      setElText('gateway-date', formatDateDisplay(d.current_date));
    }
    setElText('gateway-vouchers-count', d.total_vouchers ?? 0);
    setElText('gateway-ledgers-count', d.total_ledgers ?? 0);

    if (d.company?.gstin) {
      setElText('gw-company-gstin', `GSTIN: ${d.company.gstin}`);
    }

    if (d.last_voucher) {
      setElText('gateway-last-voucher', `${formatDateDisplay(d.last_voucher.date)} (${d.last_voucher.voucher_no})`);
    } else {
      setElText('gateway-last-voucher', 'None');
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
  const safeFetchJson = async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return { success: false };
      return await r.json();
    } catch (e) {
      return { success: false };
    }
  };

  try {
    const [ledgersRes, itemsRes, groupsRes, godownsRes, uomRes, centresRes] = await Promise.all([
      safeFetchJson(`${API_BASE}/masters/ledgers`),
      safeFetchJson(`${API_BASE}/masters/stock-items`),
      safeFetchJson(`${API_BASE}/masters/groups`),
      safeFetchJson(`${API_BASE}/masters/godowns`),
      safeFetchJson(`${API_BASE}/masters/uom`),
      safeFetchJson(`${API_BASE}/masters/cost-centres`)
    ]);

    if (ledgersRes?.success && Array.isArray(ledgersRes.data)) appState.ledgers = ledgersRes.data;
    if (itemsRes?.success && Array.isArray(itemsRes.data)) appState.stockItems = itemsRes.data;
    if (groupsRes?.success && Array.isArray(groupsRes.data)) appState.groups = groupsRes.data;
    if (godownsRes?.success && Array.isArray(godownsRes.data)) appState.godowns = godownsRes.data;
    if (uomRes?.success && Array.isArray(uomRes.data)) appState.uoms = uomRes.data;
    if (centresRes?.success && Array.isArray(centresRes.data)) appState.costCentres = centresRes.data;

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
  const parentGroupSelect = document.getElementById('m-group-parent');
  if (parentGroupSelect && appState.groups) {
    parentGroupSelect.innerHTML = '<option value="">Primary (Top Level Group)</option>' +
      appState.groups.map(g => `<option value="${g.id}">${g.name} (${g.nature})</option>`).join('');
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
  'view-dashboard',
  'view-gateway',
  'view-display-more',
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

const VIEW_BREADCRUMBS = {
  'view-login': 'Security & Company Login',
  'view-dashboard': 'RRE Entries Live Dashboard',
  'view-gateway': 'Gateway of RRE Entries',
  'view-display-more': 'Gateway of RRE Entries > Display More Reports',
  'view-voucher': 'Gateway of RRE Entries > Accounting Voucher Creation',
  'view-balance-sheet': 'Gateway of RRE Entries > Balance Sheet',
  'view-profit-loss': 'Gateway of RRE Entries > Profit & Loss A/c',
  'view-trial-balance': 'Gateway of RRE Entries > Trial Balance',
  'view-stock-summary': 'Gateway of RRE Entries > Stock Summary',
  'view-daybook': 'Gateway of RRE Entries > Day Book',
  'view-ratio-analysis': 'Gateway of RRE Entries > Ratio Analysis',
  'view-gst': 'Gateway of RRE Entries > GST Portal (GSTR-1 & 3B)',
  'view-outstandings': 'Gateway of RRE Entries > Outstandings (Ageing)',
  'view-bank-recon': 'Gateway of RRE Entries > Bank Reconciliation (BRS)',
  'view-chart-accounts': 'Gateway of RRE Entries > Chart of Accounts'
};

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

  // Update Breadcrumb and Bottom Status Bar Context
  const label = VIEW_BREADCRUMBS[viewId] || 'Gateway of RRE Entries';
  const topCrumb = document.getElementById('top-breadcrumb');
  if (topCrumb) topCrumb.textContent = label;
  const statusCtx = document.getElementById('status-bar-context');
  if (statusCtx) statusCtx.textContent = label;

  if (window.lucide) window.lucide.createIcons();
}

function showGateway() {
  const ribbon = document.getElementById('header-ribbon');
  if (ribbon) ribbon.classList.remove('opacity-40');
  showView('view-gateway');
  loadGatewayInfo();
}

function showDisplayMoreMenu() {
  showView('view-display-more');
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

    // AI Financial Intelligence & Anomaly Banner update
    try {
      const aiRes = await fetchApi('/ai/insights');
      const aiJson = await aiRes.json();
      if (aiJson.success) {
        const badge = document.getElementById('dash-ai-score-badge');
        const summary = document.getElementById('dash-ai-summary');
        if (badge) {
          badge.textContent = `${aiJson.health_score}% Compliance`;
          badge.className = `px-2 py-0.2 rounded-full text-[10px] font-black font-mono ${aiJson.health_score >= 80 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'}`;
        }
        if (summary) {
          summary.textContent = aiJson.issues?.length > 0
            ? `${aiJson.issues.length} anomaly detected: ${aiJson.issues[0].title}. Click Ask AI Copilot to resolve.`
            : `Continuous double-entry verification active: ${aiJson.metrics?.voucher_count || 0} balanced vouchers, zero discrepancies.`;
        }
      }
    } catch (e) {}

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

  const ledgerOptions = appState.ledgers.map(l => `<option value="${l.id}" ${l.name === defaultLedger || String(l.id) === String(defaultLedger) ? 'selected' : ''}>${l.name} (${l.group_name})</option>`).join('');
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
// AI VOUCHER ASSISTANT AUTO-FILL
// ----------------------------------------------------
function toggleVoucherAiAssistBar() {
  const bar = document.getElementById('voucher-ai-assist-bar');
  if (!bar) return;
  bar.classList.toggle('hidden');
  const inp = document.getElementById('voucher-ai-prompt-input');
  if (inp && !bar.classList.contains('hidden')) {
    setTimeout(() => inp.focus(), 50);
  }
}

async function handleVoucherAiAutoFill() {
  const input = document.getElementById('voucher-ai-prompt-input');
  const prompt = (input?.value || '').trim();
  if (!prompt) {
    alert('Please enter a business transaction sentence (e.g. "Paid Office Rent 15000 via Bank" or "Sold 5 Compressors to Apex Tech at 45000 with 18% GST")');
    if (input) input.focus();
    return;
  }

  const btn = document.getElementById('btn-v-ai-autofill');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Auto-filling...</span>';
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const res = await fetchApi('/ai/parse-voucher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    if (!data.success || !data.interpreted) {
      throw new Error(data.error || 'AI could not interpret the voucher prompt');
    }

    const inter = data.interpreted;
    // Set voucher type
    if (inter.voucher_type && inter.voucher_type !== appState.currentVoucherType) {
      appState.currentVoucherType = inter.voucher_type;
      const sel = document.getElementById('v-select-type');
      if (sel) sel.value = inter.voucher_type;
      updateVoucherMeta(inter.voucher_type);
    }

    // Switch to manual mode for strict balanced double-entry
    setVoucherMode('manual');

    // Populate entries table
    const tbody = document.getElementById('voucher-entries-tbody');
    if (tbody && Array.isArray(inter.entries) && inter.entries.length > 0) {
      tbody.innerHTML = '';
      inter.entries.forEach(e => {
        const type = e.debit_amount > 0 ? 'Dr' : 'Cr';
        const amt = e.debit_amount > 0 ? e.debit_amount : e.credit_amount;
        addDoubleEntryRow(type, e.ledger_id, amt);
      });
      recalculateAccountingTotals();
    }

    // Set narration
    const narr = document.getElementById('v-narration');
    if (narr) {
      narr.value = inter.narration || prompt;
    }

    // Auto-focus save button so hitting Enter immediately posts voucher to books!
    const saveBtn = document.getElementById('btn-save-voucher') || document.querySelector('#voucher-form button[type="submit"]') || document.querySelector('#view-voucher button[type="submit"]');
    if (saveBtn) {
      saveBtn.focus();
    }
  } catch (err) {
    alert(`AI Voucher Assist error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="wand-2" class="w-3 h-3 text-amber-300"></i><span>Auto-Fill</span>';
      if (window.lucide) window.lucide.createIcons();
    }
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

    const isReturn = ['Credit Note', 'Debit Note'].includes(voucherType);
    if (isReturn) {
      // Credit / Debit Notes REVERSE the original sale / purchase (see ext/invoice-compose.js)
      if (!window.RRECompose) { alert('The return-voucher module failed to load. Please reload the application.'); return; }
      try {
        window.RRECompose.returnEntries({
          voucherType, party, partyLedgerId, subtotal, cgst, sgst, igst, grandTotal, roundOff, isInterState, ledgers: appState.ledgers
        }).forEach(e => entries.push(e));
      } catch (composeErr) { alert(composeErr.message); return; }
    } else if (isSales) {
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
    let billType = document.getElementById('bill-ref-type').value;
    const enteredBillRef = document.getElementById('bill-ref-name').value;
    const billRef = enteredBillRef || voucherNo;
    if (isReturn) {
      if (billType === 'New Ref') billType = 'Agst Ref'; // a return settles an existing bill; it never opens a new one
      if (!enteredBillRef && !confirm('No original invoice number was entered in "Bill Reference Name".\n\nWithout it this note will not reduce any outstanding bill. Continue anyway?')) return;
    }
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
    const primaryGroups = (appState.groups || []).filter(g => g.is_primary === 1 || !g.parent_id);

    container.innerHTML = primaryGroups.map(pg => {
      const subGroups = (appState.groups || []).filter(sg => sg.parent_id === pg.id);
      const pgLedgers = (appState.ledgers || []).filter(l => l.group_id === pg.id);

      return `
        <div class="border border-slate-200 rounded-lg p-3 bg-white shadow-sm">
          <div class="font-bold text-slate-900 text-sm flex items-center justify-between">
            <div class="flex items-center space-x-2">
              <span class="w-2.5 h-2.5 rounded-full ${pg.nature === 'Assets' ? 'bg-blue-500' : pg.nature === 'Liabilities' ? 'bg-purple-500' : pg.nature === 'Income' ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
              <span>${escapeHtml(pg.name)}</span>
              <span class="text-[10px] text-slate-400">(${pg.nature})</span>
            </div>
            <button type="button" onclick="openCreateLedgerForGroup(${pg.id})" class="text-[11px] text-blue-600 hover:text-blue-800 font-normal hover:underline">+ Add Ledger</button>
          </div>

          <!-- Ledgers in Primary Group -->
          <div class="ml-5 mt-1 space-y-0.5">
            ${pgLedgers.map(l => `<div class="text-slate-700 text-xs flex justify-between py-0.5 border-b border-slate-100"><span>• ${escapeHtml(l.name)}</span><span class="font-mono text-slate-500">${formatCurrency(l.opening_balance)} ${l.opening_balance_type}</span></div>`).join('')}
          </div>

          <!-- Sub Groups -->
          <div class="ml-5 mt-2 space-y-2">
            ${subGroups.map(sg => {
              const sgLedgers = (appState.ledgers || []).filter(l => l.group_id === sg.id);
              return `
                <div class="bg-slate-50 p-2 rounded border border-slate-200">
                  <div class="font-bold text-xs text-slate-800 flex justify-between items-center">
                    <span>↳ ${escapeHtml(sg.name)}</span>
                    <button type="button" onclick="openCreateLedgerForGroup(${sg.id})" class="text-[10px] text-blue-600 hover:text-blue-800 font-normal hover:underline">+ Add Ledger</button>
                  </div>
                  <div class="ml-4 mt-1 space-y-0.5">
                    ${sgLedgers.map(l => `<div class="text-slate-600 text-[11px] flex justify-between py-0.5"><span>- ${escapeHtml(l.name)}</span><span class="font-mono">${formatCurrency(l.opening_balance)} ${l.opening_balance_type}</span></div>`).join('')}
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

// Group Parent Selection Auto-Nature Logic
function handleGroupParentChange() {
  const parentSelect = document.getElementById('m-group-parent');
  const natureSelect = document.getElementById('m-group-nature');
  const affectsCheck = document.getElementById('m-group-affects-gp');
  if (!parentSelect || !natureSelect) return;
  const val = parentSelect.value;
  if (!val) return;
  const parentId = parseInt(val, 10);
  const p = (appState.groups || []).find(g => g.id === parentId);
  if (p) {
    natureSelect.value = p.nature;
    if (affectsCheck) affectsCheck.checked = p.affects_gross_profit === 1;
  }
}

async function handleSaveGroup(e) {
  if (e) e.preventDefault();
  const nameInput = document.getElementById('m-group-name');
  const parentSelect = document.getElementById('m-group-parent');
  const natureSelect = document.getElementById('m-group-nature');
  const affectsCheck = document.getElementById('m-group-affects-gp');

  const name = nameInput ? nameInput.value.trim() : '';
  const parentId = parentSelect && parentSelect.value ? parseInt(parentSelect.value, 10) : null;
  const nature = natureSelect ? natureSelect.value : 'Expenses';
  const affectsGP = affectsCheck ? affectsCheck.checked : false;

  if (!name) {
    alert('Please enter a group name');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/masters/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId, nature, affects_gross_profit: affectsGP })
    });
    const json = await res.json();
    if (json.success) {
      alert(`Group '${name}' created successfully!`);
      if (nameInput) nameInput.value = '';
      closeModal('createGroupModal');
      await loadMasters();
      populateLedgerDropdowns();
      const ledgerGroupSelect = document.getElementById('m-ledger-group');
      if (ledgerGroupSelect && json.id) {
        ledgerGroupSelect.value = json.id;
      }
      if (appState.currentView === 'view-chart-accounts') {
        loadChartOfAccountsTree();
      }
    } else {
      alert(`Error: ${json.error}`);
    }
  } catch (err) {
    alert(`Failed to save group: ${err.message}`);
  }
}

function openCreateLedgerForGroup(groupId) {
  openModal('createLedgerModal');
  const groupSelect = document.getElementById('m-ledger-group');
  if (groupSelect && groupId) {
    groupSelect.value = groupId;
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
  const desc = document.getElementById('m-ledger-desc') ? document.getElementById('m-ledger-desc').value : '';
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
      body: JSON.stringify({ name, group_id: groupId, description: desc, opening_balance: opBal, opening_balance_type: opType, gstin, state, state_code: stateCode })
    });
    const json = await res.json();
    if (json.success) {
      alert(`Ledger '${name}' created successfully!`);
      closeModal('createLedgerModal');
      const descInput = document.getElementById('m-ledger-desc');
      if (descInput) descInput.value = '';
      await loadMasters();
      populatePartyDropdown();
      if (appState.currentView === 'view-chart-accounts') {
        loadChartOfAccountsTree();
      }
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
// 5.5 TALLY CANONICAL MODALS, GO TO (ALT+G) & SUBMENUS
// ========================================================
const GOTO_REGISTRY = [
  // Financial & Accounting Reports
  { title: 'Balance Sheet', category: 'Reports', action: () => openReport('balance-sheet'), hotkey: 'B' },
  { title: 'Profit & Loss A/c', category: 'Reports', action: () => openReport('profit-loss'), hotkey: 'P' },
  { title: 'Trial Balance', category: 'Reports', action: () => openReport('trial-balance'), hotkey: 'T' },
  { title: 'Day Book', category: 'Reports', action: () => openReport('daybook'), hotkey: 'K' },
  { title: 'Stock Summary', category: 'RRE Inventory', action: () => openReport('stock-summary'), hotkey: 'S' },
  { title: 'Ratio Analysis', category: 'Reports', action: () => openReport('ratio-analysis'), hotkey: 'R' },
  { title: 'GST Portal (GSTR-1 & 3B)', category: 'Statutory', action: () => openReport('gst'), hotkey: 'G' },
  { title: 'Bills Outstandings (Ageing)', category: 'Reports', action: () => openReport('outstandings'), hotkey: 'O' },
  { title: 'Bank Reconciliation (BRS)', category: 'Banking', action: () => openReport('bank-recon'), hotkey: 'N' },
  { title: 'Chart of Accounts', category: 'Masters', action: () => openReport('chart-accounts'), hotkey: 'H' },
  { title: 'Live Business Dashboard', category: 'Overview', action: () => toggleDashboard(), hotkey: 'Alt+D' },

  // Transactions (Vouchers)
  { title: 'Create Sales Voucher (Tax Invoice)', category: 'Vouchers', action: () => openVoucherScreen('Sales'), hotkey: 'F8' },
  { title: 'Create Purchase Voucher', category: 'Vouchers', action: () => openVoucherScreen('Purchase'), hotkey: 'F9' },
  { title: 'Create Payment Voucher', category: 'Vouchers', action: () => openVoucherScreen('Payment'), hotkey: 'F5' },
  { title: 'Create Receipt Voucher', category: 'Vouchers', action: () => openVoucherScreen('Receipt'), hotkey: 'F6' },
  { title: 'Create Contra Voucher', category: 'Vouchers', action: () => openVoucherScreen('Contra'), hotkey: 'F4' },
  { title: 'Create Journal Voucher', category: 'Vouchers', action: () => openVoucherScreen('Journal'), hotkey: 'F7' },
  { title: 'Create Debit Note (Purchase Return)', category: 'Vouchers', action: () => openVoucherScreen('Debit Note'), hotkey: 'Alt+F5' },
  { title: 'Create Credit Note (Sales Return)', category: 'Vouchers', action: () => openVoucherScreen('Credit Note'), hotkey: 'Alt+F6' },

  // Masters
  { title: 'Create Account Group', category: 'Masters', action: () => openModal('createGroupModal'), hotkey: 'Alt+G' },
  { title: 'Create Ledger Account', category: 'Masters', action: () => openModal('createLedgerModal'), hotkey: 'Alt+C' },
  { title: 'Create Stock Item', category: 'Masters', action: () => openModal('createStockModal'), hotkey: 'Alt+I' },
  { title: 'Master Creation Hub', category: 'Masters', action: () => openMasterCreateModal(), hotkey: 'C' },
  { title: 'Master Alteration Hub', category: 'Masters', action: () => openMasterAlterModal(), hotkey: 'A' },

  // Utilities & Settings
  { title: 'Change Current Date', category: 'Utilities', action: () => openChangeDateModal(), hotkey: 'F2' },
  { title: 'Company Features (F11)', category: 'Configure', action: () => openF11FeaturesModal(), hotkey: 'F11' },
  { title: 'System Configuration (F12)', category: 'Configure', action: () => openF12ConfigModal(), hotkey: 'F12' },
  { title: 'Banking Utilities', category: 'Banking', action: () => openBankingUtilitiesModal(), hotkey: 'N' },
  { title: 'Users & Passwords (Security)', category: 'Security', action: () => openUserManagement(), hotkey: 'Alt+K' },
  { title: 'Display Color Themes', category: 'Display', action: () => openThemeSelectorModal(), hotkey: 'Alt+T' },
  { title: 'Calculator', category: 'Utilities', action: () => toggleCalculator(), hotkey: 'Ctrl+N' }
];

let goToSelectedIndex = 0;
let filteredGoToList = [];

function openGoToModal() {
  openModal('goToModal');
  const input = document.getElementById('goto-search-input');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 60);
  }
  handleGoToSearch();
}

function handleGoToSearch() {
  const query = (document.getElementById('goto-search-input')?.value || '').trim().toLowerCase();
  if (!query) {
    filteredGoToList = [...GOTO_REGISTRY];
  } else {
    filteredGoToList = GOTO_REGISTRY.filter(item =>
      item.title.toLowerCase().includes(query) ||
      item.category.toLowerCase().includes(query) ||
      (item.hotkey && item.hotkey.toLowerCase().includes(query))
    );
  }
  goToSelectedIndex = 0;
  renderGoToResults();
}

function renderGoToResults() {
  const listEl = document.getElementById('goto-results-list');
  const countEl = document.getElementById('goto-results-count');
  if (!listEl) return;

  if (countEl) countEl.textContent = `${filteredGoToList.length} item${filteredGoToList.length === 1 ? '' : 's'}`;

  if (filteredGoToList.length === 0) {
    listEl.innerHTML = `
      <div class="p-6 text-center text-slate-400">
        <i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
        <div class="font-bold">No matching reports or vouchers found</div>
        <div class="text-[11px] mt-1">Try searching "Balance Sheet", "Sales", "GST", or "Ledger"</div>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  listEl.innerHTML = filteredGoToList.map((item, idx) => `
    <div onclick="handleGoToSelect(${idx})"
         class="goto-item ${idx === goToSelectedIndex ? 'active' : ''}">
      <div class="flex items-center space-x-2">
        <span class="w-2 h-2 rounded-full ${idx === goToSelectedIndex ? 'bg-amber-300' : 'bg-slate-300'}"></span>
        <span class="font-bold">${item.title}</span>
        <span class="goto-category text-[10px] px-1.5 py-0.2 rounded font-mono bg-slate-100 text-slate-600 border border-slate-200">${item.category}</span>
      </div>
      <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100/80 text-slate-700 font-bold border border-slate-300/80">${item.hotkey || 'Enter'}</span>
    </div>
  `).join('');
}

function handleGoToKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (filteredGoToList.length > 0) {
      goToSelectedIndex = (goToSelectedIndex + 1) % filteredGoToList.length;
      renderGoToResults();
      scrollActiveGoToIntoView();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (filteredGoToList.length > 0) {
      goToSelectedIndex = (goToSelectedIndex - 1 + filteredGoToList.length) % filteredGoToList.length;
      renderGoToResults();
      scrollActiveGoToIntoView();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (filteredGoToList[goToSelectedIndex]) {
      handleGoToSelect(goToSelectedIndex);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeModal('goToModal');
  }
}

function scrollActiveGoToIntoView() {
  const activeEl = document.querySelector('.goto-item.active');
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'nearest' });
  }
}

function handleGoToSelect(index) {
  const item = filteredGoToList[index];
  closeModal('goToModal');
  if (item && typeof item.action === 'function') {
    item.action();
  }
}

function openMasterCreateModal() { openModal('masterCreateModal'); }
function openMasterAlterModal() { openModal('masterAlterModal'); }
function openBankingUtilitiesModal() { openModal('bankingUtilitiesModal'); }
function openOtherVouchersModal() { openModal('otherVouchersModal'); }
function openStockJournalModal() { openVoucherScreen('Journal'); }
function openDataMenuModal() {
  openModal('dataMenuModal');
  loadBackupDisasterRecoveryData();
}
function openExchangeMenuModal() { openModal('exchangeMenuModal'); }
function openHelpModal() {
  openModal('helpMenuModal');
  setTimeout(() => checkForUpdates(), 200);
}

async function loadBackupDisasterRecoveryData() {
  const tbody = document.getElementById('backup-list-tbody');
  const integrityEl = document.getElementById('health-db-integrity');
  const sizeEl = document.getElementById('health-db-size');
  const uptimeEl = document.getElementById('health-uptime');
  const badgeText = document.getElementById('health-status-text');

  try {
    // 1. Fetch Health Metrics
    const healthRes = await fetch(`${API_BASE}/health`).then(r => r.json()).catch(() => null);
    if (healthRes && healthRes.status === 'healthy') {
      if (badgeText) badgeText.textContent = 'Healthy';
      if (integrityEl) integrityEl.textContent = 'Verified (OK)';
      if (sizeEl) sizeEl.textContent = `${healthRes.database?.size_mb || '0.10'} MB`;
      if (uptimeEl) uptimeEl.textContent = healthRes.uptime?.human || 'Active';
    }

    // 2. Fetch Backups
    const backupRes = await fetch(`${API_BASE}/backup/list`).then(r => r.json()).catch(() => ({ data: [] }));
    const backups = backupRes.data || [];

    if (!tbody) return;

    if (backups.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="p-3 text-center text-slate-400 font-sans">
            No snapshots recorded yet. Click "Capture Snapshot" above to create an automated point-in-time backup.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = backups.map(b => {
      const dateStr = new Date(b.created_at).toLocaleString();
      const safeName = b.filename;
      const noteStr = b.notes ? `<div class="text-[9px] text-slate-500 font-sans">${escapeHtml(b.notes)}</div>` : '';
      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2">
            <span class="font-bold text-slate-900">${escapeHtml(b.filename)}</span>
            ${noteStr}
          </td>
          <td class="p-2 text-slate-600 font-sans">${dateStr}</td>
          <td class="p-2 font-mono text-slate-700">${b.size_formatted}</td>
          <td class="p-2 text-right space-x-1 font-sans">
            <button type="button" onclick="triggerRestoreBackup('${safeName}')" class="px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-[10px] font-bold shadow-sm" title="Restore database from this point-in-time snapshot">
              Restore Drill
            </button>
            <a href="${API_BASE}/backup/download/${safeName}" download class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold">
              Download
            </a>
          </td>
        </tr>
      `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-rose-500 font-sans">Error loading backup records: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

async function triggerCreateBackup() {
  const noteInput = document.getElementById('backup-note-input');
  const btn = document.getElementById('btn-create-backup');
  const notes = noteInput ? noteInput.value.trim() : '';

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/backup/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    const data = await res.json();
    if (data.success) {
      if (noteInput) noteInput.value = '';
      loadBackupDisasterRecoveryData();
      alert(`Point-in-Time Snapshot created successfully:\n${data.data.filename}\nSize: ${data.data.size_formatted}\nSHA-256 Checksum verified.`);
    } else {
      alert(`Could not create backup: ${data.error}`);
    }
  } catch (err) {
    alert(`Snapshot creation failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function triggerRestoreBackup(filename) {
  const confirmMsg = `WARNING: Are you sure you want to restore the company database from "${filename}"?\n\nA safety rollback snapshot will be created automatically before restoring so zero data can ever be lost.\n\nProceed with restore drill?`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`${API_BASE}/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Restore successful!\n${data.message}\nRollback snapshot saved as: ${data.rollback_snapshot}`);
      closeModal('dataMenuModal');
      if (typeof loadGatewayInfo === 'function') await loadGatewayInfo();
      if (typeof loadDashboard === 'function') await loadDashboard();
    } else {
      alert(`Restore failed: ${data.error}`);
    }
  } catch (err) {
    alert(`Restore drill failed: ${err.message}`);
  }
}

async function checkForUpdates() {
  const spinner = document.getElementById('update-spinner');
  const btnCheck = document.getElementById('btn-check-update');
  const btnDoUpdate = document.getElementById('btn-do-update');
  const badge = document.getElementById('update-online-badge');
  const statusMsg = document.getElementById('update-status-msg');
  const statusText = document.getElementById('update-status-text');
  const remoteStatus = document.getElementById('update-remote-status');
  const remoteCommit = document.getElementById('update-remote-commit');
  const currentCommit = document.getElementById('update-current-commit');

  if (spinner) spinner.classList.remove('hidden');
  if (btnCheck) btnCheck.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/system/update-status`);
    const data = await res.json();

    if (currentCommit) currentCommit.textContent = `Commit: ${data.current_commit || '03810f9'}`;

    if (!data.is_online) {
      if (badge) {
        badge.className = 'flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 inline-block"></span><span>Offline Mode</span>';
      }
      if (remoteStatus) remoteStatus.textContent = 'Offline (No Connection)';
      if (remoteCommit) remoteCommit.textContent = 'Local SQLite Active';
      if (statusMsg) statusMsg.className = 'p-2.5 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-900 flex items-center space-x-2';
      if (statusText) statusText.textContent = 'PC is in 100% offline mode. Connect your PC to the internet to check for updates directly.';
      if (btnDoUpdate) btnDoUpdate.classList.add('hidden');
      return;
    }

    // Online
    if (badge) {
      badge.className = 'flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse"></span><span>Online Connected</span>';
    }

    if (remoteStatus) remoteStatus.textContent = `Latest: ${data.remote_commit}`;
    if (remoteCommit) remoteCommit.textContent = data.remote_message ? `"${data.remote_message.slice(0, 32)}..."` : '-';

    if (data.update_available) {
      if (statusMsg) statusMsg.className = 'p-2.5 bg-emerald-50 border border-emerald-300 rounded text-[11px] text-emerald-950 flex items-center space-x-2';
      if (statusText) statusText.innerHTML = `<strong>Update Available!</strong> Release <code>${data.remote_commit}</code> is available. Click below to install directly on your PC.`;
      if (btnDoUpdate) btnDoUpdate.classList.remove('hidden');
    } else {
      if (statusMsg) statusMsg.className = 'p-2.5 bg-blue-50 border border-blue-200 rounded text-[11px] text-blue-900 flex items-center space-x-2';
      if (statusText) statusText.textContent = 'Your RRE Entries installation is completely up to date!';
      if (btnDoUpdate) btnDoUpdate.classList.add('hidden');
    }
  } catch (err) {
    if (badge) {
      badge.className = 'flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500 inline-block"></span><span>Check Failed</span>';
    }
    if (statusText) statusText.textContent = `Unable to verify update status: ${err.message}`;
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (btnCheck) btnCheck.disabled = false;
    if (window.lucide) window.lucide.createIcons();
  }
}

async function performDirectUpdate() {
  const btnDoUpdate = document.getElementById('btn-do-update');
  const statusText = document.getElementById('update-status-text');

  if (!confirm('Download and install the latest RRE Entries update directly on this PC? All your company accounting data in company.db will remain 100% intact.')) {
    return;
  }

  if (btnDoUpdate) {
    btnDoUpdate.disabled = true;
    btnDoUpdate.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Updating PC Application...</span>';
    if (window.lucide) window.lucide.createIcons();
  }
  if (statusText) statusText.textContent = 'Pulling latest release from GitHub and applying updates to your PC installation...';

  try {
    const res = await fetch(`${API_BASE}/system/perform-update`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (data.requires_download) {
        alert(data.message);
        if (data.download_url) {
          window.open(data.download_url, '_blank');
        }
      } else {
        alert(data.message || 'RRE Entries update launched successfully! The application will refresh.');
        setTimeout(() => location.reload(), 2500);
      }
    } else {
      alert(`Update notification: ${data.error || 'Please run the RRE Entries Setup installer to update.'}`);
    }
  } catch (err) {
    alert(`Update request error: ${err.message}`);
  } finally {
    if (btnDoUpdate) {
      btnDoUpdate.disabled = false;
      btnDoUpdate.innerHTML = '<i data-lucide="download-cloud" class="w-3.5 h-3.5"></i><span>Direct Update &amp; Install on PC</span>';
      if (window.lucide) window.lucide.createIcons();
    }
  }
}
function openF11FeaturesModal() { openModal('f11FeaturesModal'); }
function openF12ConfigModal() { openModal('f12ConfigModal'); }

function openChangeDateModal() {
  openModal('changeDateModal');
  const dInput = document.getElementById('input-change-date');
  if (dInput) {
    setTimeout(() => dInput.focus(), 50);
  }
}

async function handleChangeDate(e) {
  e.preventDefault();
  const newDate = document.getElementById('input-change-date')?.value;
  if (!newDate) return;

  const formattedDate = formatDateDisplay(newDate);
  const topDateEl = document.getElementById('top-current-date');
  const gwDateEl = document.getElementById('gateway-date');
  if (topDateEl) topDateEl.textContent = `${formattedDate} (F2)`;
  if (gwDateEl) gwDateEl.textContent = `${formattedDate} (F2)`;

  closeModal('changeDateModal');
  alert(`Current voucher date successfully changed to ${formattedDate}`);
}

// Helper to close modals on Esc
function closeAnyOpenModal() {
  const copilotDrawer = document.getElementById('ai-copilot-drawer');
  if (copilotDrawer && !copilotDrawer.classList.contains('hidden')) {
    copilotDrawer.classList.add('hidden');
    return true;
  }
  const openModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)'));
  if (openModals.length > 0) {
    openModals.forEach(m => m.classList.add('hidden'));
    return true;
  }
  return false;
}

// ========================================================
// RRE AI COPILOT & FINANCIAL INTELLIGENCE ARCHITECTURE
// ========================================================

let aiState = {
  isCopilotOpen: false,
  isWorkspaceActive: false,
  insightsCache: null
};

// 1. Toggle AI Copilot Drawer
function toggleAiCopilot(forceOpen = null) {
  const drawer = document.getElementById('ai-copilot-drawer');
  if (!drawer) return;

  if (forceOpen === true) {
    aiState.isCopilotOpen = true;
  } else if (forceOpen === false) {
    aiState.isCopilotOpen = false;
  } else {
    aiState.isCopilotOpen = !aiState.isCopilotOpen;
  }

  if (aiState.isCopilotOpen) {
    drawer.classList.remove('hidden');
    setTimeout(() => {
      const input = document.getElementById('copilot-user-input');
      if (input) input.focus();
    }, 100);
  } else {
    drawer.classList.add('hidden');
  }
  if (window.lucide) window.lucide.createIcons();
}

function clearAiChat() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;
  container.innerHTML = `
    <div class="flex items-start space-x-2">
      <div class="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
        <i data-lucide="bot" class="w-3.5 h-3.5 text-white"></i>
      </div>
      <div class="bg-slate-900 border border-indigo-500/30 rounded-xl p-3 text-slate-200 space-y-1.5 max-w-[85%] shadow-sm">
        <p class="font-bold text-indigo-300">Chat reset. Ready for your prompt!</p>
        <p class="text-[11px] text-slate-300">Ask any financial question or type a transaction to draft a voucher.</p>
      </div>
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();
}

function sendCopilotQuick(prompt) {
  const input = document.getElementById('copilot-user-input');
  if (input) {
    input.value = prompt;
    handleCopilotSubmit(new Event('submit'));
  }
}

// AI Voice Synthesis & Natural Audio Output
let aiVoiceEnabled = false;

function toggleAiVoice() {
  aiVoiceEnabled = !aiVoiceEnabled;
  updateAiVoiceUi();
  if (aiVoiceEnabled) {
    speakAiText("AI voice output enabled. Answers will be spoken aloud.");
  } else {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}

function updateAiVoiceUi() {
  const wsBtn = document.getElementById('btn-toggle-ai-voice-ws');
  const copilotBtn = document.getElementById('btn-toggle-ai-voice-copilot');
  [wsBtn, copilotBtn].forEach(b => {
    if (b) {
      if (aiVoiceEnabled) {
        b.className = 'px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center space-x-1.5 shadow-sm bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-400';
        b.innerHTML = '<i data-lucide="volume-2" class="w-3.5 h-3.5 text-white"></i><span>Voice: ON</span>';
      } else {
        b.className = 'px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center space-x-1.5 shadow-sm bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700';
        b.innerHTML = '<i data-lucide="volume-x" class="w-3.5 h-3.5 text-slate-400"></i><span>Voice: OFF</span>';
      }
    }
  });
  if (window.lucide) window.lucide.createIcons();
}

function speakAiText(text) {
  if (!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const clean = text
    .replace(/[*#_`]/g, '')
    .replace(/[•-]\s+/g, ', ')
    .replace(/₹/g, 'Rupees ')
    .replace(/\n+/g, '. ')
    .replace(/✅|⚠️|📊|🛒|💸|📦|🏛️|⚖️|📒|🏢|💰|👥|🛡️|✨|✓/g, '');
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

function isFinancialQuestion(query) {
  if (!query || typeof query !== 'string') return false;
  const q = query.trim().toLowerCase();
  if (q.endsWith('?')) return true;
  if (/^(what|how|who|show|list|view|check|tell|get|find|can|explain|is there|do we|audit|query|summary|details)\b/i.test(q)) {
    return true;
  }
  if (/(?:net\s+)?profit|margin|earnings|gross\s+profit|cogs|purchases|expenses|stock|inventory|valuation|debtors|creditors|receivables|payables|working\s+capital|current\s+ratio|quick\s+ratio|solvency|gst|tax|cgst|sgst|company|gstin|pan|daybook|recent\s+vouchers|health\s+score|anomal/i.test(q)) {
    if (!/^(sold|bought|paid|received|deposited|withdrew|transfer|purchased)\s+\d+/i.test(q)) {
      return true;
    }
  }
  return false;
}

function getActionReportButton(action) {
  if (action === 'view-profit-loss') {
    return `<button type="button" onclick="showReport('view-profit-loss')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="pie-chart" class="w-3.5 h-3.5"></i><span>Open P&amp;L Statement</span></button>`;
  } else if (action === 'view-balance-sheet') {
    return `<button type="button" onclick="showReport('view-balance-sheet')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="scale" class="w-3.5 h-3.5"></i><span>Open Balance Sheet</span></button>`;
  } else if (action === 'view-stock' || action === 'view-stock-summary') {
    return `<button type="button" onclick="showReport('view-stock-summary')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="boxes" class="w-3.5 h-3.5"></i><span>Open Stock Summary</span></button>`;
  } else if (action === 'view-daybook') {
    return `<button type="button" onclick="showReport('view-daybook')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="book-open" class="w-3.5 h-3.5"></i><span>Open Day Book</span></button>`;
  } else if (action === 'view-ledger' || action === 'view-chart-accounts') {
    return `<button type="button" onclick="openReport('chart-accounts')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="list" class="w-3.5 h-3.5"></i><span>Chart of Accounts</span></button>`;
  } else if (action === 'view-sales') {
    return `<button type="button" onclick="openVoucherScreen('Sales')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="plus-circle" class="w-3.5 h-3.5"></i><span>New Sales Voucher</span></button>`;
  } else if (action === 'view-purchases') {
    return `<button type="button" onclick="openVoucherScreen('Purchase')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs flex items-center space-x-1"><i data-lucide="plus-circle" class="w-3.5 h-3.5"></i><span>New Purchase Voucher</span></button>`;
  }
  return '';
}

async function handleCopilotSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('copilot-user-input');
  const query = (input?.value || '').trim();
  if (!query) return;

  input.value = '';
  appendChatMessage('user', query);

  const loadingId = 'loading-' + Date.now();
  appendChatMessage('assistant', `<div id="${loadingId}" class="flex items-center space-x-2 text-indigo-300 font-mono text-[11px]"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Analyzing business prompt...</span></div>`);

  try {
    const isQuestion = isFinancialQuestion(query);

    if (!isQuestion) {
      const res = await fetchApi('/ai/parse-voucher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: query })
      });
      const data = await res.json();
      const el = document.getElementById(loadingId);
      if (el) el.parentElement.innerHTML = formatCopilotVoucherDraft(data.interpreted);
    } else {
      const res = await fetchApi('/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      const el = document.getElementById(loadingId);
      const answer = data.data?.answer || 'Query processed.';
      const encodedAnswer = encodeURIComponent(answer);
      if (el) {
        el.parentElement.innerHTML = `
          <div class="space-y-2">
            <div>${formatCopilotAnswer(answer)}</div>
            <div class="pt-1.5 flex items-center justify-between border-t border-slate-800">
              <button type="button" onclick="speakAiText(decodeURIComponent('${encodedAnswer}'))" class="text-[10px] text-indigo-300 hover:text-white flex items-center space-x-1 transition">
                <i data-lucide="volume-2" class="w-3 h-3 text-amber-300"></i>
                <span>🔊 Say Answer</span>
              </button>
            </div>
          </div>
        `;
      }
      if (aiVoiceEnabled) {
        speakAiText(answer);
      }
    }
  } catch (err) {
    const el = document.getElementById(loadingId);
    if (el) el.parentElement.innerHTML = `<span class="text-rose-400">Error processing query: ${err.message}</span>`;
  }

  const container = document.getElementById('ai-chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
  if (window.lucide) window.lucide.createIcons();
}

function appendChatMessage(sender, htmlContent) {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = sender === 'user'
    ? 'flex items-start justify-end space-x-2'
    : 'flex items-start space-x-2';

  if (sender === 'user') {
    msgDiv.innerHTML = `
      <div class="bg-indigo-600 text-white rounded-xl px-3 py-2 text-[11px] max-w-[80%] shadow-sm">
        ${escapeHtml(htmlContent)}
      </div>
      <div class="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">
        👤
      </div>
    `;
  } else {
    msgDiv.innerHTML = `
      <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-500 flex items-center justify-center shrink-0 mt-0.5">
        <i data-lucide="bot" class="w-3.5 h-3.5 text-white"></i>
      </div>
      <div class="bg-slate-900 border border-indigo-500/30 rounded-xl p-3 text-slate-200 text-[11px] leading-relaxed max-w-[85%] shadow-sm space-y-1.5">
        ${htmlContent}
      </div>
    `;
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
  if (window.lucide) window.lucide.createIcons();
}

function formatCopilotAnswer(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/• (.*?)(?=\n|$)/g, '<li class="ml-3 list-disc">$1</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function formatCopilotVoucherDraft(v) {
  if (!v) return '<span class="text-rose-400">Could not interpret voucher details.</span>';

  const entryRows = v.entries.map(e => `
    <div class="flex justify-between items-center text-[10px] font-mono border-b border-slate-800 py-1">
      <span class="text-slate-300 truncate max-w-[140px]">${e.ledger_name}</span>
      <span class="font-bold ${e.debit_amount > 0 ? 'text-amber-300' : 'text-emerald-400'}">
        ${e.debit_amount > 0 ? 'Dr ' + formatCurrency(e.debit_amount) : 'Cr ' + formatCurrency(e.credit_amount)}
      </span>
    </div>
  `).join('');

  const jsonStr = encodeURIComponent(JSON.stringify(v));

  return `
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="px-2 py-0.5 rounded text-[10px] font-black bg-indigo-950 text-indigo-300 border border-indigo-500/40">
          ✨ Drafted ${v.voucher_type} Voucher
        </span>
        <span class="text-[10px] text-emerald-400 font-mono font-bold">${v.is_balanced ? '✓ Balanced' : '⚠️ Unbalanced'}</span>
      </div>
      <div class="bg-slate-950/70 p-2 rounded border border-slate-800">
        ${entryRows}
      </div>
      <div class="flex items-center justify-between text-[10px]">
        <span class="text-slate-400">Total: <strong>${formatCurrency(v.total_amount)}</strong></span>
        <button onclick="saveAiDraftFromChat('${jsonStr}')" class="px-2.5 py-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded shadow flex items-center space-x-1">
          <i data-lucide="check" class="w-3 h-3"></i>
          <span>Save to Books</span>
        </button>
      </div>
    </div>
  `;
}

async function saveAiDraftFromChat(encodedJson) {
  try {
    const voucher = JSON.parse(decodeURIComponent(encodedJson));
    const res = await fetchApi('/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voucher_type: voucher.voucher_type,
        voucher_no: voucher.voucher_no,
        date: voucher.date,
        narration: voucher.narration,
        entries: voucher.entries
      })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Success! Voucher ${voucher.voucher_no} (${voucher.voucher_type}) saved into company database.`);
      loadGatewayInfo();
      refreshAiInsights();
    } else {
      alert(`Failed to save voucher: ${data.error}`);
    }
  } catch (err) {
    alert(`Save error: ${err.message}`);
  }
}

// 2. AI Executive Workspace View
function toggleAiWorkspaceView() {
  const wsView = document.getElementById('view-ai-workspace');
  const gwView = document.getElementById('view-gateway');
  const label = document.getElementById('ai-view-toggle-text');

  aiState.isWorkspaceActive = !aiState.isWorkspaceActive;

  if (aiState.isWorkspaceActive) {
    if (gwView) gwView.classList.add('hidden');
    if (wsView) {
      wsView.classList.remove('hidden');
      loadAiWorkspaceData();
    }
    if (label) label.textContent = '⌨️ Classic Tally';
    appState.currentView = 'view-ai-workspace';
  } else {
    if (wsView) wsView.classList.add('hidden');
    if (gwView) gwView.classList.remove('hidden');
    if (label) label.textContent = '⚡ AI Workspace';
    appState.currentView = 'view-gateway';
  }
  if (window.lucide) window.lucide.createIcons();
}

async function loadAiWorkspaceData() {
  try {
    const res = await fetchApi('/ai/insights');
    const data = await res.json();
    if (!data.success) return;

    aiState.insightsCache = data;

    // 1. Update Health Score Badge
    const scoreEl = document.getElementById('ai-top-score');
    if (scoreEl) scoreEl.textContent = `${data.health_score}%`;

    // 2. Metrics Cards
    const totalLiquidity = (data.metrics.cash_balance || 0) + (data.metrics.bank_balance || 0);
    const liqEl = document.getElementById('ai-metric-liquidity');
    if (liqEl) liqEl.textContent = formatCurrency(totalLiquidity);

    const cashSubEl = document.getElementById('ai-metric-cash-sub');
    if (cashSubEl) cashSubEl.textContent = `Cash: ${formatCurrency(data.metrics.cash_balance)} | Bank: ${formatCurrency(data.metrics.bank_balance)}`;

    // Query Sales & Debtors directly
    const [salesQ, debtorsQ, gstQ] = await Promise.all([
      fetchApi('/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'total sales' }) }).then(r => r.json()).catch(() => ({})),
      fetchApi('/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'who owes us money' }) }).then(r => r.json()).catch(() => ({})),
      fetchApi('/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'gst tax liability' }) }).then(r => r.json()).catch(() => ({}))
    ]);

    const salesEl = document.getElementById('ai-metric-sales');
    if (salesEl) salesEl.textContent = formatCurrency(salesQ.data?.data?.total || 0);

    const salesSubEl = document.getElementById('ai-metric-sales-sub');
    if (salesSubEl) salesSubEl.textContent = `Total Vouchers: ${salesQ.data?.data?.count || 0}`;

    const debtorsEl = document.getElementById('ai-metric-debtors');
    const debtorsList = Array.isArray(debtorsQ.data?.data) ? debtorsQ.data.data : [];
    const totalDebtors = debtorsList.reduce((s, d) => s + (d.balance || 0), 0);
    if (debtorsEl) debtorsEl.textContent = formatCurrency(totalDebtors);

    const debtorsSubEl = document.getElementById('ai-metric-debtors-sub');
    if (debtorsSubEl) debtorsSubEl.textContent = debtorsList.length > 0 ? `Top: ${debtorsList[0].name}` : 'No overdue debtors';

    const gstEl = document.getElementById('ai-metric-gst');
    if (gstEl) gstEl.textContent = formatCurrency(gstQ.data?.data?.totalGst || 0);

    // 3. Populate Anomaly Feed
    const feed = document.getElementById('ai-anomaly-feed');
    if (feed) {
      if (data.issues && data.issues.length > 0) {
        feed.innerHTML = data.issues.map(iss => `
          <div class="p-3 bg-slate-900 border ${iss.severity === 'CRITICAL' ? 'border-rose-500/50 bg-rose-950/20' : 'border-amber-500/50 bg-amber-950/20'} rounded-lg flex items-start justify-between">
            <div class="flex items-start space-x-2">
              <i data-lucide="${iss.severity === 'CRITICAL' ? 'alert-triangle' : 'alert-circle'}" class="w-4 h-4 ${iss.severity === 'CRITICAL' ? 'text-rose-400' : 'text-amber-400'} shrink-0 mt-0.5"></i>
              <div>
                <div class="font-bold text-slate-200">${iss.title}</div>
                <div class="text-[11px] text-slate-400 mt-0.5">${iss.description}</div>
              </div>
            </div>
            <button onclick="handleResolveAnomaly('${iss.type}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-bold shrink-0 ml-3 transition">
              Resolve
            </button>
          </div>
        `).join('');
      } else {
        feed.innerHTML = `
          <div class="p-3 bg-emerald-950/30 border border-emerald-500/40 rounded-lg flex items-center space-x-2 text-emerald-300">
            <i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i>
            <span>No financial anomalies detected! Your books, vouchers, and cash accounts are 100% compliant.</span>
          </div>
        `;
      }
    }
  } catch (err) {
    console.warn('[AI Workspace] Load notice:', err.message);
  } finally {
    if (window.lucide) window.lucide.createIcons();
  }
}

function refreshAiInsights() {
  loadAiWorkspaceData();
}

function handleResolveAnomaly(type) {
  if (type === 'NEGATIVE_CASH') {
    openVoucherScreen('Receipt');
  } else if (type === 'UNBALANCED_VOUCHER') {
    openReport('daybook');
  } else if (type === 'LOW_STOCK') {
    openVoucherScreen('Purchase');
  } else {
    toggleAiCopilot(true);
  }
}

function fillAndSubmitAiPrompt(promptText) {
  const input = document.getElementById('ai-ws-prompt-input');
  if (input) {
    input.value = promptText;
    handleAiWorkspaceSubmit(new Event('submit'));
  }
}

async function handleAiWorkspaceSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('ai-ws-prompt-input');
  const prompt = (input?.value || '').trim();
  if (!prompt) return;

  const btn = document.getElementById('btn-ai-ws-submit');
  const container = document.getElementById('ai-ws-draft-container');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Analyzing...</span>';
  }

  try {
    const isQuestion = isFinancialQuestion(prompt);

    if (isQuestion) {
      // 1. Universal Database Financial Query
      const res = await fetchApi('/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt })
      });
      const data = await res.json();

      if (!data.success) {
        alert(`AI query notice: ${data.error || 'Could not process database question.'}`);
        return;
      }

      const answer = data.data?.answer || 'No answer returned from financial agent.';
      const action = data.data?.action || '';
      const encodedAnswer = encodeURIComponent(answer);

      if (container) {
        container.classList.remove('hidden');
        container.innerHTML = `
          <div class="p-4 bg-slate-900 border border-indigo-500/50 rounded-xl space-y-3 shadow-lg">
            <div class="flex items-center justify-between border-b border-indigo-500/20 pb-2">
              <div class="flex items-center space-x-2">
                <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-gradient-to-r from-purple-600 to-indigo-600 text-white flex items-center space-x-1">
                  <i data-lucide="bot" class="w-3 h-3 text-amber-300"></i>
                  <span>AI Database Insight</span>
                </span>
                <span class="text-xs text-slate-400 font-mono">100% Offline SQLite</span>
              </div>
              <div class="flex items-center space-x-2">
                <button type="button" onclick="speakAiText(decodeURIComponent('${encodedAnswer}'))" class="px-2.5 py-1 bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-500/40 text-indigo-200 rounded text-xs font-bold flex items-center space-x-1 shadow-sm transition" title="Speak Answer Aloud">
                  <i data-lucide="volume-2" class="w-3.5 h-3.5 text-amber-300"></i>
                  <span>🔊 Say Answer</span>
                </button>
                <button type="button" onclick="document.getElementById('ai-ws-draft-container').classList.add('hidden')" class="text-slate-400 hover:text-white p-1 rounded">
                  <i data-lucide="x" class="w-4 h-4"></i>
                </button>
              </div>
            </div>

            <div class="bg-slate-950/80 rounded-lg p-3.5 border border-slate-800 text-slate-200 text-xs leading-relaxed font-sans space-y-2">
              ${formatCopilotAnswer(answer)}
            </div>

            <div class="flex items-center justify-between pt-1">
              <div class="text-[11px] text-slate-400 flex items-center space-x-1.5">
                <i data-lucide="check-circle" class="w-3.5 h-3.5 text-emerald-400"></i>
                <span>Directly queried from active company database</span>
              </div>
              <div class="space-x-2 flex items-center">
                ${getActionReportButton(action)}
                <button type="button" onclick="document.getElementById('ai-ws-draft-container').classList.add('hidden')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-bold text-xs transition">
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        `;

        if (aiVoiceEnabled) {
          speakAiText(answer);
        }
      }
    } else {
      // 2. Voucher Parsing & Auto-Drafting
      const res = await fetchApi('/ai/parse-voucher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();

      if (!data.success) {
        alert(`AI parsing note: ${data.error || 'Please provide more details.'}`);
        return;
      }

      const v = data.interpreted;
      const jsonStr = encodeURIComponent(JSON.stringify(v));

      if (container) {
        container.classList.remove('hidden');
        container.innerHTML = `
          <div id="ai-ws-draft-card" class="p-3.5 bg-slate-900 border border-indigo-500/40 rounded-xl space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2">
                <span class="px-2 py-0.5 rounded text-[11px] font-black bg-indigo-600 text-white">${v.voucher_type} Voucher</span>
                <span class="text-xs text-slate-300 font-mono">${v.voucher_no} (${v.date})</span>
              </div>
              <span class="text-xs font-bold ${v.is_balanced ? 'text-emerald-400' : 'text-rose-400'}">${v.is_balanced ? '✓ Double-Entry Verified' : '⚠️ Unbalanced'}</span>
            </div>

            <div class="bg-slate-950 rounded-lg p-2.5 border border-slate-800">
              <table class="w-full text-xs font-mono">
                <thead>
                  <tr class="text-slate-500 border-b border-slate-800">
                    <th class="text-left pb-1 font-sans">Ledger Account</th>
                    <th class="text-right pb-1 font-sans">Debit (Dr)</th>
                    <th class="text-right pb-1 font-sans">Credit (Cr)</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  ${v.entries.map(e => `
                    <tr>
                      <td class="py-1 text-slate-300">${e.ledger_name}</td>
                      <td class="py-1 text-right text-amber-300">${e.debit_amount > 0 ? formatCurrency(e.debit_amount) : '-'}</td>
                      <td class="py-1 text-right text-emerald-400">${e.credit_amount > 0 ? formatCurrency(e.credit_amount) : '-'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="flex items-center justify-between pt-1">
              <div class="text-[11px] text-slate-400">Total: <strong class="text-white">${formatCurrency(v.total_amount)}</strong></div>
              <div class="space-x-2 flex items-center">
                <button type="button" onclick="document.getElementById('ai-ws-draft-container').classList.add('hidden')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-bold text-xs">Dismiss</button>
                <button type="button" id="btn-save-ai-ws-draft" onclick="saveAiDraftFromChat('${jsonStr}')" class="px-4 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-lg font-black text-xs shadow-md transition flex items-center space-x-1.5 focus:ring-2 focus:ring-emerald-400 focus:outline-none">
                  <i data-lucide="check" class="w-3.5 h-3.5"></i>
                  <span>💾 Confirm &amp; Save Voucher (Enter)</span>
                </button>
              </div>
            </div>
          </div>
        `;

        // Auto-focus the Confirm & Save button so hitting Enter again immediately saves!
        setTimeout(() => {
          const saveBtn = document.getElementById('btn-save-ai-ws-draft');
          if (saveBtn) saveBtn.focus();
        }, 80);
      }
    }
  } catch (err) {
    alert(`AI analysis error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="sparkles" class="w-3.5 h-3.5 text-amber-300"></i><span>Draft (Enter)</span>';
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

// 3. Omni-Search Command Palette (Ctrl+K)
const OMNI_COMMANDS = [
  { title: 'Create Sales Voucher', category: 'Vouchers', hotkey: 'F8', action: () => openVoucherScreen('Sales') },
  { title: 'Create Purchase Voucher', category: 'Vouchers', hotkey: 'F9', action: () => openVoucherScreen('Purchase') },
  { title: 'Create Payment Voucher', category: 'Vouchers', hotkey: 'F5', action: () => openVoucherScreen('Payment') },
  { title: 'Create Receipt Voucher', category: 'Vouchers', hotkey: 'F6', action: () => openVoucherScreen('Receipt') },
  { title: 'Create Contra Voucher', category: 'Vouchers', hotkey: 'F4', action: () => openVoucherScreen('Contra') },
  { title: 'Create Journal Voucher', category: 'Vouchers', hotkey: 'F7', action: () => openVoucherScreen('Journal') },
  { title: 'Balance Sheet', category: 'Reports', hotkey: 'B', action: () => openReport('balance-sheet') },
  { title: 'Profit & Loss Statement', category: 'Reports', hotkey: 'P', action: () => openReport('profit-loss') },
  { title: 'Trial Balance', category: 'Reports', hotkey: 'T', action: () => openReport('trial-balance') },
  { title: 'Day Book Journal', category: 'Reports', hotkey: 'D', action: () => openReport('daybook') },
  { title: 'Ratio Analysis', category: 'Reports', hotkey: 'R', action: () => openReport('ratio-analysis') },
  { title: 'GST Statutory Returns (GSTR-1 & 3B)', category: 'Reports', hotkey: 'O', action: () => openReport('gst') },
  { title: 'Create Ledger Account', category: 'Masters', hotkey: 'Alt+C', action: () => openModal('createLedgerModal') },
  { title: 'Create Stock Item', category: 'Masters', hotkey: 'I', action: () => openModal('createStockModal') },
  { title: 'AI Copilot Assistant', category: 'AI', hotkey: 'Alt+A', action: () => toggleAiCopilot(true) },
  { title: 'AI Executive Workspace', category: 'AI', hotkey: '⚡', action: () => toggleAiWorkspaceView() },
  { title: 'Parse Invoice / Bill Document', category: 'AI', hotkey: '🧾', action: () => openAiDocParserModal() },
  { title: 'Security Control & User Management', category: 'System', hotkey: 'Alt+K', action: () => openUserManagement() },
  { title: 'Change Theme Palette', category: 'System', hotkey: 'Alt+T', action: () => openThemeSelectorModal() },
  { title: 'Change Current Date', category: 'System', hotkey: 'F2', action: () => openChangeDateModal() }
];

function openOmniSearchModal() {
  openModal('omniSearchModal');
  const input = document.getElementById('omni-search-input');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 80);
  }
  renderOmniResults(OMNI_COMMANDS);
}

function handleOmniSearchInput(e) {
  const query = (e.target.value || '').trim().toLowerCase();
  if (!query) {
    renderOmniResults(OMNI_COMMANDS);
    return;
  }

  const filtered = OMNI_COMMANDS.filter(c =>
    c.title.toLowerCase().includes(query) ||
    c.category.toLowerCase().includes(query) ||
    (c.hotkey && c.hotkey.toLowerCase().includes(query))
  );

  filtered.unshift({
    title: `Ask AI Copilot: "${e.target.value}"`,
    category: '✨ AI Natural Language',
    hotkey: 'Enter',
    action: () => {
      closeModal('omniSearchModal');
      toggleAiCopilot(true);
      sendCopilotQuick(e.target.value);
    }
  });

  renderOmniResults(filtered);
}

function renderOmniResults(list) {
  const container = document.getElementById('omni-results-list');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = '<div class="p-4 text-center text-slate-500">No matching commands or ledgers found.</div>';
    return;
  }

  container.innerHTML = list.map((item, idx) => `
    <div onclick="executeOmniAction(${idx})" class="flex items-center justify-between p-2.5 rounded-lg hover:bg-indigo-950/70 cursor-pointer border border-transparent hover:border-indigo-500/30 transition text-xs">
      <div class="flex items-center space-x-2.5">
        <span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${item.category.includes('AI') ? 'bg-purple-900/60 text-purple-300' : 'bg-slate-800 text-slate-400'}">
          ${item.category}
        </span>
        <span class="text-slate-200 font-semibold">${item.title}</span>
      </div>
      <kbd class="px-1.5 py-0.5 bg-slate-800 text-slate-400 font-mono text-[10px] rounded">${item.hotkey || 'Go'}</kbd>
    </div>
  `).join('');

  window._activeOmniList = list;
}

function executeOmniAction(idx) {
  const item = (window._activeOmniList || OMNI_COMMANDS)[idx];
  if (item && item.action) {
    closeModal('omniSearchModal');
    item.action();
  }
}

// 4. AI Document / Invoice Text Parser
function openAiDocParserModal() {
  openModal('aiDocParserModal');
  const txt = document.getElementById('ai-doc-raw-text');
  if (txt) {
    setTimeout(() => txt.focus(), 80);
  }
  const preview = document.getElementById('ai-doc-preview-area');
  if (preview) preview.classList.add('hidden');
}

async function handleAiDocParse() {
  const txt = document.getElementById('ai-doc-raw-text')?.value;
  const btn = document.getElementById('btn-parse-doc');
  const preview = document.getElementById('ai-doc-preview-area');

  if (!txt || !txt.trim()) {
    alert('Please paste or type invoice text to parse.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Analyzing Bill...</span>';
  }

  try {
    const res = await fetchApi('/ai/parse-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: txt })
    });
    const data = await res.json();
    if (!data.success) {
      alert(`Parsing failed: ${data.error}`);
      return;
    }

    const doc = data.document_parsed;
    const v = doc.draft_voucher;
    const jsonStr = encodeURIComponent(JSON.stringify(v));

    if (preview) {
      preview.classList.remove('hidden');
      preview.innerHTML = `
        <div class="space-y-2">
          <div class="flex justify-between items-center text-xs">
            <span class="font-bold text-indigo-900">Extracted Invoice: ${doc.invoice_no}</span>
            <span class="font-bold text-emerald-700">${formatCurrency(doc.detected_amount)}</span>
          </div>
          <div class="text-[11px] text-slate-600 font-mono">
            Voucher Type: <strong>${v.voucher_type}</strong> | Balanced: <strong>${v.is_balanced ? 'Yes' : 'No'}</strong>
          </div>
          <button type="button" onclick="saveAiDraftFromChat('${jsonStr}'); closeModal('aiDocParserModal');" class="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs shadow transition">
            💾 Confirm &amp; Save Voucher to Books
          </button>
        </div>
      `;
    }
  } catch (err) {
    alert(`Document parse error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="sparkles" class="w-3.5 h-3.5"></i><span>AI Parse Invoice</span>';
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

// ========================================================
// 6. KEYBOARD SHORTCUTS & INTERACTIVE ASSISTANT
// ========================================================
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

    // Escape handling
    if (e.key === 'Escape') {
      e.preventDefault();
      // If any modal or AI drawer is open, close it
      if (closeAnyOpenModal()) return;

      // If in AI Workspace, return to Gateway
      if (aiState.isWorkspaceActive) {
        toggleAiWorkspaceView();
        return;
      }

      // If in sub-view or report, return to Gateway
      if (appState.currentView === 'view-display-more') {
        showGateway();
        return;
      }
      if (appState.currentView !== 'view-gateway') {
        showGateway();
        return;
      }
      if (appState.currentView === 'view-gateway') {
        return;
      }
      return;
    }

    // Ctrl+K: AI Omni-Search Command Palette
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openOmniSearchModal();
      return;
    }

    // Alt+A: AI Copilot Toggle
    if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      toggleAiCopilot();
      return;
    }

    // Alt+W: AI Executive Workspace Toggle
    if (e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      toggleAiWorkspaceView();
      return;
    }

    // Ctrl+N: Calculator
    if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      toggleCalculator();
      return;
    }

    // Alt+G: Universal Go To Search & Jump
    if (e.altKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      openGoToModal();
      return;
    }

    // Alt+D: Dashboard
    if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      toggleDashboard();
      return;
    }

    // Alt+C: Create Ledger
    if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      openModal('createLedgerModal');
      return;
    }

    // Alt+K: User Security & Passwords
    if (e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openUserManagement();
      return;
    }

    // Alt+T: Themes
    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      openThemeSelectorModal();
      return;
    }

    // Alt+Y: Data Menu
    if (e.altKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      openDataMenuModal();
      return;
    }

    // Alt+Z: Exchange Menu
    if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      openExchangeMenuModal();
      return;
    }

    // Ctrl+A: Accept Form in Voucher
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && appState.currentView === 'view-voucher') {
      e.preventDefault();
      document.getElementById('form-voucher')?.dispatchEvent(new Event('submit'));
      return;
    }

    // Alt+F2: Change Period
    if (e.altKey && (e.key === 'F2')) {
      e.preventDefault();
      openChangeDateModal();
      return;
    }

    // Alt+F5: Debit Note
    if (e.altKey && (e.key === 'F5')) {
      e.preventDefault();
      openVoucherScreen('Debit Note');
      return;
    }

    // Alt+F6: Credit Note
    if (e.altKey && (e.key === 'F6')) {
      e.preventDefault();
      openVoucherScreen('Credit Note');
      return;
    }

    // Alt+F7: Stock Journal
    if (e.altKey && (e.key === 'F7')) {
      e.preventDefault();
      openStockJournalModal();
      return;
    }

    // Function keys (F1 to F12)
    if (e.key === 'F1') { e.preventDefault(); openHelpModal(); return; }
    if (e.key === 'F2') { e.preventDefault(); openChangeDateModal(); return; }
    if (e.key === 'F3') { e.preventDefault(); openAlterCompany(); return; }
    if (e.key === 'F4') { e.preventDefault(); openVoucherScreen('Contra'); return; }
    if (e.key === 'F5') { e.preventDefault(); openVoucherScreen('Payment'); return; }
    if (e.key === 'F6') { e.preventDefault(); openVoucherScreen('Receipt'); return; }
    if (e.key === 'F7') { e.preventDefault(); openVoucherScreen('Journal'); return; }
    if (e.key === 'F8') { e.preventDefault(); openVoucherScreen('Sales'); return; }
    if (e.key === 'F9') { e.preventDefault(); openVoucherScreen('Purchase'); return; }
    if (e.key === 'F10') { e.preventDefault(); openOtherVouchersModal(); return; }
    if (e.key === 'F11') { e.preventDefault(); openF11FeaturesModal(); return; }
    if (e.key === 'F12') { e.preventDefault(); openF12ConfigModal(); return; }

    // Gateway Single-Key Shortcuts (when on Gateway screen and not typing)
    if (!isInput && appState.currentView === 'view-gateway') {
      const k = e.key.toUpperCase();
      if (k === 'W') { e.preventDefault(); toggleAiWorkspaceView(); return; }
      if (k === 'O') { e.preventDefault(); toggleAiCopilot(); return; }
      if (k === 'I') { e.preventDefault(); openAiDocParserModal(); return; }
      if (k === 'C') { e.preventDefault(); openMasterCreateModal(); return; }
      if (k === 'A') { e.preventDefault(); openMasterAlterModal(); return; }
      if (k === 'H') { e.preventDefault(); openReport('chart-accounts'); return; }
      if (k === 'V') { e.preventDefault(); openVoucherScreen('Sales'); return; }
      if (k === 'K') { e.preventDefault(); openReport('daybook'); return; }
      if (k === 'N') { e.preventDefault(); openBankingUtilitiesModal(); return; }
      if (k === 'B') { e.preventDefault(); openReport('balance-sheet'); return; }
      if (k === 'P') { e.preventDefault(); openReport('profit-loss'); return; }
      if (k === 'S') { e.preventDefault(); openReport('stock-summary'); return; }
      if (k === 'R') { e.preventDefault(); openReport('ratio-analysis'); return; }
      if (k === 'D') { e.preventDefault(); showDisplayMoreMenu(); return; }
      if (k === 'Q') { e.preventDefault(); showGateway(); return; }
    }

    // Display More Reports Single-Key Shortcuts
    if (!isInput && appState.currentView === 'view-display-more') {
      const k = e.key.toUpperCase();
      if (k === 'T') { e.preventDefault(); openReport('trial-balance'); return; }
      if (k === 'D') { e.preventDefault(); openReport('daybook'); return; }
      if (k === 'C') { e.preventDefault(); openReport('bank-recon'); return; }
      if (k === 'A') { e.preventDefault(); openReport('chart-accounts'); return; }
      if (k === 'S') { e.preventDefault(); openReport('outstandings'); return; }
      if (k === 'I') { e.preventDefault(); openReport('stock-summary'); return; }
      if (k === 'O') { e.preventDefault(); openReport('gst'); return; }
      if (k === 'R') { e.preventDefault(); openReport('ratio-analysis'); return; }
      if (k === 'B') { e.preventDefault(); openReport('bank-recon'); return; }
      if (k === 'Q') { e.preventDefault(); showGateway(); return; }
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
  if (appState.currentView === 'view-login' || !appState.currentUser) {
    selectQuickUser('admin');
    const uInput = document.getElementById('login-username');
    if (uInput) uInput.focus();
    return;
  }
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
    const res = await fetchApi('/auth/users');
    const data = await res.json();
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-rose-500">${data.error || 'Failed to load users'}</td></tr>`;
      return;
    }

    cachedUsers = data.data || [];
    try { localStorage.setItem('tally_cached_users', JSON.stringify(cachedUsers)); } catch (e) {}
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

      let providerBadge = '';
      if (u.auth_provider === 'google') {
        providerBadge = '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-black bg-rose-50 text-rose-600 border border-rose-200">Google</span>';
      } else if (u.auth_provider === 'email') {
        providerBadge = '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-black bg-blue-50 text-blue-600 border border-blue-200">Email</span>';
      }

      return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="p-2.5 font-bold text-slate-900">${u.username} ${providerBadge}</td>
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
window.startWithFreshLogin = startWithFreshLogin;
window.toggleFreshLoginStartup = toggleFreshLoginStartup;
window.handleLogin = handleLogin;
window.loginAsGuest = loginAsGuest;
window.handleLogout = handleLogout;
window.openRegisterModal = openRegisterModal;
window.openGoogleLoginModal = openGoogleLoginModal;
window.fillGoogleProfile = fillGoogleProfile;
window.handleRegister = handleRegister;
window.handleGoogleAuthSubmit = handleGoogleAuthSubmit;
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
window.openThemeSelectorModal = openThemeSelectorModal;
window.applyTheme = applyTheme;
window.cycleNextTheme = cycleNextTheme;
window.showGateway = showGateway;
window.toggleDashboard = toggleDashboard;
window.openModal = openModal;
window.closeModal = closeModal;
window.toggleAiCopilot = toggleAiCopilot;
window.clearAiChat = clearAiChat;
window.sendCopilotQuick = sendCopilotQuick;
window.handleCopilotSubmit = handleCopilotSubmit;
window.saveAiDraftFromChat = saveAiDraftFromChat;
window.toggleAiWorkspaceView = toggleAiWorkspaceView;
window.loadAiWorkspaceData = loadAiWorkspaceData;
window.refreshAiInsights = refreshAiInsights;
window.handleResolveAnomaly = handleResolveAnomaly;
window.fillAndSubmitAiPrompt = fillAndSubmitAiPrompt;
window.handleAiWorkspaceSubmit = handleAiWorkspaceSubmit;
window.openOmniSearchModal = openOmniSearchModal;
window.handleOmniSearchInput = handleOmniSearchInput;
window.executeOmniAction = executeOmniAction;
window.openAiDocParserModal = openAiDocParserModal;
window.handleAiDocParse = handleAiDocParse;
window.toggleAiVoice = toggleAiVoice;
window.speakAiText = speakAiText;
window.isFinancialQuestion = isFinancialQuestion;

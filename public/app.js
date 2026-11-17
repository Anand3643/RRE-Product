// Ramraj Enterprises — ERP Core Frontend Controller

const API_BASE = '/api';

// State Store
let state = {
  activeTab: 'dashboard',
  products: [],
  customers: [],
  quotations: [],
  invoices: [],
  workOrders: [],
  amcContracts: [],
  employees: [],
  quoteLineItems: []
};

// Formatting Helpers
const formatINR = (val) => {
  const num = parseFloat(val) || 0;
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
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
  initIcons();
  switchTab('dashboard');
  loadGlobalDropdowns();

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  const dateInputs = ['quote-date', 'wo-start', 'amc-start', 'emp-join'];
  dateInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });
});

function initIcons() {
  if (window.lucide) {
    lucide.createIcons();
  }
}

// Tab Switching
function switchTab(tabName) {
  state.activeTab = tabName;

  // Update nav buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('border-blue-600', 'text-blue-600', 'font-semibold');
    btn.classList.add('border-transparent', 'text-slate-600');
  });

  const activeBtn = document.getElementById(`tab-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.add('border-blue-600', 'text-blue-600', 'font-semibold');
    activeBtn.classList.remove('border-transparent', 'text-slate-600');
  }

  // Update view contents
  document.querySelectorAll('.tab-content').forEach(view => {
    view.classList.add('hidden');
  });

  const activeView = document.getElementById(`view-${tabName}`);
  if (activeView) {
    activeView.classList.remove('hidden');
  }

  // Load data for the active tab
  if (tabName === 'dashboard') loadDashboard();
  else if (tabName === 'manufacturing') loadManufacturing();
  else if (tabName === 'inventory') loadInventory();
  else if (tabName === 'sales') loadSales();
  else if (tabName === 'amc') loadAMC();
  else if (tabName === 'finance') loadFinance();
  else if (tabName === 'hr') loadHR();
  else if (tabName === 'zoho') loadZoho();

  setTimeout(initIcons, 50);
}

// Modal Handlers
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    initIcons();
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

// --- 1. DASHBOARD ---
async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/stats`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    document.getElementById('dash-revenue').innerText = formatINR(d.finance.revenue);
    document.getElementById('dash-collected').innerText = formatINR(d.finance.collected);
    document.getElementById('dash-stock-value').innerText = formatINR(d.inventory.valuation);
    document.getElementById('dash-low-stock').innerText = d.inventory.low_stock_count;
    document.getElementById('dash-active-wo').innerText = d.manufacturing.active_orders;
    document.getElementById('dash-amc-count').innerText = d.sales.active_amcs;
    document.getElementById('dash-amc-value').innerText = (d.sales.amc_revenue || 0).toLocaleString('en-IN');

    // Recent Invoices Table
    const invTbody = document.getElementById('dash-recent-invoices');
    if (invTbody) {
      if (d.recent.invoices.length === 0) {
        invTbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">No invoices generated yet</td></tr>`;
      } else {
        invTbody.innerHTML = d.recent.invoices.map(i => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-semibold text-blue-600">${i.invoice_no}</td>
            <td class="p-3 font-medium text-slate-900">${i.customer_company}</td>
            <td class="p-3 text-slate-500">${formatDate(i.invoice_date)}</td>
            <td class="p-3 font-bold">${formatINR(i.total)}</td>
            <td class="p-3"><span class="badge ${i.status === 'Paid' ? 'badge-success' : 'badge-warning'}">${i.status}</span></td>
          </tr>
        `).join('');
      }
    }

    // Recent Work Orders Table
    const woTbody = document.getElementById('dash-recent-wo');
    if (woTbody) {
      if (d.recent.work_orders.length === 0) {
        woTbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">No work orders scheduled</td></tr>`;
      } else {
        woTbody.innerHTML = d.recent.work_orders.map(w => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-semibold text-indigo-600">${w.order_no}</td>
            <td class="p-3 font-medium text-slate-900">${w.product_name}</td>
            <td class="p-3 text-slate-600 font-semibold">${w.quantity} units</td>
            <td class="p-3 text-slate-500">${formatDate(w.due_date)}</td>
            <td class="p-3"><span class="badge badge-info">${w.status}</span></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

// --- 2. MANUFACTURING & BOM ---
async function loadManufacturing() {
  try {
    const [woRes, prodRes] = await Promise.all([
      fetch(`${API_BASE}/manufacturing/work-orders`),
      fetch(`${API_BASE}/products?is_assembly=1`)
    ]);

    const woData = await woRes.json();
    const prodData = await prodRes.json();

    const tbody = document.getElementById('work-orders-tbody');
    if (tbody && woData.success) {
      state.workOrders = woData.data;
      if (woData.data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400">No work orders recorded. Click "+ Create Work Order" to begin.</td></tr>`;
      } else {
        tbody.innerHTML = woData.data.map(w => {
          let statusBadge = 'badge-neutral';
          if (w.status === 'Completed') statusBadge = 'badge-success';
          else if (w.status === 'In Production') statusBadge = 'badge-info';
          else if (w.status === 'Quality Check') statusBadge = 'badge-warning';

          return `
            <tr class="hover:bg-slate-50 transition">
              <td class="p-3 font-bold text-indigo-600">${w.order_no}</td>
              <td class="p-3 font-semibold text-slate-900">${w.product_name}</td>
              <td class="p-3 font-bold">${w.quantity} Units</td>
              <td class="p-3 text-slate-500">${formatDate(w.start_date)}</td>
              <td class="p-3 text-slate-500">${formatDate(w.due_date)}</td>
              <td class="p-3"><span class="badge ${statusBadge}">${w.status}</span></td>
              <td class="p-3 text-right">
                <select onchange="updateWorkOrderStatus(${w.id}, this.value)" class="text-[11px] border border-slate-300 rounded px-2 py-1 bg-white">
                  <option value="Draft" ${w.status === 'Draft' ? 'selected' : ''}>Draft</option>
                  <option value="In Production" ${w.status === 'In Production' ? 'selected' : ''}>In Production</option>
                  <option value="Quality Check" ${w.status === 'Quality Check' ? 'selected' : ''}>Quality Check</option>
                  <option value="Completed" ${w.status === 'Completed' ? 'selected' : ''}>Completed (Auto Stock)</option>
                  <option value="Cancelled" ${w.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                </select>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Load BOM Details for Assemblies
    const bomContainer = document.getElementById('bom-models-container');
    if (bomContainer && prodData.success) {
      bomContainer.innerHTML = '';
      for (const p of prodData.data) {
        const detailRes = await fetch(`${API_BASE}/products/${p.id}`);
        const detailJson = await detailRes.json();
        const bom = detailJson.data.bom || [];

        const bomRows = bom.map(b => `
          <tr class="text-[11px] border-b border-slate-100">
            <td class="py-1.5 px-3 font-medium text-slate-800">${b.name} (${b.sku})</td>
            <td class="py-1.5 px-3 font-semibold text-slate-900">${b.quantity} ${b.unit}</td>
            <td class="py-1.5 px-3 text-slate-500">${formatINR(b.cost_price)}</td>
            <td class="py-1.5 px-3 font-medium ${b.current_stock < b.quantity ? 'text-red-600' : 'text-emerald-600'}">${b.current_stock} in stock</td>
          </tr>
        `).join('');

        bomContainer.innerHTML += `
          <div class="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
            <div class="flex justify-between items-center mb-2">
              <div class="flex items-center space-x-2">
                <span class="font-bold text-slate-900 text-xs">${p.name}</span>
                <span class="bg-blue-100 text-blue-800 text-[10px] px-2 py-0.5 rounded font-mono">${p.sku}</span>
              </div>
              <span class="text-xs text-slate-500">Finished Stock: <strong class="text-slate-900">${p.current_stock} SET</strong></span>
            </div>
            <p class="text-[11px] text-slate-500 mb-2">${p.description || 'Standard Assembly'}</p>
            <div class="bg-white rounded border border-slate-200 overflow-hidden">
              <table class="w-full text-left">
                <thead class="bg-slate-100 text-slate-600 text-[10px] uppercase font-semibold">
                  <tr>
                    <th class="py-1.5 px-3">BOM Component</th>
                    <th class="py-1.5 px-3">Qty per Unit</th>
                    <th class="py-1.5 px-3">Unit Cost</th>
                    <th class="py-1.5 px-3">Available Stock</th>
                  </tr>
                </thead>
                <tbody>${bomRows}</tbody>
              </table>
            </div>
          </div>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to load manufacturing:', err);
  }
}

async function updateWorkOrderStatus(woId, newStatus) {
  try {
    const res = await fetch(`${API_BASE}/manufacturing/work-orders/${woId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const json = await res.json();
    if (!json.success) {
      alert(json.error || 'Failed to update work order');
    } else {
      loadManufacturing();
    }
  } catch (err) {
    alert('Error updating work order: ' + err.message);
  }
}

// --- 3. INVENTORY & STOCK ---
async function loadInventory() {
  try {
    const [invRes, txRes] = await Promise.all([
      fetch(`${API_BASE}/inventory`),
      fetch(`${API_BASE}/inventory/transactions`)
    ]);

    const invData = await invRes.json();
    const txData = await txRes.json();

    if (invData.success) {
      state.products = invData.data.items;
      renderInventoryTable(state.products);
    }

    if (txData.success) {
      const txTbody = document.getElementById('inventory-tx-tbody');
      if (txTbody) {
        txTbody.innerHTML = txData.data.map(t => {
          let typeColor = 'text-blue-600';
          if (t.type === 'IN' || t.type === 'PROD_YIELD') typeColor = 'text-emerald-600 font-bold';
          else if (t.type === 'OUT' || t.type === 'PROD_CONSUME') typeColor = 'text-red-600 font-bold';

          return `
            <tr class="hover:bg-slate-50 transition">
              <td class="p-2.5 text-slate-500">${formatDate(t.created_at)}</td>
              <td class="p-2.5 ${typeColor}">${t.type}</td>
              <td class="p-2.5 font-medium text-slate-900">${t.product_name}</td>
              <td class="p-2.5 font-bold">${t.quantity} ${t.unit}</td>
              <td class="p-2.5 text-slate-600 font-mono text-[11px]">${t.reference_no || '-'}</td>
              <td class="p-2.5 text-slate-500">${t.notes || '-'}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load inventory:', err);
  }
}

function renderInventoryTable(items) {
  const tbody = document.getElementById('inventory-tbody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="p-6 text-center text-slate-400">No items found matching filter</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(p => {
    const isLow = p.current_stock <= p.min_stock;
    return `
      <tr class="hover:bg-slate-50 transition ${isLow ? 'bg-amber-50/30' : ''}">
        <td class="p-3 font-mono font-bold text-blue-600">${p.sku}</td>
        <td class="p-3 font-medium text-slate-900">
          <div>${p.name}</div>
          <div class="text-[10px] text-slate-400">${p.description ? p.description.substring(0, 45) + '...' : ''}</div>
        </td>
        <td class="p-3 text-slate-600"><span class="badge badge-neutral">${p.category}</span></td>
        <td class="p-3 text-slate-500">${p.unit}</td>
        <td class="p-3 font-mono text-slate-600">${p.hsn_code || '-'}</td>
        <td class="p-3 text-right font-medium">${formatINR(p.cost_price)}</td>
        <td class="p-3 text-right font-bold text-slate-900">${formatINR(p.unit_price)}</td>
        <td class="p-3 text-center text-slate-500 font-medium">${p.min_stock}</td>
        <td class="p-3 text-center font-bold text-sm ${isLow ? 'text-amber-600' : 'text-slate-800'}">${p.current_stock}</td>
        <td class="p-3 text-center">
          <span class="badge ${isLow ? 'badge-danger' : 'badge-success'}">${isLow ? 'Low Stock' : 'Optimal'}</span>
        </td>
        <td class="p-3 text-right">
          <button onclick="quickStockIn(${p.id})" class="text-xs text-blue-600 hover:text-blue-800 font-semibold">+ Stock</button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterInventoryTable() {
  const query = (document.getElementById('inventory-search')?.value || '').toLowerCase();
  const cat = document.getElementById('inventory-filter-cat')?.value || '';

  const filtered = state.products.filter(p => {
    const matchesSearch = p.sku.toLowerCase().includes(query) || p.name.toLowerCase().includes(query) || (p.description || '').toLowerCase().includes(query);
    const matchesCat = !cat || p.category === cat;
    return matchesSearch && matchesCat;
  });

  renderInventoryTable(filtered);
}

function quickStockIn(productId) {
  const select = document.getElementById('stock-product');
  if (select) select.value = productId;
  document.getElementById('stock-type').value = 'IN';
  openModal('stockModal');
}

function openStockOutModal() {
  document.getElementById('stock-type').value = 'OUT';
  openModal('stockModal');
}

// --- 4. SALES, QUOTATIONS & CRM ---
async function loadSales() {
  try {
    const [quotesRes, ordersRes, custRes] = await Promise.all([
      fetch(`${API_BASE}/sales/quotations`),
      fetch(`${API_BASE}/sales/orders`),
      fetch(`${API_BASE}/sales/customers`)
    ]);

    const quotesData = await quotesRes.json();
    const ordersData = await ordersRes.json();
    const custData = await custRes.json();

    // Render Quotes
    const qTbody = document.getElementById('quotations-tbody');
    if (qTbody && quotesData.success) {
      state.quotations = quotesData.data;
      if (quotesData.data.length === 0) {
        qTbody.innerHTML = `<tr><td colspan="9" class="p-6 text-center text-slate-400">No quotations generated yet</td></tr>`;
      } else {
        qTbody.innerHTML = quotesData.data.map(q => {
          let badge = 'badge-neutral';
          if (q.status === 'Accepted') badge = 'badge-success';
          else if (q.status === 'Sent') badge = 'badge-info';

          return `
            <tr class="hover:bg-slate-50 transition">
              <td class="p-3 font-bold text-blue-600">${q.quote_no}</td>
              <td class="p-3 font-semibold text-slate-900">${q.customer_company}</td>
              <td class="p-3 text-slate-500">${formatDate(q.quote_date)}</td>
              <td class="p-3 text-slate-500">${formatDate(q.valid_until)}</td>
              <td class="p-3 text-right font-medium">${formatINR(q.subtotal)}</td>
              <td class="p-3 text-right text-slate-500">${formatINR(q.tax_amount)}</td>
              <td class="p-3 text-right font-bold text-slate-900">${formatINR(q.total)}</td>
              <td class="p-3 text-center"><span class="badge ${badge}">${q.status}</span></td>
              <td class="p-3 text-right space-x-2">
                <button onclick="viewPrintQuotation(${q.id})" class="text-xs text-blue-600 font-semibold hover:underline">View / Print</button>
                ${q.status !== 'Accepted' ? `<button onclick="convertToSalesOrder(${q.id})" class="text-xs text-emerald-600 font-semibold hover:underline">Convert to Order</button>` : ''}
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Render Sales Orders
    const soTbody = document.getElementById('sales-orders-tbody');
    if (soTbody && ordersData.success) {
      if (ordersData.data.length === 0) {
        soTbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400">No confirmed sales orders</td></tr>`;
      } else {
        soTbody.innerHTML = ordersData.data.map(o => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-bold text-emerald-600">${o.order_no}</td>
            <td class="p-3 font-semibold text-slate-900">${o.customer_company}</td>
            <td class="p-3 text-slate-500">${formatDate(o.order_date)}</td>
            <td class="p-3 text-right font-bold">${formatINR(o.total)}</td>
            <td class="p-3 text-center"><span class="badge badge-success">${o.status}</span></td>
            <td class="p-3 text-right">
              <button onclick="createInvoiceFromOrder(${o.id}, ${o.customer_id}, ${o.total})" class="text-xs text-blue-600 font-semibold hover:underline">+ Invoice</button>
            </td>
          </tr>
        `).join('');
      }
    }

    // Render Customers
    const custTbody = document.getElementById('customers-tbody');
    if (custTbody && custData.success) {
      state.customers = custData.data;
      custTbody.innerHTML = custData.data.map(c => `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2.5 font-bold text-slate-900">${c.company}</td>
          <td class="p-2.5 font-medium">${c.name || '-'}</td>
          <td class="p-2.5 font-mono text-slate-600">${c.gstin || '-'}</td>
          <td class="p-2.5 text-slate-600">${c.phone || '-'}</td>
          <td class="p-2.5 text-slate-500">${c.email || '-'}</td>
          <td class="p-2.5 text-slate-600">${c.city || 'Chennai'}, ${c.state || 'TN'}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load sales:', err);
  }
}

async function convertToSalesOrder(quoteId) {
  if (!confirm('Convert this quotation into a confirmed Sales Order?')) return;
  try {
    const res = await fetch(`${API_BASE}/sales/quotations/${quoteId}/convert-to-order`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(`Success! Created ${json.order_no}`);
      loadSales();
    } else {
      alert(json.error || 'Conversion failed');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// --- 5. AMC SERVICES ---
async function loadAMC() {
  try {
    const res = await fetch(`${API_BASE}/amc`);
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('amc-tbody');
    if (tbody) {
      state.amcContracts = json.data.items;
      if (state.amcContracts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="p-6 text-center text-slate-400">No AMC contracts found</td></tr>`;
      } else {
        tbody.innerHTML = state.amcContracts.map(a => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-bold text-blue-600">${a.contract_no}</td>
            <td class="p-3 font-semibold text-slate-900">${a.customer_company}</td>
            <td class="p-3 font-medium">${a.machine_model}</td>
            <td class="p-3 font-mono text-slate-600">${a.serial_no || '-'}</td>
            <td class="p-3 text-slate-600">${a.visit_frequency}</td>
            <td class="p-3 text-slate-500">${formatDate(a.end_date)}</td>
            <td class="p-3 font-semibold text-indigo-600">${formatDate(a.next_service_date)}</td>
            <td class="p-3 text-right font-bold">${formatINR(a.total_amount)}</td>
            <td class="p-3 text-center"><span class="badge badge-success">${a.status}</span></td>
            <td class="p-3 text-right">
              <button onclick="scheduleAMCService(${a.id})" class="text-xs text-blue-600 font-semibold hover:underline">Schedule Visit</button>
            </td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load AMC:', err);
  }
}

async function scheduleAMCService(amcId) {
  const newDate = prompt('Enter next service visit date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
  if (!newDate) return;

  try {
    const res = await fetch(`${API_BASE}/amc/${amcId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_service_date: newDate })
    });
    const json = await res.json();
    if (json.success) {
      loadAMC();
    } else {
      alert(json.error || 'Failed to update schedule');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// --- 6. FINANCE & INVOICES ---
async function loadFinance() {
  try {
    const [invRes, expRes] = await Promise.all([
      fetch(`${API_BASE}/finance/invoices`),
      fetch(`${API_BASE}/finance/expenses`)
    ]);

    const invData = await invRes.json();
    const expData = await expRes.json();

    // Render Invoices
    const tbody = document.getElementById('invoices-tbody');
    if (tbody && invData.success) {
      state.invoices = invData.data;
      if (state.invoices.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="p-6 text-center text-slate-400">No invoices logged yet</td></tr>`;
      } else {
        tbody.innerHTML = state.invoices.map(i => {
          let badge = 'badge-warning';
          if (i.status === 'Paid') badge = 'badge-success';
          else if (i.status === 'Partially Paid') badge = 'badge-info';

          return `
            <tr class="hover:bg-slate-50 transition">
              <td class="p-3 font-bold text-blue-600">${i.invoice_no}</td>
              <td class="p-3 font-semibold text-slate-900">${i.customer_company}</td>
              <td class="p-3 text-slate-500">${formatDate(i.invoice_date)}</td>
              <td class="p-3 text-slate-500">${formatDate(i.due_date)}</td>
              <td class="p-3 text-right font-medium">${formatINR(i.subtotal)}</td>
              <td class="p-3 text-right text-slate-500">${formatINR((i.cgst + i.sgst + i.igst))}</td>
              <td class="p-3 text-right font-bold text-slate-900">${formatINR(i.total)}</td>
              <td class="p-3 text-right font-semibold text-emerald-600">${formatINR(i.paid_amount)}</td>
              <td class="p-3 text-center"><span class="badge ${badge}">${i.status}</span></td>
              <td class="p-3 text-right space-x-2">
                <button onclick="viewPrintInvoice(${i.id})" class="text-xs text-blue-600 font-semibold hover:underline">View</button>
                ${i.status !== 'Paid' ? `<button onclick="recordInvoicePayment(${i.id}, ${i.total - (i.paid_amount || 0)})" class="text-xs text-emerald-600 font-semibold hover:underline">Pay</button>` : ''}
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Render Expenses
    const expTbody = document.getElementById('expenses-tbody');
    if (expTbody && expData.success) {
      document.getElementById('expense-total').innerText = (expData.data.total || 0).toLocaleString('en-IN');
      expTbody.innerHTML = expData.data.items.map(e => `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2.5 text-slate-500">${formatDate(e.date)}</td>
          <td class="p-2.5"><span class="badge badge-neutral">${e.category}</span></td>
          <td class="p-2.5 font-medium text-slate-900">${e.paid_to || '-'}</td>
          <td class="p-2.5 text-slate-600">${e.description || '-'}</td>
          <td class="p-2.5 text-slate-500">${e.payment_mode}</td>
          <td class="p-2.5 text-right font-bold text-slate-900">${formatINR(e.amount)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load finance:', err);
  }
}

async function recordInvoicePayment(invoiceId, balanceDue) {
  const amtStr = prompt(`Enter payment amount received (Balance Due: ${formatINR(balanceDue)}):`, balanceDue);
  if (!amtStr) return;
  const amt = parseFloat(amtStr);
  if (isNaN(amt) || amt <= 0) return alert('Invalid amount');

  try {
    const res = await fetch(`${API_BASE}/finance/invoices/${invoiceId}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amt })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadFinance();
    } else {
      alert(json.error || 'Payment record failed');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// --- 7. HR & ATTENDANCE ---
async function loadHR() {
  try {
    const [empRes, attRes, payRes] = await Promise.all([
      fetch(`${API_BASE}/hr/employees`),
      fetch(`${API_BASE}/hr/attendance`),
      fetch(`${API_BASE}/hr/payroll`)
    ]);

    const empData = await empRes.json();
    const attData = await attRes.json();
    const payData = await payRes.json();

    // Attendance Table
    const attTbody = document.getElementById('attendance-tbody');
    if (attTbody && attData.success) {
      document.getElementById('attendance-date-label').innerText = formatDate(attData.date);
      attTbody.innerHTML = attData.data.map(a => {
        let badge = 'badge-neutral';
        if (a.status === 'Present') badge = 'badge-success';
        else if (a.status === 'Absent') badge = 'badge-danger';
        else if (a.status === 'Half Day') badge = 'badge-warning';

        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-mono font-bold text-slate-700">${a.emp_code}</td>
            <td class="p-3 font-semibold text-slate-900">${a.name}</td>
            <td class="p-3 text-slate-600">${a.department}</td>
            <td class="p-3 text-slate-500">${a.designation}</td>
            <td class="p-3 font-mono text-slate-600">${a.check_in || '-'}</td>
            <td class="p-3 font-mono text-slate-600">${a.check_out || '-'}</td>
            <td class="p-3 text-center"><span class="badge ${badge}">${a.status}</span></td>
            <td class="p-3 text-right space-x-1">
              <button onclick="markAttendanceQuick(${a.employee_id}, 'Present')" class="px-2 py-0.5 bg-emerald-100 text-emerald-800 text-[10px] font-bold rounded hover:bg-emerald-200">Present</button>
              <button onclick="markAttendanceQuick(${a.employee_id}, 'Absent')" class="px-2 py-0.5 bg-red-100 text-red-800 text-[10px] font-bold rounded hover:bg-red-200">Absent</button>
              <button onclick="markAttendanceQuick(${a.employee_id}, 'Half Day')" class="px-2 py-0.5 bg-amber-100 text-amber-800 text-[10px] font-bold rounded hover:bg-amber-200">Half Day</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Payroll Table
    const payTbody = document.getElementById('payroll-tbody');
    if (payTbody && payData.success) {
      if (payData.data.length === 0) {
        payTbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400">No payroll generated for this month. Click "Process Monthly Payroll" above.</td></tr>`;
      } else {
        payTbody.innerHTML = payData.data.map(p => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-mono font-bold text-slate-700">${p.emp_code}</td>
            <td class="p-3 font-semibold text-slate-900">${p.employee_name}</td>
            <td class="p-3 text-slate-600">${p.department}</td>
            <td class="p-3 text-right font-medium">${formatINR(p.basic)}</td>
            <td class="p-3 text-right text-emerald-600 font-medium">+${formatINR(p.allowances)}</td>
            <td class="p-3 text-right text-red-600 font-medium">-${formatINR(p.deductions)}</td>
            <td class="p-3 text-right font-bold text-slate-900">${formatINR(p.net_salary)}</td>
            <td class="p-3 text-center"><span class="badge badge-success">${p.status}</span></td>
          </tr>
        `).join('');
      }
    }

    // Employees Directory
    const empTbody = document.getElementById('employees-tbody');
    if (empTbody && empData.success) {
      state.employees = empData.data;
      empTbody.innerHTML = empData.data.map(e => `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2.5 font-mono font-bold text-blue-600">${e.emp_code}</td>
          <td class="p-2.5 font-semibold text-slate-900">${e.name}</td>
          <td class="p-2.5 text-slate-600">${e.department}</td>
          <td class="p-2.5 text-slate-500">${e.designation}</td>
          <td class="p-2.5 text-slate-600">${e.phone || '-'}</td>
          <td class="p-2.5 text-slate-500">${e.email || '-'}</td>
          <td class="p-2.5 text-right font-bold">${formatINR(e.basic_salary)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load HR:', err);
  }
}

async function markAttendanceQuick(empId, status) {
  try {
    const res = await fetch(`${API_BASE}/hr/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: empId, status })
    });
    const json = await res.json();
    if (json.success) {
      loadHR();
    }
  } catch (err) {
    alert('Error marking attendance: ' + err.message);
  }
}

async function runMonthlyPayroll() {
  if (!confirm('Calculate and generate monthly payroll for all active staff members?')) return;
  try {
    const res = await fetch(`${API_BASE}/hr/payroll/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadHR();
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// --- GLOBAL DROPDOWNS & FORM HANDLERS ---
async function loadGlobalDropdowns() {
  try {
    const [custRes, prodRes] = await Promise.all([
      fetch(`${API_BASE}/sales/customers`),
      fetch(`${API_BASE}/products`)
    ]);

    const custJson = await custRes.json();
    const prodJson = await prodRes.json();

    if (custJson.success) {
      state.customers = custJson.data;
      const custOptions = custJson.data.map(c => `<option value="${c.id}">${c.company} (${c.name || 'Sales'})</option>`).join('');
      const qCust = document.getElementById('quote-customer');
      if (qCust) qCust.innerHTML = custOptions;
      const aCust = document.getElementById('amc-customer');
      if (aCust) aCust.innerHTML = custOptions;
    }

    if (prodJson.success) {
      state.products = prodJson.data;
      // All products for stock adjustment
      const pOptions = prodJson.data.map(p => `<option value="${p.id}">${p.name} (${p.sku}) — Stock: ${p.current_stock}</option>`).join('');
      const sProd = document.getElementById('stock-product');
      if (sProd) sProd.innerHTML = pOptions;

      // Assemblies for work order
      const assemblies = prodJson.data.filter(p => p.is_assembly === 1);
      const asmOptions = assemblies.map(a => `<option value="${a.id}">${a.name} (${a.sku})</option>`).join('');
      const woProd = document.getElementById('wo-product');
      if (woProd) woProd.innerHTML = asmOptions;
    }
  } catch (err) {
    console.error('Failed to populate dropdowns:', err);
  }
}

// Quotation Multi-Line Item Builder
function addQuoteLineItem(productId = null, desc = '', price = 0, qty = 1, hsn = '84148011') {
  const container = document.getElementById('quote-items-container');
  if (!container) return;

  const rowId = 'q-item-' + Date.now() + Math.random().toString(36).substr(2, 4);

  const productOptions = state.products.map(p => `
    <option value="${p.id}" ${productId === p.id ? 'selected' : ''} data-price="${p.unit_price}" data-hsn="${p.hsn_code || ''}" data-name="${p.name}">
      ${p.name} (${p.sku})
    </option>
  `).join('');

  const rowHtml = `
    <div id="${rowId}" class="flex items-center space-x-2 bg-slate-50 p-2 rounded-lg border border-slate-200 text-xs">
      <select onchange="onQuoteItemProductChange('${rowId}', this)" class="w-1/3 border border-slate-300 rounded p-1.5 bg-white">
        <option value="">-- Custom Item / Description --</option>
        ${productOptions}
      </select>
      <input type="text" placeholder="Item description" value="${desc}" class="q-desc flex-1 border border-slate-300 rounded p-1.5">
      <input type="text" placeholder="HSN" value="${hsn}" class="q-hsn w-20 border border-slate-300 rounded p-1.5 font-mono">
      <input type="number" placeholder="Qty" value="${qty}" min="1" step="any" oninput="calculateQuoteTotal()" class="q-qty w-16 border border-slate-300 rounded p-1.5">
      <input type="number" placeholder="Unit Price" value="${price}" step="any" oninput="calculateQuoteTotal()" class="q-price w-24 border border-slate-300 rounded p-1.5">
      <input type="number" placeholder="Disc %" value="0" min="0" max="100" oninput="calculateQuoteTotal()" class="q-disc w-16 border border-slate-300 rounded p-1.5">
      <button type="button" onclick="document.getElementById('${rowId}').remove(); calculateQuoteTotal();" class="text-red-500 hover:text-red-700 p-1">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', rowHtml);
  initIcons();
  calculateQuoteTotal();
}

function onQuoteItemProductChange(rowId, selectEl) {
  const row = document.getElementById(rowId);
  if (!row) return;

  const opt = selectEl.options[selectEl.selectedIndex];
  if (opt.value) {
    row.querySelector('.q-desc').value = opt.getAttribute('data-name') || '';
    row.querySelector('.q-price').value = opt.getAttribute('data-price') || 0;
    row.querySelector('.q-hsn').value = opt.getAttribute('data-hsn') || '';
  }
  calculateQuoteTotal();
}

function calculateQuoteTotal() {
  const rows = document.querySelectorAll('#quote-items-container > div');
  let subtotal = 0;

  rows.forEach(r => {
    const qty = parseFloat(r.querySelector('.q-qty')?.value) || 0;
    const price = parseFloat(r.querySelector('.q-price')?.value) || 0;
    const disc = parseFloat(r.querySelector('.q-disc')?.value) || 0;
    const lineTotal = (qty * price) * (1 - disc / 100);
    subtotal += lineTotal;
  });

  const tax = subtotal * 0.18;
  const grandTotal = subtotal + tax;

  document.getElementById('quote-preview-subtotal').innerText = formatINR(subtotal);
  document.getElementById('quote-preview-tax').innerText = formatINR(tax);
  document.getElementById('quote-preview-total').innerText = formatINR(grandTotal);
}

// Add first row if empty when opening modal
const originalOpenModal = openModal;
openModal = function(modalId) {
  originalOpenModal(modalId);
  if (modalId === 'quoteModal') {
    const container = document.getElementById('quote-items-container');
    if (container && container.children.length === 0) {
      addQuoteLineItem();
    }
  }
};

// Form Submissions
async function handleCreateQuote(e) {
  e.preventDefault();
  const customerId = document.getElementById('quote-customer').value;
  const quoteDate = document.getElementById('quote-date').value;
  const validUntil = document.getElementById('quote-validity').value;
  const notes = document.getElementById('quote-notes').value;

  const rows = document.querySelectorAll('#quote-items-container > div');
  const items = [];
  rows.forEach(r => {
    const sel = r.querySelector('select');
    const desc = r.querySelector('.q-desc').value;
    const hsn = r.querySelector('.q-hsn').value;
    const qty = parseFloat(r.querySelector('.q-qty').value) || 1;
    const price = parseFloat(r.querySelector('.q-price').value) || 0;
    const disc = parseFloat(r.querySelector('.q-disc').value) || 0;

    if (desc || sel.value) {
      items.push({
        product_id: sel.value ? parseInt(sel.value, 10) : null,
        description: desc || 'Product Item',
        hsn,
        quantity: qty,
        unit_price: price,
        discount: disc
      });
    }
  });

  if (items.length === 0) return alert('Please add at least one line item to the quotation');

  try {
    const res = await fetch(`${API_BASE}/sales/quotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId,
        quote_date: quoteDate,
        valid_until: validUntil,
        tax_rate: 18,
        items,
        notes
      })
    });
    const json = await res.json();
    if (json.success) {
      closeModal('quoteModal');
      document.getElementById('form-quote').reset();
      document.getElementById('quote-items-container').innerHTML = '';
      loadSales();
      viewPrintQuotation(json.id);
    } else {
      alert(json.error || 'Failed to create quotation');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleStockAdjust(e) {
  e.preventDefault();
  const productId = document.getElementById('stock-product').value;
  const type = document.getElementById('stock-type').value;
  const qty = document.getElementById('stock-qty').value;
  const ref = document.getElementById('stock-ref').value;
  const notes = document.getElementById('stock-notes').value;

  try {
    const res = await fetch(`${API_BASE}/inventory/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, type, quantity: qty, reference_no: ref, notes })
    });
    const json = await res.json();
    if (json.success) {
      closeModal('stockModal');
      document.getElementById('form-stock').reset();
      loadInventory();
      loadDashboard();
    } else {
      alert(json.error || 'Failed to update stock');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleCreateWorkOrder(e) {
  e.preventDefault();
  const productId = document.getElementById('wo-product').value;
  const qty = document.getElementById('wo-qty').value;
  const start = document.getElementById('wo-start').value;
  const due = document.getElementById('wo-due').value;
  const notes = document.getElementById('wo-notes').value;

  try {
    const res = await fetch(`${API_BASE}/manufacturing/work-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, quantity: qty, start_date: start, due_date: due, notes })
    });
    const json = await res.json();
    if (json.success) {
      closeModal('workOrderModal');
      document.getElementById('form-workorder').reset();
      loadManufacturing();
      loadDashboard();
    } else {
      alert(json.error || 'Failed to create work order');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleCreateCustomer(e) {
  e.preventDefault();
  const body = {
    company: document.getElementById('cust-company').value,
    name: document.getElementById('cust-name').value,
    gstin: document.getElementById('cust-gstin').value,
    phone: document.getElementById('cust-phone').value,
    email: document.getElementById('cust-email').value,
    address: document.getElementById('cust-addr').value,
    city: document.getElementById('cust-city').value,
    state: document.getElementById('cust-state').value
  };

  try {
    const res = await fetch(`${API_BASE}/sales/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      closeModal('customerModal');
      document.getElementById('form-customer').reset();
      loadGlobalDropdowns();
      loadSales();
    } else {
      alert(json.error || 'Failed to save customer');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleCreateProduct(e) {
  e.preventDefault();
  const body = {
    sku: document.getElementById('prod-sku').value,
    category: document.getElementById('prod-cat').value,
    name: document.getElementById('prod-name').value,
    unit: document.getElementById('prod-unit').value,
    hsn_code: document.getElementById('prod-hsn').value,
    is_assembly: document.getElementById('prod-assembly').value === '1',
    cost_price: document.getElementById('prod-cost').value,
    unit_price: document.getElementById('prod-price').value,
    current_stock: document.getElementById('prod-stock').value,
    min_stock: document.getElementById('prod-min').value,
    description: document.getElementById('prod-desc').value
  };

  try {
    const res = await fetch(`${API_BASE}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      closeModal('productModal');
      document.getElementById('form-product').reset();
      loadGlobalDropdowns();
      loadInventory();
    } else {
      alert(json.error || 'Failed to save product');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleCreateAMC(e) {
  e.preventDefault();
  const body = {
    customer_id: document.getElementById('amc-customer').value,
    machine_model: document.getElementById('amc-model').value,
    serial_no: document.getElementById('amc-serial').value,
    start_date: document.getElementById('amc-start').value,
    end_date: document.getElementById('amc-end').value,
    visit_frequency: document.getElementById('amc-freq').value,
    total_amount: document.getElementById('amc-val').value,
    next_service_date: document.getElementById('amc-next-date').value
  };

  try {
    const res = await fetch(`${API_BASE}/amc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      closeModal('amcModal');
      document.getElementById('form-amc').reset();
      loadAMC();
      loadDashboard();
    } else {
      alert(json.error || 'Failed to create AMC');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleCreateEmployee(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('emp-name').value,
    department: document.getElementById('emp-dept').value,
    designation: document.getElementById('emp-desig').value,
    phone: document.getElementById('emp-phone').value,
    email: document.getElementById('emp-email').value,
    basic_salary: document.getElementById('emp-salary').value,
    joining_date: document.getElementById('emp-join').value
  };

  try {
    const res = await fetch(`${API_BASE}/hr/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      closeModal('employeeModal');
      document.getElementById('form-employee').reset();
      loadHR();
    } else {
      alert(json.error || 'Failed to save employee');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Print / View Quotation
async function viewPrintQuotation(quoteId) {
  try {
    const res = await fetch(`${API_BASE}/sales/quotations/${quoteId}`);
    const json = await res.json();
    if (!json.success) return alert('Quote not found');
    const q = json.data;

    const itemsHtml = (q.items || []).map((it, idx) => `
      <tr class="border-b border-slate-200 text-xs">
        <td class="py-2.5 px-3 text-center text-slate-500">${idx + 1}</td>
        <td class="py-2.5 px-3 font-semibold text-slate-900">${it.description}</td>
        <td class="py-2.5 px-3 font-mono text-center text-slate-600">${it.hsn || '84148011'}</td>
        <td class="py-2.5 px-3 text-center font-bold">${it.quantity}</td>
        <td class="py-2.5 px-3 text-right">${formatINR(it.unit_price)}</td>
        <td class="py-2.5 px-3 text-right font-bold text-slate-900">${formatINR(it.total)}</td>
      </tr>
    `).join('');

    const content = `
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex justify-between items-start border-b border-slate-300 pb-5">
          <div>
            <div class="flex items-center space-x-2">
              <div class="w-10 h-10 rounded bg-blue-600 text-white font-bold text-lg flex items-center justify-center">RRE</div>
              <h1 class="text-xl font-bold text-slate-900">RAMRAJ ENTERPRISES</h1>
            </div>
            <p class="text-xs text-slate-600 mt-1">Specialist in Rotary Screw Compressors, Spares & Servicing</p>
            <p class="text-xs text-slate-500">GSTIN: 33ANUPS7331M1Z8 | PAN: ANUPS7331M</p>
            <p class="text-xs text-slate-500">Chennai, Tamil Nadu • Phone: +91 98401 76592</p>
          </div>
          <div class="text-right">
            <span class="inline-block bg-blue-100 text-blue-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">Commercial Quotation</span>
            <h2 class="text-lg font-bold text-slate-900 mt-2">${q.quote_no}</h2>
            <p class="text-xs text-slate-500">Date: <strong>${formatDate(q.quote_date)}</strong></p>
            <p class="text-xs text-slate-500">Valid Until: <strong>${formatDate(q.valid_until)}</strong></p>
          </div>
        </div>

        <!-- Customer Info -->
        <div class="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p class="text-[10px] font-bold text-slate-400 uppercase">Quotation Prepared For:</p>
          <h3 class="text-sm font-bold text-slate-900">${q.customer_company}</h3>
          <p class="text-xs text-slate-600">${q.customer_name ? 'Attn: ' + q.customer_name : ''}</p>
          <p class="text-xs text-slate-600">${q.address || ''}, ${q.city || 'Chennai'}, ${q.state || 'Tamil Nadu'}</p>
          <p class="text-xs text-slate-600">GSTIN: <span class="font-mono font-semibold">${q.gstin || 'N/A'}</span></p>
          <p class="text-xs text-slate-600">Phone: ${q.phone || '-'}</p>
        </div>

        <!-- Items Table -->
        <table class="w-full border border-slate-200 rounded-lg overflow-hidden">
          <thead class="bg-slate-100 text-slate-700 text-xs font-bold">
            <tr>
              <th class="py-2 px-3 text-center">#</th>
              <th class="py-2 px-3 text-left">Description of Goods / Scope</th>
              <th class="py-2 px-3 text-center">HSN/SAC</th>
              <th class="py-2 px-3 text-center">Qty</th>
              <th class="py-2 px-3 text-right">Unit Rate</th>
              <th class="py-2 px-3 text-right">Total Amount</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>

        <!-- Totals & Terms -->
        <div class="grid grid-cols-2 gap-6 items-start">
          <div class="text-xs text-slate-600 space-y-1">
            <h4 class="font-bold text-slate-800">Commercial Terms & Conditions:</h4>
            <p>1. Prices are ex-works Chennai.</p>
            <p>2. Warranty: 12 months from commissioning against manufacturing defects.</p>
            <p>3. Delivery: Within 1-2 weeks upon receipt of confirmed purchase order.</p>
            <p class="mt-2 text-slate-500 italic">${q.notes || ''}</p>
          </div>
          <div class="space-y-1.5 text-xs text-right bg-slate-50 p-4 rounded-lg border border-slate-200">
            <div class="flex justify-between"><span class="text-slate-500">Taxable Subtotal:</span><span class="font-bold">${formatINR(q.subtotal)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">CGST (9%):</span><span class="font-bold">${formatINR(q.tax_amount / 2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">SGST (9%):</span><span class="font-bold">${formatINR(q.tax_amount / 2)}</span></div>
            <div class="flex justify-between border-t border-slate-300 pt-2 text-base font-bold text-slate-900">
              <span>Grand Total:</span>
              <span class="text-blue-600">${formatINR(q.total)}</span>
            </div>
          </div>
        </div>

        <!-- Footer Sign-off -->
        <div class="pt-8 border-t border-slate-200 flex justify-between items-end text-xs text-slate-600">
          <div>
            <p>Thank you for choosing Ramraj Enterprises!</p>
            <p class="text-[10px] text-slate-400">Computer generated estimate, signature not mandatory.</p>
          </div>
          <div class="text-right">
            <p class="font-bold text-slate-900">For RAMRAJ ENTERPRISES</p>
            <div class="h-12"></div>
            <p class="font-semibold text-slate-700">Authorized Signatory</p>
          </div>
        </div>
      </div>
    `;

    document.getElementById('print-content').innerHTML = content;
    document.getElementById('print-doc-title').innerText = `Quotation — ${q.quote_no}`;
    openModal('printModal');
  } catch (err) {
    alert('Error loading quotation: ' + err.message);
  }
}

// Print / View Tax Invoice
async function viewPrintInvoice(invId) {
  try {
    const res = await fetch(`${API_BASE}/finance/invoices/${invId}`);
    const json = await res.json();
    if (!json.success) return alert('Invoice not found');
    const inv = json.data;

    const itemsHtml = (inv.items || []).map((it, idx) => `
      <tr class="border-b border-slate-200 text-xs">
        <td class="py-2.5 px-3 text-center text-slate-500">${idx + 1}</td>
        <td class="py-2.5 px-3 font-semibold text-slate-900">${it.description}</td>
        <td class="py-2.5 px-3 font-mono text-center text-slate-600">${it.hsn || '84148011'}</td>
        <td class="py-2.5 px-3 text-center font-bold">${it.quantity}</td>
        <td class="py-2.5 px-3 text-right">${formatINR(it.unit_price)}</td>
        <td class="py-2.5 px-3 text-right font-bold text-slate-900">${formatINR(it.total)}</td>
      </tr>
    `).join('');

    const content = `
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex justify-between items-start border-b border-slate-300 pb-5">
          <div>
            <div class="flex items-center space-x-2">
              <div class="w-10 h-10 rounded bg-blue-600 text-white font-bold text-lg flex items-center justify-center">RRE</div>
              <h1 class="text-xl font-bold text-slate-900">RAMRAJ ENTERPRISES</h1>
            </div>
            <p class="text-xs text-slate-600 mt-1">Industrial Air Compressors • Spares • Turnkey Solutions</p>
            <p class="text-xs text-slate-500">GSTIN: 33ANUPS7331M1Z8 | PAN: ANUPS7331M</p>
            <p class="text-xs text-slate-500">Chennai, Tamil Nadu • Phone: +91 98401 76592</p>
          </div>
          <div class="text-right">
            <span class="inline-block bg-emerald-100 text-emerald-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">TAX INVOICE</span>
            <h2 class="text-lg font-bold text-slate-900 mt-2">${inv.invoice_no}</h2>
            <p class="text-xs text-slate-500">Invoice Date: <strong>${formatDate(inv.invoice_date)}</strong></p>
            <p class="text-xs text-slate-500">Due Date: <strong>${formatDate(inv.due_date)}</strong></p>
          </div>
        </div>

        <!-- Billed To -->
        <div class="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p class="text-[10px] font-bold text-slate-400 uppercase">Billed To (Customer):</p>
          <h3 class="text-sm font-bold text-slate-900">${inv.customer_company}</h3>
          <p class="text-xs text-slate-600">${inv.customer_name ? 'Attn: ' + inv.customer_name : ''}</p>
          <p class="text-xs text-slate-600">${inv.address || ''}, ${inv.city || 'Chennai'}, ${inv.state || 'Tamil Nadu'}</p>
          <p class="text-xs text-slate-600">GSTIN: <span class="font-mono font-semibold">${inv.gstin || 'Unregistered'}</span></p>
        </div>

        <!-- Items Table -->
        <table class="w-full border border-slate-200 rounded-lg overflow-hidden">
          <thead class="bg-slate-100 text-slate-700 text-xs font-bold">
            <tr>
              <th class="py-2 px-3 text-center">#</th>
              <th class="py-2 px-3 text-left">Item Description</th>
              <th class="py-2 px-3 text-center">HSN/SAC</th>
              <th class="py-2 px-3 text-center">Qty</th>
              <th class="py-2 px-3 text-right">Rate</th>
              <th class="py-2 px-3 text-right">Taxable Amount</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>

        <!-- Totals & Bank Details -->
        <div class="grid grid-cols-2 gap-6 items-start">
          <div class="text-xs text-slate-600 bg-slate-50 p-4 rounded-lg border border-slate-200 space-y-1">
            <h4 class="font-bold text-slate-800">Bank & Remittance Details:</h4>
            <p>Bank: <strong>HDFC Bank Ltd</strong></p>
            <p>Account Name: <strong>Ramraj Enterprises</strong></p>
            <p>Account No: <strong>50200012345678</strong></p>
            <p>IFSC Code: <strong>HDFC0001234</strong></p>
            <p>Branch: <strong>Chennai Main</strong></p>
          </div>
          <div class="space-y-1.5 text-xs text-right bg-slate-50 p-4 rounded-lg border border-slate-200">
            <div class="flex justify-between"><span class="text-slate-500">Taxable Value:</span><span class="font-bold">${formatINR(inv.subtotal)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">CGST (9%):</span><span class="font-bold">${formatINR(inv.cgst)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">SGST (9%):</span><span class="font-bold">${formatINR(inv.sgst)}</span></div>
            ${inv.igst > 0 ? `<div class="flex justify-between"><span class="text-slate-500">IGST (18%):</span><span class="font-bold">${formatINR(inv.igst)}</span></div>` : ''}
            <div class="flex justify-between border-t border-slate-300 pt-2 text-base font-bold text-slate-900">
              <span>Invoice Total:</span>
              <span class="text-emerald-600">${formatINR(inv.total)}</span>
            </div>
            <div class="flex justify-between text-xs font-semibold text-slate-500 pt-1">
              <span>Amount Paid:</span>
              <span>${formatINR(inv.paid_amount)}</span>
            </div>
            <div class="flex justify-between text-xs font-bold text-slate-800">
              <span>Balance Due:</span>
              <span>${formatINR(inv.total - (inv.paid_amount || 0))}</span>
            </div>
          </div>
        </div>

        <!-- Footer Sign-off -->
        <div class="pt-8 border-t border-slate-200 flex justify-between items-end text-xs text-slate-600">
          <div>
            <p class="font-semibold text-slate-800">Declaration:</p>
            <p class="text-[10px] text-slate-500">We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</p>
          </div>
          <div class="text-right">
            <p class="font-bold text-slate-900">For RAMRAJ ENTERPRISES</p>
            <div class="h-12"></div>
            <p class="font-semibold text-slate-700">Authorized Signatory</p>
          </div>
        </div>
      </div>
    `;

    document.getElementById('print-content').innerHTML = content;
    document.getElementById('print-doc-title').innerText = `Tax Invoice — ${inv.invoice_no}`;
    openModal('printModal');
  } catch (err) {
    alert('Error loading invoice: ' + err.message);
  }
}


// --- 8. ZOHO BOOKS INTEGRATION (Reconstructed via REA) ---
async function loadZoho() {
  await Promise.all([
    checkZohoStatus(),
    loadZohoTransactions(),
    loadZohoLogs()
  ]);
}

async function checkZohoStatus() {
  try {
    const res = await fetch(`${API_BASE}/zoho/status`);
    const json = await res.json();
    const badge = document.getElementById('zoho-status-badge');
    const orgName = document.getElementById('zoho-org-name');
    const orgId = document.getElementById('zoho-org-id');
    const dc = document.getElementById('zoho-dc');

    if (json.success && json.data.connected) {
      if (badge) {
        badge.className = 'badge badge-success';
        badge.innerText = 'Connected';
      }
      if (orgName) orgName.innerText = json.data.org_name || 'Ramraj Enterprises';
      if (orgId) orgId.innerText = json.data.org_id || '639436206';
      if (dc) dc.innerText = json.data.dc || 'com';
    } else {
      if (badge) {
        badge.className = 'badge badge-danger';
        badge.innerText = 'Disconnected';
      }
      if (orgName) orgName.innerText = 'Status: ' + (json.data?.error || json.error || 'Check .env configuration');
    }
  } catch (err) {
    console.error('Zoho status error:', err);
  }
}

async function loadZohoTransactions() {
  try {
    const [qRes, iRes] = await Promise.all([
      fetch(`${API_BASE}/sales/quotations`),
      fetch(`${API_BASE}/finance/invoices`)
    ]);
    const qData = await qRes.json();
    const iData = await iRes.json();

    const qTbody = document.getElementById('zoho-quotes-tbody');
    if (qTbody && qData.success) {
      qTbody.innerHTML = qData.data.map(q => `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2.5 font-bold text-blue-600">${q.quote_no}</td>
          <td class="p-2.5 font-medium text-slate-900">${q.customer_company}</td>
          <td class="p-2.5 text-right font-bold">${formatINR(q.total)}</td>
          <td class="p-2.5 text-center">
            ${q.zoho_estimate_id ? `<span class="badge badge-success">Synced (#${q.zoho_estimate_id})</span>` : `<span class="badge badge-neutral">Not Synced</span>`}
          </td>
          <td class="p-2.5 text-right">
            <button onclick="syncQuoteToZoho(${q.id})" class="px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold rounded text-[11px]">
              ${q.zoho_estimate_id ? 'Re-Sync' : 'Push to Zoho'}
            </button>
          </td>
        </tr>
      `).join('');
    }

    const iTbody = document.getElementById('zoho-invoices-tbody');
    if (iTbody && iData.success) {
      iTbody.innerHTML = iData.data.map(i => `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-2.5 font-bold text-blue-600">${i.invoice_no}</td>
          <td class="p-2.5 font-medium text-slate-900">${i.customer_company}</td>
          <td class="p-2.5 text-right font-bold">${formatINR(i.total)}</td>
          <td class="p-2.5 text-center">
            ${i.zoho_invoice_id ? `<span class="badge badge-success">Synced (#${i.zoho_invoice_id})</span>` : `<span class="badge badge-neutral">Not Synced</span>`}
          </td>
          <td class="p-2.5 text-right">
            <button onclick="syncInvoiceToZoho(${i.id})" class="px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold rounded text-[11px]">
              ${i.zoho_invoice_id ? 'Re-Sync' : 'Push to Zoho'}
            </button>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load Zoho transactions:', err);
  }
}

async function loadZohoLogs() {
  try {
    const res = await fetch(`${API_BASE}/zoho/logs`);
    const json = await res.json();
    const tbody = document.getElementById('zoho-logs-tbody');
    if (tbody && json.success) {
      if (json.data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">No sync actions performed yet</td></tr>`;
      } else {
        tbody.innerHTML = json.data.map(l => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-2.5 text-slate-500">${formatDate(l.created_at)}</td>
            <td class="p-2.5 font-semibold text-slate-800">${l.entity_type} #${l.entity_id}</td>
            <td class="p-2.5 font-mono text-indigo-600">${l.zoho_id || '-'}</td>
            <td class="p-2.5 text-center"><span class="badge ${l.status === 'Success' ? 'badge-success' : 'badge-danger'}">${l.status}</span></td>
            <td class="p-2.5 text-slate-600">${l.message || '-'}</td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load Zoho logs:', err);
  }
}

async function syncQuoteToZoho(quoteId) {
  try {
    const res = await fetch(`${API_BASE}/zoho/sync-quote/${quoteId}`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadZoho();
    } else {
      alert(json.error || 'Sync failed');
    }
  } catch (err) {
    alert('Error syncing quote: ' + err.message);
  }
}

async function syncInvoiceToZoho(invId) {
  try {
    const res = await fetch(`${API_BASE}/zoho/sync-invoice/${invId}`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      loadZoho();
    } else {
      alert(json.error || 'Sync failed');
    }
  } catch (err) {
    alert('Error syncing invoice: ' + err.message);
  }
}

async function syncAllCustomersToZoho() {
  if (!confirm('Push all customer records to Zoho Books as Contacts?')) return;
  try {
    const res = await fetch(`${API_BASE}/zoho/sync-all-customers`, { method: 'POST' });
    const json = await res.json();
    alert(json.message || 'Sync completed');
    loadZoho();
  } catch (err) {
    alert('Error syncing customers: ' + err.message);
  }
}

async function syncAllProductsToZoho() {
  if (!confirm('Push all product & spare items to Zoho Books as Items?')) return;
  try {
    const res = await fetch(`${API_BASE}/zoho/sync-all-products`, { method: 'POST' });
    const json = await res.json();
    alert(json.message || 'Sync completed');
    loadZoho();
  } catch (err) {
    alert('Error syncing products: ' + err.message);
  }
}

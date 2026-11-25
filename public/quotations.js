// ========================================================
// RRE TALLY — QUOTATIONS, FOLLOW-UPS, DOCUMENTS & REPORT CENTER
// Loaded after app.js; reuses appState, API_BASE, fetchApi, showView,
// checkPermission, formatCurrency, formatDateDisplay, openModal/closeModal.
// ========================================================

const GST_STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh']
];

const QUOTE_STATUS_BADGE = {
  Draft: 'bg-slate-200 text-slate-700',
  Sent: 'bg-blue-100 text-blue-800',
  Accepted: 'bg-emerald-100 text-emerald-800',
  Declined: 'bg-rose-100 text-rose-800',
  Expired: 'bg-amber-100 text-amber-800',
  Revised: 'bg-violet-100 text-violet-800',
  Invoiced: 'bg-teal-100 text-teal-800'
};

const quoteState = { current: null, loadTimer: null, reports: [], activeReport: null, lastReport: null };

// ---------- helpers ----------
function qEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function qToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function qAddDays(dateStr, n) {
  const d = new Date((dateStr || qToday()) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function qRound2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
function companyStateCode() { return String((appState.company && appState.company.state_code) || '33'); }
function currentUserName() { return (appState.currentUser && (appState.currentUser.full_name || appState.currentUser.username)) || ''; }

// a save that is already on its way is not sent again (double click): the same request gets the same answer
const qInFlight = new Map();
function qApi(path, method = 'GET', body) {
  if (method === 'GET') return qApiNow(path, method, body);
  const key = method + ' ' + path + ' ' + JSON.stringify(body || null);
  if (qInFlight.has(key)) return qInFlight.get(key);
  const p = qApiNow(path, method, body).finally(() => qInFlight.delete(key));
  qInFlight.set(key, p); return p;
}
async function qApiNow(path, method = 'GET', body) {
  const res = await fetchApi(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!res.ok || json.success === false) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

/** Opens a document/print view. "Download PDF" inside it saves a real PDF in the desktop app. */
function openDocumentWindow(path) {
  const base = API_BASE.replace(/\/api$/, '');
  window.open(`${base}${path}`, '_blank', 'width=1000,height=900');
}
function downloadQuotePdf(id) { openDocumentWindow(`/api/documents/quotation/${id}/pdf`); }
function viewQuoteDocument(id) { openDocumentWindow(`/api/documents/quotation/${id}`); }
function viewInvoiceDocument(voucherId) { openDocumentWindow(`/api/documents/invoice/${voucherId}`); }
function downloadInvoicePdf(voucherId) { openDocumentWindow(`/api/documents/invoice/${voucherId}/pdf`); }
// Day Book rows call this; show the Zoho-style printable voucher
function viewVoucherDetail(voucherId) { viewInvoiceDocument(voucherId); }

// ========================================================
// QUOTATION LIST
// ========================================================
function openQuotations() {
  showView('view-quotations');
  loadQuotations();
}

function setQuoteFollowupFilter(val) {
  const sel = document.getElementById('qt-followup-filter');
  if (sel) sel.value = val;
  const st = document.getElementById('qt-status-filter');
  if (st) st.value = '';
  loadQuotations();
}

function debouncedLoadQuotations() {
  clearTimeout(quoteState.loadTimer);
  quoteState.loadTimer = setTimeout(loadQuotations, 250);
}

async function loadQuotationStats() {
  try {
    const { data } = await qApi('/quotations/stats');
    document.getElementById('qt-kpi-open').textContent = formatCurrency(data.open_value);
    document.getElementById('qt-kpi-open-count').textContent = `${data.open_count} open quote${data.open_count === 1 ? '' : 's'}`;
    document.getElementById('qt-kpi-won').textContent = formatCurrency(data.won_value);
    document.getElementById('qt-kpi-conv').textContent = `${data.conversion_rate}%`;
    document.getElementById('qt-kpi-overdue').textContent = data.followups.overdue;
    document.getElementById('qt-kpi-today').textContent = data.followups.today;
    document.getElementById('qt-kpi-upcoming').textContent = data.followups.upcoming;
    updateFollowupBadge(data.followups.overdue + data.followups.today);
  } catch (e) {
    console.warn('Quotation stats unavailable:', e.message);
  }
}

function updateFollowupBadge(count) {
  const b = document.getElementById('gw-followup-badge');
  if (!b) return;
  b.textContent = count > 0 ? `${count} due` : 'Follow-ups';
  b.className = count > 0 ? 'text-[10px] font-mono font-bold text-rose-600' : 'text-[10px] text-slate-400 font-mono';
}

async function loadQuotations() {
  loadQuotationStats();
  const params = new URLSearchParams();
  const search = document.getElementById('qt-search')?.value.trim();
  const status = document.getElementById('qt-status-filter')?.value;
  const followup = document.getElementById('qt-followup-filter')?.value;
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (followup) params.set('followup', followup);

  const tbody = document.getElementById('qt-tbody');
  try {
    const { data } = await qApi(`/quotations?${params}`);
    const t = qToday();
    tbody.innerHTML = data.length ? data.map((q) => {
      let fu = '<span class="text-slate-400">—</span>';
      if (q.next_followup_date && ['Draft', 'Sent', 'Accepted'].includes(q.status)) {
        const cls = q.next_followup_date < t ? 'text-rose-700 font-bold' : q.next_followup_date === t ? 'text-amber-700 font-bold' : 'text-slate-700';
        const tag = q.next_followup_date < t ? ' (overdue)' : q.next_followup_date === t ? ' (today)' : '';
        fu = `<span class="${cls}">${formatDateDisplay(q.next_followup_date)}${tag}</span>`;
      }
      const expired = q.expiry_date && q.expiry_date < t && ['Draft', 'Sent'].includes(q.status);
      return `
      <tr class="hover:bg-slate-50 cursor-pointer" onclick="openQuoteDetail(${q.id})">
        <td class="p-2.5 font-mono text-slate-600">${formatDateDisplay(q.date)}</td>
        <td class="p-2.5 font-mono font-bold text-blue-700">${qEsc(q.quote_no)}</td>
        <td class="p-2.5"><div class="font-semibold text-slate-800">${qEsc(q.customer_name)}</div>
          <div class="text-[10px] text-slate-500 truncate max-w-xs">${qEsc(q.subject || '')}${q.followup_count ? ` · ${q.followup_count} follow-up${q.followup_count > 1 ? 's' : ''}` : ''}${q.converted_voucher_no ? ` · Inv ${qEsc(q.converted_voucher_no)}` : ''}</div></td>
        <td class="p-2.5 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${QUOTE_STATUS_BADGE[q.status] || ''}">${qEsc(q.status)}</span></td>
        <td class="p-2.5 font-mono ${expired ? 'text-rose-600' : 'text-slate-600'}">${formatDateDisplay(q.expiry_date)}</td>
        <td class="p-2.5 font-mono">${fu}</td>
        <td class="p-2.5 text-right font-mono font-bold text-slate-900">${formatCurrency(q.total)}</td>
        <td class="p-2.5 text-center" onclick="event.stopPropagation()">
          <button onclick="downloadQuotePdf(${q.id})" title="Download PDF" class="p-1 rounded hover:bg-rose-50 text-rose-600"><i data-lucide="file-down" class="w-4 h-4"></i></button>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="p-6 text-center text-slate-400">No quotations found. Press <strong>Alt+N</strong> to create one.</td></tr>`;
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-rose-600">${qEsc(err.message)}</td></tr>`;
  }
}

// ========================================================
// QUOTATION EDITOR
// ========================================================
function populateQuotePartyDropdown() {
  const sel = document.getElementById('qe-party');
  const customers = (appState.ledgers || []).filter((l) => l.group_name === 'Sundry Debtors');
  sel.innerHTML = '<option value="">— New prospect (no ledger yet) —</option>' +
    customers.map((l) => `<option value="${l.id}">${qEsc(l.name)}</option>`).join('');
  const pos = document.getElementById('qe-pos');
  pos.innerHTML = GST_STATES.map(([c, n]) => `<option value="${c}">${qEsc(n)} (${c})</option>`).join('');
}

function handleQuotePartyChange() {
  const id = parseInt(document.getElementById('qe-party').value, 10);
  const l = (appState.ledgers || []).find((x) => x.id === id);
  if (l) {
    document.getElementById('qe-customer-name').value = l.name;
    document.getElementById('qe-gstin').value = l.gstin || '';
    document.getElementById('qe-address').value = l.address || '';
    if (l.state_code) document.getElementById('qe-pos').value = String(l.state_code).padStart(2, '0');
  }
  recalcQuoteTotals();
}

function handleQuoteDateChange() {
  const d = document.getElementById('qe-date').value;
  if (!d) return;
  document.getElementById('qe-expiry').value = qAddDays(d, 15);
  document.getElementById('qe-followup').value = qAddDays(d, 3);
}

function addQuoteItemRow(item = {}) {
  const tbody = document.getElementById('qe-items');
  const tr = document.createElement('tr');
  const opts = (appState.stockItems || []).map((s) =>
    `<option value="${s.id}" ${item.stock_item_id === s.id ? 'selected' : ''}>${qEsc(s.name)}</option>`).join('');
  tr.innerHTML = `
    <td class="p-1.5">
      <select class="qi-stock w-full border border-slate-300 rounded p-1 bg-white mb-1" onchange="handleQuoteItemSelect(this)">
        <option value="">— Free text / service —</option>${opts}
      </select>
      <input class="qi-name w-full border border-slate-300 rounded p-1 font-semibold" placeholder="Item name" value="${qEsc(item.item_name || '')}">
      <input class="qi-desc w-full border border-slate-200 rounded p-1 mt-1 text-slate-600" placeholder="Description (optional)" value="${qEsc(item.description || '')}">
      <input type="hidden" class="qi-uom" value="${qEsc(item.uom || '')}">
    </td>
    <td class="p-1.5 align-top"><input class="qi-hsn w-full border border-slate-300 rounded p-1 font-mono" value="${qEsc(item.hsn_code || '')}"></td>
    <td class="p-1.5 align-top"><input type="number" step="0.01" min="0" class="qi-qty w-full border border-slate-300 rounded p-1 text-right font-mono" value="${item.quantity ?? 1}" oninput="recalcQuoteTotals()"></td>
    <td class="p-1.5 align-top"><input type="number" step="0.01" min="0" class="qi-rate w-full border border-slate-300 rounded p-1 text-right font-mono" value="${item.rate ?? 0}" oninput="recalcQuoteTotals()"></td>
    <td class="p-1.5 align-top"><input type="number" step="0.01" min="0" max="100" class="qi-disc w-full border border-slate-300 rounded p-1 text-right font-mono" value="${item.discount_pct ?? 0}" oninput="recalcQuoteTotals()"></td>
    <td class="p-1.5 align-top"><select class="qi-gst w-full border border-slate-300 rounded p-1 text-right font-mono bg-white" onchange="recalcQuoteTotals()">
      ${[0, 0.25, 3, 5, 12, 18, 28].map((r) => `<option value="${r}" ${Number(item.gst_rate ?? 18) === r ? 'selected' : ''}>${r}%</option>`).join('')}
    </select></td>
    <td class="p-1.5 align-top text-right font-mono font-bold qi-amount pt-2.5">₹0.00</td>
    <td class="p-1.5 align-top text-center"><button type="button" onclick="this.closest('tr').remove(); recalcQuoteTotals();" class="text-rose-500 hover:text-rose-700 font-bold pt-1">✕</button></td>`;
  tbody.appendChild(tr);
  recalcQuoteTotals();
}

function handleQuoteItemSelect(sel) {
  const tr = sel.closest('tr');
  const s = (appState.stockItems || []).find((x) => x.id === parseInt(sel.value, 10));
  if (!s) return;
  tr.querySelector('.qi-name').value = s.name;
  tr.querySelector('.qi-hsn').value = s.hsn_code || '';
  tr.querySelector('.qi-uom').value = s.uom_symbol || '';
  tr.querySelector('.qi-rate').value = s.standard_price || s.opening_rate || 0;
  const g = tr.querySelector('.qi-gst');
  if (s.gst_rate !== undefined && s.gst_rate !== null) {
    if (![...g.options].some((o) => Number(o.value) === Number(s.gst_rate))) g.add(new Option(`${s.gst_rate}%`, s.gst_rate));
    g.value = String(s.gst_rate);
  }
  recalcQuoteTotals();
}

function collectQuoteItems() {
  return [...document.querySelectorAll('#qe-items tr')].map((tr, idx) => ({
    stock_item_id: parseInt(tr.querySelector('.qi-stock').value, 10) || null,
    item_name: tr.querySelector('.qi-name').value.trim(),
    description: tr.querySelector('.qi-desc').value.trim(),
    hsn_code: tr.querySelector('.qi-hsn').value.trim(),
    uom: tr.querySelector('.qi-uom').value,
    quantity: parseFloat(tr.querySelector('.qi-qty').value) || 0,
    rate: parseFloat(tr.querySelector('.qi-rate').value) || 0,
    discount_pct: parseFloat(tr.querySelector('.qi-disc').value) || 0,
    gst_rate: parseFloat(tr.querySelector('.qi-gst').value) || 0,
    sort_order: idx
  }));
}

// Live preview — mirrors the server's computeTotals (server stays authoritative)
function recalcQuoteTotals() {
  const rows = [...document.querySelectorAll('#qe-items tr')];
  const overall = Math.min(100, Math.max(0, parseFloat(document.getElementById('qe-discount').value) || 0));
  const shipping = qRound2(document.getElementById('qe-shipping').value);
  const inter = document.getElementById('qe-pos').value !== companyStateCode();
  let subtotal = 0, taxable = 0, tax = 0;
  rows.forEach((tr) => {
    const qty = parseFloat(tr.querySelector('.qi-qty').value) || 0;
    const rate = parseFloat(tr.querySelector('.qi-rate').value) || 0;
    const disc = Math.min(100, Math.max(0, parseFloat(tr.querySelector('.qi-disc').value) || 0));
    const gst = parseFloat(tr.querySelector('.qi-gst').value) || 0;
    const amt = qRound2(qty * rate * (1 - disc / 100));
    tr.querySelector('.qi-amount').textContent = formatCurrency(amt);
    const lt = amt * (1 - overall / 100);
    subtotal += amt; taxable += lt; tax += lt * gst / 100;
  });
  subtotal = qRound2(subtotal); taxable = qRound2(taxable);
  const cgst = inter ? 0 : qRound2(tax / 2);
  const sgst = inter ? 0 : qRound2(tax / 2);
  const igst = inter ? qRound2(tax) : 0;
  const raw = taxable + cgst + sgst + igst + shipping;
  const total = Math.round(raw);
  document.getElementById('qe-subtotal').textContent = formatCurrency(subtotal);
  document.getElementById('qe-discount-amt').textContent = `-${formatCurrency(subtotal - taxable)}`;
  document.getElementById('qe-cgst').textContent = formatCurrency(cgst);
  document.getElementById('qe-sgst').textContent = formatCurrency(sgst);
  document.getElementById('qe-igst').textContent = formatCurrency(igst);
  document.getElementById('qe-cgst-row').classList.toggle('hidden', inter);
  document.getElementById('qe-sgst-row').classList.toggle('hidden', inter);
  document.getElementById('qe-igst-row').classList.toggle('hidden', !inter);
  document.getElementById('qe-roundoff').textContent = formatCurrency(total - raw);
  document.getElementById('qe-total').textContent = formatCurrency(total);
}

async function openQuotationEditor(id = null) {
  if (!checkPermission('canCreateVouchers', 'Quotation Entry')) return;
  closeModal('quoteDetailModal');
  showView('view-quotation-editor');
  populateQuotePartyDropdown();
  const form = document.getElementById('qe-form');
  form.reset();
  document.getElementById('qe-items').innerHTML = '';
  document.getElementById('qe-id').value = id || '';
  document.getElementById('qe-title').textContent = id ? 'Edit Quotation' : 'New Quotation';

  if (id) {
    try {
      const { data: q } = await qApi(`/quotations/${id}`);
      const set = (el, v) => { document.getElementById(el).value = v ?? ''; };
      set('qe-party', q.party_ledger_id || '');
      set('qe-customer-name', q.customer_name || q.party_name);
      set('qe-phone', q.customer_phone); set('qe-email', q.customer_email); set('qe-gstin', q.customer_gstin);
      set('qe-address', q.billing_address); set('qe-pos', String(q.place_of_supply_code || companyStateCode()).padStart(2, '0'));
      set('qe-no', q.quote_no); set('qe-date', q.date); set('qe-expiry', q.expiry_date); set('qe-followup', q.next_followup_date);
      set('qe-ref', q.reference_no); set('qe-salesperson', q.salesperson); set('qe-subject', q.subject);
      set('qe-notes', q.customer_notes); set('qe-terms', q.terms); set('qe-discount', q.discount_pct || 0); set('qe-shipping', q.shipping_charges || 0);
      document.getElementById('qe-no').readOnly = true;
      q.items.forEach((it) => addQuoteItemRow(it));
      document.getElementById('qe-title').textContent = `Edit Quotation ${q.quote_no}`;
    } catch (err) {
      alert(`Could not load quotation: ${err.message}`);
      openQuotations();
      return;
    }
  } else {
    document.getElementById('qe-no').readOnly = false;
    document.getElementById('qe-pos').value = companyStateCode().padStart(2, '0');
    document.getElementById('qe-date').value = qToday();
    document.getElementById('qe-salesperson').value = currentUserName();
    handleQuoteDateChange();
    try {
      const r = await qApi('/quotations/next-number');
      document.getElementById('qe-no').value = r.quote_no;
      document.getElementById('qe-terms').value = r.default_terms;
      document.getElementById('qe-notes').value = 'Looking forward to your business.';
    } catch (e) {}
    addQuoteItemRow();
  }
  recalcQuoteTotals();
  setTimeout(() => document.getElementById('qe-party').focus(), 50);
}

async function handleSaveQuotation(e, forcedStatus) {
  e.preventDefault();
  const status = forcedStatus || (e.submitter && e.submitter.dataset.status) || 'Draft';
  const id = document.getElementById('qe-id').value;
  const items = collectQuoteItems().filter((i) => i.item_name || i.stock_item_id);
  if (!items.length) { alert('Add at least one line item.'); return; }
  const posSel = document.getElementById('qe-pos');
  const payload = {
    party_ledger_id: parseInt(document.getElementById('qe-party').value, 10) || null,
    customer_name: document.getElementById('qe-customer-name').value.trim(),
    customer_phone: document.getElementById('qe-phone').value.trim(),
    customer_email: document.getElementById('qe-email').value.trim(),
    customer_gstin: document.getElementById('qe-gstin').value.trim().toUpperCase(),
    billing_address: document.getElementById('qe-address').value.trim(),
    place_of_supply_code: posSel.value,
    place_of_supply: (GST_STATES.find(([c]) => c === posSel.value) || [])[1] || '',
    quote_no: document.getElementById('qe-no').value.trim(),
    date: document.getElementById('qe-date').value,
    expiry_date: document.getElementById('qe-expiry').value,
    next_followup_date: document.getElementById('qe-followup').value || null,
    reference_no: document.getElementById('qe-ref').value.trim(),
    salesperson: document.getElementById('qe-salesperson').value.trim(),
    subject: document.getElementById('qe-subject').value.trim(),
    customer_notes: document.getElementById('qe-notes').value,
    terms: document.getElementById('qe-terms').value,
    discount_pct: parseFloat(document.getElementById('qe-discount').value) || 0,
    shipping_charges: parseFloat(document.getElementById('qe-shipping').value) || 0,
    status,
    created_by: currentUserName(),
    items
  };
  try {
    const r = id ? await qApi(`/quotations/${id}`, 'PUT', payload) : await qApi('/quotations', 'POST', payload);
    openQuotations();
    openQuoteDetail(r.id);
  } catch (err) {
    alert(`Could not save quotation: ${err.message}`);
  }
}

// ========================================================
// QUOTE DETAIL, ACTIONS & FOLLOW-UPS
// ========================================================
async function openQuoteDetail(id) {
  try {
    const { data } = await qApi(`/quotations/${id}`);
    renderQuoteDetail(data);
    openModal('quoteDetailModal');
  } catch (err) {
    alert(err.message);
  }
}

function renderQuoteDetail(q) {
  quoteState.current = q;
  document.getElementById('qd-title').textContent = `Quotation ${q.quote_no}${q.revision ? ` (Revision ${q.revision})` : ''}`;
  document.getElementById('qd-customer').textContent = q.display_customer;
  document.getElementById('qd-subject').textContent = q.subject || '';
  const st = document.getElementById('qd-status');
  st.textContent = q.status;
  st.className = `inline-block px-2 py-0.5 rounded text-[10px] font-bold ${QUOTE_STATUS_BADGE[q.status] || ''}`;
  document.getElementById('qd-total').textContent = formatCurrency(q.total);
  document.getElementById('qd-dates').innerHTML =
    `Dated ${formatDateDisplay(q.date)} · Valid till ${formatDateDisplay(q.expiry_date)}` +
    (q.next_followup_date ? `<br><span class="text-amber-700 font-bold">Next follow-up ${formatDateDisplay(q.next_followup_date)}</span>` : '');

  const btn = (label, onclick, cls = 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100', icon = '') =>
    `<button type="button" onclick="${onclick}" class="px-2.5 py-1 rounded font-bold flex items-center space-x-1 ${cls}">${icon ? `<i data-lucide="${icon}" class="w-3.5 h-3.5"></i>` : ''}<span>${label}</span></button>`;
  const a = [];
  a.push(btn('PDF', `downloadQuotePdf(${q.id})`, 'bg-rose-600 text-white hover:bg-rose-700', 'file-down'));
  a.push(btn('Preview / Print', `viewQuoteDocument(${q.id})`, undefined, 'printer'));
  if (q.status !== 'Invoiced') a.push(btn('Edit', `openQuotationEditor(${q.id})`, undefined, 'pencil'));
  if (q.status === 'Draft') a.push(btn('Mark Sent', `quoteAction('status', 'Sent')`, 'bg-blue-600 text-white hover:bg-blue-700', 'send'));
  if (['Draft', 'Sent', 'Expired'].includes(q.status)) a.push(btn('Accepted', `quoteAction('status', 'Accepted')`, 'bg-emerald-600 text-white hover:bg-emerald-700', 'check'));
  if (['Draft', 'Sent', 'Accepted', 'Expired'].includes(q.status)) a.push(btn('Declined', `quoteAction('status', 'Declined')`, 'bg-white border border-rose-300 text-rose-700 hover:bg-rose-50', 'x'));
  if (['Draft', 'Sent', 'Accepted', 'Expired'].includes(q.status)) a.push(btn('Convert to Invoice', `quoteAction('convert')`, 'bg-teal-700 text-white hover:bg-teal-800', 'receipt'));
  if (q.status === 'Invoiced' && q.converted_voucher_id) a.push(btn(`Invoice ${qEsc(q.converted_voucher_no || '')} PDF`, `downloadInvoicePdf(${q.converted_voucher_id})`, 'bg-teal-700 text-white hover:bg-teal-800', 'receipt'));
  if (!['Invoiced', 'Revised'].includes(q.status)) a.push(btn('Revise', `quoteAction('revise')`, undefined, 'git-branch'));
  a.push(btn('Duplicate', `quoteAction('duplicate')`, undefined, 'copy'));
  if (q.status !== 'Invoiced') a.push(btn('Delete', `quoteAction('delete')`, 'bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 ml-auto', 'trash-2'));
  document.getElementById('qd-actions').innerHTML = a.join('');

  const closed = ['Invoiced', 'Declined', 'Revised'].includes(q.status);
  document.getElementById('qd-followup-form').classList.toggle('hidden', closed);
  document.getElementById('qf-date').value = qToday();
  document.getElementById('qf-notes').value = '';
  document.getElementById('qf-outcome').value = 'Interested';
  setNextFollowupIn(3);

  document.getElementById('qd-timeline').innerHTML = q.followups.length ? q.followups.map((f) => `
    <div class="p-2 rounded border border-slate-200 bg-slate-50/60">
      <div class="flex justify-between items-center">
        <span class="font-bold text-slate-800">${qEsc(f.mode)} · ${formatDateDisplay(f.followup_date)}</span>
        <span class="flex items-center space-x-1">
          ${f.outcome ? `<span class="px-1.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800">${qEsc(f.outcome)}</span>` : ''}
          <button type="button" onclick="deleteFollowup(${f.id})" class="text-slate-400 hover:text-rose-600" title="Remove">✕</button>
        </span>
      </div>
      ${f.notes ? `<div class="text-slate-600 mt-0.5 whitespace-pre-line">${qEsc(f.notes)}</div>` : ''}
      <div class="text-[10px] text-slate-400 mt-0.5">${f.next_followup_date ? `Next: ${formatDateDisplay(f.next_followup_date)}` : 'No next follow-up'}${f.done_by ? ` · by ${qEsc(f.done_by)}` : ''}</div>
    </div>`).join('') : '<div class="text-slate-400">No follow-ups yet. Log the first call or email on the left.</div>';

  document.getElementById('qd-items').innerHTML = q.items.map((i) => `
    <tr><td class="p-2"><div class="font-semibold">${qEsc(i.item_name)}</div>${i.description ? `<div class="text-[10px] text-slate-500">${qEsc(i.description)}</div>` : ''}</td>
    <td class="p-2 text-right font-mono">${i.quantity} ${qEsc(i.uom || '')}</td><td class="p-2 text-right font-mono">${formatCurrency(i.rate)}</td>
    <td class="p-2 text-right font-mono">${i.gst_rate}%</td><td class="p-2 text-right font-mono font-bold">${formatCurrency(i.amount)}</td></tr>`).join('');

  if (window.lucide) window.lucide.createIcons();
}

async function quoteAction(action, arg) {
  const q = quoteState.current;
  if (!q) return;
  try {
    let r;
    if (action === 'status') {
      if (!checkPermission('canCreateVouchers', 'Quotation Status')) return;
      r = await qApi(`/quotations/${q.id}/status`, 'POST', { status: arg });
    } else if (action === 'convert') {
      if (!checkPermission('canCreateVouchers', 'Sales Invoice from Quotation')) return;
      if (!confirm(`Create a Sales Invoice for ${formatCurrency(q.total)} from ${q.quote_no}?\nThis posts a Sales voucher to your books${q.party_ledger_id ? '' : ' and creates a customer ledger under Sundry Debtors'}.`)) return;
      r = await qApi(`/quotations/${q.id}/convert`, 'POST', { date: qToday() });
      if (typeof loadMasters === 'function') loadMasters();
      alert(r.message);
    } else if (action === 'revise' || action === 'duplicate') {
      if (!checkPermission('canCreateVouchers', 'Quotation Entry')) return;
      r = await qApi(`/quotations/${q.id}/${action}`, 'POST');
    } else if (action === 'delete') {
      if (!checkPermission('canDeleteVouchers', 'Delete Quotation')) return;
      if (!confirm(`Delete quotation ${q.quote_no} and its follow-up history?`)) return;
      await qApi(`/quotations/${q.id}`, 'DELETE');
      closeModal('quoteDetailModal');
      loadQuotations();
      return;
    }
    if (r && r.data) renderQuoteDetail(r.data);
    loadQuotations();
  } catch (err) {
    alert(err.message);
  }
}

function setNextFollowupIn(days) {
  const base = document.getElementById('qf-date').value || qToday();
  document.getElementById('qf-next').value = days === null ? '' : qAddDays(base, days);
}

function handleFollowupOutcomeChange() {
  const o = document.getElementById('qf-outcome').value;
  if (o === 'Won' || o === 'Lost') setNextFollowupIn(null);
}

async function handleAddFollowup(e) {
  e.preventDefault();
  const q = quoteState.current;
  if (!q) return;
  try {
    const r = await qApi(`/quotations/${q.id}/followups`, 'POST', {
      followup_date: document.getElementById('qf-date').value,
      mode: document.getElementById('qf-mode').value,
      outcome: document.getElementById('qf-outcome').value,
      next_followup_date: document.getElementById('qf-next').value || null,
      notes: document.getElementById('qf-notes').value.trim(),
      done_by: currentUserName()
    });
    renderQuoteDetail(r.data);
    loadQuotations();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteFollowup(fid) {
  const q = quoteState.current;
  if (!q || !confirm('Remove this follow-up entry?')) return;
  try {
    const r = await qApi(`/quotations/${q.id}/followups/${fid}`, 'DELETE');
    renderQuoteDetail(r.data);
  } catch (err) {
    alert(err.message);
  }
}

// ========================================================
// REPORT CENTER
// ========================================================
async function openReportCenter(reportId) {
  showView('view-report-center');
  if (!quoteState.reports.length) {
    try {
      const r = await qApi('/report-center');
      quoteState.reports = r.data;
    } catch (err) {
      document.getElementById('rc-list').innerHTML = `<div class="text-rose-600">${qEsc(err.message)}</div>`;
      return;
    }
    setReportPeriod('fy', false);
  }
  const groups = {};
  quoteState.reports.forEach((r) => { (groups[r.group] = groups[r.group] || []).push(r); });
  document.getElementById('rc-list').innerHTML = Object.entries(groups).map(([g, list]) => `
    <div>
      <div class="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2 mb-1">${qEsc(g)}</div>
      ${list.map((r) => `
        <div onclick="selectReport('${r.id}')" id="rc-item-${r.id}" class="rc-item px-2 py-1.5 rounded cursor-pointer hover:bg-blue-600 hover:text-white">
          <div class="font-bold">${qEsc(r.title)}</div>
          <div class="text-[10px] opacity-70 leading-tight">${qEsc(r.description)}</div>
        </div>`).join('')}
    </div>`).join('');
  selectReport(reportId || quoteState.activeReport || quoteState.reports[0].id);
}

function selectReport(id) {
  quoteState.activeReport = id;
  document.querySelectorAll('.rc-item').forEach((el) => el.classList.remove('bg-[#1f3a52]', 'text-white'));
  const el = document.getElementById(`rc-item-${id}`);
  if (el) el.classList.add('bg-[#1f3a52]', 'text-white');
  document.getElementById('rc-status-wrap').classList.toggle('hidden', id !== 'quotation-register');
  runReport();
}

function setReportPeriod(kind, rerun = true) {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let from = '', to = '';
  if (kind === 'month') {
    from = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    to = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  } else if (kind === 'fy') {
    const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    from = `${startYear}-04-01`;
    to = `${startYear + 1}-03-31`;
  }
  document.getElementById('rc-from').value = from;
  document.getElementById('rc-to').value = to;
  if (rerun && quoteState.activeReport) runReport();
}

function reportQuery(format) {
  const p = new URLSearchParams();
  const f = document.getElementById('rc-from').value;
  const t = document.getElementById('rc-to').value;
  const s = document.getElementById('rc-status').value;
  if (f) p.set('from_date', f);
  if (t) p.set('to_date', t);
  if (s && quoteState.activeReport === 'quotation-register') p.set('status', s);
  if (format) p.set('format', format);
  return p.toString();
}

function rcCell(v, type) {
  if (type === 'money') return formatCurrency(v).replace('₹', '');
  if (type === 'number') return (parseFloat(v) || 0).toLocaleString('en-IN');
  if (type === 'percent') return `${(parseFloat(v) || 0).toFixed(1)}%`;
  if (type === 'date') return v ? formatDateDisplay(v) : '';
  return qEsc(v ?? '');
}

async function runReport() {
  const id = quoteState.activeReport;
  if (!id) return;
  const tbody = document.getElementById('rc-tbody');
  tbody.innerHTML = '<tr><td class="p-4 text-center text-slate-400">Generating…</td></tr>';
  try {
    const { data: r } = await qApi(`/report-center/${id}?${reportQuery()}`);
    quoteState.lastReport = r;
    const isNum = (c) => ['money', 'number', 'percent'].includes(c.type);
    document.getElementById('rc-title').textContent = r.title;
    document.getElementById('rc-subtitle').textContent = `${r.subtitle || ''} · ${r.rows.length} record(s)`;
    document.getElementById('rc-kpis').innerHTML = (r.kpis || []).map((k) => `
      <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-500">${qEsc(k.label)}</div>
      <div class="text-sm font-black font-mono text-slate-900">${qEsc(k.value)}</div></div>`).join('');
    document.getElementById('rc-thead').innerHTML = `<tr>${r.columns.map((c) => `<th class="p-2 ${isNum(c) ? 'text-right' : 'text-left'} whitespace-nowrap">${qEsc(c.label)}</th>`).join('')}</tr>`;
    tbody.innerHTML = r.rows.length
      ? r.rows.map((row) => `<tr class="hover:bg-slate-50">${r.columns.map((c) => `<td class="p-2 ${isNum(c) ? 'text-right font-mono' : ''}">${rcCell(row[c.key], c.type)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${r.columns.length}" class="p-6 text-center text-slate-400">No records for the selected period.</td></tr>`;
    document.getElementById('rc-tfoot').innerHTML = r.totals
      ? `<tr>${r.columns.map((c, i) => `<td class="p-2 ${isNum(c) ? 'text-right font-mono' : ''}">${i === 0 ? 'Total' : (r.totals[c.key] !== undefined ? rcCell(r.totals[c.key], c.type) : '')}</td>`).join('')}</tr>`
      : '';
  } catch (err) {
    tbody.innerHTML = `<tr><td class="p-4 text-center text-rose-600">${qEsc(err.message)}</td></tr>`;
  }
}

function exportReport(format) {
  const id = quoteState.activeReport;
  if (!id) return;
  const path = `/api/report-center/${id}?${reportQuery(format)}`;
  if (format === 'csv') {
    const a = document.createElement('a');
    a.href = API_BASE.replace(/\/api$/, '') + path;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    openDocumentWindow(path);
  }
}

// ========================================================
// REGISTRATION WITH THE CORE APP (views, Go To, hotkeys)
// ========================================================
(function registerQuotationModule() {
  VIEWS.push('view-quotations', 'view-quotation-editor', 'view-report-center');
  Object.assign(VIEW_BREADCRUMBS, {
    'view-quotations': 'Gateway of Tally > Quotations & Follow-ups',
    'view-quotation-editor': 'Gateway of Tally > Quotations > Quotation Entry',
    'view-report-center': 'Gateway of Tally > Report Center'
  });

  const gotoItems = [
    { title: 'Quotations & Follow-ups', category: 'Sales', action: () => openQuotations(), hotkey: 'E' },
    { title: 'Create Quotation / Estimate', category: 'Sales', action: () => openQuotationEditor(), hotkey: 'Alt+N' },
    { title: 'Follow-ups Due Today', category: 'Sales', action: () => { openQuotations(); setQuoteFollowupFilter('due'); }, hotkey: 'U' },
    { title: 'Report Center (PDF / CSV)', category: 'Reports', action: () => openReportCenter(), hotkey: 'G' },
    { title: 'Sales Register Report', category: 'Reports', action: () => openReportCenter('sales-register') },
    { title: 'Receivables Ageing Report', category: 'Reports', action: () => openReportCenter('receivables-ageing') }
  ];
  if (typeof GOTO_REGISTRY !== 'undefined') GOTO_REGISTRY.push(...gotoItems);
  if (typeof OMNI_COMMANDS !== 'undefined') OMNI_COMMANDS.push(...gotoItems);

  // Capture phase so these run before the core handler (e.g. Esc in the editor returns to the list)
  window.addEventListener('keydown', (e) => {
    const view = appState.currentView;
    const tag = document.activeElement && document.activeElement.tagName;
    const isInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
    const modalOpen = document.querySelector('.modal-backdrop:not(.hidden)');

    if (e.key === 'Escape' && !modalOpen && view === 'view-quotation-editor') {
      e.preventDefault(); e.stopImmediatePropagation(); openQuotations(); return;
    }
    if (e.altKey && (e.key === 'n' || e.key === 'N') && view !== 'view-login') {
      e.preventDefault(); e.stopImmediatePropagation(); openQuotationEditor(); return;
    }
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && view === 'view-quotation-editor') {
      e.preventDefault(); e.stopImmediatePropagation();
      const form = document.getElementById('qe-form');
      if (form.reportValidity()) handleSaveQuotation({ preventDefault() {} }, 'Sent');
      return;
    }
    if (!isInput && !modalOpen && !e.ctrlKey && !e.altKey && !e.metaKey && view === 'view-gateway') {
      const k = e.key.toUpperCase();
      if (k === 'E') { e.preventDefault(); e.stopImmediatePropagation(); openQuotations(); return; }
      if (k === 'U') { e.preventDefault(); e.stopImmediatePropagation(); openQuotations(); setQuoteFollowupFilter('due'); return; }
      if (k === 'G') { e.preventDefault(); e.stopImmediatePropagation(); openReportCenter(); return; }
    }
  }, true);

  // Refresh the follow-up badge whenever the Gateway is shown
  const origShowGateway = window.showGateway || showGateway;
  window.showGateway = function () {
    origShowGateway.apply(this, arguments);
    qApi('/quotations/stats').then((r) => updateFollowupBadge(r.data.followups.overdue + r.data.followups.today)).catch(() => {});
  };
})();

Object.assign(window, {
  openQuotations, loadQuotations, debouncedLoadQuotations, setQuoteFollowupFilter, openQuotationEditor,
  handleQuotePartyChange, handleQuoteDateChange, addQuoteItemRow, handleQuoteItemSelect, recalcQuoteTotals,
  handleSaveQuotation, openQuoteDetail, quoteAction, handleAddFollowup, setNextFollowupIn, handleFollowupOutcomeChange,
  deleteFollowup, downloadQuotePdf, viewQuoteDocument, viewInvoiceDocument, downloadInvoicePdf, viewVoucherDetail,
  openReportCenter, selectReport, setReportPeriod, runReport, exportReport
});

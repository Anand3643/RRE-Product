/**
 * RRE Tally — Organisation: branches, departments, budgets, credit limits, expense reports and supplier performance.
 * Added to the Chart of Accounts view. Tags and limits never change a posting; budgets and limits only raise alerts.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  let units = { branches: [], departments: [] };

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/org${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const msg = (h, cls) => { const el = $('org-msg'); el.className = 'text-[11px] ' + (cls || 'text-slate-600'); el.innerHTML = h; };
  const body = () => $('org-body');
  const table = (cols, rows, empty) => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="text-slate-500">${esc(empty || 'Nothing to show.')}</div>`;
  const ST = { ok: 'bg-emerald-100 text-emerald-800', near: 'bg-amber-100 text-amber-800', over: 'bg-red-100 text-red-800', on_track_to_exceed: 'bg-amber-100 text-amber-800', not_started: 'bg-slate-200 text-slate-600', no_limit: 'bg-slate-200 text-slate-600' };
  const badge = (s) => `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${ST[s] || ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;
  const opt = (arr, none) => `<option value="">${esc(none)}</option>` + arr.filter((x) => x.is_active).map((x) => `<option value="${x.id}">${esc(x.code)} — ${esc(x.name)}</option>`).join('');
  const note = (t) => `<div class="text-[10px] text-slate-500 mt-1">${esc(t)}</div>`;

  async function loadUnits() { units = { branches: await call('/units/branches'), departments: await call('/units/departments') }; }
  async function ledgers() { const j = await (await fetch(`${base()}/masters/ledgers`)).json(); return j.data || []; }

  // ------------------------------------------------------------------ tab: branches & departments + tagging
  async function tabUnits() {
    await loadUnits();
    const unitRows = (kind, list) => table(['Code', 'Name', 'Vouchers', 'Status', ''], list.map((u) => [esc(u.code), esc(u.name), u.vouchers, u.is_active ? 'active' : 'switched off',
      `<button type="button" data-tog="${kind}:${u.id}:${u.is_active ? 0 : 1}" class="px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-sans font-bold">${u.is_active ? 'Switch off' : 'Switch on'}</button>`]), 'None yet.');
    const def = await call('/defaults');
    body().innerHTML = `
      <div class="grid md:grid-cols-2 gap-3">
        <div><div class="font-bold mb-1">Branches</div>${unitRows('branches', units.branches)}
          <div class="flex flex-wrap gap-1 mt-1"><input id="org-b-code" maxlength="12" placeholder="Code" class="border border-slate-300 rounded p-1 w-20 bg-white"><input id="org-b-name" maxlength="60" placeholder="Branch name" class="border border-slate-300 rounded p-1 w-40 bg-white"><button type="button" data-add="branches" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Add</button></div></div>
        <div><div class="font-bold mb-1">Departments</div>${unitRows('departments', units.departments)}
          <div class="flex flex-wrap gap-1 mt-1"><input id="org-d-code" maxlength="12" placeholder="Code" class="border border-slate-300 rounded p-1 w-20 bg-white"><input id="org-d-name" maxlength="60" placeholder="Department name" class="border border-slate-300 rounded p-1 w-40 bg-white"><button type="button" data-add="departments" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Add</button></div></div>
      </div>
      <div class="border border-slate-200 rounded p-2 bg-slate-50 mt-2"><div class="font-bold">My defaults</div>
        <div class="flex flex-wrap items-center gap-1 mt-1"><select id="org-def-b" class="border border-slate-300 rounded p-1 bg-white">${opt(units.branches, 'No default branch')}</select><select id="org-def-d" class="border border-slate-300 rounded p-1 bg-white">${opt(units.departments, 'No default department')}</select>
        <button type="button" id="org-def-save" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Save</button></div>${note('Vouchers you post are tagged with these automatically. Tags only label vouchers; they never change a posting.')}</div>
      <div class="border border-slate-200 rounded p-2 mt-2"><div class="font-bold">Tag existing vouchers</div>
        <div class="flex flex-wrap items-center gap-1 mt-1"><input id="org-tg-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to <input id="org-tg-to" type="date" class="border border-slate-300 rounded p-1 bg-white">
          <select id="org-tg-type" class="border border-slate-300 rounded p-1 bg-white"><option value="">All types</option><option>Sales</option><option>Purchase</option><option>Payment</option><option>Receipt</option><option>Journal</option><option>Contra</option></select>
          <label><input type="checkbox" id="org-tg-untagged" checked> untagged only</label><button type="button" id="org-tg-load" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Find vouchers</button></div>
        <div id="org-tg-list" class="mt-1"></div></div>`;
    $('org-def-b').value = def.branch_id || ''; $('org-def-d').value = def.department_id || '';
    body().querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.add, p = k === 'branches' ? 'b' : 'd';
      try { await call(`/units/${k}`, { method: 'POST', body: JSON.stringify({ code: $(`org-${p}-code`).value, name: $(`org-${p}-name`).value }) }); msg('Saved.', 'text-emerald-700'); tabUnits(); } catch (e) { msg(esc(e.message), 'text-red-700'); }
    }));
    body().querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', async () => { const [k, id, on] = b.dataset.tog.split(':'); try { await call(`/units/${k}/${id}/active`, { method: 'POST', body: JSON.stringify({ active: on === '1' }) }); tabUnits(); } catch (e) { msg(esc(e.message), 'text-red-700'); } }));
    $('org-def-save').addEventListener('click', async () => { try { await call('/defaults', { method: 'POST', body: JSON.stringify({ branch_id: $('org-def-b').value || null, department_id: $('org-def-d').value || null }) }); msg('Defaults saved.', 'text-emerald-700'); } catch (e) { msg(esc(e.message), 'text-red-700'); } });
    $('org-tg-load').addEventListener('click', loadTagList);
  }

  async function loadTagList() {
    const q = new URLSearchParams(); if ($('org-tg-type').value) q.set('type', $('org-tg-type').value); if ($('org-tg-from').value) q.set('from_date', $('org-tg-from').value); if ($('org-tg-to').value) q.set('to_date', $('org-tg-to').value);
    try {
      const j = await (await fetch(`${base()}/vouchers?${q}`)).json();
      let list = (j.data || []); if ($('org-tg-untagged').checked) list = list.filter((v) => !v.branch_id && !v.department_id);
      const shown = list.slice(0, 200);
      $('org-tg-list').innerHTML = (shown.length ? `<div class="max-h-56 overflow-y-auto">${table(['', 'Date', 'Voucher', 'Type', 'Party', 'Amount'], shown.map((v) => [`<input type="checkbox" class="org-tg-pick" value="${v.id}">`, esc(v.date), esc(v.voucher_no), esc(v.voucher_type), esc(v.party_name || ''), num(v.total_amount)]))}</div>` : '<div class="text-slate-500">No matching vouchers.</div>') +
        (list.length > 200 ? note(`Showing the first 200 of ${list.length}; narrow the dates.`) : '') +
        `<div class="flex flex-wrap items-center gap-1 mt-1"><label><input type="checkbox" id="org-tg-all"> select all shown</label><select id="org-tg-b" class="border border-slate-300 rounded p-1 bg-white">${opt(units.branches, 'Branch: leave as is')}</select><select id="org-tg-d" class="border border-slate-300 rounded p-1 bg-white">${opt(units.departments, 'Department: leave as is')}</select>
          <button type="button" id="org-tg-apply" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Apply tags</button><button type="button" id="org-tg-clear" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Clear tags</button></div>`;
      $('org-tg-all').addEventListener('change', (e) => document.querySelectorAll('.org-tg-pick').forEach((c) => { c.checked = e.target.checked; }));
      const apply = async (clear) => {
        const ids = [...document.querySelectorAll('.org-tg-pick:checked')].map((c) => +c.value);
        if (!ids.length) return msg('Tick at least one voucher.', 'text-red-700');
        try { const r = await call('/tag', { method: 'POST', body: JSON.stringify({ voucher_ids: ids, clear, branch_id: $('org-tg-b').value ? +$('org-tg-b').value : undefined, department_id: $('org-tg-d').value ? +$('org-tg-d').value : undefined }) }); msg(`Updated ${r.tagged} voucher(s).`, 'text-emerald-700'); loadTagList(); } catch (e) { msg(esc(e.message), 'text-red-700'); }
      };
      $('org-tg-apply').addEventListener('click', () => apply(false)); $('org-tg-clear').addEventListener('click', () => apply(true));
    } catch (e) { $('org-tg-list').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------------ tab: reports
  async function tabReports(by) {
    by = by || 'department';
    body().innerHTML = `<div class="flex flex-wrap items-center gap-2"><select id="org-rp-by" class="border border-slate-300 rounded p-1 bg-white"><option value="department">Expenses by department</option><option value="branch">Expenses by branch</option><option value="cost_centre">Expenses by cost centre</option><option value="summary">Branch summary (sales, purchases, expenses)</option></select>
      <input id="org-rp-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to <input id="org-rp-to" type="date" class="border border-slate-300 rounded p-1 bg-white"><button type="button" id="org-rp-go" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Show</button></div><div id="org-rp-out" class="mt-2"></div>`;
    $('org-rp-by').value = by;
    $('org-rp-go').addEventListener('click', async () => {
      const q = new URLSearchParams(); if ($('org-rp-from').value) q.set('from_date', $('org-rp-from').value); if ($('org-rp-to').value) q.set('to_date', $('org-rp-to').value);
      const sel = $('org-rp-by').value;
      try {
        if (sel === 'summary') {
          const d = await call(`/branch-summary?${q}`);
          $('org-rp-out').innerHTML = table(['Branch', 'Sales (₹)', 'Purchases (₹)', 'Expenses (₹)', 'Surplus (₹)'], d.rows.map((r) => [esc(r.branch), num(r.sales), num(r.purchases), num(r.expenses), `<strong class="${r.surplus < 0 ? 'text-red-700' : ''}">${num(r.surplus)}</strong>`])) + note(d.note);
        } else {
          q.set('by', sel); const d = await call(`/expenses?${q}`);
          $('org-rp-out').innerHTML = `<div class="font-bold">Total ₹${num(d.total)}</div>` + table(['Name', 'Amount (₹)', 'Share %', 'Main ledgers'], d.rows.map((r) => [esc(r.dimension), num(r.amount), r.share_pct, `<span class="font-sans">${esc(r.ledgers.slice(0, 3).map((l) => `${l.ledger} ${num(l.amount)}`).join(' · '))}</span>`])) + note(d.note);
        }
      } catch (e) { $('org-rp-out').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
    });
  }

  // ------------------------------------------------------------------ tab: budgets
  async function tabBudgets() {
    await loadUnits();
    const [st, leds] = await Promise.all([call('/budgets'), ledgers()]);
    const exp = leds.filter((l) => ['Direct Expenses', 'Indirect Expenses'].includes(l.group_name));
    body().innerHTML = `<div class="font-bold">Budget vs actual — as at ${esc(st.as_of)}</div>` + table(['Ledger', 'Scope', 'Period', 'Budget', 'Actual', '% used', 'Projected', 'Status', ''],
      st.budgets.map((b) => [esc(b.ledger), esc([b.department, b.branch].filter(Boolean).join(' / ') || 'All'), `${esc(b.period_type)} ${esc(b.from)} → ${esc(b.to)}`, num(b.amount), num(b.actual), b.pct_used, b.projected === null ? '—' : num(b.projected), badge(b.status),
        `<button type="button" data-del="${b.id}" class="px-1.5 py-0.5 bg-red-100 hover:bg-red-200 text-red-800 rounded font-sans font-bold">Delete</button>`]), 'No budgets yet.') + note(st.method) +
      `<div class="border border-slate-200 rounded p-2 bg-slate-50 mt-2"><div class="font-bold">Add a budget</div><div class="flex flex-wrap items-center gap-1 mt-1">
        <select id="org-bd-l" class="border border-slate-300 rounded p-1 bg-white max-w-[12rem]">${exp.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <select id="org-bd-d" class="border border-slate-300 rounded p-1 bg-white">${opt(units.departments, 'All departments')}</select><select id="org-bd-b" class="border border-slate-300 rounded p-1 bg-white">${opt(units.branches, 'All branches')}</select>
        <select id="org-bd-t" class="border border-slate-300 rounded p-1 bg-white"><option value="month">Monthly</option><option value="year">Financial year</option></select><input id="org-bd-s" type="date" title="Start (1st of the month / FY start)" class="border border-slate-300 rounded p-1 bg-white">
        <input id="org-bd-a" type="number" min="1" placeholder="Amount ₹" class="border border-slate-300 rounded p-1 w-28 bg-white"><button type="button" id="org-bd-add" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Add</button></div></div>`;
    $('org-bd-s').value = st.as_of.slice(0, 7) + '-01';
    $('org-bd-add').addEventListener('click', async () => {
      try { await call('/budgets', { method: 'POST', body: JSON.stringify({ ledger_id: +$('org-bd-l').value, department_id: $('org-bd-d').value || undefined, branch_id: $('org-bd-b').value || undefined, period_type: $('org-bd-t').value, period_start: $('org-bd-s').value, amount: +$('org-bd-a').value }) }); msg('Budget added.', 'text-emerald-700'); tabBudgets(); } catch (e) { msg(esc(e.message), 'text-red-700'); }
    });
    body().querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this budget? (Accounting entries are not affected.)')) return; try { await call(`/budgets/${b.dataset.del}`, { method: 'DELETE' }); tabBudgets(); } catch (e) { msg(esc(e.message), 'text-red-700'); } }));
  }

  // ------------------------------------------------------------------ tab: credit limits
  async function tabCredit() {
    const [cs, leds] = await Promise.all([call('/credit-status'), ledgers()]);
    const customers = leds.filter((l) => l.group_name === 'Sundry Debtors');
    body().innerHTML = `<div class="font-bold">Customers with a credit limit — as at ${esc(cs.as_of)}</div>` + table(['Customer', 'Limit', 'Owes', 'Available', '% used', 'Overdue', 'Status'],
      cs.customers.map((c) => [esc(c.customer), num(c.credit_limit), num(c.balance), num(c.available), c.pct_used, num(c.overdue), badge(c.status)]), 'No credit limits set yet.') + note(cs.method) +
      `<div class="border border-slate-200 rounded p-2 bg-slate-50 mt-2"><div class="font-bold">Set a credit limit</div><div class="flex flex-wrap items-center gap-1 mt-1">
        <select id="org-cl-c" class="border border-slate-300 rounded p-1 bg-white max-w-[16rem]">${customers.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <input id="org-cl-a" type="number" min="0" placeholder="Limit ₹ (0 removes)" class="border border-slate-300 rounded p-1 w-36 bg-white"><button type="button" id="org-cl-set" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Save</button></div></div>`;
    $('org-cl-set').addEventListener('click', async () => { try { await call('/credit-limits', { method: 'POST', body: JSON.stringify({ ledger_id: +$('org-cl-c').value, credit_limit: $('org-cl-a').value === '' ? null : +$('org-cl-a').value }) }); msg('Saved.', 'text-emerald-700'); tabCredit(); } catch (e) { msg(esc(e.message), 'text-red-700'); } });
  }

  // ------------------------------------------------------------------ tab: supplier performance
  async function tabSuppliers() {
    body().innerHTML = '<div class="flex flex-wrap items-center gap-2"><input id="org-sp-from" type="date" class="border border-slate-300 rounded p-1 bg-white"> to <input id="org-sp-to" type="date" class="border border-slate-300 rounded p-1 bg-white"><button type="button" id="org-sp-go" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Show</button><span class="text-slate-500">(default: the 12 months to the latest voucher)</span></div><div id="org-sp-out" class="mt-2"></div>';
    const run_ = async () => {
      const q = new URLSearchParams(); if ($('org-sp-from').value) q.set('from_date', $('org-sp-from').value); if ($('org-sp-to').value) q.set('to_date', $('org-sp-to').value);
      try {
        const d = await call(`/supplier-performance?${q}`);
        $('org-sp-out').innerHTML = `<div class="font-bold">${esc(d.from)} → ${esc(d.to)} · purchases ₹${num(d.total_purchases)}</div>` + table(['Supplier', 'Purchases', 'Share %', 'Bills', 'Returns', 'Days to pay', 'Owed now', 'Score', 'Why'],
          d.suppliers.map((s) => [esc(s.supplier), num(s.purchases), s.share_of_spend_pct, s.bills, num(s.returns), s.avg_days_to_pay === null ? '—' : s.avg_days_to_pay, num(s.owed_now), `<strong>${s.score === null ? '—' : s.score}</strong> <span class="font-sans">${esc(s.band)}</span>`,
            `<span class="font-sans">${esc(s.components.filter((c) => c.score !== null).map((c) => `${c.label.split(' (')[0]}: ${c.value}${c.unit === '%' ? '%' : c.unit === '% above best' ? '% above best' : ''} → ${c.score}`).join(' · '))}</span>`]), 'No supplier purchases in this period.') + note(d.method);
      } catch (e) { $('org-sp-out').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
    };
    $('org-sp-go').addEventListener('click', run_); run_();
  }

  const TABS = { units: ['Branches & Departments', tabUnits], reports: ['Expense Reports', () => tabReports()], budgets: ['Budgets', tabBudgets], credit: ['Credit Limits', tabCredit], suppliers: ['Supplier Performance', tabSuppliers] };
  async function show(key) {
    document.querySelectorAll('.org-tab').forEach((b) => { const on = b.dataset.tab === key; b.className = 'org-tab px-2.5 py-1 rounded font-bold ' + (on ? 'bg-slate-800 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'); });
    msg(''); body().innerHTML = '<div class="text-slate-500">Loading…</div>';
    try { await TABS[key][1](); } catch (e) { body().innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  function inject() {
    const view = $('view-chart-accounts');
    if (!view || $('org-card')) return;
    const host = view.querySelector('.p-6'); if (!host) return;
    const card = document.createElement('div');
    card.id = 'org-card'; card.className = 'border border-slate-300 rounded-lg overflow-hidden text-xs mt-4';
    card.innerHTML = `<div class="bg-slate-800 text-white font-bold p-2.5">Organisation — Branches, Departments, Budgets, Credit Limits &amp; Suppliers</div>
      <div class="p-4 space-y-3"><div class="flex flex-wrap gap-1">${Object.entries(TABS).map(([k, v]) => `<button type="button" class="org-tab" data-tab="${k}">${esc(v[0])}</button>`).join('')}</div>
        <div id="org-msg" class="text-[11px]"></div><div id="org-body"></div></div>`;
    host.appendChild(card);
    card.querySelectorAll('.org-tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show('units');
  }

  // ------------------------------------------------------------------ pre-save warning when a customer is already over their limit
  function hookSave() {
    if (typeof window.handleSaveVoucher !== 'function' || window.handleSaveVoucher.__orgHooked) return;
    const original = window.handleSaveVoucher;
    const wrapped = async function (e) {
      if (e && e.preventDefault) e.preventDefault(); // before any await
      try {
        const type = $('v-select-type') && $('v-select-type').value, party = parseInt($('v-party-ledger') && $('v-party-ledger').value, 10);
        if (type === 'Sales' && party) {
          const c = await call('/credit-check', { method: 'POST', body: JSON.stringify({ party_ledger_id: party, amount: 0 }) });
          if (c.already_over && !confirm(`${c.customer} already owes ₹${num(c.balance)} against a credit limit of ₹${num(c.limit)}.\n\nPost this sale anyway?`)) return;
        }
      } catch (err) { /* advisory only; never blocks saving */ }
      return original.call(this, e);
    };
    wrapped.__orgHooked = true;
    window.handleSaveVoucher = wrapped;
  }

  function boot() {
    hookSave();
    if (typeof window.loadChartOfAccountsTree === 'function' && !window.loadChartOfAccountsTree.__orgHooked) {
      const original = window.loadChartOfAccountsTree;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__orgHooked = true; window.loadChartOfAccountsTree = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

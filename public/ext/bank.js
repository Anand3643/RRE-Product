/**
 * RRE Tally — bank statement import & smart reconciliation, added inside the existing
 * Bank Reconciliation view. Suggestions are never applied until the user confirms them.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  let currentImport = null;
  let lastSuggestions = [];

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/bank${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.details = j.details; throw e; }
    return j;
  }
  const msg = (html, cls = 'text-slate-600') => { $('bk-msg').className = 'text-[11px] ' + cls; $('bk-msg').innerHTML = html; };
  const bankId = () => parseInt($('bk-ledger').value, 10);

  const table = (cols, rows, empty = 'None.') => rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${cols.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="text-slate-500">${esc(empty)}</div>`;
  const section = (title, count, body, open) => `<details class="border border-slate-200 rounded" ${open ? 'open' : ''}><summary class="cursor-pointer p-2 font-bold bg-slate-50">${esc(title)} <span class="text-slate-500">(${count})</span></summary><div class="p-2">${body}</div></details>`;
  const amount = (l) => (l.debit > 0 ? `<span class="text-red-700">−${fmt(l.debit)}</span>` : `<span class="text-emerald-700">+${fmt(l.credit)}</span>`);
  const confCls = { high: 'bg-emerald-100 text-emerald-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-slate-200 text-slate-700' };

  async function loadLedgers() {
    const sel = $('bk-ledger');
    const list = (await call('/ledgers')).data;
    const want = (typeof appState !== 'undefined' && appState.activeBankLedgerId) || null;
    sel.innerHTML = list.map((l) => `<option value="${l.id}" ${l.id === want ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    if (!list.length) msg('No bank ledgers found.', 'text-red-700');
  }

  async function refreshSummary() {
    try {
      const d = (await call('/summary?bank_ledger_id=' + bankId())).data;
      const tile = (l, v, c = '') => `<div class="p-2 rounded border border-slate-200 bg-slate-50 ${c}"><div class="text-[10px] uppercase font-sans text-slate-500">${l}</div><div class="font-bold">${v}</div></div>`;
      const diff = d.unexplained_difference;
      $('bk-summary').innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 gap-2 font-mono">` +
        tile('Balance per books', '₹' + fmt(d.balance_per_books)) +
        tile('Expected at bank', '₹' + fmt(d.expected_bank_balance)) +
        tile('Statement closing' + (d.statement_as_of ? ' (' + esc(d.statement_as_of) + ')' : ''), d.statement_closing_balance === null ? '—' : '₹' + fmt(d.statement_closing_balance)) +
        tile('Unexplained difference', diff === null ? '—' : '₹' + fmt(diff), diff === null ? '' : Math.abs(diff) < 0.01 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800') + `</div>` +
        `<div class="text-[10px] text-slate-500 mt-1">Uncleared: receipts ₹${fmt(d.uncleared_receipts.amount)} (${d.uncleared_receipts.count}), payments ₹${fmt(d.uncleared_payments.amount)} (${d.uncleared_payments.count}). ${esc(d.explanation)}</div>`;
    } catch (e) { $('bk-summary').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function refreshImports(selectId) {
    const rows = (await call('/imports?bank_ledger_id=' + bankId())).data;
    $('bk-imports').innerHTML = '<option value="">Imported statements…</option>' + rows.map((r) =>
      `<option value="${r.id}" ${r.id === selectId ? 'selected' : ''}>#${r.id} · ${esc(r.filename || 'statement')} · ${esc(r.date_from)} → ${esc(r.date_to)} · ${r.matched}/${r.row_count} matched${r.duplicates ? ' · ' + r.duplicates + ' dup' : ''}</option>`).join('');
  }

  async function importStatement() {
    const f = $('bk-file').files[0];
    if (!f) return msg('Choose a bank statement file first (CSV, Excel or PDF from net-banking).', 'text-red-700');
    if (!/\.csv$/i.test(f.name) && window.RREDocImport) { // Excel / PDF statement: read by Import Documents, then into this reconciliation
      $('bk-file').value = '';
      return window.RREDocImport.importFiles([f], { settings: { category: 'bank_statement', bank_ledger_id: bankId() } });
    }
    if (f.size > 8 * 1024 * 1024) return msg('File is larger than 8 MB.', 'text-red-700');
    msg('Importing…');
    try {
      const r = (await call('/import', { method: 'POST', body: JSON.stringify({ bank_ledger_id: bankId(), content: await f.text(), filename: f.name }) })).data;
      msg(`Imported ${r.rows} line(s) into import #${r.import_id}.` + (r.warnings.length ? '<ul class="list-disc ml-4 text-amber-700">' + r.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>' : ''), 'text-emerald-700');
      $('bk-file').value = '';
      await refreshImports(r.import_id);
      await openImport(r.import_id);
      refreshSummary();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  // every ledger except this bank account, for recording a statement line that is not in the books yet
  let allLedgers = null;
  async function ledgerChoices() {
    if (!allLedgers) { try { allLedgers = ((await (await fetch(`${base()}/masters/ledgers`)).json()).data || []).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { allLedgers = []; } }
    return allLedgers.filter((l) => l.id !== bankId());
  }
  const guessLedger = (list, l) => {
    const d = String(l.description || '').toLowerCase();
    const by = (re) => list.find((x) => re.test(x.name));
    if (/charge|fee|commission|gst on chg/.test(d)) return by(/bank charges/i);
    if (/interest|int\.?\s*cr|int pd/.test(d)) return by(/interest/i);
    return list.find((x) => x.name.length >= 4 && d.includes(x.name.toLowerCase())) || null;
  };

  async function openImport(id) {
    currentImport = id || parseInt($('bk-imports').value, 10);
    if (!currentImport) { $('bk-work').innerHTML = ''; return; }
    $('bk-work').innerHTML = '<div class="text-slate-500">Finding matches…</div>';
    try {
      const d = (await call(`/imports/${currentImport}/suggestions`)).data;
      const choices = await ledgerChoices();
      const matched = (await call(`/imports/${currentImport}/lines?status=matched`)).data;
      lastSuggestions = d.suggestions;
      const high = d.suggestions.filter((s) => s.confidence === 'high' && !s.ambiguous).length;
      $('bk-work').innerHTML =
        `<div class="flex items-center justify-between"><div class="font-bold">${d.suggestions.length} suggested match(es) — review, then confirm. Nothing changes until you confirm.</div>
           <div class="space-x-2"><button type="button" id="bk-sel-high" class="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Select high-confidence (${high})</button>
           <button type="button" id="bk-confirm" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Confirm selected</button></div></div>` +
        table(['', 'Bank date', 'Bank description', 'Amount', 'Matches voucher', 'Party / ref', 'Confidence', 'Why'],
          d.suggestions.map((s) => [`<input type="checkbox" class="bk-pick" data-line="${s.line_id}" data-entry="${s.entry_id}" ${s.confidence === 'high' && !s.ambiguous ? 'checked' : ''}>`,
            esc(s.line.date), esc(s.line.description), amount(s.line), `${esc(s.entry.voucher_no)} <span class="text-slate-500">${esc(s.entry.voucher_type)} ${esc(s.entry.date)}</span>`,
            esc((s.entry.party || '') + (s.entry.instrument_no ? ' · ' + s.entry.instrument_no : '')),
            `<span class="px-1.5 py-0.5 rounded font-sans font-bold ${confCls[s.confidence]}">${esc(s.confidence)}${s.ambiguous ? ' · ambiguous' : ''}</span>`, `<span class="font-sans">${esc(s.reasons.join('; '))}</span>`]),
          'No automatic matches found.') +
        section('In the bank statement but not in your books', d.unmatched_bank_lines.length,
          table(['Date', 'Description', 'Ref', 'Amount', 'Suggestion', 'Record as a new voucher', ''], d.unmatched_bank_lines.map((l) => { const g = guessLedger(choices, l); return [esc(l.date), esc(l.description), esc(l.ref), amount(l), `<span class="font-sans">${esc(l.hint)}</span>`,
            `<span class="font-sans whitespace-nowrap"><select class="bk-rec-led border border-slate-300 rounded p-0.5 bg-white max-w-[12rem]" data-line="${l.line_id}"><option value="">${l.debit > 0 ? 'Paid to…' : 'Received from…'}</option>${choices.map((c) => `<option value="${c.id}" ${g && g.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select> <button type="button" class="bk-record px-1.5 py-0.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold" data-line="${l.line_id}" data-amt="${l.debit || l.credit}" data-dir="${l.debit > 0 ? 'out' : 'in'}">Record</button></span>`,
            `<button type="button" class="bk-ignore px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-sans font-bold" data-line="${l.line_id}">Ignore</button>`]; })), d.unmatched_bank_lines.length > 0) +
        section('In your books but not in the statement (uncleared)', d.books_not_in_statement.length,
          table(['Date', 'Voucher', 'Type', 'Party', 'Instrument', 'Debit', 'Credit'], d.books_not_in_statement.map((b) => [esc(b.date), esc(b.voucher_no), esc(b.voucher_type), esc(b.party || ''), esc(b.instrument_no || ''), b.debit ? fmt(b.debit) : '', b.credit ? fmt(b.credit) : ''])), false) +
        section('Already matched from this statement', matched.length,
          table(['Date', 'Description', 'Amount', ''], matched.map((l) => [esc(l.line_date), esc(l.description), amount(l), `<button type="button" class="bk-unmatch px-1.5 py-0.5 bg-amber-200 hover:bg-amber-300 rounded font-sans font-bold" data-line="${l.id}">Unmatch</button>`])), false) +
        `<div class="text-[10px] text-slate-500"><strong>Assumptions:</strong> ${d.assumptions.map(esc).join(' ')}</div>`;
      $('bk-sel-high').addEventListener('click', () => document.querySelectorAll('.bk-pick').forEach((c) => { const s = lastSuggestions.find((x) => x.line_id == c.dataset.line); c.checked = !!s && s.confidence === 'high' && !s.ambiguous; }));
      $('bk-confirm').addEventListener('click', confirmSelected);
      document.querySelectorAll('.bk-ignore').forEach((b) => b.addEventListener('click', () => lineAction(b.dataset.line, 'ignore')));
      document.querySelectorAll('.bk-record').forEach((b) => b.addEventListener('click', () => recordLine(b)));
      document.querySelectorAll('.bk-unmatch').forEach((b) => b.addEventListener('click', () => lineAction(b.dataset.line, 'unmatch')));
    } catch (e) { $('bk-work').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function confirmSelected() {
    const picks = [...document.querySelectorAll('.bk-pick:checked')].map((c) => ({ line_id: +c.dataset.line, entry_id: +c.dataset.entry }));
    if (!picks.length) return msg('Select at least one suggestion to confirm.', 'text-red-700');
    if (!confirm(`Mark ${picks.length} voucher line(s) as cleared on the bank statement dates? You can undo each with "Unmatch".`)) return;
    try {
      const r = (await call(`/imports/${currentImport}/confirm`, { method: 'POST', body: JSON.stringify({ matches: picks }) })).data;
      msg(`Confirmed ${r.matched} match(es).`, 'text-emerald-700');
      await afterChange();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  async function recordLine(b) {
    const sel = document.querySelector(`.bk-rec-led[data-line="${b.dataset.line}"]`);
    const led = sel && sel.value ? allLedgers.find((x) => String(x.id) === sel.value) : null;
    if (!led) return msg('Choose the ledger this money was paid to / received from, then Record.', 'text-red-700');
    if (!confirm(`Record a new voucher for ₹${fmt(b.dataset.amt)} ${b.dataset.dir === 'out' ? 'paid to' : 'received from'} "${led.name}" and mark this statement line as cleared?`)) return;
    b.disabled = true;
    try {
      const r = (await call(`/lines/${b.dataset.line}/record`, { method: 'POST', body: JSON.stringify({ ledger_id: led.id }) })).data;
      msg(`Recorded ${esc(r.voucher.voucher_type)} ${esc(r.voucher.voucher_no)} (₹${fmt(r.amount)}, ${esc(r.ledger)}); the line is cleared.`, 'text-emerald-700');
      await afterChange();
    } catch (e) { b.disabled = false; msg(esc(e.message), 'text-red-700'); }
  }

  async function lineAction(lineId, kind) {
    try {
      await call(`/lines/${lineId}/${kind}`, { method: 'POST', body: JSON.stringify({}) });
      await afterChange();
    } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  async function afterChange() {
    await refreshImports(currentImport);
    await openImport(currentImport);
    refreshSummary();
    if (typeof window.loadBankReconciliation === 'function') window.loadBankReconciliation(); // refresh the existing BRS table
  }

  async function showHistory() {
    try {
      const rows = (await call('/history?bank_ledger_id=' + bankId())).data;
      $('bk-extra').innerHTML = section('Reconciliation history', rows.length, table(['When', 'User', 'Action', 'Voucher', 'Details'], rows.map((h) => [esc(h.created_at), esc(h.created_by), esc(h.action), esc(h.voucher_no || ''), esc(h.details || '')])), true);
    } catch (e) { $('bk-extra').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function showPayments() {
    try {
      const rows = (await call('/payments?bank_ledger_id=' + bankId() + '&limit=300')).data;
      $('bk-extra').innerHTML = section('Payment & receipt status', rows.length, table(['Date', 'Voucher', 'Party', 'Instrument', 'Dir.', 'Amount', 'Status', 'Note'], rows.map((r) => [esc(r.date), esc(r.voucher_no), esc(r.party || ''), esc(r.instrument_no || ''), esc(r.direction), fmt(r.amount),
        r.status === 'Cleared' ? `<span class="text-emerald-700">Cleared ${esc(r.bank_clearing_date || '')}</span>` : `<span class="text-amber-700">Pending ${r.pending_days}d</span>`, `<span class="font-sans text-red-700">${esc(r.flag || '')}</span>`])), true);
    } catch (e) { $('bk-extra').innerHTML = `<div class="text-red-700">${esc(e.message)}</div>`; }
  }

  async function onLedgerChange() { $('bk-work').innerHTML = ''; $('bk-extra').innerHTML = ''; await refreshImports(); refreshSummary(); }

  async function inject() {
    const view = $('view-bank-recon');
    if (!view || $('bank-tools-card')) return;
    const host = view.querySelector('.p-6');
    if (!host) return;
    const card = document.createElement('div');
    card.id = 'bank-tools-card';
    card.className = 'border border-slate-300 rounded-lg overflow-hidden';
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">Bank Statement Import &amp; Smart Reconciliation</div>
      <div class="p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <select id="bk-ledger" class="border border-slate-300 rounded p-1.5 bg-white font-semibold"></select>
          <input id="bk-file" type="file" accept=".csv,text/csv,.xlsx,.xls,.pdf" class="text-[11px]">
          <button type="button" id="bk-import" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Import statement</button>
          <select id="bk-imports" class="border border-slate-300 rounded p-1.5 bg-white max-w-sm"></select>
          <button type="button" id="bk-history" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">History</button>
          <button type="button" id="bk-payments" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">Payment status</button>
        </div>
        <div id="bk-msg" class="text-[11px] text-slate-600">Import a CSV statement (Date, Description, Ref, Debit/Withdrawal, Credit/Deposit, Balance). Importing never changes your books.</div>
        <div id="bk-summary"></div>
        <div id="bk-work" class="space-y-2"></div>
        <div id="bk-extra" class="space-y-2"></div>
      </div>`;
    host.appendChild(card);
    $('bk-import').addEventListener('click', importStatement);
    $('bk-imports').addEventListener('change', () => openImport());
    $('bk-ledger').addEventListener('change', onLedgerChange);
    $('bk-history').addEventListener('click', showHistory);
    $('bk-payments').addEventListener('click', showPayments);
    try { await loadLedgers(); await refreshImports(); refreshSummary(); } catch (e) { msg(esc(e.message), 'text-red-700'); }
  }

  function boot() {
    if (typeof window.loadBankReconciliation === 'function' && !window.loadBankReconciliation.__hooked) {
      const original = window.loadBankReconciliation;
      const wrapped = function () {
        const r = original.apply(this, arguments);
        if (!$('bank-tools-card')) inject(); else refreshSummary();
        return r;
      };
      wrapped.__hooked = true;
      window.loadBankReconciliation = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // Import Documents hands a statement it imported to this screen: open Bank Reconciliation on that bank account and statement
  window.RREBank = {
    async openImport(ledgerId, importId) {
      if (ledgerId && typeof appState !== 'undefined') appState.activeBankLedgerId = ledgerId;
      if (typeof openReport === 'function') openReport('bank-recon');
      for (let i = 0; i < 40 && !($('bk-ledger') && $('bk-ledger').options.length); i++) await new Promise((r) => setTimeout(r, 150));
      if (!$('bk-ledger')) return;
      if (ledgerId && [...$('bk-ledger').options].some((o) => +o.value === ledgerId)) $('bk-ledger').value = String(ledgerId);
      await refreshImports(importId); refreshSummary();
      if (importId) await openImport(importId);
      const card = $('bank-tools-card'); if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
})();

/**
 * RRE Tally — "Ask Your Books": natural-language questions, daily summary, health score, cash-flow forecast
 * and trends, added to the Ratio Analysis view. Everything is computed from your own books; nothing is posted.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  const fmtCell = (v) => (typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : esc(v == null ? '' : v));
  const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/_(Note:[^_]+)_/g, '<em>$1</em>').replace(/\n/g, '<br>');

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/insights${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.error || `Request failed (${res.status})`);
    return j.data;
  }
  const out = () => $('ins-out');
  const busy = (m) => { out().innerHTML = `<div class="text-slate-500">${esc(m)}</div>`; };
  const fail = (e) => { out().innerHTML = `<div class="text-red-700 font-semibold">${esc(e.message)}</div>`; };
  const table = (t) => (t && t.rows.length
    ? `<div class="border border-slate-300 rounded overflow-x-auto mt-2"><table class="w-full text-[11px]"><thead class="bg-slate-100 text-slate-700 font-semibold"><tr>${t.columns.map((c) => `<th class="p-1.5 text-left">${esc(c)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-200 font-mono">${t.rows.map((r) => `<tr>${r.map((v) => `<td class="p-1.5 align-top">${fmtCell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '');
  const assumptions = (a) => (a && a.length ? `<details class="mt-2 text-[10px] text-slate-500"><summary class="cursor-pointer font-semibold">How this was worked out / assumptions</summary><ul class="list-disc ml-4 mt-1 space-y-0.5">${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '');

  function show(r) {
    if (!r || !r.answer) {
      out().innerHTML = '<div class="text-slate-600">I can answer questions about sales, profit, top products, expenses (and why they changed), overdue customers, low stock, cheapest supplier, cash-flow and sales forecasts, your health score and a daily summary. Try one of the examples above.</div>';
      return;
    }
    out().innerHTML = `<div class="bg-white border border-slate-200 rounded p-3 leading-relaxed">${md(r.answer)}${table(r.table)}${assumptions(r.assumptions)}
      <div class="text-[10px] text-slate-400 mt-1">Books as at ${esc(r.as_of || '')}</div></div>`;
  }

  async function ask(question) {
    const q = (question || $('ins-q').value || '').trim();
    if (!q) return;
    $('ins-q').value = q;
    busy('Looking through your books…');
    try { show(await call('/ask', { method: 'POST', body: JSON.stringify({ question: q }) })); } catch (e) { fail(e); }
  }

  async function summary() {
    busy('Preparing summary…');
    try {
      const s = await call('/summary');
      out().innerHTML = `<div class="bg-white border border-slate-200 rounded p-3 space-y-2">
        <div class="font-bold">Business summary as at ${esc(s.as_of)}</div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 font-mono">
          ${[['Sales today', s.today.sales_excl_tax], ['Sales this month', s.month_to_date.sales_excl_tax], ['Net profit this month', s.month_to_date.net_profit], ['Cash and bank', s.cash.total], ['Overdue receivables', s.receivables_overdue.total], ['Health score', s.health.score === null ? '—' : s.health.score + ' (' + s.health.band + ')']]
            .map(([l, v]) => `<div class="p-2 rounded border border-slate-200 bg-slate-50"><div class="text-[10px] uppercase font-sans text-slate-500">${esc(l)}</div><div class="font-bold">${typeof v === 'number' ? '₹' + fmtCell(v) : esc(v)}</div></div>`).join('')}</div>
        <div class="font-bold pt-1">Recommended actions</div>
        ${s.recommendations.length ? s.recommendations.map((r) => `<div class="border rounded p-2 ${r.priority === 1 ? 'border-red-300 bg-red-50' : r.priority === 2 ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}"><strong>${esc(r.title)}</strong><div class="text-slate-600">${esc(r.because)}</div></div>`).join('') : '<div class="text-emerald-700">Nothing needs attention right now.</div>'}
        ${assumptions(s.assumptions)}</div>`;
    } catch (e) { fail(e); }
  }

  async function health() {
    busy('Scoring…');
    try {
      const h = await call('/health');
      out().innerHTML = `<div class="bg-white border border-slate-200 rounded p-3 space-y-2">
        <div class="text-2xl font-black">${h.score === null ? 'Not enough data' : h.score + ' / 100'} <span class="text-sm font-bold ${h.score >= 60 ? 'text-emerald-700' : h.score >= 40 ? 'text-amber-700' : 'text-red-700'}">${esc(h.band)}</span></div>
        ${table({ columns: ['Component', 'Weight', 'Value', 'Score', 'Why'], rows: h.components.map((c) => [c.label, c.weight, c.value === null ? '—' : c.value + ' ' + c.unit, c.score === null ? 'n/a' : c.score, c.explain]) })}
        <div class="text-[10px] text-slate-500">${esc(h.method)}</div></div>`;
    } catch (e) { fail(e); }
  }

  async function cashflow(scenario) {
    busy('Projecting cash…');
    try {
      const days = $('ins-days').value || 30;
      const f = await call(`/cashflow?days=${encodeURIComponent(days)}${scenario ? '&scenario=' + scenario : ''}`);
      out().innerHTML = `<div class="bg-white border border-slate-200 rounded p-3 space-y-2">
        <div class="font-bold">Cash-flow forecast — next ${f.horizon_days} days (${esc(f.scenario)}), books as at ${esc(f.as_of)}</div>
        <div>Opening <strong>₹${fmtCell(f.opening_balance)}</strong> → closing <strong>₹${fmtCell(f.closing_balance)}</strong>; lowest ₹${fmtCell(f.lowest_point.balance)} around ${esc(f.lowest_point.date)}.</div>
        ${f.warning ? `<div class="text-red-700 font-semibold">⚠️ ${esc(f.warning)}</div>` : ''}
        ${table({ columns: ['Week', 'Cash in (₹)', 'Cash out (₹)', 'Net (₹)', 'Closing (₹)'], rows: f.weeks.map((w) => [w.from + ' → ' + w.to, w.inflow, w.outflow, w.net, w.closing]) })}
        <details><summary class="cursor-pointer font-semibold">What is in each week</summary>${f.weeks.map((w) => `<div class="mt-1"><strong>${esc(w.from)} → ${esc(w.to)}</strong><ul class="list-disc ml-4">${w.items.map((i) => `<li>${i.kind === 'in' ? '＋' : '−'} ₹${fmtCell(i.amount)} ${esc(i.label)} <span class="text-slate-500">(${esc(i.basis)})</span></li>`).join('') || '<li class="text-slate-500">nothing expected</li>'}</ul></div>`).join('')}</details>
        ${f.not_expected.length ? `<div class="text-amber-700">Not counted (over 90 days overdue): ${f.not_expected.map((x) => `${esc(x.party)} ${esc(x.bill)} ₹${fmtCell(x.amount)}`).join('; ')}</div>` : ''}
        <div class="flex gap-2"><button type="button" id="ins-cons" class="px-2 py-0.5 bg-amber-200 hover:bg-amber-300 rounded font-bold">Conservative (collect only 70%)</button><button type="button" id="ins-exp" class="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 rounded font-bold">Expected</button></div>
        ${assumptions(f.assumptions)}</div>`;
      $('ins-cons').addEventListener('click', () => cashflow(0.7)); $('ins-exp').addEventListener('click', () => cashflow(null));
    } catch (e) { fail(e); }
  }

  async function trends(metric) {
    busy('Analysing trend…');
    try {
      const t = await call('/trends?metric=' + metric);
      out().innerHTML = `<div class="bg-white border border-slate-200 rounded p-3 space-y-2">
        <div class="font-bold">${esc(metric.replace('_', ' '))} — last 12 months</div>
        ${table({ columns: ['Month', 'Sales (₹)', 'Expenses (₹)', 'Net profit (₹)'], rows: t.series.map((s) => [s.month + (s.complete ? '' : ' (so far)'), s.sales, s.expenses, s.net_profit]) })}
        ${t.forecast ? `<div>Trend: <strong>${esc(t.trend.direction)}</strong> ₹${fmtCell(Math.abs(t.trend.slope_per_month))}/month (${esc(t.trend.strength)} trend, R² ${t.trend.r_squared}).</div>
          ${table({ columns: ['Month', 'Predicted (₹)', 'Likely low (₹)', 'Likely high (₹)'], rows: t.forecast.map((f) => [f.month, f.predicted, f.low, f.high]) })}` : `<div class="text-amber-700">${esc(t.note)}</div>`}
        ${assumptions(t.assumptions)}</div>`;
    } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------- optional voice input (uses the browser's speech service)
  function voice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { out().innerHTML = '<div class="text-amber-700">Voice input is not available in this window. Type the question instead.</div>'; return; }
    if (!sessionStorage.getItem('ins_voice_ok')) {
      if (!confirm('Voice search sends your spoken question to the browser\'s speech-recognition service (this is the only feature that leaves this computer). Continue?')) return;
      try { sessionStorage.setItem('ins_voice_ok', '1'); } catch (e) {}
    }
    const rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false; rec.maxAlternatives = 1;
    const btn = $('ins-mic'); btn.textContent = '🎙️ Listening…';
    rec.onresult = (ev) => { const text = ev.results[0][0].transcript; $('ins-q').value = text; ask(text); };
    rec.onerror = (ev) => { out().innerHTML = `<div class="text-amber-700">Voice input failed (${esc(ev.error)}). It needs microphone permission and an internet connection; type the question instead.</div>`; };
    rec.onend = () => { btn.textContent = '🎙️ Speak'; };
    try { rec.start(); } catch (e) { btn.textContent = '🎙️ Speak'; }
  }

  function inject() {
    const view = $('view-ratio-analysis');
    if (!view || $('ins-card')) return;
    const host = view.querySelector('.p-6') || view;
    const card = document.createElement('div');
    card.id = 'ins-card';
    card.className = 'border border-slate-300 rounded-lg overflow-hidden text-xs mt-4';
    const examples = ["What are today's total sales?", "What is this month's net profit?", 'Which products are running out of stock?', 'Which customers have overdue payments?', 'Which supplier offers the lowest purchase price?',
      'Show the top 10 selling products', "Compare this month's expenses with last month", 'Why have my expenses increased?', "Predict next month's cash flow"];
    card.innerHTML = `
      <div class="bg-slate-800 text-white font-bold p-2.5">Ask Your Books — Insights, Forecasts &amp; Health Score</div>
      <div class="p-4 space-y-3">
        <form id="ins-form" class="flex flex-wrap items-center gap-2">
          <input id="ins-q" type="text" maxlength="300" placeholder="Ask a question about your business…" class="flex-1 min-w-[16rem] border border-slate-300 rounded p-2 bg-white">
          <button type="submit" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">Ask</button>
          <button type="button" id="ins-mic" class="px-2.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded font-bold">🎙️ Speak</button>
        </form>
        <div class="flex flex-wrap gap-1">${examples.map((x) => `<button type="button" class="ins-ex px-2 py-0.5 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded text-[10px]">${esc(x)}</button>`).join('')}</div>
        <div class="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <button type="button" id="ins-sum" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">Daily summary</button>
          <button type="button" id="ins-health" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Health score</button>
          <button type="button" id="ins-cash" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Cash-flow forecast</button>
          <label class="text-[11px]">days <input id="ins-days" type="number" min="7" max="90" value="30" class="w-14 border border-slate-300 rounded p-1 bg-white"></label>
          <button type="button" id="ins-t-sales" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Sales trend</button>
          <button type="button" id="ins-t-exp" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Expense trend</button>
          <button type="button" id="ins-t-prof" class="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded font-bold">Profit forecast</button>
        </div>
        <div class="text-[10px] text-slate-500">Answers are calculated from your own books with the method and assumptions shown. They never post or change anything, and are not a substitute for professional advice.</div>
        <div id="ins-out"></div>
      </div>`;
    host.appendChild(card);
    $('ins-form').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
    card.querySelectorAll('.ins-ex').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
    $('ins-mic').addEventListener('click', voice); $('ins-sum').addEventListener('click', summary); $('ins-health').addEventListener('click', health);
    $('ins-cash').addEventListener('click', () => cashflow(null));
    $('ins-t-sales').addEventListener('click', () => trends('sales')); $('ins-t-exp').addEventListener('click', () => trends('expenses')); $('ins-t-prof').addEventListener('click', () => trends('net_profit'));
  }

  function boot() {
    if (typeof window.loadRatioAnalysis === 'function' && !window.loadRatioAnalysis.__insHooked) {
      const original = window.loadRatioAnalysis;
      const wrapped = function () { const r = original.apply(this, arguments); inject(); return r; };
      wrapped.__insHooked = true;
      window.loadRatioAnalysis = wrapped;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

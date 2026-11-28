/**
 * RRE Entries — "Aurora" theme behaviour. Visual only: it never changes data, calculations, routes or permissions.
 *   - ambient 3D background with gentle parallax
 *   - collapsible navigation rail with an animated active indicator (calls the existing screens)
 *   - portfolio-style dashboard built from the SAME real data the dashboard already uses
 *   - 3D scroll reveals, depth, tilt, count-up numbers, animated charts
 * Everything switches off outside the Aurora theme, and motion is skipped when the system asks for reduced motion.
 */
(function () {
  'use strict';
  if (window.RREAurora) return;
  const doc = document, html = doc.documentElement;
  const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)'), mqCoarse = window.matchMedia('(pointer: coarse)'); // touch screens get no pointer effects
  const isOn = () => html.getAttribute('data-theme') === 'aurora';
  const motionOn = () => isOn() && !mqReduce.matches;
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const INR_FMT = typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
  const money = (n) => (typeof formatCurrency === 'function' ? formatCurrency(n || 0) : (INR_FMT ? INR_FMT.format(Number(n) || 0) : '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  const compact = (n) => { const a = Math.abs(n), s = n < 0 ? '-' : ''; return a >= 1e7 ? s + (a / 1e7).toFixed(1) + 'Cr' : a >= 1e5 ? s + (a / 1e5).toFixed(1) + 'L' : a >= 1e3 ? s + (a / 1e3).toFixed(0) + 'k' : s + Math.round(a); };
  const icons = (scope) => { try { if (window.lucide) { const root = scope || doc; if (root.querySelector && root.querySelector('[data-lucide]')) window.lucide.createIcons({ root }); } } catch (e) { /* decoration */ } };
  const $ = (s, r) => (r || doc).querySelector(s), $$ = (s, r) => Array.from((r || doc).querySelectorAll(s));
  // in this layout the whole page scrolls (the body grows with its content); fall back to <main> if it ever scrolls by itself
  const scroller = () => { const m = $('main'); return m && m.scrollHeight > m.clientHeight + 4 ? m : (doc.scrollingElement || html); };
  const scrollTopNow = () => (scroller() === (doc.scrollingElement || html) ? window.scrollY : scroller().scrollTop);
  const viewH = () => (scroller() === (doc.scrollingElement || html) ? window.innerHeight : scroller().clientHeight);
  const persistSetting = (k, v) => {
    try {
      fetch(base() + '/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [k]: String(v) })
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  };
  const store = {
    get: (k) => { try { return ((window.__RRE_SETTINGS && window.__RRE_SETTINGS[k] != null) ? String(window.__RRE_SETTINGS[k]) : null) || localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); window.__RRE_SETTINGS = window.__RRE_SETTINGS || {}; window.__RRE_SETTINGS[k] = String(v); } catch (e) { /* ignore */ } persistSetting(k, v); }
  };

  // ------------------------------------------------------------------ motion switch
  function syncMotion() { html.classList.toggle('au-motion', motionOn()); }

  // ------------------------------------------------------------------ ambient background
  let bgEls = null;
  function ambient() {
    if ($('#aurora-bg')) return;
    const bg = doc.createElement('div'); bg.id = 'aurora-bg'; bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="grid"></div>';
    doc.body.insertBefore(bg, doc.body.firstChild);
    bgEls = { b: $$('.blob', bg), g: $('.grid', bg) };
  }

  // ------------------------------------------------------------------ navigation rail
  const openDash = () => { if (typeof showView === 'function') { showView('view-dashboard'); if (typeof loadDashboard === 'function') loadDashboard(); } };
  const ITEMS = [
    ['Gateway', 'compass', () => showGateway(), ['view-gateway', 'view-display-more']],
    ['Dashboard', 'layout-dashboard', openDash, ['view-dashboard']],
    ['Vouchers', 'receipt', () => openVoucherScreen('Sales'), ['view-voucher']],    ['Day Book', 'book-open', () => openReport('daybook'), ['view-daybook']],
    ['Ledgers & Accounts', 'landmark', () => openReport('chart-accounts'), ['view-chart-accounts']],
    ['Financial Statements', 'scale', () => openReport('balance-sheet'), ['view-balance-sheet', 'view-profit-loss', 'view-trial-balance', 'view-ratio-analysis']],
    ['Sales & Reports', 'bar-chart-3', () => (typeof openReportCenter === 'function' ? openReportCenter() : openReport('outstandings')), ['view-report-center', 'view-outstandings']],
    ['Stock Summary', 'package', () => openReport('stock-summary'), ['view-stock-summary']],
    ['Banking', 'wallet', () => openReport('bank-recon'), ['view-bank-recon']],
    ['GST', 'percent', () => openReport('gst'), ['view-gst']],
    ['Quotations', 'file-text', () => (typeof openQuotations === 'function' ? openQuotations() : null), ['view-quotations', 'view-quotation-editor']],
    ['sep'],
    ['RRE Inventory', 'boxes', () => (window.RREInventoryGo ? window.RREInventoryGo('/admin') : null), ['__inventory'], 'inv']
  ];
  // Inventory lives in the rail only: its features open from this list (the screens themselves are the original inventory application)
  const INV_SUB = [['Dashboard', '/admin'], ['Low stock alerts', '/alerts'], ['Items', '/products'], ['Stock levels', '/inventory'], ['Movement history', '/movements'], ['Warehouses', '/warehouses'], ['Transfers', '/transfers'], ['Adjustments', '/adjustments'],
    ['Customers', '/customers'], ['Sales Orders', '/sales-orders'], ['Sales history', '/sales-history'], ['Suppliers', '/vendors'], ['Purchase Orders', '/purchase-orders'], ['Purchase history', '/purchase-history'], ['Categories', '/categories'], ['Units', '/units'], ['Reports', '/reports']];
  const railItem = (it, i) => {
    if (it[0] === 'sep') return '<div class="sep"></div>';
    const inv = it[4] === 'inv';
    return `<button type="button" class="item ${it[4] || ''}" data-i="${i}" title="${esc(it[0])}"${inv ? ' aria-expanded="false" aria-controls="au-inv-sub"' : ''}><i data-lucide="${it[1]}"></i><span class="lbl">${esc(it[0])}</span>${inv ? '<i class="chev" data-lucide="chevron-right"></i>' : ''}</button>`
      + (inv ? `<div class="sub" id="au-inv-sub" role="group" aria-label="RRE Inventory features">${INV_SUB.map((s) => `<button type="button" data-path="${esc(s[1])}">${esc(s[0])}</button>`).join('')}</div>` : '');
  };
  function toggleInvMenu(force) {
    const b = $('#au-rail button.item.inv'), sub = $('#au-inv-sub'); if (!b || !sub) return;
    const open = force == null ? !sub.classList.contains('open') : force;
    if (open && !doc.body.classList.contains('au-rail-open')) { doc.body.classList.add('au-rail-open'); store.set('au_rail_open', '1'); }
    sub.classList.toggle('open', open); b.classList.toggle('open', open); b.setAttribute('aria-expanded', open ? 'true' : 'false'); setTimeout(moveInd, 60); setTimeout(moveInd, 400);
  }
  let railEl = null;
  function rail() {
    if (railEl) return;
    railEl = doc.createElement('nav'); railEl.id = 'au-rail'; railEl.setAttribute('aria-label', 'Main navigation');
    const logo = 'rre_icon.png';
    railEl.innerHTML = `<div class="brand"><img src="${logo}" alt=""><span class="lbl">RRE Entries</span></div><div class="au-collapse-row"><button type="button" class="au-collapse" data-act="collapse" title="Collapse / expand the menu" aria-label="Collapse or expand the menu"><i data-lucide="panel-left-close" class="when-open"></i><i data-lucide="panel-left-open" class="when-closed"></i><span class="lbl">Collapse</span></button></div><div class="nav"><div class="ind"></div>${ITEMS.map(railItem).join('')}</div>
      <div class="foot"><button type="button" class="item rre-auth-only" data-act="users" title="Users & security"><i data-lucide="users"></i><span class="lbl">Users</span></button><button type="button" class="item" data-act="theme" title="Theme (Alt+T)"><i data-lucide="palette"></i><span class="lbl">Theme</span></button></div>`;
    doc.body.appendChild(railEl);
    if (store.get('au_rail_open') === '1') doc.body.classList.add('au-rail-open');
    // the toggle says what it will do (screen readers); the icon itself follows body.au-rail-open in CSS
    const syncCollapse = () => { const c = $('.au-collapse', railEl); if (c) c.setAttribute('aria-expanded', doc.body.classList.contains('au-rail-open') ? 'true' : 'false'); };
    syncCollapse(); new MutationObserver(syncCollapse).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    railEl.addEventListener('click', (e) => {
      const sb = e.target.closest('.sub button[data-path]'); if (sb) { try { window.RREInventoryGo(sb.dataset.path); } catch (err) { /* ignore */ } return; }
      if (e.target.closest('.au-collapse')) { doc.body.classList.toggle('au-rail-open'); store.set('au_rail_open', doc.body.classList.contains('au-rail-open') ? '1' : '0'); syncCollapse(); setTimeout(moveInd, 380); return; }
      const b = e.target.closest('button.item'); if (!b) return;
      if (b.classList.contains('inv')) { const wasOpen = $('#au-inv-sub').classList.contains('open'); toggleInvMenu(); if (!wasOpen || !(window.RREInventory && window.RREInventory.isOpen && window.RREInventory.isOpen())) { try { window.RREInventoryGo('/admin'); } catch (err) { /* ignore */ } } return; }
      if (b.dataset.act === 'collapse') { doc.body.classList.toggle('au-rail-open'); store.set('au_rail_open', doc.body.classList.contains('au-rail-open') ? '1' : '0'); setTimeout(moveInd, 380); return; }
      if (b.dataset.act === 'users') { if (window.__RRE_AUTH_ENABLED === true && typeof openUserManagement === 'function') openUserManagement(); return; }
      if (b.dataset.act === 'theme') { if (typeof openThemeSelectorModal === 'function') openThemeSelectorModal(); return; }
      const it = ITEMS[+b.dataset.i]; if (window.RREInventory) window.RREInventory.close(); try { it[2](); } catch (err) { console.warn('[Aurora] navigation:', err.message); }
    });
    icons(railEl); moveInd();
  }
  // phones: the same destinations as a bottom tab bar
  const TABS = ['Gateway', 'Dashboard', 'Vouchers', 'Sales & Reports', 'RRE Inventory'];
  let tabEl = null;
  function tabbar() {
    if (tabEl) return;
    tabEl = doc.createElement('nav'); tabEl.id = 'au-tabbar'; tabEl.setAttribute('aria-label', 'Quick navigation');
    tabEl.innerHTML = TABS.map((t) => { const i = ITEMS.findIndex((x) => x[0] === t), it = ITEMS[i]; return `<button type="button" data-i="${i}" class="${it[4] || ''}"><i data-lucide="${it[1]}"></i><span>${esc(t.replace('Sales & Reports', 'Reports'))}</span></button>`; }).join('');
    doc.body.appendChild(tabEl);
    tabEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { if (!b.classList.contains('inv') && window.RREInventory) window.RREInventory.close(); try { ITEMS[+b.dataset.i][2](); } catch (err) { /* ignore */ } } });
    icons(tabEl);
  }
  function activeIndex() {
    if ((window.RREInventory && window.RREInventory.isOpen && window.RREInventory.isOpen())) return ITEMS.findIndex((x) => x[3] && x[3][0] === '__inventory');
    const cur = (typeof appState !== 'undefined' && appState.currentView) || '';
    return ITEMS.findIndex((x) => x[3] && x[3].includes(cur));
  }
  function moveInd() {
    if (!railEl) return; const ind = $('.ind', railEl), i = activeIndex(); $$('button.item', railEl).forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
    if (tabEl) $$('button', tabEl).forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
    const btn = i >= 0 ? $(`button.item[data-i="${i}"]`, railEl) : null;
    if (!btn) { ind.style.opacity = 0; return; }
    ind.style.opacity = 1; ind.style.height = btn.offsetHeight + 'px'; ind.style.transform = `translateY(${btn.offsetTop}px)`;
  }

  // ------------------------------------------------------------------ reveal / depth / tilt
  let io = null;
  function observe(scope) {
    const els = $$('.au-reveal:not(.is-in), .au-chart:not(.is-in), .au-donut:not(.is-in), .au-bar-row:not(.is-in)', scope || doc);
    if (!motionOn() || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-in')); return; }
    if (!io) io = new IntersectionObserver((entries) => { entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); if (en.target.classList.contains('au-chart')) drawLines(en.target); } }); }, { root: null, threshold: .12, rootMargin: '0px 0px -6% 0px' });
    els.forEach((e) => io.observe(e));
  }
  let ticking = false;
  function onScroll() { if (ticking || !motionOn()) return; ticking = true; requestAnimationFrame(update); }
  function update() {
    ticking = false; const top = scrollTopNow(), vh = viewH(), mid = vh / 2;
    const hero = $('#au-hero'); if (hero) { const k = Math.min(1, top / 520); hero.style.setProperty('--hk', k.toFixed(3)); hero.style.opacity = String(1 - k * .55); }
  }
  function tilt() {
    let cur = null;
    doc.addEventListener('pointermove', (e) => {
      if (!motionOn() || mqCoarse.matches || e.pointerType === 'touch') return;
      const t = e.target.closest && e.target.closest('.au-tilt');
      if (cur && cur !== t) { cur.classList.remove('au-tilting'); cur.style.removeProperty('--rx'); cur.style.removeProperty('--ry'); }
      cur = t; if (!t) return;
      const r = t.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      t.classList.add('au-tilting'); t.style.setProperty('--ry', ((x - .5) * 12).toFixed(2) + 'deg'); t.style.setProperty('--rx', ((.5 - y) * 10).toFixed(2) + 'deg'); t.style.setProperty('--mx', (x * 100).toFixed(0) + '%'); t.style.setProperty('--my', (y * 100).toFixed(0) + '%');
    }, { passive: true });
    doc.addEventListener('pointerleave', () => { if (cur) { cur.classList.remove('au-tilting'); cur = null; } }, true);
  }
  const countJobs = new Map();
  let countRaf = 0;
  function stepCounts(t) {
    countRaf = 0;
    const ease = (p) => (p === 1 ? 1 : 1 - Math.pow(1 - p, 3));
    for (const [el, j] of countJobs) {
      if (!el.isConnected) { countJobs.delete(el); continue; }
      const p = Math.min(1, (t - j.t0) / j.dur);
      const val = p < 1 ? j.from + (j.to - j.from) * ease(p) : j.to;
      el.textContent = j.fmt(val);
      if (p >= 1) { el._auVal = j.to; countJobs.delete(el); }
    }
    if (countJobs.size) countRaf = requestAnimationFrame(stepCounts);
  }
  function countUp(el, to, fmt) {
    if (!el) return;
    const target = Number(to) || 0;
    if (!motionOn() || el._auVal === target) { el._auVal = target; el.textContent = fmt(target); return; }
    const from = typeof el._auVal === 'number' ? el._auVal : 0;
    countJobs.set(el, { from, to: target, fmt, t0: performance.now(), dur: 380 });
    if (!countRaf) countRaf = requestAnimationFrame(stepCounts);
  }

  // ------------------------------------------------------------------ charts (inline SVG, no library)
  // smooth curve whose handles never leave the band between neighbouring values, so it cannot swing past the data (no dips below zero)
  function smooth(pts) { if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ''; let d = `M${pts[0][0]},${pts[0][1]}`; const cl = (v, a, b) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v)); for (let i = 0; i < pts.length - 1; i++) { const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2; d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${cl(p1[1] + (p2[1] - p0[1]) / 6, p1[1], p2[1]).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${cl(p2[1] - (p3[1] - p1[1]) / 6, p1[1], p2[1]).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`; } return d; }
  function drawLines(svg) { $$('.line', svg).forEach((p) => { try { p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 'px'); } catch (e) { /* ignore */ } }); }
  function lineChart(series, defs) {
    const W = 640, H = 230, L = 48, R = 14, T = 12, B = 26, max = Math.max(1, ...series.flatMap((s) => defs.map((d) => s[d.k] || 0))), min = Math.min(0, ...series.flatMap((s) => defs.map((d) => s[d.k] || 0)));
    const x = (i) => L + (series.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (series.length - 1)), y = (v) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
    const grid = [0, 1, 2, 3].map((i) => { const v = min + ((max - min) * i) / 3; return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${compact(v)}</text>`; }).join('');
    const xl = series.map((s, i) => (series.length > 8 && i % 2 ? '' : `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(s.label)}</text>`)).join('');
    const body = defs.map((d, di) => { const pts = series.map((s, i) => [x(i), y(s[d.k] || 0)]), line = smooth(pts), area = line + ` L${pts[pts.length - 1][0].toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} L${pts[0][0].toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} Z`;
      return `<defs><linearGradient id="agr${di}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${d.c}" stop-opacity=".42"/><stop offset="1" stop-color="${d.c}" stop-opacity="0"/></linearGradient></defs><path class="area" d="${area}" fill="url(#agr${di})"/><path class="line" d="${line}" fill="none" stroke="${d.c}" stroke-width="2.6" stroke-linecap="round"/>${pts.map((p, i) => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${series[i][d.k] ? 3.4 : 0}" fill="${d.c}" stroke="var(--au-surface)" stroke-width="1.5"><title>${esc(series[i].label)}: ${money(series[i][d.k] || 0)}</title></circle>`).join('')}`; }).join('');
    return `<svg class="au-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Chart"><g class="grid">${grid}</g>${xl}${body}</svg>`;
  }
  function barChart(series, key, pos, neg) {
    const W = 300, H = 160, L = 4, B = 20, max = Math.max(1, ...series.map((s) => Math.abs(s[key] || 0))), mid = (H - B) / 2 + 6, bw = Math.max(6, ((W - L * 2) / series.length) * .56);
    return `<svg class="au-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart"><g class="grid"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}"/></g>${series.map((s, i) => { const v = s[key] || 0, h = (Math.abs(v) / max) * ((H - B) / 2 - 6), x = L + (i + .5) * ((W - L * 2) / series.length) - bw / 2; return `<rect class="bar" style="--bd:${(i * .06).toFixed(2)}s" x="${x.toFixed(1)}" y="${(v >= 0 ? mid - h : mid).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="3" fill="${v >= 0 ? pos : neg}"><title>${esc(s.label)}: ${money(v)}</title></rect><text x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(s.label)}</text>`; }).join('')}</svg>`;
  }
  function donut(parts) {
    const total = parts.reduce((t, p) => t + p.v, 0) || 1, C = 2 * Math.PI * 54; let acc = 0;
    return `<svg class="au-donut" viewBox="0 0 150 150" role="img" aria-label="Expense mix"><circle cx="75" cy="75" r="54" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="16"/>${parts.map((p) => { const len = (p.v / total) * C, s = `<circle class="seg" cx="75" cy="75" r="54" stroke="${p.c}" style="--d:${Math.max(0, len - 2).toFixed(1)}px" stroke-dashoffset="${(-acc).toFixed(1)}"><title>${esc(p.l)}: ${money(p.v)}</title></circle>`; acc += len; return s; }).join('')}<text x="75" y="73">${compact(total)}</text><text class="s" x="75" y="88">TOTAL SPEND</text></svg>`;
  }

  // ------------------------------------------------------------------ the portfolio dashboard (real data)
  const get = async (p) => { try { const r = await fetch(base() + p); if (!r.ok) return null; const j = await r.json(); return j && j.success === false ? null : (j.data !== undefined ? j.data : j); } catch (e) { return null; } };
  let portfolioEl = null;
  function buildPortfolio() {
    const v = $('#view-dashboard'); if (!v || portfolioEl) return;
    portfolioEl = doc.createElement('div'); portfolioEl.id = 'au-portfolio';
    portfolioEl.innerHTML = `
      <section class="au-hero" id="au-hero"><div data-speed="-0.05">
        <span class="au-eyebrow"><i></i>Live business overview</span>
        <h1>Welcome back to <span id="au-co">your business</span></h1>
        <p class="au-lead">Your sales, spending, profit and stock in one place, straight from your books and updated as you work.</p>
        <div class="au-cta"><button type="button" class="au-btn primary" data-act="voucher"><i data-lucide="plus"></i>New voucher</button><button type="button" class="au-btn" data-act="reports"><i data-lucide="bar-chart-3"></i>Reports</button></div>
      </div><div class="au-stage" data-speed="0.07">
        <div class="au-float f2" data-go="outstandings" role="button" tabindex="0"><small>Cash &amp; bank</small><b id="au-f-cash">—</b></div><div class="au-float f3" data-go="stock-summary" role="button" tabindex="0"><small>Inventory value</small><b id="au-f-stock">—</b></div></div></section>
      <div class="au-sec-title">Business overview</div>
      <div class="au-stats" id="au-stats"></div>
      <div class="au-sec-title">Analytics</div>
      <div class="au-grid2"><div class="au-panel au-reveal au-depth"><h3><i data-lucide="trending-up"></i>Revenue &amp; expenses</h3><div class="hint">Month by month, from your vouchers</div><div id="au-rev"></div></div>
        <div class="au-panel au-reveal au-depth" style="--au-d:.08s"><h3><i data-lucide="pie-chart"></i>Where the money goes</h3><div class="hint">Spending in the current period</div><div id="au-mix"></div></div></div>
      <div class="au-grid4" style="margin-top:16px"><div class="au-panel au-reveal au-depth"><h3><i data-lucide="line-chart"></i>Profit by month</h3><div class="hint">Net profit, green is a gain</div><div id="au-profit"></div></div>
        <div class="au-panel au-reveal au-depth" style="--au-d:.06s"><h3><i data-lucide="package"></i>RRE Inventory analytics</h3><div class="hint">Highest stock value</div><div id="au-inv"></div></div>
        <div class="au-panel au-reveal au-depth" style="--au-d:.12s"><h3><i data-lucide="arrow-left-right"></i>Cash flow</h3><div class="hint">Money in and out</div><div id="au-cash"></div></div>
        <div class="au-panel au-reveal au-depth" style="--au-d:.18s"><h3><i data-lucide="activity"></i>Growth indicators</h3><div class="hint">Margins and balance</div><div id="au-growth"></div></div></div>
      <div class="au-sec-title">Activity</div>
      <div class="au-grid2e"><div class="au-panel au-reveal au-depth"><h3><i data-lucide="clock"></i>Recent transactions</h3><ul class="au-list" id="au-act-all"></ul></div><div class="au-panel au-reveal au-depth" style="--au-d:.06s"><h3><i data-lucide="shopping-cart"></i>Sales activity</h3><ul class="au-list" id="au-act-sales"></ul></div>
        <div class="au-panel au-reveal au-depth" style="--au-d:.12s"><h3><i data-lucide="truck"></i>Purchase activity</h3><ul class="au-list" id="au-act-purch"></ul></div><div class="au-panel au-reveal au-depth" style="--au-d:.18s"><h3><i data-lucide="boxes"></i>Stock updates</h3><ul class="au-list" id="au-act-stock"></ul></div></div>
      <div class="au-sec-title au-detail-title">Detailed books</div>`;
    v.insertBefore(portfolioEl, v.firstChild);
    portfolioEl.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'), g = e.target.closest('[data-go]');
      if (a) { try { ({ voucher: () => openVoucherScreen('Sales'), reports: () => (typeof openReportCenter === 'function' ? openReportCenter() : openReport('profit-loss')), inventory: () => window.RREInventoryGo && window.RREInventoryGo('/admin') })[a.dataset.act](); } catch (err) { /* ignore */ } return; }
      if (g) { try { openReport(g.dataset.go); } catch (err) { /* ignore */ } }
    });
    portfolioEl.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-go]')) { e.preventDefault(); e.target.click(); } });
    icons(portfolioEl);
  }
  const when = (d) => { try { const x = new Date(String(d).replace(' ', 'T')); return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch (e) { return d || ''; } };
  const monthLabel = (m) => { const [y, mm] = String(m).split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(+mm || 1) - 1] || m; };
  const typeChip = (t) => (/^Sales|Credit Note|Receipt/.test(t) ? ['sales', t] : /^Purchase|Debit Note|Payment/.test(t) ? ['purchase', t] : /Stock/.test(t) ? ['stock', 'Stock'] : ['other', t]);
  const li = (v) => { const [c, l] = typeChip(v.voucher_type); const name = v.party_name || v.narration || v.voucher_no; return `<li><span class="au-chip ${c}">${esc(l)}</span><span class="who"><b title="${esc(name)}">${esc(name)}</b><span class="when">${esc(v.voucher_no)} · ${esc(when(v.date))}</span></span><span class="amt">${v.total_amount ? money(v.total_amount) : ''}</span></li>`; };
  const empty = (t) => `<div class="au-empty">${esc(t)}</div>`;
  let renderSeq = 0;

  async function renderPortfolio() {
    if (!isOn()) return; buildPortfolio(); if (!portfolioEl) return; const seq = ++renderSeq;
    const co = $('#top-company-name'); if (co && $('#au-co')) $('#au-co').textContent = co.textContent.trim() || 'your business';
    const per = typeof reportPeriod === 'function' ? reportPeriod() : null, pq = per ? `?from=${per.from}&date=${per.to}` : ''; // the reporting period (F2), as the reports use
    const [tiles, pl, tr, vch] = await Promise.all([get('/dashboard/tiles' + pq), get('/reports/profit-loss' + pq), get('/insights/trends'), get('/vouchers?limit=500')]);
    if (seq !== renderSeq) return;
    const t = pl && pl.trading, ind = pl && pl.indirect;
    const sales = t ? t.sales || 0 : null, purchases = t ? t.purchases || 0 : null, revenue = t ? (t.sales || 0) + (t.direct_incomes || 0) + ((ind && ind.indirect_incomes) || 0) : null;
    const expenses = t ? (t.purchases || 0) + (t.direct_expenses || 0) + ((ind && ind.indirect_expenses) || 0) : null;
    const net = ind ? ind.net_profit : tiles ? tiles.profit_loss_tile.net_profit : null, stock = tiles ? tiles.stock_tile.total_valuation : null, cash = tiles ? tiles.funds_flow_tile.cash_bank_balance : null;
    // the financial summary (same ledger balances as the reports; gross profit = sales - cost of goods sold; quotations are not counted)
    const f = (tiles && tiles.financials) || {}, fv = (k) => (tiles && tiles.financials ? f[k] : null), sign = (v) => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
    const gstDue = fv('gst_payable');
    const stats = [['Total sales', sales, 'shopping-cart', 'profit-loss', 'Sold in this period', ''], ['Total purchases', purchases, 'shopping-bag', 'daybook', 'Bought in this period', ''], ['Gross profit', fv('gross_profit'), 'trending-up', 'profit-loss', 'Sales less cost of goods sold', sign(fv('gross_profit'))],
      ['Cost of goods sold', fv('cost_of_goods_sold'), 'package-minus', 'stock-summary', 'Opening stock + purchases − closing stock', ''], ['Operating expenses', fv('operating_expenses'), 'receipt', 'profit-loss', 'Indirect expenses', ''], [net != null && net < 0 ? 'Net loss' : 'Net profit', net, 'sparkles', 'profit-loss', 'After all expenses', sign(net)],
      ['Total revenue', revenue, 'badge-indian-rupee', 'profit-loss', 'Sales and other income', ''], ['Total expenses', expenses, 'credit-card', 'profit-loss', 'Purchases and running costs', ''], ['Inventory value', stock, 'boxes', 'stock-summary', tiles ? tiles.stock_tile.item_count + ' items in stock' : '', ''],
      ['Receivables', fv('receivables'), 'arrow-down-left', 'outstandings', 'Customers owe you', ''], ['Payables', fv('payables'), 'arrow-up-right', 'outstandings', 'You owe suppliers', ''], ['Cash balance', fv('cash_balance'), 'wallet', 'daybook', 'Cash in hand', ''],
      ['Bank balance', fv('bank_balance'), 'landmark', 'bank-recon', 'All bank accounts', ''], [gstDue != null && gstDue < 0 ? 'GST credit carried' : 'GST payable', gstDue == null ? null : Math.abs(gstDue), 'percent', 'gst', 'Output GST less input credit', ''], ['GST input credit', fv('gst_input_credit'), 'badge-percent', 'gst', 'GST paid on purchases', '']];
    const sEl = $('#au-stats');
    if (!sEl.children.length) {
      sEl.innerHTML = stats.map((s, i) => `<div class="au-stat au-tilt au-reveal ${s[5]}" style="--au-d:${(i * .03).toFixed(2)}s" data-go="${s[3]}" role="button" tabindex="0"><div class="ico"><i data-lucide="${s[2]}"></i></div><small>${s[0]}</small><div class="val" data-i="${i}">—</div><div class="sub">${esc(s[4])}</div></div>`).join(''); icons(sEl); observe(sEl);
    }
    stats.forEach((s, i) => { const el = $(`.val[data-i="${i}"]`, sEl), card = el && el.closest('.au-stat'); if (!el) return; card.classList.remove('pos', 'neg'); if (s[5]) card.classList.add(s[5]); const lab = card.querySelector('small'); if (lab && lab.textContent !== s[0]) lab.textContent = s[0]; if (s[1] == null) { el.textContent = 'Not available'; el.title = 'Financial figures need permission to view'; } else countUp(el, s[1], money); const sub = $('.sub', card); if (sub) sub.textContent = s[4]; });
    if (cash != null) countUp($('#au-f-cash'), cash, money); if (stock != null) countUp($('#au-f-stock'), stock, money);
    // revenue & expenses by month
    let series = ((tr && tr.series) || []).map((s) => ({ ...s, label: monthLabel(s.month) })), fromVouchers = false;
    if (!series.length && Array.isArray(vch)) { // the insights module is not available (no sign-in): use the vouchers themselves
      const m = new Map(); const now = new Date(); for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1), k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); m.set(k, { month: k, label: monthLabel(k), sales: 0, expenses: 0, net_profit: 0, complete: i > 0 }); }
      vch.forEach((x) => { const e = m.get(String(x.date).slice(0, 7)); if (!e) return; const a = x.total_amount || 0; if (x.voucher_type === 'Sales') e.sales += a; else if (x.voucher_type === 'Credit Note') e.sales -= a; else if (x.voucher_type === 'Purchase') e.expenses += a; else if (x.voucher_type === 'Debit Note') e.expenses -= a; });
      series = [...m.values()].map((e) => ({ ...e, net_profit: e.sales - e.expenses })); fromVouchers = true;
    }
    const has = series.some((s) => s.sales || s.expenses), l2 = fromVouchers ? 'Purchases' : 'Expenses';
    $('#au-rev').innerHTML = has ? lineChart(series, [{ k: 'sales', c: '#22d3ee' }, { k: 'expenses', c: '#a78bfa' }]) + `<div class="au-legend"><span><i style="background:#22d3ee"></i>Sales</span><span><i style="background:#a78bfa"></i>${l2}</span></div>` : empty('No monthly activity yet. It appears as soon as vouchers are posted.');
    $('#au-profit').innerHTML = has ? barChart(series.slice(-8), 'net_profit', '#34d399', '#fb7185') : empty('No profit data yet.');
    const ph = $('#au-profit') && $('#au-profit').previousElementSibling; if (ph) ph.textContent = fromVouchers ? 'Sales less purchases, green is a gain' : 'Net profit, green is a gain';
    const pt = $('#au-profit') && $('#au-profit').parentElement.querySelector('h3'); if (pt) pt.lastChild.textContent = fromVouchers ? 'Sales less purchases' : 'Profit by month';
    // spending mix
    const mix = t ? [{ l: 'Purchases', v: t.purchases || 0, c: '#4f6bff' }, { l: 'Direct expenses', v: t.direct_expenses || 0, c: '#22d3ee' }, ...((ind && ind.indirect_expense_items) || []).slice(0, 3).map((x, i) => ({ l: x.name, v: Math.abs(x.net_debit || x.closing_balance || 0), c: ['#a78bfa', '#f472b6', '#fbbf24'][i] }))].filter((p) => p.v > 0) : [];
    $('#au-mix').innerHTML = mix.length ? `<div class="au-donut-wrap">${donut(mix)}<div class="au-legend" style="flex-direction:column;gap:7px">${mix.map((p) => `<span><i style="background:${p.c}"></i>${esc(p.l)} <b style="color:var(--au-strong);margin-left:6px">${money(p.v)}</b></span>`).join('')}</div></div>` : empty('No spending recorded yet.');
    // inventory analytics
    const items = tiles ? (tiles.stock_tile.top_items || []).map((i) => ({ n: i.name, v: i.closing_val || 0, q: `${i.closing_qty} ${i.uom_symbol || ''}` })).sort((a, b) => b.v - a.v).slice(0, 6) : [], mx = Math.max(1, ...items.map((i) => i.v));
    $('#au-inv').innerHTML = items.length ? `<div class="au-bars">${items.map((i) => `<div class="au-bar-row"><span title="${esc(i.n)}">${esc(i.n)}</span><b>${compact(i.v)}</b><div class="t"><i style="--w:${Math.max(3, (i.v / mx) * 100).toFixed(1)}%"></i></div></div>`).join('')}</div>` : empty('No stock items yet.');
    const ff = tiles && tiles.funds_flow_tile; $('#au-cash').innerHTML = ff ? `<div class="au-bars">${[['Money in', ff.inflow || 0, '#34d399'], ['Money out', ff.outflow || 0, '#fb7185']].map((r) => `<div class="au-bar-row"><span>${r[0]}</span><b>${money(r[1])}</b><div class="t"><i style="--w:${Math.max(3, (r[1] / Math.max(1, ff.inflow || 0, ff.outflow || 0)) * 100).toFixed(1)}%;background:${r[2]}"></i></div></div>`).join('')}</div><div class="au-legend"><span>Net flow <b style="color:${(ff.net_flow || 0) >= 0 ? 'var(--au-pos)' : 'var(--au-neg)'};margin-left:6px">${money(ff.net_flow || 0)}</b></span></div>` : empty('Cash figures need permission to view.');
    // growth indicators
    const gp = t ? t.gross_profit : null, gm = sales ? (gp / sales) * 100 : null, nm = sales ? (net / sales) * 100 : null, done = series.filter((s) => s.complete), cur = done[done.length - 1], prev = done[done.length - 2], gr = cur && prev && prev.sales ? ((cur.sales - prev.sales) / prev.sales) * 100 : null;
    const row = (l, v, c) => `<div class="au-bar-row"><span>${l}</span><b style="color:${c || 'var(--au-strong)'}">${v}</b><div class="t"><i style="--w:${v === '—' ? 0 : Math.min(100, Math.max(3, Math.abs(parseFloat(v)))).toFixed(1)}%"></i></div></div>`;
    $('#au-growth').innerHTML = tiles || pl ? `<div class="au-bars">${row('Gross margin', gm == null ? '—' : gm.toFixed(1) + '%')}${row('Net margin', nm == null ? '—' : nm.toFixed(1) + '%', nm != null && nm < 0 ? 'var(--au-neg)' : '')}${row('Sales vs last month', gr == null ? '—' : (gr >= 0 ? '+' : '') + gr.toFixed(1) + '%', gr != null && gr < 0 ? 'var(--au-neg)' : 'var(--au-pos)')}</div><div class="au-legend"><span>Receivables ${tiles ? money(tiles.debtors_tile.total) : '—'}</span><span>Payables ${tiles ? money(tiles.creditors_tile.total) : '—'}</span></div>` : empty('Growth figures need permission to view.');
    // activity
    const list = Array.isArray(vch) ? vch : [], by = (re, n) => list.filter((x) => re.test(x.voucher_type)).slice(0, n);
    const gr0 = gr; void gr0;
    $('#au-act-all').innerHTML = list.slice(0, 7).map(li).join('') || empty('No transactions yet.'); $('#au-act-sales').innerHTML = by(/^Sales|Credit Note/, 6).map(li).join('') || empty('No sales yet.');
    $('#au-act-purch').innerHTML = by(/^Purchase|Debit Note/, 6).map(li).join('') || empty('No purchases yet.'); $('#au-act-stock').innerHTML = by(/Stock/, 6).map(li).join('') || empty('No stock updates yet.');
    icons(portfolioEl); observe(portfolioEl); $$('.au-chart', portfolioEl).forEach(drawLines); update();
  }

  // ------------------------------------------------------------------ hooks into the existing app (wrap, never replace)
  function wrap(name, after) {
    const f = window[name]; if (typeof f !== 'function' || f.__auWrapped) return;
    const w = function () { const r = f.apply(this, arguments); try { after.apply(this, arguments); } catch (e) { console.warn('[Aurora]', e.message); } return r; };
    w.__auWrapped = true; window[name] = w;
  }
  function onView(id) {
    if (window.RREInventory) window.RREInventory.close(); // any RRE screen replaces the inventory area
    moveInd(); if (scrollTopNow() > 2) window.scrollTo(0, 0); const m = $('main'); if (m && m.scrollTop > 2) m.scrollTop = 0;
    const el = id && doc.getElementById(id); if (el && motionOn()) { el.classList.remove('au-enter'); requestAnimationFrame(() => el.classList.add('au-enter')); }
    if (id === 'view-dashboard') { buildPortfolio(); observe(portfolioEl); }
  }
  // ------------------------------------------------------------------ Light (white) / Dark mode
  const modeNow = () => (store.get('au_mode') === 'dark' ? 'dark' : 'light'); // white by default
  function applyMode() { if (isOn()) html.setAttribute('data-au', modeNow()); else html.removeAttribute('data-au'); syncToggle(); }
  function syncToggle() { const t = $('#au-mode'); if (!t) return; $$('button', t).forEach((b) => { const on = isOn() && b.dataset.m === modeNow(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
  function setMode(m) {
    store.set('au_mode', m === 'dark' ? 'dark' : 'light');
    if (!isOn() && typeof applyTheme === 'function') applyTheme('aurora', false); // choosing Light / Dark from another theme brings Aurora with it
    applyMode(); doc.dispatchEvent(new CustomEvent('rre-mode', { detail: modeNow() }));
  }
  function modeToggle() {
    if ($('#au-mode')) return;
    const anchor = $('#btn-top-theme'); if (!anchor || !anchor.parentElement) return;
    const t = doc.createElement('div'); t.id = 'au-mode'; t.setAttribute('role', 'group'); t.setAttribute('aria-label', 'Colour mode');
    t.innerHTML = '<button type="button" data-m="light" title="White theme"><i data-lucide="sun"></i><span>Light</span></button><button type="button" data-m="dark" title="Dark theme"><i data-lucide="moon"></i><span>Dark</span></button>';
    anchor.parentElement.insertBefore(t, anchor);
    t.addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (b) setMode(b.dataset.m); });
    icons(t); syncToggle();
  }
  function enable() {
    applyMode(); syncMotion(); modeToggle(); if (!isOn()) return; ambient(); rail(); tabbar(); buildPortfolio(); if (portfolioEl) observe(portfolioEl); moveInd();
  }
  function install() {
    wrap('showView', onView); wrap('loadDashboard', () => { renderPortfolio(); });
    new MutationObserver(enable).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    mqReduce.addEventListener && mqReduce.addEventListener('change', () => { syncMotion(); observe(portfolioEl); });
    window.addEventListener('scroll', onScroll, { passive: true }); const mn = $('main'); if (mn) mn.addEventListener('scroll', onScroll, { passive: true });
    enable();
    // the rail highlight follows RRE Inventory opening / closing (an observer on its screen, instead of measuring every 0.7 s forever)
    const watchInv = () => { const el = doc.getElementById('sp-app'); if (el && !el.__auWatch) { el.__auWatch = true; new MutationObserver(() => { if (isOn()) moveInd(); }).observe(el, { attributes: true, attributeFilter: ['class'] }); } };
    doc.addEventListener('rre-inventory', () => { watchInv(); if (isOn()) moveInd(); });
    // start on the portfolio dashboard (Esc still returns to the Gateway, as always)
    if (isOn() && typeof appState !== 'undefined' && appState.currentView === 'view-gateway') { if (appState.currentView === 'view-gateway') openDash(); } // at once (a delayed switch made the page jump after it was drawn)
  }
  window.RREAurora = { enable, renderPortfolio, setMode, mode: modeNow };
  if (doc.readyState === 'complete') install(); else window.addEventListener('load', install);
})();

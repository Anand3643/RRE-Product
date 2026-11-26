/**
 * RRE Tally — the same data on every device.
 *
 * All business data lives on the server (one central database). This script makes several open devices behave as one:
 *  1. Live updates: keeps one stream open to /api/events. When another device saves something in the same company, the screen
 *     shown here reloads its data from the server (not while you are typing or have a form open: then it waits until you finish).
 *     Coming back to the tab, or the connection coming back, also reloads, so nothing missed while offline stays stale.
 *  2. No silent overwriting: remembers the version of each record a screen loaded (row_version from the server) and sends it with
 *     the save. If another device changed that record in between, the server refuses the save (409) and nothing is overwritten.
 *  3. Honest save status: "Saving..." while a change is on its way, "Saved" ONLY after the server confirmed it, "Not saved" with the
 *     reason if it failed, "Offline - not saved" if the server could not be reached.
 *  4. No duplicate vouchers on a retry: a voucher posting carries an Idempotency-Key made from its contents, so sending the same
 *     voucher again (e.g. after a dropped connection) returns the first result instead of posting it twice.
 * Loaded before auth-bridge.js, so every fetch() of every screen passes through it (with the sign-in token already attached).
 */
(function () {
  'use strict';
  if (window.RRESync) return;
  const nativeFetch = window.fetch.bind(window);
  const CLIENT = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ------------------------------------------------------------------------------------------------ which requests are which
  function apiPath(input) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || null;
      if (!raw) return null;
      const u = new URL(raw, window.location.href);
      return u.origin === window.location.origin || ['127.0.0.1', 'localhost'].includes(u.hostname) ? (u.pathname.startsWith('/api/') ? u.pathname : null) : null;
    } catch (e) { return null; }
  }
  // same families as core/rowVersion.js (key = which kind of record)
  const FAM = [
    [/^\/api\/inv\/items(?:\/(\d+))?\/?$/, 'items'], [/^\/api\/inv\/categories(?:\/(\d+))?\/?$/, 'categories'], [/^\/api\/inv\/units(?:\/(\d+))?\/?$/, 'units'],
    [/^\/api\/inv\/warehouses(?:\/(\d+))?\/?$/, 'warehouses'], [/^\/api\/inv\/(?:customers|suppliers)(?:\/(\d+))?\/?$/, 'parties'],
    [/^\/api\/inv\/orders\/(\d+)\/?$/, 'orders'], [/^\/api\/inv\/(?:sales-orders|purchase-orders)\/?$/, 'orders'], [/^\/api\/quotations(?:\/(\d+))?\/?$/, 'quotations']
  ];
  const famOf = (p) => { for (const [re, key] of FAM) { const m = re.exec(p); if (m) return { key, id: m[1] ? Number(m[1]) : null }; } return null; };
  // writes that save business data (shown in the save status); previews / look-ups sent as POST are not "saves"
  const SAVE = /^\/api\/(vouchers|masters|inv|quotations|bank|gst|org|approvals|attachments|recurring|import|bulk|tracking|yearend|company|companies|settings|automation|auth\/users|auth\/me|portal|documents|budgets)(\/|$)/;
  const NOT_SAVE = /\/(preview|detect|validate|compute|check|extract|parse|estimate|suggest|search|session)(\/|$)|^\/api\/(events|ai|voice|search|platform\/notifications)/;

  // ------------------------------------------------------------------------------------------------ record versions
  const versions = new Map(); // "items|12" -> { v, pinned }  pinned = loaded by opening that record (an editor shows it)
  function roots(body) {
    const root = body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
    const isRec = (o) => o && typeof o === 'object' && !Array.isArray(o) && o.id != null;
    if (Array.isArray(root)) return root.filter(isRec);
    if (isRec(root)) return [root];
    if (root && typeof root === 'object') for (const k of ['items', 'rows', 'orders', 'parties', 'customers', 'suppliers', 'data']) if (Array.isArray(root[k])) return root[k].filter(isRec);
    return [];
  }
  function remember(fam, body, detail) {
    for (const r of roots(body)) {
      if (r.row_version == null) continue;
      const k = fam.key + '|' + r.id, cur = versions.get(k);
      // a list refresh never replaces the version an open editor was loaded with: that is the version its save must match
      if (detail || !cur || !cur.pinned) versions.set(k, { v: Number(r.row_version), pinned: !!detail || !!(cur && cur.pinned && cur.v === Number(r.row_version)) });
    }
  }

  // ------------------------------------------------------------------------------------------------ save status
  let pill = null, pillTimer = null, pending = 0;
  function showStatus(kind, text) {
    if (!document.body) return;
    if (!pill) {
      pill = document.createElement('div'); pill.id = 'rre-sync-status'; pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
      pill.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;padding:7px 14px;border-radius:999px;font:600 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 20px rgba(15,23,42,.25);max-width:min(92vw,560px);text-align:center;pointer-events:none;transition:opacity .2s';
      document.body.appendChild(pill);
    }
    const colors = { saving: ['#1e293b', '#e2e8f0'], saved: ['#047857', '#ecfdf5'], failed: ['#b91c1c', '#fef2f2'], offline: ['#92400e', '#fffbeb'], sync: ['#3730a3', '#eef2ff'] }[kind];
    pill.style.background = colors[0]; pill.style.color = colors[1]; pill.textContent = text; pill.dataset.state = kind; pill.style.opacity = '1'; pill.hidden = false;
    clearTimeout(pillTimer);
    if (kind === 'saved' || kind === 'sync') pillTimer = setTimeout(() => { pill.style.opacity = '0'; pillTimer = setTimeout(() => { pill.hidden = true; }, 250); }, kind === 'saved' ? 2200 : 1800);
    if (kind === 'failed' || kind === 'offline') pillTimer = setTimeout(() => { pill.style.opacity = '0'; pillTimer = setTimeout(() => { pill.hidden = true; }, 250); }, 7000);
  }

  async function idemKey(body) {
    try {
      const data = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body || ''));
      const h = await crypto.subtle.digest('SHA-256', data);
      return 'vch-' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------------------------------------ the fetch wrapper
  window.fetch = async function (input, init) {
    const path = apiPath(input);
    if (!path) return nativeFetch(input, init);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    headers.set('X-RRE-Client', CLIENT);
    const fam = famOf(path);
    const k = fam && fam.id != null ? fam.key + '|' + fam.id : null;
    if (k && (method === 'PUT' || method === 'PATCH' || method === 'DELETE') && versions.has(k)) headers.set('X-Row-Version', String(versions.get(k).v));
    if (method === 'POST' && /^\/api\/vouchers\/?$/.test(path) && !headers.has('Idempotency-Key') && init && init.body) { const key = await idemKey(init.body); if (key) headers.set('Idempotency-Key', key); }
    const next = Object.assign({}, init, { headers });
    const isSave = method !== 'GET' && method !== 'HEAD' && SAVE.test(path) && !NOT_SAVE.test(path);

    if (isSave) { pending++; showStatus('saving', 'Saving…'); }
    let res;
    try { res = await nativeFetch(input, next); }
    catch (err) {
      if (isSave) { pending = Math.max(0, pending - 1); showStatus('offline', navigator.onLine === false ? 'Offline: not saved. Check the connection and try again.' : 'Could not reach the server: not saved. Try again.'); }
      throw err;
    }
    if (fam && res.ok && method === 'GET') res.clone().json().then((b) => remember(fam, b, fam.id != null)).catch(() => {});
    if (k && res.ok && method !== 'GET') {
      if (method === 'DELETE') versions.delete(k);
      else {
        const hv = res.headers.get('X-Row-Version');
        if (hv) versions.set(k, { v: Number(hv), pinned: !!(versions.get(k) || {}).pinned });
        else versions.delete(k); // unknown now: the next screen load will fetch it
      }
    }
    if (isSave) {
      pending = Math.max(0, pending - 1);
      if (res.ok) {
        res.clone().json().then((b) => {
          if (b && b.success === false) showStatus('failed', 'Not saved: ' + (b.error || 'the server refused the change.'));
          else if (b && b.pending_approval) showStatus('saved', 'Sent for approval');
          else if (!pending) showStatus('saved', 'Saved ✓');
        }).catch(() => { if (!pending) showStatus('saved', 'Saved ✓'); });
      } else {
        res.clone().json().then((b) => {
          if (b && b.code === 'ROW_CONFLICT') { showStatus('failed', 'Not saved: changed on another device. Latest version loaded.'); conflictRefresh(); }
          else showStatus('failed', 'Not saved: ' + ((b && b.error) || 'error ' + res.status));
        }).catch(() => showStatus('failed', 'Not saved (error ' + res.status + ').'));
      }
    }
    return res;
  };

  // ------------------------------------------------------------------------------------------------ refreshing the screen
  const LOADERS = {
    'view-dashboard': 'loadDashboard', 'view-daybook': 'loadDaybook', 'view-trial-balance': 'loadTrialBalance', 'view-balance-sheet': 'loadBalanceSheet',
    'view-profit-loss': 'loadProfitLoss', 'view-stock-summary': 'loadStockSummary', 'view-ratio-analysis': 'loadRatioAnalysis', 'view-gst': 'loadGSTReport',
    'view-outstandings': 'loadOutstandings', 'view-bank-recon': 'loadBankReconciliation', 'view-chart-accounts': 'loadChartOfAccountsTree', 'view-quotations': 'loadQuotations'
  };
  const FORM_VIEWS = new Set(['view-voucher', 'view-quotation-editor']);
  const currentView = () => { try { return (typeof appState !== 'undefined' && appState && appState.currentView) || null; } catch (e) { return null; } }; // eslint-disable-line no-undef
  const invOpen = () => { const r = document.getElementById('sp-app'); return !!(r && r.classList.contains('open') && window.StockPilotInv); };

  /** True while someone is in the middle of something a reload would disturb. */
  function busy() {
    const a = document.activeElement;
    if (a && a !== document.body && a.matches && a.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable="true"]')) return true;
    if (document.querySelector('.modal-backdrop:not(.hidden)')) return true;
    if (invOpen() && document.querySelector('#sp-app .ov')) return true;
    if (!invOpen() && FORM_VIEWS.has(currentView())) return true;
    return false;
  }

  let wanted = false, timer = null, mastersStale = false;
  function refreshNow() {
    wanted = false;
    try {
      if (invOpen()) { const S = window.StockPilotInv._state; window.StockPilotInv.go(S.route, S.param); }
      else { const fn = LOADERS[currentView()]; if (fn && typeof window[fn] === 'function') window[fn](); }
      if (typeof window.loadMasters === 'function' && !FORM_VIEWS.has(currentView())) { window.loadMasters(); mastersStale = false; } else mastersStale = true;
      if (window.RREPlatform && typeof window.RREPlatform.refreshNotifications === 'function') window.RREPlatform.refreshNotifications();
    } catch (e) { /* a screen that cannot reload keeps what it shows; the next visit loads fresh data */ }
  }
  function requestRefresh(delay = 600) {
    wanted = true; clearTimeout(timer);
    timer = setTimeout(function tryIt() { if (!wanted) return; if (busy()) { timer = setTimeout(tryIt, 1500); return; } refreshNow(); }, delay);
  }
  function conflictRefresh() { requestRefresh(300); }
  // a form view left (e.g. voucher saved, back to the gateway): bring the masters (parties, items) up to date for the next entry
  setInterval(() => { if (mastersStale && !FORM_VIEWS.has(currentView()) && !busy() && typeof window.loadMasters === 'function') { mastersStale = false; try { window.loadMasters(); } catch (e) { /* ignore */ } } }, 3000);

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 2000) requestRefresh(200); // back to this tab / phone woke up: show what changed meanwhile
    if (!live.connected) connect(0);
  });
  window.addEventListener('online', () => { showStatus('sync', 'Back online: updating…'); requestRefresh(200); connect(0); });
  window.addEventListener('offline', () => showStatus('offline', 'Offline: changes cannot be saved until the connection is back.'));

  // ------------------------------------------------------------------------------------------------ the live stream
  const live = { connected: false, ever: false, ctrl: null, retry: null, backoff: 2000 };
  const signedIn = () => { if (window.__RRE_AUTH_ENABLED !== true) return true; try { const s = JSON.parse(localStorage.getItem('tally_user_session') || 'null'); return !!(s && s.token); } catch (e) { return false; } };

  function connect(delay) {
    clearTimeout(live.retry);
    live.retry = setTimeout(run, delay == null ? live.backoff : delay);
  }
  async function run() {
    if (live.connected) return;
    if (!signedIn()) { connect(5000); return; }
    const ctrl = new AbortController(); live.ctrl = ctrl;
    let res;
    try { res = await window.fetch('/api/events', { headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal }); }
    catch (e) { live.backoff = Math.min(live.backoff * 2, 30000); connect(); return; }
    if (!res.ok || !res.body) { live.backoff = res.status === 401 || res.status === 403 ? 10000 : Math.min(live.backoff * 2, 30000); connect(); return; }
    live.connected = true; live.backoff = 2000;
    const reconnected = live.ever; live.ever = true;
    if (reconnected) requestRefresh(200); // anything saved elsewhere while this device was disconnected
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (/^event: (.+)$/m.exec(block) || [])[1];
          if (ev === 'changed') { requestRefresh(); window.dispatchEvent(new CustomEvent('rre:data-changed', { detail: JSON.parse((/^data: (.+)$/m.exec(block) || [, '{}'])[1]) })); }
        }
      }
    } catch (e) { /* stream dropped */ }
    live.connected = false;
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => connect(800)); else connect(800);

  window.RRESync = { client: CLIENT, refresh: () => requestRefresh(0), status: () => ({ live: live.connected, pending }), _versions: versions };
})();

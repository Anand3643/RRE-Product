/**
 * RRE Tally — shows the ORIGINAL inventory application inside RRE.
 * The inventory interface is your original StockPilot web app, running in its own frame (its own page, its own styles), so nothing of it
 * can change RRE's look and nothing of RRE's can change its look. A slim bar on top returns to RRE.
 */
(function () {
  'use strict';
  if (window.RREInventory) return;
  const root = () => document.getElementById('rre-inv-host');
  let loadedUrl = null;

  const css = `#rre-inv-host{position:fixed;inset:0;z-index:70;display:none;flex-direction:column;background:#f6f7f9;font:13px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif}
#rre-inv-host.open{display:flex}
#rre-inv-host .bar{flex:none;height:34px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#1f3a52;color:#fff}
#rre-inv-host .bar button{border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;border-radius:5px;padding:3px 10px;font:inherit;cursor:pointer}
#rre-inv-host .bar button:hover{background:rgba(255,255,255,.14)}
#rre-inv-host .bar b{font-weight:600;letter-spacing:.02em}#rre-inv-host .grow{flex:1}
#rre-inv-host iframe{flex:1;border:0;width:100%;background:#fff}
#rre-inv-host .msg{flex:1;display:grid;place-items:center;text-align:center;color:#495057;padding:24px}
#rre-inv-host .msg .box{max-width:520px}#rre-inv-host .spin{width:30px;height:30px;border:3px solid #ced4da;border-top-color:#089185;border-radius:50%;margin:0 auto 12px;animation:rrespin 1s linear infinite}
@keyframes rrespin{to{transform:rotate(360deg)}}
[data-au="light"] #rre-inv-host{background:#f4f6ff}[data-au="light"] #rre-inv-host .bar{background:rgba(255,255,255,.96);color:#0f172a;border-bottom:1px solid rgba(99,102,241,.2)}
[data-au="light"] #rre-inv-host .bar button{border-color:#cfd6f7;color:#1e293b}[data-au="light"] #rre-inv-host .bar button:hover{background:#eef1ff}[data-au="light"] #rre-inv-host .msg{color:#475569}
[data-au="dark"] #rre-inv-host{background:#050816}[data-au="dark"] #rre-inv-host .bar{background:rgba(9,13,38,.96);color:#e8edff;border-bottom:1px solid rgba(140,158,255,.25)}[data-au="dark"] #rre-inv-host .msg{color:#b6c1ee}
[data-au] #rre-inv-host iframe{background:transparent}[data-au] #rre-inv-host .spin{border-top-color:#4f6bff}`;

  function build() {
    if (root()) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'rre-inv-host';
    el.innerHTML = '<div class="bar"><button id="rre-inv-back">← Back to RRE</button><b>Inventory</b><span class="grow"></span><span id="rre-inv-books" title="Purchases, sales, transfers and adjustments made in Inventory are posted to the RRE books automatically" style="opacity:.9"></span><button id="rre-inv-sync" hidden>Post to books now</button><button id="rre-inv-win" title="Open in its own window">Open in new window</button></div><div class="msg" id="rre-inv-msg"></div>';
    document.body.appendChild(el);
    el.querySelector('#rre-inv-back').onclick = close;
    el.querySelector('#rre-inv-win').onclick = () => openWindow();
    el.querySelector('#rre-inv-sync').onclick = async (e) => { e.target.disabled = true; try { await bridge('/inv/bridge/sync', 'POST', { force: true }); } catch (x) { /* shown by the status */ } e.target.disabled = false; refreshBooks(); };
    // keystrokes on this bar must not reach RRE's global shortcuts (Esc at RRE's gateway signs out); keys inside the frame never reach RRE at all
    ['keydown', 'keyup', 'keypress'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation()));
    window.addEventListener('keydown', (e) => { if (root() && root().classList.contains('open') && !root().contains(e.target)) e.stopPropagation(); }, true);
  }
  const msg = (html) => { const m = root().querySelector('#rre-inv-msg'); if (m) { m.style.display = 'grid'; m.innerHTML = '<div class="box">' + html + '</div>'; } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // the accounting link: what has been posted to RRE's books from the inventory application
  async function bridge(p, method, body) {
    const base = typeof API_BASE !== 'undefined' ? API_BASE : '/api';
    const res = await fetch(base + p, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) { const e = new Error(j.error || 'Not available'); e.status = res.status; throw e; }
    return j.data;
  }
  async function refreshBooks() {
    const el = root(); if (!el || !el.classList.contains('open')) return;
    const label = el.querySelector('#rre-inv-books'), btn = el.querySelector('#rre-inv-sync');
    try {
      const d = await bridge('/inv/bridge/status'); btn.hidden = false;
      const synced = d.counts.filter((c) => c.status === 'synced').reduce((t, c) => t + c.n, 0), failed = d.failed.length;
      label.textContent = !d.enabled ? 'Books link: off' : failed ? `Books: ${failed} document${failed === 1 ? '' : 's'} need attention` : `Books: up to date (${synced} posted)`;
      label.style.color = failed ? '#ffd27a' : '#cfe8d5'; label.title = failed ? d.failed.map((f) => `${f.number}: ${f.message}`).join(' | ') : label.title;
    } catch (e) { btn.hidden = true; label.textContent = ''; }
  }
  setInterval(refreshBooks, 30000);

  // the inventory screens follow RRE's Light / Dark choice
  const html = document.documentElement;
  const modeNow = () => html.getAttribute('data-au') || (html.getAttribute('data-theme') === 'midnight-dark' ? 'dark' : 'light');
  const withMode = (u) => u + (u.includes('?') ? '&' : '?') + 'mode=' + modeNow();
  function sendMode() { const f = root() && root().querySelector('iframe'); if (f && f.contentWindow && loadedUrl) { try { f.contentWindow.postMessage({ rre: 'theme', mode: modeNow() }, new URL(loadedUrl).origin); } catch (e) { /* ignore */ } } }
  new MutationObserver(sendMode).observe(html, { attributes: true, attributeFilter: ['data-au', 'data-theme'] });
  document.addEventListener('rre-mode', sendMode);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a call to RRE's own server; a dropped connection is retried before the person is told
  async function call(p, body) {
    const base = typeof API_BASE !== 'undefined' ? API_BASE : '/api';
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        return { res, j: await res.json().catch(() => ({})) };
      } catch (e) { last = e; await sleep(1000 * (i + 1)); }
    }
    throw new Error('RRE could not reach its own server (' + ((last && last.message) || 'no connection') + '). Make sure RRE is still running, then press Try again.');
  }
  // asks RRE to open Inventory. RRE answers at once; if the inventory application is still starting we wait for it here (and show how long)
  async function launch(path, onWait) {
    const t0 = Date.now();
    for (;;) {
      const { res, j } = await call('/inventory-app/launch', { path: path || '/', nowait: true });
      if (res.status === 202 && j.data && j.data.starting) {
        if (onWait) onWait(Math.round((Date.now() - t0) / 1000));
        if (Date.now() - t0 > 180000) throw new Error('Inventory is taking too long to start. Please try again in a minute.');
        await sleep(1500);
        const st = (await call('/inventory-app/status')).j;
        if (st && st.data && st.data.error && !st.data.starting) throw new Error(st.data.error);
        continue;
      }
      if (!res.ok || !j.success) throw new Error(j.error || 'The inventory application could not be started.');
      return j.data.url;
    }
  }

  async function open(path) {
    build(); root().classList.add('open'); setTimeout(refreshBooks, 300);
    const frame = root().querySelector('iframe');
    if (frame && loadedUrl) {
      if (path) { try { const u = new URL(loadedUrl); const target = u.origin + path; try { frame.contentWindow.location.href = target; } catch (e2) { frame.src = target; } } catch (e) { /* ignore */ } } // already running (signed in): go straight to the feature asked for
      return;
    }
    msg('<div class="spin"></div><b>Starting inventory…</b><div style="margin-top:6px">The first start can take a few seconds.</div>');
    try {
      const url = await launch(path, (sec) => msg(`<div class="spin"></div><b>Starting inventory…</b><div style="margin-top:6px">${sec ? sec + ' seconds so far. ' : ''}The first start can take up to a minute.</div>`));
      let f = root().querySelector('iframe');
      if (!f) { f = document.createElement('iframe'); f.title = 'Inventory'; f.setAttribute('allow', 'clipboard-write; fullscreen'); root().appendChild(f); }
      f.addEventListener('load', () => { const m = root().querySelector('#rre-inv-msg'); if (m) m.style.display = 'none'; }, { once: true });
      f.src = withMode(url); loadedUrl = url;
    } catch (e) {
      msg(`<b>Inventory could not be opened</b><div style="margin:8px 0 12px">${esc(e.message)}</div><button id="rre-inv-retry" style="padding:6px 14px;border:1px solid #adb5bd;border-radius:6px;background:#fff;cursor:pointer">Try again</button>`);
      const r = root().querySelector('#rre-inv-retry'); if (r) r.onclick = () => open(path);
    }
  }
  async function openWindow() { try { window.open(withMode(await launch('/')), '_blank', 'noopener'); } catch (e) { msg(esc(e.message)); } }
  function close() { if (root()) root().classList.remove('open'); }
  function reset() { const r = root(); if (r) { const f = r.querySelector('iframe'); if (f) f.remove(); loadedUrl = null; r.classList.remove('open'); } }

  // signing out of RRE ends the inventory session shown here too
  const wrap = (name) => { const f = window[name]; if (typeof f !== 'function' || f.__invWrapped) return; const w = function () { reset(); return f.apply(this, arguments); }; w.__invWrapped = true; window[name] = w; };
  window.addEventListener('load', () => wrap('startWithFreshLogin'));

  window.RREInventory = { open, close, reset };
})();

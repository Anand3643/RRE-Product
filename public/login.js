/* RRE Entries — the one sign-in page: Admin / Employee / Customer, forgot password, reset password, first-time setup.
 * No secret is kept here: the page only sends what the person types and stores the session token the server returns. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SESSION = 'tally_user_session';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const TYPES = ['admin', 'employee', 'customer'];
  const COMMON = /^(password|passw0rd|qwerty|letmein|welcome|admin|administrator|changeme|iloveyou|123456|abcdef)/i;
  let loginType = TYPES.includes(store.get('rre_login_type')) ? store.get('rre_login_type') : 'admin';
  let resetToken = null, pending = null, cfg = { mail_configured: true, setup_required: false, guest_access: false };

  async function api(method, path, body, token) {
    const headers = {}; if (body) headers['Content-Type'] = 'application/json'; if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try { res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
    catch (e) { const err = new Error('Cannot reach the RRE Entries server. Make sure the application is running, then try again.'); err.network = true; throw err; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const err = new Error(j.error || 'Something went wrong. Please try again.'); err.status = res.status; err.code = j.code; throw err; }
    return j;
  }

  // ---------------------------------------------------------------- views
  const VIEWS = ['signin', 'forgot', 'sent', 'reset', 'badlink', 'done', 'setup', 'change'];
  function show(name, focusId) {
    for (const v of VIEWS) { const el = $('v-' + v); if (el) el.hidden = v !== name; }
    document.querySelectorAll('.msg').forEach((m) => m.classList.remove('show'));
    const f = focusId && $(focusId); if (f) setTimeout(() => f.focus({ preventScroll: true }), 60);
    if (name === 'forgot') $('mail-note').textContent = cfg.mail_configured ? '' : ' · E-mail is not set up on this computer yet';
    else $('mail-note').textContent = '';
  }
  function err(id, text) { const m = $(id); if (!m) return; m.textContent = text || ''; m.classList.remove('show'); if (text) { void m.offsetWidth; m.classList.add('show'); } }
  function busy(btnId, on) { const b = $(btnId); if (!b) return; b.disabled = !!on; b.classList.toggle('loading', !!on); }

  // ---------------------------------------------------------------- login type control
  function setType(t, silent) {
    loginType = TYPES.includes(t) ? t : 'admin';
    const seg = $('seg'); seg.style.setProperty('--i', String(TYPES.indexOf(loginType)));
    seg.querySelectorAll('button').forEach((b) => { const on = b.dataset.type === loginType; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    store.set('rre_login_type', loginType);
    $('si-id').placeholder = loginType === 'admin' ? 'admin or you@company.com' : 'you@company.com';
    if (!silent) err('m-signin', '');
  }
  $('seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) setType(b.dataset.type); });
  $('seg').addEventListener('keydown', (e) => {
    const i = TYPES.indexOf(loginType); let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % 3; else if (e.key === 'ArrowLeft') n = (i + 2) % 3; if (n === null) return;
    e.preventDefault(); setType(TYPES[n]); $('seg').querySelector(`[data-type="${TYPES[n]}"]`).focus();
  });

  // ---------------------------------------------------------------- show / hide password, theme
  document.addEventListener('click', (e) => {
    const eye = e.target.closest('.eye'); if (eye) { const i = $(eye.dataset.eye), on = i.type === 'password'; i.type = on ? 'text' : 'password'; eye.setAttribute('aria-pressed', on ? 'true' : 'false'); eye.setAttribute('aria-label', on ? 'Hide password' : 'Show password'); i.focus(); return; }
    const go = e.target.closest('[data-go]'); if (go) { e.preventDefault(); const t = go.dataset.go; try { history.replaceState(null, '', location.pathname + '#' + t); } catch (x) { /* ignore */ } if (t === 'signin') { pending = null; resetToken = null; } show(t, t === 'signin' ? 'si-id' : t === 'forgot' ? 'fg-email' : null); }
  });
  $('theme-btn').addEventListener('click', () => { const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', t); store.set('rre_login_theme', t); });

  // ---------------------------------------------------------------- password strength (advice only: the server enforces the rules)
  function evaluate(pw) {
    const len = pw.length >= 10, mix = /\p{L}/u.test(pw) && /\p{N}/u.test(pw), common = pw.length > 0 && !COMMON.test(pw) && !/^(.)\1+$/u.test(pw);
    let s = 0; if (pw.length >= 10) s++; if (pw.length >= 14) s++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    if (!len || !mix || !common) s = Math.min(s, 1); if (pw && s < 1) s = 1; if (!pw) s = 0;
    return { len, mix, common, score: Math.min(4, s) };
  }
  function wireMeter(inputId, meterId, rulesId) {
    const input = $(inputId), meter = $(meterId); if (!input || !meter) return;
    const label = meter.querySelector('span');
    const words = ['Enter a password', 'Weak', 'Fair', 'Good', 'Strong'];
    input.addEventListener('input', () => {
      const r = evaluate(input.value); meter.dataset.s = String(r.score); if (label) label.textContent = words[r.score];
      const rules = rulesId && $(rulesId); if (rules) { rules.querySelector('[data-r=len]').classList.toggle('ok', r.len); rules.querySelector('[data-r=mix]').classList.toggle('ok', r.mix); rules.querySelector('[data-r=common]').classList.toggle('ok', r.common); }
    });
  }
  wireMeter('rs-pw', 'rs-meter', 'rs-rules'); wireMeter('su-pw', 'su-meter'); wireMeter('ch-pw', 'ch-meter');

  // ---------------------------------------------------------------- session + redirect
  function saveSession(d, remember) {
    store.set(SESSION, JSON.stringify({ user: d.user, permissions: d.permissions, token: d.token, remember: !!remember, login_type: d.login_type, home: d.home, modules: d.user && d.user.modules }));
    try { sessionStorage.setItem('rre_alive', '1'); } catch (e) { /* ignore */ }
  }
  function enter(d) { location.replace(d.home === 'portal' ? 'portal.html' : 'index.html'); }

  // ---------------------------------------------------------------- sign in
  $('v-signin').addEventListener('submit', async (e) => {
    e.preventDefault(); err('m-signin', '');
    const id = $('si-id').value.trim(), pw = $('si-pw').value;
    if (!id || !pw) return err('m-signin', 'Enter your e-mail (or username) and your password.');
    busy('si-go', true);
    try {
      const j = await api('POST', '/auth/login', { identifier: id, password: pw, login_type: loginType, remember: $('si-rem').checked });
      const d = j.data, remember = $('si-rem').checked;
      if (d.must_change_password) { pending = { d, remember, temp: pw }; $('ch-cur').value = pw; $('ch-pw').value = ''; $('ch-pw2').value = ''; show('change', 'ch-pw'); return; }
      saveSession(d, remember); $('si-pw').value = ''; enter(d);
    } catch (x) { err('m-signin', x.message); $('si-pw').select(); }
    finally { busy('si-go', false); }
  });
  $('si-guest').addEventListener('click', async () => {
    err('m-signin', '');
    try { const j = await api('POST', '/auth/guest', {}); saveSession(j.data, false); enter(j.data); } catch (x) { err('m-signin', x.message); }
  });

  // ---------------------------------------------------------------- forced change (temporary password)
  $('v-change').addEventListener('submit', async (e) => {
    e.preventDefault(); err('m-change', ''); if (!pending) return show('signin', 'si-id');
    const cur = $('ch-cur').value, a = $('ch-pw').value, b = $('ch-pw2').value;
    if (a !== b) return err('m-change', 'The two new passwords are not the same.');
    busy('ch-go', true);
    try {
      const j = await api('POST', '/auth/change-password', { current_password: cur, new_password: a }, pending.d.token);
      saveSession(j.data, pending.remember); pending = null; enter(j.data);
    } catch (x) { err('m-change', x.message); }
    finally { busy('ch-go', false); }
  });
  $('ch-cancel').addEventListener('click', () => { if (pending) api('POST', '/auth/logout', {}, pending.d.token).catch(() => {}); pending = null; $('si-pw').value = ''; });

  // ---------------------------------------------------------------- forgot password
  $('v-forgot').addEventListener('submit', async (e) => {
    e.preventDefault(); err('m-forgot', '');
    const email = $('fg-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err('m-forgot', 'Enter the e-mail address of your account.');
    busy('fg-go', true);
    try { const j = await api('POST', '/auth/forgot', { email }); $('sent-text').textContent = j.message || $('sent-text').textContent; show('sent'); }
    catch (x) { err('m-forgot', x.message); }
    finally { busy('fg-go', false); }
  });

  // ---------------------------------------------------------------- reset / set password from the e-mailed link
  $('v-reset').addEventListener('submit', async (e) => {
    e.preventDefault(); err('m-reset', '');
    const a = $('rs-pw').value, b = $('rs-pw2').value;
    if (a !== b) return err('m-reset', 'The two passwords are not the same.');
    busy('rs-go', true);
    try { await api('POST', '/auth/reset', { token: resetToken, password: a, confirm: b }); resetToken = null; $('rs-pw').value = ''; $('rs-pw2').value = ''; show('done'); }
    catch (x) { if (x.code === 'RESET_INVALID') show('badlink'); else err('m-reset', x.message); }
    finally { busy('rs-go', false); }
  });

  // ---------------------------------------------------------------- first-time administrator setup
  $('v-setup').addEventListener('submit', async (e) => {
    e.preventDefault(); err('m-setup', '');
    const a = $('su-pw').value, b = $('su-pw2').value;
    if (a !== b) return err('m-setup', 'The two passwords are not the same.');
    busy('su-go', true);
    try { const j = await api('POST', '/auth/setup', { password: a }); saveSession(j.data, false); enter(j.data); }
    catch (x) { err('m-setup', x.message); }
    finally { busy('su-go', false); }
  });

  // ---------------------------------------------------------------- start
  async function start() {
    setType(loginType, true);
    const params = new URLSearchParams(location.search);
    const token = params.get('reset');
    if (token) {
      try { history.replaceState(null, '', location.pathname + '#reset'); } catch (e) { /* ignore */ } // the secret leaves the address bar at once
      resetToken = token;
      try {
        const j = await api('GET', '/auth/reset/validate?token=' + encodeURIComponent(token));
        if (j.data.valid) { show('reset', 'rs-pw'); return; }
      } catch (e) { /* fall through to the message */ }
      show('badlink'); return;
    }
    // already signed in? go straight to the right place (unless the person asked to switch accounts)
    const raw = store.get(SESSION);
    if (raw && !params.get('switch')) {
      try {
        const s = JSON.parse(raw);
        if (s && s.token) {
          const me = await api('GET', '/auth/me', null, s.token);
          if (me.data && !me.data.must_change_password) return enter(me.data);
        }
      } catch (e) { store.del(SESSION); }
    } else if (raw) { try { const s = JSON.parse(raw); api('POST', '/auth/logout', {}, s.token).catch(() => {}); } catch (e) { /* ignore */ } store.del(SESSION); }
    try { const c = await api('GET', '/auth/config'); cfg = c.data; } catch (e) { err('m-signin', e.message); }
    if (params.get('expired')) err('m-signin', 'Your session ended. Please sign in again.');
    if (cfg.setup_required && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)) { show('setup', 'su-pw'); return; }
    $('si-guest').classList.toggle('hidden', !cfg.guest_access);
    const h = location.hash.replace('#', '');
    if (h === 'forgot') show('forgot', 'fg-email'); else show('signin', 'si-id');
  }
  start();
})();

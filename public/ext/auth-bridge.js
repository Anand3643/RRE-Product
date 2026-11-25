/**
 * RRE Tally — attaches the signed session token to API calls and handles expired sessions.
 * Loaded BEFORE app.js so every existing fetch() to the local API is covered without
 * editing individual call sites.
 */
(function () {
  'use strict';
  const nativeFetch = window.fetch.bind(window);

  function sessionToken() {
    try {
      const s = JSON.parse(localStorage.getItem('tally_user_session') || 'null');
      const t = s && s.token;
      return t && String(t).startsWith('rre_') ? t : null;
    } catch (e) { return null; }
  }

  function localApiPath(input) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
      if (!raw) return null;
      const u = new URL(raw, window.location.href);
      const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.origin === window.location.origin;
      return loop && u.pathname.startsWith('/api/') ? u.pathname : null;
    } catch (e) { return null; }
  }

  const AUTH_PATH = /^\/api\/auth\/(login|register|google|setup|change-password)\/?$/;
  let expiredHandled = false;

  function onExpired() {
    if (expiredHandled) return;
    expiredHandled = true;
    try {
      if (typeof window.startWithFreshLogin === 'function') window.startWithFreshLogin();
      const errEl = document.getElementById('login-error-msg');
      const errText = document.getElementById('login-error-text');
      if (errEl && errText) { errText.textContent = 'Your session has expired. Please log in again.'; errEl.classList.remove('hidden'); }
    } finally {
      setTimeout(() => { expiredHandled = false; }, 3000);
    }
  }

  window.fetch = function (input, init) {
    if (window.__RRE_AUTH_ENABLED !== true) return nativeFetch(input, init);
    const path = localApiPath(input);
    if (!path) return nativeFetch(input, init);

    const token = sessionToken();
    let nextInit = init;
    if (token) {
      const headers = new Headers((init && init.headers) || undefined);
      if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
      nextInit = Object.assign({}, init, { headers });
    }

    return nativeFetch(input, nextInit).then((res) => {
      if (res.status === 401 && token && !AUTH_PATH.test(path)) onExpired();
      if (res.status === 403 && token) {
        res.clone().json().then((j) => { if (j && j.code === 'PASSWORD_CHANGE_REQUIRED' && window.RREAccounts) window.RREAccounts.promptPasswordChange(); }).catch(() => {});
      }
      if (res.ok && AUTH_PATH.test(path)) {
        // Masters were requested once at page load (before login); reload them now that we are authorised.
        setTimeout(() => {
          try { if (typeof window.loadMasters === 'function') window.loadMasters(); } catch (e) {}
        }, 150);
      }
      return res;
    });
  };
})();

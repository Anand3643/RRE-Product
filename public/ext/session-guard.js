/**
 * RRE Entries — first script on every protected page (the application and the customer portal).
 * Nobody sees these pages without a session: no session -> the one sign-in page. The server still checks every request;
 * this only keeps the wrong screen from being drawn (a customer is sent to the portal, staff to the application).
 */
(function () {
  'use strict';
  var KEY = 'tally_user_session';
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function leave(query) {
    window.__RRE_REDIRECTING = true;
    try { localStorage.removeItem(KEY); sessionStorage.removeItem('rre_alive'); } catch (e) { /* ignore */ }
    location.replace('login.html' + (query || ''));
  }
  var s = read(), isPortal = /portal\.html$/i.test(location.pathname);
  // keep the page blank until the server has confirmed the session (removed by app.js / portal start-up; never left hidden for long)
  var st = document.createElement('style'); st.id = 'rre-sg'; st.textContent = 'html{visibility:hidden}';
  (document.head || document.documentElement).appendChild(st);
  setTimeout(function () { var x = document.getElementById('rre-sg'); if (x) x.remove(); }, 8000);

  if (!s || !s.token) {
    // login screen switched off on this computer: the server opens the session itself; otherwise go to the sign-in page
    window.__RRE_REDIRECTING = true;
    fetch('/api/auth/auto', { method: 'POST' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.success) { leave(); return; }
      var d = j.data;
      localStorage.setItem(KEY, JSON.stringify({ user: d.user, permissions: d.permissions, token: d.token, remember: true, auto: true, login_type: d.login_type, home: d.home, modules: d.user && d.user.modules }));
      location.replace('index.html');
    }).catch(function () { leave(); });
    return;
  }
  try {
    // "Remember me" off: the session lasts only while this window is open
    if (!s.remember && !sessionStorage.getItem('rre_alive')) {
      try { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token }, keepalive: true }); } catch (e) { /* ignore */ }
      leave('?expired=1'); return;
    }
  } catch (e) { /* storage blocked: carry on, the server decides */ }
  var role = s.user && s.user.role;
  // there is no separate customer portal: every role works inside the one application (a customer sees only their own dashboard)
  if (isPortal) { window.__RRE_REDIRECTING = true; location.replace('index.html'); return; }
  window.__RRE_SESSION = s;
})();

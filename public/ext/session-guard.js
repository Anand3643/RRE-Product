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

  if (!s || !s.token) { leave(); return; }
  try {
    // "Remember me" off: the session lasts only while this window is open
    if (!s.remember && !sessionStorage.getItem('rre_alive')) {
      try { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token }, keepalive: true }); } catch (e) { /* ignore */ }
      leave('?expired=1'); return;
    }
  } catch (e) { /* storage blocked: carry on, the server decides */ }
  var role = s.user && s.user.role;
  if (!isPortal && role === 'Customer') { window.__RRE_REDIRECTING = true; location.replace('portal.html'); return; }
  if (isPortal && role !== 'Customer') { window.__RRE_REDIRECTING = true; location.replace('index.html'); return; }
  window.__RRE_SESSION = s;
})();

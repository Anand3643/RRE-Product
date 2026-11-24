/**
 * RRE Tally — sends a signed-in CUSTOMER to the customer portal instead of the staff Gateway, and brings the portal down on sign-out.
 * Staff roles are untouched: for them showGateway() behaves exactly as before. (The server refuses a customer every staff route anyway.)
 */
(function () {
  'use strict';
  const isCustomer = () => { try { return typeof appState !== 'undefined' && appState.currentUser && appState.currentUser.role === 'Customer' && !appState.currentUser.own_company; } catch (e) { return false; } };
  const wrap = (name, fn) => { const f = window[name]; if (typeof f !== 'function' || f.__portalWrapped) return; const w = function () { return fn.call(this, f, arguments); }; w.__portalWrapped = true; window[name] = w; };
  function install() {
    wrap('showGateway', function (orig, args) { if (isCustomer() && window.RREPortal) { window.RREPortal.open(); return; } if (window.RREPortal) window.RREPortal.close(); return orig.apply(this, args); });
    wrap('startWithFreshLogin', function (orig, args) { if (window.RREPortal) window.RREPortal.close(); return orig.apply(this, args); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
  window.addEventListener('load', install);
})();

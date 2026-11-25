/**
 * Lazy screens and pop-ups. Rarely-opened blocks of index.html are <template data-lazy> (see scripts/lazy-templates.js): the browser
 * reads them but does not build them, so start-up builds and styles far fewer elements. The first time ANY code asks for an id inside
 * such a block - openModal(id), showView(id), document.getElementById(...), document.querySelector('#...') - the block is built in
 * exactly its original place and its icons are drawn; from then on it is an ordinary part of the page.
 * Loaded first in <body>, before every other script.
 */
(function () {
  'use strict';
  if (window.RRELazy) return;
  const getById = Document.prototype.getElementById, qs = Document.prototype.querySelector;
  let map = null, seen = -1; // id -> its template; how many templates the index has seen
  function index() {
    map = new Map(); seen = document.querySelectorAll('template[data-lazy]').length;
    for (const t of document.querySelectorAll('template[data-lazy]')) {
      if (t.id) map.set(t.id, t);
      map.set(t.dataset.lazy, t);
      for (const el of t.content.querySelectorAll('[id]')) map.set(el.id, t);
    }
  }
  function build(t) {
    if (!t.isConnected) return;
    const frag = t.content; const top = frag.firstElementChild;
    t.replaceWith(frag);
    try { if (window.lucide && top) window.lucide.createIcons({ root: top.parentElement || document }); } catch (e) { /* icons are decoration */ }
    for (const [k, v] of map) if (v === t) map.delete(k);
  }
  function wake(id) {
    if (!map || (!map.has(id) && document.readyState === 'loading' && document.querySelectorAll('template[data-lazy]').length !== seen)) index(); // more of the page has been read since
    const t = map.get(id); if (!t) return false;
    build(t); return true;
  }
  Document.prototype.getElementById = function (id) {
    const el = getById.call(this, id);
    if (el || this !== document) return el;
    return wake(id) ? getById.call(this, id) : null;
  };
  Document.prototype.querySelector = function (sel) {
    const el = qs.call(this, sel);
    if (el || this !== document || typeof sel !== 'string') return el;
    const m = /^#([A-Za-z][\w-]*)(?=$|[\s.:[>])/.exec(sel.trim());
    return m && wake(m[1]) ? qs.call(this, sel) : null;
  };
  // build everything (used before printing, or by tests that need the whole page)
  window.RRELazy = { wake, buildAll: () => { if (!map) index(); for (const t of new Set(map.values())) build(t); }, pending: () => document.querySelectorAll('template[data-lazy]').length };
})();

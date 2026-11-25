/**
 * Builds public/vendor/lucide.subset.js: only the Lucide icons RRE uses (the full library is ~500 KB and was parsed on every load).
 *   npm run build:icons
 * Every quoted name in public/ that is a Lucide icon is included, so icons chosen in code (data-lucide="${x}") are covered too.
 * Safety net: if a page ever asks for an icon that is not in the subset, the full library is fetched once and draws it.
 * The drawing code is Lucide's own (copied from the full build), so icons look exactly the same.
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const FULL = path.join(PUB, 'vendor', 'lucide.min.js');
const src = fs.readFileSync(FULL, 'utf8');
const lucide = require(FULL);
const version = (/@license lucide v([\d.]+)/.exec(src) || [])[1] || '?';

// Lucide's own helpers: element factory and the per-element replacer (the code before the first icon's data)
const h0 = src.indexOf('const i={xmlns'), h1 = src.indexOf(',Ct=[[', h0);
if (h0 < 0 || h1 < 0) throw new Error('Unexpected lucide.min.js layout: update scripts/build-icons.js');
const helpers = src.slice(h0, h1) + ';';
if (!/st=\(t,\{nameAttr:h,icons:c,attrs:d\}\)=>/.test(helpers)) throw new Error('Lucide replacer not found');

const pascal = (k) => k.replace(/(^|[-_ ])([a-z0-9])/g, (m, a, b) => b.toUpperCase());
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); } else if (/\.(js|html)$/.test(f)) files.push(p); } })(PUB);
const used = new Set();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"`]/g)) if (lucide.icons[pascal(m[1])]) used.add(pascal(m[1]));
  for (const m of text.matchAll(/data-lucide="([a-z0-9-]+)"/g)) if (lucide.icons[pascal(m[1])]) used.add(pascal(m[1]));
}
const subset = {}; for (const k of [...used].sort()) subset[k] = lucide.icons[k];

const out = `/* Lucide v${version} (ISC license) - ONLY the ${used.size} icons RRE uses, built by scripts/build-icons.js from vendor/lucide.min.js. */
(function () {
  'use strict';
  ${helpers}
  const SUB = ${JSON.stringify(subset)};
  let full = null, loading = null;
  const loadFull = () => loading || (loading = new Promise((res) => { const s = document.createElement('script'); s.src = 'vendor/lucide.min.js'; s.onload = () => { full = window.__lucideFull || window.lucide; res(); }; s.onerror = () => res(); const keep = window.lucide; window.lucide = undefined; document.head.appendChild(s); s.addEventListener('load', () => { window.__lucideFull = window.lucide; window.lucide = keep; }); }));
  function createIcons({ icons = SUB, nameAttr = 'data-lucide', attrs = {}, root = document } = {}) {
    let missing = false;
    Array.from(root.querySelectorAll('[' + nameAttr + ']')).forEach((el) => {
      const name = el.getAttribute(nameAttr); if (name == null || el.tagName === 'svg') return;
      const key = nP(name);
      if (!icons[key] && !(full && full.icons[key])) { missing = true; return; }
      st(el, { nameAttr, icons: icons[key] ? icons : full.icons, attrs });
    });
    // an icon that is not in the subset: fetch the full library once, then draw it
    if (missing && !full) loadFull().then(() => { if (full) createIcons({ icons, nameAttr, attrs, root }); });
  }
  window.lucide = Object.assign({ createIcons, createElement: mt, icons: SUB }, SUB);
})();
`;
fs.writeFileSync(path.join(PUB, 'vendor', 'lucide.subset.js'), out);
console.log(`lucide.subset.js: ${used.size} icons, ${(out.length / 1024).toFixed(1)} KB (full library ${(src.length / 1024).toFixed(0)} KB)`);

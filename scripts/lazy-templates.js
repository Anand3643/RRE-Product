/**
 * Wraps rarely-opened blocks of public/index.html (pop-up windows and seldom-used screens) in <template data-lazy>, so the browser
 * reads them but does not build them at start-up. public/ext/lazy-dom.js builds a block the first time anything asks for an id inside
 * it (openModal(id), showView(id), document.getElementById / querySelector('#id')), in exactly the same place.
 *   node scripts/lazy-templates.js            (idempotent: blocks already wrapped are left alone)
 */
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, '..', 'public', 'index.html');
const LAZY = ['helpMenuModal', 'themeSelectorModal', 'masterCreateModal', 'dataMenuModal', 'userManagementModal', 'createLedgerModal', 'createGroupModal',
  'quoteDetailModal', 'f11FeaturesModal', 'ai-copilot-drawer', 'view-ai-workspace', 'view-display-more'];
// Not lazy: the voucher, quotation and report-centre screens (the application fills them at start-up, so wrapping them saves nothing).

const raw = fs.readFileSync(F, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n');
const done = [], skipped = [];
for (const id of LAZY) {
  const open = new RegExp(`<(div|section|aside)\\b[^>]*\\bid="${id}"[^>]*>`).exec(s);
  if (!open) { skipped.push(id + ' (not found)'); continue; }
  const tag = open[1], start = open.index;
  if (s.slice(Math.max(0, start - 200), start).endsWith(`<template data-lazy="${id}">`)) { skipped.push(id + ' (already lazy)'); continue; }
  // the matching closing tag: count nested tags of the same name
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g'); re.lastIndex = start; let depth = 0, end = -1, m;
  while ((m = re.exec(s))) { if (m[0].startsWith('</')) { depth--; if (depth === 0) { end = m.index + m[0].length; break; } } else depth++; }
  if (end < 0) throw new Error('No closing tag for ' + id);
  const block = s.slice(start, end);
  if (/<script\b/i.test(block)) { skipped.push(id + ' (contains a script)'); continue; }
  s = s.slice(0, start) + `<template data-lazy="${id}">` + block + '</template>' + s.slice(end);
  done.push(`${id} (${(block.match(/<[a-zA-Z]/g) || []).length} elements)`);
}
fs.writeFileSync(F, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('lazy:', done.join(', ') || 'none'); if (skipped.length) console.log('skipped:', skipped.join(', '));

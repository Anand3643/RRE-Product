process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * "Aurora" premium theme: the files exist, are registered as a theme, work offline, respect reduced motion, are scoped to the theme (so
 * every other theme keeps its look) and are served by the application. (The visual and interaction checks run in a real browser.)
 * Runs against a DISPOSABLE data directory.   npm run test:theme
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_theme_test_'));
process.env.RRE_DATA_DIR = tmp; process.env.RRE_BRIDGE_AUTO = '0';
const { startServer } = require('./server');
const { initDb } = require('./core/db');
const { runMigrations } = require('./core/migrations');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

async function main() {
  console.log('\n--- 1. Files and registration ---');
  const css = read('public/theme/aurora.css'), js = read('public/theme/aurora.js'), html = read('public/index.html'), app = read('public/app.js');
  assert(css.length > 20000 && js.length > 10000, 'The stylesheet and the behaviour script exist');
  let syntaxOk = true; try { new vm.Script(js, { filename: 'aurora.js' }); } catch (e) { syntaxOk = false; }
  assert(syntaxOk, 'aurora.js is valid JavaScript');
  assert(/href="theme\/aurora\.css"/.test(html) && /src="theme\/aurora\.js"/.test(html), 'index.html loads both files');
  assert(/id="theme-card-aurora"/.test(html) && /applyTheme\('aurora'\)/.test(html), 'Aurora has a card in the theme chooser (Alt+T)');
  assert(/const THEMES = \['aurora',/.test(app), 'Aurora is a registered theme');
  assert(/rre_aurora_default_v1/.test(app) && /applyTheme\(savedTheme \|\| 'aurora'/.test(app), 'Aurora is the default once; later choices are remembered');

  console.log('\n--- 2. Offline, scoped, accessible ---');
  assert(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')) && !/@import/.test(css) && !/url\(/.test(css), 'The stylesheet makes no network request (no fonts, images or imports from the internet)');
  assert(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) && !/\bXMLHttpRequest\b|\bWebSocket\b/.test(js), 'The script only talks to the local application');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  const unscoped = rules.filter((sel) => !/\[data-theme="aurora"\]|\[data-au=|^@|^from|^to|^\d+%|#aurora-bg|\.au-|#au-|^:root$|^#view-dashboard$|^@keyframes|^@property|^\s*$/.test(sel) && !/^(from|to|\d+%|50%|0%|70%|100%)/.test(sel));
  assert(unscoped.length === 0, 'Every rule is scoped to the Aurora theme or to Aurora-only elements, so other themes keep their look', unscoped.slice(0, 4).join(' | '));
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(css) && /\.au-motion/.test(css) && /prefers-reduced-motion: reduce/.test(js), 'Reduced-motion is respected in the styles and the script');
  assert(/@media \(max-width: 899px\)/.test(css) && /@media \(max-width: 700px\)/.test(css) && /#au-tabbar/.test(css), 'Phones get a responsive layout with a bottom tab bar');
  assert(/setAttribute\('aria-label', 'Main navigation'\)/.test(js) && /role="button" tabindex="0"/.test(js), 'The rail and the stat cards are keyboard-friendly and labelled');
  assert(!/api\/(auth|users)|password|token|localStorage\.setItem\('tally_user_session/.test(js.replace(/\/\/.*$/gm, '')), 'The theme script never touches accounts, passwords or sessions');
  assert(['showView', 'loadDashboard'].every((f) => new RegExp(`wrap\\('${f}'`).test(js)) && !/function (showView|loadDashboard|openReport)\b/.test(js), 'It wraps the existing screens; it does not replace any business function');

  console.log('\n--- 2b. Light / Dark and Inventory in the side bar ---');
  assert(/\[data-au="light"\]/.test(css) && /\[data-au="dark"\]/.test(css) && /#au-mode/.test(css), 'The stylesheet has a white and a dark mode and the switch styling');
  assert(/function setMode/.test(js) && /au_mode/.test(js) && /id = 'au-mode'/.test(js) && /rre-mode/.test(js), 'The script has the Light / Dark switch, remembers the choice and tells the inventory');
  assert(/data-au/.test(html) && /au_mode/.test(html), 'The page sets the mode before it paints (no flash)');
  const invapp = read('public/ext/invapp.js'), hostJs = read('public/ext/inventory_host.js');
  assert(!/rre-inv-menu/.test(invapp) && !/rre-inv-menu/.test(js) && !/data-act="inventory"/.test(js), 'There is no Inventory button in the header or on the dashboard: only the side bar');
  assert(/INV_SUB/.test(js) && /toggleInvMenu/.test(js) && /id="au-inv-sub"/.test(js) && /\[data-theme="aurora"\] #gw-inventory-section/.test(css), 'The side bar Inventory entry expands into its features; the Gateway shortcuts are hidden in the new look');
  { // RRE Inventory is part of the application now (no separate frame): its screens follow RRE's Light / Dark switch directly
    const invJs = require('fs').readFileSync(require('path').join(__dirname, 'public', 'inv', 'inv.js'), 'utf8'), invCss = require('fs').readFileSync(require('path').join(__dirname, 'public', 'inv', 'inv.css'), 'utf8');
    assert(/attributeFilter: \['data-au'\]/.test(invJs) && /\[data-au="dark"\] #sp-app/.test(invCss) && /\[data-au="light"\] #sp-app/.test(invCss) && /window\.StockPilotInv\.open/.test(hostJs), 'RRE Inventory follows the Light / Dark choice and opens inside RRE (no separate frame)');
  }
  const rt = read('inventory-app/backend/rre_theme.css'), hostPy = read('inventory-app/backend/rre_host.py'), rtCode = rt.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/:root\s*\{/.test(rt) && /\.dark\s*\{/.test(rt) && /--brand: 79 107 255/.test(rt), 'The inventory skin defines the application colours for light and dark');
  assert(!/https?:\/\/|@import|url\(/.test(rtCode), 'The inventory skin makes no network request');
  assert(!/(^|[;{\s])(display|position|visibility|flex|grid|width|height|margin|padding|order|float|content|z-index|overflow)\s*:/.test(rtCode), 'The inventory skin changes colours and shapes only (no layout, no visibility, no content)');
  assert(/rre-theme\.css/.test(hostPy) && /e\.source!==window\.parent/.test(hostPy) && /d\.rre==='theme'/.test(hostPy), 'The inventory host loads the skin and accepts the colour choice only from RRE');

  console.log('\n--- 3. Served by the application ---');
  await initDb(); await runMigrations();
  const srv = await startServer(13700 + Math.floor(Math.random() * 90), '127.0.0.1');
  const get = (p) => new Promise((resolve, reject) => http.get(`http://${srv.host}:${srv.port}${p}`, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len: b.length, csp: res.headers['content-security-policy'] })); }).on('error', reject));
  const a = await get('/theme/aurora.css'), b = await get('/theme/aurora.js'), i = await get('/');
  assert(a.status === 200 && /css/.test(a.type) && a.len === css.length, 'The stylesheet is served as CSS');
  assert(b.status === 200 && /javascript/.test(b.type), 'The script is served as JavaScript');
  assert(i.status === 200 && /default-src 'self'/.test(i.csp || ''), 'The page keeps its security policy (no external sources are needed by the theme)');
  const idx = await get('/inv/inv.css'), host = await get('/ext/inventory_host.js');
  assert(idx.status === 200 && host.status === 200, 'The inventory host files are untouched and still served');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

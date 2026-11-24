/**
 * RRE Tally — runs YOUR ORIGINAL inventory application (StockPilot: React interface + FastAPI backend, in ./inventory-app) alongside RRE.
 *
 *  - The interface is the original, already-built one, served by the original backend (through inventory-app/backend/rre_host.py).
 *  - The backend runs as a private local process on 127.0.0.1 (never reachable from other computers), started on first use.
 *  - Its database is the original SQLite database (copied once from your StockPilot folder, never modified there), kept per RRE company
 *    in <company data dir>/inventory/stockpilot.db.
 *  - RRE's administrator is signed in with a one-minute, single-use, signed link (no second password to type). Everyone else uses the
 *    original inventory login and keeps the original roles.
 */
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { getDataDir, getCompanyNumber } = require('./db');
const { deriveSecret } = require('./security');
const { DEFAULT_COMPANY } = require('./paths');

const APP_DIR = path.resolve(__dirname, '..', 'inventory-app');
const BACKEND = path.join(APP_DIR, 'backend');
const isWin = process.platform === 'win32';
const state = { proc: null, port: null, company: null, python: null, error: null, starting: null, adopted: false };

const dir = () => path.join(getDataDir(), 'inventory');
const dbFile = () => path.join(dir(), 'stockpilot.db');
const infoFile = () => path.join(dir(), 'sidecar.json');
const fwd = (p) => p.replace(/\\/g, '/');
const bridgeSecret = () => deriveSecret('inventory-sso');
const secretKey = () => deriveSecret('inventory-jwt');

// ---------------------------------------------------------------------------------------------------- finding Python and the original data
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

async function findPython() {
  const venv = (root) => path.join(root, isWin ? 'Scripts/python.exe' : 'bin/python');
  const cands = [process.env.RRE_INVENTORY_PYTHON, venv(path.join(BACKEND, '.venv'))];
  try { for (const f of require('./invImport').detect()) cands.push(venv(path.join(path.dirname(f.path), '.venv'))); } catch (e) { /* optional */ }
  cands.push('python', 'python3', 'py');
  for (const c of cands.filter(Boolean)) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = await run(c, ['-c', 'import fastapi, sqlalchemy, uvicorn, jwt, bcrypt']);
    if (r.ok) return c;
  }
  return null;
}

/** Copies the original StockPilot database (safely, including anything still in its write-ahead log) the first time, for the main company only. */
async function ensureDatabase(python) {
  fs.mkdirSync(dir(), { recursive: true });
  if (fs.existsSync(dbFile())) return 'existing';
  if (String(getCompanyNumber()) !== String(DEFAULT_COMPANY) || process.env.RRE_INVENTORY_SEED === '0') return 'fresh'; // other companies (and test runs) start with an empty inventory
  let original = null;
  try { original = (require('./invImport').detect()[0] || {}).path; } catch (e) { /* none */ }
  if (!original) return 'fresh';
  const tmp = dbFile() + '.partial';
  try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
  const r = await run(python, ['-c', "import sqlite3,sys\ns=sqlite3.connect('file:'+sys.argv[1].replace('\\\\','/')+'?mode=ro',uri=True);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()", original, tmp]);
  if (!r.ok) { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } throw new Error('Could not copy your StockPilot database: ' + (r.stderr || '').slice(-200)); }
  fs.renameSync(tmp, dbFile());
  return 'copied';
}

// ---------------------------------------------------------------------------------------------------- the process
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function ping(port, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/rre/ping', timeout: ms }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(res.statusCode === 200 && /stockpilot/.test(b))); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
/** The process actually listening on the port (on Windows the venv's python.exe is only a launcher for the real one). */
async function pidOnPort(port) {
  if (!isWin) return null;
  const r = await run('netstat', ['-ano', '-p', 'tcp']);
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes(`127.0.0.1:${port} `) && /LISTENING/.test(l));
  return line ? parseInt(line.trim().split(/\s+/).pop(), 10) : null;
}
async function killTree(pid) {
  if (!pid || pid === process.pid || pid === process.ppid) return; // never our own process or the window that started us
  if (isWin) await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else { try { process.kill(-pid); } catch (e) { try { process.kill(pid); } catch (e2) { /* already gone */ } } }
}

async function adopt() {
  try {
    const i = JSON.parse(fs.readFileSync(infoFile(), 'utf8'));
    if (i && i.port && i.pid && alive(i.pid) && (await ping(i.port))) { Object.assign(state, { proc: null, port: i.port, pid: i.pid, adopted: true, company: String(getCompanyNumber()), error: null }); return true; }
  } catch (e) { /* nothing to adopt */ }
  return false;
}

async function doStart() {
  if (state.port && String(state.company) === String(getCompanyNumber()) && (await ping(state.port))) return;
  await stop(); // a different company (or a dead process) needs a fresh one
  if (await adopt()) return;
  const python = await findPython();
  if (!python) throw new Error('Python with the inventory requirements was not found. Create the environment with:  python -m venv inventory-app/backend/.venv  then  inventory-app/backend/.venv/Scripts/python -m pip install -r inventory-app/backend/requirements.txt');
  const seeded = await ensureDatabase(python);
  const port = await freePort();
  fs.mkdirSync(path.join(dir(), 'uploads'), { recursive: true });
  const log = fs.openSync(path.join(dir(), 'sidecar.log'), 'a');
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', DATABASE_URL: `sqlite:///${fwd(dbFile())}`, UPLOAD_DIR: path.join(dir(), 'uploads'), SECRET_KEY: secretKey(), RRE_BRIDGE_SECRET: bridgeSecret(), RRE_HOME_URL: `http://127.0.0.1:${process.env.PORT || 4000}`,
    CORS_ORIGINS: `http://127.0.0.1:${process.env.PORT || 4000},http://localhost:${process.env.PORT || 4000}` };
  const proc = spawn(python, ['-m', 'uvicorn', 'rre_host:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], { cwd: BACKEND, env, stdio: ['ignore', log, log], windowsHide: true, detached: !isWin });
  Object.assign(state, { proc, port, python, company: String(getCompanyNumber()), adopted: false, error: null, seeded });
  proc.on('exit', () => { if (state.proc === proc) { state.proc = null; state.port = null; } });
  for (let i = 0; i < 90; i++) {
    if (await ping(port)) { state.pid = (await pidOnPort(port)) || proc.pid; fs.writeFileSync(infoFile(), JSON.stringify({ pid: state.pid, launcher: proc.pid, port, started: new Date().toISOString() })); return; }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = (() => { try { return fs.readFileSync(path.join(dir(), 'sidecar.log'), 'utf8').slice(-400); } catch (e) { return ''; } })();
  await stop();
  throw new Error('The inventory application did not start. ' + tail.replace(/\s+/g, ' ').trim());
}

function ensureStarted() {
  if (!state.starting) state.starting = doStart().then(() => { state.error = null; }, (e) => { state.error = e.message; throw e; }).finally(() => { state.starting = null; });
  return state.starting;
}

async function stop() {
  const { proc, pid } = state;
  state.proc = null; state.port = null; state.pid = null; state.adopted = false;
  try { await killTree(pid || (proc && proc.pid)); if (proc && proc.pid !== pid) await killTree(proc.pid); } catch (e) { /* already gone */ }
  try { fs.unlinkSync(infoFile()); } catch (e) { /* none */ }
}

// ---------------------------------------------------------------------------------------------------- one-minute single-use sign-in link
const b64 = (b) => Buffer.from(b).toString('base64url');
// RRE role -> the inventory application's role. Only an RRE administrator becomes an inventory owner: nobody is ever promoted by a mapping.
const INV_ROLE = { Owner: 'owner', Administrator: 'owner', Accountant: 'accountant', 'Data Entry': 'warehouse', Auditor: 'viewer', Viewer: 'viewer', Guest: 'viewer' };
/** claims: { as: 'admin' | 'user' | 'sync', email, name, role (RRE role), active } — signed with the secret only RRE and its inventory process share. */
function ssoToken(claims = {}) {
  const c = typeof claims === 'string' ? { as: claims } : claims;
  const as = c.as || 'user';
  const payload = { exp: Math.floor(Date.now() / 1000) + 60, jti: crypto.randomBytes(12).toString('hex'), as };
  if (as !== 'admin') Object.assign(payload, { email: String(c.email || '').toLowerCase(), name: String(c.name || '').slice(0, 120), role: INV_ROLE[c.role] || 'viewer', active: c.active !== false });
  else Object.assign(payload, { email: String(c.email || '').toLowerCase(), name: String(c.name || '').slice(0, 120) });
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', bridgeSecret()).update(body).digest('base64url')}`;
}

/** Starts the inventory application if needed and returns the address to open. `admin` signs the administrator in; otherwise the original login is shown. */
async function launch({ user = null, admin = false, path: sub = '/', wait = true } = {}) {
  if (!wait && !(state.port && (await ping(state.port, 800)))) { ensureStarted().catch(() => { /* the reason is kept in state.error and shown by status() */ }); return { starting: true }; } // answer at once; the screen waits for the start-up
  await ensureStarted();
  const p = /^\/[A-Za-z0-9\-_/]*$/.test(sub) ? sub : '/';
  const claims = user ? { as: INV_ROLE[user.role] === 'owner' ? 'admin' : 'user', email: user.email, name: user.full_name || user.username, role: user.role } : { as: admin ? 'admin' : 'user', role: admin ? 'Owner' : 'Viewer' };
  return { url: `http://127.0.0.1:${state.port}${p}?sso=${ssoToken(claims)}`, port: state.port };
}

function status() {
  return { available: fs.existsSync(path.join(APP_DIR, 'frontend', 'dist', 'index.html')), running: !!state.port, starting: !!state.starting, port: state.port, error: state.error, database: fs.existsSync(dbFile()) ? 'ready' : 'not created yet' };
}

// when RRE quits normally the inventory process goes with it (after a hard kill it keeps running and RRE adopts it again on the next start)
process.on('exit', () => {
  try {
    const pid = state.pid || (state.proc && state.proc.pid);
    if (pid) { if (isWin) require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid); }
  } catch (e) { /* ignore */ }
});

/** Tells the running inventory application that an RRE account changed (role, name, deactivated, signed out): it updates its projection and ends that person's inventory sessions. */
function syncUser(user, { active = true } = {}) {
  return new Promise((resolve) => {
    if (!state.port || !user || !user.email) return resolve(false);
    const body = JSON.stringify({ token: ssoToken({ as: 'sync', email: user.email, name: user.full_name || user.username, role: user.role, active }) });
    const r = require('http').request({ host: '127.0.0.1', port: state.port, path: '/api/rre/sync', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 4000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); }); r.write(body); r.end();
  });
}

module.exports = { launch, status, ensureStarted, stop, findPython, _state: state, ssoToken, syncUser, INV_ROLE };

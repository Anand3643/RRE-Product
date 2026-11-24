/**
 * RRE Tally — multiple companies on one PC.
 *
 * Each company has its own folder and database (core/paths.js), so companies cannot see each other's data.
 * Creating a company never touches the others; switching only changes which database this app has open.
 * Companies are never deleted by this module. Sessions are tied to a company (see core/auth.js), so after a switch
 * everyone must sign in again to the company they are now in.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const paths = require('./paths');
const { runMigrations } = require('./migrations');
const { withTransaction } = require('./tx');
const { hashPassword } = require('./security');
const { logActivity } = require('./auth');

let switching = false;
const isSwitching = () => switching;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const now = () => new Date().toISOString();

/** Refuses API calls for the instant the database is being swapped, so no request can run against the wrong company. */
function gate(req, res, next) {
  if (switching && req.originalUrl.startsWith('/api/')) {
    return res.status(503).json({ success: false, error: 'Switching company. Please retry in a moment.', retry: true });
  }
  next();
}

async function liveName() {
  const r = await db.get('SELECT name FROM company_info LIMIT 1');
  return (r && r.name) || 'Company';
}

async function registry() {
  const active = db.getCompanyNumber();
  if (db.singleFolderMode) return { active, companies: [{ number: active, name: await liveName(), created_at: null }], single: true };
  let reg = paths.readRegistry();
  if (!reg) {
    reg = { active, companies: [{ number: active, name: await liveName(), created_at: now() }] };
    paths.writeRegistry(reg);
  }
  return reg;
}

async function list() {
  const reg = await registry();
  const active = db.getCompanyNumber();
  const out = [];
  for (const c of reg.companies) {
    out.push({ number: c.number, name: c.number === active ? await liveName() : c.name, created_at: c.created_at || null, created_by: c.created_by || null, active: c.number === active });
  }
  return { active, can_create: !db.singleFolderMode, companies: out };
}

function validateNew(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 80) throw bad('Company name must be 2–80 characters.');
  const username = String(b.owner_username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw bad('Owner username must be 3–30 characters (letters, digits, . _ -).');
  const password = String(b.owner_password || '');
  const weak = require('./passwordPolicy').checkPassword(password, { username });
  if (weak) throw bad('Owner password: ' + weak);
  const fy = b.financial_year_from ? String(b.financial_year_from) : `${new Date().getFullYear()}-04-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fy) || Number.isNaN(Date.parse(fy))) throw bad('financial_year_from must be YYYY-MM-DD.');
  const gstin = String(b.gstin || '').trim().toUpperCase();
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw bad('GSTIN format is invalid.');
  return { name, username, password, fy, gstin, pan: String(b.pan || '').trim().toUpperCase().slice(0, 10), state: String(b.state || 'Tamil Nadu').slice(0, 40),
    state_code: String(b.state_code || '33').slice(0, 2), full_name: String(b.owner_full_name || username).trim().slice(0, 80), address: String(b.address || '').slice(0, 200) };
}

function nextNumber(reg) {
  let max = 100000;
  for (const c of reg.companies) max = Math.max(max, parseInt(c.number, 10) || 0);
  try { for (const f of fs.readdirSync(paths.ROOT)) if (/^\d{6}$/.test(f)) max = Math.max(max, parseInt(f, 10)); } catch (e) { /* ignore */ }
  return String(max + 1);
}

async function reopen(number) { await db.switchDatabase(number); await db.initDb(); await runMigrations(); await require('./identity').preload(); }

async function create(body, user) {
  if (db.singleFolderMode) throw bad('Creating companies is unavailable in single-folder mode.', 409);
  if (switching) throw bad('Another company operation is in progress. Try again in a moment.', 409);
  const v = validateNew(body);
  const reg = await registry();
  if (reg.companies.some((c) => c.name.trim().toLowerCase() === v.name.toLowerCase())) throw bad(`A company named "${v.name}" already exists.`, 409);
  const original = db.getCompanyNumber();
  const number = nextNumber(reg);

  switching = true;
  try {
    await withTransaction(async () => {}); // let queued transactions finish before the database is swapped
    await reopen(number);
    await db.resetCleanCompany();           // clean books: no demo vouchers, ledgers or items (takes a safety snapshot of the empty file)
    // Start from a minimal, neutral set of masters (the invoice screens look up these exact ledger names)
    await db.run('DELETE FROM godowns'); await db.run('DELETE FROM cost_centres'); await db.run('DELETE FROM stock_groups');
    await db.run("INSERT INTO godowns (name, location) VALUES ('Main Location', 'Primary Godown')");
    await db.run("INSERT INTO cost_centres (name, category) VALUES ('Primary Cost Centre', 'Default')");
    await db.run("INSERT INTO stock_groups (name) VALUES ('Primary')");
    // resetCleanCompany() already created the standard ledgers (Cash, Bank, Capital, Sales, Purchase, Round Off, GST ...).
    // The invoice screens also look up GST ledgers by these exact names, so add them, and apply this company's state to all ledgers.
    const gstLedgers = ['Input CGST 9%', 'Input SGST 9%', 'Input IGST 18%', 'Output CGST 9%', 'Output SGST 9%', 'Output IGST 18%'];
    for (const n of gstLedgers) await db.run('INSERT OR IGNORE INTO ledgers (name, group_id, opening_balance, opening_balance_type) VALUES (?, 20, 0, ?)', [n, n.startsWith('Output') ? 'Cr' : 'Dr']);
    await db.run('UPDATE ledgers SET state = ?, state_code = ?', [v.state, v.state_code]);
    await db.run(`UPDATE company_info SET company_number = ?, name = ?, formal_name = ?, financial_year_from = ?, books_beginning_from = ?, gstin = ?, pan = ?, address = ?, state = ?, state_code = ? WHERE id = 1`,
      [number, v.name, v.name, v.fy, v.fy, v.gstin, v.pan, v.address, v.state, v.state_code]);
    // Only the owner chosen here can sign in to the new company (no demo accounts)
    await db.run('DELETE FROM user_logins'); await db.run('DELETE FROM users');
    await db.run(`INSERT INTO users (username, password, full_name, role, email, status, allow_backdated_entries) VALUES (?, ?, ?, 'Owner', '', 'Active', 1)`, [v.username, hashPassword(v.password), v.full_name]);
    await reopen(original);
    reg.companies.push({ number, name: v.name, created_at: now(), created_by: user ? user.username : null });
    paths.writeRegistry({ ...reg, active: original });
  } catch (err) {
    try { await reopen(original); } catch (e) { /* best effort: original database stays untouched */ }
    throw err;
  } finally {
    switching = false;
  }
  await logActivity({ user, action: 'COMPANY_CREATE', entity: 'company', entityId: number, details: { name: v.name } });
  return { number, name: v.name };
}

async function switchTo(number, user) {
  if (db.singleFolderMode) throw bad('Switching companies is unavailable in single-folder mode.', 409);
  if (switching) throw bad('Another company operation is in progress. Try again in a moment.', 409);
  const reg = await registry();
  const target = reg.companies.find((c) => c.number === String(number));
  if (!target) throw bad('Company not found.', 404);
  const original = db.getCompanyNumber();
  if (String(number) === original) return { active: original, name: await liveName(), changed: false };
  if (!fs.existsSync(path.join(paths.companyDir(number), 'company.db'))) throw bad('That company\'s data file is missing.', 409);

  await logActivity({ user, action: 'COMPANY_SWITCH', entity: 'company', entityId: number, details: { from: original, to: String(number) } });
  switching = true;
  try {
    await withTransaction(async () => {});
    await reopen(String(number));
    paths.writeRegistry({ ...reg, active: String(number) });
  } catch (err) {
    try { await reopen(original); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    switching = false;
  }
  return { active: String(number), name: await liveName(), changed: true, note: 'Everyone is signed out and must sign in to this company.' };
}

module.exports = { list, create, switchTo, gate, isSwitching };

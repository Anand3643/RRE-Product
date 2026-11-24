/**
 * RRE Entries — brings every existing person into the ONE user table, safely.
 *
 *   1. RRE's own accounts stay exactly where they are (ids, roles, history keep working). They are only checked: duplicate e-mail
 *      addresses and accounts without an e-mail are reported for the administrator to fix; nothing is merged by guessing.
 *      Their password hashes keep working (old formats are upgraded to Argon2id at the person's next sign-in).
 *   2. The inventory application's accounts (read-only look at its database) are linked to an RRE account ONLY when the e-mail
 *      address is exactly the same. A person with no RRE account gets one, flagged "review": inventory owners / admins are NEVER
 *      made administrators here (they become Accountants for the administrator to confirm), and the password is not copied (it is
 *      impossible to carry over a hash of another format), so they choose a password with "Forgot password" before first use.
 *      Customer logins are linked to the customer account the bridge already created for them, only when that link is certain.
 *   3. Nothing is deleted. The inventory database is not changed. The result is stored as a report and can be repeated safely.
 *
 *  dry run (default) only describes what would happen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword } = require('./security');
const { get, all, run } = db;

const lc = (s) => String(s || '').trim().toLowerCase();
const INV_TO_RRE = { owner: 'Accountant', admin: 'Accountant', manager: 'Accountant', accountant: 'Accountant', warehouse: 'Data Entry', sales: 'Data Entry', viewer: 'Viewer' };
const dbFile = () => path.join(db.getDataDir(), 'inventory', 'stockpilot.db');

async function uniqueUsername(base) {
  let u = lc(base).replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user', n = 0;
  while (await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [n ? `${u}${n}` : u])) n++;
  return n ? `${u}${n}` : u;
}

async function checkRreAccounts(report) {
  const users = await all("SELECT id, username, full_name, email, role, status FROM users WHERE role <> 'Guest'");
  const byEmail = new Map();
  for (const u of users) { const e = lc(u.email); if (!e) continue; (byEmail.get(e) || byEmail.set(e, []).get(e)).push(u); }
  report.rre = { accounts: users.length, without_email: users.filter((u) => !lc(u.email)).map((u) => ({ id: u.id, username: u.username, role: u.role })), duplicate_emails: [...byEmail.entries()].filter(([, a]) => a.length > 1).map(([email, a]) => ({ email, accounts: a.map((x) => ({ id: x.id, username: x.username, role: x.role })) })) };
}

async function readInventoryUsers() {
  const imp = require('./invImport');
  const src = await imp.openSource(dbFile());
  try {
    if (!src.names.has('users')) return [];
    return await src.q('SELECT id, email, name, role, is_active, phone, customer_id, last_login, created_at FROM users ORDER BY id');
  } finally { src.close(); }
}

async function run_({ apply = false, actor = null } = {}) {
  const report = { applied: !!apply, at: new Date().toISOString(), rre: null, inventory: { source: null, linked: [], created: [], customers_linked: [], skipped: [] } };
  await checkRreAccounts(report);
  if (!fs.existsSync(dbFile())) { report.inventory.source = 'not found'; }
  else {
    report.inventory.source = 'read';
    let invUsers = [];
    try { invUsers = await readInventoryUsers(); } catch (e) { report.inventory.source = 'unreadable: ' + e.message; }
    for (const iu of invUsers) {
      const email = lc(iu.email), tag = { inventory_user: iu.id, email, role: iu.role };
      if (!email) { report.inventory.skipped.push({ ...tag, reason: 'no e-mail address' }); continue; }
      const matches = await all('SELECT id, username, role, status FROM users WHERE email = ? COLLATE NOCASE', [email]);
      if (matches.length > 1) { report.inventory.skipped.push({ ...tag, reason: 'several RRE accounts share this e-mail: resolve the duplicates first' }); continue; }
      if (matches.length === 1) { report.inventory.linked.push({ ...tag, rre_user: matches[0].id, rre_role: matches[0].role, note: 'same e-mail: the RRE account is used, its role is not changed' }); continue; }
      if (iu.role === 'user') { // a customer portal login of the old inventory application
        const map = iu.customer_id ? await all("SELECT DISTINCT rre_id FROM inv_import_map WHERE kind = 'customer' AND src_id = ?", [String(iu.customer_id)]).catch(() => []) : [];
        if (map.length !== 1) { report.inventory.skipped.push({ ...tag, reason: 'customer login whose customer account could not be matched with certainty' }); continue; }
        const party = await get('SELECT id, name FROM ledgers WHERE id = ?', [map[0].rre_id]);
        if (!party) { report.inventory.skipped.push({ ...tag, reason: 'customer account missing' }); continue; }
        const row = { ...tag, customer: party.name, rre_role: 'Customer' };
        if (apply) {
          const username = await uniqueUsername(email.split('@')[0]);
          await run(`INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password, party_id, needs_review, created_by) VALUES (?, ?, ?, 'Customer', ?, ?, ?, 0, 1, ?, 1, ?)`,
            [username, hashPassword(crypto.randomBytes(24).toString('hex')), String(iu.name || email).slice(0, 80), email, iu.phone || '', iu.is_active ? 'Active' : 'Inactive', party.id, actor ? actor.userId : null]);
        }
        report.inventory.customers_linked.push(row); continue;
      }
      const rreRole = INV_TO_RRE[iu.role] || 'Viewer';
      const row = { ...tag, rre_role: rreRole, note: ['owner', 'admin'].includes(iu.role) ? 'was an inventory administrator: created as Accountant, an RRE administrator must confirm any promotion' : '' };
      if (apply) {
        const username = await uniqueUsername(email.split('@')[0]);
        await run(`INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password, needs_review, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)`,
          [username, hashPassword(crypto.randomBytes(24).toString('hex')), String(iu.name || email).slice(0, 80), rreRole, email, iu.phone || '', iu.is_active ? 'Active' : 'Inactive', actor ? actor.userId : null]);
      }
      report.inventory.created.push(row);
    }
  }
  report.summary = { rre_accounts: report.rre.accounts, duplicate_emails: report.rre.duplicate_emails.length, without_email: report.rre.without_email.length, inventory_linked: report.inventory.linked.length, inventory_created: report.inventory.created.length, customers_linked: report.inventory.customers_linked.length, skipped: report.inventory.skipped.length };
  if (apply) {
    await run('INSERT INTO identity_migrations (key, ran_at, report) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ran_at = excluded.ran_at, report = excluded.report', ['inventory_users_v1', report.at, JSON.stringify(report).slice(0, 500000)]);
    try { await require('./identity').refreshAll(); await require('./identity').audit('AUTH_MIGRATION_APPLIED', { userId: actor && actor.userId, username: actor && actor.username, role: actor && actor.role, details: report.summary }); } catch (e) { /* ignore */ }
  }
  return report;
}

async function lastReport() {
  const r = await get("SELECT ran_at, report FROM identity_migrations WHERE key = 'inventory_users_v1'");
  if (!r) return null;
  try { return JSON.parse(r.report); } catch (e) { return { at: r.ran_at }; }
}

module.exports = { run: run_, lastReport };

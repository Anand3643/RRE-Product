#!/usr/bin/env node
/**
 * RRE Entries — recovery tool, run on the computer where RRE is installed (nobody can run it remotely).
 * Sets the administrator's e-mail address and/or password without anyone being able to read the old password.
 *
 *   npm run admin:reset                         asks for the administrator username (default "admin"), e-mail and new password
 *   npm run admin:reset -- --user admin --email you@company.com      only set the e-mail (so "Forgot password" works)
 *
 * The password is typed here, hashed (Argon2id) and never printed or stored anywhere else. All other sessions of that account end.
 */
const readline = require('readline');
require('../core/env').load();
const { initDb, get, run, closeDb } = require('../core/db');
const { runMigrations } = require('../core/migrations');
const { hashPassword } = require('../core/security');
const { checkPassword } = require('../core/passwordPolicy');

const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else if (/[\r\n]/.test(s)) rl.output.write(s); else rl.output.write('*'); }; }
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}
(async () => {
  await initDb(); await runMigrations();
  const username = (opt('user') || (await ask('Administrator username [admin]: ')) || 'admin').trim();
  const user = await get("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND role = 'Owner'", [username]);
  if (!user) { console.error(`No administrator named "${username}" was found.`); process.exit(1); }
  let email = opt('email'); if (email === null && !args.includes('--email')) email = (await ask(`E-mail address [${user.email || 'none'}]: `)).trim();
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('That is not a valid e-mail address.'); process.exit(1); }
    const dup = await get('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?', [email, user.id]);
    if (dup) { console.error('That e-mail address belongs to another account.'); process.exit(1); }
    await run('UPDATE users SET email = ? WHERE id = ?', [email.toLowerCase(), user.id]); console.log('E-mail address saved.');
  }
  if (!args.includes('--email') || args.includes('--password')) {
    const pw = process.env.RRE_NEW_PASSWORD || (await ask('New password (leave empty to keep the current one): ', true));
    if (pw) {
      const weak = checkPassword(pw, { username: user.username }); if (weak) { console.error(weak); process.exit(1); }
      if (!process.env.RRE_NEW_PASSWORD) { const again = await ask('Repeat the password: ', true); if (again !== pw) { console.error('The two passwords are not the same.'); process.exit(1); } }
      await run('UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ?, failed_logins = 0, locked_until = NULL, status = ? WHERE id = ?', [hashPassword(pw.trim()), new Date().toISOString(), 'Active', user.id]);
      await run('UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL', [new Date().toISOString(), 'password_reset_cli', user.id]);
      await run("INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, 'Owner', 'AUTH_PASSWORD_RESET', 'auth', ?, ?)", [user.id, user.username, String(user.id), JSON.stringify({ via: 'cli' })]).catch(() => {});
      console.log('Password changed. Open RRE Entries and sign in with it.');
    }
  }
  await closeDb(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

/**
 * Runs existing test suites against PostgreSQL instead of SQLite, unchanged:
 *   node scripts/test-pg.js test_auth_unified.js [more test files...]      npm run test:pg -- test_portal.js
 * A local PostgreSQL 17 (same major version as Supabase) runs in the system temp folder; every suite gets a brand-new database with the
 * migrations applied, and its prepared SQLite copy is imported at start (RRE_PG_IMPORT_SQLITE=1). The database is dropped afterwards.
 * Set DATABASE_URL_TEST to use another PostgreSQL server instead (it must allow CREATE DATABASE).
 */
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node scripts/test-pg.js <test file> [...]'); process.exit(2); }
  let server = null, base = process.env.DATABASE_URL_TEST;
  if (!base) { server = await require('./pg-local').start({ dir: path.join(os.tmpdir(), 'rre-pg-test-cluster'), port: 54331 }); base = server.url; }
  const { Client } = require('pg');
  const admin = new Client({ connectionString: base }); await admin.connect();
  const results = [];
  for (const f of files) {
    const name = 'rre_t_' + process.pid + '_' + results.length;
    await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(base); u.pathname = '/' + name; const url = u.toString();
    await require('./pg-migrate').migrate(url, { log: () => {} });
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [f], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, RRE_DB: 'postgres', DATABASE_URL: url, RRE_PG_IMPORT_SQLITE: '1', RRE_PG_LOG_ERRORS: process.env.RRE_PG_LOG_ERRORS || '1' } });
      p.on('exit', (c) => resolve(c));
    });
    results.push({ f, code });
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
  await admin.end(); if (server) await server.stop();
  console.log('\n=== PostgreSQL run ===');
  for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.f}${r.code === 0 ? '' : ' (exit ' + r.code + ')'}`);
  process.exit(results.every((r) => r.code === 0) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

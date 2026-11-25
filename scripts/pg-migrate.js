/**
 * Applies db/postgres/migrations/*.sql to the database in DATABASE_URL, in order, each file once and inside a transaction.
 *   node scripts/pg-migrate.js            (reads .env)     npm run db:migrate
 * Applied files are recorded in rre_meta.schema_versions together with their SHA-256, and a file that was changed after it ran is refused.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'db', 'postgres', 'migrations');

async function migrate(url, { log = console.log } = {}) {
  const { Client } = require('pg');
  const c = new Client(require('../core/pgAdapter').connectionOptions(url));
  await c.connect();
  try {
    await c.query('CREATE SCHEMA IF NOT EXISTS rre_meta');
    await c.query('CREATE TABLE IF NOT EXISTS rre_meta.schema_versions (file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await c.query('REVOKE ALL ON SCHEMA rre_meta FROM PUBLIC');
    const done = new Map((await c.query('SELECT file, sha256 FROM rre_meta.schema_versions')).rows.map((r) => [r.file, r.sha256]));
    const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    let applied = 0;
    for (const f of files) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8'), sha = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) { if (done.get(f) !== sha) throw new Error(`${f} was changed after it was applied. Add a new migration file instead of editing an applied one.`); continue; }
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO rre_meta.schema_versions (file, sha256) VALUES ($1, $2)', [f, sha]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw new Error(`${f}: ${e.message}${e.position ? ' (at character ' + e.position + ')' : ''}`); }
      log('applied ' + f); applied++;
    }
    log(applied ? `${applied} migration(s) applied.` : 'Database schema is up to date.');
    return applied;
  } finally { await c.end(); }
}

module.exports = { migrate, DIR };
if (require.main === module) {
  require('../core/env').load();
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. Put it in .env (see docs/CLOUD_DATABASE.md).'); process.exit(1); }
  migrate(url).catch((e) => { console.error('Migration failed: ' + e.message); process.exit(1); });
}

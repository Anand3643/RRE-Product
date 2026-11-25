/**
 * Local PostgreSQL for development and tests (no install, no Docker): `node scripts/pg-local.js [dataDir] [port]`.
 * Prints the DATABASE_URL to use. This is NOT for production: production uses Supabase (see docs/CLOUD_DATABASE.md).
 * Also usable from code: `const pg = await require('./scripts/pg-local').start({ dir, port })` -> { url, stop }.
 */
const path = require('path');
const fs = require('fs');

async function start({ dir = path.join(__dirname, '..', '.pg-local'), port = 54329, password = 'rre_local_dev' } = {}) {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));
  // a test run that was killed leaves its lock file behind: remove it only when nothing listens on the port any more
  const lock = path.join(dir, 'postmaster.pid');
  if (fs.existsSync(lock)) {
    const busy = await new Promise((resolve) => { const s = require('net').connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (busy) throw new Error(`A PostgreSQL server is already running on port ${port} with ${dir}. Stop it first.`);
    fs.rmSync(lock, { force: true });
  }
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C', '--auth=scram-sha-256'], onLog: () => {}, onError: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  return { url, stop: () => pg.stop(), client: () => pg.getPgClient() };
}

module.exports = { start };

if (require.main === module) {
  const [dir, port] = process.argv.slice(2);
  start({ dir: dir ? path.resolve(dir) : undefined, port: port ? +port : undefined }).then((p) => {
    console.log('Local PostgreSQL is running.\nDATABASE_URL=' + p.url + '\nPress Ctrl+C to stop.');
    const bye = () => p.stop().then(() => process.exit(0));
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }).catch((e) => { console.error('Could not start local PostgreSQL:', e.message); process.exit(1); });
}

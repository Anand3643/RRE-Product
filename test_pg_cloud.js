/**
 * Cloud database (PostgreSQL / Supabase) suite. Starts its own temporary PostgreSQL 17, so it needs no credentials and touches no real data
 * (company files are only read, to copy them into the temporary database).
 *   node test_pg_cloud.js
 * Checks: migrations, the copy of real companies, company isolation enforced BY THE DATABASE (raw SQL, writes, references),
 * exact money arithmetic, simultaneous writes, and a backup -> restore round trip into a second database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') { if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}${detail ? ' (' + detail + ')' : ''}`); failed++; } }
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function main() {
  const cluster = await require('./scripts/pg-local').start({ dir: path.join(os.tmpdir(), 'rre-pg-cloud-test-' + process.pid), port: 54340 + (process.pid % 50) });
  const { Client } = require('pg');
  const admin = new Client({ connectionString: cluster.url }); await admin.connect();
  const mk = async (name) => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${name}`); const u = new URL(cluster.url); u.pathname = '/' + name; return u.toString(); };
  const urlA = await mk('rre_cloud_a'), urlB = await mk('rre_cloud_b');
  const { migrate } = require('./scripts/pg-migrate');

  console.log('\n--- 1. Migrations ---');
  assert(await migrate(urlA, { log: () => {} }) >= 4, 'all migrations apply to a brand-new database');
  assert(await migrate(urlA, { log: () => {} }) === 0, 'running them again changes nothing');
  const raw = new Client({ connectionString: urlA }); await raw.connect();
  const tables = (await raw.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'rre'")).rows[0].n;
  const rls = (await raw.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'rre' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].n;
  assert(tables >= 53 && rls === tables, 'every RRE table has row level security switched on and forced', `${rls}/${tables}`);
  const floats = (await raw.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'rre' AND data_type IN ('real', 'double precision')")).rows[0].n;
  assert(floats === 0, 'no column stores money or quantities as floating point');
  // schema parity: every table and column the application creates on SQLite (all its migrations) exists in PostgreSQL
  const { freshSqlite, introspect } = require('./scripts/pg-schema');
  const fresh = await freshSqlite();
  const sq = await introspect(fresh.file); fs.rmSync(fresh.dir, { recursive: true, force: true });
  const pgCols = new Set((await raw.query("SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'rre'")).rows.map((r) => r.k));
  const missing = sq.tables.flatMap((t) => t.cols.map((c) => `${t.name}.${c.name}`)).filter((k) => !pgCols.has(k));
  assert(missing.length === 0, `PostgreSQL has every table and column of the SQLite schema (${sq.tables.length} tables, all ${require('./core/migrations').MIGRATIONS.length} migrations)`, missing.slice(0, 10).join(', '));

  console.log('\n--- 2. Copying real companies (read-only) ---');
  const adapter = require('./core/pgAdapter');
  await adapter.init(urlA, { max: 6 });
  const { importCompany } = require('./core/pgImport');
  const live = path.join(__dirname, 'data');
  const companies = ['100000', ...fs.readdirSync(live).filter((d) => /^U\d+$/.test(d) && fs.existsSync(path.join(live, d, 'company.db')))].slice(0, 3);
  const before = companies.map((c) => fs.statSync(path.join(live, c, 'company.db')).mtimeMs);
  const imported = {};
  for (const co of companies) imported[co] = await importCompany({ sqliteFile: path.join(live, co, 'company.db'), company: co });
  assert(Object.values(imported).every((r) => Math.abs(r.debit - r.credit) < 0.005), `${companies.length} companies copied and verified; debits equal credits in each`, companies.join(', '));
  assert(companies.every((c, i) => fs.statSync(path.join(live, c, 'company.db')).mtimeMs === before[i]), 'the original company files were not changed');
  const e1 = await rejects(importCompany({ sqliteFile: path.join(live, '100000', 'company.db'), company: '100000' }));
  assert(e1 && /already has data/.test(e1.message), 'copying over a company that already has data is refused without --replace');

  console.log('\n--- 3. Company isolation enforced by the database ---');
  const app = new Client({ connectionString: urlA }); await app.connect();
  await app.query('SET ROLE rre_app; SET search_path = rre, public');
  const as = async (co) => app.query("SELECT set_config('rre.company_id', $1, false)", [co]);
  const count = async (t) => (await app.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  await as('');
  assert(await count('vouchers') === 0 && await count('ledgers') === 0 && await count('users') === 0, 'with no company chosen, not a single row is visible');
  await as('100000'); const vA = await count('vouchers'), lA = await count('ledgers');
  assert(vA === imported['100000'].tables.find((t) => t.table === 'vouchers').rows, 'company 100000 sees exactly its own vouchers', String(vA));
  if (companies[1]) {
    const other = companies[1];
    await as(other); const vB = await count('vouchers'), lB = await count('ledgers');
    assert(vB === imported[other].tables.find((t) => t.table === 'vouchers').rows && lB !== lA + lB - lB, `company ${other} sees only its own rows`, `${vB} vouchers`);
    await as('100000');
    const e2 = await rejects(app.query("INSERT INTO godowns (company_no, name) VALUES ($1, 'Smuggled')", [other]));
    assert(e2 && /row-level security/.test(e2.message), 'writing a row into another company is refused by the database');
    const u = await app.query("UPDATE ledgers SET name = name || ' X' WHERE company_no = $1", [other]);
    assert(u.rowCount === 0, 'another company\'s rows cannot be changed (0 rows affected)');
    const d = await app.query('DELETE FROM vouchers WHERE company_no = $1', [other]);
    assert(d.rowCount === 0, 'another company\'s rows cannot be deleted (0 rows affected)');
    await as(other); const vOther = (await app.query('SELECT id FROM vouchers ORDER BY id LIMIT 1')).rows[0];
    await as('100000');
    void vOther;
    // a voucher id that exists only in the OTHER company: the reference is checked against (company_no, id)
    await as(other); const ins = await app.query("INSERT INTO vouchers (id, voucher_type, voucher_no, date, total_amount) VALUES (900000, 'Journal', 'T-FK-OTHER', '2026-04-01', 1) RETURNING id"); const otherId = ins.rows[0].id;
    await as('100000'); const mine = (await app.query('SELECT count(*)::int n FROM vouchers WHERE id = $1', [otherId])).rows[0].n;
    const e3 = mine ? null : await rejects(app.query("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount) VALUES ($1, (SELECT min(id) FROM ledgers), 'Dr', 1)", [otherId]));
    assert(mine === 0 && e3 && /foreign key/.test(e3.message), 'a row cannot point at a record of another company (the reference is refused)');
    await as(other); await app.query("DELETE FROM vouchers WHERE voucher_no = 'T-FK-OTHER'"); await as('100000');
  }
  await as('');
  await raw.query('DROP ROLE IF EXISTS rre_outsider'); await raw.query('CREATE ROLE rre_outsider NOLOGIN');
  const e4 = await rejects(raw.query('SET ROLE rre_outsider; SELECT count(*) FROM rre.vouchers'));
  await raw.query('RESET ROLE');
  assert(e4 && /permission denied/.test(e4.message), 'any other database role (such as Supabase\'s public web API roles) has no access to RRE data');

  console.log('\n--- 4. Exact money ---');
  await as('100000');
  await app.query('BEGIN');
  const v = (await app.query("INSERT INTO vouchers (voucher_type, voucher_no, date, total_amount) VALUES ('Journal', 'T-MONEY-1', '2026-04-01', 0.3) RETURNING id")).rows[0].id;
  for (const amt of [0.1, 0.2]) await app.query("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount) VALUES ($1, (SELECT min(id) FROM ledgers), 'Dr', $2)", [v, amt]);
  const s = (await app.query('SELECT sum(debit_amount)::text s FROM ledger_entries WHERE voucher_id = $1', [v])).rows[0].s;
  await app.query('ROLLBACK');
  assert(s === '0.30', '0.10 + 0.20 is exactly 0.30 (never 0.30000000000000004)', s);

  console.log('\n--- 5. Simultaneous writes ---');
  const ctx = { company: '100000', user: null };
  const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => adapter.run("INSERT INTO godowns (name, location) VALUES (?, 'load test')", ['Load ' + i], ctx).then((r) => r.lastID)));
  assert(new Set(ids).size === 40 && ids.every((x) => Number.isInteger(x)), '40 inserts at the same moment get 40 different ids');
  await adapter.run("DELETE FROM godowns WHERE location = 'load test'", [], ctx);
  if (companies[1]) {
    // two companies with transactions open at the same moment: one commits, one rolls back, neither sees the other's rows
    const other = { company: companies[1], user: null };
    await Promise.all([adapter.run('BEGIN', [], ctx), adapter.run('BEGIN', [], other)]);
    await Promise.all([adapter.run("INSERT INTO godowns (name, location) VALUES ('Tx A', 'tx test')", [], ctx), adapter.run("INSERT INTO godowns (name, location) VALUES ('Tx B', 'tx test')", [], other)]);
    const seenA = await adapter.all("SELECT name FROM godowns WHERE location = 'tx test'", [], ctx), seenB = await adapter.all("SELECT name FROM godowns WHERE location = 'tx test'", [], other);
    await Promise.all([adapter.run('COMMIT', [], ctx), adapter.run('ROLLBACK', [], other)]);
    const afterA = await adapter.all("SELECT name FROM godowns WHERE location = 'tx test'", [], ctx), afterB = await adapter.all("SELECT name FROM godowns WHERE location = 'tx test'", [], other);
    assert(seenA.length === 1 && seenA[0].name === 'Tx A' && seenB.length === 1 && seenB[0].name === 'Tx B' && afterA.length === 1 && afterB.length === 0,
      'two companies in transactions at the same time stay separate; one commits, the other rolls back');
    await adapter.run("DELETE FROM godowns WHERE location = 'tx test'", [], ctx);
  }
  // a failing statement inside a transaction fails alone, as in SQLite (the rest of the transaction still commits)
  await adapter.run('BEGIN', [], ctx);
  await adapter.run("INSERT INTO godowns (name, location) VALUES ('Keep me', 'tx test')", [], ctx);
  const dup = await rejects(adapter.run("INSERT INTO godowns (name, location) VALUES ('Keep me', 'tx test')", [], ctx));
  await adapter.run('COMMIT', [], ctx);
  const kept = await adapter.all("SELECT id FROM godowns WHERE location = 'tx test'", [], ctx);
  assert(dup && kept.length === 1, 'a refused statement inside a transaction does not undo the rest of it (same as SQLite)');
  await adapter.run("DELETE FROM godowns WHERE location = 'tx test'", [], ctx);

  console.log('\n--- 6. Backup and restore into another database ---');
  await adapter.end();
  const { backup, restore } = require('./scripts/pg-backup');
  const file = path.join(os.tmpdir(), `rre-cloud-test-${process.pid}.json.gz`);
  const b = await backup(urlA, { out: file, log: () => {} });
  assert(fs.existsSync(file) && b.companies.length === companies.length, 'a backup of every company is written with a checksum');
  await migrate(urlB, { log: () => {} });
  await restore(urlB, file, { log: () => {} });
  const cmp = new Client({ connectionString: urlB }); await cmp.connect(); await cmp.query('SET ROLE rre_app; SET search_path = rre, public');
  let same = true;
  for (const co of companies) {
    for (const c of [app, cmp]) await c.query("SELECT set_config('rre.company_id', $1, false)", [co]);
    for (const t of ['vouchers', 'ledger_entries', 'ledgers', 'stock_items', 'users', 'inventory_entries']) {
      const [x, y] = await Promise.all([app, cmp].map(async (c) => (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n));
      if (x !== y) { same = false; console.error(`    ${co}.${t}: ${x} vs ${y}`); }
    }
    const [ta, tb] = await Promise.all([app, cmp].map(async (c) => (await c.query('SELECT coalesce(sum(debit_amount),0)::text d, coalesce(sum(credit_amount),0)::text c FROM ledger_entries')).rows[0]));
    if (ta.d !== tb.d || ta.c !== tb.c) { same = false; console.error(`    ${co} totals differ`); }
  }
  assert(same, 'the restored database has the same rows and the same debit / credit totals for every company');
  const e5 = await rejects(restore(urlB, file, { log: () => {} }));
  assert(e5 && /already has data/.test(e5.message), 'restoring over existing data is refused without --replace');
  const bad = file + '.bad'; const zlib = require('zlib'); const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()); o.body = o.body.replace('"vouchers"', '"vouchers "'); fs.writeFileSync(bad, zlib.gzipSync(JSON.stringify(o)));
  const e6 = await rejects(restore(urlB, bad, { replace: true, log: () => {} }));
  assert(e6 && /damaged/.test(e6.message), 'a damaged backup file is detected and nothing is restored');
  await cmp.end(); await app.end(); await raw.end();
  fs.rmSync(file, { force: true }); fs.rmSync(bad, { force: true });
  await admin.query('DROP DATABASE IF EXISTS rre_cloud_a WITH (FORCE)'); await admin.query('DROP DATABASE IF EXISTS rre_cloud_b WITH (FORCE)');
  await admin.end(); await cluster.stop();
  console.log(`\nCloud database: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

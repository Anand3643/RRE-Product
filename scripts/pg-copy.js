/**
 * Copies the companies on this computer (SQLite files under data/) into the PostgreSQL / Supabase database in DATABASE_URL.
 *   npm run db:copy                       every company found under data/
 *   npm run db:copy -- 100000 U46         only these companies
 *   npm run db:copy -- --replace 100000   overwrite a company that is already in PostgreSQL
 * Each company is copied in ONE transaction and verified (row counts, amount totals, debits = credits) before it is committed.
 * The SQLite files are only read, never changed. Run `npm run db:migrate` first.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  require('../core/env').load();
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. Put it in .env (see docs/CLOUD_DATABASE.md).'); process.exit(1); }
  const args = process.argv.slice(2), replace = args.includes('--replace');
  const paths = require('../core/paths');
  const root = path.dirname(paths.companyDir('100000'));
  let wanted = args.filter((a) => !a.startsWith('--'));
  if (!wanted.length) wanted = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'company.db')));
  if (!wanted.length) { console.log('No company files found under ' + root); return; }
  const adapter = require('../core/pgAdapter');
  await adapter.init(url, { max: 2 });
  const { importCompany } = require('../core/pgImport');
  let ok = 0, failed = 0;
  for (const no of wanted) {
    const file = path.join(root, no, 'company.db');
    try {
      await importCompany({ sqliteFile: file, company: no, replace, log: (m) => console.log('  ' + m) });
      await adapter.withClient(async (c) => { await c.query('SET ROLE rre_app'); await c.query("INSERT INTO rre_meta.companies (company_no, kind) VALUES ($1, $2) ON CONFLICT (company_no) DO NOTHING", [no, /^U\d+$/.test(no) ? 'customer' : 'company']); });
      ok++;
    } catch (e) { console.error(`  Company ${no}: NOT copied - ${e.message}`); failed++; }
  }
  await adapter.end();
  console.log(`\n${ok} compan${ok === 1 ? 'y' : 'ies'} copied and verified${failed ? `, ${failed} failed (nothing was written for those)` : ''}.`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

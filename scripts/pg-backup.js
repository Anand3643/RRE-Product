/**
 * Independent backup of the cloud database, kept wherever you choose (in addition to Supabase's own daily backups / point-in-time recovery).
 *   npm run db:backup                         -> backups/rre-cloud-<date>.json.gz   (all companies)
 *   npm run db:backup -- --out D:\safe\x.json.gz --company 100000
 *   npm run db:restore -- <file> [--company 100000] [--replace]
 * The file holds every row of every RRE table per company, the migration versions it was taken at, row counts and a SHA-256 of the
 * content. Restore checks the checksum and the schema version, loads each company in ONE transaction and verifies the row counts
 * before committing. A company that already has data is only overwritten with --replace.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const enc = (v) => (Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v);
const dec = (v) => (v && typeof v === 'object' && v.$b64 != null ? Buffer.from(v.$b64, 'base64') : v);

async function tablesOf(c) {
  return (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'rre' AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map((r) => r.table_name);
}
async function setCompany(c, no) { await c.query("SELECT set_config('rre.company_id', $1, false)", [String(no)]); }

async function backup(url, { out, companies = null, log = console.log, shared = false } = {}) {
  const adapter = require('../core/pgAdapter');
  if (!shared) await adapter.init(url, { max: 2 }); // shared: the running application's own connections (they stay open)
  try {
    return await adapter.withClient(async (c) => {
      await c.query('SET ROLE rre_app; SET search_path = rre, public');
      const versions = (await c.query('SELECT file, sha256 FROM rre_meta.schema_versions ORDER BY file').catch(() => ({ rows: [] }))).rows;
      const list = companies || (await c.query('SELECT company_no FROM rre_meta.companies ORDER BY company_no')).rows.map((r) => r.company_no);
      const tables = await tablesOf(c);
      const doc = { format: 'rre-cloud-backup', version: 1, taken_at: new Date().toISOString(), schema_versions: versions, companies: {} };
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot of every company
      try {
        for (const no of list) {
          await setCompany(c, no);
          const co = { tables: {}, counts: {} };
          for (const t of tables) {
            const rows = (await c.query(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows.map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (k !== 'company_no') o[k] = enc(v); return o; });
            co.tables[t] = rows; co.counts[t] = rows.length;
          }
          doc.companies[no] = co;
          log(`  company ${no}: ${Object.values(co.counts).reduce((a, b) => a + b, 0)} rows`);
        }
      } finally { await c.query('COMMIT'); await setCompany(c, ''); }
      const body = JSON.stringify(doc);
      doc.sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const file = out || path.join(process.cwd(), 'backups', `rre-cloud-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ sha256: doc.sha256, body })));
      log(`Backup written: ${file} (${list.length} compan${list.length === 1 ? 'y' : 'ies'}, sha256 ${doc.sha256.slice(0, 16)}...)`);
      return { file, sha256: doc.sha256, companies: list };
    });
  } finally { if (!shared) await adapter.end(); }
}

function readBackup(file) {
  const outer = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (crypto.createHash('sha256').update(outer.body).digest('hex') !== outer.sha256) throw new Error('The backup file is damaged (checksum does not match). Nothing was restored.');
  const doc = JSON.parse(outer.body);
  if (doc.format !== 'rre-cloud-backup') throw new Error('This is not an RRE cloud backup file.');
  return doc;
}

async function restore(url, file, { companies = null, replace = false, log = console.log, shared = false } = {}) {
  const doc = readBackup(file);
  const adapter = require('../core/pgAdapter');
  if (!shared) await adapter.init(url, { max: 2 });
  try {
    return await adapter.withClient(async (c) => {
      await c.query('SET ROLE rre_app; SET search_path = rre, public');
      const now = (await c.query('SELECT file, sha256 FROM rre_meta.schema_versions ORDER BY file')).rows;
      const missing = doc.schema_versions.filter((v) => !now.some((n) => n.file === v.file));
      if (missing.length) throw new Error('Run npm run db:migrate first: the backup was taken with migrations this database does not have (' + missing.map((m) => m.file).join(', ') + ').');
      const tables = await tablesOf(c);
      const list = companies || Object.keys(doc.companies);
      for (const no of list) {
        const co = doc.companies[no]; if (!co) throw new Error(`Company ${no} is not in this backup.`);
        await c.query('BEGIN');
        try {
          await setCompany(c, no); await c.query('SET CONSTRAINTS ALL DEFERRED');
          const has = (await c.query('SELECT count(*)::int n FROM company_info')).rows[0].n;
          if (has && !replace) throw new Error(`Company ${no} already has data. Use --replace to overwrite it with the backup.`);
          for (const t of [...tables].reverse()) await c.query(`DELETE FROM ${t}`);
          await c.query('DELETE FROM rre_meta.id_counters WHERE company_no = $1', [no]);
          for (const t of tables) {
            const rows = co.tables[t] || [];
            for (let i = 0; i < rows.length; i += 200) {
              const chunk = rows.slice(i, i + 200), cols = Object.keys(chunk[0]), vals = [], ph = [];
              chunk.forEach((r, ri) => ph.push('(' + cols.map((k, ci) => { vals.push(dec(r[k])); return '$' + (ri * cols.length + ci + 1); }).join(', ') + ')'));
              await c.query(`INSERT INTO ${t} (${cols.map((k) => '"' + k + '"').join(', ')}) VALUES ${ph.join(', ')}`, vals);
            }
            const n = (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
            if (n !== rows.length) throw new Error(`${t}: expected ${rows.length} rows after restore, found ${n}`);
          }
          await c.query('INSERT INTO rre_meta.companies (company_no) VALUES ($1) ON CONFLICT (company_no) DO NOTHING', [no]);
          await c.query('COMMIT');
          log(`  company ${no}: restored and verified (${Object.values(co.counts).reduce((a, b) => a + b, 0)} rows)`);
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw new Error(`Company ${no} was NOT restored (nothing changed): ${e.message}`); }
      }
      await setCompany(c, '');
      return { companies: list };
    });
  } finally { if (!shared) await adapter.end(); }
}

module.exports = { backup, restore, readBackup };

if (require.main === module) {
  require('../core/env').load();
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. Put it in .env (see docs/CLOUD_DATABASE.md).'); process.exit(1); }
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const cos = args.reduce((a, x, i) => (args[i - 1] === '--company' ? [...a, x] : a), []);
  const job = args[0] === 'restore'
    ? restore(url, args[1], { companies: cos.length ? cos : null, replace: args.includes('--replace') })
    : backup(url, { out: opt('--out'), companies: cos.length ? cos : null });
  job.catch((e) => { console.error(e.message); process.exit(1); });
}

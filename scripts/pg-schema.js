/**
 * Generates the PostgreSQL (Supabase) schema from the application's own SQLite schema, so the two can never drift apart.
 *   node scripts/pg-schema.js            -> rewrites db/postgres/migrations/001_core_schema.sql
 *
 * How the SQLite design maps onto ONE shared PostgreSQL database for every company:
 *   - every table gets  company_no text NOT NULL DEFAULT current_setting('rre.company_id')  (the server sets it per connection)
 *   - every primary key becomes (company_no, <old key>) and every foreign key (company_no, <col>) -> (company_no, <key>):
 *     existing ids are kept, and the database itself refuses a row that points at another company's record
 *   - UNIQUE becomes unique per company; COLLATE NOCASE uniqueness becomes a unique index on lower(col)
 *   - REAL money columns -> numeric(18,2); quantities, rates and percentages -> numeric(18,4)  (never floating point)
 *   - every row also gets _created_at, _updated_at (trigger) and _created_by (the signed-in user id) for the audit requirement
 * Row level security (who may see which rows) is in 002_security.sql, written by hand.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MONEY = /(^|_)(amount|total|subtotal|balance|debit|credit|charges|cgst|sgst|igst|tax|round_off|threshold|limit|val|cost|price)$/;
const QTY = /(^|_)(qty|quantity|rate|pct|level|qty_done)$/;

const RESERVED = new Set(['user', 'order', 'group', 'desc', 'limit', 'offset', 'default', 'check', 'references', 'primary', 'unique', 'table', 'column', 'select', 'where', 'from', 'to', 'end', 'both', 'all', 'and', 'or', 'as', 'case', 'when', 'then', 'else', 'on', 'in', 'is', 'not', 'null', 'true', 'false']);
const q = (id) => (/^[a-z_][a-z0-9_]*$/.test(id) && !RESERVED.has(id) ? id : '"' + id + '"');

function pgType(table, col) {
  const t = String(col.type || '').toUpperCase();
  if (/INT/.test(t)) return 'bigint';
  if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(t)) {
    if (QTY.test(col.name)) return 'numeric(18,4)';
    if (MONEY.test(col.name)) return 'numeric(18,2)';
    return 'numeric(18,4)';
  }
  if (/BLOB/.test(t)) return 'bytea';
  return 'text COLLATE "C"'; // byte order, exactly like SQLite. TEXT, DATETIME (stored as 'YYYY-MM-DD HH:MM:SS' text, exactly as today, so date comparisons keep working)
}

function pgDefault(col, type) {
  if (col.dflt_value == null) return '';
  const d = String(col.dflt_value);
  if (/^CURRENT_TIMESTAMP$/i.test(d)) return " DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')";
  if (/^CURRENT_DATE$/i.test(d)) return " DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD')";
  if (type.startsWith('text') && /^-?\d+(\.\d+)?$/.test(d)) return ` DEFAULT '${d}'`;
  return ' DEFAULT ' + d;
}

const sqlAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function introspect(file) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  const tables = await sqlAll(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = [];
  for (const t of tables) {
    const cols = await sqlAll(db, `PRAGMA table_info(${t.name})`);
    const fks = await sqlAll(db, `PRAGMA foreign_key_list(${t.name})`);
    const idx = await sqlAll(db, `PRAGMA index_list(${t.name})`);
    const indexes = [];
    for (const i of idx) {
      const info = await sqlAll(db, `PRAGMA index_xinfo(${i.name})`);
      const sqlRow = (await sqlAll(db, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [i.name]))[0];
      indexes.push({ ...i, cols: info.filter((c) => c.key), sql: sqlRow ? sqlRow.sql : null });
    }
    out.push({ name: t.name, sql: t.sql, cols, fks, indexes });
  }
  const triggers = await sqlAll(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'");
  db.close();
  return { tables: out, triggers };
}

/** CHECK (...) clauses of a CREATE TABLE statement, copied as they are (they use plain SQL both databases understand). */
function checks(sql) {
  const out = []; let i = 0;
  const s = sql.replace(/--[^\n]*/g, '');
  while ((i = s.toUpperCase().indexOf('CHECK', i)) >= 0) {
    let j = s.indexOf('(', i), depth = 0, k = j;
    for (; k < s.length; k++) { if (s[k] === '(') depth++; else if (s[k] === ')' && --depth === 0) break; }
    out.push(s.slice(j, k + 1)); i = k;
  }
  return out;
}
const nocaseCols = (sql) => new Set([...sql.replace(/--[^\n]*/g, '').matchAll(/(\w+)\s+TEXT[^,]*COLLATE\s+NOCASE/gi)].map((m) => m[1]));

/** Tables whose id SQLite numbers by itself (INTEGER PRIMARY KEY id). */
const autoId = (t) => { const pk = t.cols.filter((c) => c.pk); return pk.length === 1 && pk[0].name === 'id' && /INT/i.test(pk[0].type); };

function tableDDL(t) {
  const L = [], post = [];
  const pk = t.cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
  const nocase = nocaseCols(t.sql);
  L.push("  company_no text NOT NULL DEFAULT current_setting('rre.company_id')");
  for (const c of t.cols) {
    const type = pgType(t.name, c);
    if (autoId(t) && c.name === 'id') { L.push('  id bigint NOT NULL'); continue; } // numbered per company by rre.assign_id(), like SQLite
    const colType = nocase.has(c.name) && type.startsWith('text') ? 'text COLLATE rre.nocase' : type; // equal / group ignoring case, like SQLite
    L.push(`  ${q(c.name)} ${colType}${c.notnull ? ' NOT NULL' : ''}${pgDefault(c, colType)}`);
  }
  L.push("  _created_at timestamptz NOT NULL DEFAULT now()", "  _updated_at timestamptz NOT NULL DEFAULT now()", "  _created_by text DEFAULT nullif(current_setting('rre.user_id', true), '')");
  if (pk.length) L.push(`  PRIMARY KEY (company_no, ${pk.map((c) => q(c.name)).join(', ')})`);
  // unique constraints that come from the column definitions / UNIQUE(...) clauses (sqlite_autoindex_*) and unique indexes
  for (const i of t.indexes) {
    if (!i.unique || i.origin === 'pk') continue;
    const cols = i.cols.map((c) => (c.name == null ? null : c.name));
    if (cols.includes(null)) { post.push(exprIndex(t, i)); continue; } // expression index: translated below
    const lower = cols.map((c) => (nocase.has(c) || (i.sql && new RegExp(c + '\\s+COLLATE\\s+NOCASE', 'i').test(i.sql)) ? `lower(${q(c)})` : q(c)));
    const where = i.partial && i.sql ? ' WHERE ' + i.sql.split(/\bWHERE\b/i)[1].trim() : '';
    if (lower.some((x) => x.startsWith('lower(')) || where || i.origin === 'c') post.push(`CREATE UNIQUE INDEX ${i.origin === 'c' ? i.name : 'uq_' + t.name + '_' + cols.join('_')} ON ${t.name} (company_no, ${lower.join(', ')})${where};`);
    else L.push(`  UNIQUE (company_no, ${lower.join(', ')})`);
  }
  for (const c of checks(t.sql)) L.push(`  CHECK ${c}`);
  for (const i of t.indexes) if (!i.unique && i.origin === 'c') post.push(plainIndex(t, i));
  return { ddl: `CREATE TABLE ${t.name} (\n${L.join(',\n')}\n);`, post };
}
function plainIndex(t, i) {
  const cols = i.cols.map((c) => (c.name == null ? exprOf(i.sql) : (i.sql && new RegExp(c.name + '\\s+COLLATE\\s+NOCASE', 'i').test(i.sql) ? `lower(${q(c.name)})` : q(c.name))));
  return `CREATE INDEX ${i.name} ON ${t.name} (company_no, ${cols.join(', ')});`;
}
function exprOf(sql) { const m = /\((.*)\)/.exec(sql.replace(/\bWHERE\b.*$/i, '')); return m ? m[1] : ''; }
function exprIndex(t, i) {
  let body = exprOf(i.sql).replace(/COALESCE\(([^,]+),\s*0\)/gi, 'COALESCE($1, 0)');
  const where = /\bWHERE\b/i.test(i.sql) ? ' WHERE ' + i.sql.split(/\bWHERE\b/i)[1].trim() : '';
  return `CREATE UNIQUE INDEX ${i.name} ON ${t.name} (company_no, ${body})${where};`;
}

function fkDDL(t, keyOf) {
  const groups = new Map();
  for (const f of t.fks) { if (!groups.has(f.id)) groups.set(f.id, []); groups.get(f.id).push(f); }
  const out = [];
  for (const fs_ of groups.values()) {
    const f = fs_[0], from = fs_.map((x) => q(x.from)), to = fs_.map((x) => q(x.to || keyOf(x.table)));
    const del = f.on_delete && f.on_delete !== 'NO ACTION' ? ` ON DELETE ${f.on_delete === 'SET NULL' ? `SET NULL (${from.join(', ')})` : f.on_delete}` : '';
    out.push(`ALTER TABLE ${t.name} ADD CONSTRAINT fk_${t.name}_${fs_.map((x) => x.from).join('_')} FOREIGN KEY (company_no, ${from.join(', ')}) REFERENCES ${f.table} (company_no, ${to.join(', ')})${del} DEFERRABLE INITIALLY IMMEDIATE;`);
  }
  return out;
}

async function freshSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rre-pgschema-'));
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['-e', "(async()=>{const db=require('./core/db');await db.initDb();await require('./core/migrations').runMigrations();await db.closeDb();process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, RRE_DATA_DIR: dir, RRE_DB: 'sqlite' }, stdio: 'ignore' });
  return { file: path.join(dir, 'company.db'), dir };
}

async function generate() {
  const fresh = await freshSqlite();
  const { tables, triggers } = await introspect(fresh.file);
  const keyOf = (name) => { const t = tables.find((x) => x.name === name); const pk = t && t.cols.find((c) => c.pk); return pk ? pk.name : 'id'; };
  const parts = [`-- RRE Tally: core schema for PostgreSQL / Supabase. GENERATED by scripts/pg-schema.js from the application's SQLite schema; do not edit by hand.
-- Every table holds the rows of every company, separated by company_no (enforced by the keys below and by row level security in 002).
-- Money is numeric(18,2), quantities/rates/percentages numeric(18,4); never floating point.
-- Everything lives in the private schema "rre": Supabase publishes only "public" through its web API, so these tables are reachable
-- solely through the RRE server.
SET client_min_messages = warning;
CREATE SCHEMA IF NOT EXISTS rre;
SET search_path = rre;
-- columns that SQLite compares ignoring case (COLLATE NOCASE: usernames, batch / serial numbers, branch names ...)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE n.nspname = 'rre' AND c.collname = 'nocase') THEN
    CREATE COLLATION rre.nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
  END IF;
END $$;
`];
  const fks = [], posts = [];
  for (const t of tables) { const d = tableDDL(t); parts.push(d.ddl); posts.push(...d.post); fks.push(...fkDDL(t, keyOf)); }
  parts.push('\n-- indexes (each leads with company_no: every query runs inside one company)', ...posts);
  parts.push('\n-- foreign keys: (company_no, column) -> (company_no, key), so a row can never point into another company', ...fks);
  // housekeeping columns
  parts.push(`\n-- _updated_at on every change
CREATE OR REPLACE FUNCTION rre_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW._updated_at := now(); RETURN NEW; END $$;

-- ids exactly like SQLite: numbered per company and table, one above the highest id ever used there (also after rows inserted with an explicit id).
-- The counter row is locked until the transaction ends, so simultaneous inserts can never receive the same number.
CREATE SCHEMA IF NOT EXISTS rre_meta;
CREATE TABLE IF NOT EXISTS rre_meta.id_counters (company_no text NOT NULL, tbl text NOT NULL, last_id bigint NOT NULL, PRIMARY KEY (company_no, tbl));
CREATE OR REPLACE FUNCTION rre_assign_id() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE nid bigint; BEGIN
  IF NEW.id IS NULL THEN
    INSERT INTO rre_meta.id_counters AS c (company_no, tbl, last_id) VALUES (NEW.company_no, TG_TABLE_NAME, 1)
      ON CONFLICT (company_no, tbl) DO UPDATE SET last_id = c.last_id + 1 RETURNING c.last_id INTO nid;
    NEW.id := nid;
  ELSE
    INSERT INTO rre_meta.id_counters AS c (company_no, tbl, last_id) VALUES (NEW.company_no, TG_TABLE_NAME, NEW.id)
      ON CONFLICT (company_no, tbl) DO UPDATE SET last_id = greatest(c.last_id, EXCLUDED.last_id);
  END IF;
  RETURN NEW; END $$;`);
  for (const t of tables) if (autoId(t)) parts.push(`CREATE TRIGGER trg_${t.name}_id BEFORE INSERT ON ${t.name} FOR EACH ROW EXECUTE FUNCTION rre_assign_id();`);
  for (const t of tables) parts.push(`CREATE TRIGGER trg_${t.name}_touch BEFORE UPDATE ON ${t.name} FOR EACH ROW EXECUTE FUNCTION rre_touch();`);
  // the two SQLite triggers, rewritten
  const names = triggers.map((x) => x.name).sort().join(',');
  if (names !== 'trg_bank_line_unmatch_on_entry_delete,trg_serials_on_stock_line_delete') throw new Error('SQLite triggers changed (' + names + '): update the PostgreSQL versions in scripts/pg-schema.js');
  parts.push(`
-- SQLite triggers, same behaviour
CREATE OR REPLACE FUNCTION rre_bank_line_unmatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE bank_statement_lines SET status = 'unmatched', matched_entry_id = NULL, matched_at = NULL, matched_by = NULL WHERE company_no = OLD.company_no AND matched_entry_id = OLD.id;
  RETURN OLD; END $$;
CREATE TRIGGER trg_bank_line_unmatch_on_entry_delete BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION rre_bank_line_unmatch();
CREATE OR REPLACE FUNCTION rre_serials_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE serial_numbers SET status = 'in_stock', out_entry_id = NULL WHERE company_no = OLD.company_no AND out_entry_id = OLD.id;
  UPDATE serial_numbers SET status = 'sold', returned_entry_id = NULL WHERE company_no = OLD.company_no AND returned_entry_id = OLD.id;
  DELETE FROM serial_numbers WHERE company_no = OLD.company_no AND in_entry_id = OLD.id;
  RETURN OLD; END $$;
CREATE TRIGGER trg_serials_on_stock_line_delete BEFORE DELETE ON inventory_entries FOR EACH ROW EXECUTE FUNCTION rre_serials_release();`);
  const outFile = path.join(__dirname, '..', 'db', 'postgres', 'migrations', '001_core_schema.sql');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, parts.join('\n') + '\n');
  fs.rmSync(fresh.dir, { recursive: true, force: true });
  return { file: outFile, tables: tables.length, triggers: triggers.map((x) => x.sql) };
}

module.exports = { generate, introspect, freshSqlite };
if (require.main === module) {
  // 001 is FROZEN once databases exist: applied migrations are never edited (pg-migrate refuses a changed file). Schema changes made
  // after it go into a new numbered file in db/postgres/migrations, next to the SQLite migration; test_pg_cloud.js checks that every
  // SQLite table and column exists in PostgreSQL. --force regenerates 001 (only for a project with no PostgreSQL database yet).
  if (fs.existsSync(path.join(__dirname, '..', 'db', 'postgres', 'migrations', '001_core_schema.sql')) && !process.argv.includes('--force')) {
    console.log('001_core_schema.sql exists and is frozen. Add a new numbered migration instead (see the comment in this file), or use --force on a project without PostgreSQL databases.');
    process.exit(0);
  }
  generate().then((r) => { console.log(`Wrote ${r.file} (${r.tables} tables)`); for (const s of r.triggers) console.log('\nSQLite trigger (check the PostgreSQL version matches):\n' + s); }).catch((e) => { console.error(e); process.exit(1); });
}

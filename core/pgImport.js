/**
 * Copies one company from its SQLite file into the shared PostgreSQL database, in ONE transaction, and verifies the copy:
 * same number of rows in every table, same totals in every amount column, and debits = credits per voucher as before.
 * Nothing is written to the SQLite file (it is opened read-only), so the original data is never at risk.
 *
 *   await importCompany({ sqliteFile, company: '100000', replace: false, log })
 */
const fs = require('fs');

const sqlAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

/** Tables in an order where every referenced table comes first. */
function fkOrder(tables, fkMap) {
  const out = [], seen = new Set(), visiting = new Set();
  const visit = (t) => { if (seen.has(t) || visiting.has(t)) return; visiting.add(t); for (const d of fkMap.get(t) || []) if (d !== t) visit(d); visiting.delete(t); seen.add(t); out.push(t); };
  tables.forEach(visit);
  return out;
}

async function importCompany({ sqliteFile, company, replace = false, log = () => {}, client: given = null }) {
  if (!fs.existsSync(sqliteFile)) throw new Error('No SQLite company file at ' + sqliteFile);
  const sqlite3 = require('sqlite3');
  const src = new sqlite3.Database(sqliteFile, sqlite3.OPEN_READONLY);
  const adapter = require('./pgAdapter');
  const work = async (c) => {
    await c.query('SET ROLE rre_app; SET search_path = rre, public');
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('rre.company_id', $1, true), set_config('rre.user_id', '', true)", [String(company)]);
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      const pgCols = new Map();
      for (const r of (await c.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'rre'")).rows) { if (!pgCols.has(r.table_name)) pgCols.set(r.table_name, new Map()); pgCols.get(r.table_name).set(r.column_name, r.data_type); }
      const tables = (await sqlAll(src, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
      const missing = tables.filter((t) => !pgCols.has(t));
      if (missing.length) throw new Error('These tables exist in the SQLite file but not in PostgreSQL (run npm run db:migrate after regenerating the schema): ' + missing.join(', '));
      const fkMap = new Map();
      for (const t of tables) fkMap.set(t, (await sqlAll(src, `PRAGMA foreign_key_list(${t})`)).map((f) => f.table));
      const order = fkOrder(tables, fkMap);
      const existing = (await c.query('SELECT count(*)::int n FROM company_info')).rows[0].n;
      if (existing && !replace) throw new Error(`Company ${company} already has data in PostgreSQL. Use --replace to overwrite it with the SQLite copy.`);
      if (existing) for (const t of [...order].reverse()) await c.query(`DELETE FROM ${t}`);
      await c.query('DELETE FROM rre_meta.id_counters WHERE company_no = $1', [String(company)]);
      const report = [];
      for (const t of order) {
        const cols = (await sqlAll(src, `PRAGMA table_info(${t})`)).map((x) => x.name);
        const extra = cols.filter((x) => !pgCols.get(t).has(x));
        if (extra.length) throw new Error(`${t}: columns ${extra.join(', ')} exist only in the SQLite file`);
        const rows = await sqlAll(src, `SELECT * FROM ${t}`);
        const types = pgCols.get(t);
        const conv = (col, v) => {
          if (v == null) return null;
          const ty = types.get(col);
          if ((ty === 'bigint' || ty === 'numeric') && typeof v === 'string') { const s = v.trim(); return s === '' ? null : s; }
          return v;
        };
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200), vals = [], ph = [];
          chunk.forEach((r, ri) => { ph.push('(' + cols.map((col, ci) => { vals.push(conv(col, r[col])); return '$' + (ri * cols.length + ci + 1); }).join(', ') + ')'); });
          try { await c.query(`INSERT INTO ${t} (${cols.map((x) => '"' + x + '"').join(', ')}) VALUES ${ph.join(', ')}`, vals); }
          catch (e) { throw new Error(`${t} (rows ${i + 1}-${i + chunk.length}): ${e.message}`); }
        }
        report.push({ table: t, rows: rows.length });
      }
      // ---------------------------------------------------------------- verification, still inside the transaction
      for (const r of report) {
        const n = (await c.query(`SELECT count(*)::int n FROM ${r.table}`)).rows[0].n;
        if (n !== r.rows) throw new Error(`${r.table}: ${r.rows} rows in SQLite but ${n} in PostgreSQL`);
        const numCols = [...pgCols.get(r.table)].filter(([, ty]) => ty === 'numeric').map(([k]) => k);
        for (const col of numCols) {
          const a = (await sqlAll(src, `SELECT ROUND(COALESCE(SUM(${col}), 0), 2) s FROM ${r.table}`))[0].s;
          const b = Number((await c.query(`SELECT ROUND(COALESCE(SUM("${col}"), 0), 2) s FROM ${r.table}`)).rows[0].s);
          if (Math.abs(Number(a) - b) > 0.005) throw new Error(`${r.table}.${col}: total ${a} in SQLite but ${b} in PostgreSQL`);
        }
      }
      const tb = (await c.query('SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2) d, ROUND(COALESCE(SUM(credit_amount), 0), 2) c FROM ledger_entries')).rows[0];
      const tbSrc = (await sqlAll(src, 'SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2) d, ROUND(COALESCE(SUM(credit_amount), 0), 2) c FROM ledger_entries'))[0];
      if (Math.abs(Number(tb.d) - tbSrc.d) > 0.005 || Math.abs(Number(tb.c) - tbSrc.c) > 0.005) throw new Error('ledger totals changed during the copy');
      await c.query('INSERT INTO rre_meta.companies (company_no, kind) VALUES ($1, $2) ON CONFLICT (company_no) DO NOTHING', [String(company), /^U\d+$/.test(String(company)) ? 'customer' : 'company']);
      await c.query('COMMIT');
      log(`Company ${company}: ${report.reduce((s, r) => s + r.rows, 0)} rows in ${report.length} tables copied and verified (debits ${tb.d}, credits ${tb.c}).`);
      return { tables: report, debit: Number(tb.d), credit: Number(tb.c) };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  };
  try {
    if (given) return await work(given);
    return await adapter.withClient(work);
  } finally { src.close(); }
}

module.exports = { importCompany };

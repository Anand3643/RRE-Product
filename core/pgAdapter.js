/**
 * PostgreSQL (Supabase) driver behind the application's existing run / get / all helpers.
 * Switched on with RRE_DB=postgres and DATABASE_URL in .env; SQLite stays the default.
 *
 * - One shared database for every company. Each pooled connection switches to the restricted role rre_app (row level security
 *   applies, see db/postgres/migrations/002_security.sql) and is told which company it works for (rre.company_id) before every query.
 * - The application's SQL is written for SQLite. translate() converts the few dialect differences (placeholders, INSERT OR IGNORE,
 *   case-insensitive LIKE, new ids, ...). SQLite-only functions (datetime, julianday, strftime, ifnull, group_concat, ...) exist as
 *   real PostgreSQL functions (003_sqlite_compat.sql), so queries keep their meaning.
 * - Schema changes come only from the SQL migration files: CREATE TABLE / ALTER TABLE / PRAGMA statements issued by the old start-up
 *   code are answered without touching the database.
 * - Transactions: BEGIN pins one connection to that company until COMMIT / ROLLBACK and every query of the company uses it,
 *   exactly like the single SQLite connection per company works today.
 */
const fs = require('fs');

let pg = null, pool = null, meta = null;
const pinned = new Map(); // company -> { client, depth }

function connectionOptions(url) {
  const u = new URL(url);
  if (u.port === '6543') throw new Error('DATABASE_URL points at the Supabase transaction pooler (port 6543). RRE needs the session pooler (port 5432) or the direct connection, because each connection is told which company it serves.');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  const ssl = local && process.env.RRE_PG_SSL !== '1' ? false
    : process.env.RRE_PG_CA_FILE ? { ca: fs.readFileSync(process.env.RRE_PG_CA_FILE, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: process.env.RRE_PG_SSL_NO_VERIFY !== '1' };
  return { connectionString: url, ssl, application_name: 'rre-tally' };
}

function setTypes() {
  pg = require('pg');
  // bigint ids and numeric amounts come back as JavaScript numbers, as they did from SQLite (amounts stay exact in the database)
  pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
}

async function init(url, { max = parseInt(process.env.RRE_PG_POOL_MAX || '10', 10) } = {}) {
  if (pool) return;
  setTypes();
  pool = new pg.Pool({ ...connectionOptions(url), max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[Database] idle connection error:', e.message));
  await loadMeta();
}
async function end() { if (pool) { const p = pool; pool = null; meta = null; await p.end(); } }

/** Table facts the translator needs: which tables have an identity id, primary keys, and column lists. */
async function loadMeta() {
  const c = await pool.connect();
  try {
    await c.query('SET search_path = rre, public');
    const cols = (await c.query("SELECT table_name, column_name, is_identity, ordinal_position, data_type, is_nullable, column_default, collation_name FROM information_schema.columns WHERE table_schema = 'rre' ORDER BY table_name, ordinal_position")).rows;
    const pks = (await c.query("SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema WHERE tc.table_schema = 'rre' AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position")).rows;
    meta = { identity: new Map(), pk: new Map(), cols: new Map(), nocase: new Set() };
    for (const r of cols) {
      if (!meta.cols.has(r.table_name)) meta.cols.set(r.table_name, []);
      meta.cols.get(r.table_name).push(r);
      if (r.collation_name === 'nocase') meta.nocase.add(r.column_name); // case-insensitive columns (see likeOnNocase)
    }
    for (const r of pks) { if (!meta.pk.has(r.table_name)) meta.pk.set(r.table_name, []); if (r.column_name !== 'company_no') meta.pk.get(r.table_name).push(r.column_name); }
    for (const [t, k] of meta.pk) if (k.length === 1 && k[0] === 'id') meta.identity.set(t, 'id'); // numbered by the rre_assign_id trigger
    if (!meta.cols.size) throw new Error('The database has no RRE tables yet. Run: npm run db:migrate');
  } finally { c.release(); }
}

// ------------------------------------------------------------------------------------------------ SQL translation
/** Splits SQL into code and quoted parts, so rewriting never touches the inside of a string literal. */
function mapCode(sql, fn) {
  let out = '', i = 0, start = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") { out += fn(sql.slice(start, i)); let j = i + 1; for (; j < sql.length; j++) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j++; continue; } break; } } out += sql.slice(i, j + 1); i = start = j + 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') { out += fn(sql.slice(start, i)); const j = sql.indexOf('\n', i); i = start = j < 0 ? sql.length : j; continue; }
    i++;
  }
  return out + fn(sql.slice(start));
}

const DDL = /^\s*(CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER|VIEW|TEMP|TEMPORARY)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|TRIGGER|VIEW)|PRAGMA|VACUUM|ANALYZE|REINDEX|ATTACH|DETACH)\b/i;
const TX = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * SQLite lets a query group by a table's id and still select its other columns (l.name, ...). PostgreSQL allows that only when the
 * whole primary key is grouped, and the key is (company_no, id). Every query runs inside ONE company, so adding x.company_no next to
 * each x.id in a GROUP BY changes no group, and makes the query valid.
 */
/** The SQL with the inside of every string literal blanked out (same length), so keyword searches only see real SQL. */
function maskLiterals(s) {
  let o = '', inQ = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inQ) { if (ch === "'" && s[k + 1] === "'") { o += '  '; k++; continue; } if (ch === "'") { inQ = false; o += ch; continue; } o += ' '; continue; }
    if (ch === "'") inQ = true;
    o += ch;
  }
  return o;
}

function groupByCompany(s) {
  const mk = maskLiterals(s), up = mk.toUpperCase();
  let out = '', from = 0, i;
  const re = /\bGROUP\s+BY\b/gi; let m;
  while ((m = re.exec(mk))) {
    i = m.index + m[0].length;
    // the end of the GROUP BY list: same bracket depth, before HAVING / ORDER BY / LIMIT / ...
    let depth = 0, j = i;
    for (; j < mk.length; j++) {
      const ch = mk[j];
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && /^(HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW)\b/.test(up.slice(j, j + 12)) && /\W/.test(mk[j - 1] || ' ')) break;
    }
    const list = mk.slice(i, j);
    const quals = new Set([...list.matchAll(/\b([A-Za-z_]\w*)\.id\b/g)].map((x) => x[1]));
    let add = [...quals].filter((q) => !new RegExp('\\b' + q + '\\.company_no\\b').test(list)).map((q) => q + '.company_no');
    // an unqualified id in a single-table query
    if (/(^|[^.\w])id\b(?!\s*\()/i.test(list) && !/\bJOIN\b/i.test(mk) && !/\bcompany_no\b/.test(list)) add.push('company_no');
    out += s.slice(from, j).replace(/\s*$/, '') + (add.length ? ', ' + add.join(', ') : '') + ' ';
    from = j; re.lastIndex = j;
  }
  return from ? out + s.slice(from) : s;
}

/**
 * Case-insensitive columns (usernames, batch numbers ...) use a collation PostgreSQL 17 cannot run LIKE on. ILIKE ignores case by
 * itself, so the column is compared byte by byte inside ILIKE: same result.
 */
function likeOnNocase(s) {
  if (!meta || !meta.nocase.size || !/\bILIKE\b/i.test(s)) return s;
  return mapCode(s, (code) => code
    .replace(/(\bILIKE\s+\$\d+)\s+COLLATE\s+rre\.nocase\b/gi, '$1')
    .replace(/\b((?:\w+\.)?(\w+))(\s+(?:NOT\s+)?ILIKE\b)/gi, (m, ref, col, rest) => (meta.nocase.has(col.toLowerCase()) ? `${ref} COLLATE "C"${rest}` : m))
    .replace(/\b((?:lower|upper|trim)\s*\(\s*(?:\w+\.)?(\w+)\s*\))(\s+(?:NOT\s+)?ILIKE\b)/gi, (m, ref, col, rest) => (meta.nocase.has(col.toLowerCase()) ? `${ref} COLLATE "C"${rest}` : m)));
}

/**
 * A query without ORDER BY gets its rows from SQLite in the order they were stored (row id order) - the application relies on that,
 * e.g. "the first ledger named like Cash", or a voucher's lines in the order entered. PostgreSQL promises no order, so a plain query
 * gets ORDER BY <first table>.id. Grouped, DISTINCT, UNION and aggregate-only queries are left alone.
 */
const AGG = /\b(COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT|STRING_AGG|ARRAY_AGG|BOOL_OR|BOOL_AND|JSON_AGG)\s*\(/i;
const FROM_STOP = /^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|NATURAL|ON|LIMIT|ORDER|GROUP|HAVING|OFFSET|UNION|USING|FOR)$/i;
function naturalOrder(s) {
  const mk = maskLiterals(s);
  if (!/^\s*SELECT\b/i.test(mk)) return s;
  const top = (re) => topLevel(mk, 0, mk.length, re);
  if (top(/^ORDER\s+BY\b/).length || top(/^GROUP\s+BY\b/).length || top(/^(UNION|INTERSECT|EXCEPT)\b/).length || /^\s*SELECT\s+DISTINCT\b/i.test(mk)) return s;
  const from = top(/^FROM\b/)[0]; if (!from) return s;
  const list = mk.slice(mk.search(/SELECT/i) + 6, from.k);
  if (AGG.test(list.replace(/\([^()]*\bSELECT\b[\s\S]*?\)/gi, ''))) return s; // aggregate over the whole table: one row, no order
  const m = /^\s*"?(\w+)"?(?:\s+(?:AS\s+)?(\w+))?/i.exec(mk.slice(from.k + 4));
  if (!m || !meta || !meta.identity.has(m[1].toLowerCase())) return s;
  const name = m[2] && !FROM_STOP.test(m[2]) ? m[2] : m[1];
  const stop = top(/^(LIMIT|OFFSET|FOR)\b/)[0];
  const at = stop ? stop.k : s.length;
  return s.slice(0, at).replace(/\s*$/, '') + ` ORDER BY ${name}.id ` + s.slice(at);
}

/** SQLite sorts empty (NULL) values first when ascending and last when descending; PostgreSQL does the opposite. Same order as SQLite: */
function orderByNulls(s) {
  const mk = maskLiterals(s), up = mk.toUpperCase();
  const edits = [];
  const re = /\bORDER\s+BY\b/gi; let m;
  while ((m = re.exec(mk))) {
    const i = m.index + m[0].length; let depth = 0, j = i;
    for (; j < mk.length; j++) {
      const ch = mk[j];
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && /^(LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|FOR|RETURNING)\b/.test(up.slice(j, j + 10)) && /\W/.test(mk[j - 1] || ' ')) break;
    }
    const list = mk.slice(i, j);
    for (const [a, b] of splitTop(list)) {
      const item = list.slice(a, b);
      if (!item.trim() || /\bNULLS\s+(FIRST|LAST)\b/i.test(item)) continue;
      const end = i + a + item.replace(/\s+$/, '').length;
      edits.push([end, /\bDESC\s*$/i.test(item.trim()) ? ' NULLS LAST' : ' NULLS FIRST']);
    }
  }
  edits.sort((x, y) => y[0] - x[0]);
  for (const [pos, txt] of edits) s = s.slice(0, pos) + txt + s.slice(pos);
  return s;
}

function translate(sql, params = []) {
  let s = String(sql).trim().replace(/;\s*$/, '');
  let n = 0;
  const outParams = [];
  // positional ? -> $1..$n ; numbered ?NNN are not used by the application
  s = mapCode(s, (code) => code.replace(/\?/g, () => { outParams.push(params[n]); n++; return '$' + n; }));
  s = mapCode(s, (code) => code
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bREPLACE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bLIKE\b/gi, 'ILIKE') // SQLite LIKE ignores case
    .replace(/(^|[^.\w])(datetime|date|julianday|printf|ifnull)\s*\(/gi, (m, a, f) => `${a}rre.${f.toLowerCase()}(`) // PostgreSQL's own date() would win otherwise
    .replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE rre.nocase')
    .replace(/\bAS\s+REAL\b/gi, 'AS numeric')
    .replace(/\bAS\s+INTEGER\b/gi, 'AS bigint')
    .replace(/\bLIMIT\s+-1\b/gi, 'LIMIT ALL')
    .replace(/\blast_insert_rowid\(\)/gi, 'lastval()')
    .replace(/(\$\d+)(\s+IS\s+(NOT\s+)?NULL)/gi, '$1::text$2')); // "? IS NULL": PostgreSQL needs a type for a parameter used only here
  s = groupByCompany(s);
  s = likeOnNocase(s);
  s = naturalOrder(s);
  s = orderByNulls(s);
  // upsert targets name the per-company key: ON CONFLICT(key) -> ON CONFLICT(company_no, key)
  s = mapCode(s, (code) => code.replace(/\bON\s+CONFLICT\s*\(\s*(?!company_no\b)([^)]+)\)/gi, 'ON CONFLICT (company_no, $1)'));
  const head = /^\s*INSERT\s+(OR\s+(IGNORE|REPLACE)\s+)?INTO\s+("?)(\w+)\3/i.exec(String(sql)) || /^\s*REPLACE\s+INTO\s+("?)(\w+)\1/i.exec(String(sql));
  let insertTable = null;
  if (head) {
    insertTable = (head[4] || head[2]).toLowerCase();
    const orIgnore = /^\s*INSERT\s+OR\s+IGNORE/i.test(sql), orReplace = /^\s*(INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO/i.test(sql);
    if ((orIgnore || orReplace) && !/\bON\s+CONFLICT\b/i.test(s)) {
      if (orIgnore) s += ' ON CONFLICT DO NOTHING';
      else {
        const pk = (meta && meta.pk.get(insertTable)) || ['id'];
        const colsM = /INTO\s+"?\w+"?\s*\(([^)]*)\)/i.exec(s);
        const cols = colsM ? colsM[1].split(',').map((x) => x.trim().replace(/"/g, '')) : [];
        const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
        s += ` ON CONFLICT (company_no, ${pk.join(', ')}) ` + (upd.length ? 'DO UPDATE SET ' + upd.join(', ') : 'DO NOTHING');
      }
    }
    const idCol = meta && meta.identity.get(insertTable);
    if (idCol && !/\bRETURNING\b/i.test(s)) s += ` RETURNING ${idCol} AS __rre_id`;
  }
  const values = outParams.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v));
  return { text: s, values, insertTable };
}

// ------------------------------------------------------------------------------------------------ SQLite-only statements
async function pragmaOrDdl(sql, ctx) {
  const ti = /^\s*PRAGMA\s+table_info\s*\(\s*['"]?(\w+)['"]?\s*\)/i.exec(sql);
  if (ti) {
    const cols = (meta.cols.get(ti[1].toLowerCase()) || []).filter((c) => c.column_name !== 'company_no' && !c.column_name.startsWith('_'));
    const pk = meta.pk.get(ti[1].toLowerCase()) || [];
    return cols.map((c, i) => ({ cid: i, name: c.column_name, type: c.data_type, notnull: c.is_nullable === 'NO' ? 1 : 0, dflt_value: c.column_default, pk: pk.indexOf(c.column_name) + 1 }));
  }
  if (/^\s*PRAGMA\s+integrity_check/i.test(sql)) return [{ integrity_check: 'ok' }];
  if (/^\s*PRAGMA\s+foreign_key_check/i.test(sql)) return [];
  if (/^\s*PRAGMA\s+foreign_keys\s*$/i.test(sql)) return [{ foreign_keys: 1 }]; // PostgreSQL always enforces foreign keys
  return [];
}

function rewriteSqliteMaster(sql) {
  if (!/\bsqlite_master\b/i.test(sql)) return null;
  return sql.replace(/\bsqlite_master\b/gi, "(SELECT 'table' AS type, table_name::text AS name, table_name::text AS tbl_name, '' AS sql FROM information_schema.tables WHERE table_schema = 'rre' UNION ALL SELECT 'index', indexname::text, tablename::text, indexdef FROM pg_indexes WHERE schemaname = 'rre') AS sqlite_master");
}

// ------------------------------------------------------------------------------------------------ execution
/** ctx = { company, user } of the current request (see core/db.js). */
/** One statement at a time on a pinned (in-transaction) connection: requests of the company take turns, as on SQLite's single connection. */
function makeLock() { let tail = Promise.resolve(); return () => { let open; const next = new Promise((r) => { open = r; }); const prev = tail; tail = prev.then(() => next); return prev.then(() => open); }; }
/**
 * Which pinned transaction a statement belongs to: a transaction opened by core/tx.js carries its own id (only ITS statements use
 * its connection; other requests run in parallel). A plain BEGIN without an id (start-up migrations) pins the whole company, as on SQLite.
 */
const pinKey = (ctx) => (ctx.txId ? 'tx:' + ctx.txId : 'co:' + ctx.company);
const pinnedFor = (ctx) => (ctx.txId && pinned.get('tx:' + ctx.txId)) || pinned.get('co:' + ctx.company);
async function clientFor(ctx) {
  const p = pinnedFor(ctx);
  if (p) {
    const unlock = await p.lock();
    if (pinnedFor(ctx) === p) return { client: p.client, release: () => unlock(), inTx: true };
    unlock(); // the transaction ended while this statement waited: use an ordinary connection
  }
  const client = await pool.connect();
  return { client, release: (err) => client.release(err), inTx: false };
}
async function applyCtx(client, ctx) {
  const st = client.rre || (client.rre = {});
  if (!st.ready) { await client.query("SET ROLE rre_app; SET search_path = rre, public; SET lock_timeout = '" + (process.env.RRE_PG_LOCK_TIMEOUT || '15s') + "'"); st.ready = true; } // a wait for a locked row ends with an error, never hangs // once per connection: row level security applies from here on
  const company = ctx.company == null ? '' : String(ctx.company), user = ctx.user == null ? '' : String(ctx.user);
  if (st.company === company && st.user === user) return;
  await client.query("SELECT set_config('rre.company_id', $1, false), set_config('rre.user_id', $2, false)", [company, user]);
  st.company = company; st.user = user;
}

/**
 * SQLite also accepts grouped queries that select columns of a joined table that the GROUP BY does not name (for example the group of
 * a ledger while grouping by the ledger). PostgreSQL names the exact column and its position: that table's key (x.id, x.company_no) is
 * added to the GROUP BY of that query level and the query runs again. The working version is remembered, so this happens once per query.
 * Inside a transaction the first run of a grouped query is protected by a savepoint, so a retry never spoils the transaction.
 */
const fixed = new Map(), groupOk = new Set();
async function queryWithGroupFix(client, t, inTx) {
  if (groupOk.has(t.text)) return client.query(t);
  const original = t.text;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (inTx) await client.query('SAVEPOINT rre_group_fix');
    try {
      const r = await client.query(t);
      if (inTx) await client.query('RELEASE SAVEPOINT rre_group_fix');
      if (groupOk.size > 20000) groupOk.clear(); if (fixed.size > 5000) fixed.clear(); // SQL built with inline values must not grow the caches forever
      if (t.text === original) groupOk.add(original); else fixed.set(original, t.text);
      return r;
    } catch (e) {
      if (inTx) await client.query('ROLLBACK TO SAVEPOINT rre_group_fix').then(() => client.query('RELEASE SAVEPOINT rre_group_fix')).catch(() => {});
      let next = null;
      const m = e.code === '42803' && /column "([\w.]+)" must appear in the GROUP BY/.exec(e.message);
      if (m && e.position) next = wrapMin(t.text, +e.position - 1);
      const a = e.code === '42703' && /column "(\w+)" does not exist/.exec(e.message);
      if (a && e.position) next = substituteAlias(t.text, +e.position - 1, a[1]);
      if (!next || next === t.text) throw e;
      t = { ...t, text: next };
    }
  }
  throw new Error('Could not adapt a query for PostgreSQL: ' + original.slice(0, 200));
}
/**
 * The query level that contains position pos: [start, end) of the SELECT ... it belongs to. A bracket that opens with SELECT starts a
 * nested query; any other bracket (a function call, an IN list) belongs to the level around it.
 */
function levelOf(mk, pos) {
  const stack = [];
  for (let k = 0; k < pos && k < mk.length; k++) {
    if (mk[k] === '(') stack.push({ k, sub: /^\(\s*(SELECT|WITH)\b/i.test(mk.slice(k, k + 14)) });
    else if (mk[k] === ')') stack.pop();
  }
  let start = 0;
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].sub) { start = stack[i].k + 1; break; }
  let depth = 0, end = start;
  for (; end < mk.length; end++) { if (mk[end] === '(') depth++; else if (mk[end] === ')') { if (depth === 0) break; depth--; } }
  return [start, end];
}
/** Positions of a keyword pattern that sit directly in the level [start, end) (not inside any bracket of it). */
function topLevel(mk, start, end, re) {
  const up = mk.toUpperCase(), out = []; let depth = 0;
  for (let k = start; k < end; k++) {
    const ch = mk[k];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\W/.test(mk[k - 1] || ' ')) { const m = re.exec(up.slice(k, k + 16)); if (m && m.index === 0) out.push({ k, len: m[0].length }); }
  }
  return out;
}
const CLAUSE_END = /^(HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW)\b/;
/**
 * SQLite allows a column in a grouped (or aggregate) query that is neither grouped nor aggregated, and returns a value from the group.
 * PostgreSQL names the column and its position; it is wrapped in MIN(): for a column with one value per group (a ledger's group name
 * while grouping by the ledger) that is the very same value, and otherwise it is a value from the group, as SQLite returns.
 * The grouping itself is never changed.
 */
function wrapMin(s, pos) {
  const m = /^((?:"?\w+"?\.)?"?(\w+)"?)/.exec(s.slice(pos));
  if (!m) return null;
  // a whole select-list item keeps its output name (a.batch_no -> MIN(a.batch_no) AS batch_no)
  const mk = maskLiterals(s); let keepName = false;
  const [start, end] = levelOf(mk, pos);
  const sel = topLevel(mk, start, end, /^SELECT\b/)[0], from = topLevel(mk, start, end, /^FROM\b/)[0];
  if (sel && from && pos > sel.k && pos < from.k) {
    const ls = sel.k + sel.len, list = mk.slice(ls, from.k);
    for (const [a, b] of splitTop(list)) if (ls + a <= pos && pos < ls + b && list.slice(a, b).trim().replace(/^DISTINCT\s+/i, '') === m[1]) keepName = true;
  }
  return s.slice(0, pos) + 'MIN(' + m[1] + ')' + (keepName ? ' AS ' + m[2] : '') + s.slice(pos + m[1].length);
}
/** Splits a select list at the commas of its own level. */
function splitTop(list) { const out = []; let depth = 0, last = 0; for (let k = 0; k < list.length; k++) { const ch = list[k]; if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && depth === 0) { out.push([last, k]); last = k + 1; } } out.push([last, list.length]); return out; }

/**
 * SQLite lets HAVING / WHERE / ORDER BY use a name given in the SELECT list (SUM(x) AS total ... HAVING total > 0). PostgreSQL reports
 * the unknown name and its position: the name is replaced there by the expression it stands for.
 */
function substituteAlias(s, pos, name) {
  const mk = maskLiterals(s);
  if (mk.slice(pos, pos + name.length).toLowerCase() !== name.toLowerCase()) return null;
  const [start, end] = levelOf(mk, pos);
  const sel = topLevel(mk, start, end, /^SELECT\b/)[0], from = topLevel(mk, start, end, /^FROM\b/)[0];
  if (!sel || !from || pos < from.k) return null; // the name is in the select list itself: not an alias problem
  const lstart = sel.k + sel.len, list = mk.slice(lstart, from.k);
  for (const [a, b] of splitTop(list)) {
    const item = list.slice(a, b), mm = new RegExp('^([\\s\\S]*?)\\s+(?:AS\\s+)?"?' + name + '"?\\s*$', 'i').exec(item);
    if (mm && mm[1].trim()) { const expr = s.slice(lstart + a, lstart + a + mm[1].length).trim(); return s.slice(0, pos) + '(' + expr + ')' + s.slice(pos + name.length); }
  }
  return null;
}
/** Adds alias.id, alias.company_no to the GROUP BY of the query level that contains position pos. */
function addGroupKey(s, pos, alias) {
  const mk = maskLiterals(s), up = mk.toUpperCase();
  const [start, end] = levelOf(mk, pos);
  const g = topLevel(mk, start, end, /^GROUP\s+BY\b/)[0];
  if (!g) return null;
  const stop = topLevel(mk, g.k + g.len, end, CLAUSE_END)[0];
  const j = stop ? stop.k : end;
  const list = mk.slice(g.k + g.len, j);
  const add = [`${alias}.id`, `${alias}.company_no`].filter((c) => !new RegExp('\\b' + c.replace('.', '\\.') + '\\b').test(list));
  if (!add.length) return null;
  void up;
  return s.slice(0, j).replace(/\s*$/, '') + ', ' + add.join(', ') + ' ' + s.slice(j);
}

async function exec(sql, params, ctx) {
  if (!pool) throw new Error('PostgreSQL is not connected.');
  const txm = TX.exec(sql);
  if (txm) return txControl(txm[1].toUpperCase(), sql, ctx);
  if (DDL.test(sql)) return { rows: await pragmaOrDdl(sql, ctx), rowCount: 0, ddl: true };
  const t = translate(rewriteSqliteMaster(sql) || sql, params);
  const known = fixed.get(t.text);
  if (known) t.text = known;
  const { client, release, inTx } = await clientFor(ctx);
  let err = null;
  try {
    await applyCtx(client, ctx);
    const go = () => (known || !/^\s*(SELECT|WITH)\b/i.test(t.text) ? client.query(t) : queryWithGroupFix(client, t, inTx));
    if (!inTx) return await go();
    // Inside a transaction, a failing statement must fail ALONE (as in SQLite) and not abort the whole transaction,
    // which other requests of the same company are using too: every statement gets its own savepoint.
    await client.query('SAVEPOINT rre_stmt');
    try { const r = await go(); await client.query('RELEASE SAVEPOINT rre_stmt'); return r; }
    catch (e) { await client.query('ROLLBACK TO SAVEPOINT rre_stmt').then(() => client.query('RELEASE SAVEPOINT rre_stmt')).catch(() => {}); throw e; }
  } catch (e) {
    // the application recognises constraint errors by SQLite's wording (/UNIQUE/ etc.): same words first, PostgreSQL's details after
    const SQLITE_WORDS = { 23505: 'UNIQUE constraint failed', 23503: 'FOREIGN KEY constraint failed', 23502: 'NOT NULL constraint failed', 23514: 'CHECK constraint failed' };
    if (SQLITE_WORDS[e.code]) { e.message = `${SQLITE_WORDS[e.code]}: ${e.table ? e.table + (e.constraint ? ' (' + e.constraint + ')' : '') : e.constraint || ''} - ${e.message}`; e.sqliteCode = 'SQLITE_CONSTRAINT'; }
    err = e; e.message = e.message + ' [SQL: ' + String(sql).replace(/\s+/g, ' ').slice(0, 240) + ']'; if (process.env.RRE_PG_LOG_ERRORS === '1' || process.env.RRE_PG_LOG_ERRORS === '2') console.error('[Database] ' + (e.code || '') + ' ' + e.message + (process.env.RRE_PG_LOG_ERRORS === '2' ? ' params=' + JSON.stringify(t.values).slice(0, 300) : '')); throw e; } finally { release(err && !inTx && err.code && /^(08|57)/.test(err.code) ? err : undefined); }
}

async function txControl(word, sql, ctx) {
  const key = pinKey(ctx);
  if (word === 'BEGIN') {
    if (pinned.has(key)) throw new Error('cannot start a transaction within a transaction');
    const client = await pool.connect();
    try { await applyCtx(client, ctx); await client.query('BEGIN'); } catch (e) { client.release(); throw e; }
    pinned.set(key, { client, lock: makeLock(), company: String(ctx.company) });
    return { rows: [], rowCount: 0 };
  }
  if (word === 'COMMIT' || word === 'END' || word === 'ROLLBACK') {
    if (/ROLLBACK\s+TO/i.test(sql) || !pinned.has(key)) { if (!pinned.has(key)) throw new Error('cannot ' + word.toLowerCase() + ' - no transaction is active'); }
    const p = pinned.get(key);
    const unlock = await p.lock(); // wait for statements already running on the transaction
    try {
      if (/ROLLBACK\s+TO/i.test(sql)) { await p.client.query(sql); return { rows: [], rowCount: 0 }; }
      if (pinned.get(key) !== p) throw new Error('cannot ' + word.toLowerCase() + ' - no transaction is active');
      pinned.delete(key);
      try { await p.client.query(word === 'ROLLBACK' ? 'ROLLBACK' : 'COMMIT'); p.client.release(); }
      catch (e) { await p.client.query('ROLLBACK').catch(() => {}); p.client.release(); throw e; }
      return { rows: [], rowCount: 0 };
    } finally { unlock(); }
  }
  // SAVEPOINT / RELEASE inside a pinned transaction
  const p = pinned.get(key); if (!p) throw new Error('no transaction is active');
  const unlock = await p.lock();
  try { await p.client.query(sql); return { rows: [], rowCount: 0 }; } finally { unlock(); }
}

async function run(sql, params, ctx) {
  const r = await exec(sql, params, ctx);
  const first = r.rows && r.rows[0];
  return { lastID: first && first.__rre_id != null ? first.__rre_id : undefined, changes: r.rowCount || 0 };
}
const strip = (row) => { if (row && '__rre_id' in row) { const { __rre_id, ...rest } = row; return rest; } return row; };
async function get(sql, params, ctx) { const r = await exec(sql, params, ctx); return r.rows ? strip(r.rows[0]) : undefined; }
async function all(sql, params, ctx) { const r = await exec(sql, params, ctx); return r.rows ? r.rows.map(strip) : []; }

/** Raw access for tools (copier, tests): runs with an explicit company. */
async function withClient(fn) { const c = await pool.connect(); try { return await fn(c); } finally { c.rre = {}; c.release(); } } // settings changed by fn: the next user of this connection sets them again
const inTransaction = (company) => pinned.has('co:' + company) || [...pinned.values()].some((p) => p.company === String(company));

module.exports = { init, end, run, get, all, translate, connectionOptions, withClient, inTransaction, loadMeta, get pool() { return pool; } };

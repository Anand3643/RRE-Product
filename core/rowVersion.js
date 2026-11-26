/**
 * RRE Tally — no silent overwriting when two devices (or two people) edit the same record.
 *
 * Every record people edit carries a version number (column row_version, raised by a database trigger on every change:
 * SQLite migration 024 / PostgreSQL 008). This middleware:
 *   - adds the CURRENT row_version to every record returned by the routes below, so the browser knows which version it shows;
 *   - when a PUT / PATCH / DELETE of one record says which version it was made from (header X-Row-Version, or _row_version in the
 *     body), refuses the change with 409 ROW_CONFLICT if the record has changed since. Nothing is written in that case;
 *   - lets writes to the same record run one after another (never interleaved), so "check version, then save" cannot be raced by a
 *     second save arriving at the same moment. Writes to different records are not held up.
 * Requests that do not send a version (older screens, scripts, tests) behave exactly as before.
 * The lock is inside this server process: RRE runs as ONE server process per database (docs/CLOUD_DATABASE.md).
 */
const db = require('./db');

// API path (after /api) -> table. `id` = the path names one record.
const FAMILIES = [
  { re: /^\/inv\/items(?:\/(\d+))?\/?$/, table: 'stock_items' },
  { re: /^\/inv\/categories(?:\/(\d+))?\/?$/, table: 'stock_groups' },
  { re: /^\/inv\/units(?:\/(\d+))?\/?$/, table: 'units_of_measure' },
  { re: /^\/inv\/warehouses(?:\/(\d+))?\/?$/, table: 'godowns' },
  { re: /^\/inv\/(?:customers|suppliers)(?:\/(\d+))?\/?$/, table: 'ledgers' },
  { re: /^\/inv\/orders\/(\d+)\/?$/, table: 'inv_orders' },
  { re: /^\/inv\/(?:sales-orders|purchase-orders)\/?$/, table: 'inv_orders' },
  { re: /^\/quotations(?:\/(\d+))?\/?$/, table: 'quotations' },
  { re: /^\/vouchers(?:\/(\d+))?\/?$/, table: 'vouchers' },
  { re: /^\/masters\/ledgers(?:\/(\d+))?\/?$/, table: 'ledgers' }
];
const WRITE = new Set(['PUT', 'PATCH', 'DELETE']);

function match(path) {
  for (const f of FAMILIES) { const m = f.re.exec(path); if (m) return { table: f.table, id: m[1] ? parseInt(m[1], 10) : null }; }
  return null;
}

// one queue per record (company|table|id)
const queues = new Map();
function lockRecord(key) {
  const prev = queues.get(key) || Promise.resolve();
  let release; const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  queues.set(key, chain);
  return prev.then(() => () => { release(); if (queues.get(key) === chain) queues.delete(key); });
}

async function versionOf(table, id) {
  const r = await db.get(`SELECT row_version FROM ${table} WHERE id = ?`, [id]);
  return r ? Number(r.row_version) : null;
}

/** The records a response is about: the record itself, or the rows of a list (top level only - nested rows belong to other tables). */
function rootsOf(body) {
  const root = body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
  const isRec = (o) => o && typeof o === 'object' && !Array.isArray(o) && o.id != null && Number.isFinite(Number(o.id));
  if (Array.isArray(root)) return root.filter(isRec);
  if (isRec(root)) return [root];
  if (root && typeof root === 'object') { // { items: [...], total } and similar list envelopes
    for (const k of ['items', 'rows', 'orders', 'parties', 'customers', 'suppliers', 'data']) if (Array.isArray(root[k])) return root[k].filter(isRec);
  }
  return [];
}

async function stamp(table, recs) {
  if (!recs.length) return;
  const ids = [...new Set(recs.map((r) => Number(r.id)))];
  const ver = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of await db.all(`SELECT id, row_version FROM ${table} WHERE id IN (${part.map(() => '?').join(',')})`, part)) ver.set(Number(r.id), Number(r.row_version));
  }
  for (const r of recs) if (ver.has(Number(r.id))) r.row_version = ver.get(Number(r.id));
}

/** Wraps res.json so the reply carries the current versions (async, before it is sent). */
function stampReplies(res, table, after) {
  const json = res.json.bind(res);
  res.json = (body) => {
    (async () => {
      try {
        if (res.statusCode < 400) { await stamp(table, rootsOf(body)); if (after) await after(body); }
      } catch (e) { /* the versions are an addition: never lose the reply over them */ }
      json(body);
    })();
    return res;
  };
}

function middleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const fam = match(req.path.slice(4));
  if (!fam) return next();
  if (req.method === 'GET') { stampReplies(res, fam.table); return next(); }
  if (!WRITE.has(req.method) || !fam.id) return next();

  let expected = req.get('X-Row-Version');
  if (req.body && typeof req.body === 'object' && req.body._row_version != null) { expected = expected || req.body._row_version; delete req.body._row_version; }
  expected = expected != null && String(expected).trim() !== '' ? parseInt(String(expected).replace(/[^0-9]/g, ''), 10) : null;

  const key = `${db.getCompanyNumber()}|${fam.table}|${fam.id}`;
  lockRecord(key).then(async (release) => {
    let released = false; const done = () => { if (!released) { released = true; release(); } };
    res.on('finish', done); res.on('close', done);
    try {
      if (expected != null && Number.isFinite(expected)) {
        const current = await versionOf(fam.table, fam.id);
        if (current != null && current !== expected) {
          return res.status(409).json({
            success: false, code: 'ROW_CONFLICT', current_version: current, your_version: expected,
            error: 'This record was changed on another device (or by another user) after you opened it. Your changes were NOT saved, so nothing was overwritten. The latest version has been loaded: check it and make your change again.'
          });
        }
      }
      if (req.method !== 'DELETE') stampReplies(res, fam.table, async () => { const v = await versionOf(fam.table, fam.id); if (v != null && !res.headersSent) res.set('X-Row-Version', String(v)); });
      next();
    } catch (err) { done(); next(err); }
  }, next);
}

module.exports = { middleware, FAMILIES, match };

/**
 * Load test on a DISPOSABLE copy of the company, with SQLite or PostgreSQL:
 *   node scripts/load-test.js                       (SQLite)
 *   npm run test:pg -- scripts/load-test.js         (PostgreSQL: a local PostgreSQL 17 on this computer)
 * Adds a large data set (vouchers, customers, items), then runs simulated users at increasing concurrency against a realistic
 * mix: dashboard, trial balance, day book, ledger list, stock summary, balance sheet (reads) and posting journal vouchers (writes).
 * Prints per level: requests, errors, throughput, p50 / p95 / p99 / max response time, memory.
 * Options (environment): LOAD_LEVELS=10,25,50,100  LOAD_REQUESTS=300 (per level)  LOAD_VOUCHERS=5000  LOAD_PARTIES=1000  LOAD_ITEMS=500
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RRE_DATA_DIR = process.env.RRE_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'rre_load_'));
process.env.RRE_LEGACY_TOKENS = '1'; process.env.RRE_ENFORCE_AUTH = '1'; process.env.RRE_INVENTORY_SEED = '0'; process.env.RRE_BRIDGE_AUTO = '0';
process.env.RRE_LOG_LEVEL = process.env.RRE_LOG_LEVEL || 'warn';

const LEVELS = (process.env.LOAD_LEVELS || '10,25,50,100').split(',').map(Number);
const PER_LEVEL = parseInt(process.env.LOAD_REQUESTS || '300', 10);
const NV = parseInt(process.env.LOAD_VOUCHERS || '5000', 10), NP = parseInt(process.env.LOAD_PARTIES || '1000', 10), NI = parseInt(process.env.LOAD_ITEMS || '500', 10);

async function seed(db) {
  const { run, get } = db;
  const t0 = Date.now();
  const grp = async (n) => (await get('SELECT id FROM account_groups WHERE name = ?', [n])).id;
  const debt = await grp('Sundry Debtors'), salesG = await grp('Sales Accounts');
  const maxL = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM ledgers')).m, maxV = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM vouchers')).m, maxI = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM stock_items')).m;
  const uom = (await get('SELECT id FROM units_of_measure ORDER BY id LIMIT 1')).id, sg = (await get('SELECT id FROM stock_groups ORDER BY id LIMIT 1')).id;
  const batch = async (sql, rows, width) => { for (let i = 0; i < rows.length; i += 200) { const part = rows.slice(i, i + 200); await run(sql + part.map(() => '(' + Array(width).fill('?').join(', ') + ')').join(', '), part.flat()); } };
  await require('../core/tx').withTransaction(async () => {
    const salesL = maxL + NP + 1;
    await batch('INSERT INTO ledgers (id, name, group_id, opening_balance, opening_balance_type) VALUES ', Array.from({ length: NP }, (_, i) => [maxL + 1 + i, `Load Customer ${i + 1}`, debt, 0, 'Dr']), 5);
    await batch('INSERT INTO ledgers (id, name, group_id, opening_balance, opening_balance_type) VALUES ', [[salesL, 'Load Sales', salesG, 0, 'Cr']], 5);
    await batch('INSERT INTO stock_items (id, name, stock_group_id, uom_id, opening_qty, opening_rate, opening_val) VALUES ', Array.from({ length: NI }, (_, i) => [maxI + 1 + i, `Load Item ${i + 1}`, sg, uom, 0, 0, 0]), 7);
    const vs = [], es = [];
    for (let i = 0; i < NV; i++) {
      const id = maxV + 1 + i, amt = 100 + (i % 900), d = `2026-${String(4 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, party = maxL + 1 + (i % NP);
      vs.push([id, 'Sales', `LOAD/${id}`, d, party, amt]);
      es.push([id, party, 'Dr', amt, 0], [id, salesL, 'Cr', 0, amt]);
    }
    await batch('INSERT INTO vouchers (id, voucher_type, voucher_no, date, party_ledger_id, total_amount) VALUES ', vs, 6);
    await batch('INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount) VALUES ', es, 5);
  });
  return Date.now() - t0;
}

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  const db = require('../core/db');
  await db.initDb(); await require('../core/migrations').runMigrations();
  const seedMs = await seed(db);
  const counts = { vouchers: (await db.get('SELECT COUNT(*) AS n FROM vouchers')).n, ledger_entries: (await db.get('SELECT COUNT(*) AS n FROM ledger_entries')).n, ledgers: (await db.get('SELECT COUNT(*) AS n FROM ledgers')).n, stock_items: (await db.get('SELECT COUNT(*) AS n FROM stock_items')).n };
  const srv = await require('../server').startServer(16000 + Math.floor(Math.random() * 500), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const tok = require('../core/security').createSessionToken({ id: 1, username: 'admin', role: 'Owner' });
  const cash = (await db.get("SELECT id FROM ledgers WHERE name = 'Cash'")).id, rent = (await db.get("SELECT id FROM ledgers WHERE group_id = (SELECT id FROM account_groups WHERE name = 'Indirect Expenses') ORDER BY id LIMIT 1")).id;
  const READS = ['/api/dashboard/tiles', '/api/reports/trial-balance', process.env.LOAD_DAYBOOK_ALL ? '/api/reports/daybook' : '/api/reports/daybook?limit=200&entries=0', /* as the Day Book screen asks */ '/api/masters/ledgers', '/api/reports/stock-summary', '/api/reports/balance-sheet'];
  const one = async (i) => {
    const write = i % 10 < 3; // 30 % writes
    const t = process.hrtime.bigint();
    let ok = false, status = 0;
    try {
      const r = write
        ? await fetch(base + '/api/vouchers', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ voucher_type: 'Journal', date: '2026-08-01', entries: [{ ledger_id: rent, debit_amount: 10, credit_amount: 0 }, { ledger_id: cash, debit_amount: 0, credit_amount: 10 }] }) })
        : await fetch(base + READS[i % READS.length], { headers: { Authorization: 'Bearer ' + tok } });
      status = r.status; await r.arrayBuffer(); ok = r.status === 200;
    } catch (e) { status = -1; }
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, ok, write, status };
  };
  const engine = db.isPostgres() ? 'PostgreSQL 17 (local, same computer)' : 'SQLite (local file)';
  console.log(`\nEngine: ${engine}\nData: ${JSON.stringify(counts)} (seeded in ${seedMs} ms)\nCPU: ${os.cpus()[0].model} x${os.cpus().length}, RAM ${Math.round(os.totalmem() / 2 ** 30)} GB\n`);
  console.log('users | requests | errors | req/s | p50 ms | p95 ms | p99 ms | max ms | writes p95 ms | heap MB');
  const results = [];
  for (const c of LEVELS) {
    let next = 0; const out = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: c }, async () => { while (next < PER_LEVEL) { const i = next++; out.push(await one(i)); } }));
    const secs = (Date.now() - t0) / 1000;
    const ms = out.map((o) => o.ms), wr = out.filter((o) => o.write).map((o) => o.ms), errs = out.filter((o) => !o.ok);
    const row = { users: c, requests: out.length, errors: errs.length, rps: +(out.length / secs).toFixed(1), p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), p99: +pct(ms, 99).toFixed(1), max: +Math.max(...ms).toFixed(1), write_p95: +pct(wr, 95).toFixed(1), heap_mb: Math.round(process.memoryUsage().heapUsed / 2 ** 20), error_statuses: [...new Set(errs.map((e) => e.status))] };
    results.push(row);
    console.log(`${String(c).padStart(5)} | ${String(row.requests).padStart(8)} | ${String(row.errors).padStart(6)} | ${String(row.rps).padStart(5)} | ${String(row.p50).padStart(6)} | ${String(row.p95).padStart(6)} | ${String(row.p99).padStart(6)} | ${String(row.max).padStart(6)} | ${String(row.write_p95).padStart(13)} | ${row.heap_mb}${row.errors ? '  errors: ' + row.error_statuses.join(',') : ''}`);
  }
  const unbalanced = (await db.all('SELECT v.id FROM vouchers v JOIN ledger_entries e ON e.voucher_id = v.id GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0')).length;
  console.log(`\nAfter the load: ${unbalanced} unbalanced vouchers; journals posted: ${(await db.get("SELECT COUNT(*) AS n FROM vouchers WHERE voucher_type = 'Journal' AND date = '2026-08-01'")).n}`);
  if (process.env.LOAD_JSON) fs.writeFileSync(process.env.LOAD_JSON, JSON.stringify({ engine, counts, seedMs, results }, null, 2));
  process.exit(results.some((r) => r.errors) || unbalanced ? 1 : 0);
}
module.exports = { seed };
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

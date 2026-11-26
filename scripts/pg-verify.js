/**
 * Migration verification report: compares every company's SQLite file on this computer with its copy in the central
 * PostgreSQL / Supabase database (DATABASE_URL), and writes a report.
 *   npm run db:verify                    every company under data/
 *   npm run db:verify -- 100000          only these companies
 * Checks, per company: row count of EVERY table; missing / extra record ids in the main tables; debit and credit totals; balance
 * of every ledger; sales / purchase / receipt / payment / journal ... count and total per voucher type; GST ledger balances;
 * quantity on hand per stock item and warehouse; duplicate voucher numbers; users and roles.
 * Read-only on both sides. The report goes to data/migration-report-<date>.md (data/ is never committed: it holds business figures).
 * Exit code 0 = everything identical.
 */
const fs = require('fs');
const path = require('path');

const MAIN = ['vouchers', 'ledger_entries', 'ledgers', 'account_groups', 'stock_items', 'inventory_entries', 'godowns', 'users', 'quotations', 'inv_orders', 'bill_allocations'];

async function main() {
  require('../core/env').load();
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set (see docs/HOSTING.md).'); process.exit(2); }
  const paths = require('../core/paths');
  const root = path.dirname(paths.companyDir('100000'));
  let companies = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!companies.length) companies = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'company.db')));
  const sqlite3 = require('sqlite3');
  const { Client } = require('pg');
  const pgc = new Client(require('../core/pgAdapter').connectionOptions(url)); await pgc.connect();
  const host = new URL(url).hostname;
  const out = [`# Migration verification report`, ``, `Generated ${new Date().toISOString()} · central database host: \`${host}\` · companies: ${companies.join(', ')}`, ``];
  let problems = 0;
  const pgTables = new Set((await pgc.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'rre' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name));

  // read exactly as the application does: the restricted role, one company at a time (row level security applies)
  await pgc.query('SET ROLE rre_app');
  for (const co of companies) {
    await pgc.query("SELECT set_config('rre.company_id', $1, false)", [String(co)]);
    const db = new sqlite3.Database(path.join(root, co, 'company.db'), sqlite3.OPEN_READONLY);
    const sq = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
    const pg = async (sql, p = []) => (await pgc.query(sql, [co, ...p])).rows; // $1 = company
    const sec = []; let bad = 0;
    const row = (name, a, b, eq = (x, y) => String(x) === String(y)) => { const ok = eq(a, b); if (!ok) bad++; sec.push(`| ${name} | ${a} | ${b} | ${ok ? 'identical' : '**DIFFERENT**'} |`); };
    const num = (x, y) => Math.abs(Number(x) - Number(y)) < 0.005;
    const r2 = (v) => Number(v || 0).toFixed(2);

    // 1. every table
    sec.push('', '**Row count of every table**', '', '| Table | This computer (SQLite) | Central database | Result |', '|---|---|---|---|');
    const tables = (await sq("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
    for (const t of tables) {
      const a = (await sq(`SELECT COUNT(*) n FROM "${t}"`))[0].n;
      if (!pgTables.has(t)) { row(t, a, 'table missing', () => a === 0); continue; }
      const b = Number((await pg(`SELECT COUNT(*) n FROM rre."${t}" WHERE company_no = $1`))[0].n);
      row(t, a, b, (x, y) => Number(x) === Number(y));
    }
    // 2. ids
    sec.push('', '**Record ids (missing or extra records)**', '', '| Table | Missing in central | Extra in central | Result |', '|---|---|---|---|');
    for (const t of MAIN.filter((x) => tables.includes(x) && pgTables.has(x))) {
      const a = new Set((await sq(`SELECT id FROM "${t}"`)).map((r) => Number(r.id)));
      const b = new Set((await pg(`SELECT id FROM rre."${t}" WHERE company_no = $1`)).map((r) => Number(r.id)));
      const missing = [...a].filter((i) => !b.has(i)), extra = [...b].filter((i) => !a.has(i));
      if (missing.length || extra.length) bad++;
      sec.push(`| ${t} | ${missing.length ? missing.slice(0, 10).join(', ') + (missing.length > 10 ? ' …' : '') : 'none'} | ${extra.length ? extra.slice(0, 10).join(', ') : 'none'} | ${missing.length || extra.length ? '**DIFFERENT**' : 'same ids'} |`);
    }
    // 3. money
    sec.push('', '**Money**', '', '| Check | This computer | Central database | Result |', '|---|---|---|---|');
    const [sa] = await sq('SELECT ROUND(COALESCE(SUM(debit_amount),0),2) d, ROUND(COALESCE(SUM(credit_amount),0),2) c FROM ledger_entries');
    const [pa] = await pg('SELECT ROUND(COALESCE(SUM(debit_amount),0),2) d, ROUND(COALESCE(SUM(credit_amount),0),2) c FROM rre.ledger_entries WHERE company_no = $1');
    row('Total debits', r2(sa.d), r2(pa.d), num); row('Total credits', r2(sa.c), r2(pa.c), num);
    row('Debits = credits in the central database', 'yes', num(pa.d, pa.c) ? 'yes' : 'NO');
    const types = await sq('SELECT voucher_type t, COUNT(*) n, ROUND(COALESCE(SUM(total_amount),0),2) s FROM vouchers GROUP BY voucher_type ORDER BY voucher_type');
    const ptypes = new Map((await pg('SELECT voucher_type t, COUNT(*) n, ROUND(COALESCE(SUM(total_amount),0),2) s FROM rre.vouchers WHERE company_no = $1 GROUP BY voucher_type')).map((r) => [r.t, r]));
    for (const t of types) { const p = ptypes.get(t.t) || { n: 0, s: 0 }; row(`${t.t}: number / total`, `${t.n} / ${r2(t.s)}`, `${Number(p.n)} / ${r2(p.s)}`); }
    // every ledger's balance (opening + movements)
    const bal = async (rows) => new Map(rows.map((r) => [Number(r.id), r2(r.b)]));
    const sBal = await bal(await sq("SELECT l.id, (CASE WHEN l.opening_balance_type = 'Cr' THEN -1 ELSE 1 END) * COALESCE(l.opening_balance,0) + COALESCE((SELECT SUM(debit_amount - credit_amount) FROM ledger_entries e WHERE e.ledger_id = l.id),0) b FROM ledgers l"));
    const pBal = await bal(await pg("SELECT l.id, (CASE WHEN l.opening_balance_type = 'Cr' THEN -1 ELSE 1 END) * COALESCE(l.opening_balance,0) + COALESCE((SELECT SUM(debit_amount - credit_amount) FROM rre.ledger_entries e WHERE e.company_no = l.company_no AND e.ledger_id = l.id),0) b FROM rre.ledgers l WHERE l.company_no = $1"));
    const ledDiff = [...sBal].filter(([id, b]) => !num(b, pBal.get(id)));
    row('Balance of every ledger (opening + entries)', `${sBal.size} ledgers`, ledDiff.length ? `${ledDiff.length} differ` : `${pBal.size} ledgers, all equal`, () => !ledDiff.length && sBal.size === pBal.size);
    const gst = await sq("SELECT l.id, l.name FROM ledgers l WHERE l.name LIKE '%GST%' OR l.name LIKE '%Cess%' ORDER BY l.name");
    for (const g of gst) if (sBal.get(Number(g.id)) !== '0.00' || (pBal.get(Number(g.id)) || '0.00') !== '0.00') row(`GST ledger: ${g.name}`, sBal.get(Number(g.id)), pBal.get(Number(g.id)) || 'missing', num);
    // 4. stock
    sec.push('', '**Stock**', '', '| Check | This computer | Central database | Result |', '|---|---|---|---|');
    const sStock = new Map((await sq("SELECT s.id || ':' || COALESCE(e.godown_id, 0) k, ROUND(SUM(CASE WHEN e.direction = 'IN' THEN e.quantity ELSE -e.quantity END), 4) q FROM stock_items s JOIN inventory_entries e ON e.stock_item_id = s.id GROUP BY k")).map((r) => [r.k, Number(r.q)]));
    const pStock = new Map((await pg("SELECT s.id || ':' || COALESCE(e.godown_id, 0) k, ROUND(SUM(CASE WHEN e.direction = 'IN' THEN e.quantity ELSE -e.quantity END), 4) q FROM rre.stock_items s JOIN rre.inventory_entries e ON e.company_no = s.company_no AND e.stock_item_id = s.id WHERE s.company_no = $1 GROUP BY 1")).map((r) => [r.k, Number(r.q)]));
    const stockDiff = [...sStock].filter(([k, q]) => Math.abs(q - (pStock.get(k) || 0)) > 0.0001);
    row('Quantity moved per item and warehouse', `${sStock.size} item/warehouse pairs`, stockDiff.length ? `${stockDiff.length} differ` : `${pStock.size} pairs, all equal`, () => !stockDiff.length && sStock.size === pStock.size);
    const [so] = await sq('SELECT ROUND(COALESCE(SUM(opening_qty),0),4) q, ROUND(COALESCE(SUM(opening_val),0),2) v FROM stock_items');
    const [po] = await pg('SELECT ROUND(COALESCE(SUM(opening_qty),0),4) q, ROUND(COALESCE(SUM(opening_val),0),2) v FROM rre.stock_items WHERE company_no = $1');
    row('Opening stock: quantity / value', `${Number(so.q)} / ${r2(so.v)}`, `${Number(po.q)} / ${r2(po.v)}`);
    // 5. people and duplicates
    sec.push('', '**Accounts and duplicates**', '', '| Check | This computer | Central database | Result |', '|---|---|---|---|');
    const roles = async (rows) => rows.map((r) => `${r.role} ${r.n}`).join(', ');
    row('Sign-in accounts by role', await roles(await sq('SELECT role, COUNT(*) n FROM users GROUP BY role ORDER BY role')), await roles(await pg('SELECT role, COUNT(*) n FROM rre.users WHERE company_no = $1 GROUP BY role ORDER BY role')));
    const [ph] = await sq('SELECT COUNT(*) n FROM users WHERE password IS NOT NULL'); const [pph] = await pg('SELECT COUNT(*) n FROM rre.users WHERE company_no = $1 AND password IS NOT NULL');
    row('Password hashes carried over (never shown)', ph.n, Number(pph.n), num);
    const dup = await pg('SELECT voucher_type, voucher_no, COUNT(*) n FROM rre.vouchers WHERE company_no = $1 GROUP BY 1, 2 HAVING COUNT(*) > 1');
    row('Duplicate voucher numbers in central database', 0, dup.length);
    const ub = await pg('SELECT v.id FROM rre.vouchers v JOIN rre.ledger_entries e ON e.company_no = v.company_no AND e.voucher_id = v.id WHERE v.company_no = $1 GROUP BY v.id HAVING ROUND(SUM(e.debit_amount) - SUM(e.credit_amount), 2) <> 0');
    row('Unbalanced vouchers in central database', 0, ub.length);
    db.close();

    problems += bad;
    out.push(`## Company ${co}: ${bad ? `**${bad} difference(s)**` : 'everything identical'}`, ...sec, '');
    console.log(`company ${co}: ${bad ? bad + ' difference(s)' : 'everything identical'}`);
  }
  await pgc.end();
  out.push(`---`, problems ? `**Result: ${problems} difference(s). Do not switch to the central database until they are explained.**` : '**Result: every table, record id, money total, ledger balance, GST ledger, stock quantity and account matches.**');
  const file = path.join(root, `migration-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  console.log('report:', file);
  process.exit(problems ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(2); });

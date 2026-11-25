/**
 * RRE Tally — accounting bridge for the ORIGINAL inventory application (StockPilot).
 *
 * The inventory application keeps its own database (data/<company>/inventory/stockpilot.db). This bridge READS that database (read-only)
 * and posts what happens there into RRE's books, exactly once each:
 *
 *   goods received (GRN)      -> Purchase voucher: stock in, supplier credited, input GST, bill opened
 *   shipment dispatched       -> Sales voucher:    stock out, customer debited, output GST, bill opened
 *   stock transfer            -> Stock Journal between the two warehouses (no ledger effect)
 *   stock adjustment          -> Stock Journal (damage, loss, count correction, found stock)
 *
 * Safety:
 *   - Every document has a natural key (its StockPilot number) written on the RRE voucher, and a row in inv_bridge_events, so it can
 *     never be posted twice, whatever happens (a crash, two runs at once, a retry).
 *   - Whatever existed when the bridge first ran is marked as history and NOT posted (the books already hold the opening stock that
 *     came across with the original data); only later documents flow in.
 *   - A document that cannot be posted (missing ledger, not enough stock, approval rule) is recorded as failed with the reason and
 *     retried later; it never blocks the others.
 *   - Items, warehouses, customers and suppliers are matched to what RRE already has (by name / GSTIN); only the missing ones are created.
 */
const fs = require('fs');
const path = require('path');
const { get, all, run, getDataDir } = require('./db');
const { withTransaction } = require('./tx');
const { logActivity } = require('./auth');
const inv = require('./invCore');
const ord = require('./invOrders');
const imp = require('./invImport');

const BRIDGE_USER = { username: 'stockpilot-bridge', role: 'Owner', userId: null };
const RETRY_AFTER_MIN = 10;
let running = false;
const last = { at: null, result: null, error: null };

const dbFile = () => path.join(getDataDir(), 'inventory', 'stockpilot.db');
const day = (v) => String(v || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function setting(key, def) { const r = await get('SELECT value FROM app_settings WHERE key = ?', [key]).catch(() => null); return r && r.value != null ? r.value : def; }

// ---------------------------------------------------------------------------------------------------- bookkeeping
async function eventOf(source, kind, id) { return get('SELECT * FROM inv_bridge_events WHERE source = ? AND kind = ? AND src_id = ?', [source, kind, id]); }
async function record(source, kind, id, status, f = {}) {
  await run(`INSERT INTO inv_bridge_events (source, kind, src_id, status, voucher_id, number, message, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(source, kind, src_id) DO UPDATE SET status = excluded.status, voucher_id = COALESCE(excluded.voucher_id, inv_bridge_events.voucher_id), number = COALESCE(excluded.number, inv_bridge_events.number), message = excluded.message, attempts = inv_bridge_events.attempts + ?, updated_at = CURRENT_TIMESTAMP
             WHERE inv_bridge_events.status NOT IN ('synced', 'history') OR excluded.status = 'synced'`,
    [source, kind, id, status, f.voucher_id || null, f.number || null, f.message || null, status === 'failed' ? 1 : 0, status === 'failed' ? 1 : 0]);
}

// ---------------------------------------------------------------------------------------------------- masters (matched, created only when missing)
async function ensureCategory(name) {
  const n = String(name || '').trim() || 'Imported Items';
  const g = await get('SELECT id FROM stock_groups WHERE name = ? COLLATE NOCASE', [n]);
  return g ? g.id : (await run('INSERT INTO stock_groups (name) VALUES (?)', [n])).lastID;
}
async function ensureUnit(u) {
  const unit = String(u || 'pcs').trim() || 'pcs', found = await imp.findUnit(unit);
  if (found) return found;
  const sym = unit.toUpperCase().slice(0, 12);
  return (await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [sym, unit.slice(0, 60), imp.DECIMAL_UNITS.has(sym) ? 3 : 0])).lastID;
}

async function ensureWarehouse(src, source, id) {
  const prior = await imp.mapped(source, 'warehouse', id); if (prior) return prior;
  const w = (await src.q('SELECT * FROM warehouses WHERE id = ?', [id]))[0]; if (!w) throw new Error(`Warehouse #${id} is not in the inventory database.`);
  const name = imp.clean(w.name, 60); if (!name) throw new Error(`Warehouse #${id} has no name.`);
  let g = await get('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE', [name]);
  if (!g) {
    const code = imp.clean(w.code, 12), taken = code && (await get('SELECT id FROM godowns WHERE code = ?', [code.toUpperCase()]));
    const gid = (await run('INSERT INTO godowns (name, location, is_active, code, address, city) VALUES (?, ?, 1, ?, ?, ?)', [name, imp.clean(w.city, 80), taken || !code || !/^[A-Za-z0-9\-]{2,12}$/.test(code) ? null : code.toUpperCase(), imp.clean(w.address, 200), imp.clean(w.city, 80)])).lastID;
    const row = await get('SELECT code FROM godowns WHERE id = ?', [gid]); if (!row.code) await run('UPDATE godowns SET code = ? WHERE id = ?', [`WH-${String(gid).padStart(2, '0')}`, gid]);
    g = { id: gid };
  }
  await imp.remember(source, 'warehouse', id, g.id);
  return g.id;
}

async function ensureProduct(src, source, id) {
  const prior = await imp.mapped(source, 'product', id); if (prior) return prior;
  const p = (await src.q('SELECT * FROM products WHERE id = ?', [id]))[0]; if (!p) throw new Error(`Product #${id} is not in the inventory database.`);
  const name = imp.clean(p.name, 120); if (!name || name.length < 2) throw new Error(`Product #${id} has no usable name.`);
  let item = await get('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE', [name]);
  if (!item) {
    const sku = imp.clean(p.sku, 40) ? String(p.sku).trim().toUpperCase().replace(/[^A-Z0-9._\-\/]/g, '-') : null;
    const skuOk = sku && /^[A-Z0-9][A-Z0-9._\-\/]{1,39}$/.test(sku) && !(await get('SELECT id FROM stock_items WHERE sku = ?', [sku]));
    const cat = (await src.q('SELECT name FROM categories WHERE id = ?', [p.category_id]).catch(() => []))[0];
    const hsn = imp.clean(p.hsn_code, 8);
    const created = await inv.createItem({ name, category_id: await ensureCategory(cat && cat.name), uom_id: await ensureUnit(p.unit), sku: skuOk ? sku : undefined, brand: imp.clean(p.brand, 60) || undefined, hsn_code: hsn && /^\d{4,8}$/.test(hsn) ? hsn : undefined,
      gst_rate: Math.min(100, Math.max(0, imp.num(p.tax_rate ?? p.gst_rate ?? 18))), reorder_level: Math.max(0, imp.num(p.reorder_point)), standard_price: Math.max(0, imp.num(p.selling_price)), standard_cost: Math.max(0, imp.num(p.avg_cost) || imp.num(p.purchase_price)), opening_qty: 0 }, BRIDGE_USER);
    item = { id: created.id };
  }
  await imp.remember(source, 'product', id, item.id);
  return item.id;
}

async function ensureParty(src, source, kind, id) {
  const prior = await imp.mapped(source, kind, id); if (prior) return prior;
  const c = (await src.q(`SELECT * FROM ${kind === 'customer' ? 'customers' : 'vendors'} WHERE id = ?`, [id]))[0]; if (!c) throw new Error(`${kind === 'customer' ? 'Customer' : 'Supplier'} #${id} is not in the inventory database.`);
  const name = imp.clean(c.company_name, 120) || imp.clean(c.name, 120); if (!name || name.length < 2) throw new Error(`${kind} #${id} has no usable name.`);
  const gstin = String(c.gstin || '').trim().toUpperCase(), gstinOk = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
  let ledger = await get('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE', [name]) || (gstinOk ? await get('SELECT id FROM ledgers WHERE gstin = ?', [gstin]) : null);
  if (!ledger) {
    const email = imp.clean(c.email, 100), phone = imp.clean(c.phone, 20);
    const body = { name, gstin: gstinOk ? gstin : '', state: imp.clean(c.bill_state, 60) || '', state_code: imp.stateCode(gstinOk ? gstin : null, c.bill_state) || '', address: imp.clean(c.bill_address, 250) || '', city: imp.clean(c.bill_city, 80) || '',
      phone: phone && /^[0-9+()\-\s]{6,20}$/.test(phone) ? phone : '', email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '', credit_period: Math.min(365, Math.max(0, Math.round(imp.num(c.payment_terms ?? 30)))) };
    for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
    ledger = { id: (await ord.saveParty(kind === 'customer' ? 'customer' : 'supplier', null, body, BRIDGE_USER)).id };
  }
  await imp.remember(source, kind, id, ledger.id);
  return ledger.id;
}

// ---------------------------------------------------------------------------------------------------- documents
const partyOf = async (id) => get('SELECT id, name, credit_period FROM ledgers WHERE id = ?', [id]);

async function postReceipt(src, source, g) {
  const key = `SP-${g.number}`;
  const had = await get("SELECT id FROM vouchers WHERE voucher_type = 'Purchase' AND voucher_no = ?", [key]);
  if (had) return { commit: async () => ({ voucher_id: had.id, number: key, adopted: true }) }; // posted before, only the record was missing
  const po = (await src.q('SELECT po.number, po.vendor_id, po.warehouse_id FROM purchase_orders po WHERE po.id = ?', [g.po_id]))[0]; if (!po) throw new Error('The purchase order of this receipt is missing.');
  const lines = await src.q('SELECT l.product_id, l.quantity, l.unit_cost, pol.tax_rate FROM goods_receipt_lines l JOIN purchase_order_lines pol ON pol.id = l.po_line_id WHERE l.receipt_id = ? ORDER BY l.id', [g.id]);
  if (!lines.length) throw new Error('The receipt has no lines.');
  const party = await partyOf(await ensureParty(src, source, 'vendor', po.vendor_id)), wh = await ensureWarehouse(src, source, g.warehouse_id || po.warehouse_id);
  const picked = [];
  for (const l of lines) picked.push({ item_id: await ensureProduct(src, source, l.product_id), qty: imp.num(l.quantity), rate: imp.num(l.unit_cost), discount_pct: 0, gst_rate: imp.num(l.tax_rate) });
  // masters are resolved above (they run their own transactions); only the posting itself runs inside the caller's transaction
  return { commit: async () => { const { voucher, totals } = await ord.post('purchase', { party_ledger_id: party.id, party: party.name, warehouse_id: wh, credit_period: party.credit_period, number: po.number }, picked, key, day(g.received_on), `${g.number} / ${po.number}`, BRIDGE_USER); return { voucher_id: voucher.id, number: key, total: totals.total }; } };
}

async function postShipment(src, source, s) {
  const key = `SP-${s.number}`;
  const had = await get("SELECT id FROM vouchers WHERE voucher_type = 'Sales' AND voucher_no = ?", [key]);
  if (had) return { commit: async () => ({ voucher_id: had.id, number: key, adopted: true }) };
  const so = (await src.q('SELECT number, customer_id FROM sales_orders WHERE id = ?', [s.so_id]))[0]; if (!so) throw new Error('The sales order of this shipment is missing.');
  const pkg = (await src.q('SELECT id, warehouse_id FROM packages WHERE id = ?', [s.package_id]))[0]; if (!pkg) throw new Error('The package of this shipment is missing.');
  const lines = await src.q('SELECT pl.product_id, pl.quantity, sol.rate, sol.discount_pct, sol.tax_rate FROM package_lines pl JOIN sales_order_lines sol ON sol.id = pl.so_line_id WHERE pl.package_id = ? ORDER BY pl.id', [pkg.id]);
  if (!lines.length) throw new Error('The shipment has no lines.');
  const party = await partyOf(await ensureParty(src, source, 'customer', so.customer_id)), wh = await ensureWarehouse(src, source, pkg.warehouse_id);
  const picked = [];
  for (const l of lines) picked.push({ item_id: await ensureProduct(src, source, l.product_id), qty: imp.num(l.quantity), rate: imp.num(l.rate), discount_pct: imp.num(l.discount_pct), gst_rate: imp.num(l.tax_rate) });
  return { commit: async () => { const { voucher, totals } = await ord.post('sales', { party_ledger_id: party.id, party: party.name, warehouse_id: wh, credit_period: party.credit_period, number: so.number }, picked, key, day(s.shipping_date || s.created_at), `${s.number} / ${so.number}`, BRIDGE_USER); return { voucher_id: voucher.id, number: key, total: totals.total }; } };
}

async function postTransfer(src, source, t) {
  const note = `StockPilot ${t.number}`;
  const done = await get('SELECT voucher_id, number FROM inv_docs WHERE note = ?', [note]); if (done) return { voucher_id: done.voucher_id, number: done.number }; // adopt: it was posted but not recorded
  const lines = await src.q('SELECT product_id, quantity FROM transfer_lines WHERE order_id = ?', [t.id]); if (!lines.length) throw new Error('The transfer has no lines.');
  const from = await ensureWarehouse(src, source, t.from_warehouse_id), to = await ensureWarehouse(src, source, t.to_warehouse_id), items = [];
  for (const l of lines) items.push({ item_id: await ensureProduct(src, source, l.product_id), qty: imp.num(l.quantity) });
  const doc = await inv.createTransfer({ from_warehouse_id: from, to_warehouse_id: to, date: day(t.created_at), note, lines: items }, BRIDGE_USER);
  return { voucher_id: (await get('SELECT voucher_id FROM inv_docs WHERE id = ?', [doc.id])).voucher_id, number: doc.number };
}

const ADJ_REASON = { increase: 'Found stock', decrease: 'Stock count correction', damage: 'Damaged goods', missing: 'Lost / stolen', correction: 'Stock count correction' };
async function postAdjustment(src, source, a) {
  const note = `StockPilot ${a.number}`;
  const done = await get('SELECT voucher_id, number FROM inv_docs WHERE note = ?', [note]); if (done) return { voucher_id: done.voucher_id, number: done.number };
  const lines = (await src.q('SELECT product_id, qty_delta FROM inventory_adjustment_lines WHERE adjustment_id = ?', [a.id])).filter((l) => imp.num(l.qty_delta) !== 0);
  if (!lines.length) return { voucher_id: null, number: null, nothing: true };
  const wh = await ensureWarehouse(src, source, a.warehouse_id), items = [];
  for (const l of lines) items.push({ item_id: await ensureProduct(src, source, l.product_id), delta: imp.num(l.qty_delta) });
  const doc = await inv.createAdjustment({ warehouse_id: wh, reason: ADJ_REASON[a.adj_type] || 'Other', date: day(a.adj_date), note: `${note}${a.reason ? ' — ' + String(a.reason).slice(0, 120) : ''}`, lines: items }, BRIDGE_USER);
  return { voucher_id: (await get('SELECT voucher_id FROM inv_docs WHERE id = ?', [doc.id])).voucher_id, number: doc.number };
}

const KINDS = [
  { kind: 'grn', label: 'purchases', sql: 'SELECT * FROM goods_receipts WHERE org_id = ? ORDER BY id', post: postReceipt },
  { kind: 'ship', label: 'sales', sql: "SELECT * FROM shipments WHERE org_id = ? AND status NOT IN ('ready_to_ship', 'cancelled') ORDER BY id", post: postShipment },
  { kind: 'transfer', label: 'transfers', sql: 'SELECT * FROM transfer_orders WHERE org_id = ? ORDER BY id', post: postTransfer },
  { kind: 'adjustment', label: 'adjustments', sql: 'SELECT * FROM inventory_adjustments WHERE org_id = ? ORDER BY id', post: postAdjustment }
];

// ---------------------------------------------------------------------------------------------------- the run
async function orgOf(src) {
  const set = parseInt(await setting('inv_bridge_org', ''), 10);
  if (set) return set;
  const o = (await src.q("SELECT org_id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1"))[0] || (await src.q('SELECT id AS org_id FROM organizations ORDER BY id LIMIT 1'))[0];
  return o ? o.org_id : null;
}

async function syncOnce({ force = false } = {}) {
  if (running) return { skipped: 'A synchronisation is already running.' };
  running = true; // taken before the first await, so two callers can never both get in
  let src;
  try {
    if ((await setting('inv_bridge_enabled', '1')) === '0') return { skipped: 'The accounting link is switched off.' };
    if (!fs.existsSync(dbFile())) return { skipped: 'The inventory application has not been opened yet.' };
    src = await imp.openSource(dbFile());
    const orgId = await orgOf(src); if (!orgId) return { skipped: 'The inventory database has no organisation yet.' };
    const source = await imp.sourceKey(src, orgId), out = { posted: { purchases: 0, sales: 0, transfers: 0, adjustments: 0 }, failed: [], history_marked: 0, retried: 0 };

    // first run: everything that already exists is history (its stock is already in RRE's opening balances)
    if (!(await eventOf(source, 'baseline', 0))) {
      await withTransaction(async () => {
        for (const k of KINDS) for (const d of await src.q(k.sql, [orgId])) { await record(source, k.kind, d.id, 'history', { number: d.number }); out.history_marked++; }
        await record(source, 'baseline', 0, 'synced', { message: 'Documents that existed when the accounting link was first started are not posted again.' });
      });
    }

    for (const k of KINDS) {
      for (const d of await src.q(k.sql, [orgId])) {
        const ev = await eventOf(source, k.kind, d.id);
        if (ev && (ev.status === 'history' || ev.status === 'synced')) continue;
        if (ev && ev.status === 'failed' && !force && (await get("SELECT 1 x FROM inv_bridge_events WHERE source = ? AND kind = ? AND src_id = ? AND updated_at > datetime('now', ?)", [source, k.kind, d.id, `-${RETRY_AFTER_MIN} minutes`]))) continue;
        if (ev && ev.status === 'failed') out.retried++;
        try {
          let res;
          if (k.kind === 'grn' || k.kind === 'ship') {
            // one transaction: the voucher and the record that it was posted stand or fall together
            const plan = await k.post(src, source, d);
            res = await withTransaction(async () => { const r = await plan.commit(); await record(source, k.kind, d.id, 'synced', { voucher_id: r.voucher_id, number: r.number }); return r; });
          } else {
            res = await k.post(src, source, d); await record(source, k.kind, d.id, 'synced', { voucher_id: res.voucher_id, number: res.number, message: res.nothing ? 'No quantity changed.' : null });
          }
          out.posted[k.label]++;
          await logActivity({ user: BRIDGE_USER, action: 'INV_BRIDGE_POST', entity: k.kind, entityId: d.id, details: { number: d.number, voucher: res.number } });
        } catch (e) {
          await record(source, k.kind, d.id, 'failed', { number: d.number, message: String(e.message || e).slice(0, 400) });
          out.failed.push({ kind: k.kind, number: d.number, reason: String(e.message || e).slice(0, 300) });
        }
      }
    }
    last.at = new Date().toISOString(); last.result = out; last.error = null;
    return out;
  } catch (e) { last.error = e.message; last.at = new Date().toISOString(); throw e; } finally { running = false; if (src) src.close(); }
}

async function status() {
  const orgInfo = { enabled: (await setting('inv_bridge_enabled', '1')) !== '0', database: fs.existsSync(dbFile()) };
  const rows = await all("SELECT kind, status, COUNT(*) n FROM inv_bridge_events WHERE kind <> 'baseline' GROUP BY kind, status");
  const failed = await all("SELECT kind, src_id, number, message, attempts, updated_at FROM inv_bridge_events WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20");
  const recent = await all("SELECT kind, number, voucher_id, updated_at FROM inv_bridge_events WHERE status = 'synced' AND kind <> 'baseline' ORDER BY updated_at DESC LIMIT 10");
  return { ...orgInfo, running, last_run: last.at, last_error: last.error, counts: rows, failed, recent };
}

let timer = null;
function startAuto(ms = 20000) {
  if (timer || process.env.RRE_BRIDGE_AUTO === '0') return;
  timer = setInterval(() => { syncOnce().catch((e) => console.warn('[Inventory bridge]', e.message)); }, ms);
  if (timer.unref) timer.unref();
}

module.exports = { syncOnce, status, startAuto, BRIDGE_USER };

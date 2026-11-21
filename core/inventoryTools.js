/**
 * RRE Tally — inventory intelligence (read-only analytics over existing stock data).
 *
 * Conventions (all stated to the user in each result):
 *  - "Today" for analysis is the latest voucher date in the books (the same working date the app shows),
 *    so imported/historic books are analysed as at their own date. Override with ?as_of=YYYY-MM-DD.
 *  - Quantity on hand = opening + inward − outward from inventory_entries (same basis as the Stock Summary).
 *  - Net sales quantity = Sales outward − Credit Note inward (sales returns).
 *  - Purchase cost basis = weighted average of opening stock and Purchase vouchers only (returns excluded).
 *  - Forecasts are statistical extrapolations of past sales, not guarantees; each carries its assumptions.
 */
const { all, get } = require('./db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function asOfDate(override) {
  if (override) {
    if (!ISO.test(override)) { const e = new Error('as_of must be YYYY-MM-DD.'); e.status = 400; throw e; }
    return override;
  }
  const r = await get('SELECT MAX(date) d FROM vouchers');
  return (r && r.d) || new Date().toISOString().slice(0, 10);
}

async function loadItems() {
  return all(`
    SELECT s.id, s.name, s.hsn_code, s.reorder_level, s.opening_qty, s.opening_rate, s.opening_val, u.symbol AS uom
    FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id WHERE s.is_active = 1 ORDER BY s.name`);
}

/** Per-item aggregates in one pass. */
async function aggregates(asOf) {
  const rows = await all(`
    SELECT i.stock_item_id AS id, v.voucher_type AS vt, i.direction AS dir, v.date AS date, i.quantity AS qty, i.amount AS amt
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
    WHERE v.date <= ?`, [asOf]);
  const m = new Map();
  const get_ = (id) => { if (!m.has(id)) m.set(id, { qty_in: 0, qty_out: 0, purchase_qty: 0, purchase_amt: 0, sales: [], last_sale: null, last_movement: null }); return m.get(id); };
  for (const r of rows) {
    const a = get_(r.id);
    if (r.dir === 'IN') a.qty_in += r.qty; else a.qty_out += r.qty;
    if (r.vt === 'Purchase') { a.purchase_qty += r.qty; a.purchase_amt += r.amt; }
    if (r.vt === 'Sales') { a.sales.push({ date: r.date, qty: r.qty }); if (!a.last_sale || r.date > a.last_sale) a.last_sale = r.date; }
    if (r.vt === 'Credit Note') a.sales.push({ date: r.date, qty: -r.qty }); // sales return reduces net demand
    if (!a.last_movement || r.date > a.last_movement) a.last_movement = r.date;
  }
  return m;
}

function costPerUnit(item, a) {
  const q = item.opening_qty + (a ? a.purchase_qty : 0);
  const v = item.opening_val + (a ? a.purchase_amt : 0);
  return q > 0 ? round2(v / q) : round2(item.opening_rate || 0);
}

function netQtyBetween(sales, fromExcl, toIncl) {
  return sales.filter((s) => s.date > fromExcl && s.date <= toIncl).reduce((t, s) => t + s.qty, 0);
}

/** Weighted demand: recent 30 days count double versus the 60 days before. */
function demandStats(a, asOf, lookback = 90) {
  const sales = a ? a.sales : [];
  const d30 = Math.max(0, netQtyBetween(sales, addDays(asOf, -30), asOf));
  const d60prior = Math.max(0, netQtyBetween(sales, addDays(asOf, -90), addDays(asOf, -30)));
  const windowQty = Math.max(0, netQtyBetween(sales, addDays(asOf, -lookback), asOf));
  const txns = sales.filter((s) => s.qty > 0 && s.date > addDays(asOf, -lookback) && s.date <= asOf).length;
  const recent = d30 / 30, prior = d60prior / 60;
  const weighted = txns === 0 ? 0 : (2 * recent + 1 * prior) / 3;
  return { window_qty: round2(windowQty), avg_daily_simple: round2(windowQty / lookback), avg_daily_weighted: round2(weighted),
    recent_30d_qty: round2(d30), prior_60d_qty: round2(d60prior), sale_transactions: txns,
    confidence: txns >= 6 ? 'medium' : txns >= 2 ? 'low' : txns === 1 ? 'very low' : 'none' };
}

async function currentQty(item, a) { return round2(item.opening_qty + (a ? a.qty_in - a.qty_out : 0)); }

async function demandForecast({ as_of, lookback_days = 90, horizon_days = 30 } = {}) {
  const asOf = await asOfDate(as_of);
  const lb = Math.min(365, Math.max(30, parseInt(lookback_days, 10) || 90));
  const hz = Math.min(180, Math.max(7, parseInt(horizon_days, 10) || 30));
  const items = await loadItems(); const agg = await aggregates(asOf);
  const out = [];
  for (const it of items) {
    const a = agg.get(it.id); const d = demandStats(a, asOf, lb); const qty = await currentQty(it, a);
    const monthly = [];
    for (let k = 5; k >= 0; k--) {
      const to = addDays(asOf, -30 * k), from = addDays(to, -30);
      monthly.push({ period_end: to, qty: round2(Math.max(0, netQtyBetween(a ? a.sales : [], from, to))) });
    }
    out.push({ item_id: it.id, name: it.name, uom: it.uom, current_qty: qty, ...d, forecast_qty: round1(d.avg_daily_weighted * hz),
      days_of_cover: d.avg_daily_weighted > 0 ? round1(qty / d.avg_daily_weighted) : null, last_6_periods_30d: monthly });
  }
  return { as_of: asOf, lookback_days: lb, horizon_days: hz, items: out,
    assumptions: [
      `Demand = net sales quantity (Sales − Credit Note returns). Average daily demand weights the last 30 days twice as much as the 60 days before.`,
      `Forecast for the next ${hz} days = weighted daily demand × ${hz}. It assumes recent buying patterns continue; seasonality, price changes and one-off bulk orders are not modelled.`,
      'Confidence is based on the number of sale transactions in the lookback window (none / very low / low / medium).'
    ] };
}

async function supplierPrices(itemId) {
  const rows = await all(`
    SELECT s.id AS item_id, s.name AS item, p.id AS supplier_id, p.name AS supplier, v.date, v.voucher_no, i.rate, i.quantity
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.stock_item_id
    LEFT JOIN ledgers p ON p.id = v.party_ledger_id
    WHERE v.voucher_type = 'Purchase' ${itemId ? 'AND s.id = ?' : ''} ORDER BY v.date, v.id`, itemId ? [itemId] : []);
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, { item_id: r.item_id, item: r.item, suppliers: new Map() });
    const it = byItem.get(r.item_id);
    const key = r.supplier_id || 0;
    if (!it.suppliers.has(key)) it.suppliers.set(key, { supplier_id: r.supplier_id, supplier: r.supplier || '(no supplier)', purchases: 0, qty: 0, spend: 0, min_rate: Infinity, max_rate: 0, last_rate: 0, last_date: null, first_rate: null });
    const s = it.suppliers.get(key);
    s.purchases++; s.qty += r.quantity; s.spend += r.rate * r.quantity; s.min_rate = Math.min(s.min_rate, r.rate); s.max_rate = Math.max(s.max_rate, r.rate);
    if (s.first_rate === null) s.first_rate = r.rate;
    s.last_rate = r.rate; s.last_date = r.date;
  }
  const items = [...byItem.values()].map((it) => {
    const suppliers = [...it.suppliers.values()].map((s) => ({
      supplier_id: s.supplier_id, supplier: s.supplier, purchases: s.purchases, total_qty: round2(s.qty), avg_rate: round2(s.spend / s.qty),
      last_rate: round2(s.last_rate), min_rate: round2(s.min_rate), max_rate: round2(s.max_rate), last_date: s.last_date,
      trend: s.purchases < 2 ? 'n/a' : s.last_rate > s.first_rate * 1.02 ? 'rising' : s.last_rate < s.first_rate * 0.98 ? 'falling' : 'stable'
    })).sort((a, b) => a.last_rate - b.last_rate);
    const best = suppliers[0], worst = suppliers[suppliers.length - 1];
    return { item_id: it.item_id, item: it.item, suppliers, best_supplier: best.supplier,
      saving_per_unit_vs_dearest: suppliers.length > 1 ? round2(worst.last_rate - best.last_rate) : 0,
      note: suppliers.length < 2 ? 'Only one supplier on record; no comparison possible.' : null };
  });
  return { items, assumptions: ['Ranked by each supplier\'s most recent Purchase rate (excl. GST). Quality, lead time, credit terms and minimum order quantities are not captured in the books and are not compared.'] };
}

async function reorderSuggestions({ as_of, lead_time_days = 14, safety_days = 7, cover_days = 30, lookback_days = 90 } = {}) {
  const asOf = await asOfDate(as_of);
  const lead = Math.min(180, Math.max(0, parseInt(lead_time_days, 10) || 14));
  const safetyIn = parseInt(safety_days, 10);
  const safety = Math.min(90, Math.max(0, Number.isNaN(safetyIn) ? 7 : safetyIn));
  const cover = Math.min(180, Math.max(1, parseInt(cover_days, 10) || 30));
  const lb = Math.min(365, Math.max(30, parseInt(lookback_days, 10) || 90));
  const items = await loadItems(); const agg = await aggregates(asOf);
  const sp = await supplierPrices(null);
  const spMap = new Map(sp.items.map((x) => [x.item_id, x]));
  const rows = [];
  for (const it of items) {
    const a = agg.get(it.id); const d = demandStats(a, asOf, lb); const qty = await currentQty(it, a);
    const dd = d.avg_daily_weighted;
    const demandPoint = dd * (lead + safety);
    const reorderPoint = Math.max(Number(it.reorder_level) || 0, Math.ceil(demandPoint));
    const target = dd * (lead + safety + cover);
    const level = Number(it.reorder_level) || 0;
    let suggested = 0;
    let status;
    if (qty <= 0) status = 'out_of_stock';
    else if (dd > 0 && qty <= demandPoint) status = 'reorder_now';
    else if ((Number(it.reorder_level) || 0) > 0 && qty <= it.reorder_level) status = 'below_reorder_level';
    else if (dd === 0) status = 'no_recent_demand';
    else status = 'ok';
    if (status === 'out_of_stock' || status === 'reorder_now' || status === 'below_reorder_level') {
      suggested = Math.max(0, Math.ceil(target - qty));
      // no usable demand history: fall back to restoring stock to twice the reorder level the user set
      if (suggested === 0 && level > 0) suggested = Math.max(0, Math.ceil(level * 2 - qty));
    }
    const best = spMap.get(it.id)?.suppliers[0] || null;
    rows.push({ item_id: it.id, name: it.name, uom: it.uom, current_qty: qty, reorder_level: Number(it.reorder_level) || 0,
      avg_daily_demand: dd, days_of_cover: dd > 0 ? round1(qty / dd) : null, reorder_point: reorderPoint, status, suggested_order_qty: suggested,
      estimated_cost: best ? round2(suggested * best.last_rate) : null,
      suggested_supplier: best ? { name: best.supplier, last_rate: best.last_rate, last_date: best.last_date } : null,
      demand_confidence: d.confidence });
  }
  const rank = { out_of_stock: 0, reorder_now: 1, below_reorder_level: 2, ok: 3, no_recent_demand: 4 };
  rows.sort((x, y) => rank[x.status] - rank[y.status] || (x.days_of_cover ?? 1e9) - (y.days_of_cover ?? 1e9));
  return { as_of: asOf, parameters: { lead_time_days: lead, safety_days: safety, cover_days: cover, lookback_days: lb }, items: rows,
    assumptions: [
      `Reorder when stock ≤ demand during (lead time ${lead} d + safety ${safety} d). Order enough to cover lead time + safety + ${cover} days of demand.`,
      'Demand is the weighted average of net sales (see Demand forecast). Items with no sales in the window are not auto-ordered; use the Reorder Level you set on the item.',
      'Supplier shown is the one with the lowest most-recent Purchase rate. Costs exclude GST. Lead time is the same for every item (adjust the parameter).',
      'These are suggestions only. Nothing is ordered or posted.'
    ] };
}

async function deadStock({ as_of, days = 90 } = {}) {
  const asOf = await asOfDate(as_of);
  const d = Math.min(730, Math.max(30, parseInt(days, 10) || 90));
  const items = await loadItems(); const agg = await aggregates(asOf);
  const out = [];
  for (const it of items) {
    const a = agg.get(it.id); const qty = await currentQty(it, a);
    if (qty <= 0) continue;
    const lastSale = a ? a.last_sale : null;
    const since = lastSale ? dayDiff(asOf, lastSale) : null;
    if (lastSale && since <= d) continue;
    const cost = costPerUnit(it, a);
    out.push({ item_id: it.id, name: it.name, uom: it.uom, current_qty: qty, cost_per_unit: cost, value_locked: round2(qty * cost),
      last_sale_date: lastSale, days_since_last_sale: since, category: lastSale ? 'slow-moving' : 'never sold',
      last_movement: a ? a.last_movement : null });
  }
  out.sort((x, y) => y.value_locked - x.value_locked);
  return { as_of: asOf, threshold_days: d, items: out, total_value_locked: round2(out.reduce((s, r) => s + r.value_locked, 0)),
    assumptions: [`Dead/slow = stock on hand with no Sales in the last ${d} days (or never sold). Credit-note returns are not counted as sales.`,
      'Value uses the weighted-average cost of opening stock and Purchase vouchers; it is an estimate, not the closing-stock valuation shown in reports.'] };
}

async function godownStock() {
  const items = await loadItems();
  const gs = await all('SELECT id, name FROM godowns WHERE is_active = 1 ORDER BY id');
  const rows = await all(`
    SELECT i.stock_item_id AS id, COALESCE(i.godown_id, 0) AS gid,
           SUM(CASE WHEN i.direction = 'IN' THEN i.quantity ELSE -i.quantity END) AS net
    FROM inventory_entries i GROUP BY i.stock_item_id, COALESCE(i.godown_id, 0)`);
  const map = new Map();
  rows.forEach((r) => { if (!map.has(r.id)) map.set(r.id, new Map()); map.get(r.id).set(r.gid, r.net); });
  const out = items.map((it) => {
    const m = map.get(it.id) || new Map();
    const godowns = gs.map((g) => ({ godown_id: g.id, name: g.name, qty: round2(m.get(g.id) || 0) }));
    const unassigned = round2(m.get(0) || 0);
    const total = round2(it.opening_qty + godowns.reduce((s, g) => s + g.qty, 0) + unassigned);
    const flags = [];
    godowns.filter((g) => g.qty < 0).forEach((g) => flags.push(`Negative movement balance in ${g.name} (${g.qty}): stock was issued from here more than was received.`));
    if (it.opening_qty > 0) flags.push(`Opening stock (${it.opening_qty}) is not assigned to any godown.`);
    return { item_id: it.id, name: it.name, uom: it.uom, opening_unallocated: it.opening_qty, godowns, no_godown: unassigned, total_qty: total, flags };
  });
  return { godowns: gs, items: out,
    assumptions: ['Per-godown quantity = inward − outward recorded against that godown. Opening stock has no godown in the master data, so it is shown separately as "opening (unallocated)".'] };
}

async function movementHistory(itemId, { from_date, to_date } = {}) {
  const item = await get(`SELECT s.id, s.name, s.opening_qty, s.opening_rate, s.opening_val, u.symbol AS uom FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id WHERE s.id = ?`, [itemId]);
  if (!item) { const e = new Error('Stock item not found.'); e.status = 404; throw e; }
  for (const d of [from_date, to_date]) if (d && !ISO.test(d)) { const e = new Error('Dates must be YYYY-MM-DD.'); e.status = 400; throw e; }
  const rows = await all(`
    SELECT v.id AS voucher_id, v.date, v.voucher_no, v.voucher_type, p.name AS party, g.name AS godown, i.direction, i.quantity, i.rate, i.amount
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id LEFT JOIN godowns g ON g.id = i.godown_id
    WHERE i.stock_item_id = ? ORDER BY v.date, v.id, i.id`, [itemId]);
  let run = item.opening_qty;
  const all_ = rows.map((r) => { run += r.direction === 'IN' ? r.quantity : -r.quantity; return { ...r, balance: round2(run) }; });
  let shown = all_;
  let broughtForward = item.opening_qty;
  if (from_date) { const before = all_.filter((r) => r.date < from_date); broughtForward = before.length ? before[before.length - 1].balance : item.opening_qty; shown = shown.filter((r) => r.date >= from_date); }
  if (to_date) shown = shown.filter((r) => r.date <= to_date);
  return { item: { id: item.id, name: item.name, uom: item.uom }, opening: { qty: item.opening_qty, rate: item.opening_rate, value: item.opening_val },
    brought_forward: round2(broughtForward), movements: shown, closing_qty: shown.length ? shown[shown.length - 1].balance : round2(broughtForward),
    totals: { inward: round2(shown.filter((r) => r.direction === 'IN').reduce((s, r) => s + r.quantity, 0)), outward: round2(shown.filter((r) => r.direction === 'OUT').reduce((s, r) => s + r.quantity, 0)) } };
}

module.exports = { demandForecast, supplierPrices, reorderSuggestions, deadStock, godownStock, movementHistory, asOfDate };

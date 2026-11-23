/**
 * RRE Tally — inventory suite, stage 3: reports.
 *
 * Each report has metadata (title, group, filters, whether it shows money) and a run() that returns a uniform table
 * { columns, rows, totals, notes } so the screen and the CSV export are generated from the same data. Everything is derived from
 * the same stock entries and vouchers the rest of RRE uses, so the figures agree with Stock Summary, the Day Book and the ledgers.
 * Reports that show cost, value or sales/purchase amounts need the "view financials" permission; quantity-only reports do not.
 */
const { get, all, getRolePermissions } = require('./db');
const { toCsv } = require('./exports');
const tools = require('./inventoryTools');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const money = (user) => !!getRolePermissions(user && user.role).canViewFinancials;
const date = (v, label) => { if (v === undefined || v === '' || v === null) return null; if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${label} must be YYYY-MM-DD.`); return v; };
const intIn = (v, d, lo, hi, label) => { if (v === undefined || v === '' || v === null) return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${label} must be a whole number from ${lo} to ${hi}.`); return n; };
const optId = (v, label) => { if (v === undefined || v === '' || v === null) return null; const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1) throw bad(`${label} is not valid.`); return n; };

async function defaultGodown() {
  const g = await get('SELECT id FROM godowns WHERE is_active = 1 ORDER BY id LIMIT 1') || await get('SELECT id FROM godowns ORDER BY id LIMIT 1');
  return g ? g.id : 1;
}

const ITEMS_SQL = `SELECT s.id, s.name, s.sku, s.is_active, s.opening_qty, s.opening_val, s.opening_rate, s.standard_cost, g.name AS category, g.id AS category_id, u.symbol AS uom
  FROM stock_items s JOIN stock_groups g ON g.id = s.stock_group_id JOIN units_of_measure u ON u.id = s.uom_id`;

/** Net quantity per item and warehouse, and weighted-average cost, as at a date (entries up to and including it). */
async function stateAsOf(asOf, { categoryId = null } = {}) {
  const dg = await defaultGodown();
  const items = await all(`${ITEMS_SQL} ${categoryId ? 'WHERE s.stock_group_id = ?' : ''} ORDER BY s.name`, categoryId ? [categoryId] : []);
  const rows = await all(`SELECT ie.stock_item_id AS id, COALESCE(ie.godown_id, ?) AS gid, ie.direction AS dir, SUM(ie.quantity) AS q, SUM(ie.amount) AS a
    FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id WHERE v.date <= ? GROUP BY ie.stock_item_id, COALESCE(ie.godown_id, ?), ie.direction`, [dg, asOf, dg]);
  const by = new Map(items.map((it) => [it.id, { item: it, per: new Map([[dg, it.opening_qty || 0]]), inQ: 0, inA: 0 }]));
  for (const r of rows) { const st = by.get(r.id); if (!st) continue; st.per.set(r.gid, (st.per.get(r.gid) || 0) + (r.dir === 'IN' ? r.q : -r.q)); if (r.dir === 'IN') { st.inQ += r.q; st.inA += r.a; } }
  for (const st of by.values()) { const q = (st.item.opening_qty || 0) + st.inQ, v = (st.item.opening_val || 0) + st.inA; st.rate = q > 0 ? v / q : (st.item.opening_rate || st.item.standard_cost || 0); st.qty = r3([...st.per.values()].reduce((t, x) => t + x, 0)); }
  return { by, dg };
}

const col = (key, label, type = 'text') => ({ key, label, type });

// ---------------------------------------------------------------------------------------------------- the reports
const REPORTS = {
  'stock-valuation': {
    title: 'Stock valuation', group: 'Stock', financial: true,
    description: 'Quantity, average cost and value of every item on a chosen date, for all warehouses or one.',
    filters: [{ key: 'as_of', label: 'As at', type: 'date' }, { key: 'category', label: 'Category', type: 'category' }, { key: 'warehouse', label: 'Warehouse', type: 'warehouse' }],
    async run(q) {
      const asOf = date(q.as_of, 'As at date') || today(), cat = optId(q.category, 'Category'), wh = optId(q.warehouse, 'Warehouse');
      const { by } = await stateAsOf(asOf, { categoryId: cat });
      const rows = [];
      for (const st of by.values()) {
        const qty = wh ? r3(st.per.get(wh) || 0) : st.qty;
        if (qty === 0) continue; // nothing on hand: not part of the valuation
        rows.push({ item: st.item.name, sku: st.item.sku, category: st.item.category, uom: st.item.uom, qty, rate: r2(st.rate), value: r2(Math.max(qty, 0) * st.rate) });
      }
      return { columns: [col('item', 'Item'), col('sku', 'SKU'), col('category', 'Category'), col('uom', 'Unit'), col('qty', 'Quantity', 'number'), col('rate', 'Average cost', 'money'), col('value', 'Value', 'money')], rows,
        totals: { item: 'Total', value: r2(rows.reduce((t, r) => t + r.value, 0)) },
        notes: [`As at ${asOf}. Weighted-average cost of opening stock and everything received up to that date. Negative quantities are valued at zero.`] };
    }
  },
  'stock-by-warehouse': {
    title: 'Stock by warehouse', group: 'Stock', financial: false,
    description: 'Quantity of each item in every warehouse on a chosen date.',
    filters: [{ key: 'as_of', label: 'As at', type: 'date' }, { key: 'category', label: 'Category', type: 'category' }],
    async run(q) {
      const asOf = date(q.as_of, 'As at date') || today(), cat = optId(q.category, 'Category');
      const { by } = await stateAsOf(asOf, { categoryId: cat });
      const whs = await all('SELECT id, name FROM godowns ORDER BY is_active DESC, id');
      const rows = [], tot = {};
      for (const st of by.values()) {
        if (st.qty === 0 && ![...st.per.values()].some((x) => x !== 0)) continue;
        const r = { item: st.item.name, sku: st.item.sku, uom: st.item.uom, total: st.qty };
        whs.forEach((w) => { r[`w${w.id}`] = r3(st.per.get(w.id) || 0); tot[`w${w.id}`] = r3((tot[`w${w.id}`] || 0) + r[`w${w.id}`]); });
        rows.push(r);
      }
      return { columns: [col('item', 'Item'), col('sku', 'SKU'), col('uom', 'Unit'), ...whs.map((w) => col(`w${w.id}`, w.name, 'number')), col('total', 'Total', 'number')], rows,
        totals: { item: 'Total', ...tot, total: r3(rows.reduce((t, r) => t + r.total, 0)) }, notes: [`As at ${asOf}.`] };
    }
  },
  'movement-summary': {
    title: 'Stock movement summary', group: 'Stock', financial: false,
    description: 'Opening, received, issued and closing quantity of each item over a period.',
    filters: [{ key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }, { key: 'category', label: 'Category', type: 'category' }, { key: 'warehouse', label: 'Warehouse', type: 'warehouse' }],
    async run(q, user) {
      const to = date(q.to, 'To date') || today(), from = date(q.from, 'From date') || `${to.slice(0, 7)}-01`;
      if (from > to) throw bad('The From date is after the To date.');
      const cat = optId(q.category, 'Category'), wh = optId(q.warehouse, 'Warehouse'), dg = await defaultGodown();
      const items = await all(`${ITEMS_SQL} ${cat ? 'WHERE s.stock_group_id = ?' : ''} ORDER BY s.name`, cat ? [cat] : []);
      const ent = await all(`SELECT ie.stock_item_id AS id, ie.direction AS dir, SUM(CASE WHEN v.date < ? THEN ie.quantity ELSE 0 END) AS qb, SUM(CASE WHEN v.date >= ? AND v.date <= ? THEN ie.quantity ELSE 0 END) AS qp,
          SUM(CASE WHEN v.date >= ? AND v.date <= ? THEN ie.amount ELSE 0 END) AS ap FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
          ${wh ? 'WHERE COALESCE(ie.godown_id, ?) = ?' : ''} GROUP BY ie.stock_item_id, ie.direction`, wh ? [from, from, to, from, to, dg, wh] : [from, from, to, from, to]);
      const m = new Map(items.map((it) => [it.id, { it, open: wh ? (wh === dg ? it.opening_qty || 0 : 0) : it.opening_qty || 0, inQ: 0, outQ: 0, inA: 0, outA: 0 }]));
      for (const e of ent) { const x = m.get(e.id); if (!x) continue; if (e.dir === 'IN') { x.open += e.qb; x.inQ += e.qp; x.inA += e.ap; } else { x.open -= e.qb; x.outQ += e.qp; x.outA += e.ap; } }
      const seeMoney = money(user), rows = [];
      for (const x of m.values()) { if (!x.open && !x.inQ && !x.outQ) continue; const r = { item: x.it.name, sku: x.it.sku, uom: x.it.uom, opening: r3(x.open), received: r3(x.inQ), issued: r3(x.outQ), closing: r3(x.open + x.inQ - x.outQ) }; if (seeMoney) { r.received_value = r2(x.inA); r.issued_value = r2(x.outA); } rows.push(r); }
      const cols = [col('item', 'Item'), col('sku', 'SKU'), col('uom', 'Unit'), col('opening', 'Opening', 'number'), col('received', 'Received', 'number'), col('issued', 'Issued', 'number'), col('closing', 'Closing', 'number')];
      if (seeMoney) cols.push(col('received_value', 'Received value', 'money'), col('issued_value', 'Issued value', 'money'));
      return { columns: cols, rows, totals: { item: 'Total', received: r3(rows.reduce((t, r) => t + r.received, 0)), issued: r3(rows.reduce((t, r) => t + r.issued, 0)), ...(seeMoney ? { received_value: r2(rows.reduce((t, r) => t + r.received_value, 0)), issued_value: r2(rows.reduce((t, r) => t + r.issued_value, 0)) } : {}) },
        notes: [`${from} to ${to}. "Received" and "issued" include purchases, sales, returns, transfers and adjustments (a transfer shows as issued in one warehouse and received in another when no warehouse is chosen).`] };
    }
  },
  reorder: {
    title: 'Reorder suggestions', group: 'Stock', financial: false,
    description: 'What to order, how much, and from whom, based on recent sales and the reorder level you set.',
    filters: [{ key: 'lead_time_days', label: 'Lead time (days)', type: 'number' }, { key: 'cover_days', label: 'Cover to order (days)', type: 'number' }],
    async run(q, user) {
      const lead = intIn(q.lead_time_days, 14, 0, 180, 'Lead time'), cover = intIn(q.cover_days, 30, 1, 180, 'Cover');
      const d = await tools.reorderSuggestions({ lead_time_days: lead, cover_days: cover });
      const see = money(user);
      const rows = d.items.filter((r) => ['out_of_stock', 'reorder_now', 'below_reorder_level'].includes(r.status)).map((r) => ({ item: r.name, uom: r.uom, qty: r.current_qty, reorder_level: r.reorder_level, daily: r.avg_daily_demand ? r3(r.avg_daily_demand) : 0, cover: r.days_of_cover, status: r.status.replace(/_/g, ' '), suggested: r.suggested_order_qty, supplier: see && r.suggested_supplier ? r.suggested_supplier.name : '', cost: see ? r.estimated_cost : null }));
      const cols = [col('item', 'Item'), col('uom', 'Unit'), col('qty', 'In stock', 'number'), col('reorder_level', 'Reorder level', 'number'), col('daily', 'Daily demand', 'number'), col('cover', 'Days of cover', 'number'), col('status', 'Status', 'badge'), col('suggested', 'Suggested order', 'number')];
      if (see) cols.push(col('supplier', 'Usual supplier'), col('cost', 'Estimated cost', 'money'));
      return { columns: cols, rows, totals: see ? { item: 'Total', cost: r2(rows.reduce((t, r) => t + (r.cost || 0), 0)) } : {}, notes: d.assumptions };
    }
  },
  'dead-stock': {
    title: 'Slow-moving and dead stock', group: 'Stock', financial: false,
    description: 'Stock on hand that has not sold for a long time.',
    filters: [{ key: 'days', label: 'No sale for (days)', type: 'number' }],
    async run(q, user) {
      const days = intIn(q.days, 90, 30, 730, 'Days'), d = await tools.deadStock({ days }), see = money(user);
      const rows = d.items.map((r) => ({ item: r.name, uom: r.uom, qty: r.current_qty, last_sale: r.last_sale_date || '', since: r.days_since_last_sale, kind: r.category, ...(see ? { value: r.value_locked } : {}) }));
      const cols = [col('item', 'Item'), col('uom', 'Unit'), col('qty', 'In stock', 'number'), col('last_sale', 'Last sale', 'date'), col('since', 'Days since', 'number'), col('kind', 'Type', 'badge')]; if (see) cols.push(col('value', 'Value locked up', 'money'));
      return { columns: cols, rows, totals: see ? { item: 'Total', value: d.total_value_locked } : {}, notes: d.assumptions };
    }
  },
  'sales-by-customer': partyReport('Sales by customer', 'Sales', ['Sales', 'Credit Note'], 'Customer', 'Net sales to each customer (sales less credit notes), including tax.'),
  'purchases-by-supplier': partyReport('Purchases by supplier', 'Purchases', ['Purchase', 'Debit Note'], 'Supplier', 'Net purchases from each supplier (purchases less debit notes), including tax.'),
  'sales-by-item': itemReport('Sales by item', 'Sales', ['Sales', 'Credit Note'], 'Net quantity and value sold per item (before tax), after credit notes.'),
  'purchases-by-item': itemReport('Purchases by item', 'Purchases', ['Purchase', 'Debit Note'], 'Net quantity and value bought per item (before tax), after debit notes.'),
  'open-orders': {
    title: 'Open orders', group: 'Orders', financial: false,
    description: 'Purchase and sales orders still waiting to be received or invoiced, with overdue ones marked.',
    filters: [{ key: 'kind', label: 'Orders', type: 'select', options: [['', 'Purchase and sales'], ['purchase', 'Purchase orders'], ['sales', 'Sales orders']] }],
    async run(q) {
      const kind = q.kind === 'purchase' || q.kind === 'sales' ? q.kind : null;
      const rows = await all(`SELECT o.number, o.kind, l.name AS party, o.order_date AS date, o.expected_date AS due, o.status, o.total,
          CASE WHEN o.expected_date IS NOT NULL AND o.expected_date < date('now') THEN CAST(julianday('now') - julianday(o.expected_date) AS INTEGER) ELSE 0 END AS days_late
        FROM inv_orders o JOIN ledgers l ON l.id = o.party_ledger_id WHERE o.status IN ('issued', 'partially_received', 'confirmed') ${kind ? 'AND o.kind = ?' : ''} ORDER BY days_late DESC, o.order_date`, kind ? [kind] : []);
      const out = rows.map((r) => ({ ...r, kind: r.kind === 'sales' ? 'Sales' : 'Purchase', status: r.status.replace('_', ' '), days_late: r.days_late || '' }));
      return { columns: [col('number', 'Number'), col('kind', 'Type', 'badge'), col('party', 'Customer / supplier'), col('date', 'Order date', 'date'), col('due', 'Due', 'date'), col('status', 'Status', 'badge'), col('days_late', 'Days late', 'number'), col('total', 'Total', 'money')], rows: out,
        totals: { number: 'Total', total: r2(out.reduce((t, r) => t + r.total, 0)) }, notes: ['Draft and finished orders are not listed.'] };
    }
  }
};

function partyReport(title, group, types, who, description) {
  return {
    title, group, financial: true, description,
    filters: [{ key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
    async run(q) {
      const from = date(q.from, 'From date'), to = date(q.to, 'To date'); if (from && to && from > to) throw bad('The From date is after the To date.');
      const w = [`v.voucher_type IN (?, ?)`], p = [...types]; if (from) { w.push('v.date >= ?'); p.push(from); } if (to) { w.push('v.date <= ?'); p.push(to); }
      const rows = await all(`SELECT COALESCE(l.name, '(no party)') AS party, SUM(CASE WHEN v.voucher_type = ? THEN 1 ELSE 0 END) AS vouchers,
          SUM(CASE WHEN v.voucher_type = ? THEN v.total_amount ELSE -v.total_amount END) AS net, SUM(CASE WHEN v.voucher_type = ? THEN 0 ELSE v.total_amount END) AS returns_amt, MAX(v.date) AS last_date
        FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id WHERE ${w.join(' AND ')} GROUP BY v.party_ledger_id ORDER BY net DESC`, [types[0], types[0], types[0], ...p]);
      const out = rows.map((r) => ({ party: r.party, vouchers: r.vouchers, returns: r2(r.returns_amt), net: r2(r.net), last: r.last_date }));
      return { columns: [col('party', who), col('vouchers', 'Vouchers', 'number'), col('returns', types[1] + 's', 'money'), col('net', 'Net amount', 'money'), col('last', 'Last voucher', 'date')], rows: out,
        totals: { party: 'Total', vouchers: out.reduce((t, r) => t + r.vouchers, 0), returns: r2(out.reduce((t, r) => t + r.returns, 0)), net: r2(out.reduce((t, r) => t + r.net, 0)) }, notes: [description] };
    }
  };
}

function itemReport(title, group, types, description) {
  return {
    title, group, financial: true, description,
    filters: [{ key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }, { key: 'category', label: 'Category', type: 'category' }],
    async run(q) {
      const from = date(q.from, 'From date'), to = date(q.to, 'To date'); if (from && to && from > to) throw bad('The From date is after the To date.');
      const cat = optId(q.category, 'Category');
      const w = ['v.voucher_type IN (?, ?)'], p = [...types]; if (from) { w.push('v.date >= ?'); p.push(from); } if (to) { w.push('v.date <= ?'); p.push(to); } if (cat) { w.push('s.stock_group_id = ?'); p.push(cat); }
      const rows = await all(`SELECT s.name AS item, s.sku, g.name AS category, u.symbol AS uom, SUM(CASE WHEN v.voucher_type = ? THEN ie.quantity ELSE -ie.quantity END) AS qty, SUM(CASE WHEN v.voucher_type = ? THEN ie.amount ELSE -ie.amount END) AS amount
        FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id JOIN stock_items s ON s.id = ie.stock_item_id JOIN stock_groups g ON g.id = s.stock_group_id JOIN units_of_measure u ON u.id = s.uom_id
        WHERE ${w.join(' AND ')} GROUP BY s.id ORDER BY amount DESC`, [types[0], types[0], ...p]);
      const out = rows.map((r) => ({ item: r.item, sku: r.sku, category: r.category, uom: r.uom, qty: r3(r.qty), amount: r2(r.amount), avg: r.qty ? r2(r.amount / r.qty) : 0 }));
      return { columns: [col('item', 'Item'), col('sku', 'SKU'), col('category', 'Category'), col('uom', 'Unit'), col('qty', 'Net quantity', 'number'), col('amount', 'Net value', 'money'), col('avg', 'Average rate', 'money')], rows: out,
        totals: { item: 'Total', amount: r2(out.reduce((t, r) => t + r.amount, 0)) }, notes: [description] };
    }
  };
}

// ---------------------------------------------------------------------------------------------------- public
function list(user) {
  const see = money(user);
  return Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, group: r.group, description: r.description, filters: r.filters, financial: r.financial, available: !r.financial || see }));
}

async function run(id, q, user) {
  const r = REPORTS[id];
  if (!r) throw bad('Unknown report.', 404);
  if (r.financial && !money(user)) throw bad(`Your role "${user && user.role}" may not view reports that show costs and values.`, 403);
  const out = await r.run(q || {}, user);
  return { id, title: r.title, filters: q || {}, generated: new Date().toISOString().slice(0, 16).replace('T', ' '), ...out };
}

async function csv(id, q, user) {
  const rep = await run(id, q, user);
  const fmt = (c, v) => (v === null || v === undefined ? '' : c.type === 'money' || c.type === 'number' ? v : v);
  const lines = rep.rows.map((r) => rep.columns.map((c) => fmt(c, r[c.key])));
  if (rep.totals && Object.keys(rep.totals).length) lines.push(rep.columns.map((c) => fmt(c, rep.totals[c.key])));
  const stamp = today();
  return { filename: `${id}_${stamp}.csv`, body: toCsv(rep.columns.map((c) => c.label), lines) };
}

module.exports = { list, run, csv, REPORTS };

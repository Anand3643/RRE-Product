/**
 * RRE Tally — inventory suite, stage 2: customers, suppliers, purchase orders, sales orders and their history.
 *
 *   customer / supplier   -> ledgers under Sundry Debtors / Sundry Creditors (+ party_profiles for contact details)
 *   purchase order        -> inv_orders (kind purchase). Receiving goods posts a real PURCHASE voucher (stock in + payable + input GST).
 *   sales order           -> inv_orders (kind sales). Confirming RESERVES stock; invoicing posts a real SALES voucher (stock out +
 *                            receivable + output GST) and releases the reservation.
 *
 * Every posting goes through the same voucher service the voucher screens use, inside one serialised transaction, so stock and
 * accounts are updated together or not at all. An order line can only be received/invoiced once (quantities are tracked), and every
 * posting still obeys the approval rules. Totals are always computed here from the lines; nothing the browser sends is trusted.
 */
const { run, get, all, getRolePermissions } = require('./db');
const { withTransaction } = require('./tx');
const { logActivity } = require('./auth');
const { postVoucher, VoucherValidationError } = require('./voucherService');
const approvals = require('./approvals');
const { stockState } = require('./invCore');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const MAX_PAGE = 100;
const GROUP = { customer: 'Sundry Debtors', supplier: 'Sundry Creditors' };
const canSeeMoney = (user) => !!getRolePermissions(user && user.role).canViewFinancials;

function page(q, total) {
  const size = Math.min(MAX_PAGE, Math.max(1, parseInt(q.page_size, 10) || 25));
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, parseInt(q.page, 10) || 1));
  return { page: p, page_size: size, pages, total, offset: (p - 1) * size };
}
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const checkDate = (d, label = 'Date') => { const x = d || today(); if (!ISO.test(x) || Number.isNaN(Date.parse(x))) throw bad(`${label} must be YYYY-MM-DD.`); return x; };

// ---------------------------------------------------------------------------------------------------- customers and suppliers
async function groupIdOf(kind) {
  const g = await get('SELECT id FROM account_groups WHERE name = ?', [GROUP[kind]]);
  if (!g) throw bad(`The account group "${GROUP[kind]}" does not exist.`, 409);
  return g.id;
}

const PARTY_SQL = `SELECT l.id, l.name, l.gstin, l.pan, l.address, l.state, l.state_code, l.credit_period, l.credit_limit, l.is_active, l.opening_balance, l.opening_balance_type,
  p.email, p.phone, p.contact_name, p.city, p.payment_terms, p.notes,
  (SELECT COUNT(*) FROM inv_orders o WHERE o.party_ledger_id = l.id) AS orders,
  (SELECT COUNT(*) FROM inv_orders o WHERE o.party_ledger_id = l.id AND o.status IN ('draft', 'issued', 'partially_received', 'confirmed')) AS open_orders,
  COALESCE(t.d, 0) AS dr, COALESCE(t.c, 0) AS cr
  FROM ledgers l LEFT JOIN party_profiles p ON p.ledger_id = l.id LEFT JOIN (SELECT ledger_id, SUM(debit_amount) d, SUM(credit_amount) c FROM ledger_entries GROUP BY ledger_id) t ON t.ledger_id = l.id`;

function partyRow(r, kind, user) {
  const o = { id: r.id, name: r.name, gstin: r.gstin, pan: r.pan, address: r.address, state: r.state, state_code: r.state_code, credit_period: r.credit_period,
    email: r.email, phone: r.phone, contact_name: r.contact_name, city: r.city, payment_terms: r.payment_terms, notes: r.notes, is_active: r.is_active ? 1 : 0, orders: r.orders, open_orders: r.open_orders };
  if (kind === 'customer') o.credit_limit = r.credit_limit || 0;
  if (canSeeMoney(user)) {
    const dr = (r.opening_balance_type === 'Dr' ? r.opening_balance : 0) + r.dr, cr = (r.opening_balance_type === 'Cr' ? r.opening_balance : 0) + r.cr;
    const net = kind === 'customer' ? dr - cr : cr - dr; // what the customer owes us / what we owe the supplier
    o.balance = r2(Math.abs(net)); o.balance_side = net >= 0 ? (kind === 'customer' ? 'receivable' : 'payable') : (kind === 'customer' ? 'advance' : 'advance');
  }
  return o;
}

async function listParties(kind, q, user) {
  const gid = await groupIdOf(kind);
  const where = ['l.group_id = ?'], p = [gid];
  if (q.archived === '1') where.push('l.is_active = 0'); else where.push('l.is_active = 1');
  if (q.q) { where.push("(l.name LIKE ? ESCAPE '\\' OR l.gstin LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR p.city LIKE ? ESCAPE '\\')"); const n = like(q.q); p.push(n, n, n, n, n); }
  const total = (await get(`SELECT COUNT(*) c FROM ledgers l LEFT JOIN party_profiles p ON p.ledger_id = l.id WHERE ${where.join(' AND ')}`, p)).c;
  const pg = page(q, total);
  const rows = await all(`${PARTY_SQL} WHERE ${where.join(' AND ')} ORDER BY l.name LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  return { items: rows.map((r) => partyRow(r, kind, user)), page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
}

function cleanParty(b, kind, partial = false) {
  const o = {};
  const text = (k, max) => { if (b[k] === undefined) return; const v = String(b[k] || '').trim().slice(0, max); o[k] = v || null; };
  if (!partial || b.name !== undefined) { const n = String(b.name || '').trim(); if (n.length < 2 || n.length > 120) throw bad('Name must be 2–120 characters.'); o.name = n; }
  if (b.gstin !== undefined) { const g = String(b.gstin || '').trim().toUpperCase(); if (g && !GSTIN.test(g)) throw bad('GSTIN format is invalid (15 characters).'); o.gstin = g || null; }
  if (b.pan !== undefined) { const v = String(b.pan || '').trim().toUpperCase(); if (v && !/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) throw bad('PAN format is invalid.'); o.pan = v || null; }
  if (b.state_code !== undefined) { const v = String(b.state_code || '').trim(); if (v && !/^\d{2}$/.test(v)) throw bad('State code must be two digits.'); o.state_code = v || null; }
  text('state', 60); text('address', 250); text('city', 80); text('contact_name', 80); text('payment_terms', 120); text('notes', 500);
  if (b.email !== undefined) { const v = String(b.email || '').trim(); if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad('Enter a valid e-mail address.'); o.email = v || null; }
  if (b.phone !== undefined) { const v = String(b.phone || '').trim(); if (v && !/^[0-9+()\-\s]{6,20}$/.test(v)) throw bad('Enter a valid phone number.'); o.phone = v || null; }
  if (b.credit_period !== undefined && b.credit_period !== '') { const v = Number(b.credit_period); if (!Number.isInteger(v) || v < 0 || v > 365) throw bad('Credit period must be 0 to 365 days.'); o.credit_period = v; }
  if (kind === 'customer' && b.credit_limit !== undefined && b.credit_limit !== '') { const v = Number(b.credit_limit); if (!Number.isFinite(v) || v < 0 || v > 1e11) throw bad('Credit limit must be zero or more.'); o.credit_limit = v; }
  return o;
}

async function saveParty(kind, id, b, user) {
  const c = cleanParty(b, kind, !!id);
  return withTransaction(async () => {
    const gid = await groupIdOf(kind);
    if (c.name && (await get('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE AND id != ?', [c.name, id || 0]))) throw bad(`A ledger named "${c.name}" already exists.`, 409);
    let rid = id;
    const ledgerCols = ['name', 'gstin', 'pan', 'address', 'state', 'state_code', 'credit_period', 'credit_limit'].filter((k) => c[k] !== undefined);
    if (id) {
      const cur = await get('SELECT id, group_id FROM ledgers WHERE id = ?', [id]);
      if (!cur || cur.group_id !== gid) throw bad(`${kind === 'customer' ? 'Customer' : 'Supplier'} not found.`, 404);
      if (ledgerCols.length) await run(`UPDATE ledgers SET ${ledgerCols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...ledgerCols.map((k) => c[k]), id]);
    } else {
      const co = await get('SELECT state, state_code FROM company_info LIMIT 1') || {};
      rid = (await run(`INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, pan, address, state, state_code, credit_period, credit_limit) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.name, gid, kind === 'customer' ? 'Dr' : 'Cr', c.gstin || null, c.pan || null, c.address || null, c.state || co.state || null, c.state_code || co.state_code || null, c.credit_period ?? 30, c.credit_limit || 0])).lastID;
    }
    const prof = ['email', 'phone', 'contact_name', 'city', 'payment_terms', 'notes'].filter((k) => c[k] !== undefined);
    if (!id || prof.length) {
      await run('INSERT OR IGNORE INTO party_profiles (ledger_id) VALUES (?)', [rid]);
      if (prof.length) await run(`UPDATE party_profiles SET ${prof.map((k) => `${k} = ?`).join(', ')} WHERE ledger_id = ?`, [...prof.map((k) => c[k]), rid]);
    }
    await logActivity({ user, action: id ? `INV_${kind.toUpperCase()}_UPDATE` : `INV_${kind.toUpperCase()}_CREATE`, entity: 'ledger', entityId: rid, details: { name: c.name } });
    return rid;
  }).then((rid) => partyDetail(kind, rid, user));
}

async function partyDetail(kind, id, user) {
  const gid = await groupIdOf(kind);
  const r = await get(`${PARTY_SQL} WHERE l.id = ? AND l.group_id = ?`, [id, gid]);
  if (!r) throw bad(`${kind === 'customer' ? 'Customer' : 'Supplier'} not found.`, 404);
  const out = partyRow(r, kind, user);
  out.orders_list = (await all('SELECT id, kind, number, status, order_date, total FROM inv_orders WHERE party_ledger_id = ? ORDER BY id DESC LIMIT 10', [id]));
  const types = kind === 'customer' ? ['Sales', 'Receipt', 'Credit Note'] : ['Purchase', 'Payment', 'Debit Note'];
  out.vouchers = await all(`SELECT id, voucher_type AS type, voucher_no AS number, date, total_amount AS total FROM vouchers WHERE party_ledger_id = ? AND voucher_type IN (${types.map(() => '?').join(',')}) ORDER BY date DESC, id DESC LIMIT 10`, [id, ...types]);
  return out;
}

async function setPartyActive(kind, id, active, user) {
  return withTransaction(async () => {
    const gid = await groupIdOf(kind);
    const l = await get('SELECT id, name FROM ledgers WHERE id = ? AND group_id = ?', [id, gid]);
    if (!l) throw bad('Not found.', 404);
    if (!active && (await get(`SELECT COUNT(*) c FROM inv_orders WHERE party_ledger_id = ? AND status IN ('draft', 'issued', 'partially_received', 'confirmed')`, [id])).c) throw bad(`${l.name} has open orders. Finish or cancel them first.`, 409);
    await run('UPDATE ledgers SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
    await logActivity({ user, action: active ? 'INV_PARTY_RESTORE' : 'INV_PARTY_ARCHIVE', entity: 'ledger', entityId: id, details: { name: l.name } });
  }).then(() => partyDetail(kind, id, user));
}

// ---------------------------------------------------------------------------------------------------- order maths
/** Tax is split into CGST+SGST for a supplier/customer in the company's own state, otherwise IGST. Totals round to a whole rupee. */
function compute(lines, intra) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  const out = lines.map((l) => {
    const amount = r2(l.qty * l.rate * (1 - (l.discount_pct || 0) / 100)), tax = r2(amount * (l.gst_rate || 0) / 100);
    taxable += amount;
    if (intra) { const h = r2(tax / 2); cgst += h; sgst += r2(tax - h); } else igst += tax;
    return { ...l, amount, tax };
  });
  taxable = r2(taxable); cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst);
  const gross = r2(taxable + cgst + sgst + igst), total = Math.round(gross);
  return { lines: out, taxable, cgst, sgst, igst, tax: r2(cgst + sgst + igst), total, round_off: r2(total - gross) };
}

async function isIntra(partyId) {
  const co = await get('SELECT state_code FROM company_info LIMIT 1') || {};
  const p = await get('SELECT state_code FROM ledgers WHERE id = ?', [partyId]);
  return !p || !p.state_code || !co.state_code || p.state_code === co.state_code;
}

async function cleanOrder(kind, b) {
  const partyId = parseInt(b.party_id, 10);
  if (!partyId) throw bad(`Choose a ${kind === 'sales' ? 'customer' : 'supplier'}.`);
  const party = await get('SELECT l.id, l.name, l.is_active, l.group_id, l.credit_period, l.state_code FROM ledgers l WHERE l.id = ?', [partyId]);
  if (!party || party.group_id !== (await groupIdOf(kind === 'sales' ? 'customer' : 'supplier'))) throw bad(`Choose a valid ${kind === 'sales' ? 'customer' : 'supplier'}.`);
  if (!party.is_active) throw bad(`${party.name} is archived.`, 422);
  const wh = await get('SELECT id, name, is_active FROM godowns WHERE id = ?', [parseInt(b.warehouse_id, 10) || 0]);
  if (!wh) throw bad('Choose a warehouse.'); if (!wh.is_active) throw bad(`${wh.name} is archived.`, 422);
  const order_date = checkDate(b.order_date, 'Order date'), expected = b.expected_date ? checkDate(b.expected_date, 'Expected date') : null;
  if (expected && expected < order_date) throw bad('The expected date cannot be before the order date.');
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one line.');
  if (b.lines.length > 100) throw bad('An order can have at most 100 lines.');
  const seen = new Set(), lines = [];
  for (const [i, l] of b.lines.entries()) {
    const item = await get('SELECT id, name, is_active, gst_rate, standard_cost, standard_price FROM stock_items WHERE id = ?', [parseInt(l.item_id, 10) || 0]);
    if (!item) throw bad(`Line ${i + 1}: choose an item.`);
    if (!item.is_active) throw bad(`Line ${i + 1}: ${item.name} is archived.`, 422);
    if (seen.has(item.id)) throw bad(`Line ${i + 1}: ${item.name} appears twice. Combine the quantities.`); seen.add(item.id);
    const qty = Number(l.qty); if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw bad(`Line ${i + 1}: quantity must be more than zero.`);
    const rate = l.rate === undefined || l.rate === '' || l.rate === null ? (kind === 'sales' ? item.standard_price : item.standard_cost) : Number(l.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1e9) throw bad(`Line ${i + 1}: rate must be zero or more.`);
    const disc = l.discount_pct === undefined || l.discount_pct === '' ? 0 : Number(l.discount_pct);
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) throw bad(`Line ${i + 1}: discount must be 0 to 100%.`);
    const gst = l.gst_rate === undefined || l.gst_rate === '' ? item.gst_rate : Number(l.gst_rate);
    if (!Number.isFinite(gst) || gst < 0 || gst > 100) throw bad(`Line ${i + 1}: GST rate must be 0 to 100%.`);
    lines.push({ item_id: item.id, name: item.name, qty: r3(qty), rate: r2(rate), discount_pct: r2(disc), gst_rate: gst });
  }
  return { party, wh, order_date, expected, lines, reference: String(b.reference || '').trim().slice(0, 60) || null, notes: String(b.notes || '').trim().slice(0, 500) || null };
}

async function nextNumber(table, col, prefix) {
  const r = await get(`SELECT ${col} AS n FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`, [`${prefix}-%`]);
  return `${prefix}-${String(r ? parseInt(r.n.split('-').pop(), 10) + 1 : 1).padStart(5, '0')}`;
}

async function writeLines(orderId, lines) {
  for (const l of lines) await run('INSERT INTO inv_order_lines (order_id, item_id, qty, rate, discount_pct, gst_rate) VALUES (?, ?, ?, ?, ?, ?)', [orderId, l.item_id, l.qty, l.rate, l.discount_pct, l.gst_rate]);
}

async function createOrder(kind, b, user, extra = {}) {
  const c = await cleanOrder(kind, b);
  const t = compute(c.lines, await isIntra(c.party.id));
  return withTransaction(async () => {
    const number = await nextNumber('inv_orders', 'number', kind === 'sales' ? 'SO' : 'PO');
    const r = await run(`INSERT INTO inv_orders (kind, number, party_ledger_id, status, order_date, expected_date, warehouse_id, reference, notes, subtotal, tax, total, created_by, portal_user_id) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, number, c.party.id, c.order_date, c.expected, c.wh.id, c.reference, c.notes, t.taxable, t.tax, t.total, user.username, extra.portalUserId || null]);
    await writeLines(r.lastID, c.lines);
    await logActivity({ user, action: 'INV_ORDER_CREATE', entity: 'inv_order', entityId: r.lastID, details: { number, party: c.party.name, total: t.total } });
    return r.lastID;
  }).then((id) => getOrder(id, user));
}

async function loadOrder(id) {
  const o = await get(`SELECT o.*, l.name AS party, l.state_code AS party_state_code, l.credit_period, w.name AS warehouse FROM inv_orders o JOIN ledgers l ON l.id = o.party_ledger_id JOIN godowns w ON w.id = o.warehouse_id WHERE o.id = ?`, [id]);
  if (!o) throw bad('Order not found.', 404);
  o.lines = await all(`SELECT ol.id, ol.item_id, s.name AS item, s.sku, u.symbol AS uom, ol.qty, ol.rate, ol.discount_pct, ol.gst_rate, ol.qty_done
                       FROM inv_order_lines ol JOIN stock_items s ON s.id = ol.item_id JOIN units_of_measure u ON u.id = s.uom_id WHERE ol.order_id = ? ORDER BY ol.id`, [id]);
  return o;
}

async function getOrder(id, user) {
  const o = await loadOrder(id);
  const t = compute(o.lines.map((l) => ({ ...l, qty: l.qty })), await isIntra(o.party_ledger_id));
  o.lines = o.lines.map((l, i) => ({ ...l, amount: t.lines[i].amount, remaining: r3(l.qty - l.qty_done) }));
  o.totals = { taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, tax: t.tax, round_off: t.round_off, total: t.total };
  o.docs = await all(`SELECT d.id, d.kind, d.number, d.doc_date, d.reference, d.created_by, v.id AS voucher_id, v.voucher_no, v.total_amount FROM inv_order_docs d JOIN vouchers v ON v.id = d.voucher_id WHERE d.order_id = ? ORDER BY d.id`, [id]);
  o.reserved = o.kind === 'sales' && o.status === 'confirmed';
  return o;
}

async function listOrders(kind, q, user) {
  const where = ['o.kind = ?'], p = [kind];
  const open = { purchase: ['issued', 'partially_received'], sales: ['confirmed'] }[kind];
  if (q.status === 'open') where.push(`o.status IN (${open.map(() => '?').join(',')})`), p.push(...open);
  else if (q.status) { where.push('o.status = ?'); p.push(String(q.status)); }
  if (q.party) { where.push('o.party_ledger_id = ?'); p.push(parseInt(q.party, 10)); }
  if (q.from && ISO.test(q.from)) { where.push('o.order_date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('o.order_date <= ?'); p.push(q.to); }
  if (q.q) { where.push("(o.number LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\' OR o.reference LIKE ? ESCAPE '\\')"); const n = like(q.q); p.push(n, n, n); }
  const base = `FROM inv_orders o JOIN ledgers l ON l.id = o.party_ledger_id JOIN godowns w ON w.id = o.warehouse_id WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c, pg = page(q, total);
  const rows = await all(`SELECT o.id, o.number, o.status, o.order_date, o.expected_date, o.total, o.reference, l.name AS party, w.name AS warehouse, CASE WHEN o.portal_user_id IS NOT NULL THEN 1 ELSE 0 END AS portal,
    (SELECT COUNT(*) FROM inv_order_lines WHERE order_id = o.id) AS lines,
    CASE WHEN o.expected_date IS NOT NULL AND o.expected_date < date('now') AND o.status IN (${[...open, 'draft'].map(() => '?').join(',')}) THEN 1 ELSE 0 END AS overdue
    ${base} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...open, 'draft', ...p, pg.page_size, pg.offset]);
  return { items: rows, page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
}

async function updateOrder(id, b, user) {
  const cur = await loadOrder(id);
  if (cur.status !== 'draft') throw bad('Only a draft order can be edited.', 409);
  const c = await cleanOrder(cur.kind, b), t = compute(c.lines, await isIntra(c.party.id));
  return withTransaction(async () => {
    const fresh = await get('SELECT status FROM inv_orders WHERE id = ?', [id]);
    if (fresh.status !== 'draft') throw bad('Only a draft order can be edited.', 409);
    await run('UPDATE inv_orders SET party_ledger_id = ?, order_date = ?, expected_date = ?, warehouse_id = ?, reference = ?, notes = ?, subtotal = ?, tax = ?, total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [c.party.id, c.order_date, c.expected, c.wh.id, c.reference, c.notes, t.taxable, t.tax, t.total, id]);
    await run('DELETE FROM inv_order_lines WHERE order_id = ?', [id]);
    await writeLines(id, c.lines);
    await logActivity({ user, action: 'INV_ORDER_UPDATE', entity: 'inv_order', entityId: id, details: { number: cur.number, total: t.total } });
  }).then(() => getOrder(id, user));
}

async function deleteOrder(id, user) {
  return withTransaction(async () => {
    const o = await get('SELECT id, number, status FROM inv_orders WHERE id = ?', [id]);
    if (!o) throw bad('Order not found.', 404);
    if (o.status !== 'draft') throw bad('Only a draft order can be deleted. Cancel it instead.', 409);
    await run('DELETE FROM inv_orders WHERE id = ?', [id]);
    await logActivity({ user, action: 'INV_ORDER_DELETE', entity: 'inv_order', entityId: id, details: { number: o.number } });
  }).then(() => ({ deleted: true }));
}

/** Purchase: draft -> issued. Sales: draft -> confirmed, which reserves the stock (no overselling). */
async function confirmOrder(id, user) {
  return withTransaction(async () => {
    const o = await loadOrder(id);
    if (o.status !== 'draft') throw bad(`This order is already ${o.status.replace('_', ' ')}.`, 409);
    const wh = await get('SELECT name, is_active FROM godowns WHERE id = ?', [o.warehouse_id]);
    if (!wh.is_active) throw bad(`${wh.name} is archived.`, 422);
    const warnings = [];
    if (o.kind === 'sales') {
      for (const l of o.lines) {
        const { by } = await stockState({ itemId: l.item_id });
        const st = by.get(l.item_id);
        if (!st.item.is_active) throw bad(`${st.item.name} is archived.`, 422);
        const avail = r3((st.perGodown.get(o.warehouse_id) || 0) - (st.reserved.get(o.warehouse_id) || 0));
        if (l.qty > avail) throw bad(`Not enough ${st.item.name} in ${wh.name}: ${avail} available, ${l.qty} ordered.`, 409);
        await run('INSERT INTO inv_reservations (item_id, godown_id, qty, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)', [l.item_id, o.warehouse_id, l.qty, 'order', id]);
      }
      const cust = await get('SELECT credit_limit FROM ledgers WHERE id = ?', [o.party_ledger_id]);
      if (cust && cust.credit_limit > 0) {
        const bal = await get('SELECT COALESCE(SUM(debit_amount - credit_amount), 0) b FROM ledger_entries WHERE ledger_id = ?', [o.party_ledger_id]);
        if (bal.b + o.total > cust.credit_limit) warnings.push(`This order would take ${o.party} over its credit limit of ₹${cust.credit_limit}.`);
      }
    }
    await run('UPDATE inv_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [o.kind === 'sales' ? 'confirmed' : 'issued', id]);
    await logActivity({ user, action: o.kind === 'sales' ? 'INV_ORDER_CONFIRM' : 'INV_ORDER_ISSUE', entity: 'inv_order', entityId: id, details: { number: o.number } });
    return warnings;
  }).then(async (warnings) => ({ ...(await getOrder(id, user)), warnings }));
}

async function cancelOrder(id, reason, user) {
  return withTransaction(async () => {
    const o = await loadOrder(id);
    if (o.status === 'cancelled') throw bad('This order is already cancelled.', 409);
    if (['received', 'invoiced'].includes(o.status) || o.lines.some((l) => l.qty_done > 0)) throw bad('Goods have already been received or invoiced on this order, so it cannot be cancelled.', 409);
    await run("DELETE FROM inv_reservations WHERE ref_type = 'order' AND ref_id = ?", [id]);
    await run("UPDATE inv_orders SET status = 'cancelled', cancelled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [String(reason || '').trim().slice(0, 200) || null, id]);
    await logActivity({ user, action: 'INV_ORDER_CANCEL', entity: 'inv_order', entityId: id, details: { number: o.number, reason: reason || null } });
  }).then(() => getOrder(id, user));
}

// ---------------------------------------------------------------------------------------------------- posting vouchers
async function ledgerLike(patterns) {
  for (const pat of patterns) { const r = await get('SELECT id, name FROM ledgers WHERE name LIKE ? AND is_active = 1 ORDER BY id LIMIT 1', [pat]); if (r) return r; }
  return null;
}
async function firstInGroup(groupName, prefer) {
  if (prefer) { const p = await get('SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = ? AND l.name LIKE ? AND l.is_active = 1 ORDER BY l.id LIMIT 1', [groupName, prefer]); if (p) return p; }
  return get('SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = ? AND l.is_active = 1 AND l.name NOT LIKE ? ORDER BY l.id LIMIT 1', [groupName, 'Interstate%'])
    || get('SELECT l.id, l.name FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name = ? AND l.is_active = 1 ORDER BY l.id LIMIT 1', [groupName]);
}

/** Builds the balanced accounting entries (party, sales/purchase, tax, round off) for the lines being posted. */
async function buildEntries(kind, partyId, t, partyName) {
  const sales = kind === 'sales';
  const book = await firstInGroup(sales ? 'Sales Accounts' : 'Purchase Accounts', t.igst > 0 ? 'Interstate%' : null);
  if (!book) throw bad(`No ledger found under "${sales ? 'Sales' : 'Purchase'} Accounts". Create one first.`, 409);
  const entries = [sales ? { ledger_id: partyId, debit_amount: t.total, credit_amount: 0, particulars: partyName } : { ledger_id: partyId, debit_amount: 0, credit_amount: t.total, particulars: partyName }];
  entries.push(sales ? { ledger_id: book.id, debit_amount: 0, credit_amount: t.taxable, particulars: `${book.name} (Sales)` } : { ledger_id: book.id, debit_amount: t.taxable, credit_amount: 0, particulars: `${book.name} (Purchase)` });
  for (const [key, pat, label] of [['cgst', 'CGST%', 'CGST'], ['sgst', 'SGST%', 'SGST'], ['igst', 'IGST%', 'IGST']]) {
    if (!(t[key] > 0)) continue;
    const led = await ledgerLike([`${sales ? 'Output' : 'Input'} ${pat}`]);
    if (!led) throw bad(`Ledger "${sales ? 'Output' : 'Input'} ${label}" was not found under Duties & Taxes. Create it first.`, 409);
    entries.push(sales ? { ledger_id: led.id, debit_amount: 0, credit_amount: t[key], particulars: led.name } : { ledger_id: led.id, debit_amount: t[key], credit_amount: 0, particulars: led.name });
  }
  if (Math.abs(t.round_off) >= 0.005) {
    const ro = await ledgerLike(['Round Off%', '%Round%']);
    if (!ro) throw bad('Ledger "Round Off A/c" was not found.', 409);
    const up = t.round_off > 0; // total is above the exact amount
    entries.push(sales ? (up ? { ledger_id: ro.id, debit_amount: 0, credit_amount: t.round_off, particulars: ro.name } : { ledger_id: ro.id, debit_amount: Math.abs(t.round_off), credit_amount: 0, particulars: ro.name })
      : (up ? { ledger_id: ro.id, debit_amount: t.round_off, credit_amount: 0, particulars: ro.name } : { ledger_id: ro.id, debit_amount: 0, credit_amount: Math.abs(t.round_off), particulars: ro.name }));
  }
  return entries;
}

function mayPost(user, type) {
  const p = getRolePermissions(user && user.role);
  if (!p.canCreateVouchers || !(p.allowedVoucherTypes || []).includes(type)) throw bad(`Your role "${user && user.role}" may not post ${type} vouchers.`, 403);
}

async function post(kind, o, picked, voucherNo, date, reference, user) {
  const intra = await isIntra(o.party_ledger_id), t = compute(picked, intra);
  const type = kind === 'sales' ? 'Sales' : 'Purchase';
  const entries = await buildEntries(kind, o.party_ledger_id, t, o.party);
  const inventory = t.lines.map((l) => ({ stock_item_id: l.item_id, quantity: l.qty, rate: l.qty ? r2(l.amount / l.qty) : l.rate, amount: l.amount, discount_pct: 0, godown_id: o.warehouse_id }));
  const held = await approvals.evaluate({ voucher_type: type, entries, inventory: kind === 'sales' ? picked.map((l, i) => ({ ...inventory[i], discount_pct: l.discount_pct })) : inventory }, user);
  if (held.length) throw bad(`This ${type.toLowerCase()} needs approval (${held.map((h) => h.reason).join('; ')}). An Owner or Accountant must do it.`, 403);
  const due = addDays(date, o.credit_period == null ? 30 : o.credit_period);
  try {
    const v = await postVoucher({ voucher_type: type, voucher_no: voucherNo, date, reference_no: reference, narration: `${kind === 'sales' ? 'Sales' : 'Purchase'} order ${o.number}`, party_ledger_id: o.party_ledger_id, entries, inventory,
      bill_allocations: [{ ledger_id: o.party_ledger_id, bill_type: 'New Ref', bill_ref: reference || voucherNo, amount: t.total, due_date: due }] }, { inTransaction: true });
    return { voucher: v, totals: t };
  } catch (e) {
    if (e instanceof VoucherValidationError) throw bad(e.message, 400);
    if (/UNIQUE/.test(String(e.message))) throw bad(`The document number ${voucherNo} is already used by another voucher.`, 409);
    throw e;
  }
}

/** Goods received against a purchase order (all or part): posts a Purchase voucher and brings the stock in. */
async function receiveGoods(id, b, user) {
  mayPost(user, 'Purchase');
  const date = checkDate(b.date, 'Receipt date'), reference = String(b.reference || '').trim().slice(0, 60) || null;
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Enter the quantity received for at least one line.');
  return withTransaction(async () => {
    const o = await loadOrder(id);
    if (o.kind !== 'purchase') throw bad('That is not a purchase order.', 400);
    if (!['issued', 'partially_received'].includes(o.status)) throw bad(o.status === 'draft' ? 'Issue the purchase order before receiving goods.' : `This order is ${o.status.replace('_', ' ')}.`, 409);
    const wh = await get('SELECT name, is_active FROM godowns WHERE id = ?', [o.warehouse_id]);
    if (!wh.is_active) throw bad(`${wh.name} is archived.`, 422);
    const picked = []; const seen = new Set();
    for (const r of b.lines) {
      const line = o.lines.find((l) => l.id === parseInt(r.line_id, 10));
      if (!line) throw bad('A line does not belong to this order.');
      if (seen.has(line.id)) throw bad(`${line.item} appears twice.`); seen.add(line.id);
      const qty = Number(r.qty); if (!Number.isFinite(qty) || qty < 0) throw bad(`${line.item}: enter zero or a positive quantity.`);
      if (qty === 0) continue;
      const remaining = r3(line.qty - line.qty_done);
      if (r3(qty) > remaining) throw bad(`${line.item}: only ${remaining} still to receive (you entered ${qty}).`, 409);
      picked.push({ ...line, qty: r3(qty), line_id: line.id });
    }
    if (!picked.length) throw bad('Enter a quantity above zero for at least one line.');
    const grn = await nextNumber('inv_order_docs', 'number', 'GRN');
    const { voucher, totals } = await post('purchase', o, picked, grn, date, reference || o.number, user);
    for (const l of picked) await run('UPDATE inv_order_lines SET qty_done = qty_done + ? WHERE id = ?', [l.qty, l.line_id]);
    const left = await get('SELECT COUNT(*) c FROM inv_order_lines WHERE order_id = ? AND qty_done + 0.0005 < qty', [id]);
    await run('UPDATE inv_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [left.c ? 'partially_received' : 'received', id]);
    await run('INSERT INTO inv_order_docs (order_id, kind, number, voucher_id, doc_date, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, 'receipt', grn, voucher.id, date, reference, user.username]);
    await logActivity({ user, action: 'INV_PO_RECEIVE', entity: 'inv_order', entityId: id, details: { po: o.number, grn, total: totals.total, voucher_id: voucher.id } });
  }).then(() => getOrder(id, user));
}

/** Invoices a confirmed sales order: posts the Sales voucher (stock out, receivable, output GST) and frees the reservation. */
async function invoiceOrder(id, b, user) {
  mayPost(user, 'Sales');
  const date = checkDate(b.date, 'Invoice date'), reference = String(b.reference || '').trim().slice(0, 60) || null;
  return withTransaction(async () => {
    const o = await loadOrder(id);
    if (o.kind !== 'sales') throw bad('That is not a sales order.', 400);
    if (o.status !== 'confirmed') throw bad(o.status === 'draft' ? 'Confirm the sales order first (this reserves the stock).' : `This order is ${o.status}.`, 409);
    const picked = o.lines.map((l) => ({ ...l, line_id: l.id }));
    for (const l of picked) {
      const { by } = await stockState({ itemId: l.item_id });
      const st = by.get(l.item_id); if (!st.item.is_active) throw bad(`${st.item.name} is archived.`, 422);
      const mine = (await get("SELECT COALESCE(SUM(qty), 0) q FROM inv_reservations WHERE ref_type = 'order' AND ref_id = ? AND item_id = ? AND godown_id = ?", [id, l.item_id, o.warehouse_id])).q;
      const free = r3((st.perGodown.get(o.warehouse_id) || 0) - ((st.reserved.get(o.warehouse_id) || 0) - mine));
      if (l.qty > free) throw bad(`Not enough ${st.item.name} in stock to invoice: ${free} available, ${l.qty} ordered.`, 409);
    }
    const no = await nextNumber('inv_order_docs', 'number', 'SINV');
    const { voucher, totals } = await post('sales', o, picked, no, date, reference || o.number, user);
    await run("DELETE FROM inv_reservations WHERE ref_type = 'order' AND ref_id = ?", [id]);
    await run('UPDATE inv_order_lines SET qty_done = qty WHERE order_id = ?', [id]);
    await run("UPDATE inv_orders SET status = 'invoiced', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    await run('INSERT INTO inv_order_docs (order_id, kind, number, voucher_id, doc_date, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, 'invoice', no, voucher.id, date, reference, user.username]);
    await logActivity({ user, action: 'INV_SO_INVOICE', entity: 'inv_order', entityId: id, details: { so: o.number, invoice: no, total: totals.total, voucher_id: voucher.id } });
  }).then(() => getOrder(id, user));
}

// ---------------------------------------------------------------------------------------------------- history
async function history(kind, q, user) {
  const type = kind === 'sales' ? 'Sales' : 'Purchase';
  const where = ['v.voucher_type = ?'], p = [type];
  if (q.party) { where.push('v.party_ledger_id = ?'); p.push(parseInt(q.party, 10)); }
  if (q.from && ISO.test(q.from)) { where.push('v.date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('v.date <= ?'); p.push(q.to); }
  if (q.q) { where.push("(v.voucher_no LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\' OR v.reference_no LIKE ? ESCAPE '\\' OR o.number LIKE ? ESCAPE '\\')"); const n = like(q.q); p.push(n, n, n, n); }
  const base = `FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id LEFT JOIN inv_order_docs d ON d.voucher_id = v.id LEFT JOIN inv_orders o ON o.id = d.order_id WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c, pg = page(q, total);
  const rows = await all(`SELECT v.id, v.voucher_no AS number, v.date, v.reference_no AS reference, v.total_amount AS total, l.name AS party, o.number AS order_number, o.id AS order_id,
    (SELECT COALESCE(SUM(quantity), 0) FROM inventory_entries WHERE voucher_id = v.id) AS quantity ${base} ORDER BY v.date DESC, v.id DESC LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  const sum = await get(`SELECT COALESCE(SUM(v.total_amount), 0) s ${base}`, p);
  return { items: rows, page: pg.page, page_size: pg.page_size, pages: pg.pages, total, sum: r2(sum.s) };
}

module.exports = {
  post, buildEntries, nextNumber, loadOrder, isIntra, listParties, partyDetail, saveParty, setPartyActive, createOrder, getOrder, listOrders, updateOrder, deleteOrder, confirmOrder, cancelOrder, receiveGoods, invoiceOrder, history, compute
};

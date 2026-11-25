/**
 * RRE Tally — customer portal (inventory suite, stage 4).
 *
 * A portal login has the role "Customer" and is tied to exactly ONE customer account (users.party_id). Everything a customer
 * can see or do is scoped by that link, which is read from the DATABASE on every request. Nothing in the request (URL, body,
 * query, token) can name a different customer. Someone else's record answers 404, exactly as if it did not exist.
 *
 * A customer can: browse the catalogue (name, unit, selling price, availability status; never cost, margin or exact stock),
 * place an order request (which staff confirm), cancel their own unconfirmed orders, and see their own orders and invoices.
 */
const { get, all, run } = require('./db');
const { hashPassword } = require('./security');
const { checkPassword } = require('./passwordPolicy');
const { identify, requireAuth, logActivity } = require('./auth');
const { withTransaction } = require('./tx');
const inv = require('./invCore');
const ord = require('./invOrders');

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const paging = (q, total, def = 20, max = 50) => {
  const size = Math.min(max, Math.max(1, parseInt(q.page_size, 10) || def)), pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, parseInt(q.page, 10) || 1));
  return { page, page_size: size, pages, offset: (page - 1) * size };
};
const MAX_OPEN_REQUESTS = 20, MAX_LOGINS_PER_CUSTOMER = 5;
const STATUS_LABEL = { draft: 'Awaiting confirmation', confirmed: 'Confirmed', invoiced: 'Invoiced', cancelled: 'Cancelled' };

// ---------------------------------------------------------------------------------------------------- who is calling
/**
 * Express middleware for every /api/portal route. Only a signed-in "Customer" whose login is active AND tied to an active
 * customer account gets through. The customer account id comes from the database, never from the request.
 */
async function portalOnly(req, res, next) {
  const guard = requireAuth(null, { allowCustomer: true });
  guard(req, res, async () => {
    try {
      if (req.user.role !== 'Customer') return res.status(403).json({ success: false, error: 'The customer portal is for customer accounts. Staff use the main application.', code: 'NOT_A_CUSTOMER' });
      const u = await get('SELECT id, username, full_name, role, status, party_id, email, phone FROM users WHERE id = ?', [req.user.userId]);
      if (!u || u.role !== 'Customer' || u.status !== 'Active') return res.status(401).json({ success: false, error: 'This login is no longer active. Please contact the company.', code: 'AUTH_REQUIRED' });
      if (!u.party_id) return res.status(403).json({ success: false, error: 'This login is not linked to a customer account. Please contact the company.', code: 'NO_CUSTOMER' });
      const p = await get(`SELECT l.id, l.name, l.gstin, pp.city AS city, l.state, l.address, l.is_active FROM ledgers l JOIN account_groups g ON g.id = l.group_id LEFT JOIN party_profiles pp ON pp.ledger_id = l.id WHERE l.id = ? AND g.name = 'Sundry Debtors'`, [u.party_id]);
      if (!p || !p.is_active) return res.status(403).json({ success: false, error: 'Your customer account is not active. Please contact the company.', code: 'NO_CUSTOMER' });
      req.portal = { userId: u.id, username: u.username, fullName: u.full_name, partyId: p.id, party: p };
      next();
    } catch (e) { console.error('[Portal] ' + e.message); res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' }); }
  });
}

// ---------------------------------------------------------------------------------------------------- catalogue
const availability = (avail, reorder) => (avail <= 0 ? 'out' : reorder > 0 && avail <= reorder ? 'limited' : 'in_stock');
const AVAIL_LABEL = { in_stock: 'In stock', limited: 'Limited stock', out: 'Out of stock' };

async function activeWarehouseIds() { return new Set((await all('SELECT id FROM godowns WHERE is_active = 1')).map((g) => g.id)); }

async function catalogue(q) {
  const { by } = await inv.stockState();
  const wh = await activeWarehouseIds(), needle = String(q.q || '').trim().toLowerCase();
  let rows = [];
  for (const st of by.values()) {
    const it = st.item; if (!it.is_active) continue;
    let onHand = 0, reserved = 0;
    for (const [gid, qty] of st.perGodown) if (wh.has(gid)) onHand += qty;
    for (const [gid, qty] of st.reserved) if (wh.has(gid)) reserved += qty;
    const av = availability(onHand - reserved, it.reorder_level || 0), price = it.standard_price || 0;
    rows.push({ id: it.id, name: it.name, sku: it.sku, brand: it.brand || null, description: it.description || null, category: it.category, category_id: it.stock_group_id, uom: it.uom, decimals: it.decimal_places || 0,
      price: price > 0 ? r2(price) : null, gst_rate: it.gst_rate || 0, availability: av, availability_label: AVAIL_LABEL[av], orderable: price > 0 });
  }
  const categories = [...new Map(rows.map((r) => [r.category_id, r.category])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (needle) rows = rows.filter((r) => [r.name, r.sku, r.brand].some((x) => x && String(x).toLowerCase().includes(needle)));
  if (q.category) rows = rows.filter((r) => String(r.category_id) === String(q.category));
  if (q.available === '1') rows = rows.filter((r) => r.availability !== 'out');
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const pg = paging(q, rows.length, 24);
  return { items: rows.slice(pg.offset, pg.offset + pg.page_size), categories, page: pg.page, page_size: pg.page_size, pages: pg.pages, total: rows.length };
}

// ---------------------------------------------------------------------------------------------------- orders
const orderRow = (o) => ({ id: o.id, number: o.number, status: o.status, status_label: STATUS_LABEL[o.status] || o.status, order_date: o.order_date, expected_date: o.expected_date, reference: o.reference, total: o.total, lines: o.lines, can_cancel: o.status === 'draft' });

async function listOrders(portal, q) {
  const where = ["o.kind = 'sales'", 'o.party_ledger_id = ?'], p = [portal.partyId];
  if (q.status && STATUS_LABEL[q.status]) { where.push('o.status = ?'); p.push(q.status); }
  if (q.from && ISO.test(q.from)) { where.push('o.order_date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('o.order_date <= ?'); p.push(q.to); }
  if (q.q) { where.push("(o.number LIKE ? ESCAPE '\\' OR o.reference LIKE ? ESCAPE '\\')"); p.push(like(q.q), like(q.q)); }
  const base = `FROM inv_orders o WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c, pg = paging(q, total, 20);
  const rows = await all(`SELECT o.id, o.number, o.status, o.order_date, o.expected_date, o.reference, o.total, (SELECT COUNT(*) FROM inv_order_lines WHERE order_id = o.id) AS lines ${base} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  return { items: rows.map(orderRow), page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
}

/** One of THIS customer's orders, or 404. The customer id in the WHERE clause is the whole access rule. */
async function getOrder(portal, id) {
  const o = await get(`SELECT o.id, o.number, o.status, o.order_date, o.expected_date, o.reference, o.notes, o.total, o.cancelled_reason FROM inv_orders o WHERE o.id = ? AND o.kind = 'sales' AND o.party_ledger_id = ?`, [id, portal.partyId]);
  if (!o) throw bad('Order not found.', 404);
  const full = await ord.getOrder(o.id, { username: portal.username });
  const out = { ...orderRow({ ...o, lines: full.lines.length }), notes: o.notes, cancelled_reason: o.cancelled_reason,
    lines: full.lines.map((l) => ({ item: l.item, sku: l.sku, uom: l.uom, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate, amount: l.amount, invoiced_qty: l.qty_done })),
    totals: { taxable: full.totals.taxable, tax: full.totals.tax, round_off: full.totals.round_off, total: full.totals.total } };
  out.invoices = await all(`SELECT v.id, v.voucher_no AS number, v.date, v.total_amount AS total FROM inv_order_docs d JOIN vouchers v ON v.id = d.voucher_id WHERE d.order_id = ? AND d.kind = 'invoice' AND v.party_ledger_id = ? ORDER BY d.id`, [o.id, portal.partyId]).catch(() => []);
  return out;
}

async function placeOrder(portal, b) {
  b = b || {};
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one item to your order.');
  if (b.lines.length > 50) throw bad('An order request can have at most 50 items. Please split it.');
  const lines = [], seen = new Set();
  for (const [i, l] of b.lines.entries()) {
    const itemId = parseInt(l && l.item_id, 10);
    const item = itemId ? await get('SELECT s.id, s.name, s.is_active, s.standard_price, u.decimal_places FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id WHERE s.id = ?', [itemId]) : null;
    if (!item || !item.is_active) throw bad(`Item ${i + 1} is not available.`, 422);
    if (seen.has(item.id)) throw bad(`${item.name} appears twice. Combine the quantities.`); seen.add(item.id);
    if (!(item.standard_price > 0)) throw bad(`${item.name} has no listed price. Please contact the company to order it.`, 422);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw bad(`${item.name}: enter a quantity between 0 and 100,000.`);
    if (!item.decimal_places && !Number.isInteger(qty)) throw bad(`${item.name}: this item is sold in whole units.`);
    lines.push({ item_id: item.id, qty }); // rate, discount and GST are NOT taken from the customer: the server prices the order
  }
  const wh = await get('SELECT id FROM godowns WHERE is_active = 1 ORDER BY id LIMIT 1');
  if (!wh) throw bad('Orders cannot be placed right now. Please contact the company.', 503);
  const note = String(b.notes || '').trim().slice(0, 500), ref = String(b.reference || '').trim().slice(0, 60);
  let expected = null; if (b.expected_date) { if (!ISO.test(b.expected_date) || b.expected_date < today()) throw bad('Choose a delivery date that is today or later.'); expected = b.expected_date; }
  const open = (await get(`SELECT COUNT(*) c FROM inv_orders WHERE party_ledger_id = ? AND portal_user_id IS NOT NULL AND status = 'draft'`, [portal.partyId])).c;
  if (open >= MAX_OPEN_REQUESTS) throw bad(`You already have ${open} orders waiting for confirmation. Please wait for them to be confirmed or cancel some.`, 429);
  const user = { username: `portal:${portal.username}`, userId: portal.userId, role: 'Customer' };
  const created = await ord.createOrder('sales', { party_id: portal.partyId, warehouse_id: wh.id, order_date: today(), expected_date: expected, reference: ref, notes: note, lines }, user, { portalUserId: portal.userId });
  // double-click / retry guard: an identical request from this login in the last 20 seconds is the same request
  const twin = await get(`SELECT id FROM inv_orders WHERE portal_user_id = ? AND id < ? AND total = ? AND created_at >= datetime('now', '-20 seconds') AND (SELECT COUNT(*) FROM inv_order_lines WHERE order_id = inv_orders.id) = ?`, [portal.userId, created.id, created.total, lines.length]);
  if (twin) {
    await run("DELETE FROM inv_orders WHERE id = ? AND status = 'draft' AND portal_user_id = ?", [created.id, portal.userId]);
    throw bad('You just sent this same order. It is already in your list.', 409);
  }
  return getOrder(portal, created.id);
}

async function cancelOrder(portal, id, reason) {
  const r = await run(`UPDATE inv_orders SET status = 'cancelled', cancelled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = 'sales' AND party_ledger_id = ? AND status = 'draft'`,
    [`Cancelled by customer${reason ? ': ' + String(reason).trim().slice(0, 150) : ''}`, id, portal.partyId]);
  if (!r.changes) {
    const o = await get("SELECT status FROM inv_orders WHERE id = ? AND kind = 'sales' AND party_ledger_id = ?", [id, portal.partyId]);
    if (!o) throw bad('Order not found.', 404);
    throw bad(o.status === 'cancelled' ? 'This order is already cancelled.' : 'This order has been confirmed. Please contact the company to change it.', 409);
  }
  await logActivity({ user: { username: `portal:${portal.username}`, userId: portal.userId, role: 'Customer' }, action: 'PORTAL_ORDER_CANCEL', entity: 'inv_order', entityId: id, details: {} });
  return getOrder(portal, id);
}

// ---------------------------------------------------------------------------------------------------- invoices
async function listInvoices(portal, q) {
  const where = ["v.party_ledger_id = ?", "v.voucher_type IN ('Sales', 'Credit Note')"], p = [portal.partyId];
  if (q.from && ISO.test(q.from)) { where.push('v.date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('v.date <= ?'); p.push(q.to); }
  if (q.q) { where.push("(v.voucher_no LIKE ? ESCAPE '\\' OR v.reference_no LIKE ? ESCAPE '\\')"); p.push(like(q.q), like(q.q)); }
  const base = `FROM vouchers v LEFT JOIN inv_order_docs d ON d.voucher_id = v.id LEFT JOIN inv_orders o ON o.id = d.order_id AND o.party_ledger_id = v.party_ledger_id WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c, pg = paging(q, total, 20);
  const rows = await all(`SELECT v.id, v.voucher_no AS number, v.voucher_type AS type, v.date, v.reference_no AS reference, v.total_amount AS total, o.number AS order_number ${base} ORDER BY v.date DESC, v.id DESC LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  return { items: rows, page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
}

async function getInvoice(portal, id) {
  const v = await get(`SELECT v.id, v.voucher_no AS number, v.voucher_type AS type, v.date, v.reference_no AS reference, v.total_amount AS total FROM vouchers v WHERE v.id = ? AND v.party_ledger_id = ? AND v.voucher_type IN ('Sales', 'Credit Note')`, [id, portal.partyId]);
  if (!v) throw bad('Invoice not found.', 404);
  const items = await all(`SELECT s.name AS item, s.sku, u.symbol AS uom, e.quantity AS qty, e.rate, e.discount_pct, e.amount FROM inventory_entries e JOIN stock_items s ON s.id = e.stock_item_id JOIN units_of_measure u ON u.id = s.uom_id WHERE e.voucher_id = ? ORDER BY e.id`, [v.id]);
  const taxable = r2(items.reduce((t, x) => t + x.amount, 0));
  const order = await get(`SELECT o.id, o.number FROM inv_order_docs d JOIN inv_orders o ON o.id = d.order_id WHERE d.voucher_id = ? AND o.party_ledger_id = ?`, [v.id, portal.partyId]);
  return { ...v, items, taxable, tax_and_rounding: r2(v.total - taxable), order: order || null };
}

async function summary(portal) {
  const c = async (st) => (await get("SELECT COUNT(*) c FROM inv_orders WHERE kind = 'sales' AND party_ledger_id = ? AND status = ?", [portal.partyId, st])).c;
  return { customer: portal.party.name, awaiting: await c('draft'), confirmed: await c('confirmed'), invoiced: await c('invoiced'),
    recent_orders: (await listOrders(portal, { page_size: 5 })).items, recent_invoices: (await listInvoices(portal, { page_size: 5 })).items };
}

function me(portal) {
  const p = portal.party;
  return { username: portal.username, full_name: portal.fullName, customer: { name: p.name, gstin: p.gstin || null, city: p.city || null, state: p.state || null } };
}

// ---------------------------------------------------------------------------------------------------- admin: portal logins (Owner only; the route requires canManageUsers)
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,39}$/;

async function listPortalUsers(q = {}) {
  const where = ["u.role = 'Customer'"], p = [];
  if (q.party) { where.push('u.party_id = ?'); p.push(parseInt(q.party, 10) || 0); }
  return all(`SELECT u.id, u.username, u.full_name, u.email, u.status, u.party_id, l.name AS customer, u.last_login, u.created_at, u.must_change_password AS must_change,
    (SELECT COUNT(*) FROM inv_orders WHERE portal_user_id = u.id) AS orders FROM users u LEFT JOIN ledgers l ON l.id = u.party_id WHERE ${where.join(' AND ')} ORDER BY l.name, u.username`, p);
}

async function createPortalUser(b, admin) {
  b = b || {};
  const partyId = parseInt(b.party_id, 10);
  const party = partyId ? await get(`SELECT l.id, l.name, l.is_active FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ? AND g.name = 'Sundry Debtors'`, [partyId]) : null;
  if (!party) throw bad('Choose a customer.');
  if (!party.is_active) throw bad(`${party.name} is archived.`, 422);
  const username = String(b.username || '').trim();
  if (!USERNAME.test(username)) throw bad('The username must be 3–40 characters: letters, numbers, dot, dash, underscore or @.');
  const password = String(b.password || '').trim();
  const weak = checkPassword(password, { username }); if (weak) throw bad(weak);
  const fullName = String(b.full_name || '').trim().slice(0, 80) || party.name;
  const email = String(b.email || '').trim().slice(0, 100);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('That email address does not look right.');
  return withTransaction(async () => {
    if (await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username])) throw bad(`The username "${username}" is already taken.`, 409);
    if ((await get("SELECT COUNT(*) c FROM users WHERE role = 'Customer' AND party_id = ?", [party.id])).c >= MAX_LOGINS_PER_CUSTOMER) throw bad(`${party.name} already has ${MAX_LOGINS_PER_CUSTOMER} portal logins.`, 409);
    const r = await run(`INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password, party_id) VALUES (?, ?, ?, 'Customer', ?, '', 'Active', 0, 1, ?)`,
      [username, hashPassword(password), fullName, email, party.id]);
    await logActivity({ user: admin, action: 'PORTAL_USER_CREATE', entity: 'user', entityId: r.lastID, details: { username, customer: party.name } });
    return r.lastID;
  }).then(async (id) => (await listPortalUsers()).find((u) => u.id === id));
}

async function portalUserOr404(id) {
  const u = await get("SELECT id, username, role FROM users WHERE id = ?", [id]);
  if (!u || u.role !== 'Customer') throw bad('Portal login not found.', 404);
  return u;
}

async function setPortalUserStatus(id, active, admin) {
  const u = await portalUserOr404(id);
  await run('UPDATE users SET status = ? WHERE id = ?', [active ? 'Active' : 'Inactive', id]);
  // disabling ends every session of that login NOW (not later in the background: re-enabling quickly must never revive an old session)
  if (!active) await require('./identity').revokeUserSessions(id, 'disabled');
  await logActivity({ user: admin, action: active ? 'PORTAL_USER_ENABLE' : 'PORTAL_USER_DISABLE', entity: 'user', entityId: id, details: { username: u.username } });
  return (await listPortalUsers()).find((x) => x.id === id);
}

async function resetPortalPassword(id, password, admin) {
  const u = await portalUserOr404(id);
  const pw = String(password || '').trim(), weak = checkPassword(pw, { username: u.username }); if (weak) throw bad(weak);
  await run('UPDATE users SET password = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?', [hashPassword(pw), id]);
  await logActivity({ user: admin, action: 'PORTAL_USER_RESET_PASSWORD', entity: 'user', entityId: id, details: { username: u.username } });
  return (await listPortalUsers()).find((x) => x.id === id);
}

module.exports = { portalOnly, me, catalogue, listOrders, getOrder, placeOrder, cancelOrder, listInvoices, getInvoice, summary, listPortalUsers, createPortalUser, setPortalUserStatus, resetPortalPassword };

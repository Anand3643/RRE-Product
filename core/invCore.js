/**
 * RRE Tally — inventory suite engine (the StockPilot features, built on RRE's own tables).
 *
 *   StockPilot            RRE
 *   product               stock_items          (+ sku, brand, description)
 *   category              stock_groups
 *   unit                  units_of_measure
 *   warehouse             godowns              (+ code, address, contact)
 *   stock ledger          inventory_entries    (written by vouchers; transfers/adjustments are Stock Journal vouchers)
 *   reserved stock        inv_reservations
 *
 * Stock is never stored as a separate balance: it is always derived from the entries, so accounting and inventory cannot drift.
 * Opening stock lives in the default (first) warehouse. Valuation is weighted average, the same method the reports already use.
 */
const { run, get, all, getRolePermissions } = require('./db');
const { withTransaction } = require('./tx');
const { logActivity } = require('./auth');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const ADJUSTMENT_REASONS = ['Stock count correction', 'Damaged goods', 'Lost / stolen', 'Expired', 'Found stock', 'Opening balance fix', 'Other'];
const MAX_PAGE = 100;

const canSeeValue = (user) => !!getRolePermissions(user && user.role).canViewFinancials;

function page(params, total) {
  const size = Math.min(MAX_PAGE, Math.max(1, parseInt(params.page_size, 10) || 25));
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, parseInt(params.page, 10) || 1));
  return { page: p, page_size: size, pages, total, offset: (p - 1) * size };
}

// ---------------------------------------------------------------------------------------------------- stock maths
async function defaultGodown() {
  const g = await get('SELECT id FROM godowns WHERE is_active = 1 ORDER BY id LIMIT 1') || await get('SELECT id FROM godowns ORDER BY id LIMIT 1');
  return g ? g.id : 1;
}

const ITEM_SQL = `SELECT s.id, s.name, s.sku, s.barcode, s.brand, s.description, s.hsn_code, s.gst_rate, s.opening_qty, s.opening_rate, s.opening_val,
  s.standard_cost, s.standard_price, s.reorder_level, s.is_active, s.stock_group_id, g.name AS category, s.uom_id, u.symbol AS uom, u.decimal_places
  FROM stock_items s JOIN stock_groups g ON g.id = s.stock_group_id JOIN units_of_measure u ON u.id = s.uom_id`;

/** One pass over the entries -> per item: net quantity per warehouse, weighted-average cost, reserved quantity. */
async function stockState({ itemId = null } = {}) {
  const dg = await defaultGodown();
  const items = await all(`${ITEM_SQL} ${itemId ? 'WHERE s.id = ?' : ''} ORDER BY s.name`, itemId ? [itemId] : []);
  const agg = await all(`SELECT stock_item_id AS id, COALESCE(godown_id, ?) AS gid, direction AS dir, SUM(quantity) AS q, SUM(amount) AS a
                         FROM inventory_entries ${itemId ? 'WHERE stock_item_id = ?' : ''} GROUP BY stock_item_id, COALESCE(godown_id, ?), direction`, itemId ? [dg, itemId, dg] : [dg, dg]);
  const res = await all(`SELECT item_id AS id, godown_id AS gid, SUM(qty) AS q FROM inv_reservations ${itemId ? 'WHERE item_id = ?' : ''} GROUP BY item_id, godown_id`, itemId ? [itemId] : []);
  const by = new Map();
  for (const it of items) by.set(it.id, { item: it, perGodown: new Map([[dg, it.opening_qty || 0]]), inQty: 0, inAmt: 0, reserved: new Map() });
  for (const a of agg) {
    const st = by.get(a.id); if (!st) continue;
    const cur = st.perGodown.get(a.gid) || 0;
    st.perGodown.set(a.gid, cur + (a.dir === 'IN' ? a.q : -a.q));
    if (a.dir === 'IN') { st.inQty += a.q; st.inAmt += a.a; }
  }
  for (const r of res) { const st = by.get(r.id); if (st) st.reserved.set(r.gid, r.q); }
  for (const st of by.values()) {
    const it = st.item, q = (it.opening_qty || 0) + st.inQty, v = (it.opening_val || 0) + st.inAmt;
    st.rate = q > 0 ? v / q : (it.opening_rate || it.standard_cost || 0);
    st.onHand = r3([...st.perGodown.values()].reduce((t, x) => t + x, 0));
    st.reservedTotal = r3([...st.reserved.values()].reduce((t, x) => t + x, 0));
  }
  return { by, dg };
}

const statusOf = (available, reorder, hadStock) => (available <= 0 ? (hadStock ? 'out' : 'out') : reorder > 0 && available <= reorder ? 'low' : 'ok');

function itemRow(st, user) {
  const it = st.item, avail = r3(st.onHand - st.reservedTotal);
  const row = {
    id: it.id, name: it.name, sku: it.sku, barcode: it.barcode, brand: it.brand, category: it.category, category_id: it.stock_group_id, uom: it.uom, uom_id: it.uom_id,
    hsn_code: it.hsn_code, gst_rate: it.gst_rate, reorder_level: it.reorder_level || 0, is_active: it.is_active ? 1 : 0, description: it.description,
    on_hand: st.onHand, reserved: st.reservedTotal, available: avail, status: statusOf(avail, it.reorder_level || 0)
  };
  if (canSeeValue(user)) { row.cost = r2(st.rate); row.price = it.standard_price || 0; row.value = r2(Math.max(st.onHand, 0) * st.rate); }
  return row;
}

// ---------------------------------------------------------------------------------------------------- items
async function listItems(q, user) {
  const { by } = await stockState();
  const needle = String(q.q || '').trim().toLowerCase();
  let rows = [...by.values()].map((st) => itemRow(st, user));
  if (q.archived === '1') rows = rows.filter((r) => !r.is_active); else rows = rows.filter((r) => r.is_active);
  if (needle) rows = rows.filter((r) => [r.name, r.sku, r.barcode, r.hsn_code, r.brand].some((x) => x && String(x).toLowerCase().includes(needle)));
  if (q.category) rows = rows.filter((r) => String(r.category_id) === String(q.category));
  if (q.status && ['ok', 'low', 'out'].includes(q.status)) rows = rows.filter((r) => r.status === q.status);
  if (q.warehouse) {
    const gid = parseInt(q.warehouse, 10);
    rows = rows.filter((r) => (by.get(r.id).perGodown.get(gid) || 0) !== 0);
    for (const r of rows) { const st = by.get(r.id); r.on_hand = r3(st.perGodown.get(gid) || 0); r.reserved = r3(st.reserved.get(gid) || 0); r.available = r3(r.on_hand - r.reserved); r.status = statusOf(r.available, r.reorder_level); }
  }
  const sorts = { name: (a, b) => a.name.localeCompare(b.name), stock: (a, b) => b.on_hand - a.on_hand, value: (a, b) => (b.value || 0) - (a.value || 0), low: (a, b) => a.available - b.available };
  rows.sort(sorts[q.sort] || sorts.name);
  const pg = page(q, rows.length);
  return { items: rows.slice(pg.offset, pg.offset + pg.page_size), page: pg.page, page_size: pg.page_size, pages: pg.pages, total: pg.total };
}

async function itemDetail(id, user) {
  const { by } = await stockState({ itemId: id });
  const st = by.get(id);
  if (!st) throw bad('Item not found.', 404);
  const gods = await all('SELECT id, name, code, is_active FROM godowns ORDER BY id');
  const row = itemRow(st, user);
  row.warehouses = gods.map((g) => {
    const oh = r3(st.perGodown.get(g.id) || 0), rs = r3(st.reserved.get(g.id) || 0);
    const w = { id: g.id, name: g.name, code: g.code, on_hand: oh, reserved: rs, available: r3(oh - rs) };
    if (canSeeValue(user)) w.value = r2(Math.max(oh, 0) * st.rate);
    return w;
  }).filter((w) => w.on_hand !== 0 || w.reserved !== 0 || gods.length <= 4);
  row.recent = (await movements({ item: id, page_size: 12 }, user)).items;
  row.used = (await get('SELECT COUNT(*) c FROM inventory_entries WHERE stock_item_id = ?', [id])).c > 0;
  return row;
}

function cleanItem(b, partial = false) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;
  if (need('name')) { const n = String(b.name || '').trim(); if (n.length < 2 || n.length > 120) throw bad('Item name must be 2–120 characters.'); out.name = n; }
  if (b.sku !== undefined && String(b.sku).trim() !== '') { const s = String(b.sku).trim().toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._\-\/]{1,39}$/.test(s)) throw bad('SKU may use letters, digits and . _ - / (2–40 characters).'); out.sku = s; }
  if (b.barcode !== undefined) { const c = String(b.barcode || '').trim(); if (c && !/^[A-Za-z0-9\-]{4,32}$/.test(c)) throw bad('Barcode must be 4–32 letters, digits or dashes.'); out.barcode = c || null; }
  if (b.brand !== undefined) out.brand = String(b.brand || '').trim().slice(0, 60) || null;
  if (b.description !== undefined) out.description = String(b.description || '').trim().slice(0, 500) || null;
  if (b.hsn_code !== undefined) { const h = String(b.hsn_code || '').trim(); if (h && !/^\d{4,8}$/.test(h)) throw bad('HSN/SAC must be 4 to 8 digits.'); out.hsn_code = h || null; }
  const num = (k, label, max = 1e9) => { if (b[k] === undefined || b[k] === null || b[k] === '') return; const v = Number(b[k]); if (!Number.isFinite(v) || v < 0 || v > max) throw bad(`${label} must be a number between 0 and ${max}.`); out[k] = v; };
  num('gst_rate', 'GST rate', 100); num('reorder_level', 'Reorder level'); num('standard_price', 'Selling price'); num('standard_cost', 'Cost');
  if (need('category_id')) { const g = parseInt(b.category_id, 10); if (!g) throw bad('Choose a category.'); out.stock_group_id = g; }
  if (need('uom_id')) { const u = parseInt(b.uom_id, 10); if (!u) throw bad('Choose a unit of measure.'); out.uom_id = u; }
  return out;
}

function ean13(seed) {
  const d = String(seed).padStart(12, '0').slice(-12).split('').map(Number);
  const sum = d.reduce((t, x, i) => t + x * (i % 2 ? 3 : 1), 0);
  return d.join('') + ((10 - (sum % 10)) % 10);
}

async function createItem(b, user) {
  const c = cleanItem(b);
  const openQty = b.opening_qty === undefined || b.opening_qty === '' ? 0 : Number(b.opening_qty);
  if (!Number.isFinite(openQty) || openQty < 0 || openQty > 1e9) throw bad('Opening quantity must be zero or more.');
  const openRate = b.opening_rate === undefined || b.opening_rate === '' ? (c.standard_cost || 0) : Number(b.opening_rate);
  if (!Number.isFinite(openRate) || openRate < 0) throw bad('Opening rate must be zero or more.');
  return withTransaction(async () => {
    if (!(await get('SELECT id FROM stock_groups WHERE id = ?', [c.stock_group_id]))) throw bad('That category does not exist.');
    if (!(await get('SELECT id FROM units_of_measure WHERE id = ?', [c.uom_id]))) throw bad('That unit does not exist.');
    if (await get('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE', [c.name])) throw bad(`An item named "${c.name}" already exists.`, 409);
    if (c.sku && (await get('SELECT id FROM stock_items WHERE sku = ?', [c.sku]))) throw bad(`SKU ${c.sku} is already used.`, 409);
    if (c.barcode && (await get('SELECT id FROM stock_items WHERE barcode = ?', [c.barcode]))) throw bad('That barcode is already used by another item.', 409);
    const r = await run(`INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, opening_qty, opening_rate, opening_val, standard_cost, standard_price, reorder_level, barcode, brand, description, is_active)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [c.name, c.stock_group_id, c.uom_id, c.hsn_code || null, c.gst_rate ?? 18, openQty, openRate, r2(openQty * openRate), c.standard_cost || 0, c.standard_price || 0, c.reorder_level || 0, c.barcode || null, c.brand || null, c.description || null]);
    const sku = c.sku || `SKU-${String(r.lastID).padStart(5, '0')}`;
    await run('UPDATE stock_items SET sku = ? WHERE id = ?', [sku, r.lastID]);
    if (b.auto_barcode && !c.barcode) await run('UPDATE stock_items SET barcode = ? WHERE id = ?', [ean13(r.lastID + 200000000000), r.lastID]);
    await logActivity({ user, action: 'INV_ITEM_CREATE', entity: 'stock_item', entityId: r.lastID, details: { name: c.name, sku } });
    return r.lastID;
  }).then((id) => itemDetail(id, user));
}

async function updateItem(id, b, user) {
  const c = cleanItem(b, true);
  return withTransaction(async () => {
    const cur = await get('SELECT * FROM stock_items WHERE id = ?', [id]);
    if (!cur) throw bad('Item not found.', 404);
    if (c.name && (await get('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE AND id != ?', [c.name, id]))) throw bad(`An item named "${c.name}" already exists.`, 409);
    if (c.sku && (await get('SELECT id FROM stock_items WHERE sku = ? AND id != ?', [c.sku, id]))) throw bad(`SKU ${c.sku} is already used.`, 409);
    if (c.barcode && (await get('SELECT id FROM stock_items WHERE barcode = ? AND id != ?', [c.barcode, id]))) throw bad('That barcode is already used by another item.', 409);
    if (c.stock_group_id && !(await get('SELECT id FROM stock_groups WHERE id = ?', [c.stock_group_id]))) throw bad('That category does not exist.');
    if (c.uom_id && c.uom_id !== cur.uom_id && (await get('SELECT COUNT(*) c FROM inventory_entries WHERE stock_item_id = ?', [id])).c > 0) throw bad('The unit cannot be changed once the item has stock movements.', 409);
    const cols = Object.keys(c); if (!cols.length) throw bad('Nothing to change.');
    await run(`UPDATE stock_items SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => c[k]), id]);
    await logActivity({ user, action: 'INV_ITEM_UPDATE', entity: 'stock_item', entityId: id, details: { fields: cols } });
  }).then(() => itemDetail(id, user));
}

async function setArchived(id, archived, user) {
  return withTransaction(async () => {
    const cur = await get('SELECT id, name FROM stock_items WHERE id = ?', [id]);
    if (!cur) throw bad('Item not found.', 404);
    if (archived) {
      const { by } = await stockState({ itemId: id });
      const st = by.get(id);
      if (st.onHand > 0) throw bad(`${cur.name} still has ${st.onHand} in stock. Move or adjust it to zero before archiving.`, 409);
      if (st.reservedTotal > 0) throw bad(`${cur.name} is reserved for open orders.`, 409);
    }
    await run('UPDATE stock_items SET is_active = ? WHERE id = ?', [archived ? 0 : 1, id]);
    await logActivity({ user, action: archived ? 'INV_ITEM_ARCHIVE' : 'INV_ITEM_RESTORE', entity: 'stock_item', entityId: id });
  }).then(() => itemDetail(id, user));
}

async function deleteItem(id, user) {
  return withTransaction(async () => {
    const cur = await get('SELECT id, name, opening_qty FROM stock_items WHERE id = ?', [id]);
    if (!cur) throw bad('Item not found.', 404);
    const used = (await get('SELECT COUNT(*) c FROM inventory_entries WHERE stock_item_id = ?', [id])).c;
    if (used || cur.opening_qty > 0) throw bad('An item with stock history cannot be deleted. Archive it instead.', 409);
    await run('DELETE FROM stock_items WHERE id = ?', [id]);
    await logActivity({ user, action: 'INV_ITEM_DELETE', entity: 'stock_item', entityId: id, details: { name: cur.name } });
  }).then(() => ({ deleted: true }));
}

// ---------------------------------------------------------------------------------------------------- categories and units
async function listCategories() {
  return all(`SELECT g.id, g.name, g.parent_id, p.name AS parent,
    (SELECT COUNT(*) FROM stock_items s WHERE s.stock_group_id = g.id AND s.is_active = 1) AS items,
    (SELECT COUNT(*) FROM stock_groups c WHERE c.parent_id = g.id) AS children
    FROM stock_groups g LEFT JOIN stock_groups p ON p.id = g.parent_id ORDER BY g.name`);
}
const cleanName = (n, label) => { const s = String(n || '').trim(); if (s.length < 2 || s.length > 60) throw bad(`${label} must be 2–60 characters.`); return s; };
async function saveCategory(id, b, user) {
  const name = cleanName(b.name, 'Category name'); const parent = b.parent_id ? parseInt(b.parent_id, 10) : null;
  return withTransaction(async () => {
    if (await get('SELECT id FROM stock_groups WHERE name = ? COLLATE NOCASE AND id != ?', [name, id || 0])) throw bad(`A category named "${name}" already exists.`, 409);
    if (parent && (parent === id || !(await get('SELECT id FROM stock_groups WHERE id = ?', [parent])))) throw bad('Choose a valid parent category.');
    let rid = id;
    if (id) { if (!(await run('UPDATE stock_groups SET name = ?, parent_id = ? WHERE id = ?', [name, parent, id])).changes) throw bad('Category not found.', 404); }
    else rid = (await run('INSERT INTO stock_groups (name, parent_id) VALUES (?, ?)', [name, parent])).lastID;
    await logActivity({ user, action: id ? 'INV_CATEGORY_UPDATE' : 'INV_CATEGORY_CREATE', entity: 'stock_group', entityId: rid, details: { name } });
    return rid;
  }).then(async (rid) => (await listCategories()).find((c) => c.id === rid));
}
async function deleteCategory(id, user) {
  return withTransaction(async () => {
    const c = await get('SELECT id, name FROM stock_groups WHERE id = ?', [id]);
    if (!c) throw bad('Category not found.', 404);
    if ((await get('SELECT COUNT(*) c FROM stock_items WHERE stock_group_id = ?', [id])).c) throw bad('This category still has items.', 409);
    if ((await get('SELECT COUNT(*) c FROM stock_groups WHERE parent_id = ?', [id])).c) throw bad('This category has sub-categories.', 409);
    await run('DELETE FROM stock_groups WHERE id = ?', [id]);
    await logActivity({ user, action: 'INV_CATEGORY_DELETE', entity: 'stock_group', entityId: id, details: { name: c.name } });
  }).then(() => ({ deleted: true }));
}

async function listUnits() {
  return all(`SELECT u.id, u.symbol, u.formal_name, u.decimal_places, (SELECT COUNT(*) FROM stock_items s WHERE s.uom_id = u.id) AS items FROM units_of_measure u ORDER BY u.symbol`);
}
async function saveUnit(id, b, user) {
  const symbol = String(b.symbol || '').trim(); if (!/^[A-Za-z0-9 .\/²³-]{1,12}$/.test(symbol)) throw bad('Unit symbol must be 1–12 characters.');
  const formal = cleanName(b.formal_name || symbol, 'Unit name'); const dp = b.decimal_places === undefined || b.decimal_places === '' ? 0 : parseInt(b.decimal_places, 10);
  if (!Number.isInteger(dp) || dp < 0 || dp > 4) throw bad('Decimal places must be 0 to 4.');
  return withTransaction(async () => {
    if (await get('SELECT id FROM units_of_measure WHERE symbol = ? COLLATE NOCASE AND id != ?', [symbol, id || 0])) throw bad(`Unit "${symbol}" already exists.`, 409);
    let rid = id;
    if (id) { if (!(await run('UPDATE units_of_measure SET symbol = ?, formal_name = ?, decimal_places = ? WHERE id = ?', [symbol, formal, dp, id])).changes) throw bad('Unit not found.', 404); }
    else rid = (await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [symbol, formal, dp])).lastID;
    await logActivity({ user, action: id ? 'INV_UNIT_UPDATE' : 'INV_UNIT_CREATE', entity: 'uom', entityId: rid, details: { symbol } });
    return rid;
  }).then(async (rid) => (await listUnits()).find((u) => u.id === rid));
}
async function deleteUnit(id, user) {
  return withTransaction(async () => {
    const u = await get('SELECT id, symbol FROM units_of_measure WHERE id = ?', [id]);
    if (!u) throw bad('Unit not found.', 404);
    if ((await get('SELECT COUNT(*) c FROM stock_items WHERE uom_id = ?', [id])).c) throw bad('This unit is used by items.', 409);
    await run('DELETE FROM units_of_measure WHERE id = ?', [id]);
    await logActivity({ user, action: 'INV_UNIT_DELETE', entity: 'uom', entityId: id, details: { symbol: u.symbol } });
  }).then(() => ({ deleted: true }));
}

// ---------------------------------------------------------------------------------------------------- warehouses
async function listWarehouses(user) {
  const gods = await all('SELECT * FROM godowns ORDER BY is_active DESC, id');
  const { by } = await stockState();
  const rows = gods.map((g) => ({ id: g.id, name: g.name, code: g.code, address: g.address, city: g.city, location: g.location, contact_name: g.contact_name, phone: g.phone, email: g.email, is_active: g.is_active ? 1 : 0, items: 0, units: 0, low: 0, value: 0 }));
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const st of by.values()) {
    for (const [gid, q] of st.perGodown) {
      const w = map.get(gid); if (!w || q <= 0) continue;
      w.items += 1; w.units = r3(w.units + q); w.value = r2(w.value + q * st.rate);
      const avail = q - (st.reserved.get(gid) || 0);
      if (st.item.reorder_level > 0 && avail <= st.item.reorder_level) w.low += 1;
    }
  }
  if (!canSeeValue(user)) rows.forEach((r) => delete r.value);
  return rows;
}

function cleanWarehouse(b) {
  const o = {};
  o.name = cleanName(b.name, 'Warehouse name');
  const code = String(b.code || '').trim().toUpperCase(); if (code && !/^[A-Z0-9\-]{2,12}$/.test(code)) throw bad('Code must be 2–12 letters, digits or dashes.'); if (code) o.code = code; // an edit that leaves the code out keeps the existing one
  for (const k of ['address', 'city', 'contact_name', 'phone', 'email', 'location']) o[k] = b[k] === undefined ? undefined : (String(b[k] || '').trim().slice(0, 200) || null);
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw bad('Enter a valid e-mail address.');
  if (o.phone && !/^[0-9+()\-\s]{6,20}$/.test(o.phone)) throw bad('Enter a valid phone number.');
  return o;
}
async function saveWarehouse(id, b, user) {
  const c = cleanWarehouse(b);
  return withTransaction(async () => {
    if (await get('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE AND id != ?', [c.name, id || 0])) throw bad(`A warehouse named "${c.name}" already exists.`, 409);
    if (c.code && (await get('SELECT id FROM godowns WHERE code = ? AND id != ?', [c.code, id || 0]))) throw bad(`Code ${c.code} is already used.`, 409);
    let rid = id;
    if (id) {
      const sets = Object.keys(c).filter((k) => c[k] !== undefined);
      if (!(await run(`UPDATE godowns SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => c[k]), id])).changes) throw bad('Warehouse not found.', 404);
    } else {
      rid = (await run('INSERT INTO godowns (name, location, is_active, code, address, city, contact_name, phone, email) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)', [c.name, c.location || c.city || null, c.code || null, c.address || null, c.city || null, c.contact_name || null, c.phone || null, c.email || null])).lastID;
      if (!c.code) await run('UPDATE godowns SET code = ? WHERE id = ?', [`WH-${String(rid).padStart(2, '0')}`, rid]);
    }
    await logActivity({ user, action: id ? 'INV_WAREHOUSE_UPDATE' : 'INV_WAREHOUSE_CREATE', entity: 'godown', entityId: rid, details: { name: c.name } });
    return rid;
  }).then(async (rid) => (await listWarehouses(user)).find((w) => w.id === rid));
}
async function setWarehouseActive(id, active, user) {
  return withTransaction(async () => {
    const g = await get('SELECT id, name, is_active FROM godowns WHERE id = ?', [id]);
    if (!g) throw bad('Warehouse not found.', 404);
    if (!active) {
      if ((await get('SELECT COUNT(*) c FROM godowns WHERE is_active = 1 AND id != ?', [id])).c === 0) throw bad('The last active warehouse cannot be archived.', 409);
      const { by } = await stockState();
      const left = [...by.values()].filter((st) => (st.perGodown.get(id) || 0) > 0).length;
      if (left) throw bad(`${g.name} still holds stock of ${left} item(s). Transfer or adjust it first.`, 409);
    }
    await run('UPDATE godowns SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
    await logActivity({ user, action: active ? 'INV_WAREHOUSE_RESTORE' : 'INV_WAREHOUSE_ARCHIVE', entity: 'godown', entityId: id });
  }).then(async () => (await listWarehouses(user)).find((w) => w.id === id));
}
async function warehouseDetail(id, user) {
  const w = (await listWarehouses(user)).find((x) => x.id === id);
  if (!w) throw bad('Warehouse not found.', 404);
  const { by } = await stockState();
  w.stock = [...by.values()].map((st) => {
    const q = st.perGodown.get(id) || 0; if (q === 0 && !st.reserved.get(id)) return null;
    const rs = st.reserved.get(id) || 0, row = { id: st.item.id, name: st.item.name, sku: st.item.sku, uom: st.item.uom, on_hand: r3(q), reserved: r3(rs), available: r3(q - rs), reorder_level: st.item.reorder_level || 0, status: statusOf(q - rs, st.item.reorder_level || 0) };
    if (canSeeValue(user)) row.value = r2(Math.max(q, 0) * st.rate);
    return row;
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  w.recent = (await movements({ warehouse: id, page_size: 10 }, user)).items;
  return w;
}

// ---------------------------------------------------------------------------------------------------- movement history
async function movements(q, user) {
  const where = [], p = [];
  const dg = await defaultGodown();
  if (q.item) { where.push('ie.stock_item_id = ?'); p.push(parseInt(q.item, 10)); }
  if (q.warehouse) { where.push('COALESCE(ie.godown_id, ?) = ?'); p.push(dg, parseInt(q.warehouse, 10)); }
  if (q.type) { where.push('v.voucher_type = ?'); p.push(String(q.type)); }
  if (q.direction === 'IN' || q.direction === 'OUT') { where.push('ie.direction = ?'); p.push(q.direction); }
  if (q.from && ISO.test(q.from)) { where.push('v.date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('v.date <= ?'); p.push(q.to); }
  if (q.q) { const n = `%${String(q.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`; where.push("(s.name LIKE ? ESCAPE '\\' OR s.sku LIKE ? ESCAPE '\\' OR v.voucher_no LIKE ? ESCAPE '\\')"); p.push(n, n, n); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id JOIN stock_items s ON s.id = ie.stock_item_id LEFT JOIN godowns g ON g.id = COALESCE(ie.godown_id, ${dg}) ${W}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c;
  const pg = page(q, total);
  const rows = await all(`SELECT ie.id, v.id AS voucher_id, v.date, v.voucher_type AS type, v.voucher_no AS number, v.narration, ie.stock_item_id AS item_id, s.name AS item, s.sku,
      COALESCE(ie.godown_id, ${dg}) AS warehouse_id, g.name AS warehouse, ie.direction, ie.quantity, ie.rate, ie.amount
      ${base} ORDER BY v.date DESC, ie.id DESC LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  const seeValue = canSeeValue(user);
  const items = rows.map((r) => { const o = { ...r, qty_signed: r.direction === 'IN' ? r.quantity : -r.quantity }; if (!seeValue) { delete o.rate; delete o.amount; } return o; });
  const out = { items, page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
  // a running balance is only meaningful for one item in one warehouse
  if (q.item && q.warehouse) {
    const gid = parseInt(q.warehouse, 10), all_ = await all(`SELECT ie.id, ie.direction, ie.quantity FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id WHERE ie.stock_item_id = ? AND COALESCE(ie.godown_id, ${dg}) = ? ORDER BY v.date, ie.id`, [parseInt(q.item, 10), gid]);
    let bal = gid === dg ? ((await get('SELECT opening_qty FROM stock_items WHERE id = ?', [parseInt(q.item, 10)])) || {}).opening_qty || 0 : 0; const at = new Map();
    for (const e of all_) { bal += e.direction === 'IN' ? e.quantity : -e.quantity; at.set(e.id, r3(bal)); }
    for (const it of out.items) it.balance = at.get(it.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- stock levels
async function stockLevels(q, user) {
  const { by } = await stockState();
  const gods = await all('SELECT id, name FROM godowns');
  const gname = new Map(gods.map((g) => [g.id, g.name]));
  const needle = String(q.q || '').trim().toLowerCase();
  let rows = [];
  for (const st of by.values()) {
    if (!st.item.is_active) continue;
    for (const [gid, qty] of st.perGodown) {
      const rs = st.reserved.get(gid) || 0; if (qty === 0 && rs === 0) continue;
      if (q.warehouse && String(gid) !== String(q.warehouse)) continue;
      const avail = r3(qty - rs), row = { item_id: st.item.id, item: st.item.name, sku: st.item.sku, uom: st.item.uom, warehouse_id: gid, warehouse: gname.get(gid) || `#${gid}`, on_hand: r3(qty), reserved: r3(rs), available: avail, reorder_level: st.item.reorder_level || 0, status: statusOf(avail, st.item.reorder_level || 0) };
      if (canSeeValue(user)) row.value = r2(Math.max(qty, 0) * st.rate);
      rows.push(row);
    }
  }
  if (needle) rows = rows.filter((r) => r.item.toLowerCase().includes(needle) || String(r.sku || '').toLowerCase().includes(needle));
  if (q.status && ['ok', 'low', 'out'].includes(q.status)) rows = rows.filter((r) => r.status === q.status);
  rows.sort((a, b) => a.item.localeCompare(b.item) || a.warehouse.localeCompare(b.warehouse));
  const pg = page(q, rows.length);
  return { items: rows.slice(pg.offset, pg.offset + pg.page_size), page: pg.page, page_size: pg.page_size, pages: pg.pages, total: pg.total };
}

// ---------------------------------------------------------------------------------------------------- stock documents (transfers and adjustments)
async function nextNumber(prefix) {
  const r = await get('SELECT number FROM inv_docs WHERE number LIKE ? ORDER BY id DESC LIMIT 1', [`${prefix}-%`]);
  const n = r ? parseInt(r.number.split('-')[1], 10) + 1 : 1;
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

function cleanLines(lines, withDelta) {
  if (!Array.isArray(lines) || !lines.length) throw bad('Add at least one line.');
  if (lines.length > 100) throw bad('A document can have at most 100 lines.');
  const seen = new Set();
  return lines.map((l, i) => {
    const item = parseInt(l.item_id, 10); if (!item) throw bad(`Line ${i + 1}: choose an item.`);
    if (seen.has(item)) throw bad(`Line ${i + 1}: the same item appears twice.`); seen.add(item);
    if (withDelta) {
      const hasNew = l.new_qty !== undefined && l.new_qty !== null && l.new_qty !== '';
      const v = Number(hasNew ? l.new_qty : l.delta);
      if (!Number.isFinite(v) || Math.abs(v) > 1e9 || (!hasNew && v === 0)) throw bad(`Line ${i + 1}: enter a ${hasNew ? 'counted quantity of zero or more' : 'non-zero change'}.`);
      if (hasNew && v < 0) throw bad(`Line ${i + 1}: the counted quantity cannot be negative.`);
      return { item, ...(hasNew ? { newQty: r3(v) } : { delta: r3(v) }) };
    }
    const qty = Number(l.qty); if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw bad(`Line ${i + 1}: quantity must be more than zero.`);
    return { item, qty: r3(qty) };
  });
}

function checkDate(d) { const x = d || today(); if (!ISO.test(x) || Number.isNaN(Date.parse(x))) throw bad('Date must be YYYY-MM-DD.'); return x; }

async function activeGodown(id, label) {
  const g = await get('SELECT id, name, is_active FROM godowns WHERE id = ?', [parseInt(id, 10) || 0]);
  if (!g) throw bad(`${label} not found.`, 404);
  if (!g.is_active) throw bad(`${g.name} is archived.`, 422);
  return g;
}

async function docLines(voucherId) {
  const dg = await defaultGodown();
  return all(`SELECT ie.stock_item_id AS item_id, s.name AS item, s.sku, u.symbol AS uom, ie.direction, ie.quantity, ie.rate, ie.amount, COALESCE(ie.godown_id, ${dg}) AS warehouse_id, g.name AS warehouse
              FROM inventory_entries ie JOIN stock_items s ON s.id = ie.stock_item_id JOIN units_of_measure u ON u.id = s.uom_id LEFT JOIN godowns g ON g.id = COALESCE(ie.godown_id, ${dg})
              WHERE ie.voucher_id = ? ORDER BY ie.id`, [voucherId]);
}

/** Moves stock between two warehouses. All-or-nothing; refuses to take more than is available. Value-neutral. */
async function createTransfer(b, user) {
  const lines = cleanLines(b.lines, false), date = checkDate(b.date), note = String(b.note || '').trim().slice(0, 300);
  return withTransaction(async () => {
    const from = await activeGodown(b.from_warehouse_id, 'Source warehouse'), to = await activeGodown(b.to_warehouse_id, 'Destination warehouse');
    if (from.id === to.id) throw bad('Choose two different warehouses.');
    const number = await nextNumber('TR');
    const prepared = [];
    for (const l of lines) {
      const { by } = await stockState({ itemId: l.item });
      const st = by.get(l.item);
      if (!st) throw bad('An item on this transfer no longer exists.', 404);
      if (!st.item.is_active) throw bad(`${st.item.name} is archived.`, 422);
      const avail = r3((st.perGodown.get(from.id) || 0) - (st.reserved.get(from.id) || 0));
      if (l.qty > avail) throw bad(`Not enough ${st.item.name} in ${from.name}: ${avail} available, ${l.qty} requested.`, 409);
      prepared.push({ ...l, rate: r2(st.rate), name: st.item.name });
    }
    const total = r2(prepared.reduce((t, l) => t + l.qty * l.rate, 0));
    const v = await run(`INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, total_amount) VALUES ('Stock Journal', ?, ?, ?, ?, ?)`,
      [number, date, 'TRANSFER', `Transfer ${from.name} → ${to.name}${note ? ' — ' + note : ''}`, total]);
    for (const l of prepared) {
      await run('INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.lastID, l.item, 'OUT', l.qty, l.rate, r2(l.qty * l.rate), from.id]);
      await run('INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.lastID, l.item, 'IN', l.qty, l.rate, r2(l.qty * l.rate), to.id]);
    }
    const d = await run('INSERT INTO inv_docs (kind, number, voucher_id, from_godown_id, to_godown_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', ['transfer', number, v.lastID, from.id, to.id, note || null, user.username]);
    await logActivity({ user, action: 'INV_TRANSFER', entity: 'inv_doc', entityId: d.lastID, details: { number, from: from.name, to: to.name, lines: prepared.length } });
    return d.lastID;
  }).then((id) => getDoc(id, user));
}

/** Corrects stock in one warehouse (count correction, damage, found stock...). Each line is a change or a counted quantity. */
async function createAdjustment(b, user) {
  const reason = String(b.reason || '').trim();
  if (!ADJUSTMENT_REASONS.includes(reason)) throw bad(`Choose a reason: ${ADJUSTMENT_REASONS.join(', ')}.`);
  const lines = cleanLines(b.lines, true), date = checkDate(b.date), note = String(b.note || '').trim().slice(0, 300);
  return withTransaction(async () => {
    const wh = await activeGodown(b.warehouse_id, 'Warehouse');
    const number = await nextNumber('ADJ');
    const prepared = [];
    for (const l of lines) {
      const { by } = await stockState({ itemId: l.item });
      const st = by.get(l.item);
      if (!st) throw bad('An item on this adjustment no longer exists.', 404);
      if (!st.item.is_active) throw bad(`${st.item.name} is archived.`, 422);
      const cur = st.perGodown.get(wh.id) || 0;
      const delta = l.newQty !== undefined ? r3(l.newQty - cur) : l.delta;
      if (delta === 0) continue; // counted quantity equals the book quantity: nothing to record
      if (r3(cur + delta) < 0) throw bad(`${st.item.name}: only ${r3(cur)} in ${wh.name}; cannot reduce by ${Math.abs(delta)}.`, 409);
      if (delta < 0 && r3(cur + delta) < (st.reserved.get(wh.id) || 0)) throw bad(`${st.item.name}: the remaining quantity would be below what is reserved for open orders.`, 409);
      prepared.push({ item: l.item, delta, rate: r2(st.rate), name: st.item.name });
    }
    if (!prepared.length) throw bad('Nothing to adjust: every counted quantity already matches the books.');
    const total = r2(prepared.reduce((t, l) => t + Math.abs(l.delta) * l.rate, 0));
    const v = await run(`INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, total_amount) VALUES ('Stock Journal', ?, ?, ?, ?, ?)`,
      [number, date, 'ADJUSTMENT', `Stock adjustment (${reason}) in ${wh.name}${note ? ' — ' + note : ''}`, total]);
    for (const l of prepared) await run('INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [v.lastID, l.item, l.delta > 0 ? 'IN' : 'OUT', Math.abs(l.delta), l.rate, r2(Math.abs(l.delta) * l.rate), wh.id]);
    const d = await run('INSERT INTO inv_docs (kind, number, voucher_id, to_godown_id, reason, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', ['adjustment', number, v.lastID, wh.id, reason, note || null, user.username]);
    await logActivity({ user, action: 'INV_ADJUSTMENT', entity: 'inv_doc', entityId: d.lastID, details: { number, warehouse: wh.name, reason, lines: prepared.length } });
    return d.lastID;
  }).then((id) => getDoc(id, user));
}

async function getDoc(id, user) {
  const d = await get(`SELECT d.*, v.date, v.total_amount, fg.name AS from_name, tg.name AS to_name FROM inv_docs d JOIN vouchers v ON v.id = d.voucher_id
                       LEFT JOIN godowns fg ON fg.id = d.from_godown_id LEFT JOIN godowns tg ON tg.id = d.to_godown_id WHERE d.id = ?`, [id]);
  if (!d) throw bad('Document not found.', 404);
  const lines = await docLines(d.voucher_id);
  const see = canSeeValue(user);
  return { id: d.id, kind: d.kind, number: d.number, date: d.date, reason: d.reason, note: d.note, from_warehouse: d.from_name, to_warehouse: d.to_name, created_by: d.created_by, created_at: d.created_at,
    ...(see ? { value: d.total_amount } : {}), lines: lines.map((l) => (see ? l : { ...l, rate: undefined, amount: undefined })) };
}

async function listDocs(kind, q, user) {
  const where = ['d.kind = ?'], p = [kind];
  if (q.q) { where.push("(d.number LIKE ? ESCAPE '\\' OR d.note LIKE ? ESCAPE '\\')"); const n = `%${String(q.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`; p.push(n, n); }
  if (q.warehouse) { where.push('(d.from_godown_id = ? OR d.to_godown_id = ?)'); p.push(parseInt(q.warehouse, 10), parseInt(q.warehouse, 10)); }
  if (q.from && ISO.test(q.from)) { where.push('v.date >= ?'); p.push(q.from); }
  if (q.to && ISO.test(q.to)) { where.push('v.date <= ?'); p.push(q.to); }
  const base = `FROM inv_docs d JOIN vouchers v ON v.id = d.voucher_id LEFT JOIN godowns fg ON fg.id = d.from_godown_id LEFT JOIN godowns tg ON tg.id = d.to_godown_id WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) c ${base}`, p)).c, pg = page(q, total);
  const rows = await all(`SELECT d.id, d.number, v.date, d.reason, d.note, d.created_by, fg.name AS from_warehouse, tg.name AS to_warehouse, v.total_amount AS value,
      (SELECT COUNT(DISTINCT stock_item_id) FROM inventory_entries WHERE voucher_id = d.voucher_id) AS lines ${base} ORDER BY v.date DESC, d.id DESC LIMIT ? OFFSET ?`, [...p, pg.page_size, pg.offset]);
  if (!canSeeValue(user)) rows.forEach((r) => delete r.value);
  return { items: rows, page: pg.page, page_size: pg.page_size, pages: pg.pages, total };
}

// ---------------------------------------------------------------------------------------------------- alerts and dashboard
async function alerts(user, limit = 100) {
  const { by } = await stockState();
  const rows = [...by.values()].filter((st) => st.item.is_active).map((st) => itemRow(st, user)).filter((r) => r.status !== 'ok' && (r.reorder_level > 0 || r.on_hand > 0 || r.status === 'out' && r.reorder_level > 0));
  rows.sort((a, b) => (a.status === 'out' ? 0 : 1) - (b.status === 'out' ? 0 : 1) || a.available - b.available);
  const trimmed = rows.map((r) => ({ ...r, shortfall: r.reorder_level > 0 ? r3(Math.max(0, r.reorder_level - r.available)) : 0 }));
  return { total: trimmed.length, out: trimmed.filter((r) => r.status === 'out').length, low: trimmed.filter((r) => r.status === 'low').length, items: trimmed.slice(0, limit) };
}

async function dashboard(user) {
  const { by } = await stockState();
  const active = [...by.values()].filter((st) => st.item.is_active), rows = active.map((st) => itemRow(st, user));
  const seeValue = canSeeValue(user);
  const k = { items: rows.length, low: rows.filter((r) => r.status === 'low').length, out: rows.filter((r) => r.status === 'out' && r.reorder_level > 0).length, units: r3(rows.reduce((t, r) => t + Math.max(r.on_hand, 0), 0)) };
  if (seeValue) k.stock_value = r2(rows.reduce((t, r) => t + (r.value || 0), 0));
  const whs = await listWarehouses(user); k.warehouses = whs.filter((w) => w.is_active).length;
  const dg = await defaultGodown();
  const series = await all(`SELECT v.date AS d, SUM(CASE WHEN ie.direction = 'IN' THEN ie.quantity ELSE 0 END) AS qin, SUM(CASE WHEN ie.direction = 'OUT' THEN ie.quantity ELSE 0 END) AS qout
    FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id WHERE v.date >= date((SELECT COALESCE(MAX(date), date('now')) FROM vouchers), '-29 days') GROUP BY v.date ORDER BY v.date`);
  const cats = new Map();
  for (const r of rows) { const c = cats.get(r.category) || { name: r.category, items: 0, value: 0, units: 0 }; c.items++; c.units = r3(c.units + Math.max(r.on_hand, 0)); c.value = r2(c.value + (r.value || 0)); cats.set(r.category, c); }
  return {
    kpis: k, series, warehouses: whs.filter((w) => w.is_active).map((w) => ({ id: w.id, name: w.name, items: w.items, units: w.units, low: w.low, ...(seeValue ? { value: w.value } : {}) })),
    categories: [...cats.values()].sort((a, b) => b.units - a.units).slice(0, 8), low_stock: (await alerts(user, 6)).items,
    recent: (await movements({ page_size: 8 }, user)).items, default_warehouse_id: dg
  };
}

module.exports = {
  listItems, itemDetail, createItem, updateItem, setArchived, deleteItem, listCategories, saveCategory, deleteCategory, listUnits, saveUnit, deleteUnit,
  listWarehouses, saveWarehouse, setWarehouseActive, warehouseDetail, movements, stockLevels, createTransfer, createAdjustment, getDoc, listDocs, alerts, dashboard,
  ADJUSTMENT_REASONS, stockState
};

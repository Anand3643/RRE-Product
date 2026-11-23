/**
 * RRE Tally — inventory suite, stage 3: one-time import of an existing StockPilot database.
 *
 * Safety rules:
 *  - The StockPilot file is opened READ-ONLY and never changed.
 *  - Nothing is written until the person has seen the preview and confirmed.
 *  - Records that already exist in RRE (same name, GSTIN) are matched, not duplicated.
 *  - Every imported record is remembered (inv_import_map), so running the import again adds nothing twice.
 *  - Stock goes in as ordinary stock adjustments (reason "Opening balance fix"), so it appears in the movement history and the books.
 *  - Only the Owner may run it. Orders, payments and user accounts are NOT imported (reported with the reason).
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { get, all, run } = require('./db');
const { withTransaction } = require('./tx');
const { logActivity } = require('./auth');
const inv = require('./invCore');
const ord = require('./invOrders');

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const today = () => new Date().toISOString().slice(0, 10);
const LIST_CAP = 40;
let running = false;

const STATE_CODES = { 'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06', delhi: '07', rajasthan: '08', 'uttar pradesh': '09', bihar: '10', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24', maharashtra: '27', 'andhra pradesh': '37', karnataka: '29', goa: '30', kerala: '32', 'tamil nadu': '33', puducherry: '34', telangana: '36' };
const UNIT_ALIASES = { pcs: ['NOS', 'PCS'], pc: ['NOS', 'PCS'], piece: ['NOS', 'PCS'], pieces: ['NOS', 'PCS'], nos: ['NOS'], unit: ['NOS'], units: ['NOS'], kg: ['KGS', 'KG'], kgs: ['KGS', 'KG'], litre: ['LTR', 'LTRS'], liter: ['LTR', 'LTRS'], ltr: ['LTR', 'LTRS'], meter: ['MTR', 'MTRS'], metre: ['MTR', 'MTRS'], mtr: ['MTR', 'MTRS'], box: ['BOX'], set: ['SET'], pair: ['PAIR'] };
const DECIMAL_UNITS = new Set(['KG', 'KGS', 'LTR', 'LTRS', 'MTR', 'MTRS', 'G', 'ML']);

// ---------------------------------------------------------------------------------------------------- the source file
function detect() {
  const rel = ['inventory', 'backend', 'stockpilot.db'];
  const cands = [path.resolve(__dirname, '..', '..', ...rel), path.resolve(__dirname, '..', '..', '..', ...rel), path.resolve(__dirname, '..', ...rel)];
  return [...new Set(cands)].filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }).map((f) => ({ path: f, size_mb: Math.round((fs.statSync(f).size / 1048576) * 10) / 10 }));
}

function openSource(file) {
  const f = path.resolve(String(file || ''));
  if (!file || !/\.(db|sqlite|sqlite3)$/i.test(f)) throw bad('Choose a StockPilot database file (it ends in .db).');
  let st; try { st = fs.statSync(f); } catch (e) { throw bad('That file was not found.', 404); }
  if (!st.isFile() || st.size > 3e9) throw bad('That is not a usable database file.');
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(f, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(bad('The file could not be opened as a database.'));
      const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
      q("SELECT name FROM sqlite_master WHERE type = 'table'").then((t) => {
        const names = new Set(t.map((x) => x.name));
        for (const need of ['organizations', 'products', 'warehouses', 'stock_balances']) if (!names.has(need)) { db.close(); return reject(bad('That does not look like a StockPilot database (missing the table "' + need + '").')); }
        resolve({ q, names, close: () => db.close(), file: f });
      }).catch(() => { db.close(); reject(bad('That file is not a readable SQLite database.')); });
    });
  });
}

async function tableRows(src, table, orgId, extra = '') {
  if (!src.names.has(table)) return [];
  const cols = (await src.q(`PRAGMA table_info(${table})`)).map((c) => c.name);
  return src.q(`SELECT * FROM ${table} ${cols.includes('org_id') ? 'WHERE org_id = ?' : ''} ${extra}`, cols.includes('org_id') ? [orgId] : []);
}
const count = async (src, table, orgId) => (src.names.has(table) ? (await tableRows(src, table, orgId)).length : 0);

// ---------------------------------------------------------------------------------------------------- planning (read-only)
const srcKey = (orgId) => `stockpilot:${orgId}`;
const mapped = async (source, kind, id) => (await get('SELECT rre_id FROM inv_import_map WHERE source = ? AND kind = ? AND src_id = ?', [source, kind, id]))?.rre_id ?? null;
const clean = (s, max) => { const v = String(s == null ? '' : s).trim().slice(0, max); return v || null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function stateCode(gstin, stateName) {
  if (gstin && /^\d{2}/.test(gstin)) return gstin.slice(0, 2);
  return STATE_CODES[String(stateName || '').trim().toLowerCase()] || null;
}

async function buildPlan(src, orgId) {
  const source = srcKey(orgId);
  const [cats, prods, whs, bals, custs, vends] = await Promise.all(['categories', 'products', 'warehouses', 'stock_balances', 'customers', 'vendors'].map((t) => tableRows(src, t, orgId)));
  const plan = { source, categories: [], units: [], warehouses: [], products: [], parties: [], stock: [], warnings: [], not_imported: [] };

  const catById = new Map(cats.map((c) => [c.id, c]));
  const catNames = new Set(cats.map((c) => String(c.name).trim()).filter(Boolean));
  if (prods.some((p) => !p.category_id || !catById.has(p.category_id))) catNames.add('Imported Items');
  for (const name of catNames) plan.categories.push({ name, status: (await get('SELECT id FROM stock_groups WHERE name = ? COLLATE NOCASE', [name])) ? 'exists' : 'new' });

  const units = [...new Set(prods.map((p) => String(p.unit || 'pcs').trim() || 'pcs'))];
  for (const u of units) plan.units.push({ unit: u, status: (await findUnit(u)) ? 'exists' : 'new' });

  for (const w of whs) {
    const name = clean(w.name, 60);
    if (!name) { plan.warehouses.push({ src_id: w.id, name: String(w.name), status: 'invalid', reason: 'No name.' }); continue; }
    const prior = await mapped(source, 'warehouse', w.id), ex = await get('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE', [name]);
    plan.warehouses.push({ src_id: w.id, name, code: clean(w.code, 12), city: clean(w.city, 80), address: clean(w.address, 200), contact_name: clean(w.contact_name, 80), phone: clean(w.phone, 20), email: clean(w.email, 100), archived: w.is_active === 0, status: prior ? 'imported' : ex ? 'exists' : 'new' });
  }

  const usedSku = new Set(), usedBarcode = new Set();   // codes claimed earlier in this same file, so two StockPilot items cannot collide
  for (const p of prods) {
    const name = clean(p.name, 120), prior = await mapped(source, 'product', p.id);
    if (!name || name.length < 2) { plan.products.push({ src_id: p.id, name: String(p.name || ''), status: 'invalid', reason: 'The name is missing or too short.' }); continue; }
    const byName = await get('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE', [name]);
    const sku = clean(p.sku, 40) ? String(p.sku).trim().toUpperCase().replace(/[^A-Z0-9._\-\/]/g, '-') : null;
    const skuTaken = sku ? (await get('SELECT id FROM stock_items WHERE sku = ?', [sku])) || (usedSku.has(sku) && !prior ? { id: -1 } : null) : null;
    const bc = clean(p.barcode, 32), bcTaken = bc ? (await get('SELECT id FROM stock_items WHERE barcode = ?', [bc])) || (usedBarcode.has(bc) && !prior ? { id: -1 } : null) : null;
    const hsn = clean(p.hsn_code, 8);
    const rec = { src_id: p.id, name, status: prior ? 'imported' : byName ? 'exists' : 'new', sku: skuTaken || !sku || !/^[A-Z0-9][A-Z0-9._\-\/]{1,39}$/.test(sku) ? null : sku, original_sku: p.sku || null, barcode: bcTaken ? null : bc, brand: clean(p.brand, 60),
      description: clean(p.description, 400), hsn_code: hsn && /^\d{4,8}$/.test(hsn) ? hsn : null, gst_rate: Math.min(100, Math.max(0, num(p.tax_rate ?? p.gst_rate ?? 18))), reorder_level: Math.max(0, num(p.reorder_point)),
      price: Math.max(0, num(p.selling_price)), cost: Math.max(0, num(p.avg_cost) > 0 ? num(p.avg_cost) : num(p.purchase_price)), unit: String(p.unit || 'pcs').trim() || 'pcs', category: catById.get(p.category_id) ? String(catById.get(p.category_id).name).trim() : 'Imported Items',
      archived: !!p.is_archived || p.status === 'inactive' };
    if (rec.sku) usedSku.add(rec.sku); if (rec.barcode) usedBarcode.add(rec.barcode);
    if (skuTaken) rec.note = `SKU ${sku} is already used in RRE, so a new SKU is generated.`;
    if (bcTaken) plan.warnings.push(`"${name}": barcode ${bc} is already used in RRE; the item is imported without a barcode.`);
    if (hsn && !rec.hsn_code) plan.warnings.push(`"${name}": the HSN "${hsn}" is not 4–8 digits and was left out.`);
    if (p.parent_id) plan.warnings.push(`"${name}" is a variant in StockPilot; it is imported as a separate item.`);
    if (rec.status === 'exists') plan.warnings.push(`"${name}" already exists in RRE: it is kept as is and its stock is not imported.`);
    plan.products.push(rec);
  }

  const partyKinds = [['customer', custs], ['vendor', vends]];
  for (const [kind, rows] of partyKinds) for (const c of rows) {
    const name = clean(c.company_name, 120) || clean(c.name, 120);
    if (!name || name.length < 2) { plan.parties.push({ kind, src_id: c.id, name: String(c.name || ''), status: 'invalid', reason: 'The name is missing or too short.' }); continue; }
    const gstin = String(c.gstin || '').trim().toUpperCase(), gstinOk = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
    const prior = await mapped(source, kind, c.id), ex = await get('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE', [name]) || (gstinOk ? await get('SELECT id FROM ledgers WHERE gstin = ?', [gstin]) : null);
    const email = clean(c.email, 100), phone = clean(c.phone, 20);
    plan.parties.push({ kind, src_id: c.id, name, status: prior ? 'imported' : ex ? 'exists' : 'new', gstin: gstinOk ? gstin : null, email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null, phone: phone && /^[0-9+()\-\s]{6,20}$/.test(phone) ? phone : null,
      address: clean(c.bill_address, 250), city: clean(c.bill_city, 80), state: clean(c.bill_state, 60), state_code: stateCode(gstinOk ? gstin : null, c.bill_state), credit_period: Math.min(365, Math.max(0, Math.round(num(c.payment_terms ?? 30)))),
      credit_limit: kind === 'customer' ? Math.max(0, num(c.credit_limit)) : 0, contact_name: clean(c.contact_person, 80) || (c.company_name ? clean(c.name, 80) : null), payment_terms: kind === 'vendor' ? clean(c.payment_terms ? `Net ${c.payment_terms}` : '', 120) : null, notes: clean(c.notes, 400), archived: c.status === 'inactive' });
    if (gstin && !gstinOk) plan.warnings.push(`"${name}": the GSTIN "${gstin}" is not valid and was left out.`);
    if (ex && !prior) plan.warnings.push(`"${name}" already exists in RRE as a ledger: it is kept as is.`);
  }

  const prodById = new Map(plan.products.map((p) => [p.src_id, p])), whById = new Map(plan.warehouses.map((w) => [w.src_id, w]));
  for (const b of bals) {
    const p = prodById.get(b.product_id), w = whById.get(b.warehouse_id), onHand = num(b.on_hand);
    if (num(b.reserved) > 0) plan.warnings.push(`${num(b.reserved)} unit(s) of "${p ? p.name : '#' + b.product_id}" are reserved in StockPilot for open orders; orders are not imported, so nothing is reserved in RRE.`);
    if (onHand <= 0 || !p || !w || p.status === 'invalid' || w.status === 'invalid') continue;
    if (p.status === 'exists') continue;
    plan.stock.push({ product: p.src_id, warehouse: b.warehouse_id, name: p.name, warehouse_name: w.name, qty: onHand });
  }

  const skip = [['sales_orders', 'Sales orders', 'RRE sales orders post vouchers and reserve stock; old orders are not recreated. Open ones should be raised again in RRE.'], ['purchase_orders', 'Purchase orders', 'Receiving goods posts a voucher in RRE, so past orders are not recreated.'], ['payments', 'Payments', 'Payments belong to the accounts: enter them as RRE Receipt/Payment vouchers.'],
    ['shipments', 'Shipments', 'RRE does not track shipments.'], ['goods_receipts', 'Goods receipts', 'Not imported (see purchase orders).'], ['support_tickets', 'Support tickets', 'RRE has no ticket module.']];
  for (const [t, label, why] of skip) { const n = await count(src, t, orgId); if (n) plan.not_imported.push({ what: label, count: n, reason: why }); }
  const users = await count(src, 'users', orgId);
  if (users) plan.not_imported.push({ what: 'User accounts', count: users, reason: 'Passwords cannot be moved between the two programs and RRE has its own roles. Create the people under Users & Passwords.' });
  return plan;
}

async function findUnit(u) {
  const cands = [u, ...(UNIT_ALIASES[String(u).toLowerCase()] || [])];
  for (const c of cands) { const r = await get('SELECT id FROM units_of_measure WHERE symbol = ? COLLATE NOCASE OR formal_name = ? COLLATE NOCASE', [c, c]); if (r) return r.id; }
  return null;
}

const summarise = (plan) => {
  const by = (arr) => ({ total: arr.length, new: arr.filter((x) => x.status === 'new').length, exists: arr.filter((x) => x.status === 'exists').length, imported: arr.filter((x) => x.status === 'imported').length, invalid: arr.filter((x) => x.status === 'invalid').length });
  return { categories: by(plan.categories), units: by(plan.units), warehouses: by(plan.warehouses), items: by(plan.products), customers: by(plan.parties.filter((p) => p.kind === 'customer')), suppliers: by(plan.parties.filter((p) => p.kind === 'vendor')),
    stock_lines: plan.stock.length, stock_units: Math.round(plan.stock.reduce((t, s) => t + s.qty, 0) * 1000) / 1000 };
};

async function preview(file, orgId) {
  const src = await openSource(file);
  try {
    const orgs = await src.q('SELECT id, name FROM organizations ORDER BY id');
    const withCounts = [];
    for (const o of orgs) withCounts.push({ id: o.id, name: o.name, items: await count(src, 'products', o.id), warehouses: await count(src, 'warehouses', o.id), customers: await count(src, 'customers', o.id), suppliers: await count(src, 'vendors', o.id) });
    if (!orgId) return { step: 'choose_organisation', file: src.file, organisations: withCounts };
    const id = parseInt(orgId, 10);
    if (!withCounts.some((o) => o.id === id)) throw bad('That organisation is not in the file.', 404);
    const plan = await buildPlan(src, id);
    const cap = (a) => a.slice(0, LIST_CAP);
    return { step: 'preview', file: src.file, organisation: withCounts.find((o) => o.id === id), summary: summarise(plan), items: cap(plan.products), warehouses: plan.warehouses, parties: cap(plan.parties), stock: cap(plan.stock), warnings: cap(plan.warnings), warnings_total: plan.warnings.length, not_imported: plan.not_imported };
  } finally { src.close(); }
}

// ---------------------------------------------------------------------------------------------------- the import
async function remember(source, kind, srcId, rreId, note) {
  await run('INSERT OR REPLACE INTO inv_import_map (source, kind, src_id, rre_id, note) VALUES (?, ?, ?, ?, ?)', [source, kind, srcId, rreId, note || null]);
}

async function importAll(file, orgId, user) {
  if (running) throw bad('An import is already running.', 409);
  running = true;
  const src = await openSource(file).catch((e) => { running = false; throw e; });
  const out = { created: { categories: 0, units: 0, warehouses: 0, items: 0, customers: 0, suppliers: 0, stock_documents: 0 }, matched: { categories: 0, warehouses: 0, items: 0, parties: 0 }, skipped: [], failed: [], warnings: [], not_imported: [] };
  try {
    const orgs = await src.q('SELECT id FROM organizations');
    const id = parseInt(orgId, 10);
    if (!orgs.some((o) => o.id === id)) throw bad('That organisation is not in the file.', 404);
    const plan = await buildPlan(src, id), source = plan.source;
    out.warnings = plan.warnings.slice(0, LIST_CAP); out.not_imported = plan.not_imported;

    // 1. categories, units, warehouses (simple masters, one transaction)
    const catMap = new Map(), unitMap = new Map(), whMap = new Map();
    await withTransaction(async () => {
      for (const c of plan.categories) {
        let r = await get('SELECT id FROM stock_groups WHERE name = ? COLLATE NOCASE', [c.name]);
        if (r) out.matched.categories++; else { r = { id: (await run('INSERT INTO stock_groups (name) VALUES (?)', [c.name])).lastID }; out.created.categories++; }
        catMap.set(c.name.toLowerCase(), r.id);
      }
      for (const u of plan.units) {
        let uid = await findUnit(u.unit);
        if (!uid) { const sym = u.unit.toUpperCase().slice(0, 12); uid = (await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [sym, u.unit.slice(0, 60), DECIMAL_UNITS.has(sym) ? 3 : 0])).lastID; out.created.units++; }
        unitMap.set(u.unit, uid);
      }
      for (const w of plan.warehouses) {
        if (w.status === 'invalid') { out.skipped.push({ kind: 'warehouse', name: w.name, reason: w.reason }); continue; }
        const prior = await mapped(source, 'warehouse', w.src_id);
        let gid = prior || (await get('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE', [w.name]))?.id;
        if (gid) { if (!prior) out.matched.warehouses++; } else {
          const codeTaken = w.code && (await get('SELECT id FROM godowns WHERE code = ?', [w.code.toUpperCase()]));
          gid = (await run('INSERT INTO godowns (name, location, is_active, code, address, city, contact_name, phone, email) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)', [w.name, w.city, codeTaken || !w.code || !/^[A-Za-z0-9\-]{2,12}$/.test(w.code) ? null : w.code.toUpperCase(), w.address, w.city, w.contact_name, w.phone, w.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(w.email) ? w.email : null])).lastID;
          const g = await get('SELECT code FROM godowns WHERE id = ?', [gid]); if (!g.code) await run('UPDATE godowns SET code = ? WHERE id = ?', [`WH-${String(gid).padStart(2, '0')}`, gid]);
          out.created.warehouses++;
        }
        await remember(source, 'warehouse', w.src_id, gid); whMap.set(w.src_id, gid);
      }
    });

    // 2. items (each through the same validation as the Items screen)
    const itemMap = new Map();
    for (const p of plan.products) {
      if (p.status === 'invalid') { out.skipped.push({ kind: 'item', name: p.name, reason: p.reason }); continue; }
      const prior = await mapped(source, 'product', p.src_id);
      if (prior) { itemMap.set(p.src_id, prior); continue; }
      if (p.status === 'exists') { out.matched.items++; continue; }
      try {
        const created = await inv.createItem({ name: p.name, category_id: catMap.get(p.category.toLowerCase()), uom_id: unitMap.get(p.unit), sku: p.sku || undefined, barcode: p.barcode || undefined, brand: p.brand || undefined,
          description: [p.description, p.original_sku && !p.sku ? `StockPilot SKU: ${p.original_sku}` : ''].filter(Boolean).join(' ') || undefined, hsn_code: p.hsn_code || undefined, gst_rate: p.gst_rate, reorder_level: p.reorder_level, standard_price: p.price, standard_cost: p.cost, opening_qty: 0 }, user);
        await remember(source, 'product', p.src_id, created.id); itemMap.set(p.src_id, created.id); out.created.items++;
      } catch (e) { out.failed.push({ kind: 'item', name: p.name, reason: e.message }); }
    }

    // 3. customers and suppliers
    for (const c of plan.parties) {
      const kind = c.kind === 'customer' ? 'customers' : 'suppliers';
      if (c.status === 'invalid') { out.skipped.push({ kind: c.kind, name: c.name, reason: c.reason }); continue; }
      if (c.status === 'imported') continue;
      if (c.status === 'exists') { out.matched.parties++; continue; }
      try {
        const body = { name: c.name, gstin: c.gstin || '', state: c.state || '', state_code: c.state_code || '', address: c.address || '', city: c.city || '', contact_name: c.contact_name || '', phone: c.phone || '', email: c.email || '', credit_period: c.credit_period, notes: c.notes || '' };
        if (c.kind === 'customer') body.credit_limit = c.credit_limit; else body.payment_terms = c.payment_terms || '';
        for (const k of Object.keys(body)) if (body[k] === '' ) delete body[k];
        const saved = await ord.saveParty(c.kind === 'customer' ? 'customer' : 'supplier', null, body, user);
        await remember(source, c.kind, c.src_id, saved.id); out.created[c.kind === 'customer' ? 'customers' : 'suppliers']++;
        if (c.archived) await ord.setPartyActive(c.kind === 'customer' ? 'customer' : 'supplier', saved.id, false, user);
      } catch (e) { out.failed.push({ kind: c.kind, name: c.name, reason: e.message }); }
      void kind;
    }

    // 4. stock on hand, as opening-balance adjustments per warehouse (up to 100 lines each)
    const byWh = new Map();
    for (const s of plan.stock) { const iid = itemMap.get(s.product), gid = whMap.get(s.warehouse); if (!iid || !gid) continue; if (!byWh.has(gid)) byWh.set(gid, { src: s.warehouse, lines: [] }); byWh.get(gid).lines.push({ item_id: iid, delta: s.qty }); }
    for (const [gid, w] of byWh) {
      for (let i = 0; i < w.lines.length; i += 100) {
        const chunk = w.lines.slice(i, i + 100), key = w.src * 100000 + i / 100;
        if (await get('SELECT 1 x FROM inv_import_map WHERE source = ? AND kind = ? AND src_id = ?', [source, 'stock', key])) continue;
        try {
          const doc = await inv.createAdjustment({ warehouse_id: gid, reason: 'Opening balance fix', date: today(), note: 'Imported from StockPilot', lines: chunk }, user);
          await remember(source, 'stock', key, doc.id || null, doc.number); out.created.stock_documents++;
        } catch (e) { out.failed.push({ kind: 'stock', name: `Warehouse #${gid}`, reason: e.message }); }
      }
    }

    // 5. archived records, now that stock is in
    for (const p of plan.products) if (p.archived && itemMap.has(p.src_id) && p.status === 'new') { try { await inv.setArchived(itemMap.get(p.src_id), true, user); } catch (e) { out.warnings.push(`"${p.name}" is archived in StockPilot but still has stock, so it stays active in RRE.`); } }
    for (const w of plan.warehouses) if (w.archived && w.status === 'new' && whMap.has(w.src_id)) { try { await inv.setWarehouseActive(whMap.get(w.src_id), false, user); } catch (e) { out.warnings.push(`Warehouse "${w.name}" is archived in StockPilot but holds stock (or is the last active one), so it stays active in RRE.`); } }

    await logActivity({ user, action: 'INV_IMPORT_STOCKPILOT', entity: 'import', entityId: source, details: { created: out.created, failed: out.failed.length } });
    return out;
  } finally { running = false; src.close(); }
}

module.exports = { detect, preview, importAll, openSource, mapped, remember, clean, num, findUnit, stateCode, srcKey, DECIMAL_UNITS };

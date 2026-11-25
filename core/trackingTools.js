/**
 * RRE Tally — batch, expiry and serial-number tracking (plus barcode lookup).
 *
 * Design: the existing voucher screens are untouched. For items you mark as tracked, you assign batches /
 * serial numbers to the stock lines of POSTED vouchers in a register. Totals are checked against the voucher's
 * quantity, so a batch can never be issued more than was received.
 *
 *   Purchase / Credit Note (sales return)  -> stock IN     Sales / Debit Note (purchase return) -> stock OUT
 */
const { run, get, all } = require('./db');
const { withTransaction } = require('./tx');
const { logActivity } = require('./auth');

const EPS = 0.0005;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,39}$/;
const BARCODE_RE = /^[A-Za-z0-9._-]{4,64}$/;
const bad = (m, s = 400, details) => { const e = new Error(m); e.status = s; if (details) e.details = details; return e; };
const todayIso = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const validDate = (d) => ISO.test(d || '') && !Number.isNaN(Date.parse(d));

async function getEntry(entryId) {
  const e = await get(`
    SELECT i.id, i.stock_item_id AS item_id, i.direction, i.quantity, v.voucher_type, v.date, v.voucher_no, v.id AS voucher_id,
           s.name AS item, s.track_batches, s.has_expiry, s.track_serials
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.stock_item_id WHERE i.id = ?`, [entryId]);
  if (!e) throw bad('Stock line not found.', 404);
  return e;
}

// ---------------------------------------------------------------- item settings & barcode
async function setItemSettings(itemId, b, user) {
  const item = await get('SELECT id, name, track_batches, has_expiry, track_serials, barcode FROM stock_items WHERE id = ?', [itemId]);
  if (!item) throw bad('Stock item not found.', 404);
  const flag = (v, cur) => (v === undefined ? cur : v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : (() => { throw bad('Flags must be true or false.'); })());
  const batches = flag(b.track_batches, item.track_batches), expiry = flag(b.has_expiry, item.has_expiry), serials = flag(b.track_serials, item.track_serials);
  if (expiry && !batches) throw bad('Expiry tracking needs batch tracking to be on.');
  let barcode = item.barcode;
  if (b.barcode !== undefined) {
    const raw = b.barcode === null ? '' : String(b.barcode).trim();
    if (raw && !BARCODE_RE.test(raw)) throw bad('Barcode must be 4–64 characters: letters, digits, dot, dash or underscore.');
    if (raw) {
      const other = await get('SELECT id, name FROM stock_items WHERE lower(barcode) = lower(?) AND id <> ?', [raw, itemId]);
      if (other) throw bad(`Barcode "${raw}" is already used by "${other.name}".`, 409);
    }
    barcode = raw || null;
  }
  await run('UPDATE stock_items SET track_batches = ?, has_expiry = ?, track_serials = ?, barcode = ? WHERE id = ?', [batches, expiry, serials, barcode, itemId]);
  await logActivity({ user, action: 'ITEM_TRACKING_SET', entity: 'stock_item', entityId: itemId, details: { name: item.name, batches, expiry, serials, barcode } });
  return { id: itemId, track_batches: batches, has_expiry: expiry, track_serials: serials, barcode };
}

async function listItems() {
  return all(`
    SELECT s.id, s.name, s.track_batches, s.has_expiry, s.track_serials, s.barcode,
      (SELECT COUNT(*) FROM serial_numbers n WHERE n.stock_item_id = s.id AND n.status = 'in_stock') AS serials_in_stock
    FROM stock_items s WHERE s.is_active = 1 ORDER BY s.name`);
}

// ---------------------------------------------------------------- batches
async function batchRemaining(itemId, batchNo, db = { get }) {
  const r = await db.get(`
    SELECT COALESCE(SUM(CASE WHEN i.direction = 'IN' THEN a.qty ELSE -a.qty END), 0) AS rem
    FROM batch_allocations a JOIN inventory_entries i ON i.id = a.inventory_entry_id
    WHERE a.stock_item_id = ? AND a.batch_no = ? COLLATE NOCASE`, [itemId, batchNo]);
  return r3(r.rem);
}

async function allocateBatches(entryId, allocations, user) {
  const e = await getEntry(entryId);
  if (!e.track_batches) throw bad(`Batch tracking is off for "${e.item}". Turn it on in the item's tracking settings first.`);
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 200) throw bad('Provide 1–200 batch lines.');
  const isReturnIn = e.direction === 'IN' && e.voucher_type === 'Credit Note';

  return withTransaction(async () => {
    const already = r3((await get('SELECT COALESCE(SUM(qty),0) s FROM batch_allocations WHERE inventory_entry_id = ?', [entryId])).s);
    const problems = [], plan = [], usedInRequest = new Map();
    let total = 0;
    for (const [i, a] of allocations.entries()) {
      const label = `Line ${i + 1}`;
      const batch = String(a.batch_no || '').trim();
      const qty = Number(a.qty);
      if (!BATCH_RE.test(batch)) { problems.push(`${label}: batch number must be 1–40 characters (letters, digits, space, . _ / -).`); continue; }
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) { problems.push(`${label}: quantity must be a positive number.`); continue; }
      total += qty;
      const existing = await get('SELECT expiry_date FROM batch_allocations WHERE stock_item_id = ? AND batch_no = ? COLLATE NOCASE LIMIT 1', [e.item_id, batch]);
      let expiry = null;
      if (e.direction === 'IN' && !isReturnIn) {
        if (e.has_expiry) {
          expiry = a.expiry_date;
          if (!validDate(expiry)) { problems.push(`${label}: a valid expiry date (YYYY-MM-DD) is required for "${e.item}".`); continue; }
          if (expiry <= e.date) { problems.push(`${label}: expiry ${expiry} must be after the receipt date ${e.date}.`); continue; }
        }
        if (existing && (existing.expiry_date || null) !== (expiry || null)) { problems.push(`${label}: batch "${batch}" already exists with expiry ${existing.expiry_date || '(none)'}; one batch has one expiry date.`); continue; }
      } else {
        if (!existing) { problems.push(`${label}: batch "${batch}" has never been received for "${e.item}".`); continue; }
        expiry = existing.expiry_date;
        if (e.direction === 'OUT') {
          if (e.voucher_type === 'Sales' && expiry && expiry < e.date) { problems.push(`${label}: batch "${batch}" expired on ${expiry}; it cannot be sold on ${e.date}.`); continue; }
          const firstIn = await get(`SELECT MIN(v.date) d FROM batch_allocations a JOIN inventory_entries i ON i.id = a.inventory_entry_id JOIN vouchers v ON v.id = i.voucher_id
                                     WHERE a.stock_item_id = ? AND a.batch_no = ? COLLATE NOCASE AND i.direction = 'IN'`, [e.item_id, batch]);
          if (firstIn && firstIn.d > e.date) { problems.push(`${label}: batch "${batch}" was first received on ${firstIn.d}, after this voucher's date ${e.date}.`); continue; }
          const rem = (await batchRemaining(e.item_id, batch)) - (usedInRequest.get(batch.toLowerCase()) || 0);
          if (qty > rem + EPS) { problems.push(`${label}: batch "${batch}" has only ${rem} in stock; cannot issue ${qty}.`); continue; }
          usedInRequest.set(batch.toLowerCase(), (usedInRequest.get(batch.toLowerCase()) || 0) + qty);
        }
      }
      plan.push({ batch, qty: r3(qty), expiry });
    }
    if (already + total > e.quantity + EPS) problems.push(`Allocations (${r3(already + total)}) exceed the voucher quantity (${e.quantity}).`);
    if (problems.length) throw bad('Nothing was saved. ' + problems.slice(0, 6).join(' '), 400, problems);
    for (const p of plan) {
      await run(`INSERT INTO batch_allocations (inventory_entry_id, stock_item_id, batch_no, expiry_date, qty, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [entryId, e.item_id, p.batch, p.expiry, p.qty, user?.username || 'unknown']);
    }
    await logActivity({ user, action: 'BATCH_ALLOCATE', entity: 'stock_line', entityId: entryId, details: { voucher: e.voucher_no, item: e.item, lines: plan.length } });
    return { saved: plan.length, allocated: r3(already + total), voucher_quantity: e.quantity };
  });
}

async function removeAllocation(id, user) {
  const a = await get(`SELECT a.*, i.direction FROM batch_allocations a JOIN inventory_entries i ON i.id = a.inventory_entry_id WHERE a.id = ?`, [id]);
  if (!a) throw bad('Allocation not found.', 404);
  if (a.direction === 'IN') {
    const rem = await batchRemaining(a.stock_item_id, a.batch_no);
    if (rem - a.qty < -EPS) throw bad(`Batch "${a.batch_no}" has already been issued; ${r3(rem)} remains, so ${a.qty} cannot be removed.`, 409);
  }
  await run('DELETE FROM batch_allocations WHERE id = ?', [id]);
  await logActivity({ user, action: 'BATCH_DEALLOCATE', entity: 'stock_line', entityId: a.inventory_entry_id, details: { batch: a.batch_no, qty: a.qty } });
}

async function listBatches({ item_id, as_of } = {}) {
  if (as_of && !validDate(as_of)) throw bad('as_of must be YYYY-MM-DD.');
  const asOf = as_of || todayIso();
  const rows = await all(`
    SELECT a.stock_item_id AS item_id, s.name AS item, a.batch_no, MAX(a.expiry_date) AS expiry_date,
      SUM(CASE WHEN i.direction = 'IN' THEN a.qty ELSE 0 END) AS received, SUM(CASE WHEN i.direction = 'OUT' THEN a.qty ELSE 0 END) AS issued,
      MIN(CASE WHEN i.direction = 'IN' THEN v.date END) AS first_received
    FROM batch_allocations a JOIN inventory_entries i ON i.id = a.inventory_entry_id JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = a.stock_item_id
    WHERE (? IS NULL OR a.stock_item_id = ?) GROUP BY a.stock_item_id, lower(a.batch_no) ORDER BY s.name, MAX(a.expiry_date) IS NULL, MAX(a.expiry_date), first_received`, [item_id || null, item_id || null]);
  return rows.map((r) => {
    const remaining = r3(r.received - r.issued);
    const days = r.expiry_date ? dayDiff(r.expiry_date, asOf) : null;
    let status = 'ok';
    if (remaining < -EPS) status = 'negative';
    else if (remaining > EPS && days !== null && days < 0) status = 'expired';
    else if (remaining > EPS && days !== null && days <= 30) status = 'expiring';
    else if (remaining <= EPS) status = 'empty';
    return { ...r, received: r3(r.received), issued: r3(r.issued), remaining, days_to_expiry: days, status };
  });
}

async function expiring({ days = 60, as_of } = {}) {
  const d = Math.min(730, Math.max(1, parseInt(days, 10) || 60));
  const all_ = await listBatches({ as_of });
  const rows = all_.filter((b) => b.remaining > EPS && b.days_to_expiry !== null && b.days_to_expiry <= d).sort((a, b) => a.days_to_expiry - b.days_to_expiry);
  return { as_of: as_of || todayIso(), within_days: d, batches: rows, expired_units: r3(rows.filter((b) => b.days_to_expiry < 0).reduce((s, b) => s + b.remaining, 0)) };
}

async function getExpiryAlerts() {
  const out = [];
  for (const b of await listBatches()) {
    if (b.status === 'expired') out.push({ key: `expiry:${b.item_id}:${b.batch_no.toLowerCase()}`, type: 'expiry', severity: 'critical', title: `Expired stock: ${b.item}, batch ${b.batch_no}`,
      message: `${b.remaining} unit(s) expired on ${b.expiry_date} (${-b.days_to_expiry} day(s) ago) and are still on the books.`, view: 'view-stock-summary' });
    else if (b.status === 'expiring') out.push({ key: `expiry:${b.item_id}:${b.batch_no.toLowerCase()}`, type: 'expiry', severity: 'warning', title: `Expiring soon: ${b.item}, batch ${b.batch_no}`,
      message: `${b.remaining} unit(s) expire on ${b.expiry_date} (in ${b.days_to_expiry} day(s)).`, view: 'view-stock-summary' });
  }
  return out;
}

async function fefoSuggestion(entryId) {
  const e = await getEntry(entryId);
  if (e.direction !== 'OUT') throw bad('First-expiry-first-out suggestions apply to stock going out (Sales / Debit Note).');
  if (!e.track_batches) throw bad(`Batch tracking is off for "${e.item}".`);
  const already = r3((await get('SELECT COALESCE(SUM(qty),0) s FROM batch_allocations WHERE inventory_entry_id = ?', [entryId])).s);
  let need = r3(e.quantity - already);
  const batches = (await listBatches({ item_id: e.item_id, as_of: e.date })).filter((b) => b.remaining > EPS && b.first_received <= e.date && !(e.voucher_type === 'Sales' && b.expiry_date && b.expiry_date < e.date));
  const picks = [];
  for (const b of batches) { if (need <= EPS) break; const q = Math.min(b.remaining, need); picks.push({ batch_no: b.batch_no, qty: r3(q), expiry_date: b.expiry_date }); need = r3(need - q); }
  return { entry_id: entryId, voucher: e.voucher_no, item: e.item, quantity: e.quantity, already_allocated: already, suggestion: picks, shortfall: need > EPS ? need : 0,
    method: 'Earliest expiry first (then oldest receipt). Batches received after the voucher date, and batches already expired on the sale date, are excluded. Suggestion only; nothing is saved until you confirm.' };
}

// ---------------------------------------------------------------- serial numbers
async function addSerials(entryId, serials, user) {
  const e = await getEntry(entryId);
  if (!e.track_serials) throw bad(`Serial tracking is off for "${e.item}". Turn it on in the item's tracking settings first.`);
  if (!Array.isArray(serials) || !serials.length || serials.length > 5000) throw bad('Provide 1–5000 serial numbers.');
  const list = serials.map((s) => String(s == null ? '' : s).trim());
  const problems = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || s.length > 60 || /[\u0000-\u001F\u007F]/.test(s)) { problems.push(`"${s.slice(0, 20)}": serial numbers must be 1–60 printable characters.`); continue; }
    const k = s.toLowerCase();
    if (seen.has(k)) problems.push(`"${s}" appears twice in the list.`);
    seen.add(k);
  }
  if (problems.length) throw bad('Nothing was saved. ' + problems.slice(0, 6).join(' '), 400, problems);
  const isReturnIn = e.direction === 'IN' && e.voucher_type === 'Credit Note';
  const col = e.direction === 'IN' ? (isReturnIn ? 'returned_entry_id' : 'in_entry_id') : 'out_entry_id';

  return withTransaction(async () => {
    const linked = (await get(`SELECT COUNT(*) c FROM serial_numbers WHERE ${col} = ? `, [entryId])).c;
    if (linked + list.length > e.quantity + EPS) throw bad(`This line is for ${e.quantity} unit(s); ${linked} serial(s) already recorded, so ${list.length} more would exceed it.`);
    const errs = [];
    for (const s of list) {
      const ex = await get('SELECT * FROM serial_numbers WHERE stock_item_id = ? AND serial_no = ? COLLATE NOCASE', [e.item_id, s]);
      if (e.direction === 'IN' && !isReturnIn) { if (ex) errs.push(`"${s}" already exists (${ex.status}).`); }
      else if (isReturnIn) { if (!ex) errs.push(`"${s}" was never received for this item.`); else if (ex.status !== 'sold') errs.push(`"${s}" is ${ex.status}, not sold; it cannot be returned by a customer.`); }
      else if (!ex) errs.push(`"${s}" was never received for this item.`);
      else if (ex.status !== 'in_stock') errs.push(`"${s}" is not in stock (${ex.status}).`);
    }
    if (errs.length) throw bad('Nothing was saved. ' + errs.slice(0, 6).join(' '), 409, errs);
    for (const s of list) {
      if (e.direction === 'IN' && !isReturnIn) await run(`INSERT INTO serial_numbers (stock_item_id, serial_no, status, in_entry_id, created_by) VALUES (?, ?, 'in_stock', ?, ?)`, [e.item_id, s, entryId, user?.username || 'unknown']);
      else if (isReturnIn) await run(`UPDATE serial_numbers SET status = 'in_stock', out_entry_id = NULL, returned_entry_id = ? WHERE stock_item_id = ? AND serial_no = ? COLLATE NOCASE`, [entryId, e.item_id, s]);
      else await run(`UPDATE serial_numbers SET status = ?, out_entry_id = ? WHERE stock_item_id = ? AND serial_no = ? COLLATE NOCASE`, [e.voucher_type === 'Sales' ? 'sold' : 'returned_out', entryId, e.item_id, s]);
    }
    await logActivity({ user, action: 'SERIAL_RECORD', entity: 'stock_line', entityId: entryId, details: { voucher: e.voucher_no, item: e.item, count: list.length } });
    return { saved: list.length, recorded_on_line: linked + list.length, voucher_quantity: e.quantity };
  });
}

async function removeSerial(id, user) {
  const s = await get('SELECT * FROM serial_numbers WHERE id = ?', [id]);
  if (!s) throw bad('Serial number not found.', 404);
  if (s.status !== 'in_stock' || s.out_entry_id || s.returned_entry_id) throw bad('Only a serial that is still in stock and has not moved can be removed (to correct a typing mistake).', 409);
  await run('DELETE FROM serial_numbers WHERE id = ?', [id]);
  await logActivity({ user, action: 'SERIAL_REMOVE', entity: 'serial', entityId: id, details: { serial: s.serial_no } });
}

async function listSerials({ item_id, status, q } = {}) {
  const where = ['1=1'], p = [];
  if (item_id) { where.push('n.stock_item_id = ?'); p.push(item_id); }
  if (status) { where.push('n.status = ?'); p.push(String(status)); }
  if (q) { where.push("n.serial_no LIKE ? ESCAPE '\\'"); p.push('%' + String(q).slice(0, 60).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  return all(`
    SELECT n.id, n.serial_no, n.status, s.name AS item, n.stock_item_id AS item_id, vin.voucher_no AS received_on, vin.date AS received_date, vout.voucher_no AS issued_on, vout.date AS issued_date
    FROM serial_numbers n JOIN stock_items s ON s.id = n.stock_item_id
    LEFT JOIN inventory_entries ei ON ei.id = n.in_entry_id LEFT JOIN vouchers vin ON vin.id = ei.voucher_id
    LEFT JOIN inventory_entries eo ON eo.id = n.out_entry_id LEFT JOIN vouchers vout ON vout.id = eo.voucher_id
    WHERE ${where.join(' AND ')} ORDER BY s.name, n.serial_no LIMIT 500`, p);
}

async function serialHistory(serialNo, itemId) {
  const rows = await all(`SELECT n.*, s.name AS item FROM serial_numbers n JOIN stock_items s ON s.id = n.stock_item_id WHERE n.serial_no = ? COLLATE NOCASE ${itemId ? 'AND n.stock_item_id = ?' : ''}`, itemId ? [serialNo, itemId] : [serialNo]);
  const out = [];
  for (const n of rows) {
    const ev = [];
    for (const [kind, id] of [['Received', n.in_entry_id], ['Issued', n.out_entry_id], ['Returned by customer', n.returned_entry_id]]) {
      if (!id) continue;
      const x = await get(`SELECT v.voucher_no, v.voucher_type, v.date, p.name AS party FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id WHERE i.id = ?`, [id]);
      if (x) ev.push({ event: kind, ...x });
    }
    out.push({ serial_no: n.serial_no, item: n.item, status: n.status, events: ev.sort((a, b) => a.date.localeCompare(b.date)) });
  }
  return out;
}

// ---------------------------------------------------------------- work list & lookup
async function unallocated({ item_id } = {}) {
  const rows = await all(`
    SELECT i.id AS entry_id, v.voucher_no, v.voucher_type, v.date, i.direction, i.quantity, s.id AS item_id, s.name AS item, s.track_batches, s.has_expiry, s.track_serials,
      COALESCE((SELECT SUM(a.qty) FROM batch_allocations a WHERE a.inventory_entry_id = i.id), 0) AS batch_allocated,
      (SELECT COUNT(*) FROM serial_numbers n WHERE n.in_entry_id = i.id OR n.out_entry_id = i.id OR n.returned_entry_id = i.id) AS serial_count
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.stock_item_id
    WHERE (s.track_batches = 1 OR s.track_serials = 1) AND (? IS NULL OR s.id = ?) ORDER BY v.date, i.id`, [item_id || null, item_id || null]);
  return rows.map((r) => ({ ...r, batch_allocated: r3(r.batch_allocated),
    needs_batch: !!r.track_batches && r.batch_allocated < r.quantity - EPS, needs_serial: !!r.track_serials && r.serial_count < r.quantity - EPS }))
    .filter((r) => r.needs_batch || r.needs_serial);
}

async function lookup(code) {
  const c = String(code || '').trim();
  if (!c || c.length > 80) throw bad('Enter or scan a code.');
  const results = [];
  const qtyOf = async (itemId) => {
    const r = await get(`SELECT MAX(s.opening_qty) + COALESCE(SUM(CASE WHEN i.direction='IN' THEN i.quantity ELSE -i.quantity END),0) AS q FROM stock_items s LEFT JOIN inventory_entries i ON i.stock_item_id = s.id WHERE s.id = ?`, [itemId]);
    return r3(r.q);
  };
  for (const it of await all('SELECT id, name, hsn_code, barcode FROM stock_items WHERE lower(barcode) = lower(?)', [c])) results.push({ type: 'barcode', item_id: it.id, item: it.name, hsn_code: it.hsn_code, quantity_on_hand: await qtyOf(it.id) });
  for (const h of await serialHistory(c)) results.push({ type: 'serial', ...h });
  for (const b of (await listBatches()).filter((x) => x.batch_no.toLowerCase() === c.toLowerCase())) results.push({ type: 'batch', ...b });
  return { code: c, matches: results };
}

module.exports = { setItemSettings, listItems, allocateBatches, removeAllocation, listBatches, expiring, getExpiryAlerts, fefoSuggestion, addSerials, removeSerial, listSerials, serialHistory, unallocated, lookup };

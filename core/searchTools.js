/**
 * RRE Tally — smart search and quick look.
 *
 * One box finds vouchers (by number, reference, narration, party, type, date or exact amount), ledgers/parties (by name, GSTIN —
 * tolerating typos) and stock items (by name or HSN). "Quick look" gives a read-only preview of a result. Nothing here changes data.
 */
const { all, get } = require('./db');
const { getRolePermissions } = require('./db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const MIN_CHARS = 2, MAX_CHARS = 80;
const LIMITS = { vouchers: 8, ledgers: 6, items: 6 };

const esc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Edit distance, stopping early once it exceeds `max`. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] + 1); // swapped letters
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Score a name against the typed words. 0 = no match. Higher = better. */
function scoreName(name, qWords, qFolded) {
  const n = fold(name), nWords = words(name);
  if (n === qFolded) return 100;
  let total = 0;
  for (const t of qWords) {
    if (nWords.some((w) => w.startsWith(t))) total += 3;
    else if (n.includes(t)) total += 2;
    else if (t.length >= 4 && nWords.some((w) => within(t, w.slice(0, Math.max(t.length, 1) + 1), t.length >= 8 ? 2 : 1) || within(t, w, t.length >= 8 ? 2 : 1))) total += 1;
    else return 0; // every typed word must be found
  }
  return total + (n.startsWith(qWords[0]) ? 1 : 0);
}

function parseAmount(q) {
  const m = /^\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/i.exec(q);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function search(qRaw, user) {
  const q = String(qRaw == null ? '' : qRaw).trim();
  if (q.length < MIN_CHARS) return { query: q, vouchers: [], ledgers: [], items: [], hint: `Type at least ${MIN_CHARS} characters.` };
  if (q.length > MAX_CHARS) throw bad(`Please keep the search under ${MAX_CHARS} characters.`);
  const t0 = Date.now();
  const qWords = words(q), qFolded = fold(q).trim();
  const amount = parseAmount(q);

  // ---- vouchers
  let vouchers = [];
  const baseSql = `SELECT v.id, v.voucher_type, v.voucher_no, v.date, v.total_amount, v.narration, v.reference_no, l.name AS party
                   FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id`;
  if (amount !== null) {
    vouchers = await all(`${baseSql} WHERE ABS(v.total_amount - ?) < 0.005 OR v.id IN (SELECT voucher_id FROM ledger_entries WHERE ABS(debit_amount - ?) < 0.005 OR ABS(credit_amount - ?) < 0.005)
                          ORDER BY v.date DESC, v.id DESC LIMIT ?`, [amount, amount, amount, LIMITS.vouchers]);
  }
  if (!vouchers.length) {
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);
    const where = tokens.map(() => `(v.voucher_no LIKE ? ESCAPE '\\' OR v.reference_no LIKE ? ESCAPE '\\' OR v.narration LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\' OR v.voucher_type LIKE ? ESCAPE '\\' OR v.date LIKE ? ESCAPE '\\')`).join(' AND ');
    const params = tokens.flatMap((t) => Array(6).fill(`%${esc(t)}%`));
    vouchers = await all(`${baseSql} WHERE ${where} ORDER BY v.date DESC, v.id DESC LIMIT ?`, [...params, LIMITS.vouchers]);
  }

  // ---- ledgers and parties (typo tolerant)
  const ledgerRows = await all(`SELECT l.id, l.name, l.gstin, g.name AS grp FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.is_active = 1`);
  const upper = q.toUpperCase().replace(/\s+/g, '');
  const ledgers = ledgerRows.map((l) => {
    let s = qWords.length ? scoreName(l.name, qWords, qFolded) : 0;
    if (l.gstin && upper.length >= 5 && l.gstin.toUpperCase().includes(upper)) s = Math.max(s, 50);
    return { ...l, _s: s };
  }).filter((l) => l._s > 0).sort((a, b) => b._s - a._s || a.name.length - b.name.length).slice(0, LIMITS.ledgers).map(({ _s, ...l }) => l);

  // ---- stock items
  const itemRows = await all(`SELECT s.id, s.name, s.hsn_code, u.symbol AS uom FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id WHERE s.is_active = 1`);
  const items = itemRows.map((i) => {
    let s = qWords.length ? scoreName(i.name, qWords, qFolded) : 0;
    if (i.hsn_code && qFolded.length >= 4 && String(i.hsn_code).startsWith(qFolded)) s = Math.max(s, 40);
    return { ...i, _s: s };
  }).filter((i) => i._s > 0).sort((a, b) => b._s - a._s || a.name.length - b.name.length).slice(0, LIMITS.items).map(({ _s, ...i }) => i);

  return { query: q, amount_search: amount !== null, vouchers, ledgers, items, took_ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ quick look
async function voucherLook(id) {
  const v = await get(`SELECT v.*, p.name AS party FROM vouchers v LEFT JOIN ledgers p ON p.id = v.party_ledger_id WHERE v.id = ?`, [id]);
  if (!v) throw bad('Voucher not found.', 404);
  const lines = await all(`SELECT e.id, l.name AS ledger, e.debit_amount, e.credit_amount, e.particulars FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ? ORDER BY e.sort_order, e.id`, [id]);
  const stock = await all(`SELECT s.name, i.direction, i.quantity, i.rate, i.amount, i.discount_pct FROM inventory_entries i JOIN stock_items s ON s.id = i.stock_item_id WHERE i.voucher_id = ? ORDER BY i.id`, [id]);
  return { id: v.id, voucher_type: v.voucher_type, voucher_no: v.voucher_no, date: v.date, reference_no: v.reference_no, narration: v.narration, party: v.party, total_amount: v.total_amount, lines, stock };
}

async function ledgerLook(id, user) {
  const l = await get(`SELECT l.*, g.name AS grp, g.nature FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE l.id = ?`, [id]);
  if (!l) throw bad('Ledger not found.', 404);
  const perms = getRolePermissions(user && user.role);
  const recent = await all(`SELECT v.id AS voucher_id, v.date, v.voucher_no, v.voucher_type, e.debit_amount, e.credit_amount FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id
                            WHERE e.ledger_id = ? ORDER BY v.date DESC, v.id DESC LIMIT 8`, [id]);
  const out = { id: l.id, name: l.name, group: l.grp, nature: l.nature, gstin: l.gstin, state: l.state, credit_period: l.credit_period, recent, balances_visible: !!perms.canViewFinancials };
  if (perms.canViewFinancials) {
    const t = await get('SELECT COALESCE(SUM(debit_amount),0) d, COALESCE(SUM(credit_amount),0) c, COUNT(*) n FROM ledger_entries WHERE ledger_id = ?', [id]);
    const dr = (l.opening_balance_type === 'Dr' ? l.opening_balance : 0) + t.d, cr = (l.opening_balance_type === 'Cr' ? l.opening_balance : 0) + t.c;
    out.opening = { amount: l.opening_balance, type: l.opening_balance_type };
    out.closing = { amount: r2(Math.abs(dr - cr)), type: dr >= cr ? 'Dr' : 'Cr' };
    out.entries = t.n;
  } else {
    out.recent = recent.map(({ debit_amount, credit_amount, ...r }) => r); // amounts hidden, like the financial reports
  }
  return out;
}

async function itemLook(id, user) {
  const s = await get(`SELECT s.*, u.symbol AS uom FROM stock_items s JOIN units_of_measure u ON u.id = s.uom_id WHERE s.id = ?`, [id]);
  if (!s) throw bad('Stock item not found.', 404);
  const perms = getRolePermissions(user && user.role);
  const t = await get(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN quantity ELSE 0 END),0) qin, COALESCE(SUM(CASE WHEN direction='OUT' THEN quantity ELSE 0 END),0) qout,
                       COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END),0) vin FROM inventory_entries WHERE stock_item_id = ?`, [id]);
  const qty = r2(s.opening_qty + t.qin - t.qout);
  const moves = await all(`SELECT v.date, v.voucher_no, v.voucher_type, i.direction, i.quantity FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id WHERE i.stock_item_id = ? ORDER BY v.date DESC, v.id DESC LIMIT 6`, [id]);
  const out = { id: s.id, name: s.name, uom: s.uom, hsn_code: s.hsn_code, gst_rate: s.gst_rate, quantity_on_hand: qty, reorder_level: s.reorder_level || null, low: s.reorder_level ? qty <= s.reorder_level : false, recent: moves, value_visible: !!perms.canViewFinancials };
  if (perms.canViewFinancials) {
    const availQ = s.opening_qty + t.qin;
    const rate = availQ > 0 ? (s.opening_val + t.vin) / availQ : (s.opening_rate || s.standard_cost || 0);
    out.rate = r2(rate); out.value = r2(Math.max(qty, 0) * rate);
  }
  return out;
}

module.exports = { search, voucherLook, ledgerLook, itemLook, within, scoreName };

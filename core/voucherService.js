// ========================================================
// Voucher Posting Service — single double-entry write path
// Used by the Vouchers API and by Quotation -> Invoice conversion.
// ========================================================
const { get, all, run } = require('./db');

class VoucherValidationError extends Error {}
/** The voucher number is already used (HTTP 409). */
class VoucherConflictError extends Error {}

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const paise = (n) => Math.round((parseFloat(n) || 0) * 100); // exact integer arithmetic for the balance check

/**
 * Next free number for vouchers without one: <prefix><n>, n one above the highest number already used with that prefix.
 * Called inside the posting transaction, which the company's transaction queue runs one at a time, so two vouchers can never get
 * the same number (the UNIQUE constraint on voucher_no is the final guard).
 */
const voucherPrefix = (voucherType) => `RRE/${String(voucherType).toUpperCase().slice(0, 3)}/`;
async function nextVoucherNo(voucherType) {
  const prefix = voucherPrefix(voucherType);
  // a range on the voucher-number index (not LIKE over the whole table): only postings that use the SAME prefix ever compete for a number
  const rows = await all('SELECT voucher_no FROM vouchers WHERE voucher_no >= ? AND voucher_no < ?', [prefix, prefix + '~']);
  let max = 0;
  for (const r of rows) { const tail = r.voucher_no.slice(prefix.length); if (/^\d{1,12}$/.test(tail)) max = Math.max(max, parseInt(tail, 10)); }
  return prefix + String(max + 1).padStart(5, '0');
}

/** 'allow' (default) or 'block': may a sale / purchase return take an item below zero? */
async function negativeStockPolicy() {
  const r = await get("SELECT value FROM app_settings WHERE key = 'negative_stock'").catch(() => null);
  return r && r.value === 'block' ? 'block' : 'allow';
}
/**
 * Accounting period: the books can be locked up to a date (after a period is audited / GST is filed). Nothing dated on or before it
 * can be posted, altered, reversed into it or deleted. Every voucher date must also be a real calendar date.
 */
async function periodLock() {
  const r = await get("SELECT value FROM app_settings WHERE key = 'books_locked_upto'").catch(() => null);
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.value || '') ? r.value : null;
}
async function setPeriodLock(value) {
  const v = value ? String(value).trim() : '';
  if (v && !isRealDate(v)) throw new VoucherValidationError('The lock date must be a date (YYYY-MM-DD).');
  await run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('books_locked_upto', ?)", [v]);
  return v || null;
}
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100;
}
async function checkPeriod(date, what = 'A voucher') {
  if (!isRealDate(date)) throw new VoucherValidationError(`${what} date "${date}" is not a valid date (YYYY-MM-DD).`);
  const lock = await periodLock();
  if (lock && date <= lock) throw Object.assign(new VoucherValidationError(`The books are locked up to ${lock}: ${what.toLowerCase()} dated ${date} cannot be posted or changed. An administrator can change the lock date.`), { status: 409, code: 'PERIOD_LOCKED' });
}

async function setNegativeStockPolicy(value) {
  if (!['allow', 'block'].includes(value)) throw new VoucherValidationError("negative_stock must be 'allow' or 'block'.");
  await run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  await run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('negative_stock', ?)", [value]);
  return value;
}

/**
 * Posts a balanced voucher inside a transaction.
 * When `options.inTransaction` is true, the caller owns the transaction (withTransaction).
 * `options.idempotencyKey` (the Idempotency-Key header, per user): the same key always returns the first result and never posts twice.
 */
/** The double-entry checks every voucher passes, new or altered: at least 2 lines, a ledger on each, Dr or Cr (not both), Dr = Cr to the paisa. */
function validateLines(payload) {
  const { voucher_type, date, entries } = payload;
  if (!voucher_type || !entries || !Array.isArray(entries) || entries.length < 2) {
    throw new VoucherValidationError('Voucher type and at least 2 double-entry lines are required');
  }
  if (date != null && date !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(date)))) throw new VoucherValidationError('Voucher date must be YYYY-MM-DD.');

  // Mathematical Double-Entry Invariant Guard: Sum(Dr) == Sum(Cr), to the paisa
  let drPaise = 0;
  let crPaise = 0;

  const validatedEntries = entries.map((e, i) => {
    const dr = round2(e.debit_amount);
    const cr = round2(e.credit_amount);
    const ledgerId = parseInt(e.ledger_id, 10);
    if (!Number.isInteger(ledgerId) || ledgerId <= 0) throw new VoucherValidationError(`Line ${i + 1}: choose a ledger.`);
    if (!Number.isFinite(dr) || !Number.isFinite(cr) || dr < 0 || cr < 0) throw new VoucherValidationError(`Line ${i + 1}: amounts cannot be negative.`);
    if ((dr > 0) === (cr > 0)) throw new VoucherValidationError(`Line ${i + 1}: enter either a debit or a credit amount (not both, not neither).`);
    drPaise += paise(dr);
    crPaise += paise(cr);
    return {
      ledger_id: ledgerId,
      entry_type: dr > 0 ? 'Dr' : 'Cr',
      debit_amount: dr,
      credit_amount: cr,
      particulars: e.particulars || '',
      cost_centre_id: e.cost_centre_id ? parseInt(e.cost_centre_id, 10) : null
    };
  });

  if (drPaise !== crPaise) {
    throw new VoucherValidationError(
      `Tally Invariant Violation: Total Debits (₹${(drPaise / 100).toFixed(2)}) != Total Credits (₹${(crPaise / 100).toFixed(2)}). Diff: ₹${(Math.abs(drPaise - crPaise) / 100).toFixed(2)}`
    );
  }
  return { validatedEntries, totalDebit: drPaise / 100 };
}

/** Every ledger on the voucher exists. */
async function checkLedgers(validatedEntries) {
  const ids = [...new Set(validatedEntries.map((e) => e.ledger_id))];
  const found = await get(`SELECT COUNT(*) AS n FROM ledgers WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  if (Number(found.n) !== ids.length) throw new VoucherValidationError('One or more ledgers on this voucher do not exist.');
}

/**
 * Company setting "negative stock": 'allow' (default, as Tally) or 'block'. Checked inside the posting transaction, with a lock per item,
 * so two sales at the same moment can never both take the last unit. (For an alteration it runs after the voucher's own old stock lines
 * were removed, so the voucher's previous quantity is available again.)
 */
async function checkStock(voucher_type, inventory) {
  const { lockKeys } = require('./tx');
  const outward = ['Sales', 'Debit Note'].includes(voucher_type) && Array.isArray(inventory) ? inventory.filter((i) => i.stock_item_id && (parseFloat(i.quantity) || 0) > 0) : [];
  if (!outward.length || (await negativeStockPolicy()) !== 'block') return;
  const want = new Map();
  for (const i of outward) want.set(parseInt(i.stock_item_id, 10), (want.get(parseInt(i.stock_item_id, 10)) || 0) + parseFloat(i.quantity));
  await lockKeys([...want.keys()].map((id) => 'stock:' + id)); // sales of the same item take turns for its last units; other items do not wait
  for (const [itemId, qty] of want) {
    const s = await get(`SELECT s.name, s.opening_qty + COALESCE((SELECT SUM(CASE WHEN e.direction = 'IN' THEN e.quantity ELSE -e.quantity END) FROM inventory_entries e WHERE e.stock_item_id = s.id), 0) AS on_hand FROM stock_items s WHERE s.id = ?`, [itemId]);
    if (!s) throw new VoucherValidationError(`Stock item #${itemId} does not exist.`);
    if (Number(s.on_hand) - qty < -1e-9) throw Object.assign(new VoucherValidationError(`Not enough stock of ${s.name}: ${Number(s.on_hand)} on hand, ${qty} requested. (Negative stock is blocked for this company.)`), { status: 409 });
  }
}

/**
 * Writes a voucher's lines: ledger lines (+ bank reconciliation queue), stock lines, bill allocations. The ONE place this happens, for
 * new and for altered vouchers. `inventory` / `bill_allocations` undefined = not written (an alteration that keeps the existing ones).
 */
async function writeLines(voucherId, { voucher_type, voucher_no: vNo, reference_no, validatedEntries, inventory, bill_allocations }) {
    // 1. Double-Entry Ledger Lines
    for (const en of validatedEntries) {
      const enResult = await run(
        `INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [voucherId, en.ledger_id, en.entry_type, en.debit_amount, en.credit_amount, en.particulars, en.cost_centre_id]
      );

      // Auto-queue for Bank Reconciliation if ledger belongs to Bank Accounts
      const lInfo = await get('SELECT group_id FROM ledgers WHERE id = ?', [en.ledger_id]);
      if (lInfo && (lInfo.group_id === 18 || lInfo.group_id === 22)) {
        await run(
          `INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status)
           VALUES (?, NULL, ?, 'Pending')`,
          [enResult.lastID, reference_no || '']
        );
      }
    }

    // 2. Inventory Movements
    if (inventory && Array.isArray(inventory)) {
      for (const item of inventory) {
        const qty = parseFloat(item.quantity) || 0;
        const rate = parseFloat(item.rate) || 0;
        const amt = item.amount !== undefined ? round2(item.amount) : qty * rate;
        // Purchase and Credit Note (sales return) bring stock IN; Sales and Debit Note (purchase return) send it OUT
        const direction = ['Purchase', 'Credit Note'].includes(voucher_type) ? 'IN' : 'OUT';
        if (item.stock_item_id && qty > 0) {
          await run(
            `INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, discount_pct, godown_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [voucherId, item.stock_item_id, direction, qty, rate, amt, parseFloat(item.discount_pct) || 0, item.godown_id || 1]
          );
        }
      }
    }

    // 3. Bill-by-Bill Allocations
    if (bill_allocations && Array.isArray(bill_allocations)) {
      for (const b of bill_allocations) {
        if (b.ledger_id && b.amount) {
          // A Credit/Debit Note settles an existing bill; it can never open a new receivable/payable
          const isReturnNote = ['Credit Note', 'Debit Note'].includes(voucher_type);
          const billType = isReturnNote && (!b.bill_type || b.bill_type === 'New Ref') ? 'Agst Ref' : (b.bill_type || 'New Ref');
          await run(
            `INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [voucherId, b.ledger_id, billType, b.bill_ref || vNo, parseFloat(b.amount) || 0, b.due_date || null]
          );
        }
      }
    }
}

async function postVoucher(payload, options = {}) {
  const { voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, inventory, bill_allocations } = payload;
  const { validatedEntries, totalDebit } = validateLines(payload);
  const vDate = date || new Date().toISOString().split('T')[0];
  const idemKey = options.idempotencyKey ? `voucher:${options.userId == null ? '-' : options.userId}:${String(options.idempotencyKey).slice(0, 120)}` : null;

  const work = async () => {
    // the same request again (double click, network retry): the first result, nothing posted twice
    const { lockKeys } = require('./tx');
    if (idemKey) {
      await lockKeys(['idem:' + idemKey]); // the same request sent twice at once: the second waits here and then finds the first's result
      const prev = await get('SELECT result FROM idempotency_keys WHERE scope_key = ?', [idemKey]);
      if (prev) return { ...JSON.parse(prev.result), replayed: true };
    }
    await checkPeriod(vDate);
    await checkLedgers(validatedEntries);
    await checkStock(voucher_type, inventory);

    if (!voucher_no) await lockKeys(['voucher-no:' + voucherPrefix(voucher_type)]); // one number series at a time; other series do not wait
    const vNo = voucher_no || await nextVoucherNo(voucher_type);
    if (await get('SELECT id FROM vouchers WHERE voucher_no = ?', [vNo])) throw new VoucherConflictError(`Voucher number ${vNo} is already used. Choose another number.`);

    const vResult = await run(
      `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [voucher_type, vNo, vDate, reference_no || '', narration || '', party_ledger_id || null, totalDebit]
    );
    const voucherId = vResult.lastID;
    await writeLines(voucherId, { voucher_type, voucher_no: vNo, reference_no, validatedEntries, inventory, bill_allocations });

    const result = { id: voucherId, voucher_no: vNo, voucher_type, total_amount: totalDebit };
    if (idemKey) await run('INSERT INTO idempotency_keys (scope_key, result) VALUES (?, ?)', [idemKey, JSON.stringify(result)]);
    return result;
  };

  // the company's transaction queue: postings never overlap (a second BEGIN on the same connection used to fail under load)
  if (options.inTransaction) return work();
  return require('./tx').withTransaction(work, { concurrent: true }); // PostgreSQL: runs alongside other postings (locks above where they compete)
}

/** A voucher's complete content, as kept in the audit log (before / after an alteration, before a delete). */
async function snapshotOf(id) {
  return {
    voucher: await get('SELECT * FROM vouchers WHERE id = ?', [id]),
    entries: await all('SELECT ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id FROM ledger_entries WHERE voucher_id = ? ORDER BY id', [id]),
    inventory: await all('SELECT stock_item_id, direction, quantity, rate, amount, discount_pct, godown_id FROM inventory_entries WHERE voucher_id = ? ORDER BY id', [id]),
    bill_allocations: await all('SELECT ledger_id, bill_type, bill_ref, amount, due_date FROM bill_allocations WHERE voucher_id = ? ORDER BY id', [id])
  };
}

/** Why an existing voucher may not be altered (null = it may). Each case keeps other records consistent. */
async function alterationBlocker(v, newPartyAmount) {
  if (String(v.reference_no || '').startsWith('Reversal of ')) return `${v.voucher_no} is a cancellation (reversal) entry. Reversal entries are not altered.`;
  const rev = await get('SELECT voucher_no FROM vouchers WHERE reference_no = ?', [`Reversal of ${v.voucher_no}`]);
  if (rev) return `${v.voucher_no} was cancelled by ${rev.voucher_no}, so it cannot be altered any more.`;
  const order = await get('SELECT o.number AS order_no FROM inv_order_docs d JOIN inv_orders o ON o.id = d.order_id WHERE d.voucher_id = ?', [v.id]).catch(() => null);
  if (order) return `${v.voucher_no} was created from order ${order.order_no}. Change it through the order (or cancel it with a ${v.voucher_type === 'Purchase' ? 'Debit' : 'Credit'} Note).`;
  const cleared = await get("SELECT COUNT(*) AS n FROM bank_reconciliation b JOIN ledger_entries e ON e.id = b.ledger_entry_id WHERE e.voucher_id = ? AND (b.bank_clearing_date IS NOT NULL OR b.status <> 'Pending')", [v.id]);
  if (Number(cleared.n)) return `A bank line of ${v.voucher_no} is already reconciled with the bank statement. Undo the reconciliation first, or cancel the voucher with a reversal.`;
  for (const t of ['batch_allocations', 'serial_numbers']) {
    const n = await get(`SELECT COUNT(*) AS n FROM ${t} WHERE inventory_entry_id IN (SELECT id FROM inventory_entries WHERE voucher_id = ?)`, [v.id]).catch(() => ({ n: 0 }));
    if (Number(n.n)) return `${v.voucher_no} has batch or serial numbers recorded. Cancel it with a reversal and enter it again.`;
  }
  // a bill of this voucher that a receipt / payment has already settled: its amount must stay
  const own = await all("SELECT ledger_id, bill_ref, amount FROM bill_allocations WHERE voucher_id = ? AND bill_type = 'New Ref'", [v.id]);
  for (const b of own) {
    const settled = await get("SELECT v.voucher_no FROM bill_allocations a JOIN vouchers v ON v.id = a.voucher_id WHERE a.bill_type = 'Agst Ref' AND a.ledger_id = ? AND a.bill_ref = ? AND a.voucher_id <> ? LIMIT 1", [b.ledger_id, b.bill_ref, v.id]);
    if (settled && newPartyAmount != null && Math.abs(Number(b.amount) - newPartyAmount) > 0.004) return `Bill ${b.bill_ref} of ${v.voucher_no} is already settled by ${settled.voucher_no}, so its amount cannot change. Cancel it with a reversal instead.`;
  }
  return null;
}

/**
 * Alters a posted voucher (Tally "Alter"): the voucher keeps its id and type; its date, number, reference, narration, party and lines are
 * replaced, in ONE transaction, through exactly the same checks and the same line-writing code as a new voucher. The Day Book, ledgers,
 * stock, GST and every report read these same rows, so they all show the change at once. The complete voucher before AND after goes to
 * the audit log in the same transaction (no audit record = no change).
 *   payload.inventory / payload.bill_allocations undefined = keep the voucher's existing stock lines / bills.
 */
async function alterVoucher(id, payload, { user = null, ip = null } = {}) {
  const { validatedEntries, totalDebit } = validateLines(payload);
  return require('./tx').withTransaction(async () => {
    const { lockKeys } = require('./tx');
    await lockKeys(['voucher:' + id]);
    const v = await get('SELECT * FROM vouchers WHERE id = ?', [id]);
    if (!v) throw Object.assign(new VoucherValidationError('Voucher not found.'), { status: 404 });
    if (payload.voucher_type !== v.voucher_type) throw new VoucherValidationError(`A ${v.voucher_type} voucher cannot be turned into a ${payload.voucher_type}. Cancel it (reversal) and enter a new voucher.`);
    const partyId = payload.party_ledger_id ? parseInt(payload.party_ledger_id, 10) : null;
    const partyAmount = partyId ? validatedEntries.filter((e) => e.ledger_id === partyId).reduce((s, e) => s + e.debit_amount + e.credit_amount, 0) : null;
    const blocked = await alterationBlocker(v, partyAmount);
    if (blocked) throw new VoucherConflictError(blocked);
    await checkPeriod(v.date, 'This voucher'); // a voucher in a locked period stays as it is
    if (payload.date && payload.date !== v.date) await checkPeriod(payload.date, 'The new');
    await checkLedgers(validatedEntries);

    const vNo = payload.voucher_no ? String(payload.voucher_no).trim() : v.voucher_no;
    if (vNo !== v.voucher_no && await get('SELECT id FROM vouchers WHERE voucher_no = ? AND id <> ?', [vNo, id])) throw new VoucherConflictError(`Voucher number ${vNo} is already used. Choose another number.`);
    const before = await snapshotOf(id);

    // out with the old lines (and their pending bank-reconciliation items) ...
    await run('DELETE FROM bank_reconciliation WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE voucher_id = ?)', [id]);
    await run('DELETE FROM ledger_entries WHERE voucher_id = ?', [id]);
    const inventory = payload.inventory === undefined ? undefined : (Array.isArray(payload.inventory) ? payload.inventory : []);
    if (inventory !== undefined) await run('DELETE FROM inventory_entries WHERE voucher_id = ?', [id]);
    const bills = payload.bill_allocations === undefined ? undefined : (Array.isArray(payload.bill_allocations) ? payload.bill_allocations : []);
    if (bills !== undefined) await run('DELETE FROM bill_allocations WHERE voucher_id = ?', [id]);
    await checkStock(v.voucher_type, inventory); // the voucher's own previous quantity counts as available again

    // ... in with the new ones, through the same code as a new voucher
    const date = payload.date || v.date;
    await run('UPDATE vouchers SET voucher_no = ?, date = ?, reference_no = ?, narration = ?, party_ledger_id = ?, total_amount = ? WHERE id = ?',
      [vNo, date, payload.reference_no != null ? payload.reference_no : v.reference_no, payload.narration != null ? payload.narration : v.narration, partyId || v.party_ledger_id, totalDebit, id]);
    await writeLines(id, { voucher_type: v.voucher_type, voucher_no: vNo, reference_no: payload.reference_no != null ? payload.reference_no : v.reference_no, validatedEntries, inventory, bill_allocations: bills });
    // bills kept: the voucher's own single bill follows the new party amount
    if (bills === undefined && partyAmount != null) {
      const own = await all("SELECT id FROM bill_allocations WHERE voucher_id = ? AND bill_type = 'New Ref' AND ledger_id = ?", [id, partyId]);
      if (own.length === 1) await run('UPDATE bill_allocations SET amount = ? WHERE id = ?', [Math.round(partyAmount * 100) / 100, own[0].id]);
    }
    await run("UPDATE quotations SET updated_at = CURRENT_TIMESTAMP WHERE converted_voucher_id = ?", [id]).catch(() => {});

    const after = await snapshotOf(id);
    const u = user || {};
    await run('INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [u.userId || null, u.username || 'system', u.role || null, 'VOUCHER_ALTER', 'voucher', String(id), JSON.stringify({ before, after }), ip || null]);
    return { id, voucher_no: vNo, voucher_type: v.voucher_type, total_amount: totalDebit, row_version: Number(after.voucher.row_version), altered: true };
  }, { concurrent: true });
}

/**
 * Reverses a posted voucher by posting its mirror image (debits and credits swapped; stock moved back), instead of deleting it.
 * Sales <-> Credit Note and Purchase <-> Debit Note keep the stock right; other vouchers are reversed by a Journal.
 * A voucher can be reversed once.
 */
const REVERSE_TYPE = { Sales: 'Credit Note', 'Credit Note': 'Sales', Purchase: 'Debit Note', 'Debit Note': 'Purchase' };
async function reverseVoucher(id, { date, narration, userId } = {}) {
  return require('./tx').withTransaction(async () => {
    const v = await get('SELECT * FROM vouchers WHERE id = ?', [id]);
    if (!v) throw Object.assign(new VoucherValidationError('Voucher not found.'), { status: 404 });
    const ref = `Reversal of ${v.voucher_no}`;
    const done = await get('SELECT voucher_no FROM vouchers WHERE reference_no = ?', [ref]);
    if (done) throw new VoucherConflictError(`Voucher ${v.voucher_no} was already reversed by ${done.voucher_no}.`);
    const entries = (await all('SELECT ledger_id, debit_amount, credit_amount, particulars, cost_centre_id FROM ledger_entries WHERE voucher_id = ? ORDER BY id', [id]))
      .map((e) => ({ ledger_id: e.ledger_id, debit_amount: e.credit_amount, credit_amount: e.debit_amount, particulars: e.particulars, cost_centre_id: e.cost_centre_id }));
    const type = REVERSE_TYPE[v.voucher_type] || 'Journal';
    const inventory = REVERSE_TYPE[v.voucher_type]
      ? (await all('SELECT stock_item_id, quantity, rate, amount, discount_pct, godown_id FROM inventory_entries WHERE voucher_id = ? ORDER BY id', [id]))
      : [];
    if (!REVERSE_TYPE[v.voucher_type] && (await get('SELECT COUNT(*) AS n FROM inventory_entries WHERE voucher_id = ?', [id])).n > 0) {
      throw new VoucherValidationError(`A ${v.voucher_type} voucher with stock lines cannot be reversed automatically. Post a correcting stock journal.`);
    }
    return postVoucher({ voucher_type: type, date: date || new Date().toISOString().slice(0, 10), reference_no: ref, narration: narration || `Reversal of ${v.voucher_type} ${v.voucher_no}`,
      party_ledger_id: v.party_ledger_id, entries, inventory }, { inTransaction: true, userId });
  });
}

module.exports = { postVoucher, alterVoucher, snapshotOf, reverseVoucher, nextVoucherNo, negativeStockPolicy, setNegativeStockPolicy, periodLock, setPeriodLock, checkPeriod, VoucherValidationError, VoucherConflictError, round2 };

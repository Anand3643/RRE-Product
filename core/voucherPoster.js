/**
 * RRE Tally — shared voucher posting for recurring vouchers and CSV import.
 *
 * Mirrors the rules of the existing POST /api/vouchers route:
 *   - at least two lines, each with a debit OR a credit, and Σ debit = Σ credit
 *   - ledger_entries carry `particulars` (the ledger name) — the GST reports and other views rely on it
 *   - entries on bank ledgers are queued for reconciliation as Pending
 *   - optional bill allocations
 * It never opens its own transaction: call it inside withTransaction() so a batch is all-or-nothing.
 */
const { run, get, all } = require('./db');
const { getRolePermissions } = require('./db');

const KNOWN_TYPES = ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }

function assertRoleMayPost(user, voucherType) {
  if (!KNOWN_TYPES.includes(voucherType)) throw fail(`Unknown voucher type "${voucherType}".`);
  const perms = getRolePermissions(user?.role);
  if (!perms.canCreateVouchers) throw fail(`Your role "${user?.role}" may not post vouchers.`, 403);
  if (!(perms.allowedVoucherTypes || []).includes(voucherType)) throw fail(`Your role "${user?.role}" may not post ${voucherType} vouchers.`, 403);
}

/** Pure validation of a voucher payload (no database access). Returns normalised lines or throws. */
function normaliseVoucher(v, { tolerance = 0.01 } = {}) {
  if (!KNOWN_TYPES.includes(v.voucher_type)) throw fail(`Unknown voucher type "${v.voucher_type}".`);
  if (!ISO.test(v.date || '') || Number.isNaN(Date.parse(v.date))) throw fail(`Invalid date "${v.date}".`);
  if (!Array.isArray(v.entries) || v.entries.length < 2) throw fail('A voucher needs at least two ledger lines.');
  let dr = 0, cr = 0;
  const lines = v.entries.map((e, i) => {
    const d = r2(e.debit_amount), c = r2(e.credit_amount);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) throw fail(`Line ${i + 1}: amounts must be numbers ≥ 0.`);
    if ((d > 0) === (c > 0)) throw fail(`Line ${i + 1}: enter either a debit or a credit amount (not both, not neither).`);
    const id = parseInt(e.ledger_id, 10);
    if (!id) throw fail(`Line ${i + 1}: ledger is missing.`);
    dr += d; cr += c;
    return { ledger_id: id, debit_amount: d, credit_amount: c, entry_type: d > 0 ? 'Dr' : 'Cr' };
  });
  if (Math.abs(dr - cr) > tolerance) throw fail(`Not balanced: debits ₹${r2(dr)} vs credits ₹${r2(cr)}.`);
  return { lines, total: r2(dr) };
}

async function postVoucher(v, { user, source = 'automation', tolerance = 0.01 } = {}) {
  assertRoleMayPost(user, v.voucher_type);
  const { lines, total } = normaliseVoucher(v, { tolerance });
  if (!v.voucher_no || String(v.voucher_no).length > 60) throw fail('Voucher number is required (max 60 characters).');
  if (await get('SELECT id FROM vouchers WHERE voucher_no = ?', [v.voucher_no])) throw fail(`Voucher number "${v.voucher_no}" already exists.`, 409);

  const ids = [...new Set(lines.map((l) => l.ledger_id))];
  const found = await all(`SELECT l.id, l.name, l.group_id FROM ledgers l WHERE l.id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(found.map((l) => [l.id, l]));
  for (const id of ids) if (!byId.has(id)) throw fail(`Ledger #${id} does not exist.`);
  if (v.party_ledger_id && !(await get('SELECT id FROM ledgers WHERE id = ?', [v.party_ledger_id]))) throw fail('Party ledger does not exist.');

  const ins = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [v.voucher_type, v.voucher_no, v.date, v.reference_no || '', v.narration || '', v.party_ledger_id || null, total]);
  for (const l of lines) {
    const led = byId.get(l.ledger_id);
    const e = await run(
      `INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars, cost_centre_id) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [ins.lastID, l.ledger_id, l.entry_type, l.debit_amount, l.credit_amount, led.name]);
    if (led.group_id === 18 || led.group_id === 22) {
      await run(`INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status) VALUES (?, NULL, ?, 'Pending')`, [e.lastID, v.reference_no || '']);
    }
  }
  for (const b of v.bill_allocations || []) {
    if (!b.ledger_id || !(Number(b.amount) > 0)) continue;
    await run(`INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)`,
      [ins.lastID, b.ledger_id, b.bill_type || 'New Ref', b.bill_ref || v.voucher_no, r2(b.amount), b.due_date || null]);
  }
  return { id: ins.lastID, voucher_no: v.voucher_no, total_amount: total, source };
}

module.exports = { postVoucher, normaliseVoucher, assertRoleMayPost, KNOWN_TYPES };

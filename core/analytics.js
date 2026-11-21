/**
 * RRE Tally — read-only analytics helpers shared by the new modules.
 * Pure SELECTs: nothing here writes to accounting tables.
 */
const { all, get } = require('./db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Current quantity per active stock item = opening + IN - OUT (all godowns). */
async function getStockPositions() {
  const rows = await all(`
    SELECT s.id, s.name, s.hsn_code, s.reorder_level, s.opening_qty,
           COALESCE(SUM(CASE WHEN i.direction = 'IN'  THEN i.quantity END), 0) AS qty_in,
           COALESCE(SUM(CASE WHEN i.direction = 'OUT' THEN i.quantity END), 0) AS qty_out
    FROM stock_items s
    LEFT JOIN inventory_entries i ON i.stock_item_id = s.id
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY s.name
  `);
  return rows.map((r) => ({
    ...r,
    current_qty: round2(r.opening_qty + r.qty_in - r.qty_out)
  }));
}

/**
 * Open (pending) bills. Mirrors the grouping used by the existing Outstandings
 * report (/api/reports/outstandings) so numbers agree with it.
 */
async function getOpenBills() {
  const allocations = await all(`
    SELECT b.*, v.date, l.name AS ledger_name, g.name AS group_name
    FROM bill_allocations b
    JOIN vouchers v ON b.voucher_id = v.id
    JOIN ledgers l ON b.ledger_id = l.id
    JOIN account_groups g ON l.group_id = g.id
    ORDER BY b.bill_ref, b.id ASC
  `);

  const bills = {};
  for (const a of allocations) {
    if (!bills[a.bill_ref]) {
      bills[a.bill_ref] = {
        bill_ref: a.bill_ref,
        ledger_id: a.ledger_id,
        ledger_name: a.ledger_name,
        group_name: a.group_name,
        bill_date: a.date,
        due_date: null,
        original_amount: 0,
        cleared_amount: 0
      };
    }
    const b = bills[a.bill_ref];
    if (a.bill_type === 'New Ref') {
      b.original_amount += a.amount;
      b.bill_date = a.date;
      if (a.due_date) b.due_date = a.due_date;
    } else if (a.bill_type === 'Agst Ref') {
      b.cleared_amount += a.amount;
    }
  }

  const receivables = [];
  const payables = [];
  for (const b of Object.values(bills)) {
    b.pending_amount = round2(b.original_amount - b.cleared_amount);
    if (!b.due_date) b.due_date = b.bill_date;
    if (b.pending_amount > 0.005) {
      (b.group_name === 'Sundry Debtors' ? receivables : payables).push(b);
    }
  }
  return { receivables, payables };
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

async function getUnbalancedVouchers() {
  return all(`
    SELECT v.id, v.voucher_no, v.voucher_type,
           ROUND(SUM(le.debit_amount), 2) AS total_dr, ROUND(SUM(le.credit_amount), 2) AS total_cr
    FROM vouchers v JOIN ledger_entries le ON v.id = le.voucher_id
    GROUP BY v.id
    HAVING ABS(SUM(le.debit_amount) - SUM(le.credit_amount)) > 0.01
  `);
}

module.exports = { round2, getStockPositions, getOpenBills, daysBetween, getUnbalancedVouchers, get, all };

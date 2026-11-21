// ========================================================
// Voucher Posting Service — single double-entry write path
// Used by the Vouchers API and by Quotation -> Invoice conversion.
// ========================================================
const { get, run } = require('./db');

class VoucherValidationError extends Error {}

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * Posts a balanced voucher inside a transaction.
 * When `options.inTransaction` is true, the caller owns BEGIN/COMMIT.
 */
async function postVoucher(payload, options = {}) {
  const {
    voucher_type,
    voucher_no,
    date,
    reference_no,
    narration,
    party_ledger_id,
    entries,
    inventory,
    bill_allocations
  } = payload;

  if (!voucher_type || !entries || !Array.isArray(entries) || entries.length < 2) {
    throw new VoucherValidationError('Voucher type and at least 2 double-entry lines are required');
  }

  // Mathematical Double-Entry Invariant Guard: Sum(Dr) == Sum(Cr)
  let totalDebit = 0;
  let totalCredit = 0;

  const validatedEntries = entries.map((e) => {
    const dr = round2(e.debit_amount);
    const cr = round2(e.credit_amount);
    totalDebit += dr;
    totalCredit += cr;
    return {
      ledger_id: parseInt(e.ledger_id, 10),
      entry_type: dr > 0 ? 'Dr' : 'Cr',
      debit_amount: dr,
      credit_amount: cr,
      particulars: e.particulars || '',
      cost_centre_id: e.cost_centre_id ? parseInt(e.cost_centre_id, 10) : null
    };
  });

  const diff = Math.abs(totalDebit - totalCredit);
  if (diff > 0.05) {
    throw new VoucherValidationError(
      `Tally Invariant Violation: Total Debits (₹${totalDebit.toFixed(2)}) != Total Credits (₹${totalCredit.toFixed(2)}). Diff: ₹${diff.toFixed(2)}`
    );
  }

  const vNo = voucher_no || `RRE/${voucher_type.toUpperCase().slice(0, 3)}/${Date.now().toString().slice(-5)}`;
  const vDate = date || new Date().toISOString().split('T')[0];

  const ownTx = !options.inTransaction;
  if (ownTx) await run('BEGIN TRANSACTION');

  try {
    const vResult = await run(
      `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [voucher_type, vNo, vDate, reference_no || '', narration || '', party_ledger_id || null, totalDebit]
    );
    const voucherId = vResult.lastID;

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

    if (ownTx) await run('COMMIT');
    return { id: voucherId, voucher_no: vNo, voucher_type, total_amount: totalDebit };
  } catch (txErr) {
    if (ownTx) await run('ROLLBACK').catch(() => {});
    throw txErr;
  }
}

module.exports = { postVoucher, VoucherValidationError, round2 };

/**
 * RRE Tally — ledger lines for Credit Notes (sales returns) and Debit Notes (purchase returns).
 *
 * A Credit Note REVERSES a sales invoice:
 *    Dr Sales (taxable)   Dr Output CGST/SGST/IGST   Cr Customer (total)
 * A Debit Note REVERSES a purchase:
 *    Dr Supplier (total)  Cr Purchase (taxable)      Cr Input CGST/SGST/IGST
 * (The invoice screen previously posted them like a Sales invoice / Purchase, which inverted them.)
 *
 * Pure function, no DOM access: usable in the browser (window.RRECompose) and in Node tests.
 */
(function (root) {
  'use strict';

  function find(ledgers, pred) { return ledgers.find(pred); }

  function returnEntries(o) {
    const { voucherType, party, partyLedgerId, subtotal, cgst, sgst, igst, grandTotal, roundOff, isInterState, ledgers } = o;
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const roundLedger = find(ledgers, (l) => l.name === 'Round Off A/c');
    const entries = [];

    if (voucherType === 'Credit Note') {
      const salesLedger = find(ledgers, (l) => l.name.includes('Sales Account') || l.group_name === 'Sales Accounts');
      const tax = (name, fallback) => find(ledgers, (l) => l.name === name) || { id: fallback };
      if (!salesLedger) throw new Error('No Sales ledger found to reverse the sale against.');
      entries.push({ ledger_id: salesLedger.id, debit_amount: r2(subtotal), credit_amount: 0, particulars: salesLedger.name });
      if (isInterState) {
        entries.push({ ledger_id: tax('Output IGST 18%', 12).id, debit_amount: r2(igst), credit_amount: 0, particulars: 'Output IGST 18%' });
      } else {
        entries.push({ ledger_id: tax('Output CGST 9%', 10).id, debit_amount: r2(cgst), credit_amount: 0, particulars: 'Output CGST 9%' });
        entries.push({ ledger_id: tax('Output SGST 9%', 11).id, debit_amount: r2(sgst), credit_amount: 0, particulars: 'Output SGST 9%' });
      }
      // Customer is credited the grand total; any rounding goes to Round Off (mirror image of a sales invoice)
      if (Math.abs(roundOff) > 0.001) {
        entries.push({
          ledger_id: roundLedger ? roundLedger.id : 13,
          debit_amount: roundOff > 0 ? r2(roundOff) : 0, credit_amount: roundOff > 0 ? 0 : r2(Math.abs(roundOff)), particulars: 'Round Off A/c'
        });
      }
      entries.push({ ledger_id: partyLedgerId, debit_amount: 0, credit_amount: r2(grandTotal), particulars: party ? party.name : '' });
    } else if (voucherType === 'Debit Note') {
      const purchaseLedger = find(ledgers, (l) => l.name.includes('Purchase Account') || l.group_name === 'Purchase Accounts');
      const tax = (name, fallback) => find(ledgers, (l) => l.name === name) || { id: fallback };
      if (!purchaseLedger) throw new Error('No Purchase ledger found to reverse the purchase against.');
      entries.push({ ledger_id: partyLedgerId, debit_amount: r2(grandTotal), credit_amount: 0, particulars: party ? party.name : '' });
      entries.push({ ledger_id: purchaseLedger.id, debit_amount: 0, credit_amount: r2(subtotal), particulars: purchaseLedger.name });
      if (isInterState) {
        entries.push({ ledger_id: tax('Input IGST 18%', 9).id, debit_amount: 0, credit_amount: r2(igst), particulars: 'Input IGST 18%' });
      } else {
        entries.push({ ledger_id: tax('Input CGST 9%', 7).id, debit_amount: 0, credit_amount: r2(cgst), particulars: 'Input CGST 9%' });
        entries.push({ ledger_id: tax('Input SGST 9%', 8).id, debit_amount: 0, credit_amount: r2(sgst), particulars: 'Input SGST 9%' });
      }
      // Supplier is debited the grand total; credits are subtotal + tax (raw total), so Round Off absorbs the difference
      if (Math.abs(roundOff) > 0.001) {
        entries.push({
          ledger_id: roundLedger ? roundLedger.id : 13,
          debit_amount: roundOff > 0 ? 0 : r2(Math.abs(roundOff)), credit_amount: roundOff > 0 ? r2(roundOff) : 0, particulars: 'Round Off A/c'
        });
      }
    } else {
      throw new Error('returnEntries only handles Credit Note and Debit Note.');
    }
    return entries;
  }

  const api = { returnEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RRECompose = api;
})(typeof window !== 'undefined' ? window : globalThis);

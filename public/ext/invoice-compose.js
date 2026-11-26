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
  function findTax(ledgers, isOutput, part) {
    const prefix = isOutput ? 'output' : 'input';
    const re = new RegExp(`^${prefix}\\s+${part}(?:\\s+\\d+%?)?$`, 'i');
    return find(ledgers, (l) => re.test(String(l.name || '').trim()))
      || find(ledgers, (l) => { const n = String(l.name || '').toLowerCase(); return n.includes(prefix) && n.includes(part.toLowerCase()); });
  }
  function findRoundOff(ledgers) {
    return find(ledgers, (l) => l.name === 'Round Off A/c') || find(ledgers, (l) => /round\s*off/i.test(String(l.name || '')));
  }

  function returnEntries(o) {
    const { voucherType, party, partyLedgerId, subtotal, cgst, sgst, igst, grandTotal, roundOff, isInterState, ledgers } = o;
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const roundLedger = findRoundOff(ledgers);
    const entries = [];

    if (voucherType === 'Credit Note') {
      const salesLedger = find(ledgers, (l) => l.name.includes('Sales Account') || l.group_name === 'Sales Accounts');
      if (!salesLedger) throw new Error('No Sales ledger found to reverse the sale against.');
      entries.push({ ledger_id: salesLedger.id, debit_amount: r2(subtotal), credit_amount: 0, particulars: salesLedger.name });
      if (isInterState) {
        const ig = findTax(ledgers, true, 'IGST');
        if (!ig) throw new Error('Output IGST ledger not found.');
        entries.push({ ledger_id: ig.id, debit_amount: r2(igst), credit_amount: 0, particulars: ig.name });
      } else {
        const cg = findTax(ledgers, true, 'CGST'), sg = findTax(ledgers, true, 'SGST');
        if (!cg || !sg) throw new Error('Output CGST/SGST ledgers not found.');
        entries.push({ ledger_id: cg.id, debit_amount: r2(cgst), credit_amount: 0, particulars: cg.name });
        entries.push({ ledger_id: sg.id, debit_amount: r2(sgst), credit_amount: 0, particulars: sg.name });
      }
      // Customer is credited the grand total; any rounding goes to Round Off (mirror image of a sales invoice)
      if (Math.abs(roundOff) > 0.001) {
        if (!roundLedger) throw new Error('Round Off A/c ledger not found.');
        entries.push({
          ledger_id: roundLedger.id,
          debit_amount: roundOff > 0 ? r2(roundOff) : 0, credit_amount: roundOff > 0 ? 0 : r2(Math.abs(roundOff)), particulars: roundLedger.name
        });
      }
      entries.push({ ledger_id: partyLedgerId, debit_amount: 0, credit_amount: r2(grandTotal), particulars: party ? party.name : '' });
    } else if (voucherType === 'Debit Note') {
      const purchaseLedger = find(ledgers, (l) => l.name.includes('Purchase Account') || l.group_name === 'Purchase Accounts');
      if (!purchaseLedger) throw new Error('No Purchase ledger found to reverse the purchase against.');
      entries.push({ ledger_id: partyLedgerId, debit_amount: r2(grandTotal), credit_amount: 0, particulars: party ? party.name : '' });
      entries.push({ ledger_id: purchaseLedger.id, debit_amount: 0, credit_amount: r2(subtotal), particulars: purchaseLedger.name });
      if (isInterState) {
        const ig = findTax(ledgers, false, 'IGST');
        if (!ig) throw new Error('Input IGST ledger not found.');
        entries.push({ ledger_id: ig.id, debit_amount: 0, credit_amount: r2(igst), particulars: ig.name });
      } else {
        const cg = findTax(ledgers, false, 'CGST'), sg = findTax(ledgers, false, 'SGST');
        if (!cg || !sg) throw new Error('Input CGST/SGST ledgers not found.');
        entries.push({ ledger_id: cg.id, debit_amount: 0, credit_amount: r2(cgst), particulars: cg.name });
        entries.push({ ledger_id: sg.id, debit_amount: 0, credit_amount: r2(sgst), particulars: sg.name });
      }
      // Supplier is debited the grand total; credits are subtotal + tax (raw total), so Round Off absorbs the difference
      if (Math.abs(roundOff) > 0.001) {
        if (!roundLedger) throw new Error('Round Off A/c ledger not found.');
        entries.push({
          ledger_id: roundLedger.id,
          debit_amount: roundOff > 0 ? 0 : r2(Math.abs(roundOff)), credit_amount: roundOff > 0 ? r2(roundOff) : 0, particulars: roundLedger.name
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

const { all } = require('./db');

async function calculateGSTReports() {
  // 1. GSTR-1: Outward Supplies (Sales & Credit Notes)
  const salesVouchers = await all(`
    SELECT v.*, p.name as party_name, p.gstin as party_gstin, p.state as party_state, p.state_code as party_state_code
    FROM vouchers v
    JOIN ledgers p ON v.party_ledger_id = p.id
    WHERE v.voucher_type IN ('Sales', 'Credit Note')
    ORDER BY v.date ASC
  `);

  let gstr1_b2b = [];
  let gstr1_b2c = [];
  let outwardTaxable = 0;
  let outwardCGST = 0;
  let outwardSGST = 0;
  let outwardIGST = 0;

  // the lines of ALL these vouchers in one query (one query per voucher took thousands of database round trips on a large book)
  const linesByVoucher = new Map();
  for (const e of await all(`
      SELECT e.*, l.name as ledger_name, g.name as group_name
      FROM ledger_entries e
      JOIN vouchers v ON v.id = e.voucher_id
      JOIN ledgers l ON e.ledger_id = l.id
      JOIN account_groups g ON l.group_id = g.id
      WHERE v.voucher_type IN ('Sales', 'Credit Note')
      ORDER BY e.voucher_id, e.id
    `)) {
    if (!linesByVoucher.has(e.voucher_id)) linesByVoucher.set(e.voucher_id, []);
    linesByVoucher.get(e.voucher_id).push(e);
  }

  for (const v of salesVouchers) {
    const entries = linesByVoucher.get(v.id) || [];

    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    // Net = credit - debit. A Sales invoice only credits these lines (unchanged result); a Credit Note
    // debits them, so it reduces outward supplies and output tax. The party's own line is never counted.
    // Lines are classified by their LEDGER GROUP, not by label text: taxable value = ledgers in "Sales Accounts";
    // tax = CGST/SGST/IGST ledgers in "Duties & Taxes". (Matching on text such as "IGST" wrongly counted the taxable
    // value of sales booked to a ledger called "Interstate Sales (IGST)" as IGST, and missed vouchers without labels.)
    entries.forEach((e) => {
      if (e.ledger_id === v.party_ledger_id) return;
      const net = e.credit_amount - e.debit_amount;
      if (e.group_name === 'Sales Accounts') {
        taxable += net;
      } else if (e.group_name === 'Duties & Taxes') {
        const n = e.ledger_name.toUpperCase();
        if (n.includes('CGST')) cgst += net;
        else if (n.includes('SGST')) sgst += net; // also covers UTGST
        else if (n.includes('IGST')) igst += net;
      }
    });
    const isCreditNoteReduction = v.voucher_type === 'Credit Note' && taxable < 0;

    outwardTaxable += taxable;
    outwardCGST += cgst;
    outwardSGST += sgst;
    outwardIGST += igst;

    const record = {
      voucher_id: v.id,
      voucher_type: v.voucher_type,
      voucher_no: v.voucher_no,
      date: v.date,
      party_name: v.party_name,
      party_gstin: v.party_gstin,
      state: v.party_state,
      taxable_value: taxable,
      cgst,
      sgst,
      igst,
      total_invoice_value: isCreditNoteReduction ? -v.total_amount : v.total_amount
    };

    if (v.party_gstin && v.party_gstin.trim().length > 5) {
      gstr1_b2b.push(record);
    } else {
      gstr1_b2c.push(record);
    }
  }

  // 2. GSTR-3B: Inward Supplies / Eligible Input Tax Credit (ITC) from Purchases
  const purchaseEntries = await all(`
    SELECT l.name AS particulars, SUM(e.debit_amount - e.credit_amount) as total_tax
    FROM ledger_entries e
    JOIN vouchers v ON e.voucher_id = v.id
    JOIN ledgers l ON e.ledger_id = l.id
    JOIN account_groups g ON l.group_id = g.id
    WHERE v.voucher_type IN ('Purchase', 'Debit Note')
    AND g.name = 'Duties & Taxes'
    AND l.name LIKE 'Input %'
    GROUP BY l.name
  `);

  let itcCGST = 0;
  let itcSGST = 0;
  let itcIGST = 0;

  purchaseEntries.forEach((p) => {
    if (p.particulars.includes('CGST')) itcCGST += p.total_tax;
    if (p.particulars.includes('SGST')) itcSGST += p.total_tax;
    if (p.particulars.includes('IGST')) itcIGST += p.total_tax;
  });

  const netCGST = outwardCGST - itcCGST;
  const netSGST = outwardSGST - itcSGST;
  const netIGST = outwardIGST - itcIGST;
  const netPayable = (netCGST > 0 ? netCGST : 0) + (netSGST > 0 ? netSGST : 0) + (netIGST > 0 ? netIGST : 0);

  return {
    gstr1: {
      b2b_invoices: gstr1_b2b,
      b2c_invoices: gstr1_b2c,
      total_taxable: outwardTaxable,
      total_cgst: outwardCGST,
      total_sgst: outwardSGST,
      total_igst: outwardIGST,
      total_outward_tax: outwardCGST + outwardSGST + outwardIGST
    },
    gstr3b: {
      table_3_1_outward: {
        taxable: outwardTaxable,
        cgst: outwardCGST,
        sgst: outwardSGST,
        igst: outwardIGST
      },
      table_4_itc: {
        cgst: itcCGST,
        sgst: itcSGST,
        igst: itcIGST,
        total_itc: itcCGST + itcSGST + itcIGST
      },
      net_payable: {
        cgst: netCGST,
        sgst: netSGST,
        igst: netIGST,
        total_payable: netPayable
      }
    }
  };
}

module.exports = {
  calculateGSTReports
};

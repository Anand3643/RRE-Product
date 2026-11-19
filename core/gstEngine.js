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

  for (const v of salesVouchers) {
    const entries = await all(`
      SELECT e.*, l.name as ledger_name
      FROM ledger_entries e
      JOIN ledgers l ON e.ledger_id = l.id
      WHERE e.voucher_id = ?
    `, [v.id]);

    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    entries.forEach((e) => {
      if (e.particulars.includes('Sales')) taxable += e.credit_amount;
      if (e.particulars.includes('CGST')) cgst += e.credit_amount;
      if (e.particulars.includes('SGST')) sgst += e.credit_amount;
      if (e.particulars.includes('IGST')) igst += e.credit_amount;
    });

    outwardTaxable += taxable;
    outwardCGST += cgst;
    outwardSGST += sgst;
    outwardIGST += igst;

    const record = {
      voucher_id: v.id,
      voucher_no: v.voucher_no,
      date: v.date,
      party_name: v.party_name,
      party_gstin: v.party_gstin,
      state: v.party_state,
      taxable_value: taxable,
      cgst,
      sgst,
      igst,
      total_invoice_value: v.total_amount
    };

    if (v.party_gstin && v.party_gstin.trim().length > 5) {
      gstr1_b2b.push(record);
    } else {
      gstr1_b2c.push(record);
    }
  }

  // 2. GSTR-3B: Inward Supplies / Eligible Input Tax Credit (ITC) from Purchases
  const purchaseEntries = await all(`
    SELECT e.particulars, SUM(e.debit_amount) as total_tax
    FROM ledger_entries e
    JOIN vouchers v ON e.voucher_id = v.id
    WHERE v.voucher_type IN ('Purchase', 'Debit Note')
    AND e.particulars LIKE 'Input %'
    GROUP BY e.particulars
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

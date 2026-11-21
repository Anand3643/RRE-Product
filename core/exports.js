/**
 * RRE Tally — CSV dataset generators shared by one-click export and scheduled reports.
 * Read-only: SELECTs only.
 */
const { all } = require('./db');
const { getStockPositions, getOpenBills } = require('./analytics');

// Neutralises spreadsheet formula injection in text cells and quotes per RFC 4180.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (headers, rows) =>
  '﻿' + [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

const DATASETS = {
  vouchers: async (q = {}) => {
    const params = [];
    let where = '1=1';
    if (q.from_date) { where += ' AND v.date >= ?'; params.push(q.from_date); }
    if (q.to_date) { where += ' AND v.date <= ?'; params.push(q.to_date); }
    if (q.type) { where += ' AND v.voucher_type = ?'; params.push(q.type); }
    const rows = await all(`
      SELECT v.date, v.voucher_type, v.voucher_no, v.reference_no, p.name AS party, v.total_amount, v.narration
      FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id WHERE ${where}
      ORDER BY v.date, v.id`, params);
    return { rows: rows.length, csv: toCsv(['Date', 'Type', 'Voucher No', 'Reference', 'Party', 'Amount', 'Narration'],
      rows.map((r) => [r.date, r.voucher_type, r.voucher_no, r.reference_no, r.party, r.total_amount, r.narration])) };
  },
  ledgers: async () => {
    const rows = await all(`
      SELECT l.name, g.name AS grp, l.opening_balance, l.opening_balance_type, l.gstin, l.pan, l.state
      FROM ledgers l JOIN account_groups g ON l.group_id = g.id ORDER BY l.name`);
    return { rows: rows.length, csv: toCsv(['Ledger', 'Group', 'Opening Balance', 'Dr/Cr', 'GSTIN', 'PAN', 'State'],
      rows.map((r) => [r.name, r.grp, r.opening_balance, r.opening_balance_type, r.gstin, r.pan, r.state])) };
  },
  'stock-items': async () => {
    const pos = await getStockPositions();
    return { rows: pos.length, csv: toCsv(['Item', 'HSN', 'Opening Qty', 'Inward', 'Outward', 'Current Qty', 'Reorder Level'],
      pos.map((p) => [p.name, p.hsn_code, p.opening_qty, p.qty_in, p.qty_out, p.current_qty, p.reorder_level])) };
  },
  outstandings: async () => {
    const { receivables, payables } = await getOpenBills();
    const rows = [
      ...receivables.map((b) => ['Receivable', b]),
      ...payables.map((b) => ['Payable', b])
    ].map(([k, b]) => [k, b.ledger_name, b.bill_ref, b.bill_date, b.due_date, b.original_amount, b.cleared_amount, b.pending_amount]);
    return { rows: rows.length, csv: toCsv(['Kind', 'Party', 'Bill Ref', 'Bill Date', 'Due Date', 'Original', 'Cleared', 'Pending'], rows) };
  }
};

module.exports = { csvCell, toCsv, DATASETS };

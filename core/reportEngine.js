// ========================================================
// Report Center Engine — every report returns one shape:
// { title, subtitle, columns:[{key,label,type}], rows, totals, kpis }
// so it can be shown on screen, exported to CSV, or printed to PDF.
// ========================================================
const { all, get } = require('./db');

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().split('T')[0];
const inr = (n) => '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function addDays(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().split('T')[0];
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function sumCols(rows, keys) {
  const t = {};
  keys.forEach((k) => { t[k] = round2(rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0)); });
  return t;
}
function period(f) {
  if (f.from_date && f.to_date) return `Period: ${f.from_date} to ${f.to_date}`;
  if (f.from_date) return `From ${f.from_date}`;
  if (f.to_date) return `Up to ${f.to_date}`;
  return 'All dates';
}
function dateClause(alias, f, params) {
  let s = '';
  if (f.from_date) { s += ` AND ${alias}.date >= ?`; params.push(f.from_date); }
  if (f.to_date) { s += ` AND ${alias}.date <= ?`; params.push(f.to_date); }
  return s;
}

// Tax split for a posted Sales voucher, derived from its ledger lines
async function salesVoucherBreakup(voucherIds) {
  if (!voucherIds.length) return {};
  const rows = await all(
    `SELECT e.voucher_id, l.name, e.debit_amount, e.credit_amount, g.name AS group_name
     FROM ledger_entries e JOIN ledgers l ON e.ledger_id = l.id JOIN account_groups g ON l.group_id = g.id
     WHERE e.voucher_id IN (${voucherIds.map(() => '?').join(',')})`,
    voucherIds
  );
  const map = {};
  for (const r of rows) {
    const m = (map[r.voucher_id] = map[r.voucher_id] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    const net = r.credit_amount - r.debit_amount;
    if (/CGST/i.test(r.name)) m.cgst += net;
    else if (/SGST/i.test(r.name)) m.sgst += net;
    else if (/IGST/i.test(r.name)) m.igst += net;
    else if (r.group_name === 'Sales Accounts' || /sales/i.test(r.name)) m.taxable += net;
  }
  return map;
}

const REPORTS = {
  // ---------------- QUOTATIONS ----------------
  'quotation-register': {
    title: 'Quotation Register',
    group: 'Quotations',
    description: 'Every quote with status, value, validity and follow-up date.',
    async build(f) {
      const params = [];
      let sql = `SELECT q.*, COALESCE(NULLIF(q.customer_name,''), l.name) AS customer, v.voucher_no AS invoice_no
                 FROM quotations q LEFT JOIN ledgers l ON q.party_ledger_id = l.id LEFT JOIN vouchers v ON q.converted_voucher_id = v.id
                 WHERE 1=1` + dateClause('q', f, params);
      if (f.status) { sql += ' AND q.status = ?'; params.push(f.status); }
      sql += ' ORDER BY q.date DESC, q.id DESC';
      const rows = (await all(sql, params)).map((q) => ({
        date: q.date, quote_no: q.quote_no, customer: q.customer, subject: q.subject, status: q.status,
        expiry_date: q.expiry_date, next_followup_date: q.next_followup_date || '', invoice_no: q.invoice_no || '',
        taxable_amount: q.taxable_amount, tax: round2(q.cgst + q.sgst + q.igst), total: q.total
      }));
      const won = rows.filter((r) => ['Accepted', 'Invoiced'].includes(r.status));
      const decided = rows.filter((r) => ['Accepted', 'Invoiced', 'Declined', 'Expired'].includes(r.status));
      return {
        subtitle: period(f) + (f.status ? ` · Status: ${f.status}` : ''),
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'quote_no', label: 'Quote #' },
          { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' },
          { key: 'expiry_date', label: 'Valid Till', type: 'date' }, { key: 'next_followup_date', label: 'Next Follow-up', type: 'date' },
          { key: 'invoice_no', label: 'Invoice #' }, { key: 'taxable_amount', label: 'Taxable', type: 'money' },
          { key: 'tax', label: 'GST', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }
        ],
        rows,
        totals: sumCols(rows, ['taxable_amount', 'tax', 'total']),
        kpis: [
          { label: 'Quotes', value: rows.length },
          { label: 'Quoted Value', value: inr(rows.reduce((s, r) => s + r.total, 0)) },
          { label: 'Won Value', value: inr(won.reduce((s, r) => s + r.total, 0)) },
          { label: 'Conversion', value: decided.length ? `${Math.round((won.length / decided.length) * 1000) / 10}%` : '—' }
        ]
      };
    }
  },

  'quotation-by-customer': {
    title: 'Quotation Summary by Customer',
    group: 'Quotations',
    description: 'Quotes, won value and conversion rate per customer.',
    async build(f) {
      const params = [];
      const sql = `SELECT COALESCE(NULLIF(q.customer_name,''), l.name) AS customer, q.status, q.total
                   FROM quotations q LEFT JOIN ledgers l ON q.party_ledger_id = l.id WHERE 1=1` + dateClause('q', f, params);
      const agg = {};
      for (const r of await all(sql, params)) {
        const a = (agg[r.customer] = agg[r.customer] || { customer: r.customer, quotes: 0, quoted_value: 0, won: 0, won_value: 0, lost: 0, open_value: 0 });
        a.quotes++;
        a.quoted_value += r.total;
        if (['Accepted', 'Invoiced'].includes(r.status)) { a.won++; a.won_value += r.total; }
        else if (['Declined', 'Expired'].includes(r.status)) a.lost++;
        else if (['Draft', 'Sent'].includes(r.status)) a.open_value += r.total;
      }
      const rows = Object.values(agg)
        .map((a) => ({ ...a, conversion: a.won + a.lost ? (a.won / (a.won + a.lost)) * 100 : 0 }))
        .sort((x, y) => y.quoted_value - x.quoted_value);
      return {
        subtitle: period(f),
        columns: [
          { key: 'customer', label: 'Customer' }, { key: 'quotes', label: 'Quotes', type: 'number' },
          { key: 'quoted_value', label: 'Quoted Value', type: 'money' }, { key: 'open_value', label: 'Open Pipeline', type: 'money' },
          { key: 'won', label: 'Won', type: 'number' }, { key: 'won_value', label: 'Won Value', type: 'money' },
          { key: 'conversion', label: 'Conversion', type: 'percent' }
        ],
        rows,
        totals: sumCols(rows, ['quotes', 'quoted_value', 'open_value', 'won', 'won_value'])
      };
    }
  },

  'followup-due': {
    title: 'Follow-up Due List',
    group: 'Quotations',
    description: 'Open quotes whose next follow-up is overdue, today, or in the next 7 days.',
    async build() {
      const t = today();
      const rows = (await all(
        `SELECT q.id, q.quote_no, q.date, q.status, q.total, q.next_followup_date, q.customer_phone, q.salesperson,
                COALESCE(NULLIF(q.customer_name,''), l.name) AS customer,
                (SELECT f.notes FROM quotation_followups f WHERE f.quotation_id = q.id ORDER BY f.followup_date DESC, f.id DESC LIMIT 1) AS last_note,
                (SELECT COUNT(*) FROM quotation_followups f WHERE f.quotation_id = q.id) AS attempts
         FROM quotations q LEFT JOIN ledgers l ON q.party_ledger_id = l.id
         WHERE q.status IN ('Draft','Sent','Accepted') AND q.next_followup_date IS NOT NULL AND q.next_followup_date <> '' AND q.next_followup_date <= ?
         ORDER BY q.next_followup_date ASC`,
        [addDays(t, 7)]
      )).map((r) => {
        const d = daysBetween(t, r.next_followup_date);
        return { ...r, when: d < 0 ? `Overdue ${-d}d` : d === 0 ? 'Today' : `In ${d}d`, last_note: r.last_note || '' };
      });
      return {
        subtitle: `As on ${t}`,
        columns: [
          { key: 'next_followup_date', label: 'Follow-up On', type: 'date' }, { key: 'when', label: 'When' },
          { key: 'quote_no', label: 'Quote #' }, { key: 'customer', label: 'Customer' }, { key: 'customer_phone', label: 'Phone' },
          { key: 'status', label: 'Status' }, { key: 'attempts', label: 'Attempts', type: 'number' },
          { key: 'last_note', label: 'Last Note' }, { key: 'total', label: 'Value', type: 'money' }
        ],
        rows,
        totals: sumCols(rows, ['total']),
        kpis: [
          { label: 'Overdue', value: rows.filter((r) => r.next_followup_date < t).length },
          { label: 'Due Today', value: rows.filter((r) => r.next_followup_date === t).length },
          { label: 'Next 7 Days', value: rows.filter((r) => r.next_followup_date > t).length },
          { label: 'Value at Stake', value: inr(rows.reduce((s, r) => s + r.total, 0)) }
        ]
      };
    }
  },

  'followup-activity': {
    title: 'Follow-up Activity Log',
    group: 'Quotations',
    description: 'All logged calls, emails, visits and their outcomes.',
    async build(f) {
      const params = [];
      let sql = `SELECT f.*, q.quote_no, q.total, COALESCE(NULLIF(q.customer_name,''), l.name) AS customer
                 FROM quotation_followups f JOIN quotations q ON f.quotation_id = q.id LEFT JOIN ledgers l ON q.party_ledger_id = l.id WHERE 1=1`;
      if (f.from_date) { sql += ' AND f.followup_date >= ?'; params.push(f.from_date); }
      if (f.to_date) { sql += ' AND f.followup_date <= ?'; params.push(f.to_date); }
      sql += ' ORDER BY f.followup_date DESC, f.id DESC';
      const rows = await all(sql, params);
      const byMode = {};
      rows.forEach((r) => { byMode[r.mode] = (byMode[r.mode] || 0) + 1; });
      return {
        subtitle: period(f),
        columns: [
          { key: 'followup_date', label: 'Date', type: 'date' }, { key: 'quote_no', label: 'Quote #' },
          { key: 'customer', label: 'Customer' }, { key: 'mode', label: 'Mode' }, { key: 'outcome', label: 'Outcome' },
          { key: 'notes', label: 'Notes' }, { key: 'next_followup_date', label: 'Next', type: 'date' }, { key: 'done_by', label: 'By' }
        ],
        rows,
        kpis: [{ label: 'Activities', value: rows.length }, ...Object.entries(byMode).map(([k, v]) => ({ label: k, value: v }))]
      };
    }
  },

  // ---------------- SALES ----------------
  'sales-register': {
    title: 'Sales Register',
    group: 'Sales',
    description: 'Invoice-wise taxable value and GST split.',
    async build(f) {
      const params = [];
      const vs = await all(
        `SELECT v.id, v.date, v.voucher_no, v.reference_no, v.total_amount, p.name AS party, p.gstin
         FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id
         WHERE v.voucher_type = 'Sales'` + dateClause('v', f, params) + ' ORDER BY v.date ASC, v.id ASC',
        params
      );
      const br = await salesVoucherBreakup(vs.map((v) => v.id));
      const rows = vs.map((v) => {
        const b = br[v.id] || {};
        return {
          date: v.date, voucher_no: v.voucher_no, party: v.party || '', gstin: v.gstin || '', reference_no: v.reference_no || '',
          taxable: round2(b.taxable), cgst: round2(b.cgst), sgst: round2(b.sgst), igst: round2(b.igst), total: v.total_amount
        };
      });
      const tot = sumCols(rows, ['taxable', 'cgst', 'sgst', 'igst', 'total']);
      return {
        subtitle: period(f),
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'voucher_no', label: 'Invoice #' }, { key: 'party', label: 'Customer' },
          { key: 'gstin', label: 'GSTIN' }, { key: 'reference_no', label: 'Ref' }, { key: 'taxable', label: 'Taxable', type: 'money' },
          { key: 'cgst', label: 'CGST', type: 'money' }, { key: 'sgst', label: 'SGST', type: 'money' }, { key: 'igst', label: 'IGST', type: 'money' },
          { key: 'total', label: 'Invoice Value', type: 'money' }
        ],
        rows,
        totals: tot,
        kpis: [
          { label: 'Invoices', value: rows.length }, { label: 'Taxable', value: inr(tot.taxable) },
          { label: 'GST', value: inr(tot.cgst + tot.sgst + tot.igst) }, { label: 'Gross Sales', value: inr(tot.total) }
        ]
      };
    }
  },

  'sales-by-customer': {
    title: 'Sales by Customer',
    group: 'Sales',
    description: 'Invoice count and value per customer, ranked.',
    async build(f) {
      const params = [];
      const rows = await all(
        `SELECT COALESCE(p.name, '(No party)') AS customer, COUNT(*) AS invoices, ROUND(SUM(v.total_amount), 2) AS total,
                MAX(v.date) AS last_invoice
         FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id
         WHERE v.voucher_type = 'Sales'` + dateClause('v', f, params) + ' GROUP BY p.id ORDER BY total DESC',
        params
      );
      const grand = rows.reduce((s, r) => s + r.total, 0);
      rows.forEach((r) => { r.share = grand ? (r.total / grand) * 100 : 0; r.average = r.invoices ? round2(r.total / r.invoices) : 0; });
      return {
        subtitle: period(f),
        columns: [
          { key: 'customer', label: 'Customer' }, { key: 'invoices', label: 'Invoices', type: 'number' },
          { key: 'average', label: 'Avg Invoice', type: 'money' }, { key: 'last_invoice', label: 'Last Invoice', type: 'date' },
          { key: 'share', label: 'Share', type: 'percent' }, { key: 'total', label: 'Sales Value', type: 'money' }
        ],
        rows,
        totals: sumCols(rows, ['invoices', 'total'])
      };
    }
  },

  'sales-by-item': {
    title: 'Sales by Item',
    group: 'Sales',
    description: 'Quantity sold, average rate and value per stock item.',
    async build(f) {
      const params = [];
      const rows = await all(
        `SELECT s.name AS item, s.hsn_code AS hsn, u.symbol AS uom, ROUND(SUM(i.quantity), 2) AS qty,
                ROUND(SUM(i.amount), 2) AS value, COUNT(DISTINCT v.id) AS invoices
         FROM inventory_entries i JOIN vouchers v ON i.voucher_id = v.id
         JOIN stock_items s ON i.stock_item_id = s.id LEFT JOIN units_of_measure u ON s.uom_id = u.id
         WHERE v.voucher_type = 'Sales' AND i.direction = 'OUT'` + dateClause('v', f, params) + ' GROUP BY s.id ORDER BY value DESC',
        params
      );
      rows.forEach((r) => { r.avg_rate = r.qty ? round2(r.value / r.qty) : 0; });
      return {
        subtitle: period(f),
        columns: [
          { key: 'item', label: 'Item' }, { key: 'hsn', label: 'HSN' }, { key: 'uom', label: 'Unit' },
          { key: 'invoices', label: 'Invoices', type: 'number' }, { key: 'qty', label: 'Qty Sold', type: 'money' },
          { key: 'avg_rate', label: 'Avg Rate', type: 'money' }, { key: 'value', label: 'Value', type: 'money' }
        ],
        rows,
        totals: sumCols(rows, ['value'])
      };
    }
  },

  'receivables-ageing': {
    title: 'Receivables Ageing',
    group: 'Sales',
    description: 'Unpaid customer bills bucketed by days past due.',
    async build() {
      const t = today();
      const allocs = await all(
        `SELECT b.*, v.voucher_no, v.date, l.name AS ledger_name, g.name AS group_name
         FROM bill_allocations b JOIN vouchers v ON b.voucher_id = v.id JOIN ledgers l ON b.ledger_id = l.id
         JOIN account_groups g ON l.group_id = g.id WHERE g.name = 'Sundry Debtors' ORDER BY b.id`
      );
      const bills = {};
      for (const a of allocs) {
        const key = `${a.ledger_id}|${a.bill_ref}`;
        const b = (bills[key] = bills[key] || { customer: a.ledger_name, bill_ref: a.bill_ref, bill_date: a.date, due_date: a.due_date || a.date, original: 0, cleared: 0 });
        if (a.bill_type === 'New Ref') { b.original += a.amount; b.bill_date = a.date; b.due_date = a.due_date || a.date; }
        else if (a.bill_type === 'Agst Ref') b.cleared += a.amount;
      }
      const rows = Object.values(bills)
        .map((b) => {
          const pending = round2(b.original - b.cleared);
          const od = Math.max(0, daysBetween(b.due_date, t));
          return {
            ...b, pending, days_overdue: od,
            b_current: od === 0 ? pending : 0, b_30: od > 0 && od <= 30 ? pending : 0,
            b_60: od > 30 && od <= 60 ? pending : 0, b_90: od > 60 && od <= 90 ? pending : 0, b_90p: od > 90 ? pending : 0
          };
        })
        .filter((r) => r.pending > 0.01)
        .sort((a, b) => b.days_overdue - a.days_overdue);
      const tot = sumCols(rows, ['pending', 'b_current', 'b_30', 'b_60', 'b_90', 'b_90p']);
      return {
        subtitle: `As on ${t}`,
        columns: [
          { key: 'customer', label: 'Customer' }, { key: 'bill_ref', label: 'Bill Ref' }, { key: 'bill_date', label: 'Bill Date', type: 'date' },
          { key: 'due_date', label: 'Due Date', type: 'date' }, { key: 'b_current', label: 'Not Due', type: 'money' },
          { key: 'b_30', label: '1-30', type: 'money' }, { key: 'b_60', label: '31-60', type: 'money' },
          { key: 'b_90', label: '61-90', type: 'money' }, { key: 'b_90p', label: '>90', type: 'money' }, { key: 'pending', label: 'Pending', type: 'money' }
        ],
        rows,
        totals: tot,
        kpis: [
          { label: 'Total Receivable', value: inr(tot.pending) },
          { label: 'Overdue', value: inr(tot.pending - tot.b_current) },
          { label: '>90 Days', value: inr(tot.b_90p) },
          { label: 'Open Bills', value: rows.length }
        ]
      };
    }
  }
};

function listReports() {
  return Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, group: r.group, description: r.description }));
}

async function buildReport(id, filters = {}) {
  const def = REPORTS[id];
  if (!def) return null;
  const out = await def.build(filters);
  return { id, title: def.title, ...out };
}

module.exports = { listReports, buildReport };

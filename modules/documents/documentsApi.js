// ========================================================
// Documents & Report Center API
//   GET /api/documents/quotation/:id          printable HTML (toolbar)
//   GET /api/documents/quotation/:id/pdf      PDF download
//   GET /api/documents/invoice/:voucherId     printable HTML
//   GET /api/documents/invoice/:voucherId/pdf PDF download
//   GET /api/report-center                    catalogue
//   GET /api/report-center/:id?format=json|csv|html|pdf&from_date&to_date&status
// ========================================================
const express = require('express');
const { all, get } = require('../../core/db');
const { renderQuotation, renderInvoice, renderReport, reportToCsv } = require('../../core/documentTemplates');
const { htmlToPdf, isPdfAvailable } = require('../../core/pdfEngine');
const { listReports, buildReport } = require('../../core/reportEngine');
const { loadQuotation } = require('../quotations/quotationsApi');

const documentsRouter = express.Router();
const reportCenterRouter = express.Router();

const safeName = (s) => String(s || 'document').replace(/[^A-Za-z0-9._-]+/g, '_');

async function getCompany() {
  return (await get('SELECT * FROM company_info WHERE id = 1')) || (await get('SELECT * FROM company_info LIMIT 1')) || {};
}

function sendHtml(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

/**
 * Sends a real PDF when the bundled Chromium is available (desktop app);
 * otherwise sends the print view and opens the browser's Save-as-PDF dialog.
 */
async function sendPdf(res, html, filename) {
  if (isPdfAvailable()) {
    const buf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(filename)}.pdf"`);
    return res.send(buf);
  }
  const auto = html.replace('</body>', '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script></body>');
  return sendHtml(res, auto);
}

// ---------------- Quotation ----------------
documentsRouter.get('/quotation/:id', async (req, res) => {
  try {
    const q = await loadQuotation(req.params.id);
    if (!q) return res.status(404).send('Quotation not found');
    sendHtml(res, renderQuotation(q, await getCompany(), { withToolbar: true, pdfHref: `/api/documents/quotation/${q.id}/pdf` }));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

documentsRouter.get('/quotation/:id/pdf', async (req, res) => {
  try {
    const q = await loadQuotation(req.params.id);
    if (!q) return res.status(404).send('Quotation not found');
    await sendPdf(res, renderQuotation(q, await getCompany()), `Quote_${q.quote_no}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ---------------- Invoice (posted Sales voucher) ----------------
async function loadInvoice(voucherId) {
  const v = await get(
    `SELECT v.*, p.name AS party_name, p.gstin AS party_gstin, p.address AS party_address, p.state AS party_state, p.state_code AS party_state_code
     FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id WHERE v.id = ?`,
    [voucherId]
  );
  if (!v) return null;

  const entries = await all(
    `SELECT e.*, l.name AS ledger_name, g.name AS group_name FROM ledger_entries e
     JOIN ledgers l ON e.ledger_id = l.id JOIN account_groups g ON l.group_id = g.id WHERE e.voucher_id = ? ORDER BY e.id`,
    [v.id]
  );
  const inv = await all(
    `SELECT i.*, s.name AS item_name, s.hsn_code, s.gst_rate, u.symbol AS uom FROM inventory_entries i
     JOIN stock_items s ON i.stock_item_id = s.id LEFT JOIN units_of_measure u ON s.uom_id = u.id WHERE i.voucher_id = ? ORDER BY i.id`,
    [v.id]
  );

  // Use the source quotation's lines when available (keeps descriptions & per-line GST)
  const quote = await get('SELECT id, discount_pct FROM quotations WHERE converted_voucher_id = ?', [v.id]);
  let items;
  let discountPct = 0;
  if (quote) {
    items = await all('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id', [quote.id]);
    discountPct = quote.discount_pct || 0;
  } else if (inv.length) {
    items = inv.map((i) => ({ item_name: i.item_name, hsn_code: i.hsn_code, uom: i.uom, quantity: i.quantity, rate: i.rate, discount_pct: i.discount_pct, gst_rate: i.gst_rate, amount: i.amount }));
  } else {
    // Service / accounting-mode invoice: show income ledgers as lines
    items = entries
      .filter((e) => e.ledger_id !== v.party_ledger_id && !/GST|Round/i.test(e.ledger_name) && e.credit_amount > 0)
      .map((e) => ({ item_name: e.ledger_name, quantity: 1, rate: e.credit_amount, amount: e.credit_amount, gst_rate: null }));
  }

  const sum = (re) => entries.filter((e) => re.test(e.ledger_name)).reduce((s, e) => s + (e.credit_amount - e.debit_amount), 0);
  const cgst = sum(/CGST/i);
  const sgst = sum(/SGST/i);
  const igst = sum(/IGST/i);
  const roundOff = sum(/Round/i);
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const total = v.total_amount;
  const taxable = total - cgst - sgst - igst - roundOff;
  const discountAmount = Math.max(0, Math.round((subtotal - taxable) * 100) / 100);

  // Payments received against this bill
  const bill = await get("SELECT bill_ref, due_date FROM bill_allocations WHERE voucher_id = ? AND bill_type = 'New Ref' LIMIT 1", [v.id]);
  let paid = 0;
  if (bill) {
    const r = await get("SELECT COALESCE(SUM(amount), 0) AS paid FROM bill_allocations WHERE bill_type = 'Agst Ref' AND bill_ref = ? AND ledger_id = ?", [bill.bill_ref, v.party_ledger_id]);
    paid = r ? r.paid : 0;
  }

  return {
    ...v,
    items,
    subtotal,
    discount_pct: discountPct,
    discount_amount: discountAmount > 0.01 && discountAmount < subtotal ? discountAmount : 0,
    cgst, sgst, igst,
    round_off: roundOff,
    shipping_charges: 0,
    total,
    paid,
    balance_due: Math.max(0, total - paid),
    due_date: bill ? bill.due_date : null
  };
}

documentsRouter.get('/invoice/:id', async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).send('Voucher not found');
    sendHtml(res, renderInvoice(inv, await getCompany(), { withToolbar: true, pdfHref: `/api/documents/invoice/${inv.id}/pdf` }));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

documentsRouter.get('/invoice/:id/pdf', async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).send('Voucher not found');
    await sendPdf(res, renderInvoice(inv, await getCompany()), `Invoice_${inv.voucher_no}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

documentsRouter.get('/capabilities', (req, res) => {
  res.json({ success: true, native_pdf: isPdfAvailable() });
});

// ---------------- Report Center ----------------
reportCenterRouter.get('/', (req, res) => {
  res.json({ success: true, data: listReports(), native_pdf: isPdfAvailable() });
});

reportCenterRouter.get('/:id', async (req, res) => {
  try {
    const filters = {
      from_date: req.query.from_date || '',
      to_date: req.query.to_date || '',
      status: req.query.status || '',
      ledger_id: req.query.ledger_id || ''
    };
    const report = await buildReport(req.params.id, filters);
    if (!report) return res.status(404).json({ success: false, error: 'Unknown report' });

    const format = (req.query.format || 'json').toLowerCase();
    const fname = `${report.title}_${new Date().toISOString().slice(0, 10)}`;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(fname)}.csv"`);
      return res.send(reportToCsv(report));
    }
    if (format === 'html') {
      const qs = new URLSearchParams({ ...filters, format: 'pdf' }).toString();
      return sendHtml(res, renderReport(report, await getCompany(), { withToolbar: true, pdfHref: `/api/report-center/${report.id}?${qs}` }));
    }
    if (format === 'pdf') {
      return sendPdf(res, renderReport(report, await getCompany()), fname);
    }
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { documentsRouter, reportCenterRouter, loadInvoice };

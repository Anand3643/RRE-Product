const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// --- INVOICES ---

// List Invoices
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await all(`
      SELECT i.*, c.name as customer_name, c.company as customer_company, c.gstin
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      ORDER BY i.created_at DESC
    `);
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Invoice with line items
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await get(`
      SELECT i.*, c.name as customer_name, c.company as customer_company, c.email, c.phone, c.gstin, c.address, c.city, c.state
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `, [req.params.id]);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    res.json({ success: true, data: { ...invoice, items } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create GST Tax Invoice
router.post('/invoices', async (req, res) => {
  try {
    const { customer_id, sales_order_id, invoice_date, due_date, is_interstate, items, notes } = req.body;
    if (!customer_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Customer and line items are required' });
    }

    let subtotal = 0;
    const validatedItems = items.map((item) => {
      const qty = parseFloat(item.quantity) || 1;
      const price = parseFloat(item.unit_price) || 0;
      const taxRate = parseFloat(item.tax_rate) || 18;
      const lineTotal = qty * price;
      subtotal += lineTotal;
      return {
        product_id: item.product_id || null,
        description: item.description || 'Service/Product',
        hsn: item.hsn || '',
        quantity: qty,
        unit_price: price,
        tax_rate: taxRate,
        total: lineTotal
      };
    });

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (is_interstate) {
      igst = (subtotal * 0.18);
    } else {
      cgst = (subtotal * 0.09);
      sgst = (subtotal * 0.09);
    }

    const grandTotal = subtotal + cgst + sgst + igst;
    const invoiceNo = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

    const result = await run(
      `INSERT INTO invoices (invoice_no, customer_id, sales_order_id, invoice_date, due_date, subtotal, cgst, sgst, igst, total, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?)`,
      [
        invoiceNo, customer_id, sales_order_id || null,
        invoice_date || new Date().toISOString().split('T')[0],
        due_date || '',
        subtotal, cgst, sgst, igst, grandTotal,
        notes || ''
      ]
    );

    const invoiceId = result.lastID;
    for (const it of validatedItems) {
      await run(
        `INSERT INTO invoice_items (invoice_id, product_id, description, hsn, quantity, unit_price, tax_rate, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, it.product_id, it.description, it.hsn, it.quantity, it.unit_price, it.tax_rate, it.total]
      );
    }

    res.json({ success: true, id: invoiceId, invoice_no: invoiceNo, message: 'Tax invoice generated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Record Payment on Invoice
router.post('/invoices/:id/pay', async (req, res) => {
  try {
    const { amount } = req.body;
    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount required' });
    }

    const inv = await get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    if (!inv) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    const newPaid = (inv.paid_amount || 0) + payAmount;
    let newStatus = 'Partially Paid';
    if (newPaid >= inv.total) {
      newStatus = 'Paid';
    }

    await run('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [newPaid, newStatus, req.params.id]);
    res.json({ success: true, message: `Payment of ₹${payAmount.toLocaleString('en-IN')} recorded. Status: ${newStatus}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- EXPENSES ---

// List Expenses
router.get('/expenses', async (req, res) => {
  try {
    const expenses = await all('SELECT * FROM expenses ORDER BY date DESC LIMIT 100');
    const summary = await get('SELECT SUM(amount) as total_expenses FROM expenses');
    res.json({ success: true, data: { items: expenses, total: summary.total_expenses || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add Expense
router.post('/expenses', async (req, res) => {
  try {
    const { category, amount, date, description, paid_to, payment_mode } = req.body;
    const amt = parseFloat(amount);
    if (!category || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid category and positive amount required' });
    }

    const result = await run(
      `INSERT INTO expenses (category, amount, date, description, paid_to, payment_mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category, amt, date || new Date().toISOString().split('T')[0], description || '', paid_to || '', payment_mode || 'Bank Transfer']
    );

    res.json({ success: true, id: result.lastID, message: 'Expense logged successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

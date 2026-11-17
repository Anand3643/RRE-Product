const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// --- CUSTOMERS ---

// List customers
router.get('/customers', async (req, res) => {
  try {
    const customers = await all('SELECT * FROM customers ORDER BY company ASC');
    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create customer
router.post('/customers', async (req, res) => {
  try {
    const { name, company, email, phone, gstin, address, city, state, credit_limit } = req.body;
    if (!company) {
      return res.status(400).json({ success: false, error: 'Company name is required' });
    }

    const result = await run(
      `INSERT INTO customers (name, company, email, phone, gstin, address, city, state, credit_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name || '', company, email || '', phone || '', gstin || '',
        address || '', city || 'Chennai', state || 'Tamil Nadu',
        parseFloat(credit_limit) || 500000
      ]
    );

    res.json({ success: true, id: result.lastID, message: 'Customer added successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- QUOTATIONS ---

// List quotations
router.get('/quotations', async (req, res) => {
  try {
    const quotes = await all(`
      SELECT q.*, c.name as customer_name, c.company as customer_company, c.phone, c.gstin
      FROM quotations q
      JOIN customers c ON q.customer_id = c.id
      ORDER BY q.created_at DESC
    `);
    res.json({ success: true, data: quotes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single quotation with items
router.get('/quotations/:id', async (req, res) => {
  try {
    const quote = await get(`
      SELECT q.*, c.name as customer_name, c.company as customer_company, c.email, c.phone, c.gstin, c.address, c.city, c.state
      FROM quotations q
      JOIN customers c ON q.customer_id = c.id
      WHERE q.id = ?
    `, [req.params.id]);

    if (!quote) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    const items = await all('SELECT * FROM quotation_items WHERE quotation_id = ?', [quote.id]);
    res.json({ success: true, data: { ...quote, items } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create quotation with line items
router.post('/quotations', async (req, res) => {
  try {
    const { customer_id, quote_date, valid_until, items, tax_rate, notes } = req.body;
    if (!customer_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Customer and line items are required' });
    }

    const tRate = tax_rate !== undefined ? parseFloat(tax_rate) : 18;
    let subtotal = 0;
    const validatedItems = items.map((item) => {
      const qty = parseFloat(item.quantity) || 1;
      const price = parseFloat(item.unit_price) || 0;
      const discount = parseFloat(item.discount) || 0;
      const lineTotal = (qty * price) * (1 - discount / 100);
      subtotal += lineTotal;
      return {
        product_id: item.product_id || null,
        description: item.description || 'Custom Item',
        hsn: item.hsn || '',
        quantity: qty,
        unit_price: price,
        discount,
        total: lineTotal
      };
    });

    const taxAmount = (subtotal * tRate) / 100;
    const grandTotal = subtotal + taxAmount;
    const quoteNo = `QT-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

    const quoteResult = await run(
      `INSERT INTO quotations (quote_no, customer_id, quote_date, valid_until, subtotal, tax_rate, tax_amount, total, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
      [
        quoteNo, customer_id,
        quote_date || new Date().toISOString().split('T')[0],
        valid_until || '',
        subtotal, tRate, taxAmount, grandTotal,
        notes || ''
      ]
    );

    const quoteId = quoteResult.lastID;
    for (const it of validatedItems) {
      await run(
        `INSERT INTO quotation_items (quotation_id, product_id, description, hsn, quantity, unit_price, discount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [quoteId, it.product_id, it.description, it.hsn, it.quantity, it.unit_price, it.discount, it.total]
      );
    }

    res.json({ success: true, id: quoteId, quote_no: quoteNo, message: 'Quotation created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update quotation status
router.put('/quotations/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE quotations SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Quotation updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Convert quotation to Sales Order
router.post('/quotations/:id/convert-to-order', async (req, res) => {
  try {
    const quote = await get('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
    if (!quote) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    const orderNo = `SO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    const today = new Date().toISOString().split('T')[0];

    const result = await run(
      `INSERT INTO sales_orders (order_no, quotation_id, customer_id, order_date, total, status, notes)
       VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)`,
      [orderNo, quote.id, quote.customer_id, today, quote.total, `Created from Quotation ${quote.quote_no}`]
    );

    await run("UPDATE quotations SET status = 'Accepted' WHERE id = ?", [quote.id]);

    res.json({ success: true, id: result.lastID, order_no: orderNo, message: 'Converted to Sales Order' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List Sales Orders
router.get('/orders', async (req, res) => {
  try {
    const orders = await all(`
      SELECT o.*, c.name as customer_name, c.company as customer_company
      FROM sales_orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
    `);
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const {
  checkZohoConnection,
  findOrCreateContact,
  findOrCreateItem,
  pushQuotationToZoho,
  pushInvoiceToZoho
} = require('../zoho');
const { all, get } = require('../db');

// Check live connection & status
router.get('/status', async (req, res) => {
  try {
    const status = await checkZohoConnection();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync single quotation to Zoho Books Estimate
router.post('/sync-quote/:id', async (req, res) => {
  try {
    const result = await pushQuotationToZoho(req.params.id);
    res.json({ success: true, message: `Quotation pushed to Zoho Estimate #${result.estimate_number}`, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync single invoice to Zoho Books Tax Invoice
router.post('/sync-invoice/:id', async (req, res) => {
  try {
    const result = await pushInvoiceToZoho(req.params.id);
    res.json({ success: true, message: `Invoice pushed to Zoho Invoice #${result.invoice_number}`, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync single customer to Zoho Contact
router.post('/sync-customer/:id', async (req, res) => {
  try {
    const customer = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    const contactId = await findOrCreateContact(customer);
    res.json({ success: true, message: 'Customer synced to Zoho Contact', data: { zoho_contact_id: contactId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync single product to Zoho Item
router.post('/sync-product/:id', async (req, res) => {
  try {
    const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    const itemId = await findOrCreateItem(product);
    res.json({ success: true, message: 'Product synced to Zoho Item', data: { zoho_item_id: itemId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk sync all customers
router.post('/sync-all-customers', async (req, res) => {
  try {
    const customers = await all('SELECT * FROM customers');
    let synced = 0;
    let failed = 0;

    for (const c of customers) {
      try {
        await findOrCreateContact(c);
        synced++;
      } catch (e) {
        failed++;
      }
    }
    res.json({ success: true, message: `Synced ${synced} customers to Zoho Books (${failed} failed)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk sync all products
router.post('/sync-all-products', async (req, res) => {
  try {
    const products = await all('SELECT * FROM products');
    let synced = 0;
    let failed = 0;

    for (const p of products) {
      try {
        await findOrCreateItem(p);
        synced++;
      } catch (e) {
        failed++;
      }
    }
    res.json({ success: true, message: `Synced ${synced} products to Zoho Books (${failed} failed)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// View Sync Logs
router.get('/logs', async (req, res) => {
  try {
    const logs = await all('SELECT * FROM zoho_sync_logs ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

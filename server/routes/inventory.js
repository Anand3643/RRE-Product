const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// Get inventory overview with low stock warnings and valuation
router.get('/', async (req, res) => {
  try {
    const products = await all(`
      SELECT id, sku, name, category, unit, min_stock, current_stock, unit_price, cost_price,
             (current_stock * cost_price) as stock_valuation,
             CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END as is_low_stock
      FROM products
      ORDER BY is_low_stock DESC, current_stock ASC
    `);

    const summary = await get(`
      SELECT 
        COUNT(*) as total_items,
        SUM(current_stock) as total_units,
        SUM(current_stock * cost_price) as total_valuation,
        SUM(CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END) as low_stock_count
      FROM products
    `);

    res.json({
      success: true,
      data: {
        summary,
        items: products
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get inventory transactions / audit log
router.get('/transactions', async (req, res) => {
  try {
    const transactions = await all(`
      SELECT t.id, t.type, t.quantity, t.reference_no, t.notes, t.created_at,
             p.id as product_id, p.sku, p.name as product_name, p.unit
      FROM inventory_transactions t
      JOIN products p ON t.product_id = p.id
      ORDER BY t.created_at DESC
      LIMIT 100
    `);

    res.json({ success: true, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Adjust stock (Goods Receipt IN, Delivery Challan OUT, or manual ADJUST)
router.post('/adjust', async (req, res) => {
  try {
    const { product_id, type, quantity, reference_no, notes } = req.body;
    const qty = parseFloat(quantity);

    if (!product_id || !type || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, error: 'Product, valid type, and positive quantity required' });
    }

    const product = await get('SELECT id, current_stock, name FROM products WHERE id = ?', [product_id]);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    let newStock = product.current_stock;
    if (type === 'IN' || type === 'PROD_YIELD') {
      newStock += qty;
    } else if (type === 'OUT' || type === 'PROD_CONSUME') {
      if (product.current_stock < qty) {
        return res.status(400).json({
          success: false,
          error: `Insufficient stock for ${product.name}. Available: ${product.current_stock}, Requested: ${qty}`
        });
      }
      newStock -= qty;
    } else if (type === 'ADJUST') {
      newStock = qty; // direct adjustment to quantity
    } else {
      return res.status(400).json({ success: false, error: 'Invalid adjustment type' });
    }

    // Update product stock
    await run('UPDATE products SET current_stock = ? WHERE id = ?', [newStock, product_id]);

    // Record transaction
    const tx = await run(
      `INSERT INTO inventory_transactions (type, product_id, quantity, reference_no, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [type, product_id, qty, reference_no || '', notes || '']
    );

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: {
        product_id,
        new_stock: newStock,
        transaction_id: tx.lastID
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

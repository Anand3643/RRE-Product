const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// List all products with optional filters
router.get('/', async (req, res) => {
  try {
    const { category, is_assembly, search } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (is_assembly !== undefined) {
      sql += ' AND is_assembly = ?';
      params.push(parseInt(is_assembly, 10));
    }
    if (search) {
      sql += ' AND (sku LIKE ? OR name LIKE ? OR description LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY name ASC';
    const products = await all(sql, params);
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single product with BOM components
router.get('/:id', async (req, res) => {
  try {
    const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    let bom = [];
    if (product.is_assembly) {
      bom = await all(
        `SELECT b.id, b.component_product_id, b.quantity, b.unit, b.notes,
                p.sku, p.name, p.current_stock, p.unit_price, p.cost_price
         FROM bom_items b
         JOIN products p ON b.component_product_id = p.id
         WHERE b.parent_product_id = ?`,
        [product.id]
      );
    }

    res.json({ success: true, data: { ...product, bom } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create product
router.post('/', async (req, res) => {
  try {
    const {
      sku, name, category, unit, hsn_code,
      unit_price, cost_price, min_stock, current_stock,
      is_assembly, description
    } = req.body;

    if (!sku || !name || !category) {
      return res.status(400).json({ success: false, error: 'SKU, name, and category are required' });
    }

    const result = await run(
      `INSERT INTO products (sku, name, category, unit, hsn_code, unit_price, cost_price, min_stock, current_stock, is_assembly, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sku, name, category, unit || 'NOS', hsn_code || '',
        parseFloat(unit_price) || 0, parseFloat(cost_price) || 0,
        parseInt(min_stock, 10) || 5, parseInt(current_stock, 10) || 0,
        is_assembly ? 1 : 0, description || ''
      ]
    );

    res.json({ success: true, id: result.lastID, message: 'Product created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const {
      sku, name, category, unit, hsn_code,
      unit_price, cost_price, min_stock, current_stock,
      is_assembly, description
    } = req.body;

    await run(
      `UPDATE products SET
        sku = ?, name = ?, category = ?, unit = ?, hsn_code = ?,
        unit_price = ?, cost_price = ?, min_stock = ?, current_stock = ?,
        is_assembly = ?, description = ?
       WHERE id = ?`,
      [
        sku, name, category, unit, hsn_code,
        parseFloat(unit_price), parseFloat(cost_price),
        parseInt(min_stock, 10), parseInt(current_stock, 10),
        is_assembly ? 1 : 0, description,
        req.params.id
      ]
    );

    res.json({ success: true, message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add component to BOM
router.post('/:id/bom', async (req, res) => {
  try {
    const { component_product_id, quantity, unit, notes } = req.body;
    if (!component_product_id || !quantity) {
      return res.status(400).json({ success: false, error: 'Component and quantity are required' });
    }

    const result = await run(
      `INSERT INTO bom_items (parent_product_id, component_product_id, quantity, unit, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, component_product_id, parseFloat(quantity), unit || 'NOS', notes || '']
    );

    res.json({ success: true, id: result.lastID, message: 'BOM component added' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete BOM item
router.delete('/bom/:bomId', async (req, res) => {
  try {
    await run('DELETE FROM bom_items WHERE id = ?', [req.params.bomId]);
    res.json({ success: true, message: 'BOM item removed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

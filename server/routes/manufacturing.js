const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// List work orders
router.get('/work-orders', async (req, res) => {
  try {
    const orders = await all(`
      SELECT w.*, p.sku as product_sku, p.name as product_name, p.current_stock as finished_stock
      FROM work_orders w
      JOIN products p ON w.product_id = p.id
      ORDER BY w.created_at DESC
    `);
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create work order
router.post('/work-orders', async (req, res) => {
  try {
    const { product_id, quantity, start_date, due_date, notes } = req.body;
    const qty = parseInt(quantity, 10);

    if (!product_id || !qty || qty <= 0) {
      return res.status(400).json({ success: false, error: 'Product and valid quantity required' });
    }

    const orderNo = `WO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

    const result = await run(
      `INSERT INTO work_orders (order_no, product_id, quantity, status, start_date, due_date, notes)
       VALUES (?, ?, ?, 'Draft', ?, ?, ?)`,
      [orderNo, product_id, qty, start_date || new Date().toISOString().split('T')[0], due_date || '', notes || '']
    );

    res.json({ success: true, id: result.lastID, order_no: orderNo, message: 'Work order created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update work order status (including auto stock deduction & yield on completion)
router.put('/work-orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['Draft', 'In Production', 'Quality Check', 'Completed', 'Cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid work order status' });
    }

    const order = await get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Work order not found' });
    }

    // If changing to Completed and wasn't previously Completed
    if (status === 'Completed' && order.status !== 'Completed') {
      const bom = await all(
        'SELECT component_product_id, quantity FROM bom_items WHERE parent_product_id = ?',
        [order.product_id]
      );

      // Check stock availability
      for (const item of bom) {
        const requiredQty = item.quantity * order.quantity;
        const comp = await get('SELECT current_stock, name FROM products WHERE id = ?', [item.component_product_id]);
        if (comp && comp.current_stock < requiredQty) {
          return res.status(400).json({
            success: false,
            error: `Cannot complete work order. Insufficient component stock for ${comp.name}. Available: ${comp.current_stock}, Required: ${requiredQty}`
          });
        }
      }

      // Deduct components
      for (const item of bom) {
        const requiredQty = item.quantity * order.quantity;
        await run('UPDATE products SET current_stock = current_stock - ? WHERE id = ?', [requiredQty, item.component_product_id]);
        await run(
          `INSERT INTO inventory_transactions (type, product_id, quantity, reference_no, notes)
           VALUES ('PROD_CONSUME', ?, ?, ?, ?)`,
          [item.component_product_id, requiredQty, order.order_no, `Consumed for production of Work Order ${order.order_no}`]
        );
      }

      // Add finished product stock
      await run('UPDATE products SET current_stock = current_stock + ? WHERE id = ?', [order.quantity, order.product_id]);
      await run(
        `INSERT INTO inventory_transactions (type, product_id, quantity, reference_no, notes)
         VALUES ('PROD_YIELD', ?, ?, ?, ?)`,
        [order.product_id, order.quantity, order.order_no, `Manufactured from Work Order ${order.order_no}`]
      );

      const today = new Date().toISOString().split('T')[0];
      await run('UPDATE work_orders SET status = ?, completed_date = ? WHERE id = ?', [status, today, req.params.id]);
    } else {
      await run('UPDATE work_orders SET status = ? WHERE id = ?', [status, req.params.id]);
    }

    res.json({ success: true, message: `Work order marked as ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

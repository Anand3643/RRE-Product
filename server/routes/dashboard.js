const express = require('express');
const router = express.Router();
const { all, get } = require('../db');

router.get('/stats', async (req, res) => {
  try {
    // 1. Finance Metrics
    const invStats = await get(`
      SELECT 
        SUM(total) as total_revenue,
        SUM(paid_amount) as total_collected,
        SUM(total - paid_amount) as total_receivable,
        COUNT(*) as total_invoices,
        SUM(CASE WHEN status = 'Unpaid' OR status = 'Partially Paid' THEN 1 ELSE 0 END) as pending_invoices
      FROM invoices
    `);

    // 2. Inventory Metrics
    const stockStats = await get(`
      SELECT 
        COUNT(*) as total_products,
        SUM(current_stock * cost_price) as stock_valuation,
        SUM(CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END) as low_stock_alerts
      FROM products
    `);

    // 3. Manufacturing Metrics
    const mfgStats = await get(`
      SELECT 
        COUNT(*) as total_work_orders,
        SUM(CASE WHEN status = 'In Production' OR status = 'Quality Check' THEN 1 ELSE 0 END) as active_work_orders,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_work_orders
      FROM work_orders
    `);

    // 4. Sales & AMC Metrics
    const salesStats = await get(`
      SELECT 
        (SELECT COUNT(*) FROM customers) as customer_count,
        (SELECT COUNT(*) FROM quotations WHERE status = 'Draft' OR status = 'Sent') as active_quotes,
        (SELECT COUNT(*) FROM amc_contracts WHERE status = 'Active') as active_amcs,
        (SELECT SUM(total_amount) FROM amc_contracts WHERE status = 'Active') as active_amc_value
    `);

    // 5. HR Metrics
    const hrStats = await get(`
      SELECT 
        COUNT(*) as total_staff,
        (SELECT COUNT(*) FROM attendance WHERE date = date('now') AND status = 'Present') as present_today
      FROM employees
      WHERE status = 'Active'
    `);

    // 6. Recent Invoices
    const recentInvoices = await all(`
      SELECT i.invoice_no, i.invoice_date, i.total, i.status, c.company as customer_company
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      ORDER BY i.created_at DESC
      LIMIT 5
    `);

    // 7. Recent Work Orders
    const recentWorkOrders = await all(`
      SELECT w.order_no, w.quantity, w.status, w.due_date, p.name as product_name
      FROM work_orders w
      JOIN products p ON w.product_id = p.id
      ORDER BY w.created_at DESC
      LIMIT 5
    `);

    res.json({
      success: true,
      data: {
        finance: {
          revenue: invStats.total_revenue || 0,
          collected: invStats.total_collected || 0,
          receivable: invStats.total_receivable || 0,
          pending_count: invStats.pending_invoices || 0
        },
        inventory: {
          products_count: stockStats.total_products || 0,
          valuation: stockStats.stock_valuation || 0,
          low_stock_count: stockStats.low_stock_alerts || 0
        },
        manufacturing: {
          total_orders: mfgStats.total_work_orders || 0,
          active_orders: mfgStats.active_work_orders || 0,
          completed_orders: mfgStats.completed_orders || 0
        },
        sales: {
          customers: salesStats.customer_count || 0,
          active_quotes: salesStats.active_quotes || 0,
          active_amcs: salesStats.active_amcs || 0,
          amc_revenue: salesStats.active_amc_value || 0
        },
        hr: {
          total_staff: hrStats.total_staff || 0,
          present_today: hrStats.present_today || 0
        },
        recent: {
          invoices: recentInvoices,
          work_orders: recentWorkOrders
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

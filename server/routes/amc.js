const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// List AMC contracts
router.get('/', async (req, res) => {
  try {
    const contracts = await all(`
      SELECT a.*, c.name as customer_name, c.company as customer_company, c.phone, c.city
      FROM amc_contracts a
      JOIN customers c ON a.customer_id = c.id
      ORDER BY a.end_date ASC
    `);

    const summary = await get(`
      SELECT 
        COUNT(*) as total_contracts,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active_count,
        SUM(total_amount) as total_amc_value
      FROM amc_contracts
    `);

    res.json({ success: true, data: { items: contracts, summary } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create AMC contract
router.post('/', async (req, res) => {
  try {
    const { customer_id, machine_model, serial_no, start_date, end_date, visit_frequency, total_amount, next_service_date, notes } = req.body;
    const amount = parseFloat(total_amount);

    if (!customer_id || !machine_model || isNaN(amount)) {
      return res.status(400).json({ success: false, error: 'Customer, machine model, and valid contract value required' });
    }

    const contractNo = `AMC-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

    const result = await run(
      `INSERT INTO amc_contracts (contract_no, customer_id, machine_model, serial_no, start_date, end_date, visit_frequency, total_amount, status, next_service_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`,
      [
        contractNo, customer_id, machine_model, serial_no || '',
        start_date || new Date().toISOString().split('T')[0],
        end_date || '',
        visit_frequency || 'Quarterly (4 visits/yr)',
        amount, next_service_date || '', notes || ''
      ]
    );

    res.json({ success: true, id: result.lastID, contract_no: contractNo, message: 'AMC contract created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update AMC service date or status
router.put('/:id', async (req, res) => {
  try {
    const { next_service_date, status, notes } = req.body;
    await run(
      `UPDATE amc_contracts SET
        next_service_date = COALESCE(?, next_service_date),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes)
       WHERE id = ?`,
      [next_service_date, status, notes, req.params.id]
    );

    res.json({ success: true, message: 'AMC contract updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { all, get, run } = require('../../core/db');

// Account Groups
router.get('/groups', async (req, res) => {
  try {
    const groups = await all(`
      SELECT g.*, p.name as parent_name
      FROM account_groups g
      LEFT JOIN account_groups p ON g.parent_id = p.id
      ORDER BY g.nature, g.name
    `);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const { name, parent_id, nature, affects_gross_profit } = req.body;
    if (!name || !nature) return res.status(400).json({ success: false, error: 'Group name and nature are required' });

    const result = await run(
      'INSERT INTO account_groups (name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, ?, 0)',
      [name, nature, parent_id || null, affects_gross_profit ? 1 : 0]
    );
    res.json({ success: true, id: result.lastID, message: `Group '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ledgers Master
router.get('/ledgers', async (req, res) => {
  try {
    const ledgers = await all(`
      SELECT l.*, g.name as group_name, g.nature as group_nature
      FROM ledgers l
      JOIN account_groups g ON l.group_id = g.id
      ORDER BY l.name ASC
    `);
    res.json({ success: true, data: ledgers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/ledgers', async (req, res) => {
  try {
    const { name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc } = req.body;
    if (!name || !group_id) {
      return res.status(400).json({ success: false, error: 'Ledger name and group are required' });
    }

    const result = await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, group_id,
        parseFloat(opening_balance) || 0,
        opening_balance_type || 'Dr',
        gstin || '', pan || '',
        state || 'Tamil Nadu', state_code || '33',
        address || '',
        bank_account_no || null,
        bank_ifsc || null
      ]
    );

    res.json({ success: true, id: result.lastID, message: `Ledger '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Godowns / Locations Master
router.get('/godowns', async (req, res) => {
  try {
    const godowns = await all('SELECT * FROM godowns ORDER BY name ASC');
    res.json({ success: true, data: godowns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/godowns', async (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Godown name is required' });
    const result = await run('INSERT INTO godowns (name, location) VALUES (?, ?)', [name, location || '']);
    res.json({ success: true, id: result.lastID, message: `Godown '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cost Centres
router.get('/cost-centres', async (req, res) => {
  try {
    const centres = await all('SELECT * FROM cost_centres ORDER BY name ASC');
    res.json({ success: true, data: centres });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/cost-centres', async (req, res) => {
  try {
    const { name, category } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Cost centre name is required' });
    const result = await run('INSERT INTO cost_centres (name, category) VALUES (?, ?)', [name, category || 'Primary']);
    res.json({ success: true, id: result.lastID, message: `Cost Centre '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stock Groups
router.get('/stock-groups', async (req, res) => {
  try {
    const groups = await all('SELECT * FROM stock_groups ORDER BY name ASC');
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Units of Measure
router.get('/uom', async (req, res) => {
  try {
    const uoms = await all('SELECT * FROM units_of_measure ORDER BY symbol ASC');
    res.json({ success: true, data: uoms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stock Items Master
router.get('/stock-items', async (req, res) => {
  try {
    const items = await all(`
      SELECT s.*, g.name as group_name, u.symbol as uom_symbol
      FROM stock_items s
      JOIN stock_groups g ON s.stock_group_id = g.id
      JOIN units_of_measure u ON s.uom_id = u.id
      ORDER BY s.name ASC
    `);
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/stock-items', async (req, res) => {
  try {
    const { name, stock_group_id, uom_id, hsn_code, gst_rate, standard_cost, standard_price, opening_qty, opening_rate } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Item name is required' });

    const oQty = parseFloat(opening_qty) || 0;
    const oRate = parseFloat(opening_rate) || 0;
    const oVal = oQty * oRate;

    const result = await run(
      `INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, standard_cost, standard_price, opening_qty, opening_rate, opening_val)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, stock_group_id || 1, uom_id || 1, hsn_code || '84148011',
        parseFloat(gst_rate) || 18,
        parseFloat(standard_cost) || 0,
        parseFloat(standard_price) || 0,
        oQty, oRate, oVal
      ]
    );

    res.json({ success: true, id: result.lastID, message: `Stock Item '${name}' created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

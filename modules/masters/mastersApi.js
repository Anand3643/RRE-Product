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
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Group name is required' });

    let finalNature = nature;
    let finalAffects = affects_gross_profit ? 1 : 0;
    const parentId = parent_id ? parseInt(parent_id, 10) : null;

    if (parentId) {
      const parent = await get('SELECT nature, affects_gross_profit FROM account_groups WHERE id = ?', [parentId]);
      if (parent) {
        if (!finalNature) finalNature = parent.nature;
        if (affects_gross_profit === undefined) finalAffects = parent.affects_gross_profit;
      }
    }

    if (!finalNature) finalNature = 'Expenses';

    const trimmedName = name.trim();
    const existing = await get('SELECT id FROM account_groups WHERE LOWER(name) = LOWER(?)', [trimmedName]);
    if (existing) {
      return res.status(400).json({ success: false, error: `Account group '${trimmedName}' already exists` });
    }

    const result = await run(
      'INSERT INTO account_groups (name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, ?, ?)',
      [trimmedName, finalNature, parentId, finalAffects, parentId ? 0 : 1]
    );
    res.json({ success: true, id: result.lastID, message: `Group '${trimmedName}' created successfully` });
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

// ---- Ledger Alteration: name, group ("Under"), opening balance, GSTIN, state, description
// The ledgers the application finds by NAME (invoice tax lines, cash, round off) keep their names; everything else may change.
const FIXED_NAME = /^(cash|round off a\/c|(input|output) (cgst|sgst|igst)\b.*)$/i;
const ledgerSelect = `SELECT l.*, g.name AS group_name, g.nature AS group_nature FROM ledgers l JOIN account_groups g ON l.group_id = g.id WHERE l.id = ?`;

router.get('/ledgers/:id', async (req, res) => {
  try {
    const l = await get(ledgerSelect, [parseInt(req.params.id, 10) || 0]);
    if (!l) return res.status(404).json({ success: false, error: 'Ledger not found' });
    res.json({ success: true, data: l });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/ledgers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const b = req.body || {};
  const bad = (status, error) => res.status(status).json({ success: false, error });
  try {
    const cur = await get(ledgerSelect, [id]);
    if (!cur) return bad(404, 'Ledger not found');
    const name = b.name != null ? String(b.name).trim() : cur.name;
    if (!name) return bad(400, 'Ledger name is required');
    const groupId = b.group_id != null ? parseInt(b.group_id, 10) : cur.group_id;
    const group = await get('SELECT id, name, nature FROM account_groups WHERE id = ?', [groupId]);
    if (!group) return bad(400, 'Choose a valid group (Under).');
    if (name.toLowerCase() !== String(cur.name).toLowerCase() && FIXED_NAME.test(cur.name)) {
      return bad(409, `"${cur.name}" is used by the invoice and tax calculations, so its name cannot change. Its group, opening balance and other details can.`);
    }
    if (await get('SELECT id FROM ledgers WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, id])) return bad(409, `A ledger named "${name}" already exists.`);
    const ob = b.opening_balance != null && b.opening_balance !== '' ? parseFloat(b.opening_balance) : Number(cur.opening_balance) || 0;
    if (!Number.isFinite(ob) || ob < 0) return bad(400, 'Opening balance must be zero or more (choose Dr or Cr for its side).');
    const obType = b.opening_balance_type ? String(b.opening_balance_type) : cur.opening_balance_type || 'Dr';
    if (!['Dr', 'Cr'].includes(obType)) return bad(400, 'Opening balance side must be Dr or Cr.');
    const pick = (k) => (b[k] !== undefined ? (b[k] === '' ? null : String(b[k]).trim()) : cur[k]);
    await require('../../core/tx').withTransaction(async () => {
      await run(`UPDATE ledgers SET name = ?, group_id = ?, opening_balance = ?, opening_balance_type = ?, gstin = ?, pan = ?, state = ?, state_code = ?, address = ?, description = ? WHERE id = ?`,
        [name, groupId, Math.round(ob * 100) / 100, obType, pick('gstin'), pick('pan'), pick('state'), pick('state_code'), pick('address'), pick('description'), id]);
      const after = await get(ledgerSelect, [id]);
      const u = req.user || {};
      const keys = ['name', 'group_name', 'opening_balance', 'opening_balance_type', 'gstin', 'pan', 'state', 'state_code', 'address', 'description'];
      const changed = keys.filter((k) => String(cur[k] == null ? '' : cur[k]) !== String(after[k] == null ? '' : after[k]));
      await run('INSERT INTO activity_log (user_id, username, role, action, entity, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [u.userId || null, u.username || 'system', u.role || null, 'LEDGER_ALTER', 'ledger', String(id),
          JSON.stringify({ changed, before: Object.fromEntries(keys.map((k) => [k, cur[k]])), after: Object.fromEntries(keys.map((k) => [k, after[k]])) }), req.ip || null]);
    });
    const after = await get(ledgerSelect, [id]);
    res.json({ success: true, data: after, message: `Ledger '${after.name}' altered${cur.group_id !== after.group_id ? ` (moved from ${cur.group_name} to ${after.group_name})` : ''}` });
  } catch (err) {
    res.status(/UNIQUE/.test(String(err.message)) ? 409 : 500).json({ success: false, error: err.message });
  }
});

router.post('/ledgers', async (req, res) => {
  try {
    const { name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc, description } = req.body;
    if (!name || !group_id) {
      return res.status(400).json({ success: false, error: 'Ledger name and group are required' });
    }

    const result = await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, pan, state, state_code, address, bank_account_no, bank_ifsc, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(), group_id,
        parseFloat(opening_balance) || 0,
        opening_balance_type || 'Dr',
        gstin || '', pan || '',
        state || 'Tamil Nadu', state_code || '33',
        address || '',
        bank_account_no || null,
        bank_ifsc || null,
        description ? description.trim() : null
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

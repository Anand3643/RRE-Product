const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db');

// --- EMPLOYEES ---

// List employees
router.get('/employees', async (req, res) => {
  try {
    const employees = await all('SELECT * FROM employees ORDER BY name ASC');
    res.json({ success: true, data: employees });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add employee
router.post('/employees', async (req, res) => {
  try {
    const { name, email, phone, department, designation, basic_salary, joining_date } = req.body;
    if (!name || !department || !designation) {
      return res.status(400).json({ success: false, error: 'Name, department, and designation are required' });
    }

    const empCode = `RRE-${String(Date.now()).slice(-3)}`;
    const result = await run(
      `INSERT INTO employees (emp_code, name, email, phone, department, designation, basic_salary, joining_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
      [
        empCode, name, email || '', phone || '', department, designation,
        parseFloat(basic_salary) || 25000,
        joining_date || new Date().toISOString().split('T')[0]
      ]
    );

    res.json({ success: true, id: result.lastID, emp_code: empCode, message: 'Employee added successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ATTENDANCE ---

// Get attendance for a given date
router.get('/attendance', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const records = await all(`
      SELECT e.id as employee_id, e.emp_code, e.name, e.department, e.designation,
             COALESCE(a.status, 'Unmarked') as status,
             a.check_in, a.check_out, a.notes
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id AND a.date = ?
      WHERE e.status = 'Active'
      ORDER BY e.department, e.name
    `, [date]);

    res.json({ success: true, date, data: records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Log attendance for an employee
router.post('/attendance', async (req, res) => {
  try {
    const { employee_id, date, status, check_in, check_out, notes } = req.body;
    const attDate = date || new Date().toISOString().split('T')[0];
    const attStatus = status || 'Present';

    await run(`
      INSERT INTO attendance (employee_id, date, status, check_in, check_out, notes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, date) DO UPDATE SET
        status = excluded.status,
        check_in = COALESCE(excluded.check_in, attendance.check_in),
        check_out = COALESCE(excluded.check_out, attendance.check_out),
        notes = COALESCE(excluded.notes, attendance.notes)
    `, [employee_id, attDate, attStatus, check_in || '09:00', check_out || '18:00', notes || '']);

    res.json({ success: true, message: `Attendance marked as ${attStatus}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PAYROLL ---

// List payroll records
router.get('/payroll', async (req, res) => {
  try {
    const monthYear = req.query.month_year || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const payrolls = await all(`
      SELECT p.*, e.emp_code, e.name as employee_name, e.department, e.designation
      FROM payroll p
      JOIN employees e ON p.employee_id = e.id
      WHERE p.month_year = ?
      ORDER BY e.name ASC
    `, [monthYear]);

    res.json({ success: true, month_year: monthYear, data: payrolls });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate monthly payroll for all active employees
router.post('/payroll/generate', async (req, res) => {
  try {
    const monthYear = req.body.month_year || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const employees = await all("SELECT * FROM employees WHERE status = 'Active'");

    let createdCount = 0;
    for (const emp of employees) {
      const basic = emp.basic_salary || 25000;
      const allowances = Math.round(basic * 0.20); // 20% HRA/allowances
      const deductions = Math.round(basic * 0.12); // 12% PF
      const net = basic + allowances - deductions;

      try {
        await run(`
          INSERT INTO payroll (employee_id, month_year, basic, allowances, deductions, net_salary, status, payment_date)
          VALUES (?, ?, ?, ?, ?, ?, 'Paid', ?)
          ON CONFLICT(employee_id, month_year) DO NOTHING
        `, [emp.id, monthYear, basic, allowances, deductions, net, new Date().toISOString().split('T')[0]]);
        createdCount++;
      } catch (e) {
        // Already exists
      }
    }

    res.json({ success: true, message: `Payroll processed for ${createdCount} employees for ${monthYear}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

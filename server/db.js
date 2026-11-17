const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '..', 'rre_erp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Promisified query helpers
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize schema & seeds
async function initDb() {
  await run('PRAGMA foreign_keys = ON');

  // 1. Users
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'Admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Products (Finished Machines, Spare Parts, Raw Materials)
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT DEFAULT 'NOS',
      hsn_code TEXT,
      unit_price REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      min_stock INTEGER DEFAULT 5,
      current_stock INTEGER DEFAULT 0,
      is_assembly INTEGER DEFAULT 0,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Bill of Materials (BOM)
  await run(`
    CREATE TABLE IF NOT EXISTS bom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_product_id INTEGER NOT NULL,
      component_product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'NOS',
      notes TEXT,
      FOREIGN KEY(parent_product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(component_product_id) REFERENCES products(id)
    )
  `);

  // 4. Inventory Transactions (Stock In, Stock Out, Adjustments, Production)
  await run(`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, -- 'IN', 'OUT', 'ADJUST', 'PROD_CONSUME', 'PROD_YIELD'
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      reference_no TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  // 5. Work Orders (Production Jobs)
  await run(`
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'Draft', -- 'Draft', 'In Production', 'Quality Check', 'Completed', 'Cancelled'
      start_date TEXT,
      due_date TEXT,
      completed_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  // 6. Customers / Clients
  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      gstin TEXT,
      address TEXT,
      city TEXT DEFAULT 'Chennai',
      state TEXT DEFAULT 'Tamil Nadu',
      credit_limit REAL DEFAULT 500000,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 7. Quotations / Estimates
  await run(`
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL,
      quote_date TEXT NOT NULL,
      valid_until TEXT,
      subtotal REAL DEFAULT 0,
      tax_rate REAL DEFAULT 18,
      tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      status TEXT DEFAULT 'Draft', -- 'Draft', 'Sent', 'Accepted', 'Rejected'
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  // 8. Quotation Line Items
  await run(`
    CREATE TABLE IF NOT EXISTS quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL,
      product_id INTEGER,
      description TEXT NOT NULL,
      hsn TEXT,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      discount REAL DEFAULT 0,
      total REAL NOT NULL,
      FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    )
  `);

  // 9. Sales Orders
  await run(`
    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      quotation_id INTEGER,
      customer_id INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      delivery_date TEXT,
      total REAL NOT NULL,
      status TEXT DEFAULT 'Confirmed', -- 'Pending', 'Confirmed', 'Dispatched', 'Completed', 'Cancelled'
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  // 10. GST Tax Invoices
  await run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL,
      sales_order_id INTEGER,
      invoice_date TEXT NOT NULL,
      due_date TEXT,
      subtotal REAL NOT NULL,
      cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0,
      igst REAL DEFAULT 0,
      total REAL NOT NULL,
      paid_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'Unpaid', -- 'Unpaid', 'Partially Paid', 'Paid', 'Overdue'
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  // 11. Invoice Line Items
  await run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      product_id INTEGER,
      description TEXT NOT NULL,
      hsn TEXT,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      tax_rate REAL DEFAULT 18,
      total REAL NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    )
  `);

  // 12. AMC Contracts (Annual Maintenance Contracts)
  await run(`
    CREATE TABLE IF NOT EXISTS amc_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL,
      machine_model TEXT NOT NULL,
      serial_no TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      visit_frequency TEXT DEFAULT 'Quarterly (4 visits/yr)',
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'Active', -- 'Active', 'Expiring Soon', 'Expired', 'Renewed'
      next_service_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  // 13. Employees (HR)
  await run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      department TEXT NOT NULL,
      designation TEXT NOT NULL,
      joining_date TEXT,
      basic_salary REAL DEFAULT 25000,
      status TEXT DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 14. Attendance
  await run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT DEFAULT 'Present', -- 'Present', 'Absent', 'Half Day', 'On Leave'
      check_in TEXT,
      check_out TEXT,
      notes TEXT,
      UNIQUE(employee_id, date),
      FOREIGN KEY(employee_id) REFERENCES employees(id)
    )
  `);

  // 15. Payroll
  await run(`
    CREATE TABLE IF NOT EXISTS payroll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      month_year TEXT NOT NULL, -- e.g., '2026-11'
      basic REAL NOT NULL,
      allowances REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      net_salary REAL NOT NULL,
      status TEXT DEFAULT 'Paid', -- 'Pending', 'Processed', 'Paid'
      payment_date TEXT,
      notes TEXT,
      UNIQUE(employee_id, month_year),
      FOREIGN KEY(employee_id) REFERENCES employees(id)
    )
  `);

  // 16. Operational Expenses
  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL, -- 'Raw Material', 'Utility', 'Rent', 'Logistics', 'Tools', 'Maintenance'
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      description TEXT,
      paid_to TEXT,
      payment_mode TEXT DEFAULT 'Bank Transfer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 17. Zoho Sync Audit Log (Reconstructed via REA)
  await run(`
    CREATE TABLE IF NOT EXISTS zoho_sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, -- 'Customer', 'Product', 'Quotation', 'Invoice'
      entity_id INTEGER NOT NULL,
      zoho_id TEXT,
      status TEXT NOT NULL, -- 'Success', 'Failed'
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Dynamic column additions for Zoho IDs
  const addCol = async (table, col, type) => {
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (e) {}
  };
  await addCol('customers', 'zoho_contact_id', 'TEXT');
  await addCol('products', 'zoho_item_id', 'TEXT');
  await addCol('quotations', 'zoho_estimate_id', 'TEXT');
  await addCol('invoices', 'zoho_invoice_id', 'TEXT');

  // Seed sample data if empty
  await seedData();
}

async function seedData() {
  const productCount = await get('SELECT COUNT(*) as count FROM products');
  if (productCount.count > 0) return;

  console.log('Seeding initial industrial manufacturing demo data...');

  // 1. Seed Products
  const products = [
    // Finished Machines (Assemblies)
    { sku: 'RRE-SC-15HP', name: 'RRE Screw Compressor 15 HP (Air-Cooled)', category: 'Finished Goods', unit: 'SET', hsn: '84148011', price: 345000, cost: 230000, min: 2, stock: 4, is_asm: 1, desc: 'Heavy duty rotary screw air compressor, 60 CFM @ 7.5 Bar' },
    { sku: 'RRE-SC-30HP', name: 'RRE Screw Compressor 30 HP (Variable Speed)', category: 'Finished Goods', unit: 'SET', hsn: '84148011', price: 580000, cost: 395000, min: 1, stock: 2, is_asm: 1, desc: 'Energy efficient VFD screw compressor, 130 CFM @ 8.0 Bar' },
    { sku: 'RRE-AD-100', name: 'Refrigerated Air Dryer 100 CFM', category: 'Finished Goods', unit: 'SET', hsn: '84193900', price: 85000, cost: 52000, min: 2, stock: 5, is_asm: 0, desc: 'High inlet temperature air dryer with eco refrigerant' },

    // Components & Spares
    { sku: 'RRE-AR-01', name: 'Airend Assembly Rotor 15HP', category: 'Core Components', unit: 'NOS', hsn: '84149090', price: 110000, cost: 78000, min: 3, stock: 8, is_asm: 0, desc: 'Precision CNC machined rotary airend unit' },
    { sku: 'RRE-MOT-15', name: '15 HP IE3 Electric Motor (3-Phase)', category: 'Core Components', unit: 'NOS', hsn: '85015210', price: 55000, cost: 38000, min: 3, stock: 6, is_asm: 0, desc: 'High efficiency copper wound industrial motor' },
    { sku: 'RRE-FLT-SEP', name: 'Air-Oil Separator Element 15/30HP', category: 'Spares & Consumables', unit: 'NOS', hsn: '84213920', price: 4800, cost: 2600, min: 10, stock: 24, is_asm: 0, desc: 'High filtration microfiber spin-on separator' },
    { sku: 'RRE-FLT-OIL', name: 'Screw Compressor Oil Filter Spin-On', category: 'Spares & Consumables', unit: 'NOS', hsn: '84212900', price: 1650, cost: 850, min: 15, stock: 35, is_asm: 0, desc: 'High pressure spin-on oil filter canister' },
    { sku: 'RRE-FLT-AIR', name: 'Heavy Duty Air Intake Filter Element', category: 'Spares & Consumables', unit: 'NOS', hsn: '84213100', price: 2100, cost: 1100, min: 10, stock: 28, is_asm: 0, desc: 'Pleated synthetic air filter element' },
    { sku: 'RRE-LUB-20L', name: 'RRE Ultra-Lube Synthetic Compressor Oil (20L Drum)', category: 'Spares & Consumables', unit: 'DRUM', hsn: '27101990', price: 9200, cost: 6100, min: 8, stock: 18, is_asm: 0, desc: 'Extended 8,000-hour life polyolester synthetic oil' },
    { sku: 'RRE-PLC-CTRL', name: 'Microprocessor Digital Controller Panel', category: 'Core Components', unit: 'NOS', hsn: '85371000', price: 28000, cost: 17500, min: 4, stock: 7, is_asm: 0, desc: 'Backlit LCD controller with fault diagnostics & auto-drain control' },
    { sku: 'RRE-VLV-INL', name: 'Pneumatic Intake / Unloader Suction Valve', category: 'Core Components', unit: 'NOS', hsn: '84818090', price: 14500, cost: 8900, min: 5, stock: 9, is_asm: 0, desc: 'Normally closed proportional modulation suction valve' }
  ];

  for (const p of products) {
    await run(
      `INSERT INTO products (sku, name, category, unit, hsn_code, unit_price, cost_price, min_stock, current_stock, is_assembly, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.sku, p.name, p.category, p.unit, p.hsn, p.price, p.cost, p.min, p.stock, p.is_asm, p.desc]
    );
  }

  // 2. Seed BOM for RRE-SC-15HP (ID: 1)
  const bomItems = [
    { parent: 1, comp: 4, qty: 1, notes: 'Airend Assembly' },
    { parent: 1, comp: 5, qty: 1, notes: '15 HP Motor' },
    { parent: 1, comp: 6, qty: 1, notes: 'Oil Separator' },
    { parent: 1, comp: 7, qty: 1, notes: 'Oil Filter' },
    { parent: 1, comp: 8, qty: 1, notes: 'Air Filter' },
    { parent: 1, comp: 9, qty: 1, notes: 'Synthetic Oil 20L' },
    { parent: 1, comp: 10, qty: 1, notes: 'Digital Controller' },
    { parent: 1, comp: 11, qty: 1, notes: 'Intake Valve' }
  ];

  for (const b of bomItems) {
    await run(
      `INSERT INTO bom_items (parent_product_id, component_product_id, quantity, notes)
       VALUES (?, ?, ?, ?)`,
      [b.parent, b.comp, b.qty, b.notes]
    );
  }

  // 3. Seed Customers
  const customers = [
    { name: 'Karthik Subramanian', company: 'Chennai Auto Components Pvt Ltd', email: 'karthik@chennaiauto.com', phone: '+91 98401 23456', gstin: '33AABCC1234F1Z1', city: 'Sriperumbudur', addr: 'Plot 45, SIPCOT Industrial Park' },
    { name: 'R. Rajesh', company: 'Southern Textiles & Spinning Mills', email: 'rajesh@southerntextiles.in', phone: '+91 94440 98765', gstin: '33AAECS5678M1Z8', city: 'Coimbatore', addr: '124 Avinashi Road' },
    { name: 'M. Senthil Kumar', company: 'Precision Engineering & Toolings', email: 'senthil@precisiontools.com', phone: '+91 97890 54321', gstin: '33AABCP9988K1Z5', city: 'Ambattur', addr: 'Industrial Estate, Phase 2' },
    { name: 'V. Sundaram', company: 'Sakthi Plastics & Packaging', email: 'vsundaram@sakthiplastics.in', phone: '+91 98840 67890', gstin: '33AADFS4321P1Z9', city: 'Maraimalai Nagar', addr: 'Sector 8, Mahindra World City' }
  ];

  for (const c of customers) {
    await run(
      `INSERT INTO customers (name, company, email, phone, gstin, address, city)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.name, c.company, c.email, c.phone, c.gstin, c.addr, c.city]
    );
  }

  // 4. Seed Quotation
  await run(
    `INSERT INTO quotations (quote_no, customer_id, quote_date, valid_until, subtotal, tax_rate, tax_amount, total, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['QT-2026-001', 1, '2026-11-10', '2026-12-10', 345000, 18, 62100, 407100, 'Accepted', 'Supply and commissioning of 15 HP Screw Compressor with 1-year standard warranty.']
  );
  await run(
    `INSERT INTO quotation_items (quotation_id, product_id, description, hsn, quantity, unit_price, discount, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 'RRE Screw Compressor 15 HP (Air-Cooled)', '84148011', 1, 345000, 0, 345000]
  );

  // 5. Seed Tax Invoice
  await run(
    `INSERT INTO invoices (invoice_no, customer_id, invoice_date, due_date, subtotal, cgst, sgst, igst, total, paid_amount, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['INV-2026-108', 1, '2026-11-12', '2026-12-12', 345000, 31050, 31050, 0, 407100, 407100, 'Paid', 'Full payment received via RTGS.']
  );
  await run(
    `INSERT INTO invoice_items (invoice_id, product_id, description, hsn, quantity, unit_price, tax_rate, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 'RRE Screw Compressor 15 HP (Air-Cooled)', '84148011', 1, 345000, 18, 345000]
  );

  // 6. Seed AMC Contract
  await run(
    `INSERT INTO amc_contracts (contract_no, customer_id, machine_model, serial_no, start_date, end_date, visit_frequency, total_amount, status, next_service_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['AMC-2026-042', 2, 'RRE-SC-30HP (Screw Compressor)', 'RRE-2025-SC30-089', '2026-01-01', '2026-12-31', 'Quarterly (4 visits/yr)', 45000, 'Active', '2026-12-05', 'Comprehensive AMC including free air and oil filter replacement.']
  );

  // 7. Seed Employees
  const employees = [
    { code: 'RRE-001', name: 'R. Srinivas', email: 'srinivas@ramrajenterprises.com', phone: '+91 98401 76592', dept: 'Management', desig: 'Managing Director', salary: 90000 },
    { code: 'RRE-002', name: 'Anand P', email: 'anand@ramrajenterprises.com', phone: '+91 98407 70140', dept: 'Operations & Tech', desig: 'Chief Operations Officer', salary: 75000 },
    { code: 'RRE-003', name: 'K. Balaji', email: 'balaji@ramrajenterprises.com', phone: '+91 98405 11223', dept: 'Production', desig: 'Senior Assembly Engineer', salary: 42000 },
    { code: 'RRE-004', name: 'M. Vignesh', email: 'vignesh@ramrajenterprises.com', phone: '+91 97901 33445', dept: 'Field Service', desig: 'Compressor Service Technician', salary: 32000 },
    { code: 'RRE-005', name: 'P. Priya', email: 'priya@ramrajenterprises.com', phone: '+91 98408 55667', dept: 'Finance & Accounts', desig: 'Accounts Specialist', salary: 38000 }
  ];

  for (const e of employees) {
    await run(
      `INSERT INTO employees (emp_code, name, email, phone, department, designation, basic_salary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.code, e.name, e.email, e.phone, e.dept, e.desig, e.salary]
    );
  }

  // 8. Seed Work Orders
  await run(
    `INSERT INTO work_orders (order_no, product_id, quantity, status, start_date, due_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['WO-2026-015', 1, 2, 'In Production', '2026-11-14', '2026-11-25', 'Batch 15 assembly for Southern Textiles order']
  );

  console.log('Seeding completed successfully!');
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb
};

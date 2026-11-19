const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'tally_prime.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
  } else {
    console.log('Connected to Tally SQLite database at:', dbPath);
  }
});

// Promisified query wrappers
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

// Initialize schema and standard Tally Chart of Accounts
async function initDb() {
  await run('PRAGMA foreign_keys = ON');

  // 1. Company Information Master
  await run(`
    CREATE TABLE IF NOT EXISTS company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      formal_name TEXT,
      financial_year_from TEXT NOT NULL,
      books_beginning_from TEXT NOT NULL,
      gstin TEXT,
      pan TEXT,
      address TEXT,
      state TEXT,
      state_code TEXT,
      pin_code TEXT,
      currency_symbol TEXT DEFAULT '₹',
      formal_currency_name TEXT DEFAULT 'INR'
    )
  `);

  // 2. Account Groups (Statutory Tally 28 Groups)
  await run(`
    CREATE TABLE IF NOT EXISTS account_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      nature TEXT NOT NULL, -- 'Assets', 'Liabilities', 'Income', 'Expenses'
      parent_id INTEGER,
      affects_gross_profit INTEGER DEFAULT 0,
      is_primary INTEGER DEFAULT 0,
      FOREIGN KEY(parent_id) REFERENCES account_groups(id)
    )
  `);

  // 3. Ledger Accounts Master
  await run(`
    CREATE TABLE IF NOT EXISTS ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      group_id INTEGER NOT NULL,
      opening_balance REAL DEFAULT 0,
      opening_balance_type TEXT DEFAULT 'Dr', -- 'Dr' or 'Cr'
      gstin TEXT,
      pan TEXT,
      address TEXT,
      state TEXT DEFAULT 'Tamil Nadu',
      state_code TEXT DEFAULT '33',
      credit_period INTEGER DEFAULT 30,
      bank_account_no TEXT,
      bank_ifsc TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES account_groups(id)
    )
  `);

  // 4. Units of Measure (UoM)
  await run(`
    CREATE TABLE IF NOT EXISTS units_of_measure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE NOT NULL,
      formal_name TEXT NOT NULL,
      decimal_places INTEGER DEFAULT 0
    )
  `);

  // 5. Stock Groups
  await run(`
    CREATE TABLE IF NOT EXISTS stock_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      parent_id INTEGER,
      FOREIGN KEY(parent_id) REFERENCES stock_groups(id)
    )
  `);

  // 6. Stock Items Master
  await run(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      stock_group_id INTEGER NOT NULL,
      uom_id INTEGER NOT NULL,
      hsn_code TEXT,
      gst_rate REAL DEFAULT 18.0,
      opening_qty REAL DEFAULT 0,
      opening_rate REAL DEFAULT 0,
      opening_val REAL DEFAULT 0,
      standard_cost REAL DEFAULT 0,
      standard_price REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(stock_group_id) REFERENCES stock_groups(id),
      FOREIGN KEY(uom_id) REFERENCES units_of_measure(id)
    )
  `);

  // 7. Vouchers Header (Double-Entry Envelope)
  await run(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_type TEXT NOT NULL, -- 'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'
      voucher_no TEXT NOT NULL,
      date TEXT NOT NULL,
      effective_date TEXT,
      reference_no TEXT,
      narration TEXT,
      party_ledger_id INTEGER,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(party_ledger_id) REFERENCES ledgers(id)
    )
  `);

  // 8. General Ledger Entries (Strict Double Entry: Sum(Dr) = Sum(Cr))
  await run(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      ledger_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL, -- 'Dr' or 'Cr'
      debit_amount REAL DEFAULT 0,
      credit_amount REAL DEFAULT 0,
      particulars TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY(ledger_id) REFERENCES ledgers(id)
    )
  `);

  // 9. Inventory Movements (Item Allocation in Vouchers)
  await run(`
    CREATE TABLE IF NOT EXISTS inventory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      stock_item_id INTEGER NOT NULL,
      direction TEXT NOT NULL, -- 'IN' (Purchase) or 'OUT' (Sales)
      quantity REAL NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      discount_pct REAL DEFAULT 0,
      godown TEXT DEFAULT 'Main Location',
      FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY(stock_item_id) REFERENCES stock_items(id)
    )
  `);

  await seedTallyMasters();
}

async function seedTallyMasters() {
  const comp = await get('SELECT COUNT(*) as count FROM company_info');
  if (comp.count > 0) return;

  console.log('Seeding Tally statutory Chart of Accounts and masters...');

  // 1. Company Info
  await run(`
    INSERT INTO company_info (name, formal_name, financial_year_from, books_beginning_from, gstin, pan, address, state, state_code, pin_code)
    VALUES ('Ramraj Enterprises', 'M/s. RAMRAJ ENTERPRISES', '2026-04-01', '2026-04-01', '33ANUPS7331M1Z8', 'ANUPS7331M', '12/4 Industrial Estate, Ambattur', 'Tamil Nadu', '33', '600058')
  `);

  // 2. Standard Tally 28 Groups
  // Primary Groups
  const primaryGroups = [
    { id: 1, name: 'Capital Account', nature: 'Liabilities', aff: 0 },
    { id: 2, name: 'Loans (Liability)', nature: 'Liabilities', aff: 0 },
    { id: 3, name: 'Current Liabilities', nature: 'Liabilities', aff: 0 },
    { id: 4, name: 'Fixed Assets', nature: 'Assets', aff: 0 },
    { id: 5, name: 'Investments', nature: 'Assets', aff: 0 },
    { id: 6, name: 'Current Assets', nature: 'Assets', aff: 0 },
    { id: 7, name: 'Sales Accounts', nature: 'Income', aff: 1 },
    { id: 8, name: 'Purchase Accounts', nature: 'Expenses', aff: 1 },
    { id: 9, name: 'Direct Incomes', nature: 'Income', aff: 1 },
    { id: 10, name: 'Direct Expenses', nature: 'Expenses', aff: 1 },
    { id: 11, name: 'Indirect Incomes', nature: 'Income', aff: 0 },
    { id: 12, name: 'Indirect Expenses', nature: 'Expenses', aff: 0 },
    { id: 13, name: 'Suspense A/c', nature: 'Liabilities', aff: 0 },
    { id: 14, name: 'Misc. Expenses (ASSET)', nature: 'Assets', aff: 0 }
  ];

  for (const g of primaryGroups) {
    await run(
      'INSERT INTO account_groups (id, name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, NULL, ?, 1)',
      [g.id, g.name, g.nature, g.aff]
    );
  }

  // Secondary Sub-Groups
  const subGroups = [
    { id: 15, name: 'Sundry Debtors', nature: 'Assets', parent: 6, aff: 0 },
    { id: 16, name: 'Sundry Creditors', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 17, name: 'Bank Accounts', nature: 'Assets', parent: 6, aff: 0 },
    { id: 18, name: 'Cash-in-hand', nature: 'Assets', parent: 6, aff: 0 },
    { id: 19, name: 'Duties & Taxes', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 20, name: 'Stock-in-hand', nature: 'Assets', parent: 6, aff: 0 },
    { id: 21, name: 'Bank OD A/c', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 22, name: 'Secured Loans', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 23, name: 'Unsecured Loans', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 24, name: 'Deposits (Asset)', nature: 'Assets', parent: 6, aff: 0 },
    { id: 25, name: 'Loans & Advances (Asset)', nature: 'Assets', parent: 6, aff: 0 },
    { id: 26, name: 'Provisions', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 27, name: 'Reserves & Surplus', nature: 'Liabilities', parent: 1, aff: 0 }
  ];

  for (const g of subGroups) {
    await run(
      'INSERT INTO account_groups (id, name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, ?, ?, 0)',
      [g.id, g.name, g.nature, g.parent, g.aff]
    );
  }

  // 3. Units of Measure
  const units = [
    { symbol: 'NOS', formal: 'Numbers', dec: 0 },
    { symbol: 'SET', formal: 'Sets', dec: 0 },
    { symbol: 'PCS', formal: 'Pieces', dec: 0 },
    { symbol: 'DRUM', formal: 'Drums', dec: 0 },
    { symbol: 'KGS', formal: 'Kilograms', dec: 2 }
  ];
  for (const u of units) {
    await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [u.symbol, u.formal, u.dec]);
  }

  // 4. Stock Groups
  await run("INSERT INTO stock_groups (name) VALUES ('Screw Compressors')");
  await run("INSERT INTO stock_groups (name) VALUES ('Spare Parts & Consumables')");
  await run("INSERT INTO stock_groups (name) VALUES ('Service Kits & Lubes')");

  // 5. Stock Items
  const stockItems = [
    { name: 'RRE Screw Compressor 15 HP (Air-Cooled)', group: 1, uom: 2, hsn: '84148011', cost: 230000, price: 345000, oQty: 4, oRate: 230000 },
    { name: 'RRE Screw Compressor 30 HP (VFD Speed)', group: 1, uom: 2, hsn: '84148011', cost: 395000, price: 580000, oQty: 2, oRate: 395000 },
    { name: 'Airend Assembly Rotor 15HP', group: 2, uom: 1, hsn: '84149090', cost: 78000, price: 110000, oQty: 8, oRate: 78000 },
    { name: 'Air-Oil Separator Element 15/30HP', group: 2, uom: 1, hsn: '84213920', cost: 2600, price: 4800, oQty: 25, oRate: 2600 },
    { name: 'Screw Compressor Oil Filter Spin-On', group: 2, uom: 1, hsn: '84212900', cost: 850, price: 1650, oQty: 30, oRate: 850 },
    { name: 'RRE Ultra-Lube Synthetic Compressor Oil 20L', group: 3, uom: 4, hsn: '27101990', cost: 6100, price: 9200, oQty: 18, oRate: 6100 }
  ];

  for (const it of stockItems) {
    const oVal = it.oQty * it.oRate;
    await run(
      `INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, standard_cost, standard_price, opening_qty, opening_rate, opening_val)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [it.name, it.group, it.uom, it.hsn, it.cost, it.price, it.oQty, it.oRate, oVal]
    );
  }

  // Calculate total opening stock value
  const totalStockVal = stockItems.reduce((acc, cur) => acc + (cur.oQty * cur.oRate), 0);

  // 6. Standard Ledgers
  const ledgers = [
    // Cash & Bank
    { name: 'Cash', group: 18, opBal: 75000, opType: 'Dr' },
    { name: 'HDFC Bank Current A/c', group: 17, opBal: 1250000, opType: 'Dr', gstin: '', pan: '', state: 'Tamil Nadu' },

    // Capital
    { name: 'Proprietor Capital A/c', group: 1, opBal: (1250000 + 75000 + totalStockVal), opType: 'Cr' },

    // Stock-in-hand ledger
    { name: 'Stock-in-hand', group: 20, opBal: totalStockVal, opType: 'Dr' },

    // Duties & Taxes
    { name: 'Input CGST 9%', group: 19, opBal: 0, opType: 'Dr' },
    { name: 'Input SGST 9%', group: 19, opBal: 0, opType: 'Dr' },
    { name: 'Output CGST 9%', group: 19, opBal: 0, opType: 'Cr' },
    { name: 'Output SGST 9%', group: 19, opBal: 0, opType: 'Cr' },
    { name: 'Output IGST 18%', group: 19, opBal: 0, opType: 'Cr' },

    // Sundry Debtors (Customers)
    { name: 'Chennai Auto Components Pvt Ltd', group: 15, opBal: 120000, opType: 'Dr', gstin: '33AABCC1234F1Z1', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Southern Textiles & Spinning Mills', group: 15, opBal: 85000, opType: 'Dr', gstin: '33AAECS5678M1Z8', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Precision Engineering & Toolings', group: 15, opBal: 45000, opType: 'Dr', gstin: '33AABCP9988K1Z5', state: 'Tamil Nadu', stateCode: '33' },

    // Sundry Creditors (Vendors)
    { name: 'Elgi Equipments Spares Ltd', group: 16, opBal: 210000, opType: 'Cr', gstin: '33AABCE4455P1Z2', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Bharat Electric Motors Vendor', group: 16, opBal: 40000, opType: 'Cr', gstin: '33AABCB1122M1Z9', state: 'Tamil Nadu', stateCode: '33' },

    // Sales Accounts
    { name: 'Sales Account - Compressors', group: 7, opBal: 0, opType: 'Cr' },
    { name: 'Service & Maintenance AMC Charges', group: 7, opBal: 0, opType: 'Cr' },

    // Purchase Accounts
    { name: 'Purchase Account - Spares & Machines', group: 8, opBal: 0, opType: 'Dr' },

    // Expenses
    { name: 'Factory Electricity Charges', group: 10, opBal: 0, opType: 'Dr' },
    { name: 'Office Rent', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Staff Salaries & Wages', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Freight & Transportation Charges', group: 10, opBal: 0, opType: 'Dr' }
  ];

  for (const l of ledgers) {
    await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state, state_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [l.name, l.group, l.opBal || 0, l.opType || 'Dr', l.gstin || '', l.state || 'Tamil Nadu', l.stateCode || '33']
    );
  }

  // 7. Seed Sample Double-Entry Vouchers
  // Voucher 1: F8 Sales (Chennai Auto Components - Sale of 15HP Compressor)
  // Dr. Chennai Auto Components (₹4,07,100)
  //   Cr. Sales Account (₹3,45,000)
  //   Cr. Output CGST 9% (₹31,050)
  //   Cr. Output SGST 9% (₹31,050)
  const v1 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Sales', 'RRE/SALES/001', '2026-05-10', 'PO-8842', 'Being 15HP Rotary Screw Compressor sold with 18% GST', 9, 407100)`
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 9, 'Dr', 407100, 0, 'Chennai Auto Components Pvt Ltd')", [v1.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 14, 'Cr', 0, 345000, 'Sales Account - Compressors')", [v1.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 7, 'Cr', 0, 31050, 'Output CGST 9%')", [v1.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 8, 'Cr', 0, 31050, 'Output SGST 9%')", [v1.lastID]);

  // Inventory Outward for Voucher 1
  await run(
    `INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount)
     VALUES (?, 1, 'OUT', 1, 345000, 345000)`,
    [v1.lastID]
  );

  // Voucher 2: F6 Receipt (Payment received from Chennai Auto Components via Bank)
  // Dr. HDFC Bank Current A/c (₹4,07,100)
  //   Cr. Chennai Auto Components Pvt Ltd (₹4,07,100)
  const v2 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Receipt', 'RRE/REC/001', '2026-05-15', 'RTGS-109283', 'Payment received in full against Invoice RRE/SALES/001', 9, 407100)`
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 2, 'Dr', 407100, 0, 'HDFC Bank Current A/c')", [v2.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 9, 'Cr', 0, 407100, 'Chennai Auto Components Pvt Ltd')", [v2.lastID]);

  // Voucher 3: F5 Payment (Office Rent paid via Bank)
  // Dr. Office Rent (₹45,000)
  //   Cr. HDFC Bank Current A/c (₹45,000)
  const v3 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Payment', 'RRE/PMT/001', '2026-05-31', 'CHQ-44021', 'Office premises rent paid for May 2026', 18, 45000)`
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 18, 'Dr', 45000, 0, 'Office Rent')", [v3.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 2, 'Cr', 0, 45000, 'HDFC Bank Current A/c')", [v3.lastID]);

  // Voucher 4: F4 Contra (Cash withdrawal from Bank for office petty cash)
  // Dr. Cash (₹25,000)
  //   Cr. HDFC Bank Current A/c (₹25,000)
  const v4 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Contra', 'RRE/CON/001', '2026-06-01', 'SELF-CHQ', 'Self cheque cash withdrawal for office petty expenses', 1, 25000)`
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 1, 'Dr', 25000, 0, 'Cash')", [v4.lastID]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, 2, 'Cr', 0, 25000, 'HDFC Bank Current A/c')", [v4.lastID]);

  console.log('Tally masters and double-entry sample vouchers seeded successfully!');
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb
};

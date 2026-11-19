const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure data directory exists mirroring TallyPrime Data path (e.g. data/100000)
const dataDir = path.resolve(__dirname, '..', 'data', '100000');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.resolve(dataDir, 'company.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open Tally company database:', err.message);
  } else {
    console.log(`[Tally Core DB] Connected to Company 100000 database at: ${dbPath}`);
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

async function initDb() {
  await run('PRAGMA foreign_keys = ON');

  // 1. Company Information Master
  await run(`
    CREATE TABLE IF NOT EXISTS company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_number TEXT DEFAULT '100000',
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
      maintain_bill_by_bill INTEGER DEFAULT 1,
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

  // 6. Godowns / Locations
  await run(`
    CREATE TABLE IF NOT EXISTS godowns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      location TEXT,
      is_active INTEGER DEFAULT 1
    )
  `);

  // 7. Cost Centres Master
  await run(`
    CREATE TABLE IF NOT EXISTS cost_centres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      category TEXT DEFAULT 'Primary'
    )
  `);

  // 8. Stock Items Master
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

  // 9. Vouchers Header (Double-Entry Envelope)
  await run(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_type TEXT NOT NULL, -- 'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note', 'Stock Journal'
      voucher_no TEXT NOT NULL UNIQUE,
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

  // 10. General Ledger Entries (Strict Double Entry: Sum(Dr) = Sum(Cr))
  await run(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      ledger_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL, -- 'Dr' or 'Cr'
      debit_amount REAL DEFAULT 0,
      credit_amount REAL DEFAULT 0,
      particulars TEXT,
      cost_centre_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY(ledger_id) REFERENCES ledgers(id),
      FOREIGN KEY(cost_centre_id) REFERENCES cost_centres(id)
    )
  `);

  // 11. Inventory Movements (Item Allocation in Vouchers)
  await run(`
    CREATE TABLE IF NOT EXISTS inventory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      stock_item_id INTEGER NOT NULL,
      direction TEXT NOT NULL, -- 'IN' (Purchase/Inward) or 'OUT' (Sales/Outward)
      quantity REAL NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      discount_pct REAL DEFAULT 0,
      godown_id INTEGER,
      FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY(stock_item_id) REFERENCES stock_items(id),
      FOREIGN KEY(godown_id) REFERENCES godowns(id)
    )
  `);

  // 12. Bill-by-Bill Allocation Master (For Outstandings & Ageing)
  await run(`
    CREATE TABLE IF NOT EXISTS bill_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      ledger_id INTEGER NOT NULL,
      bill_type TEXT NOT NULL, -- 'New Ref', 'Agst Ref', 'Advance', 'On Account'
      bill_ref TEXT NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT,
      FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY(ledger_id) REFERENCES ledgers(id)
    )
  `);

  // 13. Bank Reconciliation Master
  await run(`
    CREATE TABLE IF NOT EXISTS bank_reconciliation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_entry_id INTEGER NOT NULL UNIQUE,
      bank_clearing_date TEXT,
      instrument_no TEXT,
      status TEXT DEFAULT 'Pending', -- 'Pending' or 'Cleared'
      FOREIGN KEY(ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE CASCADE
    )
  `);

  await seedTallyMasters();
}

async function seedTallyMasters() {
  const comp = await get('SELECT COUNT(*) as count FROM company_info');
  if (comp.count > 0) return;

  console.log('[Tally Core DB] Seeding Statutory Indian Masters for Company 100000...');

  // 1. Company Information
  await run(`
    INSERT INTO company_info (company_number, name, formal_name, financial_year_from, books_beginning_from, gstin, pan, address, state, state_code, pin_code)
    VALUES ('100000', 'Ramraj Enterprises', 'M/s. RAMRAJ ENTERPRISES', '2026-04-01', '2026-04-01', '33ANUPS7331M1Z8', 'ANUPS7331M', '12/4 Industrial Estate, Ambattur', 'Tamil Nadu', '33', '600058')
  `);

  // 2. Standard Tally 28 Groups (15 Primary + 13 Secondary)
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
    { id: 14, name: 'Misc. Expenses (ASSET)', nature: 'Assets', aff: 0 },
    { id: 15, name: 'Branch / Divisions', nature: 'Liabilities', aff: 0 }
  ];

  for (const g of primaryGroups) {
    await run(
      'INSERT INTO account_groups (id, name, nature, parent_id, affects_gross_profit, is_primary) VALUES (?, ?, ?, NULL, ?, 1)',
      [g.id, g.name, g.nature, g.aff]
    );
  }

  const subGroups = [
    { id: 16, name: 'Sundry Debtors', nature: 'Assets', parent: 6, aff: 0 },
    { id: 17, name: 'Sundry Creditors', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 18, name: 'Bank Accounts', nature: 'Assets', parent: 6, aff: 0 },
    { id: 19, name: 'Cash-in-hand', nature: 'Assets', parent: 6, aff: 0 },
    { id: 20, name: 'Duties & Taxes', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 21, name: 'Stock-in-hand', nature: 'Assets', parent: 6, aff: 0 },
    { id: 22, name: 'Bank OD A/c', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 23, name: 'Secured Loans', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 24, name: 'Unsecured Loans', nature: 'Liabilities', parent: 2, aff: 0 },
    { id: 25, name: 'Deposits (Asset)', nature: 'Assets', parent: 6, aff: 0 },
    { id: 26, name: 'Loans & Advances (Asset)', nature: 'Assets', parent: 6, aff: 0 },
    { id: 27, name: 'Provisions', nature: 'Liabilities', parent: 3, aff: 0 },
    { id: 28, name: 'Reserves & Surplus', nature: 'Liabilities', parent: 1, aff: 0 }
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
    { symbol: 'KGS', formal: 'Kilograms', dec: 2 },
    { symbol: 'MTR', formal: 'Metres', dec: 2 }
  ];
  for (const u of units) {
    await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [u.symbol, u.formal, u.dec]);
  }

  // 4. Godowns / Locations
  await run("INSERT INTO godowns (name, location) VALUES ('Main Godown (Ambattur)', 'Ambattur Industrial Estate')");
  await run("INSERT INTO godowns (name, location) VALUES ('Warehouse Guindy', 'Guindy SIDCO, Chennai')");
  await run("INSERT INTO godowns (name, location) VALUES ('Plant Assembly Floor', 'Shop Floor Unit 2')");

  // 5. Cost Centres
  await run("INSERT INTO cost_centres (name, category) VALUES ('Compressor Manufacturing Unit', 'Manufacturing')");
  await run("INSERT INTO cost_centres (name, category) VALUES ('Customer Service & AMC Division', 'Service')");
  await run("INSERT INTO cost_centres (name, category) VALUES ('General Administration', 'Admin')");

  // 6. Stock Groups
  await run("INSERT INTO stock_groups (name) VALUES ('Screw Compressors')");
  await run("INSERT INTO stock_groups (name) VALUES ('Spare Parts & Consumables')");
  await run("INSERT INTO stock_groups (name) VALUES ('Service Kits & Lubes')");

  // 7. Stock Items Master
  const stockItems = [
    { name: 'RRE Screw Compressor 15 HP (Air-Cooled)', group: 1, uom: 2, hsn: '84148011', gst: 18, cost: 230000, price: 345000, oQty: 4, oRate: 230000 },
    { name: 'RRE Screw Compressor 30 HP (VFD Speed)', group: 1, uom: 2, hsn: '84148011', gst: 18, cost: 395000, price: 580000, oQty: 2, oRate: 395000 },
    { name: 'Airend Assembly Rotor 15HP', group: 2, uom: 1, hsn: '84149090', gst: 18, cost: 78000, price: 110000, oQty: 8, oRate: 78000 },
    { name: 'Air-Oil Separator Element 15/30HP', group: 2, uom: 1, hsn: '84213920', gst: 18, cost: 2600, price: 4800, oQty: 25, oRate: 2600 },
    { name: 'Screw Compressor Oil Filter Spin-On', group: 2, uom: 1, hsn: '84212900', gst: 18, cost: 850, price: 1650, oQty: 30, oRate: 850 },
    { name: 'RRE Ultra-Lube Synthetic Compressor Oil 20L', group: 3, uom: 4, hsn: '27101990', gst: 18, cost: 6100, price: 9200, oQty: 18, oRate: 6100 }
  ];

  for (const it of stockItems) {
    const oVal = it.oQty * it.oRate;
    await run(
      `INSERT INTO stock_items (name, stock_group_id, uom_id, hsn_code, gst_rate, standard_cost, standard_price, opening_qty, opening_rate, opening_val)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [it.name, it.group, it.uom, it.hsn, it.gst, it.cost, it.price, it.oQty, it.oRate, oVal]
    );
  }

  const totalStockVal = stockItems.reduce((acc, cur) => acc + (cur.oQty * cur.oRate), 0); // 25,34,300

  // 8. Standard Ledgers with Equilibrium Opening Balances:
  // Total Assets = Cash(75k) + Bank(1250k) + Fixed Assets(770k) + Debtors(250k) + Stock(2534300) = 48,79,300 Dr
  // Total Creditors = 250,000 Cr
  // Capital = 48,79,300 - 250,000 = 46,29,300 Cr
  const ledgers = [
    { name: 'Cash', group: 19, opBal: 75000, opType: 'Dr' },
    { name: 'HDFC Bank Current A/c', group: 18, opBal: 1250000, opType: 'Dr', state: 'Tamil Nadu', stateCode: '33', accNo: '50200012345678', ifsc: 'HDFC0000123' },
    { name: 'State Bank of India (OD A/c)', group: 22, opBal: 0, opType: 'Cr', state: 'Tamil Nadu', stateCode: '33', accNo: '30495811223', ifsc: 'SBIN0001122' },

    { name: 'Plant & Machinery', group: 4, opBal: 650000, opType: 'Dr' },
    { name: 'Computers & IT Equipment', group: 4, opBal: 120000, opType: 'Dr' },

    { name: 'Proprietor Capital A/c', group: 1, opBal: 4629300, opType: 'Cr' },
    { name: 'General Reserve', group: 28, opBal: 0, opType: 'Cr' },

    { name: 'Stock-in-hand', group: 21, opBal: totalStockVal, opType: 'Dr' },

    { name: 'Input CGST 9%', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Input SGST 9%', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Input IGST 18%', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Output CGST 9%', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Output SGST 9%', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Output IGST 18%', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Round Off A/c', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'TDS Payable', group: 20, opBal: 0, opType: 'Cr' },

    { name: 'Chennai Auto Components Pvt Ltd', group: 16, opBal: 120000, opType: 'Dr', gstin: '33AABCC1234F1Z1', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Southern Textiles & Spinning Mills', group: 16, opBal: 85000, opType: 'Dr', gstin: '33AAECS5678M1Z8', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Precision Engineering & Toolings', group: 16, opBal: 45000, opType: 'Dr', gstin: '33AABCP9988K1Z5', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Bangalore Machine Tools Ltd', group: 16, opBal: 0, opType: 'Dr', gstin: '29AAACB1234F1Z3', state: 'Karnataka', stateCode: '29' },

    { name: 'Elgi Equipments Spares Ltd', group: 17, opBal: 210000, opType: 'Cr', gstin: '33AABCE4455P1Z2', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Bharat Electric Motors Vendor', group: 17, opBal: 40000, opType: 'Cr', gstin: '33AABCB1122M1Z9', state: 'Tamil Nadu', stateCode: '33' },
    { name: 'Pune Pneumatics Industries', group: 17, opBal: 0, opType: 'Cr', gstin: '27AABCP5678Q1Z9', state: 'Maharashtra', stateCode: '27' },

    { name: 'Sales Account - Compressors', group: 7, opBal: 0, opType: 'Cr' },
    { name: 'Sales Account - Spares & Lubes', group: 7, opBal: 0, opType: 'Cr' },
    { name: 'Interstate Sales (IGST)', group: 7, opBal: 0, opType: 'Cr' },
    { name: 'Service & Maintenance AMC Charges', group: 7, opBal: 0, opType: 'Cr' },

    { name: 'Purchase Account - Spares & Machines', group: 8, opBal: 0, opType: 'Dr' },
    { name: 'Interstate Purchases (IGST)', group: 8, opBal: 0, opType: 'Dr' },

    { name: 'Factory Electricity Charges', group: 10, opBal: 0, opType: 'Dr' },
    { name: 'Factory Direct Wages', group: 10, opBal: 0, opType: 'Dr' },
    { name: 'Freight & Transportation Inward', group: 10, opBal: 0, opType: 'Dr' },

    { name: 'Office Rent', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Staff Salaries & Wages', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Telephone & Internet Charges', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Bank Charges', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Depreciation on Assets', group: 12, opBal: 0, opType: 'Dr' },

    { name: 'Discount Received', group: 11, opBal: 0, opType: 'Cr' },
    { name: 'Interest on Bank Deposits', group: 11, opBal: 0, opType: 'Cr' }
  ];

  for (const l of ledgers) {
    await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, gstin, state, state_code, bank_account_no, bank_ifsc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.name, l.group, l.opBal || 0, l.opType || 'Dr', l.gstin || '', l.state || 'Tamil Nadu', l.stateCode || '33', l.accNo || null, l.ifsc || null]
    );
  }

  // ID lookup map
  const allLedgers = await all('SELECT id, name FROM ledgers');
  const lMap = {};
  allLedgers.forEach(r => { lMap[r.name] = r.id; });

  // 9. Balanced Vouchers & Allocations
  // V1: F8 Sales (Local Intra-State with CGST & SGST)
  const v1 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Sales', 'RRE/SALES/001', '2026-05-10', 'PO-8842', 'Being 15HP Screw Compressor sold to Chennai Auto with 18% GST', ?, 407100)`,
    [lMap['Chennai Auto Components Pvt Ltd']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 407100, 0, 'Chennai Auto Components Pvt Ltd')", [v1.lastID, lMap['Chennai Auto Components Pvt Ltd']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 345000, 'Sales Account - Compressors')", [v1.lastID, lMap['Sales Account - Compressors']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 31050, 'Output CGST 9%')", [v1.lastID, lMap['Output CGST 9%']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 31050, 'Output SGST 9%')", [v1.lastID, lMap['Output SGST 9%']]);
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, 1, 'OUT', 1, 345000, 345000, 1)", [v1.lastID]);
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date) VALUES (?, ?, 'New Ref', 'RRE/SALES/001', 407100, '2026-06-10')", [v1.lastID, lMap['Chennai Auto Components Pvt Ltd']]);

  // V2: F8 Sales (Inter-State with IGST)
  const v2 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Sales', 'RRE/SALES/002', '2026-05-12', 'PO-BMT-101', 'Sale of Airend Assembly Rotor to Bangalore with 18% IGST', ?, 129800)`,
    [lMap['Bangalore Machine Tools Ltd']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 129800, 0, 'Bangalore Machine Tools Ltd')", [v2.lastID, lMap['Bangalore Machine Tools Ltd']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 110000, 'Interstate Sales (IGST)')", [v2.lastID, lMap['Interstate Sales (IGST)']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 19800, 'Output IGST 18%')", [v2.lastID, lMap['Output IGST 18%']]);
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, 3, 'OUT', 1, 110000, 110000, 1)", [v2.lastID]);
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date) VALUES (?, ?, 'New Ref', 'RRE/SALES/002', 129800, '2026-06-12')", [v2.lastID, lMap['Bangalore Machine Tools Ltd']]);

  // V3: F9 Purchase (Inward Purchase with Input Tax Credit)
  const v3 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Purchase', 'RRE/PUR/001', '2026-05-18', 'INV-ELGI-9921', 'Purchase of 2 Airend Rotors with Input Tax Credit', ?, 184080)`,
    [lMap['Elgi Equipments Spares Ltd']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 156000, 0, 'Purchase Account - Spares & Machines')", [v3.lastID, lMap['Purchase Account - Spares & Machines']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 14040, 0, 'Input CGST 9%')", [v3.lastID, lMap['Input CGST 9%']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 14040, 0, 'Input SGST 9%')", [v3.lastID, lMap['Input SGST 9%']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 184080, 'Elgi Equipments Spares Ltd')", [v3.lastID, lMap['Elgi Equipments Spares Ltd']]);
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, 3, 'IN', 2, 78000, 156000, 1)", [v3.lastID]);
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount, due_date) VALUES (?, ?, 'New Ref', 'INV-ELGI-9921', 184080, '2026-06-18')", [v3.lastID, lMap['Elgi Equipments Spares Ltd']]);

  // V4: F6 Receipt (Bank Collection)
  const v4 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Receipt', 'RRE/REC/001', '2026-05-20', 'RTGS-109283', 'Payment received in full against Invoice RRE/SALES/001', ?, 407100)`,
    [lMap['Chennai Auto Components Pvt Ltd']]
  );
  const v4DrEntry = await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 407100, 0, 'HDFC Bank Current A/c')", [v4.lastID, lMap['HDFC Bank Current A/c']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 407100, 'Chennai Auto Components Pvt Ltd')", [v4.lastID, lMap['Chennai Auto Components Pvt Ltd']]);
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount) VALUES (?, ?, 'Agst Ref', 'RRE/SALES/001', 407100)", [v4.lastID, lMap['Chennai Auto Components Pvt Ltd']]);
  await run("INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status) VALUES (?, '2026-05-21', 'RTGS-109283', 'Cleared')", [v4DrEntry.lastID]);

  // V5: F5 Payment (Vendor Payment)
  const v5 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Payment', 'RRE/PMT/001', '2026-05-25', 'NEFT-88391', 'Payment made against Invoice INV-ELGI-9921', ?, 184080)`,
    [lMap['Elgi Equipments Spares Ltd']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 184080, 0, 'Elgi Equipments Spares Ltd')", [v5.lastID, lMap['Elgi Equipments Spares Ltd']]);
  const v5CrEntry = await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 184080, 'HDFC Bank Current A/c')", [v5.lastID, lMap['HDFC Bank Current A/c']]);
  await run("INSERT INTO bill_allocations (voucher_id, ledger_id, bill_type, bill_ref, amount) VALUES (?, ?, 'Agst Ref', 'INV-ELGI-9921', 184080)", [v5.lastID, lMap['Elgi Equipments Spares Ltd']]);
  await run("INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status) VALUES (?, '2026-05-26', 'NEFT-88391', 'Cleared')", [v5CrEntry.lastID]);

  // V6: F5 Payment (Office Rent)
  const v6 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Payment', 'RRE/PMT/002', '2026-05-31', 'CHQ-44021', 'Office premises rent paid for May 2026', ?, 45000)`,
    [lMap['Office Rent']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 45000, 0, 'Office Rent')", [v6.lastID, lMap['Office Rent']]);
  const v6CrEntry = await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 45000, 'HDFC Bank Current A/c')", [v6.lastID, lMap['HDFC Bank Current A/c']]);
  await run("INSERT INTO bank_reconciliation (ledger_entry_id, bank_clearing_date, instrument_no, status) VALUES (?, NULL, 'CHQ-44021', 'Pending')", [v6CrEntry.lastID]);

  // V7: F4 Contra (Cash Withdrawal)
  const v7 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Contra', 'RRE/CON/001', '2026-06-01', 'SELF-CHQ-102', 'Self cheque cash withdrawal for office petty expenses', ?, 25000)`,
    [lMap['Cash']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 25000, 0, 'Cash')", [v7.lastID, lMap['Cash']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 25000, 'HDFC Bank Current A/c')", [v7.lastID, lMap['HDFC Bank Current A/c']]);

  // V8: F7 Journal (Monthly Depreciation)
  const v8 = await run(
    `INSERT INTO vouchers (voucher_type, voucher_no, date, reference_no, narration, party_ledger_id, total_amount)
     VALUES ('Journal', 'RRE/JRN/001', '2026-06-01', 'DEP-MAY-26', 'Being monthly depreciation provided on Plant & Machinery @ 15% p.a.', ?, 15000)`,
    [lMap['Plant & Machinery']]
  );
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Dr', 15000, 0, 'Depreciation on Assets')", [v8.lastID, lMap['Depreciation on Assets']]);
  await run("INSERT INTO ledger_entries (voucher_id, ledger_id, entry_type, debit_amount, credit_amount, particulars) VALUES (?, ?, 'Cr', 0, 15000, 'Plant & Machinery')", [v8.lastID, lMap['Plant & Machinery']]);

  console.log('[Tally Core DB] Company 100000 seeded with verified mathematical equilibrium!');
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb
};

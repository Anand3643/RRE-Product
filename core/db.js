const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { hashPassword, verifyPassword, createSessionToken } = require('./security');
const { checkPassword } = require('./passwordPolicy');

// Determine the active company's data directory (see core/paths.js). One folder + database per company.
const paths = require('./paths');
let activeCompany = paths.DEFAULT_COMPANY;
let dataDir;
let dbPath;

// Single-folder override (used by tests): the folder IS the company; no other companies can be created.
const singleFolderMode = !!process.env.RRE_DATA_DIR;
if (singleFolderMode) {
  dataDir = path.resolve(process.env.RRE_DATA_DIR);
} else {
  const reg = paths.readRegistry();
  if (reg && reg.active && fs.existsSync(paths.companyDir(reg.active))) activeCompany = String(reg.active);
  dataDir = paths.companyDir(activeCompany);
}

try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (mErr) {
  console.warn('[Tally Core DB] Could not create dataDir, falling back to temp:', mErr.message);
  dataDir = path.join(process.env.TEMP || '.', 'TallyPrimeGold', 'data', activeCompany);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

dbPath = path.resolve(dataDir, 'company.db');

// If the original company's database is missing or empty, copy a pre-seeded one from candidate resources
const needsSeed = activeCompany === paths.DEFAULT_COMPANY && (!fs.existsSync(dbPath) || (fs.existsSync(dbPath) && fs.statSync(dbPath).size < 1000));
if (needsSeed) {
  const candidateSeeds = [
    process.resourcesPath ? path.join(process.resourcesPath, 'data', '100000', 'company.db') : null,
    path.join(__dirname, '..', 'data', '100000', 'company.db'),
    path.join(__dirname, 'data', '100000', 'company.db'),
    path.resolve('data', '100000', 'company.db')
  ].filter(Boolean);

  for (const seedCandidate of candidateSeeds) {
    if (fs.existsSync(seedCandidate) && path.resolve(seedCandidate) !== dbPath) {
      try {
        fs.copyFileSync(seedCandidate, dbPath);
        console.log(`[Tally Core DB] Pre-seeded company database copied from ${seedCandidate} to: ${dbPath}`);
        break;
      } catch (e) {
        console.warn(`[Tally Core DB] Could not copy from ${seedCandidate}:`, e.message);
      }
    }
  }
}

// Session tokens are bound to the company they were issued in (see core/security.js)
require('./security').setCompanyProvider(() => activeCompany);

let db = null;

function connectDb() {
  if (db) return db;
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Failed to open Tally company database:', err.message);
    } else {
      console.log(`[Tally Core DB] Connected to Company 100000 database at: ${dbPath}`);
    }
  });
  return db;
}

// Initial connection
connectDb();

function closeDb() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close((err) => {
      if (err) console.warn('[Tally Core DB] Close warning:', err.message);
      db = null;
      resolve();
    });
  });
}

function reopenDb() {
  return new Promise((resolve) => {
    connectDb();
    resolve();
  });
}

/** Points this process at another company's database. Callers (core/companies.js) coordinate the rest. */
async function switchDatabase(number) {
  if (singleFolderMode) throw new Error('Company switching is unavailable when RRE_DATA_DIR is set.');
  const dir = paths.companyDir(number);
  fs.mkdirSync(dir, { recursive: true });
  await closeDb();
  activeCompany = String(number);
  dataDir = dir;
  dbPath = path.resolve(dir, 'company.db');
  connectDb();
}
const getDbPath = () => dbPath;
const getDataDir = () => dataDir;
const getCompanyNumber = () => activeCompany;

// Promisified query wrappers
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) connectDb();
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) connectDb();
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) connectDb();
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

async function initDb() {
  await run('PRAGMA foreign_keys = ON');
  try {
    await run('PRAGMA journal_mode = WAL');
    await run('PRAGMA synchronous = NORMAL');
    await run('PRAGMA busy_timeout = 5000');
  } catch (pErr) {}

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

  // 14. Tally Security Control & Multi-User Accounts
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Data Entry',
      email TEXT,
      phone TEXT,
      status TEXT DEFAULT 'Active',
      allow_backdated_entries INTEGER DEFAULT 1,
      disallowed_vouchers TEXT DEFAULT '',
      auth_provider TEXT DEFAULT 'local',
      google_id TEXT,
      avatar_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )
  `);

  // Column migrations for Google and Email Authentication
  try { await run("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'"); } catch (e) {}
  try { await run("ALTER TABLE users ADD COLUMN google_id TEXT"); } catch (e) {}
  try { await run("ALTER TABLE users ADD COLUMN avatar_url TEXT"); } catch (e) {}

  // 15. User Login Audit Trail
  await run(`
    CREATE TABLE IF NOT EXISTS user_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Performance Indexes for High-Throughput Queries & Scalability
  await run('CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(date)');
  await run('CREATE INDEX IF NOT EXISTS idx_vouchers_type ON vouchers(voucher_type)');
  await run('CREATE INDEX IF NOT EXISTS idx_vouchers_no ON vouchers(voucher_no)');
  await run('CREATE INDEX IF NOT EXISTS idx_ledger_entries_vch ON ledger_entries(voucher_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_ledger_entries_ldg ON ledger_entries(ledger_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_inventory_entries_vch ON inventory_entries(voucher_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_inventory_entries_item ON inventory_entries(stock_item_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_bill_allocations_vch ON bill_allocations(voucher_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_bill_allocations_ldg ON bill_allocations(ledger_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_logins_user ON user_logins(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_logins_time ON user_logins(login_time)');

  await seedTallyMasters();
  await seedDefaultUsers(); // security columns, first-run administrator, and account hardening for existing databases
}

async function seedTallyMasters(force = false) {
  const comp = await get('SELECT COUNT(*) as count FROM company_info');
  if (comp.count > 0 && !force) return;

  if (force) {
    console.log('[Tally Core DB] Force re-seeding Statutory Indian Masters and Demo Vouchers...');
  } else {
    console.log('[Tally Core DB] Seeding Statutory Indian Masters for Company 100000...');
  }

  // 1. Company Information
  if (comp.count === 0) {
    await run(`
      INSERT INTO company_info (company_number, name, formal_name, financial_year_from, books_beginning_from, gstin, pan, address, state, state_code, pin_code)
      VALUES ('100000', 'RRE Tally', 'M/s. RRE TALLY', '2026-04-01', '2026-04-01', '', '', '', 'Tamil Nadu', '33', '')
    `);
  }

  // 2. Standard Tally 28 Groups (15 Primary + 13 Secondary)
  const grpCount = await get('SELECT COUNT(*) as count FROM account_groups');
  if (grpCount.count === 0) {
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
  }

  // 3. Units of Measure
  const uCount = await get('SELECT COUNT(*) as count FROM units_of_measure');
  if (uCount.count === 0) {
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
  }

  // 4. Godowns / Locations
  const gCount = await get('SELECT COUNT(*) as count FROM godowns');
  if (gCount.count === 0) {
    await run("INSERT INTO godowns (id, name, location) VALUES (1, 'Main Godown (Ambattur)', 'Ambattur Industrial Estate')");
    await run("INSERT INTO godowns (id, name, location) VALUES (2, 'Warehouse Guindy', 'Guindy SIDCO, Chennai')");
    await run("INSERT INTO godowns (id, name, location) VALUES (3, 'Plant Assembly Floor', 'Shop Floor Unit 2')");
  }

  // 5. Cost Centres
  const ccCount = await get('SELECT COUNT(*) as count FROM cost_centres');
  if (ccCount.count === 0) {
    await run("INSERT INTO cost_centres (id, name, category) VALUES (1, 'Compressor Manufacturing Unit', 'Manufacturing')");
    await run("INSERT INTO cost_centres (id, name, category) VALUES (2, 'Customer Service & AMC Division', 'Service')");
    await run("INSERT INTO cost_centres (id, name, category) VALUES (3, 'General Administration', 'Admin')");
  }

  // 6. Stock Groups
  const sgCount = await get('SELECT COUNT(*) as count FROM stock_groups');
  if (sgCount.count === 0) {
    await run("INSERT INTO stock_groups (id, name) VALUES (1, 'Screw Compressors')");
    await run("INSERT INTO stock_groups (id, name) VALUES (2, 'Spare Parts & Consumables')");
    await run("INSERT INTO stock_groups (id, name) VALUES (3, 'Service Kits & Lubes')");
  }

  // 7. Stock Items Master
  const sgRows = await all('SELECT id, name FROM stock_groups');
  const sgMap = {};
  sgRows.forEach(r => { sgMap[r.name] = r.id; });

  const uomRows = await all('SELECT id, symbol FROM units_of_measure');
  const uomMap = {};
  uomRows.forEach(r => { uomMap[r.symbol] = r.id; });

  const gRows = await all('SELECT id, name FROM godowns');
  const defaultGodownId = gRows[0]?.id || 1;

  const stockItems = [
    { name: 'RRE Screw Compressor 15 HP (Air-Cooled)', group: sgMap['Screw Compressors'] || sgRows[0]?.id, uom: uomMap['SET'] || uomRows[0]?.id, hsn: '84148011', gst: 18, cost: 230000, price: 345000, oQty: 4, oRate: 230000 },
    { name: 'RRE Screw Compressor 30 HP (VFD Speed)', group: sgMap['Screw Compressors'] || sgRows[0]?.id, uom: uomMap['SET'] || uomRows[0]?.id, hsn: '84148011', gst: 18, cost: 395000, price: 580000, oQty: 2, oRate: 395000 },
    { name: 'Airend Assembly Rotor 15HP', group: sgMap['Spare Parts & Consumables'] || sgRows[1]?.id, uom: uomMap['NOS'] || uomRows[0]?.id, hsn: '84149090', gst: 18, cost: 78000, price: 110000, oQty: 8, oRate: 78000 },
    { name: 'Air-Oil Separator Element 15/30HP', group: sgMap['Spare Parts & Consumables'] || sgRows[1]?.id, uom: uomMap['NOS'] || uomRows[0]?.id, hsn: '84213920', gst: 18, cost: 2600, price: 4800, oQty: 25, oRate: 2600 },
    { name: 'Screw Compressor Oil Filter Spin-On', group: sgMap['Spare Parts & Consumables'] || sgRows[1]?.id, uom: uomMap['NOS'] || uomRows[0]?.id, hsn: '84212900', gst: 18, cost: 850, price: 1650, oQty: 30, oRate: 850 },
    { name: 'RRE Ultra-Lube Synthetic Compressor Oil 20L', group: sgMap['Service Kits & Lubes'] || sgRows[2]?.id, uom: uomMap['DRUM'] || uomRows[3]?.id, hsn: '27101990', gst: 18, cost: 6100, price: 9200, oQty: 18, oRate: 6100 }
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

  // Stock items lookup map
  const itemRows = await all('SELECT id, name FROM stock_items');
  const itMap = {};
  itemRows.forEach(r => { itMap[r.name] = r.id; });

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
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, 'OUT', 1, 345000, 345000, ?)", [v1.lastID, itMap['RRE Screw Compressor 15 HP (Air-Cooled)'], defaultGodownId]);
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
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, 'OUT', 1, 110000, 110000, ?)", [v2.lastID, itMap['Airend Assembly Rotor 15HP'], defaultGodownId]);
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
  await run("INSERT INTO inventory_entries (voucher_id, stock_item_id, direction, quantity, rate, amount, godown_id) VALUES (?, ?, 'IN', 2, 78000, 156000, ?)", [v3.lastID, itMap['Airend Assembly Rotor 15HP'], defaultGodownId]);
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
  await seedDefaultUsers();
}

// ========================================================
// TALLY SECURITY CONTROL & MULTI-USER FUNCTIONS
// ========================================================

// Marker stored in place of a password while the first administrator has not chosen one yet. It is never a valid password:
// authenticateUser() checks for it before comparing anything.
const SETUP_MARKER = '!setup-required!';

// Passwords that earlier versions shipped for the demo accounts. They are listed ONLY so existing installations can be
// detected and forced to choose a new password; no new account is ever created with any of them.
const LEGACY_DEMO_PASSWORDS = {
  admin: ['admin123', 'admin'], accountant: ['acc123', 'acc'], dataentry: ['data123', 'data'],
  auditor: ['audit123', 'audit'], viewer: ['view123', 'view'], guest: ['guest', 'guest123']
};

async function ensureSecurityColumns() {
  const cols = (await all('PRAGMA table_info(users)')).map((c) => c.name);
  if (!cols.length) return;
  if (!cols.includes('must_change_password')) await run('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  if (!cols.includes('password_changed_at')) await run('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
}

let hardenedFor = null;
/**
 * Brings existing accounts up to the current security rules WITHOUT deleting or renaming anything:
 *  - the Guest account is switched off (its history and records stay);
 *  - any account still using a shipped demo password must choose a new one at next login.
 * Runs once per company database per process.
 */
async function hardenAccounts(force = false) {
  if (!force && hardenedFor === dbPath) return;
  await ensureSecurityColumns();
  const users = await all('SELECT id, username, role, password, status, must_change_password, password_changed_at FROM users');
  for (const u of users) {
    if (u.role === 'Guest' || String(u.username).toLowerCase() === 'guest') {
      if (u.status !== 'Inactive') {
        await run("UPDATE users SET status = 'Inactive' WHERE id = ?", [u.id]);
        console.log(`[Security] Guest account "${u.username}" was switched off (records kept).`);
      }
      continue;
    }
    if (u.password === SETUP_MARKER || u.must_change_password || u.password_changed_at) continue;
    const defaults = LEGACY_DEMO_PASSWORDS[String(u.username).toLowerCase()] || [];
    if (defaults.some((d) => verifyPassword(d, u.password).valid)) {
      await run('UPDATE users SET must_change_password = 1 WHERE id = ?', [u.id]);
      console.log(`[Security] Account "${u.username}" still uses a shipped demo password: a new password will be required at next login.`);
    }
  }
  hardenedFor = dbPath;
}

async function seedDefaultUsers() {
  const userTableExists = await get("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='users'");
  if (userTableExists.c === 0) return;
  await ensureSecurityColumns();

  const userCount = await get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    // A fresh installation gets ONE administrator account with no password. The person installing the application chooses
    // its password on first start (see isSetupRequired / setupAdmin). No demo accounts, no default passwords.
    await run(
      `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, must_change_password)
       VALUES ('admin', ?, 'Administrator', 'Owner', '', '', 'Active', 1, 1)`, [SETUP_MARKER]);
    console.log('[Security] First start: the administrator password must be chosen in the application before anyone can log in.');
  }
  await hardenAccounts();
}

async function isSetupRequired() {
  await seedDefaultUsers();
  const r = await get('SELECT COUNT(*) AS c FROM users WHERE password = ? AND role = ?', [SETUP_MARKER, 'Owner']);
  return r.c > 0;
}

/** Sets the first administrator's password. Only possible while setup is still pending. */
async function setupAdmin(password, clientMeta = {}) {
  await seedDefaultUsers();
  const owner = await get('SELECT * FROM users WHERE password = ? AND role = ? ORDER BY id LIMIT 1', [SETUP_MARKER, 'Owner']);
  if (!owner) { const e = new Error('Setup has already been completed.'); e.status = 409; throw e; }
  const weak = checkPassword(password, { username: owner.username });
  if (weak) { const e = new Error(weak); e.status = 400; throw e; }
  const r = await run('UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ? WHERE id = ? AND password = ?',
    [hashPassword(password.trim()), new Date().toISOString(), owner.id, SETUP_MARKER]);
  if (!r.changes) { const e = new Error('Setup has already been completed.'); e.status = 409; throw e; }
  return handleLoginSuccess(await get('SELECT * FROM users WHERE id = ?', [owner.id]), clientMeta);
}

/** A signed-in person changes their own password (also the way out of "must change password"). */
async function changePassword(userId, currentPassword, newPassword, clientMeta = {}) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || user.status !== 'Active') { const e = new Error('Account not available.'); e.status = 403; throw e; }
  if (user.password === SETUP_MARKER || !verifyPassword(currentPassword || '', user.password).valid) { const e = new Error('The current password is not correct.'); e.status = 400; throw e; }
  const weak = checkPassword(newPassword, { username: user.username });
  if (weak) { const e = new Error(weak); e.status = 400; throw e; }
  if (verifyPassword(newPassword || '', user.password).valid) { const e = new Error('The new password must be different from the current one.'); e.status = 400; throw e; }
  await run('UPDATE users SET password = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?', [hashPassword(newPassword.trim()), new Date().toISOString(), user.id]);
  return handleLoginSuccess(await get('SELECT * FROM users WHERE id = ?', [user.id]), clientMeta);
}

async function authenticateUser(username, password, clientMeta = {}) {
  await seedDefaultUsers();
  const u = (username || '').trim();
  const generic = { success: false, error: 'Incorrect username or password.' };
  const user = u ? await get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [u]) : null;
  if (!user) return generic;
  if (user.role === 'Guest') return { success: false, error: 'Guest access is turned off.' };
  if (user.status !== 'Active') return { success: false, error: 'User account is deactivated. Contact Company Administrator.' };
  if (user.password === SETUP_MARKER) return { success: false, error: 'First-time setup is not finished. Open RRE Tally on this computer and choose the administrator password.' };

  const p = (password || '').trim();
  if (!p) return generic;
  const verifyResult = verifyPassword(p, user.password);
  if (!verifyResult.valid) return generic;

  // Transparent cryptographic migration: upgrade a legacy plaintext password to a salted PBKDF2 hash on the fly
  if (verifyResult.needsMigration || !user.password.startsWith('pbkdf2$')) {
    try { await run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(p), user.id]); } catch (migErr) { console.warn('[Security] Password migration notice:', migErr.message); }
  }
  return handleLoginSuccess(user, clientMeta);
}

async function handleLoginSuccess(user, clientMeta = {}) {
  const now = new Date().toISOString();
  await run('UPDATE users SET last_login = ? WHERE id = ?', [now, user.id]);
  
  await run(
    `INSERT INTO user_logins (user_id, username, role, ip_address, user_agent, login_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, user.username, user.role, clientMeta.ip || '127.0.0.1', clientMeta.agent || 'TallyClient', now]
  );

  const permissions = getRolePermissions(user.role);
  const token = createSessionToken(user);

  return {
    success: true,
    data: {
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        email: user.email,
        phone: user.phone,
        status: user.status,
        allow_backdated_entries: user.allow_backdated_entries
      },
      permissions,
      token,
      must_change_password: !!user.must_change_password
    }
  };
}

function getRolePermissions(role) {
  switch (role) {
    case 'Owner':
    case 'Administrator':
      return {
        role: 'Owner',
        canCreateVouchers: true,
        canEditVouchers: true,
        canDeleteVouchers: true,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: true,
        canAlterCompany: true,
        canCleanSlate: true,
        badgeColor: 'purple',
        allowedVoucherTypes: ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note']
      };
    case 'Accountant':
      return {
        role: 'Accountant',
        canCreateVouchers: true,
        canEditVouchers: true,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'blue',
        allowedVoucherTypes: ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Debit Note', 'Credit Note']
      };
    case 'Data Entry':
      return {
        role: 'Data Entry',
        canCreateVouchers: true,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: false,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'amber',
        allowedVoucherTypes: ['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra']
      };
    case 'Auditor':
      return {
        role: 'Auditor',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: true,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'emerald',
        allowedVoucherTypes: []
      };
    case 'Guest':
      return {
        role: 'Guest',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'teal',
        allowedVoucherTypes: []
      };
    case 'Viewer':
    default:
      return {
        role: 'Viewer',
        canCreateVouchers: false,
        canEditVouchers: false,
        canDeleteVouchers: false,
        canViewFinancials: true,
        canViewAuditTrail: false,
        canManageUsers: false,
        canAlterCompany: false,
        canCleanSlate: false,
        badgeColor: 'slate',
        allowedVoucherTypes: []
      };
  }
}

async function getAllUsers() {
  await seedDefaultUsers();
  return await all('SELECT id, username, full_name, role, email, phone, status, allow_backdated_entries, auth_provider, google_id, created_at, last_login FROM users ORDER BY id ASC');
}

const ASSIGNABLE_ROLES = ['Owner', 'Accountant', 'Data Entry', 'Auditor', 'Viewer'];

async function createUser(userData) {
  await seedDefaultUsers();
  const { username, password, full_name, role, email, phone, allow_backdated_entries } = userData;
  if (!username || !password || !full_name) {
    throw new Error('Username, password, and full name are required.');
  }
  const assigned = role || 'Data Entry';
  if (!ASSIGNABLE_ROLES.includes(assigned)) throw new Error(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  const weak = checkPassword(password, { username });
  if (weak) throw new Error(weak);
  const existing = await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username.trim()]);
  if (existing) {
    throw new Error(`Username "${username}" already exists.`);
  }
  const hashedPassword = hashPassword(password.trim());
  // the password an administrator types is temporary: the person must choose their own at first login
  const res = await run(
    `INSERT INTO users (username, password, full_name, role, email, phone, allow_backdated_entries, status, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 1)`,
    [username.trim(), hashedPassword, full_name.trim(), assigned, email || '', phone || '', allow_backdated_entries ? 1 : 0]
  );
  return { success: true, id: res.lastID, message: `User "${username}" created successfully. They must choose a new password at first login.` };
}

async function updateUser(id, userData) {
  const { full_name, role, password, email, phone, status, allow_backdated_entries } = userData;
  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw new Error('User not found.');

  if (role && !ASSIGNABLE_ROLES.includes(role)) throw new Error(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  if (user.role === 'Owner' && role && role !== 'Owner') {
    const ownerCount = await get("SELECT COUNT(*) as c FROM users WHERE role = 'Owner' AND status = 'Active'");
    if (ownerCount.c <= 1) {
      throw new Error('Cannot change role of the sole active Owner.');
    }
  }

  let sql = 'UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), email = COALESCE(?, email), phone = COALESCE(?, phone), status = COALESCE(?, status)';
  const params = [full_name, role, email, phone, status];

  if (allow_backdated_entries !== undefined && allow_backdated_entries !== null) {
    sql += ', allow_backdated_entries = ?';
    params.push(allow_backdated_entries ? 1 : 0);
  }

  if (password && password.trim()) {
    const weak = checkPassword(password.trim(), { username: user.username });
    if (weak) throw new Error(weak);
    sql += ', password = ?, must_change_password = 1, password_changed_at = NULL';
    params.push(hashPassword(password.trim()));
  }
  sql += ' WHERE id = ?';
  params.push(id);

  await run(sql, params);
  return { success: true, message: `User "${user.username}" updated successfully.` };
}

async function deleteUser(id) {
  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw new Error('User not found.');
  if (user.role === 'Owner') {
    const ownerCount = await get("SELECT COUNT(*) as c FROM users WHERE role = 'Owner' AND status = 'Active'");
    if (ownerCount.c <= 1) {
      throw new Error('Cannot delete the sole Owner / Administrator of the company.');
    }
  }
  await run('DELETE FROM users WHERE id = ?', [id]);
  return { success: true, message: `User "${user.username}" removed.` };
}

async function getLoginAuditTrail(limit = 50) {
  return await all('SELECT * FROM user_logins ORDER BY login_time DESC LIMIT ?', [limit]);
}

async function resetCleanCompany() {
  console.log('[Tally Core DB] Creating pre-reset safety backup...');
  try {
    const { createBackup } = require('./backupEngine');
    await createBackup({ notes: 'Automated Disaster Recovery snapshot before Resetting to Clean Slate' });
  } catch (bErr) {
    console.warn('[Disaster Recovery] Auto-backup notice:', bErr.message);
  }

  console.log('[Tally Core DB] Resetting Company to Clean Production Slate...');
  await run('PRAGMA foreign_keys = OFF');
  await run('DELETE FROM bank_reconciliation');
  await run('DELETE FROM bill_allocations');
  await run('DELETE FROM inventory_entries');
  await run('DELETE FROM ledger_entries');
  await run('DELETE FROM vouchers');
  await run('DELETE FROM stock_items');
  await run('DELETE FROM ledgers');
  await run('PRAGMA foreign_keys = ON');

  // Insert standard units if missing
  const unitCount = await get('SELECT COUNT(*) as c FROM units_of_measure');
  if (unitCount.c === 0) {
    const units = [
      { symbol: 'NOS', formal: 'Numbers', dec: 0 },
      { symbol: 'SET', formal: 'Sets', dec: 0 },
      { symbol: 'PCS', formal: 'Pieces', dec: 0 },
      { symbol: 'KGS', formal: 'Kilograms', dec: 2 },
      { symbol: 'MTR', formal: 'Metres', dec: 2 }
    ];
    for (const u of units) {
      await run('INSERT INTO units_of_measure (symbol, formal_name, decimal_places) VALUES (?, ?, ?)', [u.symbol, u.formal, u.dec]);
    }
  }

  // Insert standard godown if missing
  const godownCount = await get('SELECT COUNT(*) as c FROM godowns');
  if (godownCount.c === 0) {
    await run("INSERT INTO godowns (name, location) VALUES ('Main Location', 'Primary Godown')");
  }

  // Insert standard cost centre if missing
  const ccCount = await get('SELECT COUNT(*) as c FROM cost_centres');
  if (ccCount.c === 0) {
    await run("INSERT INTO cost_centres (name, category) VALUES ('Primary Cost Centre', 'Default')");
  }

  // Create clean core statutory ledgers with 0 balances
  const cleanLedgers = [
    { name: 'Cash', group: 19, opBal: 0, opType: 'Dr' },
    { name: 'Bank Account', group: 18, opBal: 0, opType: 'Dr' },
    { name: 'Proprietor Capital A/c', group: 1, opBal: 0, opType: 'Cr' },
    { name: 'Sales Account', group: 7, opBal: 0, opType: 'Cr' },
    { name: 'Purchase Account', group: 8, opBal: 0, opType: 'Dr' },
    { name: 'Input CGST', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Input SGST', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Input IGST', group: 20, opBal: 0, opType: 'Dr' },
    { name: 'Output CGST', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Output SGST', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Output IGST', group: 20, opBal: 0, opType: 'Cr' },
    { name: 'Round Off A/c', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Office Expenses', group: 12, opBal: 0, opType: 'Dr' },
    { name: 'Freight Charges', group: 10, opBal: 0, opType: 'Dr' }
  ];

  for (const l of cleanLedgers) {
    await run(
      `INSERT INTO ledgers (name, group_id, opening_balance, opening_balance_type, state, state_code)
       VALUES (?, ?, ?, ?, 'Tamil Nadu', '33')`,
      [l.name, l.group, l.opBal, l.opType]
    );
  }

  console.log('[Tally Core DB] Clean Production Slate active (0 vouchers, 0 stock items, ₹0 Dr/Cr)!');
  return { success: true, message: 'Company reset to clean production state successfully.' };
}

async function loadDemoCompany() {
  console.log('[Tally Core DB] Creating pre-reload safety backup...');
  try {
    const { createBackup } = require('./backupEngine');
    await createBackup({ notes: 'Automated Disaster Recovery snapshot before Reloading Demo Data' });
  } catch (bErr) {
    console.warn('[Disaster Recovery] Auto-backup notice:', bErr.message);
  }

  console.log('[Tally Core DB] Reloading Demo Sample Data...');
  await run('PRAGMA foreign_keys = OFF');
  await run('DELETE FROM bank_reconciliation');
  await run('DELETE FROM bill_allocations');
  await run('DELETE FROM inventory_entries');
  await run('DELETE FROM ledger_entries');
  await run('DELETE FROM vouchers');
  await run('DELETE FROM stock_items');
  await run('DELETE FROM ledgers');
  await run('PRAGMA foreign_keys = ON');
  await seedTallyMasters(true);
  return { success: true, message: 'Demo sample data reloaded successfully.' };
}

async function updateCompanyInfo(info) {
  const { name, formal_name, gstin, pan, address, state, state_code, pin_code, financial_year_from, books_beginning_from } = info;
  await run(
    `UPDATE company_info SET
       name = COALESCE(?, name),
       formal_name = COALESCE(?, formal_name),
       gstin = COALESCE(?, gstin),
       pan = COALESCE(?, pan),
       address = COALESCE(?, address),
       state = COALESCE(?, state),
       state_code = COALESCE(?, state_code),
       pin_code = COALESCE(?, pin_code),
       financial_year_from = COALESCE(?, financial_year_from),
       books_beginning_from = COALESCE(?, books_beginning_from)
     WHERE id = 1`,
    [name, formal_name, gstin, pan, address, state, state_code, pin_code, financial_year_from, books_beginning_from]
  );
  return { success: true, message: 'Company profile updated successfully.' };
}

async function registerUser(userData, clientMeta = {}) {
  await seedDefaultUsers();
  // Public self-registration is OFF unless the administrator turns it on for this computer (RRE_ALLOW_SELF_REGISTRATION=1).
  // Even then, the person cannot choose a role and cannot sign in until an administrator approves the account.
  if (process.env.RRE_ALLOW_SELF_REGISTRATION !== '1') {
    const e = new Error('Self-registration is turned off. Please ask the administrator to create your account.'); e.status = 403; throw e;
  }
  const { full_name, email, username, password } = userData;
  if (!full_name || !email || !password) throw new Error('Full name, email address, and password are required.');

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = full_name.trim();
  let cleanUsername = (username || cleanEmail.split('@')[0] || 'user').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!cleanUsername) cleanUsername = 'user_' + Date.now().toString().slice(-4);
  const weak = checkPassword(password, { username: cleanUsername });
  if (weak) throw new Error(weak);

  const existing = await get('SELECT id, username, email FROM users WHERE username = ? COLLATE NOCASE OR (email != "" AND email = ? COLLATE NOCASE)', [cleanUsername, cleanEmail]);
  if (existing) {
    if (existing.email && existing.email.toLowerCase() === cleanEmail) throw new Error(`An account with email "${cleanEmail}" already exists. Please log in.`);
    cleanUsername = `${cleanUsername}_${Date.now().toString().slice(-3)}`;
  }
  await run(
    `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, auth_provider, password_changed_at)
     VALUES (?, ?, ?, 'Viewer', ?, '', 'Inactive', 0, 'email', ?)`,
    [cleanUsername, hashPassword(password.trim()), cleanName, cleanEmail, new Date().toISOString()]);
  console.log(`[Authenticator] Self-registration received from "${cleanUsername}": waiting for administrator approval.`);
  return { success: true, data: { pending: true, message: 'Your account request was received. An administrator must approve it and assign a role before you can sign in.' } };
}

async function loginWithGoogle() {
  // The application runs offline and cannot verify a Google identity, so a client-supplied email must never be trusted:
  // it would let anyone claim any account, including the administrator's.
  const e = new Error('Google sign-in is turned off: an offline installation cannot verify a Google account.'); e.status = 403; throw e;
}

module.exports = {
  closeDb,
  switchDatabase,
  getDbPath,
  getDataDir,
  getCompanyNumber,
  singleFolderMode,
  reopenDb,
  run,
  get,
  all,
  initDb,
  resetCleanCompany,
  loadDemoCompany,
  updateCompanyInfo,
  authenticateUser,
  registerUser,
  loginWithGoogle,
  hardenAccounts,
  isSetupRequired,
  setupAdmin,
  changePassword,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getLoginAuditTrail,
  getRolePermissions
};

// Values that depend on the active company are exposed as live getters so existing code that reads them keeps working after a switch.
Object.defineProperty(module.exports, 'db', { enumerable: true, get: () => db });
Object.defineProperty(module.exports, 'dbPath', { enumerable: true, get: () => dbPath });
Object.defineProperty(module.exports, 'dataDir', { enumerable: true, get: () => dataDir });

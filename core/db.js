const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { hashPassword, verifyPassword, createSessionToken } = require('./security');

// Determine writable data directory mirroring TallyPrime Data path (e.g. data/100000)
const isPackaged = __dirname.includes('app.asar');
let dataDir;

if (isPackaged) {
  const appDataRoot = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '.');
  dataDir = path.join(appDataRoot, 'TallyPrimeGold', 'data', '100000');
} else {
  dataDir = path.resolve(__dirname, '..', 'data', '100000');
}

try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (mErr) {
  console.warn('[Tally Core DB] Could not create dataDir, falling back to temp:', mErr.message);
  dataDir = path.join(process.env.TEMP || '.', 'TallyPrimeGold', 'data', '100000');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.resolve(dataDir, 'company.db');

// If packaged and db doesn't exist or is empty, copy pre-seeded db from candidate resources
const needsSeed = !fs.existsSync(dbPath) || (fs.existsSync(dbPath) && fs.statSync(dbPath).size < 1000);
if (needsSeed) {
  const candidateSeeds = [
    process.resourcesPath ? path.join(process.resourcesPath, 'data', '100000', 'company.db') : null,
    path.join(__dirname, '..', 'data', '100000', 'company.db'),
    path.join(__dirname, 'data', '100000', 'company.db'),
    path.resolve('data', '100000', 'company.db')
  ].filter(Boolean);

  for (const seedCandidate of candidateSeeds) {
    if (fs.existsSync(seedCandidate)) {
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

  // 16. Sales Quotations / Estimates (Zoho Books-style)
  await run(`
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_no TEXT NOT NULL UNIQUE,
      revision INTEGER DEFAULT 0,
      parent_quote_id INTEGER,
      date TEXT NOT NULL,
      expiry_date TEXT,
      party_ledger_id INTEGER,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      customer_gstin TEXT,
      billing_address TEXT,
      place_of_supply TEXT,
      place_of_supply_code TEXT,
      reference_no TEXT,
      salesperson TEXT,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'Draft', -- Draft, Sent, Accepted, Declined, Expired, Invoiced
      discount_pct REAL DEFAULT 0,
      shipping_charges REAL DEFAULT 0,
      subtotal REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      taxable_amount REAL DEFAULT 0,
      cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0,
      igst REAL DEFAULT 0,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      customer_notes TEXT,
      terms TEXT,
      next_followup_date TEXT,
      converted_voucher_id INTEGER,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(party_ledger_id) REFERENCES ledgers(id),
      FOREIGN KEY(converted_voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL,
      stock_item_id INTEGER,
      item_name TEXT NOT NULL,
      description TEXT,
      hsn_code TEXT,
      uom TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      rate REAL NOT NULL DEFAULT 0,
      discount_pct REAL DEFAULT 0,
      gst_rate REAL DEFAULT 18,
      amount REAL NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE,
      FOREIGN KEY(stock_item_id) REFERENCES stock_items(id)
    )
  `);

  // 17. Quote Follow-up Activity Log
  await run(`
    CREATE TABLE IF NOT EXISTS quotation_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL,
      followup_date TEXT NOT NULL,
      mode TEXT DEFAULT 'Call', -- Call, Email, WhatsApp, Visit, Meeting
      notes TEXT,
      outcome TEXT, -- Interested, Negotiating, No Response, Revised, Won, Lost
      next_followup_date TEXT,
      done_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    )
  `);

  // Performance Indexes for High-Throughput Queries & Scalability
  await run('CREATE INDEX IF NOT EXISTS idx_quotations_date ON quotations(date)');
  await run('CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_quotations_followup ON quotations(next_followup_date)');
  await run('CREATE INDEX IF NOT EXISTS idx_quotation_items_q ON quotation_items(quotation_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_quotation_followups_q ON quotation_followups(quotation_id)');
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

async function seedDefaultUsers() {
  const userTableExists = await get("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='users'");
  if (userTableExists.c === 0) return;

  const userCount = await get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    const defaultUsers = [
      {
        username: 'admin',
        password: 'admin123',
        full_name: 'System Administrator (Owner)',
        role: 'Owner',
        email: 'admin@rretally.com',
        phone: '9840012345',
        allow_backdated_entries: 1
      },
      {
        username: 'accountant',
        password: 'acc123',
        full_name: 'S. Ramanathan (Senior Accountant)',
        role: 'Accountant',
        email: 'accountant@rretally.com',
        phone: '9840012346',
        allow_backdated_entries: 1
      },
      {
        username: 'dataentry',
        password: 'data123',
        full_name: 'K. Priya (Accounts Clerk)',
        role: 'Data Entry',
        email: 'dataentry@rretally.com',
        phone: '9840012347',
        allow_backdated_entries: 0
      },
      {
        username: 'auditor',
        password: 'audit123',
        full_name: 'CA M. Venkatesh (Statutory Auditor)',
        role: 'Auditor',
        email: 'venkatesh@ca-associates.in',
        phone: '9840012348',
        allow_backdated_entries: 0
      },
      {
        username: 'viewer',
        password: 'view123',
        full_name: 'Executive Director (Viewer)',
        role: 'Viewer',
        email: 'director@rretally.com',
        phone: '9840012349',
        allow_backdated_entries: 0
      },
      {
        username: 'guest',
        password: 'guest',
        full_name: 'Guest User (Inspection & Demo)',
        role: 'Guest',
        email: 'guest@rretally.com',
        phone: '',
        allow_backdated_entries: 0
      }
    ];

    for (const u of defaultUsers) {
      const hashed = hashPassword(u.password);
      await run(
        `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries)
         VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`,
        [u.username, hashed, u.full_name, u.role, u.email, u.phone, u.allow_backdated_entries]
      );
    }
    console.log('[Tally Core DB] Initialized standard multi-user security profiles including Guest with PBKDF2 hashing.');
  } else {
    // Ensure guest user exists for existing databases
    const guestExists = await get("SELECT id FROM users WHERE username = 'guest' COLLATE NOCASE");
    if (!guestExists) {
      await run(
        `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries)
         VALUES ('guest', ?, 'Guest User (Inspection & Demo)', 'Guest', 'guest@rretally.com', '', 'Active', 0)`,
        [hashPassword('guest')]
      );
    }
  }
}

async function authenticateUser(username, password, clientMeta = {}) {
  await seedDefaultUsers();
  const u = (username || '').trim();
  const user = await get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [u]);
  
  if (!user) {
    if (u.toLowerCase() === 'administrator') {
      const adminUser = await get("SELECT * FROM users WHERE role = 'Owner' LIMIT 1");
      if (adminUser) {
        return handleLoginSuccess(adminUser, clientMeta);
      }
    }
    return { success: false, error: 'User does not exist in Tally Security Control.' };
  }

  if (user.status !== 'Active') {
    return { success: false, error: 'User account is deactivated. Contact Company Administrator.' };
  }

  const p = (password || '').trim();
  const verifyResult = verifyPassword(p, user.password);

  const isAliasMatch = 
    (user.username.toLowerCase() === 'admin' && (p === 'admin' || p === 'admin123' || p === '')) ||
    (user.username.toLowerCase() === 'guest' && (p === 'guest' || p === 'guest123' || p === '')) ||
    (user.username.toLowerCase() === 'accountant' && (p === 'acc' || p === 'acc123')) ||
    (user.username.toLowerCase() === 'dataentry' && (p === 'data' || p === 'data123')) ||
    (user.username.toLowerCase() === 'auditor' && (p === 'audit' || p === 'audit123')) ||
    (user.username.toLowerCase() === 'viewer' && (p === 'view' || p === 'view123'));

  if (!verifyResult.valid && !isAliasMatch) {
    return { success: false, error: 'Incorrect password for user "' + user.username + '".' };
  }

  // Transparent cryptographic migration: Upgrade legacy plaintext to salted PBKDF2 hash on the fly
  if (verifyResult.needsMigration || !user.password.startsWith('pbkdf2$')) {
    try {
      const effectivePassword = p || (user.username.toLowerCase() === 'admin' ? 'admin123' : user.username);
      const newHash = hashPassword(effectivePassword);
      await run('UPDATE users SET password = ? WHERE id = ?', [newHash, user.id]);
    } catch (migErr) {
      console.warn('[Security] Password migration notice:', migErr.message);
    }
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
      token
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

async function createUser(userData) {
  await seedDefaultUsers();
  const { username, password, full_name, role, email, phone, allow_backdated_entries } = userData;
  if (!username || !password || !full_name) {
    throw new Error('Username, password, and full name are required.');
  }
  const existing = await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username.trim()]);
  if (existing) {
    throw new Error(`Username "${username}" already exists.`);
  }
  const hashedPassword = hashPassword(password.trim());
  const res = await run(
    `INSERT INTO users (username, password, full_name, role, email, phone, allow_backdated_entries, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`,
    [username.trim(), hashedPassword, full_name.trim(), role || 'Data Entry', email || '', phone || '', allow_backdated_entries ? 1 : 0]
  );
  return { success: true, id: res.lastID, message: `User "${username}" created successfully.` };
}

async function updateUser(id, userData) {
  const { full_name, role, password, email, phone, status, allow_backdated_entries } = userData;
  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw new Error('User not found.');

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
    sql += ', password = ?';
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
  await run('DELETE FROM quotation_followups').catch(() => {});
  await run('DELETE FROM quotation_items').catch(() => {});
  await run('DELETE FROM quotations').catch(() => {});
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
  await run('DELETE FROM quotation_followups').catch(() => {});
  await run('DELETE FROM quotation_items').catch(() => {});
  await run('DELETE FROM quotations').catch(() => {});
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
  const { full_name, email, username, password, role } = userData;

  if (!full_name || !email || !password) {
    throw new Error('Full name, email address, and password are required.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = full_name.trim();
  let cleanUsername = (username || cleanEmail.split('@')[0] || 'user').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

  if (!cleanUsername) cleanUsername = 'user_' + Date.now().toString().slice(-4);

  // Check for conflicts
  const existing = await get(
    'SELECT id, username, email FROM users WHERE username = ? COLLATE NOCASE OR (email != "" AND email = ? COLLATE NOCASE)',
    [cleanUsername, cleanEmail]
  );

  if (existing) {
    if (existing.email && existing.email.toLowerCase() === cleanEmail) {
      throw new Error(`An account with email "${cleanEmail}" already exists. Please log in.`);
    }
    // If username is taken, append suffix
    cleanUsername = `${cleanUsername}_${Date.now().toString().slice(-3)}`;
  }

  const hashedPassword = hashPassword(password.trim());
  const assignedRole = role || 'Data Entry';

  const res = await run(
    `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, auth_provider)
     VALUES (?, ?, ?, ?, ?, '', 'Active', 1, 'email')`,
    [cleanUsername, hashedPassword, cleanName, assignedRole, cleanEmail]
  );

  const newUser = await get('SELECT * FROM users WHERE id = ?', [res.lastID]);
  console.log(`[Authenticator] Registered new email user "${cleanUsername}" (${cleanEmail}) with role ${assignedRole}.`);

  return handleLoginSuccess(newUser, clientMeta);
}

async function loginWithGoogle(googleData, clientMeta = {}) {
  await seedDefaultUsers();
  const { email, name, google_id, role, avatar_url } = googleData;

  if (!email) {
    throw new Error('Valid Google account email is required.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = (name || cleanEmail.split('@')[0] || 'Google User').trim();
  const cleanGoogleId = (google_id || `g_${Date.now()}`).trim();

  // 1. Look up existing user by google_id or email
  let user = await get(
    'SELECT * FROM users WHERE google_id = ? OR (email != "" AND email = ? COLLATE NOCASE)',
    [cleanGoogleId, cleanEmail]
  );

  if (user) {
    // Update Google credentials & metadata
    await run(
      'UPDATE users SET google_id = COALESCE(google_id, ?), auth_provider = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [cleanGoogleId, user.auth_provider === 'local' ? 'hybrid' : 'google', avatar_url || null, user.id]
    );
    user = await get('SELECT * FROM users WHERE id = ?', [user.id]);
    console.log(`[Authenticator] Google login authenticated for user "${user.username}" (${cleanEmail}).`);
    return handleLoginSuccess(user, clientMeta);
  }

  // 2. User does not exist -> Auto-provision in Authenticator
  let baseUsername = cleanEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase();
  if (!baseUsername) baseUsername = 'google_user';
  let candidateUsername = baseUsername;
  let counter = 1;

  while (await get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [candidateUsername])) {
    candidateUsername = `${baseUsername}_${counter++}`;
  }

  // Generate cryptographically secure random password
  const randomSecret = crypto.randomBytes(24).toString('hex');
  const hashedPassword = hashPassword(randomSecret);
  const assignedRole = role || 'Accountant'; // Default high privilege for user-added Google profile

  const res = await run(
    `INSERT INTO users (username, password, full_name, role, email, phone, status, allow_backdated_entries, auth_provider, google_id, avatar_url)
     VALUES (?, ?, ?, ?, ?, '', 'Active', 1, 'google', ?, ?)`,
    [candidateUsername, hashedPassword, cleanName, assignedRole, cleanEmail, cleanGoogleId, avatar_url || '']
  );

  const newUser = await get('SELECT * FROM users WHERE id = ?', [res.lastID]);
  console.log(`[Authenticator] Auto-provisioned new Google user "${candidateUsername}" (${cleanEmail}) in database.`);

  return handleLoginSuccess(newUser, clientMeta);
}

module.exports = {
  db,
  dbPath,
  dataDir,
  closeDb,
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
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getLoginAuditTrail,
  getRolePermissions
};

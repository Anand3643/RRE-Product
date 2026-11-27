/**
 * RRE Tally — Versioned, additive-only schema migrations.
 *
 * Rules:
 *  - Only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ADD COLUMN.
 *  - Never DROP, DELETE, RENAME or rewrite existing data.
 *  - Each migration runs once (tracked in schema_migrations) inside a transaction.
 *  - Runs after core/db.js initDb(), so all legacy tables already exist.
 */
const { run, get, all } = require('./db');

const MIGRATIONS = [
  {
    id: '001_platform_tables',
    description: 'Activity log, notification centre',
    statements: [
      `CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER,
        username TEXT,
        role TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        details TEXT,
        ip_address TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity, entity_id)',
      `CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT,
        link_view TEXT,
        is_read INTEGER DEFAULT 0,
        is_resolved INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_notifications_state ON notifications(is_resolved, is_read)'
    ]
  },
  {
    id: '002_stock_reorder_level',
    description: 'Per-item reorder level (used by low-stock alerts and reorder suggestions)',
    statements: [
      'ALTER TABLE stock_items ADD COLUMN reorder_level REAL DEFAULT 0'
    ]
  },
  {
    id: '003_scheduled_reports',
    description: 'Scheduled report definitions and generated outputs',
    statements: [
      `CREATE TABLE IF NOT EXISTS scheduled_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        dataset TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        frequency TEXT NOT NULL,
        hour INTEGER NOT NULL DEFAULT 8,
        is_active INTEGER DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS report_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        dataset TEXT,
        filename TEXT,
        row_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'ok',
        message TEXT,
        content TEXT,
        FOREIGN KEY(schedule_id) REFERENCES scheduled_reports(id) ON DELETE CASCADE
      )`,
      'CREATE INDEX IF NOT EXISTS idx_report_outputs_sched ON report_outputs(schedule_id, id)',
      'CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_reports(is_active, next_run_at)'
    ]
  },
  {
    id: '004_gst_recon_runs',
    description: 'GSTR-2B reconciliation run history',
    statements: [
      `CREATE TABLE IF NOT EXISTS gst_recon_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        period TEXT,
        source_name TEXT,
        summary TEXT,
        result TEXT
      )`
    ]
  },
  {
    id: '005_bank_statements',
    description: 'Bank statement import, line matching and reconciliation history',
    statements: [
      `CREATE TABLE IF NOT EXISTS bank_statement_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        bank_ledger_id INTEGER NOT NULL,
        filename TEXT,
        row_count INTEGER DEFAULT 0,
        file_hash TEXT NOT NULL,
        date_from TEXT,
        date_to TEXT,
        FOREIGN KEY(bank_ledger_id) REFERENCES ledgers(id)
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_imports_file ON bank_statement_imports(bank_ledger_id, file_hash)',
      `CREATE TABLE IF NOT EXISTS bank_statement_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id INTEGER NOT NULL,
        bank_ledger_id INTEGER NOT NULL,
        line_date TEXT NOT NULL,
        description TEXT,
        ref_no TEXT,
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        balance REAL,
        status TEXT NOT NULL DEFAULT 'unmatched',
        is_duplicate INTEGER DEFAULT 0,
        dedupe_hash TEXT,
        source_row INTEGER,
        matched_entry_id INTEGER,
        matched_at DATETIME,
        matched_by TEXT,
        FOREIGN KEY(import_id) REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
        FOREIGN KEY(matched_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_bank_lines_import ON bank_statement_lines(import_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_bank_lines_hash ON bank_statement_lines(bank_ledger_id, dedupe_hash)',
      'CREATE INDEX IF NOT EXISTS idx_bank_lines_entry ON bank_statement_lines(matched_entry_id)',
      `CREATE TABLE IF NOT EXISTS bank_recon_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        bank_ledger_id INTEGER,
        import_id INTEGER,
        action TEXT NOT NULL,
        line_id INTEGER,
        entry_id INTEGER,
        details TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_bank_history_ledger ON bank_recon_history(bank_ledger_id, id)',
      // If a matched voucher line is deleted (existing voucher delete), the statement line returns to "unmatched".
      `CREATE TRIGGER IF NOT EXISTS trg_bank_line_unmatch_on_entry_delete
       BEFORE DELETE ON ledger_entries
       BEGIN
         UPDATE bank_statement_lines
            SET status = 'unmatched', matched_entry_id = NULL, matched_at = NULL, matched_by = NULL
          WHERE matched_entry_id = OLD.id;
       END`
    ]
  },
  {
    id: '006_recurring_and_import',
    description: 'Recurring voucher templates/drafts and CSV import batches',
    statements: [
      `CREATE TABLE IF NOT EXISTS recurring_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        voucher_type TEXT NOT NULL,
        party_ledger_id INTEGER,
        narration TEXT,
        reference_no TEXT,
        entries TEXT NOT NULL,
        frequency TEXT NOT NULL,
        anchor_day INTEGER,
        start_date TEXT NOT NULL,
        end_date TEXT,
        next_due TEXT,
        is_active INTEGER DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(party_ledger_id) REFERENCES ledgers(id)
      )`,
      `CREATE TABLE IF NOT EXISTS recurring_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        voucher_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        actioned_by TEXT,
        actioned_at DATETIME,
        FOREIGN KEY(template_id) REFERENCES recurring_templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, due_date)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_templates(is_active, next_due)',
      'CREATE INDEX IF NOT EXISTS idx_recurring_drafts_status ON recurring_drafts(status, due_date)',
      `CREATE TABLE IF NOT EXISTS import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        filename TEXT,
        file_hash TEXT,
        status TEXT NOT NULL DEFAULT 'previewed',
        summary TEXT,
        payload TEXT,
        results TEXT,
        posted TEXT,
        committed_at DATETIME,
        committed_by TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_import_batches_hash ON import_batches(file_hash, status)'
    ]
  },
  {
    id: '007_voucher_attachments',
    description: 'Document attachments stored inside the company database',
    statements: [
      `CREATE TABLE IF NOT EXISTS voucher_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voucher_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        ext TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        uploaded_by TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS voucher_attachment_data (
        attachment_id INTEGER PRIMARY KEY,
        data BLOB NOT NULL,
        FOREIGN KEY(attachment_id) REFERENCES voucher_attachments(id) ON DELETE CASCADE
      )`,
      'CREATE INDEX IF NOT EXISTS idx_attachments_voucher ON voucher_attachments(voucher_id)'
    ]
  },
  {
    id: '008_batch_serial_tracking',
    description: 'Batch / expiry / serial tracking registers and item barcode',
    statements: [
      'ALTER TABLE stock_items ADD COLUMN track_batches INTEGER DEFAULT 0',
      'ALTER TABLE stock_items ADD COLUMN has_expiry INTEGER DEFAULT 0',
      'ALTER TABLE stock_items ADD COLUMN track_serials INTEGER DEFAULT 0',
      'ALTER TABLE stock_items ADD COLUMN barcode TEXT',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_barcode ON stock_items(lower(barcode)) WHERE barcode IS NOT NULL AND barcode <> ''",
      `CREATE TABLE IF NOT EXISTS batch_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_entry_id INTEGER NOT NULL,
        stock_item_id INTEGER NOT NULL,
        batch_no TEXT NOT NULL COLLATE NOCASE,
        expiry_date TEXT,
        qty REAL NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(inventory_entry_id) REFERENCES inventory_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(stock_item_id) REFERENCES stock_items(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_batch_alloc_item ON batch_allocations(stock_item_id, batch_no)',
      'CREATE INDEX IF NOT EXISTS idx_batch_alloc_entry ON batch_allocations(inventory_entry_id)',
      `CREATE TABLE IF NOT EXISTS serial_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stock_item_id INTEGER NOT NULL,
        serial_no TEXT NOT NULL COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'in_stock',
        in_entry_id INTEGER,
        out_entry_id INTEGER,
        returned_entry_id INTEGER,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(stock_item_id) REFERENCES stock_items(id),
        UNIQUE(stock_item_id, serial_no)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_serial_status ON serial_numbers(stock_item_id, status)',
      // If a stock line is deleted by the existing voucher delete, keep the serial register consistent.
      `CREATE TRIGGER IF NOT EXISTS trg_serials_on_stock_line_delete
       BEFORE DELETE ON inventory_entries
       BEGIN
         UPDATE serial_numbers SET status = 'in_stock', out_entry_id = NULL WHERE out_entry_id = OLD.id;
         UPDATE serial_numbers SET status = 'sold', returned_entry_id = NULL WHERE returned_entry_id = OLD.id;
         DELETE FROM serial_numbers WHERE in_entry_id = OLD.id;
       END`
    ]
  },
  {
    id: '009_org_structure',
    description: 'Branches, departments, voucher tags, budgets and customer credit limits',
    statements: [
      `CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        address TEXT,
        state_code TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'ALTER TABLE vouchers ADD COLUMN branch_id INTEGER',
      'ALTER TABLE vouchers ADD COLUMN department_id INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_vouchers_branch ON vouchers(branch_id)',
      'CREATE INDEX IF NOT EXISTS idx_vouchers_department ON vouchers(department_id)',
      `CREATE TABLE IF NOT EXISTS user_org_defaults (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        branch_id INTEGER,
        department_id INTEGER
      )`,
      'ALTER TABLE ledgers ADD COLUMN credit_limit REAL DEFAULT 0',
      `CREATE TABLE IF NOT EXISTS budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id INTEGER NOT NULL,
        department_id INTEGER,
        branch_id INTEGER,
        period_type TEXT NOT NULL CHECK (period_type IN ('month', 'year')),
        period_start TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(ledger_id) REFERENCES ledgers(id)
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_unique ON budgets(ledger_id, COALESCE(department_id, 0), COALESCE(branch_id, 0), period_type, period_start)'
    ]
  },
  {
    id: '010_approvals',
    description: 'Approval rules and held-voucher requests',
    statements: [
      `CREATE TABLE IF NOT EXISTS approval_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        kind TEXT NOT NULL,
        threshold REAL NOT NULL,
        exempt_roles TEXT NOT NULL DEFAULT 'Owner,Accountant',
        is_active INTEGER DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS approval_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voucher_type TEXT NOT NULL,
        summary TEXT,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        rule_ids TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL,
        requested_by_id INTEGER,
        requested_role TEXT,
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decided_by TEXT,
        decided_at DATETIME,
        decision_note TEXT,
        voucher_id INTEGER,
        error TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, id)',
      'CREATE INDEX IF NOT EXISTS idx_approval_requester ON approval_requests(requested_by, id)'
    ]
  },
  {
    id: '011_voice_prefs',
    description: 'Voice assistant preferences and consent (no audio is ever stored)',
    statements: [
      `CREATE TABLE IF NOT EXISTS voice_prefs (
        username TEXT PRIMARY KEY,
        speak_replies INTEGER DEFAULT 1,
        reply_language TEXT DEFAULT 'auto',
        confirm_all INTEGER DEFAULT 0,
        browser_consent_at TEXT,
        cloud_consent_at TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ]
  },
  {
    id: '012_inventory_suite',
    description: 'Inventory suite: SKU/brand on items, warehouse details, stock documents, reservations',
    statements: [
      'ALTER TABLE stock_items ADD COLUMN sku TEXT',
      'ALTER TABLE stock_items ADD COLUMN brand TEXT',
      'ALTER TABLE stock_items ADD COLUMN description TEXT',
      "UPDATE stock_items SET sku = 'SKU-' || printf('%05d', id) WHERE sku IS NULL OR sku = ''",
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_sku ON stock_items(sku)',
      'ALTER TABLE godowns ADD COLUMN code TEXT',
      'ALTER TABLE godowns ADD COLUMN address TEXT',
      'ALTER TABLE godowns ADD COLUMN city TEXT',
      'ALTER TABLE godowns ADD COLUMN contact_name TEXT',
      'ALTER TABLE godowns ADD COLUMN phone TEXT',
      'ALTER TABLE godowns ADD COLUMN email TEXT',
      "UPDATE godowns SET code = 'WH-' || printf('%02d', id) WHERE code IS NULL OR code = ''",
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_godowns_code ON godowns(code)',
      'CREATE INDEX IF NOT EXISTS idx_inventory_entries_item_godown ON inventory_entries(stock_item_id, godown_id)',
      `CREATE TABLE IF NOT EXISTS inv_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        number TEXT NOT NULL UNIQUE,
        voucher_id INTEGER NOT NULL,
        from_godown_id INTEGER,
        to_godown_id INTEGER,
        reason TEXT,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inv_docs_kind ON inv_docs(kind, id)',
      `CREATE TABLE IF NOT EXISTS inv_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        godown_id INTEGER NOT NULL,
        qty REAL NOT NULL,
        ref_type TEXT NOT NULL,
        ref_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inv_reservations_item ON inv_reservations(item_id, godown_id)',
      'CREATE INDEX IF NOT EXISTS idx_inv_reservations_ref ON inv_reservations(ref_type, ref_id)'
    ]
  },
  {
    id: '013_inventory_orders',
    description: 'Customer/supplier profiles; purchase and sales orders linked to vouchers',
    statements: [
      `CREATE TABLE IF NOT EXISTS party_profiles (
        ledger_id INTEGER PRIMARY KEY,
        email TEXT,
        phone TEXT,
        contact_name TEXT,
        city TEXT,
        payment_terms TEXT,
        notes TEXT,
        FOREIGN KEY(ledger_id) REFERENCES ledgers(id)
      )`,
      `CREATE TABLE IF NOT EXISTS inv_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        number TEXT NOT NULL UNIQUE,
        party_ledger_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        order_date TEXT NOT NULL,
        expected_date TEXT,
        warehouse_id INTEGER NOT NULL,
        reference TEXT,
        notes TEXT,
        subtotal REAL DEFAULT 0,
        tax REAL DEFAULT 0,
        total REAL DEFAULT 0,
        cancelled_reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        FOREIGN KEY(party_ledger_id) REFERENCES ledgers(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inv_orders_kind ON inv_orders(kind, status, id)',
      'CREATE INDEX IF NOT EXISTS idx_inv_orders_party ON inv_orders(party_ledger_id, id)',
      `CREATE TABLE IF NOT EXISTS inv_order_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        qty REAL NOT NULL,
        rate REAL NOT NULL,
        discount_pct REAL DEFAULT 0,
        gst_rate REAL DEFAULT 0,
        qty_done REAL DEFAULT 0,
        FOREIGN KEY(order_id) REFERENCES inv_orders(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES stock_items(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inv_order_lines_order ON inv_order_lines(order_id)',
      `CREATE TABLE IF NOT EXISTS inv_order_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        number TEXT NOT NULL UNIQUE,
        voucher_id INTEGER NOT NULL,
        doc_date TEXT,
        reference TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES inv_orders(id),
        FOREIGN KEY(voucher_id) REFERENCES vouchers(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inv_order_docs_order ON inv_order_docs(order_id)',
      'CREATE INDEX IF NOT EXISTS idx_inv_order_docs_voucher ON inv_order_docs(voucher_id)'
    ]
  },
  {
    id: '014_inventory_import',
    description: 'Remembers which StockPilot records were imported (so an import can be re-run without duplicates)',
    statements: [
      `CREATE TABLE IF NOT EXISTS inv_import_map (
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        src_id INTEGER NOT NULL,
        rre_id INTEGER,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source, kind, src_id)
      )`
    ]
  },
  {
    id: '015_customer_portal',
    description: 'Customer portal: a login can be tied to one customer account; orders remember the portal login that placed them',
    statements: [
      'ALTER TABLE users ADD COLUMN party_id INTEGER',
      'ALTER TABLE inv_orders ADD COLUMN portal_user_id INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_users_party ON users(party_id)',
      'CREATE INDEX IF NOT EXISTS idx_inv_orders_portal ON inv_orders(portal_user_id, id)'
    ]
  },
  {
    id: '016_inventory_bridge',
    description: 'Accounting bridge for the original inventory application: remembers which of its documents have been posted to the books',
    statements: [
      `CREATE TABLE IF NOT EXISTS inv_bridge_events (
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        src_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        voucher_id INTEGER,
        number TEXT,
        message TEXT,
        attempts INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source, kind, src_id)
      )`
    ]
  },
  {
    id: '017_tally_standard_ledgers_and_group_create',
    description: 'Add description column to ledgers, ensure Tally group aliases, and seed 96 standard Tally ledgers with Hindi meanings',
    statements: [
      'ALTER TABLE ledgers ADD COLUMN description TEXT'
    ]
  },
  {
    id: '018_unified_identity',
    description: 'One login for everything: server-side sessions, password-reset tokens, account lock-out and per-employee module access (additive only)',
    statements: [
      'ALTER TABLE users ADD COLUMN module_access TEXT',
      'ALTER TABLE users ADD COLUMN failed_logins INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN locked_until TEXT',
      'ALTER TABLE users ADD COLUMN created_by INTEGER',
      'ALTER TABLE users ADD COLUMN needs_review INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN deactivated_at TEXT',
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)',
      `CREATE TABLE IF NOT EXISTS auth_sessions (
        sid TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT,
        remember INTEGER DEFAULT 0,
        ip TEXT,
        agent TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at)',
      `CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL DEFAULT 'reset',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        requested_ip TEXT,
        created_by INTEGER
      )`,
      'CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, used_at)',
      `CREATE TABLE IF NOT EXISTS identity_migrations (
        key TEXT PRIMARY KEY,
        ran_at TEXT NOT NULL,
        report TEXT
      )`
    ]
  },
  {
    id: '019_email_verification',
    description: 'Customer self-registration and employee invitations: e-mail verification state (existing accounts count as verified; additive only)',
    statements: [
      'ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN email_verified_at TEXT',
      "UPDATE users SET email_verified = 1, email_verified_at = COALESCE(created_at, datetime('now')) WHERE email_verified = 0"
    ]
  },
  {
    id: '020_signup_claim',
    description: 'Lets the browser that created a customer account be signed in when it confirms the e-mail link (additive only)',
    statements: [
      'ALTER TABLE password_resets ADD COLUMN claim_hash TEXT'
    ]
  },
  {
    id: '021_customer_companies',
    description: 'Each self-registered customer works in a private company of their own; employees can be given extra monitoring access (additive only)',
    statements: [
      'ALTER TABLE users ADD COLUMN company_id TEXT',
      'ALTER TABLE users ADD COLUMN extra_access TEXT'
    ]
  },
  {
    id: '022_idempotency_keys',
    description: 'A financial request repeated with the same Idempotency-Key (double click, network retry) returns the first result instead of posting twice (additive only)',
    statements: [
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
         scope_key TEXT PRIMARY KEY,
         result TEXT NOT NULL,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`
    ]
  },
  {
    id: '023_party_and_group_indexes',
    description: 'Indexes for the lookups done on every party ledger, outstanding and group report: vouchers by party, ledgers by group (additive only)',
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_vouchers_party ON vouchers(party_ledger_id, date)',
      'CREATE INDEX IF NOT EXISTS idx_ledgers_group ON ledgers(group_id)'
    ]
  },
  {
    id: '024_row_versions',
    description: 'A version number on every record people edit (items, categories, units, warehouses, customers / suppliers, orders, quotations), raised by every change: a save made from an older copy is refused instead of overwriting the newer one (core/rowVersion.js)',
    sqliteOnly: true, // PostgreSQL: db/postgres/migrations/008_row_versions.sql (trigger syntax differs)
    statements: ['stock_items', 'stock_groups', 'units_of_measure', 'godowns', 'ledgers', 'inv_orders', 'quotations'].flatMap((t) => [
      `ALTER TABLE ${t} ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1`,
      `CREATE TRIGGER IF NOT EXISTS trg_${t}_row_version AFTER UPDATE ON ${t} FOR EACH ROW WHEN NEW.row_version = OLD.row_version
       BEGIN UPDATE ${t} SET row_version = OLD.row_version + 1 WHERE id = NEW.id; END`
    ])
  },
  {
    id: '025_voucher_row_version',
    description: 'Vouchers can be altered (PUT /api/vouchers/:id): the same version number as other edited records, so an alteration made from an older copy is refused instead of overwriting a newer one',
    sqliteOnly: true, // PostgreSQL: db/postgres/migrations/009_voucher_row_version.sql
    statements: [
      'ALTER TABLE vouchers ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1',
      `CREATE TRIGGER IF NOT EXISTS trg_vouchers_row_version AFTER UPDATE ON vouchers FOR EACH ROW WHEN NEW.row_version = OLD.row_version
       BEGIN UPDATE vouchers SET row_version = OLD.row_version + 1 WHERE id = NEW.id; END`
    ]
  },
  {
    id: '026_import_documents',
    description: 'Documents uploaded for import (PDF / Excel / CSV / images): the original file, what was read, the preview settings and the result (Import History). Additive only. PostgreSQL: 010_import_documents.sql',
    statements: [
      `CREATE TABLE IF NOT EXISTS import_documents (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         file_name TEXT NOT NULL, mime TEXT, kind TEXT, size INTEGER DEFAULT 0, sha256 TEXT NOT NULL,
         category TEXT, status TEXT NOT NULL DEFAULT 'uploaded',
         detected INTEGER DEFAULT 0, imported INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0,
         extraction TEXT, settings TEXT, result TEXT, error TEXT,
         uploaded_by TEXT, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, imported_by TEXT, imported_at DATETIME
       )`,
      'CREATE INDEX IF NOT EXISTS idx_import_documents_sha ON import_documents(sha256)',
      `CREATE TABLE IF NOT EXISTS import_document_data (
         document_id INTEGER PRIMARY KEY REFERENCES import_documents(id) ON DELETE CASCADE,
         data BLOB NOT NULL
       )`
    ]
  }
];

async function columnExists(table, column) {
  const cols = await all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function runMigrations() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    description TEXT,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = [];
  for (const m of MIGRATIONS) {
    const done = await get('SELECT id FROM schema_migrations WHERE id = ?', [m.id]);
    if (done) continue;
    if (m.sqliteOnly && require('./db').isPostgres()) { // its PostgreSQL twin is a numbered file in db/postgres/migrations
      await run('INSERT INTO schema_migrations (id, description) VALUES (?, ?)', [m.id, m.description]);
      applied.push(m.id); continue;
    }

    await run('BEGIN TRANSACTION');
    try {
      for (const sql of m.statements) {
        const addCol = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(sql);
        if (addCol && (await columnExists(addCol[1], addCol[2]))) continue; // already present
        await run(sql);
      }
      await run('INSERT INTO schema_migrations (id, description) VALUES (?, ?)', [m.id, m.description]);
      await run('COMMIT');
      applied.push(m.id);
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${m.id} failed: ${err.message}`);
    }
  }
  try {
    const { seedStandardTallyLedgers } = require('./db');
    if (typeof seedStandardTallyLedgers === 'function') {
      await seedStandardTallyLedgers();
    }
  } catch (seedErr) {
    console.warn('[Migrations] Standard Tally ledgers seed note:', seedErr.message);
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS };

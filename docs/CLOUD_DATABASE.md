# RRE Tally on a cloud database (Supabase / PostgreSQL)

Status: **Phase 1 of a phased migration.** The application can run on a shared PostgreSQL database (Supabase) instead of the
SQLite files on this computer. SQLite stays the default until you switch. Read "What is not done yet" before going live.

## 1. Architecture

```
 Browser (same RRE UI)  ──HTTPS──>  RRE server (Node/Express)  ──TLS──>  Supabase PostgreSQL 17
                                     │  sign-in, roles, permissions       │  schema "rre": all business tables
                                     │  (core/identity.js, routeGuard)    │  schema "rre_meta": company list,
                                     │  core/db.js  run/get/all           │     id counters, migration versions
                                     │  core/pgAdapter.js (pool, SQL      │  row level security on every table
                                     │      translation, transactions)    │
```

* **One database for every company.** Every row carries `company_no` (`100000`, `100001`, ... and `U<id>` for a self-registered
  customer's own books). Primary keys are `(company_no, id)` and every foreign key is `(company_no, x_id) -> (company_no, id)`, so a
  row can never reference another company's record. Copied rows keep the ids they had in SQLite; new rows get ids from one
  sequence per table (migration 007), so ids are unique and increasing within a company but not consecutive. Voucher NUMBERS are
  separate and stay consecutive per voucher type.
* **Only the RRE server talks to the database.** Its connections switch to the restricted role `rre_app` (no ownership, cannot
  bypass row level security) and tell the database which company the current request works in (`rre.company_id`).
  With no company set, every table looks empty (fail closed).
* **Supabase's web API cannot see the data:** the tables are in schema `rre`, not `public`, and the `anon` / `authenticated`
  roles have no rights on it.
* **Sign-in stays the RRE sign-in** (Argon2id, server sessions, e-mail verification and reset, roles) - chosen so that no existing
  user has to reset a password. Supabase Auth is not used.
* **Same application code.** The SQL in the application is written for SQLite. `core/pgAdapter.js` converts the differences
  (placeholders, `INSERT OR IGNORE`, case-insensitive `LIKE`, empty values first in ascending sorts, `GROUP BY` / `HAVING` habits,
  constraint error wording) and the database has SQLite's date functions (`datetime`, `date`, `julianday`) with the same results.
  Transactions behave as on SQLite: a failing statement inside a transaction fails alone.
* **Transactions (`core/tx.js`):** only the statements of a transaction use its connection; every other request keeps running on
  other connections and sees committed data only. A wait for a locked row ends after 15 s with an error (`RRE_PG_LOCK_TIMEOUT`),
  never as a hang.
  * **Voucher postings run at the same time** (`withTransaction(fn, { concurrent: true })`, READ COMMITTED). They wait for each
    other only where they really conflict, using transaction-scoped advisory locks taken in a fixed (sorted) order so two postings
    cannot deadlock each other:
    `voucher-no:<prefix>` (two postings auto-numbering the same voucher type), `stock:<item id>` (two postings selling the same
    item while negative stock is blocked), `idem:<Idempotency-Key>` (the same request sent twice). Everything else - different
    voucher types, different items, other companies - goes through in parallel. A database deadlock is retried (up to 5 times).
  * **Other writes** (masters, settings, imports, year-end, inventory documents) still go through one queue per company, as on
    SQLite. On SQLite everything uses the queue (SQLite allows one writer at a time anyway).
  * Accounting checks are unchanged in both modes: debits = credits to the paisa, every ledger must exist, stock check per policy,
    all lines of a voucher are written in one transaction or none.

## 2. Schema

Generated from the application's own SQLite schema (`npm run db:schema` -> `db/postgres/migrations/001_core_schema.sql`), so it
cannot drift from the code. 53 tables; the main ones:

| Area | Tables |
|---|---|
| Users & access | `users`, `auth_sessions`, `password_resets`, `user_logins`, `activity_log` (audit log), `identity_migrations`, `user_org_defaults` |
| Company | `company_info`, `app_settings`, `branches`, `departments`, `cost_centres`, `approval_rules`, `approval_requests` |
| Accounting | `account_groups` (groups / chart of accounts), `ledgers`, `vouchers`, `ledger_entries` (debit / credit lines), `bill_allocations` (outstanding receivables / payables), `bank_reconciliation`, `bank_statement_imports`, `bank_statement_lines`, `budgets`, `recurring_templates`, `recurring_drafts` |
| Inventory | `stock_items` (products), `stock_groups` (categories), `units_of_measure`, `godowns` (warehouses), `inventory_entries` (stock movements), `inv_docs` (adjustments / transfers), `batch_allocations`, `serial_numbers`, `inv_reservations` |
| Sales & purchases | `quotations`, `quotation_items`, `quotation_followups`, `inv_orders` (sales / purchase orders), `inv_order_lines`, `inv_order_docs`; invoices, credit / debit notes, payments, receipts, contra and journals are `vouchers` of that type |
| GST | GST rate and HSN on `stock_items` / lines; CGST / SGST / IGST on documents and GST ledgers; `gst_recon_runs` |
| Reports & other | `scheduled_reports`, `report_outputs`, `notifications`, `voucher_attachments`, `voucher_attachment_data`, `import_batches`, `voice_prefs` |

Day book, cash book, bank book, trial balance, profit & loss, balance sheet and outstanding reports are computed from
`vouchers` + `ledger_entries` (as in Tally), not stored separately, so they always agree with the ledger entries.

Column rules: money `numeric(18,2)`, quantities / rates / percentages `numeric(18,4)` (never floating point; the copy of your data
was checked to fit these exactly), text compared byte by byte like SQLite (`COLLATE "C"`), dates stored as the same
`YYYY-MM-DD[ HH:MM:SS]` text as today. Every row also has `_created_at`, `_updated_at` (kept by a trigger) and `_created_by`
(the signed-in user's id).

Migration files (applied in order, each once, recorded with a checksum in `rre_meta.schema_versions`):

| File | Content |
|---|---|
| `001_core_schema.sql` | tables, keys, indexes, triggers (generated) |
| `002_security.sql` | role `rre_app`, row level security policies, no access for other roles |
| `003_sqlite_compat.sql` | `datetime`, `date`, `julianday`, `printf`, case-insensitive collation |
| `004_company_registry.sql` | `rre_meta.companies` |
| `005_idempotency_keys.sql` | repeated financial requests (same Idempotency-Key) return the first result (= SQLite migration 022) |
| `006_party_and_group_indexes.sql` | indexes for party / group look-ups used by reports and the Day Book (= SQLite migration 023) |
| `008_row_versions.sql` | a version number (`row_version`) on items, categories, units, warehouses, ledgers (customers / suppliers), orders and quotations, raised by a trigger on every change; a save made from an older copy is refused with 409 instead of overwriting (`core/rowVersion.js`; = SQLite migration 024) |
| `009_voucher_row_version.sql` | the same version number on `vouchers`: a posted voucher can be altered (`PUT /api/vouchers/:id`, same checks and same line-writing code as posting, complete before/after in the audit log); an alteration made from an older copy is refused (= SQLite migration 025) |
| `007_id_sequences.sql` | new row ids from a sequence per table instead of a per-company counter row (the counter row made every posting wait for the previous one). Rows inserted with an explicit id (copy / restore) move the sequence past it |

`001` is frozen: a schema change is a NEW numbered file here plus the matching SQLite migration in `core/migrations.js`.
`test_pg_cloud.js` fails if any SQLite table or column is missing in PostgreSQL.

## 3. Setting up Supabase

1. Create a project at https://supabase.com (region close to your users, e.g. Mumbai). Keep the database password safe.
2. Supabase -> Project Settings -> Database -> **Connection string -> Session pooler** (port **5432**). Do **not** use the
   transaction pooler (port 6543): RRE refuses it, because each connection is told which company it serves.
3. Download the CA certificate on the same page (SSL configuration) and save it on the server.
4. Put these lines in `.env` on the server (never in the browser, never in Git - `.env` is ignored):
   ```
   RRE_DB=postgres
   DATABASE_URL=postgres://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   RRE_PG_CA_FILE=C:/path/to/prod-ca-2021.crt
   # RRE_PG_POOL_MAX=10
   ```
5. `npm run db:migrate` - creates the schema, security and functions.
6. `npm run db:copy` - copies the companies on this computer into the cloud database, each in one transaction, verified
   (row counts, amount totals, debits = credits). Your SQLite files are only read. Use `-- --replace <company>` to copy again.
7. Restart RRE. The start-up log says `Connected to PostgreSQL`, and `/api/health` reports `database_engine: postgresql`.

Going back to SQLite is removing `RRE_DB=postgres` from `.env` and restarting (the SQLite files are untouched, but anything entered
while on PostgreSQL is only in PostgreSQL).

No Supabase service-role key or API key is needed or used; nothing about the database reaches the browser.

**Check the security after connecting** (in Supabase -> SQL editor):
```sql
-- every RRE table has row level security switched on and forced: expect 0 rows
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'rre' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
-- as the application role, with no company chosen, nothing is visible: expect 0
SET ROLE rre_app; SELECT count(*) FROM rre.vouchers; RESET ROLE;
-- the public web API roles have no rights on the data: expect false
SELECT has_schema_privilege('anon', 'rre', 'USAGE'), has_schema_privilege('authenticated', 'rre', 'USAGE');
```
Then run `node test_pg_cloud.js` with `DATABASE_URL` pointing at a **separate test project** (it creates and drops its own test
data; never point it at the live project).

**Sign-in:** RRE keeps its own sign-in (you chose this, so no user has to reset a password). Supabase Auth would mean moving every
user account to Supabase and changing every screen's sign-in; it is not implemented. Row level security does not depend on it: the
server tells the database which company each request works in, and the restricted role cannot see anything else.

## 4. Security

* Company isolation: row level security on **every** table, forced (also for the table owner), policy
  `company_no = current company`, for reading and for writing. Tested: no company -> nothing visible; writing into another company
  refused; updating / deleting another company's rows affects 0 rows; a reference to another company's record is refused.
* Customer isolation inside a company (a customer-portal login sees only its own orders, invoices, quotations) is enforced by the
  server (`core/portal.js` takes the customer account from the database, never from the browser; `test_portal.js`). It is
  deliberately not a database policy: the server's own work in a customer request (next order number, stock, prices) must see the
  whole company - a database-level customer filter produced duplicate order numbers in testing.
* Roles and permissions: checked by the server on every request (`core/routeGuard.js`, `core/auth.js`), unchanged.
* SQL injection: all values are sent as parameters; the translator never puts values into SQL text.
* Credentials: only in the server's `.env`. TLS to the database with certificate verification (`RRE_PG_CA_FILE`).

## 5. Backups and recovery

**Primary: Supabase.** Daily backups are included in paid plans; **Point-in-Time Recovery** is an add-on (Project Settings ->
Add-ons). Turn it on before going live, and check the retention period of your plan. Restores are done from the Supabase
dashboard (Database -> Backups). *Not verified here: no Supabase project is connected yet.*

**Second copy you keep: `npm run db:backup`.** Writes `backups/rre-cloud-<date>.json.gz` (every row of every company from one
consistent snapshot, the schema versions, a SHA-256 checksum). Copy these files somewhere safe (another disk / cloud drive); the
`backups/` folder is never committed. Schedule it with Windows Task Scheduler, e.g. nightly.

Restore (after `npm run db:migrate` on the target database):
```
npm run db:restore -- backups/rre-cloud-<date>.json.gz                 # every company in the file, into an empty database
npm run db:restore -- <file> --company 100000 --replace                # one company, overwriting what is there
```
Each company is restored in one transaction and its row counts are checked before it is committed; a damaged file (checksum) or a
backup taken with newer migrations is refused without changing anything.

**Automatic safety copies:** before "reset to clean company" or "reload demo data", the company is written to
`<data folder>/backups/cloud-<company>-before-...json.gz` (restorable with `db:restore`).

**Restore testing:** `node test_pg_cloud.js` backs up, restores into a second database and compares every company; run it after
changes. Practise a real restore into a separate Supabase project before going live.

Recovery steps for common problems:

| Problem | What to do |
|---|---|
| Records deleted by mistake | Supabase PITR to a time before the deletion (whole database) - or restore that company from the latest `db:backup` file with `--company <no> --replace` into a *separate* database and copy back what is needed |
| Application update broke something | Roll back the application; the database schema only ever gains migrations. Restore from backup only if data was damaged |
| Supabase unavailable | RRE shows errors (nothing is saved locally). Wait, or restore the latest `db:backup` into another PostgreSQL 17 and point `DATABASE_URL` at it |
| Need to leave Supabase | `db:backup`, then `db:migrate` + `db:restore` on any PostgreSQL 17 |

## 6. Deployment

* One RRE server process per database for now (see limits). It can run on this PC, or on a cloud VM / container reachable over HTTPS.
* `.env` on the server as above; `RRE_PUBLIC_URL` set to the address people use; HTTPS in front of the server.
* Updating: stop RRE, `git pull`, `npm ci`, `npm run db:migrate`, start RRE.

## 7. Testing

| Command | What it checks |
|---|---|
| `node test_integrity.js` (both databases) | double-entry rules, every voucher type, GST, trial balance / P&L / balance sheet / day book against the ledger, reversal, audited delete, inventory (returns, transfers, adjustments, rollback, negative-stock policy), many users at once (last units, mixed purchases and sales, same voucher number, Idempotency-Key, parallel sign-in / sign-out), permissions, expired / forged sessions, role escalation |
| `node scripts/load-test.js` (both databases) | 5,000 vouchers, 1,000 customers, 500 items; 10 / 25 / 50 / 100 simulated users; response times, errors, throughput |
| `node test_pg_cloud.js` | migrations; copy of the real companies (read-only); company isolation by the database; exact money; simultaneous writes; transactions per company; backup -> restore round trip; damaged backup refused |
| `npm run test:pg -- <test files>` | runs the existing suites unchanged against a fresh PostgreSQL database each (local PostgreSQL 17, no credentials) |
| `npm run db:local` | starts a local PostgreSQL for trying the app on PostgreSQL without Supabase |

Results are in the commit / release notes of this phase.

## 8. Several devices

How to host the server so every computer and phone uses the same data, and how devices stay in step (live updates over
`/api/events`, version checks, save status, retries): **docs/HOSTING.md**. Tested by `node test_crossdevice.js` (SQLite and, with
`npm run test:pg -- test_crossdevice.js`, PostgreSQL): two computers and a phone on one account, other users, customers and companies.

## 9. What is not done yet (next phases)

* **Not yet connected to a real Supabase project** - needs your project and credentials (`.env`). Speed over the internet is not
  measured yet: every database call is a network round trip (statements inside a transaction take three), so reports that run many
  queries will be slower than on local SQLite until measured and optimised.
* **One server process only.** Session cache, the "active company" and transaction handling live in the process; running several
  RRE servers against one database is not supported yet.
* **Voucher postings on PostgreSQL run in parallel** (section 1); other writes inside one company still queue. On SQLite every write
  queues. Measured locally (100 simulated users, PostgreSQL): 0 errors, 0 unbalanced vouchers; numbers over the internet to
  Supabase are not measured yet.
* **Multi-tenant membership model** (a user belonging to several companies with a role in each, `company_members` table, Supabase
  Auth user ids) is not built: today each company has its own user list and the server picks the company. Planned as its own phase.
* **RRE Inventory is part of the books:** its screens (`public/inv/inv.js`) work on the company's own tables (stock items, warehouses,
  customers / suppliers = ledgers, orders = vouchers), so on PostgreSQL inventory is in the cloud database too. The former separate
  inventory application (Python, its own `stockpilot.db`) is no longer opened; its code is still in `inventory-app/` but unused.
  Not carried over from it: packages / shipment tracking and AI insights.
* **Attachments** are stored inside the database (`voucher_attachment_data`); moving them to Supabase Storage is not done.
* **Posted vouchers can still be deleted** by roles allowed to (Owner; not Data Entry). A delete is never silent any more: the complete
  voucher is written to the audit log in the same transaction. The accounting-correct alternative, `POST /api/vouchers/:id/reverse`,
  exists on the server; the screens do not offer it yet. Removing delete entirely is a behaviour change still to be decided.
* **Reports other than the Day Book are not paged** (the Day Book screen loads 200 vouchers at a time with "Load more").
* **Table names** stay those of the application (e.g. `stock_items` for products, `vouchers` for invoices); no separate
  `products` / `sales` / `invoices` tables were created, because that would duplicate the data.
* Supabase backups / PITR are not configured or verified (no project yet).

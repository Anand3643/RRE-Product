# One RRE for every device (central server + central database)

## Why another computer or phone did not show your data

RRE never kept business data in the browser. Every voucher, customer, item and stock movement is saved by the **RRE server**
into its database. Until now that database was a set of SQLite files on the computer that runs the server
(`RRE-Product\data\<company>\company.db`). These files are not uploaded anywhere (and must never go to GitHub), so:

* another computer that runs its own copy of RRE starts its **own, separate** database, which is empty;
* a phone cannot run RRE at all;
* signing in with the same account does not help: the account and the data live in *that* computer's files.

The fix is not in the browser: **every device must talk to the same server, and that server must use one central database.**

```
 Computer A ─┐
 Computer B ─┼── https://<your RRE address> ──>  RRE server (cloud host) ──TLS──>  Supabase PostgreSQL (all companies)
 Phone      ─┘        same sign-in                one process                      row level security per company
```

## What happens between devices now

| | |
|---|---|
| Saving | A change is "Saved ✓" only after the database confirmed it. Failures show "Not saved: <reason>"; no connection shows "Offline: not saved". |
| Other devices | Every other device of the company that has RRE open is told within about a second and reloads the screen it shows (not while you are typing or have a form open: then right after). Coming back to a tab or reconnecting also reloads. |
| Same record edited on two devices | Each record carries a version. A save made from an older copy is refused ("changed on another device"), nothing is overwritten; reload and make the change again. |
| Retries | A voucher sent twice (e.g. after the connection dropped) is posted once. |
| Several devices, same account | Allowed at the same time; signing out on one device does not sign out the others. |
| Companies / customers | A user sees only their company; a customer-portal login sees only its own orders and invoices. Enforced by the server and by the database (row level security). |

## Setting it up (you do steps 1-3 and 5; they need your accounts and secrets)

1. **Supabase** - create a project at https://supabase.com, region **Mumbai (ap-south-1)**. Save the database password in a
   password manager. Settings -> Database: copy the **Session pooler** connection string (port **5432**, not 6543) and download the
   **SSL certificate**.
2. **This PC, `.env`** (never committed): add
   ```
   DATABASE_URL=postgres://postgres.<project-ref>:<db-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   RRE_PG_CA_FILE=C:/path/to/prod-ca-2021.crt
   ```
   Do **not** add `RRE_DB=postgres` yet: this PC keeps working on its own files until the copy is checked.
3. Tell Claude "Supabase is ready". Then (or yourself):
   ```
   npm run db:migrate        # creates the schema, security rules and functions in Supabase
   npm run db:copy           # copies every company; each one in one transaction, verified (counts, Dr = Cr) before it is kept
   npm run db:verify         # independent comparison, writes data/migration-report-<date>.md (see below)
   ```
   Your SQLite files are only read. They stay on this PC, untouched, as the backup until you decide otherwise.
   `db:verify` compares, per company: the row count of **every** table, missing / extra record ids (vouchers, ledger lines, ledgers,
   groups, items, stock movements, warehouses, users, quotations, orders, bill allocations), total debits and credits, the balance of
   every ledger, number and total per voucher type (sales, purchases, receipts, payments, journals ...), every GST ledger, quantity
   per item and warehouse, opening stock, sign-in accounts per role, duplicate voucher numbers and unbalanced vouchers. It reads the
   central database the way the application does (restricted role, one company at a time), so it also proves row level security
   lets each company see its own data. **Switch over only when it ends with "every ... matches".**
   (Rehearsed on a private PostgreSQL with your real data: 4 companies, 57 vouchers, Dr ₹14,21,160 = Cr ₹14,21,160, every count identical.)
4. **Check in Supabase** (SQL editor) - see "Check the security after connecting" in `docs/CLOUD_DATABASE.md`.
5. **Host the server** (any host that runs a Docker container and gives an https address; a `render.yaml` blueprint is included):
   * Render: New -> Blueprint -> this GitHub repository. It asks for `DATABASE_URL`, `RRE_PG_CA` (paste the certificate text),
     `RRE_PUBLIC_URL` (the address it gives you, e.g. `https://rre-tally.onrender.com`) and the two e-mail settings.
     `SESSION_SECRET` is generated. Use an always-on plan (a sleeping server drops live updates and is slow to wake).
   * Other hosts: build the `Dockerfile`; set the same variables; health check `/api/health`; **one** instance only.
6. Open the https address on every computer and phone and sign in with your normal account. The start-up log says
   `Data Storage: central PostgreSQL database`, and `/api/health` reports `database_engine: postgresql`.
7. From then on, **do not enter data in the old local copy** (`http://127.0.0.1:4000` on this PC): it is a separate database. To use
   RRE on this PC, open the https address like every other device - or set `RRE_DB=postgres` in this PC's `.env` so the local
   server also uses the central database.

## Who sees what (the same in the cloud)

| Login | Sees | Enforced by |
|---|---|---|
| **Admin** (Owner / Administrator) | everything in the company: books, inventory, settings, employees and customers, sign-up and sign-in activity | server role checks |
| **Employee** (Accountant, Data Entry, Auditor, Viewer) | the modules and actions their role and module list allow (e.g. Data Entry posts vouchers but sees no financial statements) | server role and module checks |
| **Customer** (portal login linked to one customer) | only their own orders, invoices, quotations, purchase history and packages | server: the customer is taken from the database, never from the browser |
| **Customer with own books** (self-registered) | the full application, inside their own company only | database row level security + server |

Between companies the separation is done by the database itself: every table has row level security switched on and forced, and
the server's restricted database role (`rre_app`) can only see the company the request belongs to. Supabase's public API roles
(`anon`, `authenticated`) have no access at all, so no Supabase key in a browser could read anything. Sign-in stays RRE's own
(Argon2id passwords, server-side sessions); no service-role key is used anywhere.

## Settings for the hosted server

| Variable | Value |
|---|---|
| `RRE_DB` | `postgres` (set in the Dockerfile) |
| `DATABASE_URL` | Supabase session pooler, port 5432 |
| `RRE_PG_CA` or `RRE_PG_CA_FILE` | the Supabase certificate (text, or a file path) - the connection is verified, never "trust anything" |
| `SESSION_SECRET` | 64 random hex characters; keep it the same, or everyone is signed out on each deploy |
| `RRE_PUBLIC_URL` | the https address (used in password-reset e-mails) |
| `RRE_TRUST_PROXY` | `1` behind the host's https proxy (set in the Dockerfile) so sign-in lock-out sees real addresses |
| `RRE_SMTP_USER`, `RRE_SMTP_PASS` | optional, for password-reset e-mails |
| `RRE_PG_POOL_MAX` | optional, database connections (default 10; Supabase's session pooler limits them per plan) |

On this PC (`.env`) only `DATABASE_URL` and `RRE_PG_CA_FILE` are needed for `db:migrate` / `db:copy` / `db:verify`; add
`RRE_DB=postgres` only to make this PC's own server use the central database too.

## Limits to know

* **One server process.** Live updates, sign-in sessions and record locks are kept inside the server process: run one instance
  (the blueprint does). Scaling to several instances would need a shared message channel; not needed at this size.
* **Switching company is global on the server.** An owner who switches to another of *their* companies switches the server; other
  staff of the previous company are then asked to sign in again (they never see the other company's data). With one main
  company (100000) this does not arise; customers with their own books are always kept in their own company.
* **Signing in on a new tab** asks for the password again unless "Remember me" was ticked (by design, for shared computers).
* **No offline entry.** Without a connection nothing can be saved (it says so); nothing is queued on the device.
* **Docker image not built on this PC** (Docker is not installed here); the hosted start-up itself was rehearsed with the same
  settings: empty disk, settings from the environment only, listening on all interfaces, reached from the network address.
* PDFs: the hosted server gives the printable page (print / save as PDF from the browser), as `npm start` does today.

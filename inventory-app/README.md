# StockPilot

Inventory platform (FastAPI + SQLAlchemy + React/TypeScript/Tailwind). Product brief: [SPEC.md](SPEC.md).
**Current status: Phase 1 of 6 complete.** See "Status" below for exactly what exists.

## Run locally (Windows/macOS/Linux)
```
cd backend
python -m venv .venv && .venv\Scripts\activate      # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python seed.py                                       # demo data (SQLite file stockpilot.db)
uvicorn app.main:app --reload --port 8000            # API docs: http://localhost:8000/docs

cd ../frontend
npm install
npm run dev                                          # http://localhost:5173
```
Demo logins (password `demo1234`): owner@, manager@, warehouse@, sales@, accountant@, viewer@ `demo.com`.
Set `DATABASE_URL=postgresql+psycopg://user:pass@host/db` to use PostgreSQL; `SECRET_KEY` must be set in production.

Tests: `cd backend && python -m pytest -q`. Docker: `SECRET_KEY=... docker compose up --build` (untested, see below).

## Admin portal and User portal
Two role types, two separate portals. The server decides which one you get from your row in `users`.

| | ADMIN (`owner` / `admin`) | USER (every other role, default `user`) |
|---|---|---|
| Lands on | `/admin/dashboard` | `/user/dashboard` |
| Portal | sidebar app: `/admin/items`, `/inventory`, `/customers`, `/vendors`, `/sales-orders`, `/purchase-orders`, `/warehouses`, `/shipments`, `/reports`, `/users`, `/activity`, `/support`, `/settings` | top-nav customer portal: `/user/products`, `/stock-availability`, `/orders`, `/purchase-history`, `/invoices`, `/payments`, `/support`, `/profile` |
| Buying | creates orders for any customer | **can buy**: cart -> checkout (`POST /portal/orders`); price from the item master, stock reserved and split across warehouses, overselling refused, double-submit safe, invoiced on account (no online payment) |
| Data | everything | only their own customer record's orders, shipments, invoices (the order's tax document), payments, tickets; catalogue shows selling price + availability only |

**Product assistant** (user portal, chat button bottom-right): answers stock, price + GST, product details, comparisons, "under ₹N" / cheapest, in-stock alternatives, the caller's own order and shipment status, and payment / invoice / delivery questions, from live data using customer-safe fields only (never cost, vendors or other customers). It is rule-based, not an LLM, and says so in the panel; it refuses cost/supplier questions and sends anything it has no policy for (returns, refunds, delivery promises) to Support. Product cards in the chat have Add to cart.

**Registration** (`POST /auth/signup`): the very first account in an empty system becomes the administrator and creates the organisation. Every later registration is a **USER** in that organisation with its own customer record; an `org_name` sent by a client is ignored. `ALLOW_SIGNUP=0` closes public registration; admins can always create users (role `user` gets a linked customer record automatically). `INITIAL_ADMIN_EMAIL` (see `backend/.env.example`) still provisions an administrator server-side. `ALLOW_ORG_SIGNUP=1` restores one-organisation-per-signup and is for the automated test suites only - never set it on a real server.
**Old installs** where every registrant became an admin of their own organisation: `python -m app.consolidate --admin-email you@example.com` (dry run) then `--apply` keeps the named account as ADMIN and moves other owners of *empty* organisations into it as USERs (login history preserved, nothing deleted; organisations with data are only reported).
**Permissions**: a USER can additionally be granted staff modules by an admin (per action: view/create/edit/delete/approve/export); those open under `/user/work/<module>`. Everything is enforced by the API (403 / 404 for other people's records), not by the UI.
**Protection**: bcrypt, JWT with a per-session id, single-use refresh tokens, lockout after 5 wrong passwords, forced change for temporary passwords, sessions ended on logout / deactivation / password change.
**Password reset** (no e-mail is sent by StockPilot): *Forgot password* flags the request; an administrator issues a one-time 24-hour link or a temporary password from Users.
Tests: `pytest tests/test_portals.py tests/test_auth_roles.py`, `npm run e2e:portals` (needs an EMPTY scratch database, see the file header), `npm run e2e:auth`. The older browser suites need a seeded scratch DB and `ALLOW_ORG_SIGNUP=1`.
Limits: tokens are sent as `Authorization` headers (not cookies); every request is checked against the session record, so logout, admin termination and deactivation take effect immediately; no MFA/SSO/e-mail. The "invoice" is the confirmed order's GST tax document - there is no separate invoice entity or online payment.
## Login monitoring (administrators only)
Admin Dashboard -> **User login activity** (live, refreshes every 10 s while the tab is visible) and **Login history** (`/login-activity`) with filters (today / yesterday / 7 / 30 days / custom, user, role, status), search, pagination, CSV and Excel export, a *Failed attempts* tab, and per-user details (profile, active sessions, device history, recent activity, permissions) from which an admin can terminate a session after confirming.

How "active" is decided (never from the mere existence of a record): each sign-in creates a `user_sessions` row tied to a random session id embedded in the JWTs (only its SHA-256 is stored). A session is **Active** with API activity in the last `SESSION_ACTIVE_MINUTES` (5), **Inactive** if valid but quieter than that, and **Expired** after `SESSION_IDLE_MINUTES` (30) without activity or at its expiry; **Logged out** / **Ended by admin** are explicit. Background polling (`X-Background: 1`) does not count as activity. Logout, admin termination, deactivation and password change/reset end sessions server-side at once. A sign-in right after >= 3 failed attempts is flagged **Suspicious**.
Failed attempts (`login_audit_logs`) store the e-mail typed, time, reason category, IP and device - never the password. `LOGIN_ALERT_THRESHOLD` failures within `LOGIN_ALERT_WINDOW_MINUTES` raise an alert banner. IP addresses are blanked after `IP_RETENTION_DAYS` (30). Behind a reverse proxy set `TRUST_PROXY=1` so the real client IP is recorded.
Limits: no location is shown (there is no GeoIP database and IP-derived location would be unreliable); attempts for e-mails that don't exist belong to no organisation, so every admin sees them; "today" uses the admin's browser time zone; live updates use polling, not WebSockets.
Tests: `pytest tests/test_login_monitoring.py`, `npm run e2e:monitor`.
## Status
### Implemented and verified (9 backend tests pass; frontend type-checks and builds; live API smoke-tested)
- Auth: signup creates an organization + owner; JWT access tokens; single-use rotating refresh tokens; bcrypt hashing; logout revokes.
- Multi-tenant isolation (every query scoped by org; cross-org access returns 404), role-based permissions (7 roles x modules), user management, audit log, login history (last login).
- Products: CRUD, archive/restore, delete only without stock history, variants (child products + attributes), auto SKU, auto EAN-13 barcode, categories, GST rate/HSN, reorder point, CSV import (row-level errors) / export, barcode/SKU lookup endpoint.
- Warehouses: create, activate/deactivate (blocked while stock remains), per-warehouse totals.
- Stock engine ([backend/app/stock.py](backend/app/stock.py)): atomic conditional updates, append-only ledger with running balances, no negative stock (org setting `allow_negative_stock` exists but has no UI), idempotency keys, atomic transfers, reserve/release primitives, weighted-average cost, automatic low/out-of-stock notifications. A 20-thread race test confirms stock never goes negative.
- UI: login/signup, collapsible sidebar, Ctrl+K palette with product search, notification bell, light/dark theme, dashboard with chart widgets you can show/hide, products, inventory (stock levels, ledger, receive/adjust/transfer/cycle-count dialogs with scan input), warehouses, team + audit log.

### Warehouse module + AI assistant (added after Phase 1; 19 backend tests pass)
- Warehouses: overview KPIs; list with address/contact/status, search, status filter, sorting, pagination, CSV report; create/edit/archive/restore (archive blocked while stock remains or if it is the last active warehouse); detail page with Overview, Items, Transfers, Stock adjustments and Activity tabs.
- Transfer orders (`TR-00001`…): multi-line, all-or-nothing, written to the ledger with `ref_type=transfer`, audit-logged on both warehouses.
- Status rule: per item and warehouse, `available = on_hand − reserved`; **out** when ≤ 0, **low** when ≤ the item's reorder point.
- AI Insights (`GET /api/insights`): warehouse efficiency score, shortage predictions (days of cover from the last 30 days of issues), excess and slow-moving stock, recommended transfers, 30-day requirements, anomaly detection. All computed from live records; formulas are returned by the API.
- AI Assistant (floating button, `POST /api/assistant/chat`): **rule-based, not an LLM.** It matches your message to intents and product/warehouse names in your database, then answers from real queries. Actions (transfer, stock adjustment, purchase request) are saved as *drafts* and executed only when you press Confirm, through the same validated services, permission checks and audit log as the manual screens; each draft can run once. Unrecognised questions get a help message rather than a guess.
- Purchase requests are a minimal table (`PR-00001`…) that becomes the source for purchase orders in Phase 2.
- Existing databases are upgraded automatically on startup (new warehouse columns added in place).
- Not verified: UI behaviour in a browser (built and type-checked only), PostgreSQL. No LLM integration is configured; to get free-form language understanding an LLM API key and tool-calling layer would need to be added in `assistant_api.py`.

### Interaction layer (latest)
- Motion is CSS/React only (no animation library) and honours `prefers-reduced-motion`; entrance animations deliberately use `fill-mode: backwards` (see the note in `index.css`), and modals/drawers render in a portal.
- Warehouses table: hover-revealed actions + tooltips, row quick-view drawer, selectable rows with bulk Archive / Restore / Delete / Export (with progress), keyboard navigation (↑↓ Enter Space), drag-to-reorder columns (remembered), CSV drag-and-drop import (`POST /api/warehouses-import`).
- Warehouse detail: sliding tabs (Overview, Products, Stock, Transfers, Activity), interactive charts (click a slice/bar to filter), day-grouped activity timeline, collapsible panels, swipe left/right between tabs on touch screens.
- Shortcuts: `Ctrl/⌘+K` palette, `?` help, `/` focus search, `N` new warehouse, `G` then `D/P/I/W/T/A` to navigate, `Esc` closes dialogs/drawers/menus.
- Assistant: slide-in drawer, typing indicator, progressively revealed replies (the reply itself is computed server-side and complete; only its display is staged), copy, history, ↑ to recall, and it defaults to the warehouse page you are on (`warehouse_id` sent with each chat).
- Verified with 62 scripted browser checks (headless Edge) — hover, tooltips, drawers, selection, bulk actions, drag-reorder, CSV drop, validation, charts, tabs, palette, shortcuts, assistant, reduced motion, mobile/touch. Swipes were verified with synthetic touch events, not a physical device.

### Not implemented yet (do not assume these work)
Customers, suppliers, sales/purchase orders, quotations, invoices, GST invoicing, payments, shipping, returns, GRN/RFQ, reports and PDF/Excel export, portals, AI/forecasting, workflow builder, integrations, API keys, MFA, bins/racks, batch/serial/expiry tracking, bundles, FIFO valuation, product images, Celery/Redis, email. Reserve/release exist in the stock service but have no API until orders arrive in Phase 2.

### Known limitations / untested
- **PostgreSQL and Docker were not available** on the build machine: all tests ran on SQLite. The stock logic uses portable atomic UPDATEs, but Postgres behaviour and the Docker files are unverified.
- Tables are created with `create_all`; there are no Alembic migrations yet.
- The UI was type-checked and built but not click-tested in a browser; no frontend tests yet.
- No login rate limiting. Dashboard "trend" is stock movement (sales/purchase revenue trends need Phase 2).
- Avg-cost update on concurrent receipts of the same product is not locked (cost may be slightly off under heavy races; quantities are always exact).
- Frontend bundle is a single 620 kB chunk (no code splitting yet).

## Next: Phase 2
Customers, suppliers, sales orders (confirm => reserve, cancel => release, fulfil => issue), purchase orders + GRN.

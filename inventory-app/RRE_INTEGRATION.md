# StockPilot inside RRE

This folder holds the **original StockPilot inventory application** (React interface + FastAPI backend), unchanged, running as part of RRE.

| Part | What it is |
|---|---|
| `frontend/` | the original React/Vite/Tailwind source and its built interface (`frontend/dist`), exactly as in the original project |
| `backend/app/`, `backend/alembic/` | the original FastAPI backend and its migrations, unchanged |
| `backend/rre_host.py` | the **only file added**: serves the built interface from the same process and gives RRE a one-minute, single-use, signed sign-in link for its administrator |

## How it runs
* RRE (`core/inventoryHost.js`) starts the backend **on first use** on a private port of `127.0.0.1` (never reachable from other computers) and shows the original interface in a full-screen frame under **Gateway → Inventory Management**. The frame keeps the inventory app's styles and RRE's apart.
* The database is the original SQLite database. On first use it is **copied** (never moved or changed) from your StockPilot folder to `data/<company>/inventory/stockpilot.db`; other companies start empty. It is never committed to Git.
* **One login, one user list.** Inventory has no sign-in, sign-up, password reset or user administration of its own any more (those routes answer `410`, and its Users screens are hidden). Opening Inventory from RRE signs the person in with a one-minute, single-use link made from their RRE session. RRE's administrator becomes the inventory owner; employees whose administrator allows the Inventory module arrive with the mapped role (Accountant → accountant, Data Entry → warehouse, Auditor / Viewer → viewer); nobody is ever promoted to an inventory administrator by this mapping. Customers and guests are refused. When an account is deactivated, changed, reset or signed out in RRE, the inventory sessions of that person end at once. The inventory database keeps a technical record of each person (so its documents can name who did the work), created automatically, with no usable password.
* Existing inventory accounts are brought into RRE's one user list by **User management → (administrator) migration** or `POST /api/auth/migration` (preview first, then `{ "apply": true }`). Matching is by identical e-mail only; inventory owners/admins become RRE Accountants flagged *review* for an administrator to confirm; passwords are not copied (people use *Forgot password*); nothing is deleted and the inventory database is only read.

## Accounting link (`core/invBridge.js`)
Reads the inventory database (read-only) every 20 seconds and posts, exactly once each:

| In the inventory app | In RRE's books |
|---|---|
| goods received (GRN) | Purchase voucher: stock in, supplier credited, input GST, bill opened (`SP-GRN-…`) |
| shipment dispatched | Sales voucher: stock out, customer debited, output GST, bill opened (`SP-SHP-…`) |
| transfer | Stock Journal between the two warehouses |
| adjustment (damage, loss, count, found) | Stock Journal |

Documents that existed when the link first ran are marked **history** and are not posted (their stock is already in RRE's opening balances). A document that cannot be posted (for example a missing GST ledger) is shown as "need attention" on the Inventory bar with the reason and is retried; nothing is ever half-posted. Switch it off with the setting `inv_bridge_enabled = 0`.

## Requirements
Python 3.12 with the packages in `backend/requirements.txt`. Create the environment once with `npm run setup:inventory`
(or set `RRE_INVENTORY_PYTHON` to a Python that already has them). A packaged installer does **not** bundle Python.

## Tests
`npm run test:invbridge` starts the real backend and checks purchases, sales, transfers, adjustments, exactly-once behaviour and failure handling against RRE's books.

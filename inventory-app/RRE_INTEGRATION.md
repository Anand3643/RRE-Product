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
* RRE's administrator is signed in to the inventory owner account automatically. Every other role gets the original inventory login, with the original roles (owner/admin/manager/…/user) and the customer portal. A later sign-up in the inventory app only ever becomes an ordinary user, never an administrator.

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

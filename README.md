# RRE Entries — Modular Enterprise Accounting & Inventory Suite

> [!IMPORTANT]
> **Legal & Trademark Notice**: Tally, TallyPrime, and Tally.ERP 9 are registered trademarks of Tally Solutions Pvt. Ltd. **RRE Entries** is an independent accounting suite developed by RRE. It is not affiliated with, authorized, maintained, sponsored, or endorsed by Tally Solutions Pvt. Ltd. References to Tally or Tally XML format are used strictly under nominative fair use to describe file and data interoperability.

An independent, production-grade enterprise accounting and inventory suite built for high reliability, Indian statutory GST compliance, strict double-entry mathematical invariants, and open XML data interchange.

---

## ⚡ Main Gateway & Keyboard Shortcuts

| Shortcut | Function | Description |
| :---: | :--- | :--- |
| **Esc** | **Gateway / Back** | Return to Main Gateway or exit modal dialogs |
| **Alt+D** | **Dashboard** | Toggle Modern Interactive Analytical Dashboard |
| **F4** | **Contra** | Cash to Bank, Bank to Cash, Bank to Bank transfers |
| **F5** | **Payment** | Cheque / NEFT / Cash expense and vendor payments with BRS tracking |
| **F6** | **Receipt** | Inward collections from customers & capital infusion |
| **F7** | **Journal** | Non-cash adjustments, depreciation, provisions |
| **F8** | **Sales Invoice** | Item Invoice mode (Auto GST calculation) or As Voucher Dr/Cr |
| **F9** | **Purchase Voucher** | Vendor bills, ITC Input Tax Credit, and stock inward |
| **Alt+F5** | **Debit Note** | Purchase returns and vendor rate adjustments |
| **Alt+F6** | **Credit Note** | Sales returns and customer credit allowances |
| **B** | **Balance Sheet** | Schedule III format with Capital, Net Profit & Closing Stock |
| **P** | **Profit & Loss** | Trading Account (COGS, Gross Profit) + Operating P&L (Net Profit) |
| **T** | **Trial Balance** | Strict Dr = Cr audit verification across all 28 statutory groups |
| **S** | **Stock Summary** | Weighted Average inventory valuation & Inward/Outward movements |
| **D** | **Day Book** | Chronological voucher audit journal with drill-down |
| **R** | **Ratio Analysis** | Current Ratio, Quick Ratio, Debt-to-Equity, GP %, NP %, Turnover |
| **G** | **GST Portal** | Statutory GSTR-1 (Table 4 B2B, Table 7 B2C) & GSTR-3B (ITC & Net Tax) |
| **O** | **Outstandings** | Bill-by-Bill Receivables & Payables Ageing Analysis |
| **K** | **Bank Reconciliation** | BRS comparing Books balance with Bank clearing statements |
| **A** | **Chart of Accounts** | Hierarchical 28 Statutory Groups & Ledgers tree view |
| **C / Alt+C** | **Create Ledger** | Fast ledger master creation modal |
| **I** | **Create Stock Item** | Stock item master with HSN, GST rate, UoM, and opening balances |
| **Ctrl+N** | **Calculator** | Built-in accounting calculator drawer |
| **Ctrl+A** | **Accept / Save** | 1-key instant voucher commit |
| **Alt+E** | **XML Export** | Standard XML interoperability backup (compatible with accounting software import) |

---

## 🏛️ Modular Clean Architecture

- **Dual Server Ports**:
  - `4000`: RRE Entries Modern Web UI and REST API.
  - `9000`: Native XML Gateway Server (Configured via `tally.ini` `ServerPort=9000`), handling standard `<ENVELOPE>` XML export/import for third-party ERP integrations.
- **Company Dataset (`data/100000/company.db`)**:
  - Structured local PC SQLite database with ACID transactional reliability.
- **Core Modules**:
  - `core/db.js`: SQLite ACID transactional engine for ledgers, groups, stock items, vouchers, godowns, and cost centres.
  - `core/accountingEngine.js`: Double-entry accounting engine calculating running ledger balances, weighted average stock valuation, COGS, P&L, and Balance Sheet.
  - `core/gstEngine.js`: Statutory Indian GST calculation engine (Intra-state CGST+SGST vs Inter-state IGST), GSTR-1, and GSTR-3B ITC netting.
  - `modules/dashboard/dashboardApi.js`: Drill-down telemetry API (`drilldown-BS`, `drilldown-PandL`, `drilldown-duerecv`, `drilldown-duepaya`, `drilldown-fundsflow`, `drilldown-stock`, `drilldown-costcentre`).
  - `modules/gateway/tallyXmlGateway.js`: Standard XML `<ENVELOPE>` parser and generator on port 9000 for seamless data exchange.
  - `modules/masters/mastersApi.js`: CRUD endpoints for 28 statutory groups, ledgers, stock items, units, and godowns.
  - `modules/vouchers/vouchersApi.js`: Transaction posting engine with balance verification ($\sum Dr \equiv \sum Cr$).
  - `modules/reports/reportsApi.js`: Trial Balance, Balance Sheet, P&L, Day Book, Cash/Bank Books, Ratio Analysis, BRS, and Outstandings.

---

## 📐 Mathematical Formulas & Accounting Systems

### 1. Dual-Entry Equilibrium Invariant
$$\sum \text{Debits} \equiv \sum \text{Credits} \quad (\Delta < 0.05)$$
Every voucher must balance before commit. The backend strictly enforces this invariant.

### 2. Trading & Cost of Goods Sold (COGS)
$$\text{COGS} = \text{Opening Stock} + \text{Purchases} + \text{Direct Expenses} - \text{Closing Stock}$$
$$\text{Gross Profit} = \text{Net Sales} + \text{Direct Incomes} - \text{COGS}$$

### 3. Net Profit Formula
$$\text{Net Profit} = \text{Gross Profit} + \text{Indirect Incomes} - \text{Indirect Expenses}$$
Net Profit is dynamically transferred to the **Capital Account** on the Balance Sheet.

### 4. Balance Sheet Equation
$$\text{Total Assets} \equiv \text{Capital} + \text{Current Net Profit} + \text{Loans} + \text{Current Liabilities}$$
$$\text{Difference} = 0.00$$

### 5. Moving Weighted Average Inventory Valuation
$$\text{Valuation Rate} = \frac{\text{Opening Value} + \sum \text{Inward Value}}{\text{Opening Qty} + \sum \text{Inward Qty}}$$
$$\text{Closing Stock Valuation} = \text{Closing Quantity} \times \text{Valuation Rate}$$

### 6. Statutory GST Engine
- **Intra-State Supply** (`Party State Code == Company State Code = 33`):
  $$\text{CGST} = \text{Taxable Value} \times 9\% \quad | \quad \text{SGST} = \text{Taxable Value} \times 9\%$$
- **Inter-State Supply** (`Party State Code != 33`):
  $$\text{IGST} = \text{Taxable Value} \times 18\%$$
- **Net GST Payable (GSTR-3B)**:
  $$\text{Net Tax Payable} = \text{Outward Tax Liability} - \text{Eligible Input Tax Credit (ITC)}$$

### 7. Financial Solvency Ratios
- **Current Ratio**: $\frac{\text{Current Assets}}{\text{Current Liabilities}}$ (Benchmark: $2.0 : 1$)
- **Quick (Acid-Test) Ratio**: $\frac{\text{Current Assets} - \text{Closing Stock}}{\text{Current Liabilities}}$ (Benchmark: $1.0 : 1$)
- **Debt to Equity**: $\frac{\text{Total Borrowings}}{\text{Capital} + \text{Reserves}}$ (Benchmark: $< 1.5 : 1$)
- **Gross Profit Margin**: $\frac{\text{Gross Profit}}{\text{Net Sales}} \times 100\%$
- **Net Profit Margin**: $\frac{\text{Net Profit}}{\text{Net Sales}} \times 100\%$
- **Inventory Turnover**: $\frac{\text{COGS}}{\text{Average Inventory}}$

---

## 🛡️ Production Engineering Architecture (The 13 Pillars)

RRE Entries implements the 13 enterprise system pillars designed for high-reliability offline desktop & local client-server operations:

1. **Secrets Management**: Zero API keys or hardcoded secrets. Server reads from `.env` or system environment with zero-config safe offline defaults. No secrets exposed to frontend.
2. **Security & Parameterized SQL**: 100% parameterized SQLite queries preventing SQL injection. Strict HTTP security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, CSP, Referrer-Policy).
3. **Authentication & RBAC**: Direct standalone owner access by default with zero login barrier. Configurable multi-user RBAC with PBKDF2 hashing when multi-tenant mode is enabled.
4. **Encryption**: Passwords cryptographically hashed at rest. HMAC-SHA256 session token generation and verification. Optional AES-256-GCM encrypted database backup archives.
5. **Disaster Recovery & Point-in-Time Backups**: Automated snapshot backups (`data/100000/backups/`) with SHA-256 checksum integrity verification. Automatic rollback snapshots taken prior to restore drills or data resets. 1-click backup and restore from the UI (`Alt+Y: Data`).
6. **Monitoring & Health Checks**: Comprehensive diagnostic endpoint (`GET /api/health`) reporting system uptime, SQLite WAL status, integrity check, disk usage, memory telemetry, and active record counts.
7. **System Design & Separation of Concerns**: Modular decoupled subsystems for Core Accounting Engine, Statutory GST Engine, Backup Engine, Security Subsystem, and Desktop Shell.
8. **Networking & Origin Lockdown**: Strict loopback binding (`127.0.0.1`) preventing unauthorized remote network exposure. Keep-alive timeout optimization (`65000` ms) preventing socket drops.
9. **Scaling & Query Optimization**: Database performance indices on vouchers, ledger entries, inventory entries, and user audit tables. SQLite WAL (Write-Ahead Logging) mode and PRAGMA busy_timeout.
10. **Load Testing & Benchmarks**: High-throughput automated stress testing script (`npm run test:load`) verifying sub-50ms p50/p95 latency and zero dropped requests at 300+ requests/second.
11. **Testing Suite**: Automated verification suite (`npm test`) running 100 comprehensive audit tests across schema, cryptography, double-entry balance, backups, health checks, and bundled assets.
12. **Deployment & CI/CD**: Reproducible Windows NSIS setup package (`dist/RRE Entries Setup 1.0.0.exe`) and portable executable with desktop shortcuts.
13. **Data Retention & Pruning**: Automated snapshot retention policy retaining up to 30 snapshots with automated safe pruning.

---

## 🔐 One sign-in for everything (Admin · Employee · Customer)
RRE Entries has **one login page, one authentication system and one user list**. Inventory, accounting, reports and the customer portal are modules of the same application and use the same session.

* **Login types** — the sign-in page offers *Admin*, *Employee* and *Customer*. The choice is only checked against the role stored in the database; it never grants access. A mismatch looks exactly like a wrong password.
* **Roles** — Admin (everything, including user management), Employee (Accountant / Data Entry / Auditor / Viewer; an administrator can limit an employee to chosen modules) and Customer (own orders, invoices and profile in the customer portal only). Every API route is checked on the server.
* **Passwords** — stored only as salted Argon2id hashes; nobody, administrators included, can read one. Reset links are random, single-use, expire after 30 minutes and only their hash is stored. Five wrong passwords lock the account for 15 minutes. Sessions can be ended (sign-out, deactivation, password reset) and expire.
* **Same application for everyone.** Admin, employees and self-registered customers all use the full RRE Tally interface. A customer who signs up gets a **private company of their own** (separate database, separate connection): they run vouchers, GST, Day Book, quotations, inventory and reports there, and can never see the owner's books or another customer's. Customers never see user management, login/sign-up tracking, company management or role management. Employees can be given login tracking and the company list as extra permissions by the administrator (off by default). Customers who were created by an administrator and linked to one of the owner's customer accounts keep the purchase-history view of the owner's business instead.
* **Customers create their own account** (Customer tab → Create account): name, e-mail, mobile, password. The role is always Customer, and the account only works after the e-mail link is opened. Needs the Gmail settings below.
* **Employees cannot register.** An administrator invites them (name, e-mail, mobile, modules); the employee opens the single-use invitation link, creates a password, and the account becomes active as an Employee. Administrators are only created at first-time setup or by an existing administrator.
* **User management** (administrators): create employees and customers, roles, module access, activate / deactivate, unlock, e-mail a password link, see last sign-in and sign-in activity.
* **First start** — the person installing chooses the administrator password on the sign-in page (only on that computer). There are no default credentials. Forgot it? Run `npm run admin:reset` on the computer.

### Gmail for "Forgot password" and invitations
Credentials come only from environment variables (a local `.env` file, which is never committed). Copy `.env.example` to `.env` and:
1. Turn on 2-Step Verification for the Gmail account that will send the mail (https://myaccount.google.com/security).
2. Create an **App password** (https://myaccount.google.com/apppasswords, name it "RRE Entries"). Your normal Gmail password will not work.
3. Put it in `.env`: `RRE_SMTP_USER=you@gmail.com` and `RRE_SMTP_PASS=<the 16 characters, no spaces>`. If people open RRE from other computers also set `RRE_PUBLIC_URL=http://<this-computer>:4000` so the links work for them.
4. Restart RRE Entries. User management → Access settings shows *E-mail: set up*.

Tests: `npm run test:auth`.

## 💻 Install and Run on PC

### 1. Ready-to-Use Windows Desktop App
A native desktop shortcut has been created on your Windows Desktop:
- **Desktop Shortcut**: `C:\Users\Admin\Desktop\RRE Entries.lnk`
- **Start Menu**: Located in `Start Menu > Programs > RRE Entries`
- **Reinstall Shortcut Anytime**: Double-click [Install-Desktop-App.bat](file:///c:/Users/Admin/Desktop/RRE%20PRoduct/Install-Desktop-App.bat)

### 2. Standalone Windows Setup Installer (.exe)
You can distribute and install this on any Windows PC:
- **Installer Executable**: `dist/RRE Entries Setup 1.0.0.exe` (~127 MB)
- Run the installer wizard to install RRE Entries cleanly with automatic desktop & start menu shortcuts.
- **Standalone Unpacked Executable**: `dist/win-unpacked/RRE Entries.exe` (run directly without installing)
- **Rebuild Installer**: `npm run build:win`

---

## 🚀 Quick Launch

Run server:
```bash
node server.js
```
Open in browser:
- Web Application: **[http://localhost:4000](http://localhost:4000)**
- XML Gateway: **[http://localhost:9000](http://localhost:9000)**

## Voice assistant (multilingual)

A mic button (bottom-left, or `Alt+Shift+V`) lets you open screens and ask questions in many languages, including mixed-language speech. It understands 18 languages (English, Tamil, Hindi, Telugu, Malayalam, Kannada, Bengali, Marathi, Gujarati, Punjabi, Urdu, Arabic, French, German, Spanish, Chinese, Japanese, Korean); more can be added with JSON files. Voice only opens screens and reads answers; it never saves accounting entries, and sensitive commands wait for you to check and confirm the recognised text.

Speech recognition runs **on this computer**: the Owner installs a Whisper model once from the Voice panel (downloaded from huggingface.co, no account or key), after which it works offline and the language is detected automatically.

---

## ⚖️ Trademark Disclaimer

*Tally, TallyPrime, and Tally.ERP 9 are registered trademarks of Tally Solutions Pvt. Ltd.*
*RRE Entries is an independent product developed by RRE. It is not affiliated with, authorized, maintained, sponsored, or endorsed by Tally Solutions Pvt. Ltd.*
*All other trademarks, service marks, and trade names referenced herein are the property of their respective owners.*

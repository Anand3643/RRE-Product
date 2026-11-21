# RRE Tally — Modular Enterprise Suite

An accurate, production-grade recreation of **RRE Tally** architecture, workflows, systems, features, and statutory formulas reverse engineered from the official Tally model binaries, configuration, and data structures.

---

## ⚡ Gateway of Tally & Keyboard Shortcuts

| Shortcut | Function | Description |
| :---: | :--- | :--- |
| **Esc** | **Gateway / Back** | Return to Gateway of Tally or exit modal dialogs |
| **Alt+D** | **Dashboard** | Toggle TallyPrime Modern Interactive Analytical Dashboard |
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
| **Ctrl+N** | **Calculator** | Built-in Tally accounting calculator drawer |
| **Ctrl+A** | **Accept / Save** | 1-key instant voucher commit |
| **Alt+E** | **XML Export** | Full Tally XML interoperability backup (importable into desktop Tally) |

---

## 🏛️ Reverse-Engineered Modular Architecture

Extracted directly from `tally model/TallyPrime` and `tally model/Tally/Tally.ERP9`:
- **Dual Server Ports**:
  - `4000`: TallyPrime Modern Web UI and REST API.
  - `9000`: Tally Native XML Gateway Server (Configured via `tally.ini` `ServerPort=9000`), handling native `<ENVELOPE>` XML export/import for third-party ERP integrations.
- **Company Dataset (`data/100000/company.db`)**:
  - Follows standard Tally numbered folder storage convention (e.g., Company 100000).
- **Core Modules**:
  - `core/db.js`: SQLite ACID transactional engine for ledgers, groups, stock items, vouchers, godowns, and cost centres.
  - `core/accountingEngine.js`: Double-entry accounting engine calculating running ledger balances, weighted average stock valuation, COGS, P&L, and Balance Sheet.
  - `core/gstEngine.js`: Statutory Indian GST calculation engine (Intra-state CGST+SGST vs Inter-state IGST), GSTR-1, and GSTR-3B ITC netting.
  - `modules/dashboard/dashboardApi.js`: Modern TallyPrime drill-down telemetry API (`drilldown-BS`, `drilldown-PandL`, `drilldown-duerecv`, `drilldown-duepaya`, `drilldown-fundsflow`, `drilldown-stock`, `drilldown-costcentre`).
  - `modules/gateway/tallyXmlGateway.js`: Official Tally XML `<ENVELOPE>` parser and generator on port 9000.
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

RRE Tally implements the 13 enterprise system pillars designed for high-reliability offline desktop & local client-server operations:

1. **Secrets Management**: Zero API keys or hardcoded secrets. Server reads from `.env` or system environment with zero-config safe offline defaults. No secrets exposed to frontend.
2. **Security & Parameterized SQL**: 100% parameterized SQLite queries preventing SQL injection. Strict HTTP security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, CSP, Referrer-Policy).
3. **Authentication & RBAC**: Role-Based Access Control with 5 security tiers (Owner, Accountant, Data Entry, Auditor, Viewer), enforced on the server for every API route. There are no default passwords and no guest access: on first start the person installing the application chooses the administrator password; accounts created by an administrator (or still on a temporary password) must choose their own at first login; passwords need at least 10 characters with letters and numbers; self-registration and Google sign-in are off. PBKDF2 password hashing with 10,000 iterations & cryptographic salt. Brute-force rate limiting on `/api/auth/login`.
4. **Encryption**: Passwords cryptographically hashed at rest. HMAC-SHA256 session token generation and verification. Optional AES-256-GCM encrypted database backup archives.
5. **Disaster Recovery & Point-in-Time Backups**: Automated snapshot backups (`data/100000/backups/`) with SHA-256 checksum integrity verification. Automatic rollback snapshots taken prior to restore drills or data resets. 1-click backup and restore from the UI (`Alt+Y: Data`).
6. **Monitoring & Health Checks**: Comprehensive diagnostic endpoint (`GET /api/health`) reporting system uptime, SQLite WAL status, integrity check, disk usage, memory telemetry, and active record counts.
7. **System Design & Separation of Concerns**: Modular decoupled subsystems for Core Accounting Engine, Statutory GST Engine, Backup Engine, Security Subsystem, and Desktop Shell.
8. **Networking & Origin Lockdown**: Strict loopback binding (`127.0.0.1`) preventing unauthorized remote network exposure. Keep-alive timeout optimization (`65000` ms) preventing socket drops.
9. **Scaling & Query Optimization**: Database performance indices on vouchers, ledger entries, inventory entries, and user audit tables. SQLite WAL (Write-Ahead Logging) mode and PRAGMA busy_timeout.
10. **Load Testing & Benchmarks**: High-throughput automated stress testing script (`npm run test:load`) verifying sub-50ms p50/p95 latency and zero dropped requests at 300+ requests/second.
11. **Testing Suite**: Automated verification suite (`npm test`) running 58 comprehensive audit tests across schema, cryptography, RBAC, double-entry balance, backups, health checks, and bundled assets.
12. **Deployment & CI/CD**: Reproducible Windows NSIS setup package (`dist/RRE Tally Setup 1.0.0.exe`) and portable executable with desktop shortcuts.
13. **Data Retention & Pruning**: Automated snapshot retention policy retaining up to 30 snapshots with automated safe pruning.

---

## 💻 Install and Run on PC

### 1. Ready-to-Use Windows Desktop App
A native desktop shortcut with the official Tally icon has been created on your Windows Desktop:
- **Desktop Shortcut**: `C:\Users\Admin\Desktop\RRE Tally.lnk`
- **Start Menu**: Located in `Start Menu > Programs > RRE Tally`
- **Reinstall Shortcut Anytime**: Double-click [Install-Desktop-App.bat](file:///c:/Users/Admin/Desktop/RRE%20PRoduct/Install-Desktop-App.bat)

### 2. Standalone Windows Setup Installer (.exe)
You can distribute and install this on any Windows PC:
- **Installer Executable**: `dist/RRE Tally Setup 1.0.0.exe` (~127 MB)
- Run the installer wizard to install RRE Tally cleanly with automatic desktop & start menu shortcuts.
- **Standalone Unpacked Executable**: `dist/win-unpacked/RRE Tally.exe` (run directly without installing)
- **Rebuild Installer**: Run [build-installer.bat](file:///c:/Users/Admin/Desktop/RRE%20PRoduct/build-installer.bat) or `npm run build:win`

---

## 🚀 Quick Launch

Run server:
```bash
node server.js
```
Open in browser:
- Web Application: **[http://localhost:4000](http://localhost:4000)**
- Tally Native XML Gateway: **[http://localhost:9000](http://localhost:9000)**
- Tally Configuration: [tally.ini](file:///c:/Users/Admin/Desktop/RRE%20PRoduct/tally.ini)

## Voice assistant (multilingual)

A mic button (bottom-left, or `Alt+Shift+V`) lets you open screens and ask questions in many languages, including mixed-language speech. It understands 18 languages (English, Tamil, Hindi, Telugu, Malayalam, Kannada, Bengali, Marathi, Gujarati, Punjabi, Urdu, Arabic, French, German, Spanish, Chinese, Japanese, Korean); more can be added with JSON files. Voice only opens screens and reads answers; it never saves accounting entries, and sensitive commands wait for you to check and confirm the recognised text.

Speech recognition runs **on this computer**: the Owner installs a Whisper model once from the Voice panel (downloaded from huggingface.co, no account or key), after which it works offline and the language is detected automatically. Accuracy depends on the model size and the language: English and Hindi are good with the recommended `small` model, Tamil is fair, and Telugu, Malayalam and Kannada are often wrong at this size. Typing a command always works. Optional online transcription (an Owner-configured service) is off unless configured and needs each user's consent.

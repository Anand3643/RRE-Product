# TallyPrime Gold — Ramraj Enterprises (Full Accounting Suite)

An accurate, production-grade recreation of **TallyPrime / Tally ERP 9** architecture, workflows, systems, features, and statutory formulas.

---

## ⚡ Complete Gateway of Tally & Keyboard Shortcuts

| Shortcut | Function | Description |
| :---: | :--- | :--- |
| **Esc** | **Gateway / Back** | Return to Gateway of Tally or exit modal dialogs |
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

## 📐 Mathematical Formulas & Accounting Systems

### 1. Dual-Entry Equilibrium Invariant
$$\sum \text{Debits} \equiv \sum \text{Credits} \quad (\Delta < 0.05)$$
Every voucher must balance before commit. The backend rejects any unbalanced transaction.

### 2. Trading & Cost of Goods Sold (COGS)
$$\text{COGS} = \text{Opening Stock} + \text{Purchases} + \text{Direct Expenses} - \text{Closing Stock}$$
$$\text{Gross Profit} = \text{Net Sales} + \text{Direct Incomes} - \text{COGS}$$

### 3. Net Profit Formula
$$\text{Net Profit} = \text{Gross Profit} + \text{Indirect Incomes} - \text{Indirect Expenses}$$
Net Profit is automatically transferred to the **Capital Account** on the Balance Sheet.

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

## 🏛️ System Architecture

- **Backend**: Node.js & Express REST API (`server.js`) with ACID SQLite transactions.
- **Database Engine**: `tally_prime.db` (`db.js`) pre-seeded with 28 statutory Indian groups, multiple godowns, cost centres, double-entry vouchers, and bill allocations.
- **Frontend**: Zero-dependency keyboard-first Tally UI (`public/index.html`, `public/app.js`, `public/styles.css`).
- **Interoperability**: Standard Tally XML Export (`/api/export/tally-xml`) compatible with TallyPrime / Tally ERP 9 import.

---

## 🚀 Quick Launch

Run from workspace:
```bash
start-tally.bat
```
Or with Node:
```bash
node server.js
```
Open in browser:
👉 **[http://localhost:4000](http://localhost:4000)**

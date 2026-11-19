# TallyPrime Web Edition — Ramraj Enterprises

A full-scale, keyboard-driven recreation of **TallyPrime / Tally ERP 9** built with a real double-entry general ledger engine, statutory 28 Indian account groups, GST tax computation, F4–F9 voucher entry, and real-time financial reporting.

---

## ⚡ Gateway of Tally & Keyboard Shortcuts

| Key | Function | Description |
| :---: | :--- | :--- |
| **Esc** | **Gateway / Back** | Exit current screen or close modal, return to Gateway of Tally |
| **F4** | **Contra Voucher** | Cash to Bank, Bank to Cash, or Bank to Bank fund transfers |
| **F5** | **Payment Voucher** | Payments for expenses, vendor dues, or assets |
| **F6** | **Receipt Voucher** | Inward collections from customers, debtors, or capital |
| **F7** | **Journal Voucher** | Non-cash adjustments, provisions, and year-end entries |
| **F8** | **Sales Invoice** | Commercial sales with auto GST computation (CGST/SGST/IGST) and stock out |
| **F9** | **Purchase Voucher**| Vendor bills, raw material inward, and stock in |
| **B** | **Balance Sheet** | Liabilities vs Assets with automated Net Profit transfer |
| **P** | **Profit & Loss A/c** | Trading Account (Gross Profit) + Operating P&L (Net Profit) |
| **T** | **Trial Balance** | Real-time debit vs credit balance verification across all ledgers |
| **S** | **Stock Summary** | Item closing quantities, rates, and moving inventory valuations |
| **D** | **Day Book** | Chronological transaction journal |
| **C** | **Create Ledger** | Fast ledger master creation (Sundry Debtors, Creditors, Bank, Expenses) |

---

## 🗄️ Core Accounting Architecture

1. **Strict Double-Entry Enforcement**:
   Every voucher must satisfy $\sum \text{Debits} == \sum \text{Credits}$. Transactions out of balance cannot be posted.
2. **28 Statutory Indian Account Groups**:
   Preloaded with Primary and Secondary Tally groups (`Capital Account`, `Sundry Debtors`, `Sundry Creditors`, `Bank Accounts`, `Duties & Taxes`, `Direct/Indirect Expenses`, `Sales Accounts`, `Purchase Accounts`).
3. **Inventory Allocation (Stock Movement)**:
   Inward and outward stock tracking linked directly to Sales (F8) and Purchase (F9) vouchers.
4. **Account Statement (Khata)**:
   Full ledger statement for any account with opening balance, chronological debit/credit movements, and running balance.

---

## 🚀 Quick Launch

### 1-Click Desktop Launcher:
Double-click `start-tally.bat` or run:
```bash
npm start
```
Access in your browser:
👉 **[http://localhost:4000](http://localhost:4000)**

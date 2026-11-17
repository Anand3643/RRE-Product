# Ramraj Enterprises (RRE) — Manufacturing & Operations ERP Suite

An all-in-one industrial ERP system designed to replace fragmented software (Zoho Books, Zoho Inventory, Zoho CRM, Zoho People, and Manufacturing BOM) with a unified, high-performance platform tailored for compressor manufacturing, sales, spares, and field services.

---

## 🚀 Key Modules Included

| Module | Replaces | Key Capabilities |
| :--- | :--- | :--- |
| **Manufacturing & BOM** | Zoho Creator / MRP | Multi-level Bill of Materials (BOM), Production Work Orders (Job Cards), Automated stock consumption & finished goods yield on order completion |
| **Inventory & Spares** | Zoho Inventory | Real-time stock levels, low-stock reorder warnings, Goods Receipt (Stock IN), Delivery Challan (Stock OUT), movement audit trail |
| **Sales & CRM** | Zoho CRM | Customer/plant directory, professional GST quotations (18% auto-split), one-click conversion to Sales Orders, printable proposals |
| **AMC & Servicing** | Zoho Desk / Custom | Annual Maintenance Contracts tracker, machine serial numbers, visit frequency, automated upcoming service date alerts |
| **Finance & GST** | Zoho Books | Tax Invoices (CGST/SGST/IGST), accounts receivable tracking, partial payment receipts, operational expense ledger |
| **HR & Payroll** | Zoho People / Payroll | Staff directory, daily attendance tracker with quick-mark (Present/Absent/Half-day), automated monthly salary slip calculation |
| **Zoho Sync Hub** | Zoho Integration | Bi-directional live sync with Zoho Books API v3 (Estimates, Invoices, Contacts, Items) with GSTIN matching and audit logs |
| **Executive Dashboard** | Zoho Analytics | Live KPIs (Total revenue, stock valuation, active jobs, active AMCs, staff attendance) |

---

## 🛠️ Technology Stack

- **Backend**: Node.js + Express REST API
- **Database**: SQLite with foreign key constraints, relational integrity, and automated schema migrations
- **Frontend**: Single Page Application (SPA) powered by Tailwind CSS, Lucide Icons, and responsive modals
- **Printing Engine**: Native browser print styling for commercial Quotations, Tax Invoices, and Pay Slips

---

## 🏃 Quick Start

### 1. Launch with One Click
Double-click `start-erp.bat` on your Desktop. It will automatically start the server and open your browser at:
```
http://localhost:5000
```

### 2. Manual Start
```bash
npm install
npm start
```

---

## 🗄️ Database Structure

The database (`rre_erp.db`) is local and portable. It includes:
- `products`: Finished machines, sub-assemblies, and spare parts.
- `bom_items`: Component ratios and materials per assembly.
- `inventory_transactions`: Complete stock ledger (IN, OUT, ADJUST, PROD_CONSUME, PROD_YIELD).
- `work_orders`: Production status queue (`Draft` ➔ `In Production` ➔ `Quality Check` ➔ `Completed`).
- `customers`: Client company profiles, GSTINs, addresses, and contacts.
- `quotations` & `quotation_items`: Line items, discounts, and GST.
- `sales_orders`: Confirmed purchase commitments.
- `invoices` & `invoice_items`: GST Tax invoices with balance tracking.
- `amc_contracts`: Annual maintenance agreements and service schedules.
- `employees`, `attendance`, `payroll`: Complete workforce administration.
- `expenses`: Operating costs and vendor ledger.

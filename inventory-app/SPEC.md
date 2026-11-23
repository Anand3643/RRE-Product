# StockPilot – Product Spec (from user brief)

Enterprise inventory platform inspired by Zoho Inventory with better UX, automation and AI features.

## Modules
Dashboard, products, SKUs, barcodes, variants, inventory tracking, stock adjustments, stock ledger, multiple warehouses, transfers, customers, suppliers, sales orders, quotations, invoices, purchase orders, RFQs, purchase approvals, goods received notes, returns, shipping, GST, payments, reports, PDF/Excel/CSV exports, authentication, role permissions, notifications, audit logs, customer and supplier portals, REST APIs and integrations.

## Unique features
AI inventory assistant, predictive demand forecasting, automatic reorder recommendations, automatic RFQ generation, supplier quotation comparison, AI business insights, dead-stock detection, warehouse transfer recommendations, barcode/QR scanning, workflow automation, natural language reports, business health score.

## Business rules
Complete stock movement ledger; no accidental negative stock; reserve on confirmed orders and release on cancel; stock changes only via validated transactions; audit history; idempotent order processing; safe concurrent warehouse operations; enforced permissions.

## Design
Premium SaaS UI, collapsible sidebar, global search, interactive analytics, responsive, light/dark, modern tables/filters, customizable dashboard widgets, Ctrl+K command palette.

## Phases
1. Foundation, auth, organizations, products, warehouses, stock ledger
2. Customers, suppliers, sales and purchase orders, reservations
3. Quotations, invoices, GST, payments, shipping
4. Reports and analytics
5. AI, forecasting, automation
6. Integrations, security, performance, deployment

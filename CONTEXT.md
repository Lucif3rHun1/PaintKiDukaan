# PaintKiDukaan — Domain Glossary

## Core Entities

### Party
A person or business entity that interacts with the shop. Two kinds: **Customer** (buys from you) and **Vendor** (sells to you).

### Customer
A party who purchases goods from the shop. Has a name, phone, type classification, optional credit limit, and can be flagged for attention. Outstanding balance tracks how much they owe.

### Vendor
A party from whom the shop purchases goods (paint brands, hardware suppliers, logistics). Has a name, phone, contact person, optional credit limit, and opening balance. Outstanding balance tracks how much the shop owes them.

### Contact Person
The individual at a vendor company with whom the shop owner deals directly. Not a full entity — just a name string on the Vendor record.

## Transactions

### Purchase
A record of goods bought from a vendor. Links to a vendor via `vendor_id`. Automatically updates stock levels and vendor outstanding balance. Contains purchase items (product, quantity, cost).

### Sale
A record of goods sold to a customer. Links to a customer via `customer_id` (or null for walk-in). Automatically updates stock levels. Two kinds: **quotation** (draft, no stock impact) and **final** (commits stock, creates outstanding). Outstanding is derived from `total - paid_amount`, not from a "credit" payment mode.

### Quotation
A draft sale that hasn't been finalized. No stock movement. Can be converted to a final bill later. Auto-deleted when day is closed.

### Payment Split
One component of a sale's payment. Has a mode (cash/upi/card/cheque/bank_transfer) and amount in paise. A sale can have multiple splits. The sum of all splits = `paid_amount`. If `paid < total`, the remainder is implicit credit (outstanding).

### Credit (Implicit)
Not a payment mode. The consequence of `paid_amount < total`. The unpaid portion automatically becomes customer outstanding. No explicit "credit" mode needed.

### Sale Payment
A normalized record of payment against a specific sale. Replaces the JSON blob (`payment_modes_json`). Stored in `sale_payments` table with sale_id, mode, amount.

### Vendor Payment
A payment made **to** a vendor to reduce the outstanding balance. Has amount, mode (cash/upi/card/cheque/bank_transfer), date, and notes.

### Customer Payment
A payment received **from** a customer to reduce the outstanding balance.

### Customer Ledger
Auditable running balance per customer. Shows every sale (credit portion) and every payment received, in chronological order. Computed from normalized sale_payments + customer_payments tables.

## Balances

### Opening Balance
The starting balance when a party is created. Can be positive (you owe them / they owe you) or negative (they owe you / you owe them). Set manually during creation.

### Outstanding Balance
Current amount owed. Calculated as: `opening_balance + total_purchases - total_payments` (for vendors) or `opening_balance + total_sales - total_payments` (for customers).

### Credit Limit
Maximum outstanding balance allowed before purchasing should be paused. Optional field.

## Classifications

### Customer Type
Classification of customers: retail (individual), painter (professional painter), contractor (construction), dealer (resale). Affects pricing and credit terms.

## UI Patterns

### Khata Record
Traditional Indian shop ledger showing all transactions (sales, payments) for a party in chronological order. Used for both customers and vendors.

### Inline Edit
Click a cell in a list to edit it in-place. Enter saves, Esc cancels. No separate form needed for quick changes.

### Detail View
Full view when clicking a party name. Shows header (name, phone), stats grid (balances, totals), transaction history, and action buttons.

### Type-Ahead Autocomplete
Search-as-you-type input with dropdown results. Walk-in customer is the default (no interaction needed). Typing triggers client-side filter. Arrow keys + Enter or click to select.

### Smart Item Entry
Unified input that handles both barcode scanning (keyboard wedge: sends text + Enter) and manual name search. Barcode pattern → exact lookup. Text → fuzzy name search. Dropdown shows matches.

### Split Payment
Multiple payment mode+amount rows on a single sale. Sum of all splits = paid_amount. If paid < total, remainder is implicit credit. Modes: Cash, UPI, Card, Cheque, Bank Transfer.

## Money

### Paise
All monetary values stored as integers in paise (1/100 of rupee). Displayed using `formatINR()` utility.

## Security

### Roles
- **Owner**: Full access to all features
- **Cashier**: Can process sales, record payments
- **Stocker**: Can manage inventory

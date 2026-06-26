# Dashboard Metrics Improvement Plan

## Context

The dashboard has placeholder metric cards (Total Purchase, Expenses, Cash+Bank, Net Profit) showing `—` or wrong values, a Balance Overview card hardcoded to ₹0, and an Inventory section stub with no content. The backend already has `daily_sales`, `stock_report`, and `outstanding_report` in `reports.rs`. This plan wires up the missing metrics and adds a proper Inventory tab.

### What we're dropping

| Current UI element | Why |
|---|---|
| Net Profit card | `cost_paise` unreliable — replace with Payment Received |
| Cash + Bank card (shows outstanding) | Wrong data source — replace with Payment Paid |
| Balance Overview card (Cash/Bank/Total at ₹0) | No ledger table exists — delete the section |
| Disclaimer paragraph ("Cash & bank balances wire up once...") | Delete |

---

## Data flow

```
purchases.bill_date (unix ms)         →  purchase_summary  →  Total Purchase card + trend line
day_close.expenses_paise / .day       →  expense_summary   →  Expenses card
sale_items + sales                    →  top_items_sold    →  Top 5 Items by Sales
sales + customers                     →  top_customers     →  Top 5 Customers
purchase_items + purchases            →  top_items_purch.  →  Top 5 Items by Purchase
purchases + vendors                   →  top_vendors       →  Top 5 Suppliers
customer_payments.created_at (unix ms)→  payment_summary   →  Payment Received card
vendor_payments.created_at (unix ms)  →  payment_summary   →  Payment Paid card
stock_balances + items                →  stock_health_sum. →  Inventory Overview cards + donut
stock_movements (qty > 0, unix ms)    →  dead_stock        →  Dead Stock alert table
stock_movements (qty > 0, unix ms)    →  inventory_aging   →  Inventory Aging chart
```

---

## Critical schema facts (corrections to draft plan)

- `purchases.bill_date` is **unix milliseconds**, not an ISO string. Use `date_to_ms()`/`ms_to_date()` helpers that already exist privately in `purchases.rs` — make them `pub(crate)`.
- Sale line items table is `sale_items` (not `sale_lines`). Columns: `sale_id, item_id, qty, price, unit_type, line_discount, line_order`. `item_id` can be NULL for formula lines.
- `stock_movements.kind_id` is an FK to `stock_movement_kinds` table; `k.code` returns `"inward" | "sale" | "adjust" | "transfer"`. For dead stock / aging, use `sm.qty > 0` as the inbound discriminator (simpler, avoids needing the kinds join).
- `stock_movements.created_at` is unix ms.
- `customer_payments.created_at` and `vendor_payments.created_at` are unix ms.
- `day_close.day` is an ISO date string (YYYY-MM-DD), `day_close.expenses_paise` = cash_out at close.
- `purchase_items` columns: `purchase_id, item_id, qty, unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at`.
- `sales.date` is ISO-compatible; filter with `date(s.date) BETWEEN ?1 AND ?2` (existing pattern from `daily_sales`).

---

## Backend changes — `src-tauri/src/commands/reports.rs`

### Step 1: Expose `date_to_ms` / `ms_to_date` from purchases.rs

In `src-tauri/src/commands/purchases.rs`, change `fn date_to_ms` and `fn ms_to_date` from private to `pub(crate)`. Then import in `reports.rs`:

```rust
use crate::commands::purchases::{date_to_ms, ms_to_date};
```

### Step 2: Add 9 new types and functions

All functions follow the existing pattern: take `&Db`, return `Result<T, ReportsError>`, with a corresponding `#[tauri::command] pub fn cmd_*` that locks `AppState`.

**1. `purchase_summary(db, from_date, to_date) → PurchaseSummary`**

```rust
pub struct PurchaseSummary {
    pub grand_total: i64,
    pub rows: Vec<PurchaseDayRow>,  // for trend chart
}
pub struct PurchaseDayRow { pub date: String, pub total: i64 }
```

SQL:
```sql
SELECT date(bill_date/1000, 'unixepoch', 'localtime') AS day, SUM(total_paise) AS total
FROM purchases
WHERE bill_date >= ?1 AND bill_date < ?2   -- ?1=date_to_ms(from), ?2=date_to_ms(to)+86400000
GROUP BY day ORDER BY day ASC
```

**2. `expense_summary(db, from_date, to_date) → ExpenseSummary`**

```rust
pub struct ExpenseSummary { pub grand_total: i64 }
```

SQL:
```sql
SELECT COALESCE(SUM(expenses_paise), 0)
FROM day_close WHERE day BETWEEN ?1 AND ?2
```

**3. `top_items_sold(db, from_date, to_date, limit) → Vec<TopItemRow>`**

```rust
pub struct TopItemRow { pub item_id: i64, pub name: String, pub total_qty: i64, pub total_value: i64 }
```

SQL:
```sql
SELECT si.item_id, i.name, SUM(si.qty) AS total_qty, SUM(si.qty * si.price) AS total_value
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
JOIN items i ON i.id = si.item_id
WHERE s.status = 'final'
  AND si.item_id IS NOT NULL
  AND date(s.date) BETWEEN ?1 AND ?2
GROUP BY si.item_id
ORDER BY total_qty DESC
LIMIT ?3
```

**4. `top_customers(db, from_date, to_date, limit) → Vec<TopCustomerRow>`**

```rust
pub struct TopCustomerRow { pub customer_id: Option<i64>, pub name: String, pub total_value: i64, pub bill_count: i64 }
```

SQL:
```sql
SELECT s.customer_id, COALESCE(c.name, 'Walk-in') AS name,
       SUM(s.total) AS total_value, COUNT(*) AS bill_count
FROM sales s
LEFT JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'final' AND date(s.date) BETWEEN ?1 AND ?2
GROUP BY s.customer_id
ORDER BY total_value DESC
LIMIT ?3
```

**5. `top_items_purchased(db, from_date, to_date, limit) → Vec<TopItemRow>`** (reuse `TopItemRow`)

SQL:
```sql
SELECT pi.item_id, i.name, SUM(pi.qty) AS total_qty, SUM(pi.line_total_paise) AS total_value
FROM purchase_items pi
JOIN purchases p ON p.id = pi.purchase_id
JOIN items i ON i.id = pi.item_id
WHERE p.bill_date >= ?1 AND p.bill_date < ?2   -- ms bounds
GROUP BY pi.item_id
ORDER BY total_qty DESC
LIMIT ?3
```

**6. `top_vendors(db, from_date, to_date, limit) → Vec<TopVendorRow>`**

```rust
pub struct TopVendorRow { pub vendor_id: Option<i64>, pub name: String, pub total_value: i64 }
```

SQL:
```sql
SELECT p.vendor_id, COALESCE(v.name, 'Unknown') AS name, SUM(p.total_paise) AS total_value
FROM purchases p
LEFT JOIN vendors v ON v.id = p.vendor_id
WHERE p.bill_date >= ?1 AND p.bill_date < ?2
GROUP BY p.vendor_id
ORDER BY total_value DESC
LIMIT ?3
```

**7. `stock_health_summary(db) → StockHealthSummary`**

```rust
pub struct StockHealthSummary {
    pub total_active_items: i64,
    pub healthy_count: i64,
    pub low_count: i64,
    pub zero_count: i64,
    pub negative_count: i64,
    pub retail_value_paise: i64,
}
```

SQL (subquery aggregates per-item qty across all locations):
```sql
SELECT
    COUNT(*)                                                                        AS total_active_items,
    SUM(CASE WHEN total_qty > 0 AND (min_qty = 0 OR total_qty > min_qty) THEN 1 ELSE 0 END) AS healthy_count,
    SUM(CASE WHEN total_qty > 0 AND min_qty > 0 AND total_qty <= min_qty THEN 1 ELSE 0 END) AS low_count,
    SUM(CASE WHEN total_qty = 0  THEN 1 ELSE 0 END)                                AS zero_count,
    SUM(CASE WHEN total_qty < 0  THEN 1 ELSE 0 END)                                AS negative_count,
    SUM(CASE WHEN total_qty > 0  THEN total_qty * retail_price_paise ELSE 0 END)   AS retail_value_paise
FROM (
    SELECT i.id, i.min_qty, i.retail_price_paise,
           COALESCE(SUM(sb.qty), 0) AS total_qty
    FROM items i
    LEFT JOIN stock_balances sb ON sb.item_id = i.id
    WHERE i.is_active = 1
    GROUP BY i.id
)
```

**8. `dead_stock(db, days_idle) → Vec<DeadStockRow>`**

```rust
pub struct DeadStockRow { pub item_id: i64, pub name: String, pub current_qty: i64, pub last_inbound_ms: Option<i64> }
```

SQL (items with positive stock but no positive-qty movement in last N days):
```sql
-- threshold_ms = now_ms() - days_idle * 86400 * 1000
SELECT i.id, i.name, COALESCE(SUM(sb.qty), 0) AS current_qty,
       MAX(sm.created_at) AS last_inbound_ms
FROM items i
LEFT JOIN stock_balances sb ON sb.item_id = i.id
LEFT JOIN stock_movements sm ON sm.item_id = i.id AND sm.qty > 0 AND sm.created_at >= ?threshold_ms
WHERE i.is_active = 1
GROUP BY i.id
HAVING current_qty > 0 AND last_inbound_ms IS NULL
ORDER BY i.name
LIMIT 50
```

**9. `inventory_aging(db) → InventoryAgingReport`**

```rust
pub struct InventoryAgingReport {
    pub bucket_0_30: i64,
    pub bucket_31_60: i64,
    pub bucket_61_90: i64,
    pub bucket_91_plus: i64,
}
```

Compute 4 ms thresholds from `now_ms()` (30/60/90 days back), then:
```sql
SELECT
    SUM(CASE WHEN last_inbound_ms >= ?t30  THEN 1 ELSE 0 END) AS bucket_0_30,
    SUM(CASE WHEN last_inbound_ms >= ?t60  AND last_inbound_ms < ?t30 THEN 1 ELSE 0 END) AS bucket_31_60,
    SUM(CASE WHEN last_inbound_ms >= ?t90  AND last_inbound_ms < ?t60 THEN 1 ELSE 0 END) AS bucket_61_90,
    SUM(CASE WHEN last_inbound_ms IS NULL OR last_inbound_ms < ?t90 THEN 1 ELSE 0 END)  AS bucket_91_plus
FROM (
    SELECT i.id, MAX(sm.created_at) AS last_inbound_ms
    FROM items i
    LEFT JOIN stock_movements sm ON sm.item_id = i.id AND sm.qty > 0
    WHERE i.is_active = 1
    GROUP BY i.id
)
```

*(No `payment_summary` command — Payment Received/Paid cards will query `customer_payments` and `vendor_payments` directly inline; simpler since there's no existing pattern to follow for these tables.)*

Actually — add a single `payment_summary` to keep the pattern clean:

**10. `payment_summary(db, from_date, to_date) → PaymentSummary`**

```rust
pub struct PaymentSummary { pub received_paise: i64, pub paid_paise: i64 }
```

SQL:
```sql
-- received: customer_payments.created_at is unix ms
SELECT COALESCE(SUM(amount_paise), 0) FROM customer_payments
WHERE created_at >= ?1 AND created_at < ?2

-- paid: vendor_payments.created_at is unix ms
SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments
WHERE created_at >= ?1 AND created_at < ?2
```

### Step 3: Register in `src-tauri/src/lib.rs` `generate_handler![]`

Add under the `// Reports (Slice C)` block:
```rust
commands::reports::cmd_purchase_summary,
commands::reports::cmd_expense_summary,
commands::reports::cmd_top_items_sold,
commands::reports::cmd_top_customers,
commands::reports::cmd_top_items_purchased,
commands::reports::cmd_top_vendors,
commands::reports::cmd_stock_health_summary,
commands::reports::cmd_dead_stock,
commands::reports::cmd_inventory_aging,
commands::reports::cmd_payment_summary,
```

---

## Frontend changes

### Step 4: Add types to `src/pos/types.ts`

Add interfaces mirroring each Rust struct:
```ts
export interface PurchaseDayRow { date: string; total: number }
export interface PurchaseSummary { grand_total: number; rows: PurchaseDayRow[] }
export interface ExpenseSummary { grand_total: number }
export interface TopItemRow { item_id: number; name: string; total_qty: number; total_value: number }
export interface TopCustomerRow { customer_id: number | null; name: string; total_value: number; bill_count: number }
export interface TopVendorRow { vendor_id: number | null; name: string; total_value: number }
export interface StockHealthSummary { total_active_items: number; healthy_count: number; low_count: number; zero_count: number; negative_count: number; retail_value_paise: number }
export interface DeadStockRow { item_id: number; name: string; current_qty: number; last_inbound_ms: number | null }
export interface InventoryAgingReport { bucket_0_30: number; bucket_31_60: number; bucket_61_90: number; bucket_91_plus: number }
export interface PaymentSummary { received_paise: number; paid_paise: number }
```

### Step 5: Add IPC wrappers to `src/pos/api.ts`

Follow the existing `isTauri() ? tauriInvoke(...) : Promise.resolve(fallback)` pattern, one export per command. Date range params use `from_date` / `to_date` (snake_case to match backend `rename_all = "snake_case"`).

### Step 6: Split Dashboard.tsx into tabs

Current `Dashboard.tsx` (949 lines) will grow significantly. Extract:

- **`src/shell/routes/dashboard/BusinessTab.tsx`** — all current "Sales" section content plus new Purchase/Expense/Payment cards and Top 5 tables
- **`src/shell/routes/dashboard/InventoryTab.tsx`** — new inventory content
- `Dashboard.tsx` becomes thin: header, alerts, top-level metric cards (Today's Sales, Items Sold Today, Customers, Low Stock, Pending Credit, Backup), tab toggle, and renders `<BusinessTab>` or `<InventoryTab>`.

Shared helpers (`MetricCard`, `Delta`, `Sparkline`, `Row`, `QuickActions`, etc.) move to `src/shell/routes/dashboard/shared.tsx`.

### Step 7: Business tab content changes

**Remove:**
- The "Net Profit (today)" `MetricCard` (wrong data source)
- The "Cash + Bank" `MetricCard` (shows outstanding — misleading)
- The entire "Balance Overview" `Card` (hardcoded zeros)
- The disclaimer `<p>` ("Cash & bank balances wire up once...")

**Replace the 5-card row with 4 wired cards:**
1. **Total Sales** — already wired to `todaySalesPaise`
2. **Total Purchase** — `purchaseSummary(today, today).grand_total`
3. **Expenses** — `expenseSummary(today, today).grand_total`
4. **Payment Received** — `paymentSummary(today, today).received_paise`
5. **Payment Paid** — `paymentSummary(today, today).paid_paise`

(Keep 5 cards; drop Net Profit and Cash+Bank, add the two payment cards.)

**Extend the Trends chart:**
Modify the existing `Sparkline` component OR create `TwoLineTrend` that renders two `<polyline>` in one `<svg>` — one for sales (primary color), one for purchases (info color) — with a small legend. The purchase data comes from `weeklySales`-equivalent query on `purchaseSummary`.

**Add two new sections below the chart row:**

*Top 5 by Sales* — two tabs ("Items" / "Customers"):
- Items: `topItemsSold(weekStart, today, 5)` → name + qty + value list
- Customers: `topCustomers(weekStart, today, 5)` → name + value list

*Top 5 by Purchase* — two tabs ("Items" / "Suppliers"):
- Items: `topItemsPurchased(weekStart, today, 5)` → name + qty + value list
- Suppliers: `topVendors(weekStart, today, 5)` → name + value list

Use simple in-component `useState` for the active tab (no router involvement).

**Party Overview** — already wired, keep as-is.

### Step 8: Inventory tab (new)

**Inventory Overview cards (4 cards, no time range):**
- Total Items (active) — `stockHealth.total_active_items`
- Stock Value — `stockHealth.retail_value_paise` (use `<Money>`)
- Low Stock count — `stockHealth.low_count`
- Zero Stock count — `stockHealth.zero_count`

**Stock Health donut chart:**
Hand-rolled SVG donut (consistent with existing hand-rolled Sparkline). Four segments: Healthy (success), Low (warning), Zero (muted), Negative (destructive). Compute arc paths from counts.

**Low Stock alerts** — move the existing `lowStock` query display here from the main metrics grid. (Keep the metric card in the top section but move the detail list here.)

**Top Moving Items (2-tab: Top Sellers / Top Purchased):**
- Reuse `topItemsSold` and `topItemsPurchased` queries already fetched for Business tab

**Stock by Category bar chart:**
`stockReport().by_group` already returns `{ group, total_qty, total_retail_value }`. Render as horizontal bar chart (hand-rolled SVG bars). Toggle between Value and Qty with a button.

**Dead Stock Alert table (60+ days):**
`deadStock(60)` → table with name, current qty, last movement date.

**Inventory Aging chart:**
`inventoryAging()` → 4-bucket horizontal bar chart showing item count per time bucket.

---

## Implementation order

```
1. purchases.rs      — make date_to_ms/ms_to_date pub(crate)
2. reports.rs        — add 10 new types + functions + cmd_* wrappers
3. lib.rs            — register 10 new commands in generate_handler!
4. pos/types.ts      — add 10 new interfaces
5. pos/api.ts        — add 10 new IPC wrappers
6. dashboard/shared.tsx       — extract MetricCard, Delta, Sparkline, Row, QuickActions
7. dashboard/BusinessTab.tsx  — wire new cards, remove dead cards, extend trend chart, add Top 5 sections
8. dashboard/InventoryTab.tsx — full new inventory content
9. Dashboard.tsx     — thin orchestrator: keep top metrics, add tab toggle, render sub-tabs
```

Steps 1–5 must be done before 6–9 (backend drives types). Steps 6–9 can be done in parallel per file but 9 depends on 7 and 8.

---

## Verification

1. `cargo test -p paintkiduakan-lib` — existing tests must pass; add minimal smoke tests for `purchase_summary`, `expense_summary`, `stock_health_summary`
2. `pnpm build` or `pnpm typecheck` — no TypeScript errors
3. Create a test purchase → Total Purchase card reflects it immediately on refresh
4. Trigger a day close with cash_out=500 → Expenses card shows ₹5.00
5. Record a customer payment → Payment Received card updates
6. Confirm Balance Overview is gone — no ₹0.00 placeholders anywhere on dashboard
7. Inventory tab: verify total_active_items matches item count from Items list page
8. Check dead stock table: manually verify a known idle item appears
9. Party Overview totals match the dedicated Outstanding report page

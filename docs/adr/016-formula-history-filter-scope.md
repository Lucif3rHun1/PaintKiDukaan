# ADR-016: Date Filter Lives on History Sub-Section, Not on the Formulas List

## Status
Accepted

## Context
There are two surfaces for formula data:
1. The **Formulas list** (`#/formulas`) — catalog of all formulas. Filterable by `id_code`/name (search) and active/inactive (toggle).
2. The **Formula History** (sub-section of `#/formulas/{id}`) — every sale that included this formula.

These have different filter needs. The list is a catalog ("show me everything"); the history is a sales record ("show me sales of this formula in March"). Conflating them — putting date filter on the list — would force the cashier to also pick a date range just to see the catalog. That is friction for no benefit.

## Decision

### Formulas list page (`#/formulas`)
- **No date filter.**
- Filter by: search (`id_code` / `name`), active/inactive 3-state toggle.
- Each row shows `last_sold_at` as an **always-visible column**, derived from the most recent sale of this formula. Read-only, not interactive.

### Formula details page (`#/formulas/{id}`)
- **Sub-section 1 — Info**: id_code, name, with_base, retail_price_paise, is_active, sales_count, last_sold_at, created_at, created_by.
- **Sub-section 2 — History** (table of sales of THIS formula):
  - Columns: invoice_no, date, customer, qty, price, line_total.
  - Filters: search (invoice number + customer name, `LIKE`), date range (required UI — defaults to "all time" when opened).
  - Each row is a link to `SaleDetailPage` in view-only mode (`#/sales/{id}`).

### Deriving `last_sold_at` and `sales_count`
Computed in Rust at read time (not stored):
```rust
SELECT MAX(s.created_at), COUNT(*)
FROM sale_items si JOIN sales s ON s.id = si.sale_id
WHERE si.formula_id = ?1 AND s.kind = 'final'
```

YAGNI on an index for now — formula sales will be O(thousands) over years.

## Consequences
- **+** Each surface has the filter it actually needs.
- **+** `last_sold_at` on the list gives the cashier a quick "is this shade still in demand?" signal without forcing them into the details page.
- **+** History filter is local to the formula — no global "all formula sales in March" view. YAGNI; build when asked.
- **−** The list query is now a join across `formulas`, `sale_items`, `sales`. Acceptable for the row counts in question.

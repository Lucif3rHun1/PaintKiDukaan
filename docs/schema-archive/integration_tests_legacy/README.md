# Legacy integration tests — ARCHIVED, STALE

These three integration test files reference the v1..v14 schema (column names,
table names, FK shapes). After the schema reset they will not compile against
the new `schema.sql` and are intentionally excluded from the test runner.

## Files

- `inventory_integration.rs` — items, stock_movements, units, brands
- `parties_integration.rs` — customers, vendors, customer_types
- `sales_integration.rs` — sales, sale_items, sale_payments, returns, day_close

## Why archived (not deleted)

The tests encode business rules that still apply after the reset — sale
validation, payment-mode arithmetic, stock movement audit, etc. They are a
useful starting point for the L3 rewrite.

## Plan for L3

Rewrite each test file against the new schema:

1. Update `Db::open_in_memory()` calls if signatures changed.
2. Rewrite column references (`cost_price` → `cost_paise`, etc.).
3. Drop any test that exercised the old JSON-blob payment path.
4. Drop the `default_location = ORDER BY id LIMIT 1` test; replace with
   `locations.is_default` partial-UNIQUE assertion.
5. Add tests for the new bits: `stock_movement_kinds` lookup, append-only
   triggers on `stock_movements`, polymorphic `ref_kind`/`ref_id`.

Until then these files are read-only archaeology — keep this folder intact.

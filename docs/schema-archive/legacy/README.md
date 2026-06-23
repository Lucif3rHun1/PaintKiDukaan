# Legacy schema history (v1..v14) — ARCHIVED

These files were the production SQL schema between 2024-2026. They are preserved
here for archaeology only — **they are no longer applied to the database**.

## What's in here

The 14 incremental migrations that built up the legacy production schema:

| Version | Slug                     | Summary                                                    |
| ------- | ------------------------ | ---------------------------------------------------------- |
| v1      | `v1__base`               | Base tables: locations, users, customers, items, sales...  |
| v2      | `v2__inventory_rename`   | Money columns renamed to `*_paise`; `min_qty` etc.         |
| v3      | `v3__vendors_extras`     | vendors.updated_at / contact_person / credit_limit        |
| v4      | `v4__brands`             | brands + brand_sequences; items.brand_id FK                |
| v5      | `v5__alerts`             | alerts table (JSON-blob roles/read_by); retention days     |
| v6      | `v6__sale_payments`      | normalized sale_payments (JSON kept alongside — bug)       |
| v7      | `v7__settings_currency`  | settings currency triple; dead columns left behind         |
| v8      | `v8__units`              | units + unit_conversions                                   |
| v9      | `v9__lockout`            | settings.failed_attempts_lockout                           |
| v10     | `v10__drop_units_legacy` | drop items.unit / sell_unit / units_per_pack              |
| v11     | `v11__sales_audit`       | sales.voided_at/voided_by/edited_at/edited_by              |
| v12     | `v12__sub_locations`     | sub_locations + items.sub_location_id / position           |
| v13     | `v13__locations_zone`    | locations.zone                                             |
| v14     | `v14__returns`           | sale_returns + sale_return_lines; stock_movements recreate |

## Why archived

The schema had grown by accretion. By v14 it had:

- Two parallel sources of truth for sale payment splits (`sales.payment_modes_json`
  + `sale_payments` both written).
- Mixed timestamp types (TEXT `datetime('now')` vs INTEGER epoch ms).
- A magic "first active location" rule (5+ sites in sales.rs).
- A race-prone `mint_next_sku` (SELECT-after-UPDATE without `RETURNING`).
- Stock movements recreated at v14 just to extend a `CHECK` constraint.
- 14 round-trips through the migration runner on every fresh install.

The redesign reset the DB to a single canonical schema (`schema.sql`) and
treats any future change as a forward migration in
`src-tauri/src/db/migrations/`.

## What to do with this folder

- **Read-only reference.** Do not link these files into the build.
- **Diff tool.** Use these to answer "did we used to store X?" questions.
- **Do not apply.** `migrations.rs` does not include any of these files.

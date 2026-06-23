# ADR-001: Add missing columns to vendors table

## Status

Accepted

## Context

The `vendors` table was created without `updated_at`, `contact_person`, and `credit_limit` columns, but the code expects them:

- **`updated_at`**: Rust `Vendor` struct and TypeScript `Vendor` interface both declare `updated_at`. SQL queries select it. But `schema_v1.sql` line 73-81 shows the vendors table has no such column. This causes a runtime error: `no such column: updated_at`.
- **`contact_person`**: Needed for vendor detail view (who you deal with at the company). Currently not in schema.
- **`credit_limit`**: Needed for vendor credit management (max outstanding before pausing purchases). Currently not in schema.

The `customers` table already has `updated_at` (line 67) and `credit_limit` (line 64), so this is a migration gap, not a design decision.

## Decision

Add three columns to `vendors` table via a new migration:

```sql
-- schema_v3.sql
ALTER TABLE vendors ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE vendors ADD COLUMN contact_person TEXT;
ALTER TABLE vendors ADD COLUMN credit_limit INTEGER;
```

**Rationale**:
- `updated_at`: Required by existing code. Default to `datetime('now')` for existing rows.
- `contact_person`: Nullable — not all vendors have a specific contact person.
- `credit_limit`: Nullable — optional field, same as customers.

## Consequences

- Existing vendor rows get `updated_at = datetime('now')` (current timestamp)
- Existing vendor rows get `contact_person = NULL`, `credit_limit = NULL`
- Rust `Vendor` struct already expects these fields — no Rust changes needed
- TypeScript `Vendor` interface already expects these fields — no TS changes needed
- The error `no such column: updated_at` will be fixed

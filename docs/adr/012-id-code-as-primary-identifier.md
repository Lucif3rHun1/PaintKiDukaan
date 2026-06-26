# ADR-012: `id_code` is the Primary Identifier for Formulas

## Status
Accepted

## Context
Cashiers recognise formulas by the **number on the physical shade card**, not by name and not by an auto-generated DB id. Examples: "8827", "1293". Names are descriptive but optional — many formulas live with a number only. The DB's autoincrement `id` is invisible to users. Searching by either name only or by DB id only would miss the cashier's mental model.

## Decision
The user-assigned numeric/text `id_code` is the **primary identifier at the counter and in the UI**. Display leads with `id_code`; `name` is secondary (rendered smaller, omitted if null). `id` (autoincrement) is the FK and never displayed.

### Field shape
```sql
id_code TEXT NOT NULL UNIQUE  -- e.g. "8827", "R-204", "BM-001"
name    TEXT NULL              -- e.g. "Rose Beige" — optional
```

### Search
Unified search input on the sales page matches in this order:
1. Exact `id_code` match → first
2. `id_code` prefix match → second
3. `name` `LIKE '%query%'` → third

### Display
- Formula list row: `8827 — Rose Beige` (em-dash separator, smaller secondary)
- Formula-only row: `8827` (no em-dash)
- Receipt print: `id_code` first line, `name` second line if present
- Cart line in sale: same convention

### Validation
- `id_code` is required, trimmed, max 32 chars
- Unique enforced by DB constraint; UI surfaces the conflict clearly (reuse `Conflict` error variant)

## Consequences
- **+** Cashier finds the shade by the number they know.
- **+** Renaming a formula does not break history (FK uses `id`, not `id_code`).
- **−** Renaming `id_code` is forbidden in practice (would orphan cashier memory). Edit form disables `id_code` after creation; if the code is wrong, deactivate and create a new one.
- **−** Two formulas with the same `id_code` is a hard error — collision must be prevented at the UI before submit, not just at the DB.

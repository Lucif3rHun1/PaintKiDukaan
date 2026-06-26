# ADR-014: Formulas — Edit Freely, Soft-Delete Only

## Status
Accepted

## Context
Formula prices drift with pigment cost. Names get re-spelled. `id_code` rarely changes (cashier memory, ADR-012). A formula sold even once must remain queryable from historical sales forever — a hard delete would orphan the `sale_items.formula_id` FK and break the formula history view.

## Decision
- **Edit freely**: any formula field except `id_code` is editable in place. UI: "Edit" button on `FormulaDetailsPage` opens a `FormulaForm` modal pre-filled.
- **Soft-delete only**: deactivation sets `is_active = 0`. Hard delete is **not exposed** in the UI and would be rejected by a DB trigger or by Rust command logic.
- **`id_code` is immutable** after creation (ADR-012). If the code is wrong, deactivate the old formula and create a new one.

### Active/Inactive semantics
- The formulas list page has a 3-state toggle: `All / Active / Inactive`. Persisted in URL hash (matches existing pattern).
- Inactive formulas are excluded from the unified sales search by default. Power feature (escape hatch): if a cashier searches by an inactive `id_code`, the result is still surfaced (otherwise they cannot re-activate by typing the code they remember).
- Inactive formulas still appear on historical sale details and on the formula details page (read-only).

### Edit form behaviour
- Save with no changes → no-op
- Save with new `name` / `price` → updates `updated_at`-equivalent field (not yet in schema — YAGNI, the list page does not show it)

## Consequences
- **+** Sale history is never broken.
- **+** Cashiers can fix typos and price drift without DB intervention.
- **+** Restoring a formula is just toggling `is_active` back to 1.
- **−** "Deleted" formulas accumulate forever. Acceptable — there will never be more than a few thousand.

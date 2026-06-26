# ADR-013: Formulas Are Not Returnable

## Status
Accepted

## Context
A formula is a **mixed paint shade** produced on demand for a specific sale. Once mixed, the pigment + base cannot be cleanly separated back into inventory. Returns would mean either (a) re-shelving a tinted can (impractical, contaminates the base) or (b) throwing away a custom mix (loss). Neither matches the user's mental model: "we charge money for the formula, and once it's sold it's gone."

Items (cans, hardware) remain returnable as before. This ADR is scoped to formula lines only.

## Decision
A `sale_items` row of `kind='formula'` **cannot be added to a return**. The return dialog:

- Greys out formula rows in the original-sale table
- Disables the "return this line" checkbox for formula rows
- Shows a tooltip: "Formula mixes cannot be returned"

### Backend enforcement
`cmd_create_return` validates that every returned line has `kind='item'`. If a formula id slips through (e.g. via a hand-crafted IPC call), the command returns `AppError::Validation("formula lines are not returnable")`.

### Edge case: full-bill reversal
A full-bill reversal (rare) is unaffected — it is a write-off, not a return. If a bill is 100% formula lines, the reversal still goes through as a `sale_delete` or owner-only adjustment, not a `sale_return`.

## Consequences
- **+** Matches the physical reality of paint mixing.
- **+** Removes a category of confusion at the counter (cashier cannot accidentally "return" a shade mix).
- **−** A customer who genuinely refuses a formula at delivery must be handled out-of-band (owner adjustment / manual refund). The owner role already has this authority.

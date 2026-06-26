# ADR-015: Formulas Work in Quotations

## Status
Accepted

## Context
A contractor often asks for a quote that includes custom shade mixes. The cashier types the formula `id_code`, the quote is printed and given to the contractor, and later — if accepted — the quote is converted to a final bill. The formula lines must survive this conversion.

## Decision
A `CartLine` of `kind='formula'` is allowed in a sale of `kind='quotation'`. The paint-brush (create formula) button is **enabled in quotation mode** in the sales page header.

### Conversion path
`cmd_convert_quotation` flips the parent `sale.kind` from `quotation` → `final` and creates stock movements **only for item lines**. Formula lines are unchanged (no inventory movement, no outstanding impact — already correct because formula lines never touched stock).

### Quotation print
Receipt for a quotation prints `id_code` first, then `name`, then `qty=1`, then `price` — same as a final bill. The header carries the "Quotation" stamp (already implemented).

## Consequences
- **+** Quotations and final bills look identical for formula lines, which is what the contractor sees.
- **+** No special-case branching in `convert_quotation` beyond the existing per-line kind check.
- **−** A formula line in a quotation must still validate against the active formula set at conversion time. If the formula was deactivated between quote and convert, the conversion **succeeds** (the price was snapshotted at quotation time per `sale_items.price`) but a small badge appears on the bill: "formula now inactive".

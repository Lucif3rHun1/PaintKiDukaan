# ADR-010: Split Payment UI

## Status
Accepted

## Context
Real paint shop payments are often split: part UPI, part cash, part cheque. The current UI only supports one payment mode per sale.

## Decision
Multi-row payment UI in the bill panel:

```
Total: ₹12,000

Payments:
[UPI         ₹5,000] [×]
[Cash        ₹3,000] [×]
[+ Add payment]

Paid: ₹8,000
Credit: ₹4,000 (auto-calculated, grayed out)
```

### Rules
- First row is pre-filled with the default mode (Cash)
- "+ Add payment" adds a new row
- Each row has: mode selector + amount input + remove button
- `paid_amount` = sum of all row amounts (auto-calculated)
- `credit` = `total - paid_amount` (auto-calculated, shown but not editable)
- If `paid_amount > total`, show error (can't overpay)
- If `paid_amount = 0`, it's a full credit sale (only allowed for attached customers, not walk-in)

### Walk-in Constraint
Walk-in customers must pay in full (`paid = total`). This is already enforced in the backend. The UI should disable the "Save bill" button if walk-in + paid < total.

### Backend
- `NewSale.payment_modes` becomes an array of `{ mode, amount }` (already is)
- `sale_payments` table stores each split as a separate row (ADR-006)
- `sale.paid_amount` = sum of all splits (denormalized for fast queries)

## Consequences
- **Real-world**: Matches how paint shops actually accept payments
- **Clear UX**: Cashier sees exactly what's been paid and what's outstanding
- **Flexible**: Can add/remove payment rows as needed
- **Consistent**: Backend already supports array of payment splits

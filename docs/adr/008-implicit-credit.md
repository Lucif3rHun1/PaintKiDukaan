# ADR-008: Implicit Credit (Credit as Consequence)

## Status
Accepted

## Context
Currently, "credit" is listed as a payment mode alongside Cash, UPI, Card, Cheque. This creates confusion:
- Is "credit" a payment method? (No, it's the absence of payment)
- The backend CHECK constraint allows `bank` but not `credit`
- The frontend type includes `credit` but backend comment says `bank`
- A "credit sale" is really just `paid_amount < total`

## Decision
Remove "credit" from payment modes. Credit is the **consequence** of `paid_amount < total`, not a payment mode.

Payment modes are:
- `cash` — physical currency
- `upi` — UPI transfer (Google Pay, PhonePe, etc.)
- `card` — debit/credit card
- `cheque` — post-dated or current cheque
- `bank_transfer` — NEFT/RTGS/IMPS

If a ₹12,000 sale has ₹5,000 UPI + ₹3,000 Cash, the system knows ₹4,000 is outstanding. No "credit" mode needed.

## Consequences
- **Simpler UI**: No confusing "Credit (khata)" option in payment mode selector
- **Consistent**: Frontend and backend agree on valid modes
- **Correct**: Outstanding is derived from `total - paid`, not from a mode flag
- **Migration**: Update CHECK constraints to remove 'credit', add 'bank_transfer'

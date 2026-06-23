# ADR-006: Normalize Sale Payments

## Status
Accepted

## Context
Sales currently store payment information as a JSON blob in `sales.payment_modes_json`. This makes it impossible to:
- Query "all sales paid by UPI" without parsing JSON
- Audit individual payment records
- Join payments with other tables
- Enforce mode constraints at the DB level

The JSON blob approach was a shortcut that now limits reporting and auditing.

## Decision
Replace `payment_modes_json` with a normalized `sale_payments` table:

```sql
CREATE TABLE sale_payments (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('cash','upi','card','cheque','bank_transfer')),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- Each row = one payment component (e.g., ₹5000 UPI + ₹3000 Cash = two rows)
- `sale.paid_amount` stays as a denormalized sum for fast queries
- `sale.payment_modes_json` is removed after migration
- Backend `create_final_bill` inserts into `sale_payments` instead of serializing JSON
- Backend `get_sale` joins with `sale_payments` to return payment splits

## Consequences
- **Migration**: Add `sale_payments` table, migrate existing JSON data, drop `payment_modes_json` column
- **Reports**: Can now query payment modes directly (e.g., "total UPI sales today")
- **Audit**: Each payment is an individual record with timestamp
- **Breaking**: All code that reads/writes `payment_modes_json` must be updated

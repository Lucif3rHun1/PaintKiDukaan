# ADR-007: Customer Ledger View

## Status
Accepted

## Context
Currently, customer outstanding is computed on-the-fly from:
```
opening_balance + Σ(total - paid_amount) - Σ(customer_payments.amount)
```

This works but is not auditable. If there's a discrepancy, you can't trace which sale or payment caused it.

## Decision
Create a `customer_ledger` view that provides an auditable running balance:

```sql
CREATE VIEW customer_ledger AS
SELECT
  c.id AS customer_id,
  c.name AS customer_name,
  'opening' AS type,
  NULL AS ref_id,
  c.opening_balance AS amount,
  c.created_at AS date,
  c.opening_balance AS running_balance
FROM customers c
WHERE c.opening_balance != 0

UNION ALL

SELECT
  s.customer_id,
  c.name,
  'sale',
  s.id,
  s.total - s.paid_amount AS amount,
  s.date,
  NULL AS running_balance
FROM sales s
JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'final' AND s.total > s.paid_amount

UNION ALL

SELECT
  cp.customer_id,
  c.name,
  'payment',
  cp.id,
  -cp.amount AS amount,
  cp.date,
  NULL AS running_balance
FROM customer_payments cp
JOIN customers c ON c.id = cp.customer_id

ORDER BY customer_id, date;
```

The running_balance is computed application-side for now (SQLite window functions are limited).

## Consequences
- **Transparency**: Every change to customer balance is traceable
- **Audit**: Can verify outstanding by summing ledger entries
- **Reports**: Can show "customer had ₹5000 outstanding on March 15" by summing up to that date
- **Performance**: View is computed on-demand, not stored. For 50-200 customers this is fine.

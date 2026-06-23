# ADR-002: Vendor detail view structure

## Status

Accepted

## Context

Vendors currently have no detail view — only a list with search. Users need to see purchase history, payment history, and outstanding balance in one place when clicking a vendor.

The existing `CustomerDetail` component provides a reference pattern: header (name, phone, flagged), stats grid (balances, totals), transaction history (KhataRecord), and action buttons.

## Decision

Create `VendorDetail.tsx` with this structure:

```
┌─────────────────────────────────────────────────┐
│ Header: Name, Contact Person, Phone             │
│ Action buttons: Edit, Record Payment, Deactivate│
├─────────────────────────────────────────────────┤
│ Stats Grid (3 columns):                         │
│   Opening Balance │ Total Purchases │ Total Paid│
│   Outstanding (highlighted)                     │
├─────────────────────────────────────────────────┤
│ Purchase History (table):                       │
│   Date │ Items │ Total Amount                   │
├─────────────────────────────────────────────────┤
│ Payment History (table):                        │
│   Date │ Amount │ Mode │ Notes                  │
├─────────────────────────────────────────────────┤
│ Notes (if any)                                  │
└─────────────────────────────────────────────────┘
```

**Rationale**:
- Mirrors `CustomerDetail` pattern for consistency
- Purchase history replaces KhataRecord (vendors don't need traditional khata)
- Stats grid shows vendor-specific metrics (purchases instead of sales)
- Action buttons provide quick access to common operations

## Consequences

- New file: `src/domain/vendors/VendorDetail.tsx`
- Reuses `Money` component for currency display
- Reuses existing `vendorOutstanding` API for stats
- Needs new API for purchase history list (or reuse existing purchase list with vendor filter)
- Needs new API for payment history list (or reuse existing payment list with vendor filter)

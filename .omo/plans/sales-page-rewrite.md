# Sales Page Rewrite — Work Plan

## Overview
Rewrite the sales page to fix broken features, add split payments, normalize payment storage, and improve item/customer search UX.

## Architecture Decisions
- ADR-006: Normalize sale payments (JSON → table)
- ADR-007: Customer ledger view
- ADR-008: Implicit credit (credit as consequence, not mode)
- ADR-009: Unified item entry (smart search)
- ADR-010: Split payment UI

---

## Phase 1: Backend (Database + Commands)

### 1.1 Database Migration (schema_v4.sql)
**Goal**: Normalize payments, add search capability

- [ ] Create `sale_payments` table (id, sale_id, mode, amount, created_at)
- [ ] Add CHECK constraint: mode IN ('cash','upi','card','cheque','bank_transfer')
- [ ] Migrate existing `payment_modes_json` data to `sale_payments` rows
- [ ] Drop `payment_modes_json` column from `sales` table
- [ ] Update CHECK constraints on `customer_payments` and `vendor_payments` to match

**Files**:
- Create: `src-tauri/src/db/schema_v4.sql`
- Modify: `src-tauri/src/db/migrations.rs` (add SCHEMA_V4)

### 1.2 Sale Creation Backend
**Goal**: Write to `sale_payments` instead of JSON blob

- [ ] Update `create_final_bill()` in `sales.rs`:
  - Insert into `sale_payments` for each payment split
  - Remove JSON serialization of payment modes
  - Keep `paid_amount` as denormalized sum
- [ ] Update `get_sale()` to join with `sale_payments` and return splits
- [ ] Update `list_sales()` / recent sales to include payment info
- [ ] Update quotation conversion to carry forward payment info

**Files**:
- Modify: `src-tauri/src/commands/sales.rs`

### 1.3 Item Search Backend
**Goal**: Add fuzzy item search by name

- [ ] Add `search_items(query)` command:
  - LIKE '%query%' on name, sku_code, barcode
  - Return id, name, sku_code, barcode, retail_price_paise, stock_qty
  - Limit 20 results
  - Only active items
- [ ] Register command in `lib.rs`

**Files**:
- Modify: `src-tauri/src/commands/items.rs`
- Modify: `src-tauri/src/lib.rs`

### 1.4 Customer Ledger View
**Goal**: Auditable running balance per customer

- [ ] Create `customer_ledger` SQL view:
  - UNION of opening_balance, sales (credit portion), customer_payments
  - Ordered by customer_id, date
- [ ] Add `getCustomerLedger(customerId)` Rust command
- [ ] Add TypeScript API function

**Files**:
- Modify: `src-tauri/src/db/schema_v4.sql` (add view)
- Modify: `src-tauri/src/commands/customers.rs`
- Modify: `src/domain/customers/api.ts`

---

## Phase 2: Frontend Types + API

### 2.1 TypeScript Types
**Goal**: Align types with new architecture

- [ ] Update `PaymentSplit` type: remove 'credit', add 'bank_transfer'
- [ ] Add `SalePayment` interface (id, sale_id, mode, amount, created_at)
- [ ] Update `Sale` interface: `payment_modes: SalePayment[]` (from join, not JSON)
- [ ] Update `NewSale` interface: `payment_splits: Array<{mode, amount}>` (renamed for clarity)
- [ ] Add `ItemSearchResult` interface
- [ ] Add `CustomerLedgerEntry` interface

**Files**:
- Modify: `src/pos/types.ts`
- Modify: 'src/domain/types.ts`

### 2.2 TypeScript API Functions
**Goal**: Wire up new backend commands

- [ ] Add `searchItems(query)` in `src/pos/api.ts`
- [ ] Add `getCustomerLedger(customerId)` in `src/domain/customers/api.ts`
- [ ] Update `createSale()` to send `payment_splits` array
- [ ] Update `getSale()` to receive `payment_modes: SalePayment[]`

**Files**:
- Modify: `src/pos/api.ts`
- Modify: `src/domain/customers/api.ts`

---

## Phase 3: Sales Page UI Rewrite

### 3.1 Customer Selector (Type-Ahead Autocomplete)
**Goal**: Walk-in default, search to attach customer

- [ ] Replace current split (input + select) with single autocomplete input
- [ ] Default: "Walk-in customer" (no customer selected)
- [ ] Typing triggers client-side filter of pre-loaded customers
- [ ] Dropdown shows: name, phone, outstanding
- [ ] Arrow keys + Enter or click to select
- [ ] Clear button to deselect (back to walk-in)
- [ ] Remove "Opening" column from display (per grilling decision)

**Component**: New `CustomerAutocomplete.tsx` in `src/pos/sales/`

### 3.2 Item Entry (Smart Search)
**Goal**: Unified barcode + name search

- [ ] Single input with dual behavior:
  - Barcode pattern → `lookupItem(code)` (existing)
  - Text → `searchItems(query)` (new)
- [ ] Dropdown shows matches with: name, SKU, price, stock
- [ ] Scanner flow: exact match → instant add (no dropdown)
- [ ] Manual flow: type → dropdown → pick → add
- [ ] Error handling: "No item found" with suggestion to check inventory

**Component**: New `ItemSearchInput.tsx` in `src/pos/sales/`

### 3.3 Split Payment UI
**Goal**: Multiple payment modes per sale

- [ ] Payment section shows:
  - Total (from cart)
  - Payment rows (mode selector + amount input + remove button)
  - "+ Add payment" button
  - Paid total (auto-sum)
  - Credit remaining (auto-calculated, grayed)
- [ ] Default: one row with Cash mode
- [ ] Add/remove rows dynamically
- [ ] Mode options: Cash, UPI, Card, Cheque, Bank Transfer (no Credit)
- [ ] Amount validation: can't exceed total, can't be negative
- [ ] Walk-in constraint: if no customer, paid must equal total (disable Save if not)

**Component**: New `SplitPayment.tsx` in `src/pos/sales/`

### 3.4 Keyboard Shortcuts
**Goal**: Fix F2/F4/F9/Esc

- [ ] F2: Focus item search input
- [ ] F4: Toggle between Final bill and Quotation mode
- [ ] F9: Save bill (or convert quotation)
- [ ] Esc: Clear cart and reset form
- [ ] Ensure shortcuts work when inputs are focused (use global event listener)
- [ ] Add visual shortcut hints in the UI

**Implementation**: Global `useEffect` with `keydown` handler in `SalesPage.tsx`

### 3.5 History Isolation
**Goal**: Show only relevant history per mode

- [ ] Final bill mode: show "Recent bills" table only
- [ ] Quotation mode: show "Open quotations" table only
- [ ] Remove mixed history display
- [ ] Each table shows: number, date, customer, total, actions

**Implementation**: Conditional rendering in `SalesPage.tsx`

### 3.6 Bill Panel Cleanup
**Goal**: Clean, accurate bill display

- [ ] Subtotal (sum of line totals before discount)
- [ ] Bill discount input
- [ ] Total (subtotal - discount)
- [ ] Payment section (split payments, see 3.3)
- [ ] Credit display (auto-calculated, not editable)
- [ ] Remove "Proceed past flagged-customer warning" checkbox (move to modal)

**Implementation**: Refactor existing bill panel in `SalesPage.tsx`

---

## Phase 4: Integration + Polish

### 4.1 Quotation Flow
**Goal**: Fix quotation → bill conversion

- [ ] Quotation mode: no payment section (paid = 0)
- [ ] Save quotation: stores items, no stock movement
- [ ] Convert to bill: opens with items pre-loaded, payment section active
- [ ] Ensure shortcuts work in both modes

**Implementation**: Update `convert()` function in `SalesPage.tsx`

### 4.2 Customer Ledger Integration
**Goal**: Show ledger in customer detail

- [ ] Add "View Ledger" action to customer list
- [ ] Show ledger entries in customer detail modal
- [ ] Display running balance per entry

**Implementation**: Update `CustomerDetail.tsx`

### 4.3 Error Handling + UX Polish
**Goal**: Smooth user experience

- [ ] Loading states for search results
- [ ] Empty states for no matches
- [ ] Success feedback after save
- [ ] Error messages for validation failures
- [ ] Disable Save button when form is invalid
- [ ] Auto-focus appropriate input on mode change

---

## Phase 5: Testing + Verification

### 5.1 Backend Verification
- [ ] `cargo check` passes
- [ ] Migration runs cleanly on existing DB
- [ ] Sale creation writes to `sale_payments` table
- [ ] Item search returns correct results
- [ ] Customer ledger computes correctly

### 5.2 Frontend Verification
- [ ] `tsc -b` passes
- [ ] LSP shows 0 errors
- [ ] Customer autocomplete works (search, select, clear)
- [ ] Item search works (barcode + name)
- [ ] Split payments work (add, remove, validate)
- [ ] Keyboard shortcuts work (F2, F4, F9, Esc)
- [ ] History isolation works (bill vs quotation)
- [ ] Walk-in constraint enforced

### 5.3 Integration Testing
- [ ] Create sale with split payment → verify `sale_payments` rows
- [ ] Create credit sale → verify outstanding increases
- [ ] Record customer payment → verify outstanding decreases
- [ ] Convert quotation to bill → verify items carry forward
- [ ] Search items by name → verify results appear

---

## File Summary

### New Files
- `src-tauri/src/db/schema_v4.sql` — sale_payments table, customer_ledger view
- `src/pos/sales/CustomerAutocomplete.tsx` — type-ahead customer selector
- `src/pos/sales/ItemSearchInput.tsx` — smart item entry
- `src/pos/sales/SplitPayment.tsx` — multi-mode payment UI

### Modified Files
- `src-tauri/src/db/migrations.rs` — add SCHEMA_V4
- `src-tauri/src/commands/sales.rs` — sale_payments writes, remove JSON
- `src-tauri/src/commands/items.rs` — add search_items command
- `src-tauri/src/commands/customers.rs` — add ledger command
- `src-tauri/src/lib.rs` — register new commands
- `src/pos/types.ts` — update types
- `src/domain/types.ts` — add new interfaces
- `src/pos/api.ts` — add searchItems
- `src/domain/customers/api.ts` — add getCustomerLedger
- `src/pos/sales/SalesPage.tsx` — full rewrite
- `src/domain/customers/CustomerDetail.tsx` — add ledger view

---

## Dependencies

```
Phase 1 (Backend) → Phase 2 (Types/API) → Phase 3 (UI) → Phase 4 (Integration) → Phase 5 (Testing)
```

Phase 1 must complete before Phase 2 (types depend on DB schema).
Phase 2 must complete before Phase 3 (UI depends on types/API).
Phase 3 and 4 can be partially parallelized.
Phase 5 is final verification.

---

## Risk Assessment

| Risk                                      | Mitigation                                                    |
| ----------------------------------------- | ------------------------------------------------------------- |
| Migration breaks existing sales data      | Test migration on copy of production DB first                 |
| Split payment UI too complex              | Start with simple version, iterate                            |
| Item search performance with many items   | Limit to 20 results, use indexed columns                      |
| Shortcuts conflict with browser shortcuts | Use specific combinations (F-keys, Ctrl+key)                  |
| Quotation conversion loses payment info   | Store payment intent in quotation, apply on conversion        |

---

## Success Criteria

1. ✅ Customer autocomplete works (walk-in default, search to attach)
2. ✅ Item search works (barcode + name, dropdown results)
3. ✅ Split payments work (multiple modes, auto-calculate credit)
4. ✅ Keyboard shortcuts work (F2, F4, F9, Esc)
5. ✅ History isolated (bill mode → bills, quotation mode → quotations)
6. ✅ Payments normalized (sale_payments table, no JSON blob)
7. ✅ Customer ledger auditable (running balance, traceable entries)
8. ✅ Credit is implicit (total - paid, not a payment mode)
9. ✅ Backend compiles (cargo check passes)
10. ✅ Frontend compiles (tsc -b passes, LSP clean)

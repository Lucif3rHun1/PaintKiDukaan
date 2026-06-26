# UI Polish & Bugfix Plan — Synthesized from 5 Hostile Auditors

## Bugs (CRITICAL — fix first)

### B1: SaleDetailPage paise-as-rupees
**File**: `src/pos/sales/SaleDetailPage.tsx` line ~243
**Bug**: `sale.total.toLocaleString("en-IN")` displays paise as rupees (₹1,50,000 instead of ₹1,500.00)
**Fix**: Use `<Money paise={sale.total} />` or `formatRupeesFromPaise(sale.total)`

### B2: Type collisions — CustomerOutstanding/CustomerLedger/VendorOutstanding
**Files**: `src/domain/types.ts` + `src/pos/types.ts`
**Bug**: Both files define these types with incompatible shapes. Domain has detailed fields (opening_balance_paise, total_sales, etc.), POS has simpler (name, phone, outstanding).
**Fix**: Domain types for detail views, POS types for list/report views. Rename POS variants if needed.

### B3: Donut zero/negative color mismatch
**File**: `src/shell/routes/dashboard/shared.tsx`
**Bug**: Arc uses `stroke-warning` for zero, legend uses `bg-destructive` for zero. Zero and Negative share same legend color.
**Fix**: Zero arc = `stroke-warning`, legend = `bg-warning`. Negative arc = `stroke-destructive`, legend = `bg-destructive`.

### B4: KhataRecord payments shown as red
**File**: Customer KhataRecord component
**Bug**: Payments rendered as negative Money → red. Payment reduces debt, should be green/positive.
**Fix**: Render payment amounts as positive Money (not negative).

### B5: ItemList total value wrong
**File**: `src/domain/items/ItemList.tsx`
**Bug**: Sums unit retail prices (retail_price_paise) instead of current_qty × retail_price_paise.
**Fix**: Sum `(item.current_qty ?? 0) * item.retail_price_paise`.

### B6: Null safety — SaleDetailPage items
**File**: `src/pos/sales/SaleDetailPage.tsx`
**Bug**: `sale.items.map()` with no null guard — crashes if items is null.
**Fix**: `(sale.items ?? []).map()` or default empty array.

## Theme & Color (HIGH)

### C1: WCAG contrast failures
**Files**: `src/index.css` (CSS vars)
**Bug**: text-success (2.30:1), text-warning (2.13:1), text-info (2.86:1) all fail WCAG AA.
**Fix**: Darken semantic colors: success to ~40% lightness, warning to ~45%, info to ~40%.

### C2: Hardcoded light-only colors
**Files**: `src/shell/routes/dashboard/BusinessTab.tsx`, `InventoryTab.tsx`
**Bug**: `border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50` — light-only styling island.
**Fix**: Replace with theme tokens: `border-border bg-muted`.

### C3: Badge inconsistency across pages
**Files**: CustomerList.tsx, SalesPage.tsx, CustomerAutocomplete.tsx
**Bug**: Flagged = danger in CustomerList, warning in SalesPage. Inactive = muted in CustomerList, danger in SalesPage.
**Fix**: Standardize: Inactive = muted everywhere, Flagged = warning everywhere.

### C4: Dark mode surface separation
**File**: `src/index.css`
**Bug**: `--card` ≈ `--background` in dark mode, cards rely on faint ring/shadow.
**Fix**: Bump `--card` lightness 2-3 points above `--background` in dark mode.

### C5: Reports money columns not right-aligned
**File**: `src/pos/salesReport/ReportsPage.tsx`
**Bug**: Sales money columns (Discount, Total) not right-aligned.
**Fix**: Add `className="text-right tabular-nums"` to money cells.

## UI Hierarchy (MEDIUM)

### D1: Card padding inconsistency
**Files**: `src/components/ui/Card.tsx`
**Bug**: Card adds p-5, Card.Body adds p-4 → double padding.
**Fix**: Remove p-5 from Card root, keep only in Card.Body/Card.Header.

### D2: Page hierarchy too weak
**Files**: Dashboard.tsx, ReportsPage.tsx, ItemList.tsx
**Bug**: No real page headers. Everything competes at same visual weight.
**Fix**: Add page-level headings with distinct size/weight.

### D3: Spacing rhythm
**Files**: Multiple pages
**Bug**: Everything space-y-3, gap-3, px-3 py-2. Visually breathless.
**Fix**: Normalize to space-y-6 for sections, gap-4 for grids, px-4 py-3 for cards.

### D4: Dashboard tab hierarchy
**File**: `src/shell/routes/Dashboard.tsx`
**Bug**: Tab bar text-sm + 2px underline — too weak for primary navigation.
**Fix**: text-base + thicker indicator, or segmented control style.

### E1: SalesPage date toISOString() off-by-one
**File**: `src/pos/sales/SalesPage.tsx`
**Bug**: Date defaults use toISOString() which can shift by timezone.
**Fix**: Use todayLocalYyyymmdd() consistent with rest of app.

## Deferred (feature additions — separate planning)
- GST/Tax infrastructure (Agent 2 critical #1, #6)
- Credit limit enforcement at POS (Agent 2 critical #3)
- Hold/resume bills (Agent 2 high)
- Batch/expiry tracking (Agent 2 high)
- P&L / Cash flow reports (Agent 2 high)
- Global search (Agent 2 medium)
- Accessible charts (Agent 3 #6)
- DataTable built-in sort/pagination (Agent 3 #6)

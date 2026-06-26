# Bugfix: Hyperplan Critical Findings

## Context
Hyperplan audit identified 10 critical bugs and consistency issues across the app. All fixes are small, surgical edits — no architecture changes needed.

---

## Fix 1: B1+B6 — SaleDetailPage paise formatting + null safety
**File**: `src/pos/sales/SaleDetailPage.tsx`

`formatRupeesFromPaise` is already imported (line 5).

### Edit A (line 238):
```tsx
// BEFORE:
{sale.items.length === 0 ? (
// AFTER:
{(sale.items ?? []).length === 0 ? (
```

### Edit B (line 243):
```tsx
// BEFORE:
(Header totals ₹{sale.total.toLocaleString("en-IN")} were saved, but the line
// AFTER:
(Header totals {formatRupeesFromPaise(sale.total)} were saved, but the line
```

### Edit C (line 250):
```tsx
// BEFORE:
{sale.items.map((line, idx) => {
// AFTER:
{(sale.items ?? []).map((line, idx) => {
```

---

## Fix 2: B3 — Donut legend Zero color mismatch
**File**: `src/shell/routes/dashboard/shared.tsx`

### Edit (line 247):
```tsx
// BEFORE:
<LegendDot color="bg-destructive" label="Zero" count={zero} />
// AFTER:
<LegendDot color="bg-warning" label="Zero" count={zero} />
```
Arc uses `stroke-warning` for zero; legend must match.

---

## Fix 3: D1 — Card default padding double-up
**File**: `src/components/ui/Card.tsx`

### Edit (line 16):
```tsx
// BEFORE:
bare ? "" : "p-5",
// AFTER:
bare ? "" : "",
```
Card.Body already has `p-4`. Pages that need padding pass their own via `className`.

---

## Fix 4: B4 — KhataRecord payments shown as RED
**File**: `src/domain/customers/KhataRecord.tsx`

### Edit A (~line 45):
```tsx
// BEFORE:
amount: -data.total_payments,
// AFTER:
amount: data.total_payments,
```

### Edit B (~line 71):
```tsx
// BEFORE:
<Money paise={r.amount} />
// AFTER:
<Money paise={r.amount} tone="success" />
```

---

## Fix 5: B5 — ItemList total value sums unit prices instead of qty×price
**File**: `src/domain/items/ItemList.tsx`

### Edit (~line 209):
```tsx
// BEFORE:
totalRetail += item.retail_price_paise;
// AFTER:
totalRetail += (item.current_qty ?? 0) * item.retail_price_paise;
```

---

## Fix 6: C3 — Badge inconsistency for Flagged customers
**File**: `src/domain/customers/CustomerList.tsx`

### Edit (~line 77):
```tsx
// BEFORE:
variant="danger"
// AFTER:
variant="warning"
```
Standardizes with CustomerAutocomplete and ReturnPage.

---

## Fix 7: C1+C4 — WCAG contrast + dark mode surface separation
**File**: `src/index.css`

### Edit A — Light mode `:root` section:
```css
/* BEFORE: */
--success: 142 71% 45%;
--warning: 38 92% 50%;
--info: 199 89% 48%;

/* AFTER: */
--success: 142 71% 38%;
--warning: 38 82% 38%;
--info: 199 80% 40%;
```

### Edit B — Dark mode `[data-theme="dark"]` section:
```css
/* BEFORE: */
--card: 222.2 84% 4.9%;
/* AFTER: */
--card: 222.2 84% 8%;
```

---

## Fix 8: C2 — Hardcoded slate colors in BusinessTab
**File**: `src/shell/routes/dashboard/BusinessTab.tsx`

Find the date filter div with:
```
border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50
```
Replace with:
```
border-border bg-muted
```

---

## Fix 9: E1 — Date off-by-one in SalesListPage
**File**: `src/pos/sales/SalesListPage.tsx`

Find (~line 47):
```tsx
new Date().toISOString().slice(0, 10)
```
Replace with:
```tsx
todayLocalYyyymmdd()
```
Ensure `todayLocalYyyymmdd` is imported from `../../lib/date`.

---

## Verification
After all edits:
```bash
pnpm exec tsc -b
```
Must pass clean.

## Risk
All changes are minimal and surgical. No API changes, no new dependencies, no architecture changes.

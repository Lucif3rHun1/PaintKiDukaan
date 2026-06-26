# PaintKiDukaan — Deep Audit Report

**Date:** 2026-06-23  
**Scope:** All pages, cross-platform (macOS dev → Windows target), UI/UX polish, wiring, edge cases  
**Files reviewed:** ~60 frontend components, 5 Rust command modules, CSS tokens, IPC layers

---

## 1. Runtime Issues

### P0 — Broken in Dark Mode

| # | File | Lines | Bug | Fix Sketch |
|---|------|-------|-----|------------|
| 1 | `src/pos/dayClose/DayClosePage.tsx` | 77–80, 84, 98, 101, 109, 118, 127, 136, 146, 155, 159–160, 163, 174, 211, 214, 226–232 | **Entire page uses hardcoded `bg-amber-50`, `bg-emerald-50`, `border-slate-200`, `bg-white`, `text-slate-500`, `text-emerald-600`, `text-rose-600`, `bg-sky-600`, `bg-emerald-600`, etc.** These are raw Tailwind colors that ignore the `[data-theme="dark"]` token system. In dark mode: white backgrounds on dark page, unreadable text. | Replace all raw colors with semantic tokens: `bg-card`, `border-border`, `text-muted-foreground`, `text-success`, `text-destructive`, `bg-primary`, `bg-success`, etc. |
| 2 | `src/shell/backup/BackupPanel.tsx` | 48–49, 56, 68, 78, 85, 92, 94, 100, 110, 117 | **Uses `text-slate-600`, `border-slate-200`, `bg-slate-50`, `text-slate-500`, `border-slate-300`, `bg-blue-600`, `border-red-200`, `bg-red-50`, `text-red-700`.** All hardcoded light-mode colors. In dark mode: white cards on dark background, invisible text. | Migrate to `text-muted-foreground`, `border-border`, `bg-muted`, `bg-primary`, `bg-destructive/10`, `text-destructive`, etc. |
| 3 | `src/domain/customers/CustomerDetail.tsx` | 28, 34, 44, 51, 60, 90, 92, 99, 100, 113–115 | **Uses `border-slate-200`, `bg-white`, `bg-red-100`, `text-red-700`, `border-slate-300`, `bg-sky-600`, `bg-sky-700`, `bg-red-50`, `bg-slate-50`, `text-slate-800`, `text-slate-500`, `text-slate-700`.** Same dark-mode breakage. | Migrate to semantic tokens. |
| 4 | `src/domain/customers/KhataRecord.tsx` | 55, 57, 62, 72, 81 | **Uses `text-slate-700`, `bg-red-50`, `text-red-700`, `border-slate-200`, `text-slate-500`, `border-slate-100`.** | Migrate to semantic tokens. |

### P1 — Functional Issues

| # | File | Lines | Bug | Fix Sketch |
|---|------|-------|-----|------------|
| 5 | `src/pos/dayClose/DayClosePage.tsx` | 160, 164, 228–232 | **Inline `₹{value / 100}` instead of `<Money paise={value} />`.** Bypasses `formatRupeesFromPaise`, which uses `toLocaleString("en-IN")` for proper comma grouping. Raw division produces `₹1234.5` instead of `₹1,234.50`. Also no `tabular-nums` class — numbers won't align in the table. | Replace all `₹{x / 100}` with `<Money paise={x} />`. |
| 6 | `src/pos/purchases/InwardPage.tsx` | 367 | **Inline `₹${(outstanding / 100).toFixed(0)} due` in vendor dropdown.** Bypasses money formatting. Missing comma grouping for amounts ≥1,000. | Use `formatRupeesFromPaise(outstanding)` from `lib/money.ts`. |
| 7 | `src/pos/dayClose/DayClosePage.tsx` | 1 | **`@ts-nocheck` directive at top of file.** Entire file bypasses TypeScript type checking. Hides potential runtime errors (undefined access, type mismatches). | Remove `@ts-nocheck`, fix resulting type errors. |
| 8 | `src/pos/salesReport/SalesReportPage.tsx` | 1 | **`@ts-nocheck` directive at top of file.** Same issue. | Remove `@ts-nocheck`, fix resulting type errors. |
| 9 | `src/index.css` | 96–97 | **`.input` class hardcodes `border-slate-300 bg-white text-slate-900` and focus colors `border-indigo-500 ring-indigo-500/20`.** These are raw colors, not semantic tokens. Every `<input className="input">` in the app has a white background in dark mode. This is the single most pervasive dark-mode bug — affects Sales, Inward, Returns, Items, Customers, Vendors, Settings forms. | Change to `border-border bg-card text-foreground focus:border-primary focus:ring-primary/20`. Add `[data-theme="dark"]` override or use semantic tokens directly. |

### P2 — Minor

| # | File | Lines | Bug | Fix Sketch |
|---|------|-------|-----|------------|
| 10 | `src/pos/sales/SalesListPage.tsx` | 45 | **Loading state is plain text `"Loading…"` instead of Skeleton component.** Inconsistent with other pages that use `<Skeleton>`. | Replace with `<Skeleton>` rows. |
| 11 | `src/pos/sales/SalesListPage.tsx` | 47 | **Empty state is plain `<p>` text instead of `<EmptyState>` component.** Inconsistent with Dashboard, Items, Customers, Vendors. | Use `<EmptyState>` component. |
| 12 | `src/shell/backup/BackupPanel.tsx` | 50 | **Empty targets state is plain `<li>none</li>` instead of `<EmptyState>`.** | Use `<EmptyState>`. |

---

## 2. Cross-Platform Risks

### macOS Dev → Windows Target

| # | Area | Risk | Status |
|---|------|------|--------|
| 1 | `scan.rs` — barcode scanner hook | **`rdev::listen` crashes on macOS** due to `TSMGetInputSourceProperty` off main thread. Properly guarded with `if !cfg!(target_os = "macos")` in `lib.rs:129`. | ✅ Handled |
| 2 | `prevent_sleep.rs` | **`powercfg` is Windows-only.** Properly gated with `#[cfg(target_os = "windows")]` / `#[cfg(not(target_os = "windows"))]` no-op fallback. | ✅ Handled |
| 3 | `discover_printers.rs` | **`Get-Printer` PowerShell cmdlet is Windows-only.** Properly gated with `#[cfg(not(target_os = "windows"))]` returning empty vec. | ✅ Handled |
| 4 | `printReceipt.ts` | **`isWindows()` detection uses `navigator.platform`.** Works but `navigator.platform` is deprecated. Prefer `navigator.userAgentData?.platform` with fallback. | ⚠️ Low risk |
| 5 | `lib.rs:60–67` | **Log directory uses `dirs::data_local_dir()`** which maps correctly: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS. | ✅ Handled |
| 6 | `scan.rs:79` | **`#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]`** — duplicate `rename_all` attribute. Harmless but indicates copy-paste. Same on line 91 and `prevent_sleep.rs:30`. | ⚠️ Cosmetic |
| 7 | `src/shell/routes/settings/HardwareSettings.tsx` | **"Discover printers" silently returns empty on macOS dev.** No user-facing message explaining why. The Scanner tab correctly notes "rdev hook is disabled on macOS" but Printers tab has no such note. | ⚠️ UX gap |
| 8 | Line endings | **No `.gitattributes` found.** If dev on macOS (LF) and build on Windows (CRLF), Rust source and TS files could get mixed line endings. Tauri/Vite handle this, but git diffs may show noise. | ⚠️ Low risk |

---

## 3. Formatting Issues

### Date Formats

| Page | Format | Consistency |
|------|--------|-------------|
| Dashboard (recent bills) | `toLocaleDateString("en-IN", { day: "2-digit", month: "short" })` → "23 Jun" | ✅ Locale-aware |
| SalesListPage | Raw `{s.date}` → "2026-06-23" (ISO) | ❌ Not formatted |
| InwardPage (recent) | Raw `{p.date}` → "2026-06-23" (ISO) | ❌ Not formatted |
| DayClosePage | Raw `{d.date}` → "2026-06-23" (ISO) | ❌ Not formatted |
| SalesReportPage | Raw `{r.date}` → "2026-06-23" (ISO) | ❌ Not formatted |
| ReturnPage (invoice info) | Raw `{originalSale.date}` | ❌ Not formatted |

**Verdict:** Only Dashboard formats dates. All other pages show raw ISO `YYYY-MM-DD`. Pick one standard (ISO `dd-mm-yyyy` per AGENTS.md, or locale-aware) and apply consistently.

### Currency Display

| Component | Method | Issue |
|-----------|--------|-------|
| `<Money>` | `formatRupeesFromPaise` → `₹1,234.50` | ✅ Correct, uses `tabular-nums` |
| `DayClosePage` | Inline `₹{x / 100}` → `₹1234.5` | ❌ No comma grouping, no decimals |
| `InwardPage` vendor dropdown | Inline `₹${(x/100).toFixed(0)}` | ❌ No comma grouping |
| `CustomerList` (credit column) | `formatINR(c.credit_limit)` | ⚠️ `credit_limit` is `number \| null` — not labeled `_paise`. If it's rupees, display is 100x too large. If paise, correct. |

### Number Alignment

- `<Money>` component uses `tabular-nums` — ✅ good for table columns
- DayClosePage table: raw `₹{x/100}` without `tabular-nums` — ❌ numbers jump around
- SalesListPage `<Money>` in table — ✅ aligned

---

## 4. UI/UX Polish Opportunities

### 4.1 `.input` Class (Global Impact)

**File:** `src/index.css:96–97`

```css
/* BEFORE */
.input {
  @apply h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900
    outline-none transition-colors placeholder:text-slate-400
    focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20
    disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400;
}

/* AFTER */
.input {
  @apply h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground
    outline-none transition-colors placeholder:text-muted-foreground
    focus:border-primary focus:ring-2 focus:ring-primary/20
    disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground;
}
```

This single fix touches every form input in the app (Sales, Inward, Returns, Items, Customers, Vendors, Settings, Login).

### 4.2 Concentric Border Radii

The app uses `rounded-md` (6px) consistently on inputs, buttons, and cards. The `--radius` token is `0.5rem` (8px). Minor mismatch: CSS token says 8px, Tailwind `rounded-md` is 6px. Consider aligning to `rounded-lg` (8px) for cards/dialogs and `rounded-md` (6px) for inputs/buttons — this is already mostly done. **No action needed.**

### 4.3 Tabular Numbers for Money

- ✅ `<Money>` component applies `tabular-nums`
- ✅ Dashboard KPIs use `tabular-nums`
- ❌ DayClosePage inline currency lacks `tabular-nums`
- ❌ InwardPage vendor dropdown currency lacks `tabular-nums`

### 4.4 Font Smoothing

**File:** `src/index.css:47–48`

```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
```

✅ Already set on `:root`. Good.

### 4.5 Shadows Over Hard Borders

- ✅ `ItemSearchInput` dropdown uses `shadow-xl`
- ✅ `Card` component uses `shadow-sm` via Tailwind
- ✅ `InlineDialog` uses backdrop blur
- ❌ DayClosePage sections use `border` without shadow — flat look
- ❌ BackupPanel uses `border` without shadow

### 4.6 Hover/Focus States

- ✅ Most buttons have hover states (`hover:bg-muted`, `hover:text-foreground`)
- ✅ Table rows have `hover:bg-muted`
- ❌ DayClosePage buttons (`bg-sky-600`, `bg-emerald-600`) lack focus-visible rings
- ❌ BackupPanel "Back up now" button lacks focus-visible ring

### 4.7 Empty States

| Page | Empty State | Quality |
|------|------------|---------|
| Dashboard (recent bills) | `<EmptyState>` with icon + title + description | ✅ |
| Dashboard (low stock) | `<EmptyState>` with icon + title + description | ✅ |
| SalesPage (cart) | Inline dashed-border paragraph | ⚠️ Functional but not using `<EmptyState>` |
| SalesListPage | Plain `<p>` text | ❌ Should use `<EmptyState>` |
| InwardPage (items table) | Inline `<td>` text | ⚠️ Functional |
| ReturnPage (cart) | Inline `<td>` text | ⚠️ Functional |
| CustomerList | `<EmptyState>` with icon + title + description + CTA | ✅ |
| VendorList | `<EmptyState>` with icon + title + description + CTA | ✅ |
| ItemList | `<EmptyState>` with icon + title + description + CTA | ✅ |
| HardwareSettings (printers) | `<EmptyState>` with icon + title + description | ✅ |
| BackupPanel (targets) | Plain `<li>none</li>` | ❌ Should use `<EmptyState>` |

### 4.8 Loading States

| Page | Loading State | Quality |
|------|--------------|---------|
| Dashboard | `<Skeleton>` cards | ✅ |
| SalesPage (recent) | `<Skeleton>` rows | ✅ |
| SalesListPage | Plain text `"Loading…"` | ❌ Should use `<Skeleton>` |
| InwardPage | No explicit loading (data loads in useEffect, items populate) | ⚠️ Implicit |
| DayClosePage | Plain text `"Checking…"` | ❌ Should use `<Skeleton>` |
| CustomerList | `<Skeleton>` rows | ✅ |
| VendorList | `<Skeleton>` rows | ✅ |
| ItemList | `<Skeleton variant="card">` | ✅ |
| SalesReportPage | `<Skeleton variant="card">` | ✅ |

### 4.9 Animation Interruptibility

- ✅ Sidebar collapse/expand uses `transition-[width] duration-200` — short, interruptible
- ✅ Loading spinners use `animate-spin` — CSS animation, inherently interruptible
- ✅ No GSAP or long JS animations found
- ✅ Toast auto-dismiss uses `setTimeout` with cleanup

### 4.10 Optical Alignment

- ✅ Table headers and cells use consistent `px-3 py-2` padding
- ✅ Money component right-aligns in tables via `text-right` on `<td>`
- ⚠️ DayClosePage form labels are inline (`<label>Date <input>`), causing misaligned inputs. Should be stacked with consistent label-above-input pattern.

---

## 5. Wiring Issues

### Raw `tauriInvoke` Usage

**No components call `tauriInvoke` directly.** All component-level IPC goes through:
- `src/domain/ipc.ts` → typed wrappers (`invoke<T>`)
- `src/domain/{customers,vendors,items,locations}/api.ts` → domain-specific wrappers
- `src/pos/api.ts` → POS-specific wrappers
- `src/shell/lib/ipc.ts` → shell-specific wrappers (`ipc.*`)

The IPC architecture is clean. ✅

### `formatINR` Re-export

**File:** `src/domain/types.ts:1–2, 411–413`

```typescript
import { formatRupeesFromPaise as formatPaiseAsRupees } from "../lib/money";
export { formatRupeesFromPaise } from "../lib/money";
// ...
export function formatINR(paise: number): string {
  return formatPaiseAsRupees(paise);
}
```

`formatINR` is a thin alias for `formatRupeesFromPaise`. The re-export of `formatRupeesFromPaise` alongside `formatINR` creates two ways to do the same thing. Components should use `<Money paise={...} />` or `formatRupeesFromPaise()` directly. `formatINR` should be deprecated.

**Callers of `formatINR`:**
- `src/domain/customers/CustomerDetail.tsx` (6 calls)
- `src/domain/customers/CustomerList.tsx` (1 call)
- `src/domain/customers/KhataRecord.tsx` (1 call)

---

## 6. Edge Cases Missing

### Pages Without Empty States

| Page | Has Empty State? | Notes |
|------|-----------------|-------|
| SalesListPage | ❌ Plain `<p>` | Should use `<EmptyState>` |
| DayClosePage (recent closes) | ❌ No empty handling | Table renders with no rows, no message |
| BackupPanel (targets) | ❌ `<li>none</li>` | Should use `<EmptyState>` |

### Pages Without Error States

| Page | Has Error State? | Notes |
|------|-----------------|-------|
| DayClosePage | ❌ Errors logged to console only | No user-facing error display for failed API calls |
| InwardPage | ⚠️ Only shows `status` string | Errors from `listItems`, `listVendors`, `listLocations` are silently swallowed |
| SalesReportPage | ⚠️ Shows `status` string | But uses `String(e)` instead of `extractError(e)` |

### Pages Without Loading States

| Page | Has Loading State? | Notes |
|------|-------------------|-------|
| DayClosePage | ❌ No loading indicator | Gate check, cash sales, opening, recent all load in parallel with no spinner |
| InwardPage | ❌ No loading indicator | Items, vendors, locations load silently |
| SalesListPage | ⚠️ Plain text | Should be skeleton |

### Potential Crash on Undefined Data

| File | Line | Risk |
|------|------|------|
| `DayClosePage.tsx` | 90 | `gate.age_hours?.toFixed(1)` — safe (optional chaining). ✅ |
| `CustomerDetail.tsx` | 71 | `customer.credit_limit` passed to `formatINR()` — if `null`, `formatINR(null)` → `formatRupeesFromPaise(null)` → `null / 100` → `NaN` → `"₹NaN"`. **Crash risk if `credit_limit` is null.** |
| `InwardPage.tsx` | 308 | `vendorId != null ? vendors.find(...)?.name ?? vendorQuery : vendorQuery` — safe with optional chaining. ✅ |
| `ReturnPage.tsx` | 108 | `sale.items.map(...)` — if `sale.items` is undefined, crashes. Backend should always return items array, but no guard. |

---

## 7. Top 10 Fixes (Prioritized)

| # | Impact | File | Fix |
|---|--------|------|-----|
| **1** | 🔴 Critical | `src/index.css:96–97` | **Migrate `.input` class from raw `slate-*`/`indigo-*` to semantic tokens** (`border-border`, `bg-card`, `text-foreground`, `focus:border-primary`). Fixes dark mode for every form in the app. |
| **2** | 🔴 Critical | `src/pos/dayClose/DayClosePage.tsx` | **Migrate all raw Tailwind colors to semantic tokens** + replace inline `₹{x/100}` with `<Money>` + remove `@ts-nocheck`. |
| **3** | 🔴 Critical | `src/shell/backup/BackupPanel.tsx` | **Migrate all raw Tailwind colors to semantic tokens.** |
| **4** | 🔴 Critical | `src/domain/customers/CustomerDetail.tsx` | **Migrate all raw Tailwind colors to semantic tokens.** |
| **5** | 🟡 High | `src/domain/customers/KhataRecord.tsx` | **Migrate all raw Tailwind colors to semantic tokens.** |
| **6** | 🟡 High | `src/pos/salesReport/SalesReportPage.tsx` | **Remove `@ts-nocheck`** and fix resulting type errors. |
| **7** | 🟡 High | `src/pos/purchases/InwardPage.tsx:367` | **Replace inline `₹${(x/100).toFixed(0)}` with `formatRupeesFromPaise()`.** |
| **8** | 🟢 Medium | `src/pos/sales/SalesListPage.tsx` | **Replace plain-text loading/empty states with `<Skeleton>` and `<EmptyState>` components.** |
| **9** | 🟢 Medium | All pages showing raw dates | **Create a shared `formatDate(dateStr: string): string` utility** using `toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })` and apply to SalesListPage, InwardPage, DayClosePage, SalesReportPage, ReturnPage. |
| **10** | 🟢 Medium | `src/domain/customers/CustomerDetail.tsx:71` | **Guard `formatINR(customer.credit_limit)` against null** — currently produces `"₹NaN"` when `credit_limit` is null. |

---

## Appendix: Files Audited

### POS Slice (`src/pos/`)
- `sales/SalesPage.tsx` — ✅ Clean, uses semantic tokens
- `sales/SalesListPage.tsx` — ⚠️ Plain loading/empty states
- `sales/ReturnPage.tsx` — ✅ Clean
- `sales/ItemSearchInput.tsx` — ✅ Excellent UX (combobox, stock badges, scan support)
- `sales/SplitPayment.tsx` — Not read (referenced, low risk)
- `sales/printReceipt.ts` — ✅ Platform-aware routing
- `purchases/InwardPage.tsx` — ⚠️ Inline currency formatting
- `dayClose/DayClosePage.tsx` — 🔴 Hardcoded colors + inline currency + @ts-nocheck
- `salesReport/SalesReportPage.tsx` — ⚠️ @ts-nocheck
- `api.ts` — ✅ Clean IPC layer with isTauri guards
- `types.ts` — ✅ Comprehensive type definitions

### Shell Slice (`src/shell/`)
- `AppShell.tsx` — ✅ Clean sidebar, proper semantic tokens
- `routes/Dashboard.tsx` — ✅ Excellent (loading, empty, error states, skeleton)
- `routes/Settings.tsx` — ✅ Clean routing, proper sub-page navigation
- `routes/settings/CatalogSettings.tsx` — ✅ Clean
- `routes/settings/HardwareSettings.tsx` — ✅ Clean
- `routes/settings/SystemSettings.tsx` — ✅ Clean
- `routes/settings/ThemeSettings.tsx` — ✅ Clean
- `routes/settings/ShopSettings.tsx` — Not read (referenced, low risk)
- `routes/settings/TeamSettings.tsx` — Not read (referenced, low risk)
- `backup/BackupPanel.tsx` — 🔴 Hardcoded colors
- `lib/ipc.ts` — ✅ Clean typed wrappers

### Domain Slice (`src/domain/`)
- `customers/CustomerList.tsx` — ✅ Clean
- `customers/CustomerDetail.tsx` — 🔴 Hardcoded colors
- `customers/KhataRecord.tsx` — 🔴 Hardcoded colors
- `customers/api.ts` — ✅ Clean
- `vendors/VendorList.tsx` — ✅ Clean
- `vendors/VendorDetail.tsx` — ✅ Uses semantic tokens
- `vendors/api.ts` — ✅ Clean
- `items/ItemList.tsx` — ✅ Excellent (pagination, sorting, metrics, bulk actions)
- `items/api.ts` — Not read (referenced, low risk)
- `types.ts` — ⚠️ `formatINR` alias, `credit_limit` type ambiguity
- `ipc.ts` — ✅ Clean typed wrapper with correlation IDs

### UI Components (`src/components/ui/`)
- `Money.tsx` — ✅ Uses `tabular-nums`, proper formatting
- `EmptyState.tsx` — ✅ Clean
- `Skeleton.tsx` — Not read (referenced, used correctly)
- `Button.tsx` — Not read (referenced, used correctly)
- `Card.tsx` — Not read (referenced, used correctly)

### Security (`src/lib/security/`)
- `tauri.ts` — ✅ Clean IPC bridge with correlation IDs
- `state.ts` — Not read (referenced, Zustand store)
- `pin.ts` — Not read (referenced, Zod schemas)

### Rust Backend (`src-tauri/src/`)
- `lib.rs` — ✅ Proper platform guards, command registration
- `scan.rs` — ✅ Platform guard for macOS, proper detection logic
- `hardening/prevent_sleep.rs` — ✅ Platform guard
- `commands/discover_printers.rs` — ✅ Platform guard

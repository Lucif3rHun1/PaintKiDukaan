# PaintKiDukaan — Updated Integrated Master Plan

**Date:** 2026-06-21  
**Scope:** Planning-only audit of existing `.omo/plans/*.md` against the current Tauri 2 + React codebase, plus integration of the new requirements: Error Boundaries, `boneyard-js` skeleton loading, `DESIGN.md`, and improved frontend data-fetching conventions.

---

## 1. Current codebase snapshot

### Confirmed product/runtime baseline

- Current app is **Tauri 2 desktop**, not the older Next.js/Postgres concept.
- Frontend entry: `src/main.tsx` renders `<App />` inside `React.StrictMode`.
- Live shell: `src/App.tsx` imports and renders `src/shell/AppShell.tsx`, direct route components, and modal flows.
- Routing is custom hash routing via `readTab()` in `src/App.tsx`; TanStack Router is installed but unused.
- TanStack Query is installed but currently unused: no `QueryClient`, `QueryClientProvider`, `useQuery`, or `useMutation` references were found in `src/`.
- `boneyard-js` and `react-error-boundary` are present in `package.json`; no current source usage was found.
- No `ErrorBoundary` component and no `Suspense` usage found.
- `PosLayout.tsx` is not imported by the live root; `src/App.tsx` renders `SalesPage`, `InwardPage`, `SalesReportPage`, etc. directly.
- `src/shell/routes/App.tsx` exists as a separate shell route root and is not imported by `src/App.tsx`.

### Implemented frontend primitives

Existing `src/components/ui/` primitives:

- `ActionMenu.tsx`
- `Alert.tsx`
- `Badge.tsx`
- `Button.tsx`
- `Card.tsx`
- `EmptyState.tsx`
- `HelpHint.tsx`
- `InlineDialog.tsx`
- `Money.tsx`
- `MoneyInput.tsx` — includes `tone?: "light" | "dark"`; already used by dark inward/item surfaces.
- `Section.tsx`
- `ShortcutsHint.tsx`
- `Skeleton.tsx`
- `Toaster.tsx`
- `cn.ts`
- `index.ts` exporting the above.

Missing or not yet standardized:

- App/page error boundary primitives.
- Query-state primitives for pagination, debounced search, empty/loading/error conventions.
- A standard `PageHeader`/`Toolbar`/`Pagination` primitive.
- A unified skeleton policy based on `boneyard-js`; current `Skeleton` is a local Tailwind pulse block.
- A canonical `DESIGN.md` file for future agents.

### Current data-fetching pattern

- Most pages use ad-hoc `useEffect` + local `loading`/`error`/state.
- Examples:
  - `Dashboard` does one `Promise.all` for reports/sales/backup.
  - `ItemList` calls `listItems()` directly whenever `search`, `lowStockOnly`, or `includeInactive` changes; search is not debounced.
  - `CustomerList` and `VendorList` list entities, then run per-row outstanding calls with `Promise.all`, creating N+1 command pressure.
  - `SalesPage` and `InwardPage` use direct command wrappers and local state.
- There are no `isLoading` consumers from TanStack Query because TanStack Query is not wired.

---

## 2. Existing plans audit

### 2.1 `paint-shop-insight-bundle.md`

**Original direction:** Greenfield web app research bundle: Next.js 14 + Postgres + Prisma + Tailwind + bwip-js, with mandatory intake questions and competitor-informed domain primitives.

**Implemented or superseded:**

- Core ideas survived in the current Tauri implementation: inventory, purchases/inward, sales, customers/vendors, barcode lifecycle, stock movements, customer ledger/khata, roles, backup/security.
- Money-in-paise rule is implemented and documented in `src/domain/types.ts` + `src/lib/money.ts`.

**Outdated/conflicting:**

- Stack is obsolete. Current repo is Tauri 2 + React 19 + Vite + SQLCipher/rusqlite, not Next.js/Postgres/Prisma.
- Electron/web decision is obsolete; Tauri desktop is active.
- Several proposed regulatory/GST primitives remain deferred in the current master plan.

**Keep as context only:** domain rationale and risk framing. Do not use its stack/file layout for implementation.

### 2.2 `paint-shop-implementation-plan.md`

**Original direction:** Executable plan based on the insight bundle, still using Next.js/Postgres/Prisma.

**Implemented or superseded:**

- Functional areas are present in the Tauri app: items, sales/POS, purchases/inward, customers, vendors, reports, backup/security.
- Error boundaries were mentioned in hardening but not implemented.

**Pending/outdated/conflicting:**

- Entire file-level layout (`app/api`, Prisma schema, NextAuth, `app/error.tsx`) conflicts with current codebase.
- Treat this as historical planning only. Do not assign implementation agents to these paths.

### 2.3 `paint-shop-master-plan.md`

**Original direction:** Current authoritative Tauri/SQLCipher master plan with milestones, schema, security, workflows, and grill decisions.

**Implemented evidence in code:**

- Tauri/React root exists: `src/main.tsx` → `src/App.tsx`.
- Security phases exist in `src/App.tsx`: loading, first-launch, locked, restore-recovery, user-management, unlocked.
- Backend command modules exist for auth, recovery, items, brands, customers, vendors, purchases, sales, day_close, reports, settings, backup, hardening, scan.
- SQL migrations exist through `schema_v11.sql`.
- Barcode/brand work exists: `commands/brands.rs`, `schema_v4.sql`, `BrandAdmin`, `BulkLabelsPage`, `BarcodeThumb`, label print history.
- Payment normalization exists: `schema_v6.sql` and `sale_payments` handling in `commands/sales.rs`.
- Customer ledger command exists: `customer_ledger` in `commands/customers.rs` and frontend ledger UI.
- Money paise convention implemented with `Money`/`MoneyInput` and `formatINR(paise)` compatibility wrapper.

**Pending or partial:**

- Plan versions are aspirational and conflict with actual package versions: current app uses React 19, TypeScript 5.7, Vite 5.4, Tailwind 3.4 rather than the plan's later pinned versions.
- Some milestone claims remain unverified in this audit: real Windows MSI, SQLCipher Windows linking, scanner hardware, tray/power hardening, backup/restore E2E, and E1-E90 manual acceptance.
- UI/UX §8 loading/empty/error states are partially present but not standardized.
- Error boundaries are absent.
- `DESIGN.md` is absent.
- M3 batch label print is effectively pulled forward: `BulkLabelsPage` exists.

### 2.4 `parallel-worktree-slices.md`

**Original direction:** Four parallel slices: A DB+Security, B Domain, C POS, D Shell.

**Implemented evidence in code:**

- Slice A: DB/keywrap/auth/recovery/security files exist.
- Slice B: domain commands and frontend folders for items, locations, customer types, customers, vendors exist.
- Slice C: sales, purchases, day_close, reports, held bills, print files exist.
- Slice D: shell, settings, backup, health, scan, hardening files exist.

**Outdated/conflicting:**

- It says scaffold complete and ready to slice; the repo has moved beyond scaffold.
- It should no longer be used as the primary implementation sequence, but its file ownership model remains useful for parallel work.

### 2.5 `bulk-barcode-management.md`

**Original direction:** Bulk barcode management, brand sequences, item barcode UX, bulk label PDF.

**Implemented evidence in code:**

- Backend brands command module exists and is registered in `src-tauri/src/lib.rs`.
- Brand/sequence schema exists in `schema_v4.sql`.
- `Item.brand_id`, `Brand`, and brand APIs exist in `src/domain/types.ts` and `src/domain/items/api.ts`.
- `ItemForm` loads brands, predicts next barcode via `previewNextBarcode`, and shows a read-only barcode preview.
- `BrandAdmin` exists and is reachable through settings catalog.
- `BulkLabelsPage` exists and is rendered by the live root on `#/barcodes`.
- `BarcodeThumb` exists.
- `printLabelBatch`, PDF preview/download/print paths are represented by `BulkLabelsPage` calls.
- Label print history exists via `label_log` commands and frontend `recordLabelPrint`/`listLabelPrints`.

**Partial or changed:**

- Planned route `#/items/barcodes` is redirected to `#/barcodes` in `src/App.tsx`.
- `ItemList` shows Mapped/Unmapped badges but does not show a dedicated Barcode column with live thumbnail; thumbnail exists in `BarcodeThumb` and is used in forms/bulk labels.
- The plan's wording says `BrandAdmin` optional in AppShell; current route is through Settings catalog, not inventory nav.

### 2.6 `sales-page-rewrite.md`

**Original direction:** Normalize payments, add item search, customer ledger, sales page rewrite with split payments and shortcuts.

**Implemented evidence in code:**

- `schema_v6.sql` adds `sale_payments`.
- `commands/sales.rs` inserts/lists sale payments.
- `src/pos/api.ts` exposes `listSalePayments`, `recordSalePayment`, `searchItems`, `customerLedger`.
- `SalesPage` has final/quotation toggle, customer autocomplete, item search input, split payments, F2/F4/F9/Esc shortcuts, separate open quotations and recent bills sections.
- `CustomerLedgerView` exists.

**Pending or partial:**

- `SalesPage.convert()` currently sends zero paid amount and empty payment modes; the earlier plan expected conversion to open with items/payment active.
- History isolation is partial: both open quotations and recent bills are rendered on the page rather than only the relevant mode's history.
- Error handling is local status strings/alerts, not boundary-backed.
- Search is command-backed but not using a shared debounced/query convention.

### 2.7 `ui-overhaul-v2.md`

**Original direction:** Fix paise display/input, add primitives, Koolwa-style app shell, surface overhaul, keyboard shortcuts.

**Implemented evidence in code:**

- Money foundation exists: `src/lib/money.ts`, `Money`, `MoneyInput`, paise-aware `formatINR` wrapper.
- `MoneyInput` is used in item, sales, inward, day-close/vendor/customer/payment surfaces.
- Many UI primitives exist: Card/Button/Badge/EmptyState/ActionMenu/Section/Skeleton/Alert/Toaster/ShortcutsHint.
- App shell is dark zinc with collapsible groups and light slate work area.
- Dashboard, sales, customers, vendors, inventory, reports, and inward surfaces have substantial UI polish.

**Pending or partial:**

- Theme consistency is uneven: `src/App.tsx` wraps `inward`, `items`, and `barcodes` in dark zinc work surfaces; `sales`, `sales-report`, `vendors`, and `customers` remain light surfaces inside the shell's light content area.
- `Skeleton` is local Tailwind pulse, not `boneyard-js`.
- No app-level design spec file exists.
- Some older `₹{value / 100}` style still appears in `InwardPage` vendor option text; re-audit before declaring money cleanup complete.

---

## 3. Pending, outdated, and conflicting items

### Pending and current

1. **Error boundaries**
   - Add a shared component based on `react-error-boundary`.
   - Wire at root and per-route/page level.
   - Ensure reset integrates with hash navigation and local refresh actions.

2. **`boneyard-js` skeleton loading**
   - Replace or wrap current `Skeleton` so existing imports keep working.
   - Standardize list/table/card skeletons.
   - Do not scatter direct `boneyard-js` imports across pages; use one local adapter.

3. **`DESIGN.md` generation**
   - Create a root `DESIGN.md` describing the product UI: dark shell, light operational surfaces unless intentionally dark, paise/money rules, density, focus states, AA contrast, error/empty/loading states, no SaaS/glass/ornamental gradients.

4. **Improved frontend data fetching**
   - Decide whether to adopt TanStack Query now or define a light in-house convention first. Since TanStack Query is installed but unused, prefer a contained rollout for list pages.
   - Add pagination contracts to backend/frontend list APIs where needed.
   - Add debounced search and a shared query key convention.
   - Remove N+1 outstanding fetches by adding backend aggregate list commands or a batch outstanding command.

5. **Managing patterns**
   - Standardize admin/manage screens: `BrandAdmin`, `ManageTypes`, Locations, Units, Users should share layout, fetch state, pagination if data grows, and empty/error/loading states.

### Outdated

- Next.js/Postgres/Prisma plans are obsolete for implementation.
- `parallel-worktree-slices.md` is useful only as ownership decomposition, not as a state-of-work document.
- `paint-shop-master-plan.md` has version pins and milestones that no longer match package reality.

### Conflicting

- Barcode label size decisions conflict across plans: master plan says 50×25mm default in locked decision but later grill decisions mention 50×50mm and never print prices. Current code supports multiple presets and defaults to 50×25 in bulk page.
- Payment mode wording drift: master grill mentions Credit as a mode, while later sales rewrite says credit is implicit and modes are cash/upi/card/cheque/bank_transfer. Current frontend `SplitPayment`/API should be treated as source of truth before further changes.
- `#/items/barcodes` vs `#/barcodes`: live code redirects the former to the latter.
- Dark/light surface split needs a decision: PRODUCT says dark app chrome and light dense operational surfaces, but inventory/inward/barcodes are currently dark.

---

## 4. Updated integrated work breakdown

### Priority 0 — Planning guardrails before coding

**Goal:** Prevent implementation agents from fighting over the same files.

- Treat `src/App.tsx`, `src/main.tsx`, and `src/components/ui/index.ts` as shared integration files. Only one integration owner edits them at a time.
- Keep `src/pos/PosLayout.tsx` and `src/shell/routes/App.tsx` read-only until a cleanup decision; they appear unused by the live app.
- No source deletion in this round unless a separate dead-code cleanup plan is approved.

### Priority 1 — Error boundaries

**Files:**

- New: `src/components/ErrorBoundary.tsx` or `src/components/ui/ErrorBoundary.tsx`
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Optional modify: page-level wrappers in `src/shell/routes/Dashboard.tsx`, `src/pos/sales/SalesPage.tsx`, `src/pos/purchases/InwardPage.tsx`, `src/domain/items/ItemList.tsx`, `src/domain/customers/CustomerList.tsx`, `src/domain/vendors/VendorList.tsx`

**Expected result:**

- Root catches render failures and shows a trade-counter appropriate fallback.
- Page-level boundary can reset on route/hash changes.
- Fallback copy includes a next action: retry, go dashboard, lock app if needed.

**Notes:**

- Use `react-error-boundary`.
- Do not hide IPC errors inside boundaries; normal command failures should remain inline `Alert`/toast states.

### Priority 2 — Skeleton loading via `boneyard-js`

**Files:**

- Modify: `src/components/ui/Skeleton.tsx`
- Modify only if necessary: `src/components/ui/index.ts`
- Then incrementally update high-traffic pages:
  - `src/shell/routes/Dashboard.tsx`
  - `src/domain/items/ItemList.tsx`
  - `src/domain/customers/CustomerList.tsx`
  - `src/domain/vendors/VendorList.tsx`
  - `src/pos/salesReport/SalesReportPage.tsx`
  - `src/shell/routes/settings/*`

**Expected result:**

- Existing `<Skeleton />` call sites continue working.
- New skeleton variants cover row/table/card/form patterns.
- Dark surface support is explicit, not achieved through ad-hoc `className="bg-white/25"` only.

### Priority 3 — `DESIGN.md`

**Files:**

- New: `DESIGN.md`

**Expected contents:**

- Product personality from `PRODUCT.md`: practical, trustworthy, focused.
- Anti-references: no generic SaaS, no glass dashboard, no ornamental gradients, no decorative analytics.
- Layout rules: dark shell, operational density, clear hierarchy, tabular money.
- Theme rule to resolve current drift: either light operational surfaces by default with dark exceptions, or formalize dark inventory/inward as a deliberate mode.
- Accessibility rules: WCAG AA, focus-visible, keyboard routes, reduced-motion-safe transitions.
- Component rules for Card/Button/Badge/EmptyState/ActionMenu/Money/MoneyInput/Skeleton/ErrorBoundary.

### Priority 4 — Data fetching conventions

**New files:**

- `src/lib/data/queryClient.ts` if adopting TanStack Query.
- `src/lib/data/queryKeys.ts`
- `src/lib/data/useDebouncedValue.ts`
- `src/lib/data/pagination.ts`

**Modify:**

- `src/main.tsx` if adding `QueryClientProvider`.
- `src/domain/items/api.ts`
- `src/domain/customers/api.ts`
- `src/domain/vendors/api.ts`
- `src/pos/api.ts`
- List pages in domain/pos/shell as needed.

**Calling conventions:**

- API wrapper function names stay domain-first: `listItems`, `listCustomers`, `listVendors`, `searchItems`, `dailySales`.
- Query keys use tuple factories: `items.list(filter)`, `customers.list(filter)`, `vendors.outstanding(id)`.
- Mutations invalidate the smallest affected list/detail query.
- Backend command names remain as-is unless a command is explicitly being created; avoid renaming existing Tauri commands in this cleanup.

**Pagination requirements:**

- Define `PageRequest = { query?: string; page: number; pageSize: number }` and `PageResult<T> = { rows: T[]; total: number; page: number; pageSize: number }`.
- First targets: items, customers, vendors, sales history, label print history.
- Avoid breaking current call sites: add new paged functions before migrating pages.

**Debounced search requirements:**

- Use one shared hook, default delay 250–300ms.
- Debounce user text before command invocation, not after results.
- Preserve immediate scanner/barcode flows; do not debounce exact scan submission.

**Managing patterns:**

- Use a standard `ManageList` pattern for Settings management pages: header, description, search, paged list/table, inline add/edit, empty state, error alert.
- Apply first to Catalog settings: Brands, Units, Locations, Customer Types.

### Priority 5 — Theme consistency pass

**Files:**

- `src/App.tsx`
- `src/shell/AppShell.tsx`
- `src/domain/items/*`
- `src/pos/purchases/InwardPage.tsx`
- `src/domain/items/BulkLabelsPage.tsx`
- `src/pos/sales/SalesPage.tsx`
- `src/domain/customers/*`
- `src/domain/vendors/*`

**Expected result:**

- One documented theme policy from `DESIGN.md` is reflected in wrappers.
- If inventory/inward/barcodes remain dark, components must support dark tone intentionally.
- If converted to light, do it in a separate UI pass after behavior work.

---

## 5. Parallel execution map

Use this map to dispatch agents without file conflicts.

### Agent A — Error boundary integration

**Exclusive scope:**

- `src/components/ui/ErrorBoundary.tsx` or `src/components/ErrorBoundary.tsx`
- `src/main.tsx`
- `src/App.tsx`

**Do not touch:** data-fetching files, page internals except minimal wrapper props.

**Output:** root/page boundary implementation and reset behavior.

### Agent B — Skeleton adapter

**Exclusive scope:**

- `src/components/ui/Skeleton.tsx`
- `src/components/ui/index.ts`
- Optional local demos only in `src/components/ui/`

**Do not touch:** page components in first pass. A second pass can migrate call sites after adapter lands.

**Output:** boneyard-backed, backwards-compatible `Skeleton` API with light/dark variants.

### Agent C — Design documentation

**Exclusive scope:**

- `DESIGN.md`
- Optional: `.omo/plans/design-followup.md` only if needed.

**Do not touch:** source files.

**Output:** agent-friendly design system rules grounded in `PRODUCT.md` and current primitives.

### Agent D — Data query infrastructure

**Exclusive scope:**

- `src/lib/data/**`
- `src/main.tsx` only if Agent A is not active; otherwise coordinate a single integration patch.

**Do not touch:** domain pages yet.

**Output:** query client, key factories, debounce hook, pagination types.

### Agent E — Domain list migration

**Exclusive scope:**

- `src/domain/items/ItemList.tsx`
- `src/domain/customers/CustomerList.tsx`
- `src/domain/vendors/VendorList.tsx`
- Their API wrappers only if Agent D has completed contracts.

**Do not touch:** `src/App.tsx`, `src/main.tsx`, POS pages.

**Output:** debounced search, paged lists, no N+1 outstanding calls where backend supports aggregate results.

### Agent F — POS/dashboard data migration

**Exclusive scope:**

- `src/pos/sales/SalesPage.tsx`
- `src/pos/sales/ItemSearchInput.tsx`
- `src/pos/purchases/InwardPage.tsx`
- `src/shell/routes/Dashboard.tsx`
- `src/pos/salesReport/SalesReportPage.tsx`
- `src/pos/api.ts`

**Do not touch:** domain list pages, app root.

**Output:** debounced manual item search, non-debounced scanner flow, cleaner loading/error states.

### Agent G — Settings/manage patterns

**Exclusive scope:**

- `src/shell/routes/Settings.tsx`
- `src/shell/routes/settings/**`
- `src/domain/items/BrandAdmin.tsx`
- `src/domain/customerTypes/ManageTypes.tsx`
- `src/domain/locations/api.ts`
- `src/domain/units/api.ts`

**Do not touch:** shell root, App root, domain list pages.

**Output:** consistent managing pattern for catalog/system/team settings.

---

## 6. File-level assignment summary

| Area | Files | Priority | Conflict notes |
|---|---|---:|---|
| Root provider/boundary | `src/main.tsx`, `src/App.tsx` | P1 | Single integration owner only. ErrorBoundary and QueryClientProvider both want `main.tsx`. |
| Shell | `src/shell/AppShell.tsx` | P5 | Avoid until DESIGN.md settles theme rules. |
| UI primitives | `src/components/ui/*` | P1-P2 | Skeleton/ErrorBoundary agents can work independently if they use distinct new files. |
| Design spec | `DESIGN.md` | P1 | No code conflicts. |
| Query infra | `src/lib/data/**` | P4 | New files, low conflict. |
| Items | `src/domain/items/*` | P4-P5 | `ItemList` and `BrandAdmin/BulkLabelsPage` should be separate agents. |
| Customers | `src/domain/customers/*` | P4 | Coordinate API changes with backend aggregate commands. |
| Vendors | `src/domain/vendors/*` | P4 | Same N+1 outstanding issue as customers. |
| POS | `src/pos/sales/*`, `src/pos/purchases/*`, `src/pos/api.ts` | P4 | Keep scanner exact-submit behavior separate from debounced manual search. |
| Settings | `src/shell/routes/settings/**` | P4 | Good place to prove managing pattern. |
| Dead-code review | `src/pos/PosLayout.tsx`, `src/shell/routes/App.tsx` | Later | Planning note only; do not delete in this wave. |

---

## 7. Risk notes

1. **Dark/light inconsistency**
   - Product principle says dark shell + light operational surfaces, but current inventory/inward/barcodes are dark while sales/customers/vendors are light. Decide in `DESIGN.md` before broad UI edits.

2. **Dead-code false positives**
   - `src/pos/PosLayout.tsx` and `src/shell/routes/App.tsx` appear unused by live root. AFT also reports many dead-code hints, but it warns TypeScript server is not installed, so treat these as hints only.

3. **Root integration conflict**
   - Error boundaries and TanStack Query both need `src/main.tsx`. Assign one integrator or sequence Agent A before Agent D.

4. **N+1 command risk**
   - Customer/vendor lists fetch outstanding balances per row. Pagination alone will reduce pressure, but backend aggregate/batch commands are the root fix.

5. **Search behavior risk**
   - Do not debounce barcode scanner flows. Manual text search should be debounced; exact barcode submission should remain immediate.

6. **Plan drift**
   - Historical plans disagree on stack, label sizes, payment modes, and route paths. Current code plus `PRODUCT.md`/`CONTEXT.md` should be source of truth for this work.

7. **Package presence vs usage**
   - `boneyard-js` and `react-error-boundary` are installed/present in `package.json`, but no source usage exists yet. Implementation agents must add imports deliberately and validate build.

---

## 8. Recommended implementation order

1. Generate `DESIGN.md` first so UI agents share taste and theme constraints.
2. Add ErrorBoundary root/page primitives.
3. Add `boneyard-js` skeleton adapter while preserving existing `Skeleton` API.
4. Add data-query infrastructure (`QueryClientProvider`, query keys, debounce, pagination types).
5. Migrate one low-risk settings/manage screen to prove conventions.
6. Migrate domain list pages with debounced search and pagination.
7. Migrate POS/dashboard data fetching and scanner-safe search.
8. Run a separate theme consistency pass after behavior/data patterns are stable.

---

## 9. Verification plan for future implementation agents

For code changes (not performed in this planning task):

- `lsp_diagnostics` or `aft_inspect` on changed files.
- `pnpm build` for frontend/root changes.
- `cargo check --manifest-path src-tauri/Cargo.toml` only if backend commands/API contracts change.
- Manual smoke routes after UI work: `#/`, `#/sales`, `#/inward`, `#/items`, `#/barcodes`, `#/customers`, `#/vendors`, `#/settings`, `#/health`.
- Specific money smoke: 5000 paise displays as `₹50.00`; 100000 paise displays as `₹1,000.00`.

---

## 10. Planning-only completion note

This file is the updated integrated master plan. No source code, existing plan files, or deletion/cleanup tasks are included in this planning update.

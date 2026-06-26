# PaintKiDukaan Recovery & Hardening Plan

> **Status:** Awaiting execution. Plan derived from prior session `ses_10d784d12ffeAwCrH9E49j0bNT` + codebase verification.

---

## 0. Context & Decisions

### 0.1 What the prior session left behind
- **50 uncommitted files**, +1072/-5279 lines, no commits
- Frontend cleanup mostly done: held-bill UI, legacy shell, dead routes, inwards/adjust duplicate
- Backend cleanup partial: held-bill Rust commands still in `sales.rs`
- Observability partial: `obs/` module never landed
- Customer types, money formatting, customer ledger: status uncertain (claim vs. reality gap)
- `git status` clean except for untracked: `.githooks/pre-commit`, `.opencode/`, `src-tauri/src/db/schema_final.sql`, two zeroed PNGs

### 0.2 Verified test status (today)
- `pnpm exec tsc -b` → **PASS** (0 errors)
- `cd src-tauri && cargo check` → **PASS** (1 dead-code warning, unrelated)
- `cd src-tauri && cargo test` → **PASS** (448/448 in 115s)
- `pnpm test` (vitest) → **FAIL** (3 files, 22+ tests):
  - `src/domain/items/BrandAdmin.test.tsx` — 1 failure (validation message)
  - `src/shell/routes/settings/settings-edge-cases.test.tsx` — 14 failures
  - `src/shell/routes/settings/CatalogSettings.test.tsx` — 7+ failures
  - **All** failures share the same error: `Cannot read properties of undefined (reading 'filter')` — components are calling `.filter()` on undefined results from queries that didn't seed test data.

### 0.3 User decisions (locked)
1. **Commit what's done, finish the rest.**
2. **Schema: hard cutover, drop all data.** No data migration. Existing DBs on first open get wiped and re-bootstrapped with `schema_final.sql`.
3. **Held-bill: delete everything.** No UI, no Rust commands, no migration footers.
4. **Observability: all 8 gaps in one PR.** Consolidated logging + correlation IDs + AppError + ErrorBoundary.
5. **Tauri commands: register all 3 missing** (`cmd_print_receipt`, `cmd_import_items_csv`, `cmd_import_inward_csv`).
6. **Commit granularity: one logical commit per workstream.** ~5–7 commits expected.
7. **Test failures: fix as part of the plan.** No "fix later" deferral.
8. **Plan lives in:** `.omo/plans/paintkiduakan-recovery.md` (this file).

### 0.4 From prior session (carried over, no need to re-confirm)
- Customer form fields: **Name, Phone, Type, Opening Balance only**
- Customer types: **Retailer (default), Dealer, Painter, Contractor**
- Sidebar: **dark chrome, does not follow main theme**
- Money display: **₹ prefix + paise→rupees + en-IN locale** via `formatRupeesFromPaise()`
- Inventory UI: **"Inward" only** (no "Inwards" / "Adjust")
- Day-close: reachable from POS shell, enables fresh-day + trend analysis
- Customer ledger: per-transaction view, Overview/Ledger/Bills tabs
- Backdated credit invoice: Tauri command `create_customer_credit_invoice`, registered

---

## 1. Workstream Breakdown

### WS-1 — Schema hard cutover (drop data, no migration)

**Goal:** Fresh DBs get `schema_final.sql` directly. Existing DBs get **wiped** and re-bootstrapped. Remove the 9-migration chain.

**Files to touch:**
- `src-tauri/src/db/mod.rs` — change `Db::open` so it always applies `SCHEMA_FINAL` on first run, and **deletes all rows** from existing tables on upgrade. No call to `migrations::run()`.
- `src-tauri/src/db/migrations.rs` — delete the 9 `M::up(MIGRATION_NNN)` registrations. Keep only the test cases that validate `SCHEMA_FINAL` directly.
- `src-tauri/src/db/migrations/001__...sql` through `009__...sql` — **delete these files** (migrations no longer exist).
- `src-tauri/src/db/schema_final.sql` — keep as-is; verify it inlines everything migrations used to add (units.dimension, sales.no/total/paid_amount, sale_returns.no, daily_counters, printers, etc.).

**Success criteria:**
- `cargo test` still 448/448 pass (the `schema_loads_all_expected_tables` test is the gate)
- First open of an old dev DB → all tables dropped, then re-created with final shape
- `migrations::run` no longer exists or is a no-op stub

**Verification:**
- `cd src-tauri && cargo test` → green
- Manually open a pre-cutover DB in a test wrapper, confirm `_schema_final_applied` flag absent → wipe + bootstrap
- `pnpm tauri:dev` reaches security phase without migration errors

**Commit:** `feat(schema): hard cutover to schema_final.sql, drop old data`

---

### WS-2 — Register 3 missing Tauri commands

**Goal:** Frontend already invokes these but they aren't wired in `invoke_handler` → runtime failure.

**Files to touch:**
- `src-tauri/src/lib.rs` — add to `invoke_handler`:
  - `commands::printing::cmd_print_receipt`
  - `commands::import::cmd_import_items_csv`
  - `commands::import::cmd_import_inward_csv`
- (Optional) `src-tauri/src/commands/printing.rs` — if `cmd_print_receipt` signature doesn't match the frontend's invoke args, align it. Verify by reading `src/pos/print.ts`.

**Success criteria:**
- `cargo check` clean
- `pnpm tauri:dev` → log in → POS tab → scan an item → print receipt → no `command not found` error in devtools
- `pnpm tauri:dev` → Catalog → Import Items CSV → no `command not found` error

**Verification:**
- Static: `grep -n 'cmd_print_receipt\|cmd_import_items_csv\|cmd_import_inward_csv' src-tauri/src/lib.rs` shows all three in `invoke_handler!`
- Runtime: full `pnpm tauri:dev` smoke (login → sales → import)

**Commit:** `feat(commands): register 3 missing Tauri commands`

---

### WS-3 — Held-bill removal (complete)

**Goal:** Remove the 3 Rust commands. UI is already gone. Verify no stragglers.

**Files to touch:**
- `src-tauri/src/commands/sales.rs` — delete the 3 command fns (lines ~785, 802, 813): `cmd_hold_bill`, `cmd_list_held`, `cmd_delete_held`. Also delete any internal helper functions they call (e.g. `hold_bill_impl`, `list_held_impl`, etc.).
- `src-tauri/src/lib.rs` — confirm none of these 3 are in `invoke_handler!` (they shouldn't be; not registered).
- `src-tauri/src/commands/sales.rs` — search for `hold_bill` / `held_bills` / `HoldBill` references in the file. If any remain (e.g., helper structs, model types), delete or move to dead-code-eligible.

**Success criteria:**
- `cargo check` clean (or only the pre-existing `ItemLookupRow` dead-code warning)
- `grep -r 'cmd_hold_bill\|cmd_list_held\|cmd_delete_held\|hold_bill\|held_bills\|HoldBill' src-tauri/src src/` → no hits in production code (test fixtures OK to flag for review)
- `cargo test` still 448/448

**Verification:**
- Grep
- `cargo check` + `cargo test`

**Commit:** `refactor(sales): remove held-bill commands and UI`

---

### WS-4 — Observability (all 8 gaps in one PR)

**Goal:** Make errors traceable end-to-end. Consolidate AppError, wire ErrorBoundary, log DB rollbacks, add correlation IDs, fix serialization, fix log level mapping.

**Sub-tasks (parallelizable into 2 sub-agents):**

**4A — Backend structured logging (`obs/` module):**
- `src-tauri/src/obs/mod.rs` — new module: `Logger` with `info/warn/error/debug/trace`, correlation-id propagation via thread-local or `tauri::State`, structured fields (e.g., `serde_json::Value`).
- `src-tauri/src/db/mod.rs` — log every `BEGIN` / `COMMIT` / `ROLLBACK` with correlation-id + table counts.
- `src-tauri/src/commands/*.rs` — replace any `eprintln!` with `obs::error!` carrying the corr-id.
- `src-tauri/src/error.rs` — already consolidated in prior session; verify and add `AppError::correlation_id() -> Option<Uuid>`.
- `src-tauri/src/lib.rs` — initialize `obs::Logger::new()` at startup, generate a corr-id per IPC call (via middleware or wrapping `invoke_handler`).

**4B — Frontend observability:**
- `src/lib/security/sessionLog.ts` — fix the `console.log` → `console.info` mapping (so `"log"` level maps to valid `"info"`). Replace silent `.catch(() => {})` with `.catch(e => sessionLog.error('context', e))`.
- `src/lib/security/ErrorBoundary.tsx` (or equivalent) — wire to call `sessionLog.error` with corr-id on every error.
- `src/lib/security/tauri.ts` — normalize errors: `JSON.stringify(e, Object.getOwnPropertyNames(e))` instead of `${e}` to fix `[object Object]`.
- Generate a corr-id in the IPC wrapper, attach to every call, return it in the error response.

**Success criteria:**
- Trigger any error → log appears in dev console + backend log with the **same** correlation id
- `pnpm exec tsc -b` clean
- `cargo check` clean
- No `console.log` calls in the codebase that send `"log"` level to the backend (use `console.info`)
- No `.catch(() => {})` in `src/` (use `.catch(e => log(...))`)

**Verification:**
- `grep -rn 'catch(() => {}' src/ | wc -l` → 0
- `grep -rn 'console\.log' src/ | wc -l` → small (only dev-time, not in IPC path)
- Manual test: trigger a backend error, confirm log shows corr-id

**Commit:** `feat(observability): structured logging + AppError + ErrorBoundary + correlation IDs`

---

### WS-5 — Theme system (verify + finalize)

**Goal:** Confirm the prior session's theme work is actually applied. Fill gaps.

**Files to verify (read-only checks):**
- `src/index.css` — confirm semantic tokens (`--background`, `--foreground`, etc.) for light + dark
- `src/main.tsx` — confirm `ThemeProvider` wraps the app
- `index.html` — confirm FOUC-prevention inline script
- `src/shell/components/AppShell.tsx` — confirm sidebar uses `sidebar-*` tokens (dark chrome)
- `src/pos/PosLayout.tsx` — confirm main content uses theme tokens

**Sub-tasks:**
- Grep for old raw color classes (`bg-zinc-900`, `text-slate-500`, etc.) that should be semantic (`bg-card`, `text-muted-foreground`). Replace as found.
- Confirm `data-theme` attribute is set on `<html>` and Tailwind's `darkMode: ['class', '[data-theme="dark"]']` is configured.

**Success criteria:**
- `pnpm exec tsc -b` clean
- No raw `bg-zinc-*` / `text-zinc-*` in `src/pos/`, `src/shell/`, or `src/domain/`
- Theme toggle in settings persists across reload
- Sidebar visually distinct (dark) from main content

**Verification:**
- `grep -rn 'bg-zinc-\|text-zinc-\|bg-slate-\|text-slate-' src/pos/ src/shell/ src/domain/` → only inside `theme.test.ts` or similar test fixtures

**Commit:** `feat(theme): semantic tokens + FOUC prevention + sidebar dark chrome`

---

### WS-6 — Day-close wiring

**Goal:** `DayClosePage` reachable from the live POS shell, not orphaned.

**Files to touch:**
- `src/pos/PosLayout.tsx` — add `DayClose` to the tab list (verify it isn't already)
- `src/App.tsx` — confirm hash-routing for `#/day-close` is registered
- `src/pos/dayClose/DayClosePage.tsx` — already exists per prior session; verify it renders without errors

**Sub-tasks:**
- If `DayClosePage` is not in the live tab list, add it. Make it accessible to `owner` and `cashier` roles.
- Wire a "Day Close" button in the dashboard's quick actions.
- Add a `daily_counters` integration: when day closes, the next day starts with a fresh counter.

**Success criteria:**
- Login → POS shell → click "Day Close" tab → page renders, no `Cannot read properties of undefined` errors
- Submitting a day close → next sale gets a new `sale_number` (or `no` per new schema) prefix
- `pnpm tauri:dev` smoke: full sale → day-close → next sale → second sale has a new daily counter

**Verification:**
- `pnpm tauri:dev` end-to-end smoke

**Commit:** `feat(pos): wire day-close into live POS shell`

---

### WS-7 — Customer ledger + backdated credit invoice

**Goal:** Customer ledger UI works; backdated credit invoice Tauri command is registered and accessible.

**Files to verify/touch:**
- `src/domain/customers/CustomerDetail.tsx` — Overview/Ledger/Bills tabs
- `src/domain/customers/CustomerList.tsx` — per-row "Ledger" button
- `src-tauri/src/commands/customer_ledger.rs` — `create_customer_credit_invoice` accepts backdated `sale_date` parameter
- `src-tauri/src/lib.rs` — confirm `create_customer_credit_invoice` is in `invoke_handler!`
- `src/domain/customers/CustomerForm.tsx` — only Name, Phone, Type, Opening Balance fields
- `src-tauri/src/db/migrations/006__update_customer_types.sql` — change to Retailer/Dealer/Painter/Contractor (or move into `schema_final.sql` if WS-1 already absorbs it)

**Sub-tasks:**
- Verify `CustomerForm` simplified (per prior session claim)
- Verify customer types seed data uses new names
- Verify `create_customer_credit_invoice` is registered
- If `backdated` param is missing, add it
- Wire the customer detail "Add Credit Invoice" button to call this command with a date input

**Success criteria:**
- Customer list → click "Ledger" → CustomerDetail loads with Ledger tab active
- Add a backdated credit invoice (e.g., for 3 days ago) → appears in Ledger with correct date
- CustomerForm has only 4 fields
- Customer types: Retailer is default

**Verification:**
- `pnpm tauri:dev` smoke: create customer → view ledger → add backdated credit → verify appears

**Commit:** `feat(customer): simplified form + ledger tabs + backdated credit invoice`

---

### WS-8 — Money formatting standardization

**Goal:** All money display uses `formatRupeesFromPaise()` with `₹` prefix + en-IN.

**Files to verify:**
- `src/lib/money.ts` (or wherever `formatRupeesFromPaise` lives) — confirm it exists and matches
- Grep `src/` for any `toFixed(2)` on paise values, any `Rs.`, any raw `paise` display — replace

**Sub-tasks:**
- Find every place that does `paise / 100`, `.toFixed(2)`, `₹${...}` patterns manually
- Replace with `formatRupeesFromPaise(paise)` calls
- Verify `formatINR` (the older util) is no longer used in the codebase

**Success criteria:**
- `grep -rn 'toFixed(2)' src/pos/ src/domain/ src/shell/` → only in test fixtures or in places where the value is already rupees (not paise)
- `grep -rn '"Rs\."\|`Rs\.'` src/` → no hits
- `pnpm tauri:dev` → every money display shows `₹1,234.56` format

**Verification:**
- Grep
- Manual smoke

**Commit:** `feat(money): ₹ prefix + paise→rupees en-IN formatting`

---

### WS-9 — Frontend cleanup (verify)

**Goal:** Confirm all prior-session deletions actually landed. Fill any gaps.

**Files to verify:**
- `src/pos/heldBills/` — should not exist
- `src/shell/routes/App.tsx` — should not exist
- `src/domain/items/ItemDetail.tsx` — should not exist (or be unused)
- Duplicate reports page — only one should remain
- Dashboard inward link — `/#/inward` (not `/#/purchases/new`)

**Sub-tasks:**
- Grep for any remaining `heldBills`, `HeldBill`, `HeldBillRow` references
- Grep for `purchases/new` in src
- Confirm CustomerLedgerView is no longer a standalone route (replaced by CustomerDetail tabs)

**Success criteria:**
- `grep -r 'heldBills\|HeldBill' src/` → no hits
- `grep -rn 'purchases/new' src/` → no hits
- `find src -name 'ItemDetail.tsx'` → not found (or unused)

**Verification:**
- Greps
- `pnpm exec tsc -b` → clean

**Commit:** `chore(cleanup): remove dead held-bill UI, unused routes, duplicate reports page` (folded into WS-3 if small enough)

---

### WS-10 — Vitest test fixes (settings pages)

**Goal:** All vitest tests pass. Root cause: components call `.filter()` on `undefined` because the test environment doesn't seed unit/brand/category data, OR the query mocks return `undefined` instead of `[]`.

**Files to touch:**
- `src/shell/routes/settings/CatalogSettings.test.tsx` — fix the test setup to seed data, or fix the component to default `undefined` → `[]`.
- `src/shell/routes/settings/settings-edge-cases.test.tsx` — same
- `src/domain/items/BrandAdmin.test.tsx` — fix the validation message expectation (form treats empty brand as "disabled" not "error")

**Two approaches (pick one, or hybrid):**
- **A. Component-level fix:** make the components defensive: `(data ?? []).filter(...)`. The empty-state already renders "No units configured" so this should be a small change. Fixes the production code AND tests.
- **B. Test-setup fix:** seed the test DB / mocks with the data the tests expect. More invasive but tests the real component path.

**Recommendation: A.** Defensive defaults are good practice and the empty-state UI is already designed for this case.

**Success criteria:**
- `pnpm test` → all green (target: 0 failures across all files)
- The "Cannot read properties of undefined" error no longer appears in any test output

**Verification:**
- `pnpm test` → 100% pass
- Note: if any tests are intentionally testing error states (e.g., a 500 response), keep those intact and only fix the data-shape ones

**Commit:** `fix(tests): settings page test-environment regressions`

---

## 2. Commit Order (proposed)

1. `chore(cleanup): remove dead held-bill UI, unused routes, duplicate reports page` (WS-9)
2. `refactor(sales): remove held-bill commands and UI` (WS-3)
3. `feat(schema): hard cutover to schema_final.sql, drop old data` (WS-1)
4. `feat(commands): register 3 missing Tauri commands` (WS-2)
5. `feat(observability): structured logging + AppError + ErrorBoundary + correlation IDs` (WS-4)
6. `feat(theme): semantic tokens + FOUC prevention + sidebar dark chrome` (WS-5)
7. `feat(pos): wire day-close into live POS shell` (WS-6)
8. `feat(customer): simplified form + ledger tabs + backdated credit invoice` (WS-7)
9. `feat(money): ₹ prefix + paise→rupees en-IN formatting` (WS-8)
10. `fix(tests): settings page test-environment regressions` (WS-10)

**That's 10 commits. To hit the 5-7 target, fold like this:**
- 1+2 → `chore(sales): remove held-bill (UI + Rust commands)` 
- 5+4 → `feat(backend): schema cutover + register missing commands + observability`
- 7+8+9 → `feat(ui): theme + day-close + customer + money formatting`
- 10 standalone

**Final 6-commit order:**
1. `chore(sales): remove held-bill (UI + Rust commands)` — WS-3 + WS-9
2. `feat(backend): hard schema cutover + register 3 missing commands` — WS-1 + WS-2
3. `feat(observability): structured logging + AppError + correlation IDs` — WS-4
4. `feat(ui-theme): semantic tokens + sidebar dark chrome` — WS-5
5. `feat(pos): day-close + customer ledger + backdated credit + money formatting` — WS-6 + WS-7 + WS-8
6. `fix(tests): settings page test-environment regressions` — WS-10

---

## 3. Execution Plan (parallel workstream mapping)

These are **independent** and can run in parallel:

**Track A (Backend):** WS-1, WS-2, WS-3, WS-4
**Track B (Frontend cleanup):** WS-5, WS-6, WS-7, WS-8, WS-9
**Track C (Tests):** WS-10 (must run after A + B)

Order: A and B in parallel, then C.

**Sub-agents needed:**
- 1× `unspecified-high` for Track A (Rust/DB work) — load skill: `git-master`
- 1× `unspecified-high` for Track B (UI/frontend work) — load skill: `git-master`
- 1× `unspecified-high` for Track C (test fixes) — load skill: `git-master`

---

## 4. Verification Gates (must pass before merge)

1. `pnpm exec tsc -b` → 0 errors
2. `cd src-tauri && cargo check` → 0 errors, 0 new warnings
3. `cd src-tauri && cargo test` → 448/448 pass
4. `pnpm test` → 0 failures (target: 0 across all test files)
5. `pnpm tauri:dev` runtime smoke:
   - Boot → security phase renders
   - Login → POS shell loads
   - Open Settings → Catalog, Hardware, Backup all render without `[object Object]` errors
   - Sales: scan an item → submit → print receipt (dev PDF fallback) → no errors
   - Customers: create new customer (Retailer) → view ledger → add backdated credit invoice
   - Day-close: trigger → next sale has new counter
   - Theme toggle persists across reload

If any gate fails, fix and re-run. Do not move to the next commit until the current passes all gates.

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Hard cutover wipes real data | Confirmed by user. No production data yet. Backup DB before first run. |
| `obs/` module is complex; could break `cargo test` | Sub-agent should run `cargo test` after each change; small diffs only. |
| Test fixes are speculative (we don't know exact data shape) | Use approach A (defensive `?? []`) — low risk. |
| 6 commits all touch many files → conflict on merge | Track A and B work on different files. Track C runs after. Low conflict risk. |
| Schema change breaks `cargo test` migrations test | Update test to use `SCHEMA_FINAL` directly. |
| Backdated credit invoice might not exist as a real command | Verify in `commands/customer_ledger.rs` first; if not implemented, define it. |

---

## 6. Out of Scope (NOT in this plan)

- Production deployment / installer signing
- New hardware integrations (e.g., adding new printer drivers)
- Performance optimization beyond what's already in flight
- Migrating to a different ORM or DB engine
- CI/CD setup
- i18n / multi-language support

---

## 7. Done = 

- [ ] All 6 commits landed locally
- [ ] `pnpm exec tsc -b` clean
- [ ] `cd src-tauri && cargo check` clean
- [ ] `cd src-tauri && cargo test` 448/448 pass
- [ ] `pnpm test` 0 failures
- [ ] `pnpm tauri:dev` end-to-end smoke green
- [ ] User-confirmed: "looks good, push it" → `git push`

---

*Plan generated 2026-06-23. Source: prior session `ses_10d784d12ffeAwCrH9E49j0bNT` + fresh codebase verification.*

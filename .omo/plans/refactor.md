# PaintKiDukaan Refactor Plan

**Date**: 2026-06-24
**Intent**: Improve grammar + consistency + case-insensitive search + cache/perf across the app. Title Case display. No plaintext leaks. No overengineering.

## Constraints (locked)
- Title Case display only, NOT on save (no stored-data migration)
- Single shared `toTitleCase()` formatter
- TanStack Query built-ins, NO custom cache class
- No IndexedDB unless offline-first is demonstrably needed (it isn't — localStorage handles drafts)
- AppError variant codes (`code()`) MUST stay stable — frontend `isAppError()` type guard depends on them
- Money in paise integer, `formatRupeesFromPaise` only (NOT `formatINR`)
- Existing 5 vitest tests must still pass
- No new dependencies unless absolutely required

---

## Phase 1 — Grammar pass (UI + Rust + comments)

### 1.1 App.tsx UI strings (src/App.tsx)
- L91 "Loading…" → "Loading…"
- L307 "Opening secure shop database…" → "Opening secure shop database…"
- L452 + L465 "Inventory" duplicate heading — fix in Phase 10
- L543 "Add Vendor" → "Add vendor"
- L555 "Edit Vendor" → "Edit vendor"
- L570 "Record vendor payment" → "Record vendor payment"
- L584 "Vendor Details" → "Vendor details"
- L600 "Add Customer" → "Add customer"
- L613 "Edit Customer" → "Edit customer"
- L629 "Customer Details" → "Customer details"
- L644 "Record customer payment" → "Record customer payment"

### 1.2 AppError strings (src-tauri/src/error.rs)
Variant codes stay stable. Display messages get humanized:
- L57 `"locked out until unix {until}"` → `"locked until {human_time}"`
- All other variants: reviewed — keep technical variants (db, internal, crypto) since they're logged but shown to user via toast. Replace `"database error: {0}"` with `"Something went wrong. Please try again."` for user-facing UI but keep raw in logs.

**Strategy**: Add `Display` impl that returns the variant's user-friendly message; keep `Debug` for logging. Variant codes in `.code()` are unchanged.

### 1.3 Comments/logs review
- Audit top-of-file docstrings in src-tauri/src/commands/*.rs for grammar
- No code changes needed beyond what falls out naturally

**Verification**: `pnpm exec tsc -b` + `cd src-tauri && cargo check`

---

## Phase 2 — Title Case display normalization

### 2.1 Create single formatter
- New file: `src/lib/format/titleCase.ts`
- Exported: `toTitleCase(input: string): string`
- Rules: lowercase all words except first letter of each; preserve all-caps acronyms (≤3 letters, e.g. "PVC", "USA") via opt-in; preserve leading punctuation; trim whitespace
- 1 unit test in `tests/frontend/titleCase.test.ts`

### 2.2 Display sites — apply formatter
- All 15+ sites from codemap get `toTitleCase(...)` wrap at the render boundary
- Receipts (src/pos/print.ts + printReceipt.ts) get formatter on item_name / customer_name / vendor_name lines
- ESC/POS printing (src-tauri/src/commands/printing.rs) — add Rust `to_title_case()` helper that mirrors TS, used for receipt lines
- `user.name.slice(0,1).toUpperCase()` at src/shell/AppShell.tsx:438 — leave as-is (avatar initial only)

### 2.3 Search query folding (separate from display)
- Frontend search inputs (ItemSearchInput, CustomerAutocomplete, InwardPage): case-fold query before sending to backend
- Do NOT collapse names at save — preserve raw input

**Verification**: `pnpm test` (new titleCase test passes) + `pnpm exec tsc -b`

---

## Phase 3 — COLLATE NOCASE migration

### 3.1 New migration file
- `src-tauri/src/db/migrations/00X_add_nocase.sql`
- Drops old `idx_*_is_active_name` indexes and recreates with `COLLATE NOCASE`
- Adds `COLLATE NOCASE` to UNIQUE constraints on: brands, customer_types, categories, sub_locations, devices, users

### 3.2 Update canonical schema
- `src-tauri/src/db/schema_final.sql`: same changes so fresh install matches
- Mirrored in schema.sql, schema_v1.sql, schema_v2.sql, schema_v4.sql ONLY if they share the same CREATE INDEX statements (otherwise just add a comment)

### 3.3 SQLite-specific considerations
- COLLATE NOCASE only works with ASCII by default; Unicode case-folding needs ICU extension (not bundled). For paint-shop names (Hindi/English mix), accept that non-ASCII exact-match is case-sensitive. ASCII names get case-insensitive search via index.

**Verification**: `cd src-tauri && cargo check` + manual smoke (search "royal" finds "Royal Paints")

---

## Phase 4 — Search query case-folding (backend)

### 4.1 Backend helper
- New `src-tauri/src/commands/_util.rs` (or extend `commands/mod.rs`) with `case_fold_lower(s: &str) -> String` that calls `.to_lowercase()` (Unicode-aware)
- Replace raw `q` in `LIKE '%' || ? || '%'` patterns with `case_fold_lower(q)` and use `LOWER(name) LIKE LOWER(...)` pattern
- Affected: items.rs:440-474, customers.rs:282-324, vendors.rs:102-139

### 4.2 Import path
- Already uses `LOWER(name) = LOWER(?1)` — keep as-is

**Verification**: `cd src-tauri && cargo check`

---

## Phase 5 — QueryClient consolidation

### 5.1 Make singleton canonical
- Update `src/lib/query/queryClient.ts` to add `gcTime: 5*60_000`, `refetchOnWindowFocus: false`, `structuralSharing: true`
- Update `src/main.tsx:17-27` to import + use the singleton
- Delete inline `new QueryClient(...)`

**Verification**: `pnpm exec tsc -b` + grep for inline `new QueryClient` returns zero

---

## Phase 6 — Invalidation fix + minor prefetch

### 6.1 Fix AlertBell key
- `src/shell/components/AlertBell.tsx:88` — change `ALERTS_QUERY_KEY = ["alerts"]` to `["dashboard", "alerts"]` (or vice versa — pick one canonical key)

### 6.2 Prefetch on app unlock
- After unlock, `queryClient.prefetchQuery(["items"])` + `["customers"]` + `["vendors"]` so first paint is instant

**Verification**: `pnpm test` + manual smoke (mark alert → bell updates without refresh)

---

## Phase 7 — Session store collapse

### 7.1 Frontend
- Canonical: `src/lib/security/state.ts:useSecurity`
- Delete: `src/shell/store/session.ts`
- Find all imports of `useSessionStore` and migrate to `useSecurity`

### 7.2 Backend
- Canonical: `AppState.session` in `src-tauri/src/commands/auth.rs:42`
- Delete: `src-tauri/src/session.rs:63 static CURRENT`
- Remove `sync_session_to_static` calls (auth.rs:640-648)

**Verification**: `pnpm exec tsc -b` + `cd src-tauri && cargo check` + manual smoke (lock/unlock)

---

## Phase 8 — Cache hygiene (security)

### 8.1 Wrap AppState secrets in Zeroizing
- `recovery_passphrase: Mutex<Option<Zeroizing<String>>>` — already done per codemap
- `session.pin: Option<Zeroizing<String>>` — add if missing
- Verify all `String` fields in AppState that may hold secret material

### 8.2 Clear on lock()
- `src-tauri/src/commands/auth.rs:629-634` — extend `lock()` to clear `recovery_passphrase` and any pin/secret Mutex contents in AppState
- Audit + remove plaintext PIN/passphrase logging paths

**Verification**: `cd src-tauri && cargo check` + manual smoke (lock → verify no passphrase in process memory)

---

## Phase 9 — AppError humanization

### 9.1 User-facing display
- Add a `user_message(&self) -> String` method on AppError that returns human-readable text:
  - `LockedOut { until }` → "Too many attempts. Try again at HH:MM." (compute from `until` epoch ms)
  - `WrongPin` → "Incorrect PIN"
  - `WrongRecoveryPassphrase` → "Incorrect recovery passphrase"
  - `TooManyAttempts` → "Too many failed attempts. Please wait."
  - `InvalidPinFormat` → "PIN must be exactly 6 digits"
  - `NoDb` → "Database not set up yet"
  - `NotUnlocked` → "Please unlock the database first"
  - `Wiped` → "Data was wiped. Restore from recovery passphrase."
  - `NotFound(x)` → "Not found" (don't leak x to user)
  - `Db(_)`, `Internal(_)`, `Crypto(_)`, `Io(_)`, `Forbidden(_)`, `PathTraversal(_)`, `LogInjection(_)` → "Something went wrong." (raw kept in logs only)

### 9.2 Update frontend extractError
- `src/lib/extractError.ts:4` — read `user_message` if AppError, fall back to current behavior for non-AppError
- Keep `code()` and `message` (raw) fields for telemetry; surface `user_message` to UI

### 9.3 Add unit test
- Test that `AppError::WrongPin.user_message()` returns "Incorrect PIN"

**Verification**: `cd src-tauri && cargo check` + `pnpm test` + manual smoke (trigger each error)

---

## Phase 10 — UI bug fixes

### 10.1 App.tsx Inventory heading
- L452 → "Items"
- L465 → "Barcode Labels"

### 10.2 Remove HeldBill dead code
- Delete from `src/domain/types.ts:346-352`
- Grep for any usage — if none, safe to remove

### 10.3 App.tsx "Loading…" cleanup
- Replace magic strings with constants if they appear in >2 places

**Verification**: `pnpm exec tsc -b`

---

## file_independent_steps

| Phase | File set | Cross-deps |
|-------|----------|------------|
| P1 (grammar) | App.tsx, error.rs | None |
| P2 (Title Case) | new titleCase.ts + 15+ render sites | None |
| P3 (COLLATE NOCASE) | migrations/*.sql + schema_final.sql | None |
| P4 (search folding) | commands/_util.rs + items.rs/customers.rs/vendors.rs | None |
| P5 (QueryClient) | main.tsx + queryClient.ts | None |
| P6 (invalidation) | AlertBell.tsx + state.ts | None |
| P7 (session collapse) | shell/store/session.ts + auth.rs + session.rs | None |
| P8 (cache hygiene) | auth.rs | None |
| P9 (AppError) | error.rs + extractError.ts | None |
| P10 (UI bugs) | App.tsx + types.ts | None |

**All 10 phases are file-independent. >=3 → TEAM MODE for Phase 5.**

(Team mode unavailable this session due to usage limit; will execute sequentially myself.)

---

## Team recommendation

>= 3 independent steps: TEAM MODE for Phase 5

**Status**: Plan agent delegation unavailable (billing cycle quota). Will execute sequentially in main agent with small per-phase commits and verification after each.

---

## Ponytail filter (Phase 4b) — applied

- ✅ Single `toTitleCase()` formatter (NOT per-entity)
- ✅ TanStack Query built-ins (gcTime tuning, prefetchQuery, structuralSharing) — NOT custom cache class
- ✅ Use existing React.lazy + Suspense (already in place)
- ✅ No IndexedDB — localStorage already handles light drafts
- ✅ No stored-data migration — normalize on display + search only
- ✅ Minimal diff: in-place edits + additive migration file (no rewrites)
- ✅ No new dependencies — formatter is 10 LOC, no Tauri plugin adds

### Deliberate simplifications (ponytail: this exists)
- **Backend Rust `to_title_case()`** added only because receipts are formatted in Rust (printing.rs:189-191). 10 LOC. Drop the formatter if receipts aren't user-facing critical.
- **AppError user_message** is a method, NOT a parallel enum. Keeps variant codes stable. If messages later need i18n, lift into a `t()` lookup.
- **COLLATE NOCASE** is additive (new index drop + recreate). Not changing column collations (SQLite quirk: column collation can't be changed without rebuild). Accept the cost.

---

## Verification matrix

| Phase | Type check | Rust check | Tests | Manual smoke |
|-------|-----------|------------|-------|--------------|
| P1 | ✓ | ✓ | — | — |
| P2 | ✓ | ✓ | ✓ (new test) | — |
| P3 | — | ✓ | ✓ (existing) | search smoke |
| P4 | — | ✓ | ✓ | search smoke |
| P5 | ✓ | — | — | app boots |
| P6 | ✓ | — | ✓ | alert bell |
| P7 | ✓ | ✓ | — | lock/unlock |
| P8 | — | ✓ | — | lock → memory |
| P9 | ✓ | ✓ | ✓ | each error |
| P10 | ✓ | — | — | tabs render |

Final verification (Phase 6):
- `pnpm exec tsc -b` — clean
- `cd src-tauri && cargo check` — clean
- `pnpm test` — all 5+1 tests pass
- `cd src-tauri && cargo test` — no tests exist; skip
- Manual smoke via `pnpm tauri:dev`

---

## Out of scope (deliberate)
- New dependency: TanStack Query persist plugin (overengineering for desktop Tauri — no offline-first)
- Rust async runtime changes
- Tauri plugin additions
- Money formatter changes (already in place)
- Security primitive changes (argon2, aes-gcm params)
- Migration of stored data to Title Case
- HeldBill feature implementation (dead code, removed instead)
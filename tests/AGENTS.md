# Tests

Test suites for PaintKiDukaan.

## Layout

```
tests/
├── frontend/                # Vitest (jsdom) — React + hook + lib tests
├── rust/                    # Future: integration tests via `cargo test --tests`
└── integration/             # Future: cross-layer (FE + BE) end-to-end tests
```

## Frontend (Vitest)

All `.test.{ts,tsx}` files are picked up by `vitest.config.ts` from:
- `tests/frontend/**/*.test.{ts,tsx}` (canonical home)
- `src/**/*.test.{ts,tsx}` (legacy — being migrated)

### Conventions

- **Co-locate at `tests/frontend/<domain>/<file>.test.tsx`** (not inside `src/`).
- **Imports use `../../src/...` relative paths** from `tests/frontend/<file>`.
- **Mock at the IPC boundary**, not the component:
  - `vi.mock("../../src/domain/<domain>/api", () => ({ ... }))` for typed wrappers
  - `vi.mock("../../src/lib/ipc", () => ({ ipc: ... }))` for shell-level IPC
  - Avoid mocking `tauriInvoke` directly — components should use typed wrappers
- **Use `vi.hoisted()`** for shared mock state that needs to be referenced inside the factory.
- **Use `<QueryClientProvider>` wrapper** in `createWrapper()` for any component that uses `useQuery`/`usePaginatedQuery`.
- **Snapshot tests are forbidden** — use semantic assertions.
- **Test user-visible behavior, not implementation** — query by role/label/text, not by className.
- **Test ID: `data-testid` is allowed** but only as a last resort.

### Run

```bash
pnpm test                              # all tests, watch off
pnpm vitest run tests/frontend/<file>  # one file
pnpm vitest run -t "<test name>"       # by test name pattern
```

### Stale-test rules

- If a test references text/UI that no longer exists (e.g. "Loading…" replaced by SkeletonRow), update the test to match the new UI — do not delete the test.
- If a test mocks a path that no longer exists (module moved), update the path. Use `git log --follow <test>` to find the original location.
- If a test fails because a function signature changed, fix the test to match the new signature.

### Coverage gaps to fill (priority order)

1. `src/lib/money.ts` — `formatRupeesFromPaise`, `formatRupeesCompact`, `parseRupeesToPaise`
2. `src/lib/query/usePaginatedQuery.ts` — debounce, page reset on search change, sort/filter
3. `src/components/ui/MoneyInput.tsx` — paise <-> display, locale, sign
4. `src/components/ui/SearchInput.tsx` — debounce, clear, accessibility
5. `src/components/ui/SkeletonRow.tsx` — render variants
6. `src/components/ui/EmptyState.tsx` — icon prop, no-results vs no-data
7. `src/shell/components/AlertBell.tsx` — polling, mark-read, role guard
8. `src/pos/sales/SalesPage.tsx` — cart add/remove, qty change, total calc
9. `src/pos/purchases/InwardPage.tsx` — line item add, cost calc, submit
10. `src/pos/dayClose/DayClosePage.tsx` — gate, summary, close action

## Rust (Cargo)

All Rust tests are currently inline `#[cfg(test)] mod tests` blocks within source files.
No `tests/rust/` integration tests exist yet. The directory is reserved for future
end-to-end tests that need the full crate (DB migrations + commands + IPC).

### Run

```bash
cd src-tauri && cargo test                  # all tests
cd src-tauri && cargo test --lib            # library only
cd src-tauri && cargo test <name>           # single test
```

### Coverage gaps to fill (priority order)

1. `commands/sales.rs` — finalization, payment, void paths
2. `commands/purchases.rs` — inward, supplier, cost calc
3. `commands/customers.rs` — balance computation, opening balance
4. `commands/vendors.rs` — outstanding, totals
5. `commands/items.rs` — archive, search, stock update
6. Money helpers — overflow, negative, zero, fractional input rejection
7. Sequence counter — increment, rollover, concurrent
8. Schema migrations — upgrade from prior version (no production data yet)

## Mock layer pattern (reference)

For a component that calls `listBrands()` from `src/domain/items/api.ts`:

```tsx
// tests/frontend/BrandAdmin.test.tsx
import { BrandAdmin } from "../../src/domain/items/BrandAdmin";

vi.mock("../../src/domain/items/api", () => ({
  listBrands: vi.fn(),
  createBrand: vi.fn(),
  deactivateBrand: vi.fn(),
  updateBrandCodePrefix: vi.fn(),
}));

import { listBrands, createBrand } from "../../src/domain/items/api";

const mockListBrands = vi.mocked(listBrands);
const mockCreateBrand = vi.mocked(createBrand);

beforeEach(() => {
  vi.clearAllMocks();
  mockListBrands.mockResolvedValue([]);
});
```

For a component that uses TanStack Query (e.g. `usePaginatedQuery`):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

render(<MyComponent />, { wrapper: createWrapper() });
```

## Cross-platform note

Tests run in jsdom (Linux/Mac/Windows CI). No platform-specific code in tests.
Backend `#[cfg(target_os = "...")]` guards must be tested with `--target` in CI
(not currently configured — see `src-tauri/AGENTS.md` for the platform matrix).

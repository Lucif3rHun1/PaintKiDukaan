# Visual QA applicability matrix

This is the authoritative coverage map for visual-engineering waves. A row covers every listed route or phase, but only the role/state combinations marked applicable. Browser evidence uses deterministic fixtures; Tauri evidence uses a real local session and IPC. Browser-only fixture work must never mock or invoke Tauri.

## Global evidence contract

- **Browser owner:** layout, light/dark themes, 375/768/1280 widths, 200% zoom, long content, keyboard/focus order, reduced motion, and deterministic loading/empty/error/populated states.
- **Tauri owner:** authentication, authorization denial, persistence, native focus, scanner, printing, backup/restore, hardware discovery, filesystem, and real IPC outcomes.
- Every Browser-owned surface is captured in each applicable theme and viewport. Keyboard-only and reduced-motion runs may share a viewport when geometry is unchanged.
- Role notation: **O** owner, **C** cashier, **S** stocker, **Public** locked/no session.
- Shared primitive states are proven first at `#/__showcase` in development. Page fixtures then compose those states rather than redefining primitives.

## Foundation and security

| Surface | Route / phase | Roles | Applicable key states | Fixture strategy | Owner |
|---|---|---|---|---|---|
| Primitive showcase | `#/__showcase` (DEV only) | Public | Tier A interaction; Tier B semantic/loading/empty/error; Tier C composition; dense/focal; long content | Static exports from `src/dev/showcaseFixtures.ts`; no IPC or event subscriptions | Browser |
| Startup loading / fallback | `loading` | Public | bootstrap pending, route chunk loading, timeout copy | Deterministic delayed-boundary fixture | Browser + Tauri |
| First launch | `first-launch` | Public | choose fresh/restore; shop, PIN, recovery, inventory, PDE steps; invalid/loading/backend error | Per-step form fixtures; real setup only in disposable Tauri profile | Browser + Tauri |
| Unlock / switch user | `locked` | Public | owner/user selection; empty/valid/invalid PIN; submitting; wrong-attempt warning; lockout; wiped | Fixed users and clock in browser; real wrong/correct PIN, lockout, switch, idle lock in Tauri | Browser + Tauri |
| Recovery restore | `restore-recovery` | Public | passphrase step; new-PIN step; invalid/loading/backend error/success | Per-step deterministic form fixture; disposable encrypted backup in Tauri | Browser + Tauri |
| Keystore failure | `keystore-error` | Public | reason text; retry; erase confirm; erase loading/error | Static safe error strings; real keystore failure/erase only in disposable Tauri profile | Browser + Tauri |
| App shell / navigation | all unlocked hashes | O, C, S | expanded/collapsed/mobile nav; active/direct hash; hidden links; shortcut overlay; account menu; dirty-nav guard | Role-specific shell fixtures with fixed badges and long shop/user names | Browser + Tauri |

## Transactions and inventory

| Surface | Route / phase | Roles | Applicable key states | Fixture strategy | Owner |
|---|---|---|---|---|---|
| Dashboard | `#/` | O, C, S | loading/empty/error/populated; alerts; role-hidden metrics/actions; long names | Role-specific seeded dashboard snapshots; final wave repeats this row | Browser + Tauri |
| Sales list | `#/sales` | O, C | loading/empty/error/populated; search/filter/pagination; long bill/customer values | Fixed sale rows including cash/credit/FBill and long customer names | Browser + Tauri |
| New/edit sale | `#/sales/new`, `#/sales/edit/:id` | O, C | empty cart; search/scanner result; dense cart; validation; held bill; payment; dirty guard; submit/error | Fixed catalog/customer/cart/payment fixtures; scanner, hold/resume, save, print via Tauri | Browser + Tauri |
| Sale detail | `#/sales/:id` | O, C | loading/error/populated; long lines; payment status; editable/locked actions | Fixed complete sale with mixed units, discount, GST, and long notes | Browser + Tauri |
| Returns list/detail | `#/sales/return`, `#/sales/return/:id` | O, C | loading/empty/error/populated; search; long lines; status/action visibility | Fixed return summaries and one detailed return | Browser + Tauri |
| New return | `#/sales/return/new` | O, C | bill lookup; eligible/partial/invalid lines; totals; validation; submit/error | Fixed source bill and return quantities; real inventory reversal via Tauri | Browser + Tauri |
| Inward list/detail | `#/inward`, `#/inward/:id` | O, C | loading/empty/error/populated; search; long vendor/item values | Fixed inward summaries and one mixed-unit detail | Browser + Tauri |
| New inward | `#/inward/new` | O, C | empty/dense lines; item search/scanner; validation; totals; dirty guard; submit/error | Fixed vendor/catalog/packaging fixtures; real stock movement/scanner via Tauri | Browser + Tauri |
| Items | `#/items` | O, C, S | loading/empty/error/populated; search/filter/select; create/edit/archive; cost stripped; long SKU/name | Owner fixture includes cost/actions; cashier/stocker fixtures prove hidden/stripped fields | Browser + Tauri |
| Shade formulas | `#/formulas`, `#/formulas/:id` | O, C, S | loading/empty/error/populated; search; detail; create/edit visibility; long formula | Fixed formula list/detail with many tint lines; role-specific action fixture | Browser + Tauri |
| Barcode labels | `#/barcodes` | O, C, S | empty selection; search; populated batch; invalid/missing barcode; preview overflow; print error | Fixed label stock/item/barcode fixtures; printer path and physical stock via Tauri/Windows | Browser + Tauri |
| Reports | `#/reports/sales`, `/inventory`, `/customers` | O | loading/empty/error/populated; periods; chart/table overflow; export | Fixed period snapshots with textual summaries and long labels; export via Tauri | Browser + Tauri |
| Day close | `#/day-close` | O | unopened/ready; discrepancies; validation; confirm/loading/error/success; already closed | Fixed day totals and denomination variance; real close persistence via Tauri | Browser + Tauri |

## Parties and operations

| Surface | Route / phase | Roles | Applicable key states | Fixture strategy | Owner |
|---|---|---|---|---|---|
| Customers | `#/customers` plus create/edit/detail/payment dialogs | O, C | loading/empty/error/populated; search; ledger; validation; long address/name; payment confirm | Fixed balances, types, ledger rows, and form variants | Browser + Tauri |
| Vendors | `#/vendors` plus create/edit/detail/payment dialogs | O, C | loading/empty/error/populated; search; ledger; validation; long address/name; payment confirm | Fixed balances, ledger rows, and form variants | Browser + Tauri |
| Settings categories | `#/settings/{shop|catalog|printing|team|system}` | O | category populated; direct/invalid hash redirect; long descriptions | Static category metadata; navigation persistence via Tauri | Browser + Tauri |
| Shop settings | `#/settings/shop/{shop-info|currency}` | O | loading/populated; validation; dirty/saving/error/success | Fixed shop/GST/currency values including long address | Browser + Tauri |
| Catalog settings | `#/settings/catalog/{customer-types|locations|catalog}` | O | loading/empty/error/populated; create/edit/archive; duplicate/invalid | Fixed types, locations, brands, categories, and units | Browser + Tauri |
| Hardware / printing | `#/settings/printing/hardware` | O | no devices; discovering; populated; default selection; scanner test; errors | Static printer/scanner fixtures; discovery, spooler, scanner and physical output via Tauri/Windows | Browser + Tauri |
| Team and devices | `#/settings/team/{users|devices}` | O | loading/empty/error/populated; create/edit/disable; role changes; current device | Fixed role/device rows; authorization and enrollment persistence via Tauri | Browser + Tauri |
| Backup | `#/settings/system/backup` | O | never backed up; healthy/stale; running; success/error; restore confirmation | Fixed status/timestamps; filesystem backup/test/restore via Tauri | Browser + Tauri |
| Security settings | `#/settings/system/{security|owner-security}` | O | populated; invalid PIN/passphrase; saving/error/success; destructive confirm | Fixed policy/form states; real credential rotation and lock behavior via Tauri | Browser + Tauri |
| Theme settings | `#/settings/system/theme` | O | system/light/dark selected; persistence | Browser toggles all modes; persisted preference verified in Tauri | Browser + Tauri |
| Master health | `#/settings/system/master-health`, `#/health` | O | loading; healthy/warning/error; refresh; long diagnostic detail | Fixed mixed-severity checks; real diagnostics and recovery actions via Tauri | Browser + Tauri |
| Admin logs | `#/logs` | O | loading/empty/error/populated; filters; long/unbroken message; pagination/export | Fixed severity/source/timestamp rows with sanitized long messages | Browser + Tauri |

## Native acceptance ownership

The following cannot pass on browser fixtures alone: bootstrap and all security transitions; backend RBAC denial; scanner focus and scan events; receipt/label printing; printer discovery; backup/test/restore; file export; graceful quit/native focus; Windows spooler and physical printer/scanner output. macOS development may prove the documented PDF fallback, but Windows hardware evidence remains required for release acceptance.

# M1 Parallel Worktree Slices

> **Purpose**: Decompose M1.1–M1.16 into 4 parallel component slices so the user can spin up git worktrees and ship faster (per user direction m0145).
> **Authoritative source**: `/Users/lucif3rhun1/Windows/Files/Scripts/PaintKiDukaan/.omo/plans/paint-shop-master-plan.md` (Momus PASS).
> **Status**: Scaffold complete (M1.0a–M1.0d). Ready to slice.

---

## 0. Setup (do this once, in the main worktree, before slicing)

1. `cd /Users/lucif3rhun1/Windows/Files/Scripts/PaintKiDukaan`
2. `git init` (if not already a repo) and commit the current scaffold.
3. `git checkout -b main` if needed.
4. `git worktree add ../paintkiduakan-slice-A-db      -b slice/A/db`
5. `git worktree add ../paintkiduakan-slice-B-domain  -b slice/B/domain`
6. `git worktree add ../paintkiduakan-slice-C-pos     -b slice/C/pos`
7. `git worktree add ../paintkiduakan-slice-D-shell   -b slice/D/shell`

Each worktree shares the same Cargo workspace + Vite workspace — only the slice-owned files are edited in parallel.

---

## 1. Slice overview

| Slice | Path | Owns | Depends on | E-scenarios |
|---|---|---|---|---|
| **A. DB + Security** | `../paintkiduakan-slice-A-db` | `src-tauri/src/db/**`, `src-tauri/src/crypto/**`, `src-tauri/src/commands/auth.rs`, migrations SQL | scaffold only | DB1-DB6, E1-E5, E6-E13, E81-E88 |
| **B. Domain (items/vendors/customers/inventory)** | `../paintkiduakan-slice-B-domain` | `src-tauri/src/commands/items.rs`, `vendors.rs`, `customers.rs`, `locations.rs`, `customer_types.rs`, `src/domain/**` (TS) | Slice A (DB queries) | E14-E24, E-V1, E-V2, E-L1, E65-E66 |
| **C. POS (sales/inward/day-close/reports)** | `../paintkiduakan-slice-C-pos` | `src-tauri/src/commands/sales.rs`, `purchases.rs`, `day_close.rs`, `reports.rs`, `src/pos/**`, `src/print/**` (TS) | Slice A (DB), Slice B (item/customer reads) | E25-E30, E-IA1, E31-E46, E47-E52, E53-E56, E71-E73 |
| **D. Shell (scanner/hardening/settings/backup)** | `../paintkiduakan-slice-D-shell` | `src-tauri/src/scan.rs`, `src-tauri/src/backup.rs`, `src-tauri/src/hardening.rs`, `src-tauri/src/commands/settings.rs`, `src/shell/**` (TS) | Slice A (settings table), Slice C (uses scan target) | E57-E64, E67-E70, E74-E80, E-S1, E-S2, E-U1-E-U3 |

**Cross-slice contracts** (interfaces that all slices must respect — do not break):

```rust
// Slice A owns and exports (others import):
pub struct Db { conn: rusqlite::Connection, dek: Zeroizing<[u8; 32]> }
impl Db {
    pub fn open(path: &Path, dek: [u8; 32]) -> Result<Self>
    pub fn with_conn<F, R>(&self, f: F) -> R where F: FnOnce(&Connection) -> R
    pub fn with_conn_immediate<F, R>(&self, f: F) -> R where F: FnOnce(&Transaction) -> R
    pub fn dek(&self) -> &[u8; 32]  // for backup encryption
    pub fn backup_to(&self, dest_path: &Path) -> Result<()>
}
pub fn current_user(ctx: &AppHandle) -> Result<User>  // reads session from state
```

```ts
// Slice A owns and exports (TS):
export interface User { id: number; name: string; role: 'owner'|'cashier'|'stocker' }
export interface Session { user: User | null; locked: boolean }
```

```ts
// Slice B owns and exports (TS):
export interface Item { id: number; sku_code: string; name: string; brand?: string; category?: string;
  unit: 'L'|'ml'|'kg'|'g'|'pc'|'box'|'bundle'|'roll'|'sqft'|'sqm';
  pack_size?: string; units_per_box?: number; sell_unit: 'unit'|'box';
  retail_price: number; cost_price: number;
  label_line1?: string; label_line2?: string; location_text?: string;
  reorder_level: number; is_active: boolean }
export interface Customer { id: number; name: string; phone: string;
  type_id?: number; is_flagged: boolean; credit_limit?: number; opening_balance: number }
export interface Vendor { id: number; name: string; phone?: string; opening_balance: number }
```

```ts
// Slice C owns and exports (TS):
export interface Sale { id: number; no: string; customer_id?: number; date: string;
  status: 'quotation'|'final'; subtotal: number; bill_discount: number; total: number;
  paid_amount: number; payment_modes_json: { mode: string; amount: number }[]; user_id: number }
export interface Purchase { id: number; vendor_id?: number; date: string; total: number;
  user_id: number; items: PurchaseItem[] }
export interface DayClose { id: number; date: string; user_id: number; opening_cash: number;
  cash_sales: number; cash_in: number; cash_out: number; counted_cash: number;
  expected_cash: number; variance: number; notes?: string;
  backup_check_status: 'fresh'|'stale'|'skipped' }
```

```ts
// Slice D owns and exports (TS):
export interface ScanEvent { barcode: string; ts: number; terminator: 'enter'|'tab'|'stx'|'etx' }
export type ScanTarget = 'sales'|'inward'|'stocktake'|'locked'|null
export function setScanTarget(t: ScanTarget): void
export function onScanEvent(cb: (e: ScanEvent) => void): () => void
export interface MasterHealth { /* see plan §9.10 */ }
```

**Rule**: when a slice needs a new field/type from another slice's interface, it adds it to the interface (with default) and notifies — no breaking changes mid-slice.

---

## 2. Slice A — DB + Security (foundation; do this slice first or in parallel with B/C/D)

**Owner**: TBD (user)
**Worktree**: `../paintkiduakan-slice-A-db`
**Branch**: `slice/A/db`
**Plan references**: §4 (Security Model), §5.1 (Data Model), §5.2 (Migrations), §10.8 (Recovery), §10 (Backup format)

**Files to create**:
```
src-tauri/src/
  db/
    mod.rs                  # Db struct, open/close
    migrations.rs           # SQL embedded as &'static str
    keywrap.rs              # keywrap table read/write, KEK_owner / K_recovery derivation
    queries/
      mod.rs
      items.rs              # read-only stubs returning Vec<Item> (full impl in Slice B)
      sales.rs              # read-only stubs returning Vec<Sale> (full impl in Slice C)
  crypto/
    mod.rs                  # Argon2id helpers, AES-GCM wrap/unwrap
    kdf.rs                  # derive_pin_kek, derive_recovery_k, derive_backup_key
    wrap.rs                 # wrap_dek_with_kek, unwrap_dek_with_kek
  commands/
    mod.rs                  # tauri::generate_handler! export
    auth.rs                 # app_bootstrap, unlock, change_pin, set_recovery_passphrase
    recovery.rs             # new_device (recovery flow)

src/lib/security/
  pin.ts                    # touch numpad component for PIN entry
  lockScreen.tsx            # <LockScreen /> component
  firstLaunch.tsx           # <FirstLaunchWizard /> component
  state.ts                  # useSessionStore (Zustand), role-aware UI helpers
```

**Critical paths to implement**:

1. `db::Db::open` — sets up SQLCipher with key, runs migrations, sets PRAGMAs AFTER migrations.
2. `db::migrations` — embedded `&'static str` SQL per §5.1. Use `rusqlite_migration::Migrations` to apply.
3. `crypto::kdf` — `Argon2id(PIN, pin_salt, m=64MiB, t=2, p=1)` for PIN KEK; `Argon2id(passphrase, recovery_salt, m=256MiB, t=3, p=1)` for recovery.
4. `commands::auth::app_bootstrap` — returns `AppState { first_launch: bool, locked: bool, dek_present: bool }`. Replaces the current stub in `lib.rs`.
5. `commands::auth::unlock(pin: String)` — derives KEK_owner, attempts to unwrap DEK; on success, stores DEK in RAM, returns `Session`.
6. `commands::auth::set_recovery_passphrase(passphrase: String)` — derives K_recovery, re-wraps DEK.
7. `commands::auth::first_launch_setup(pin, passphrase, shop_name, address, phone)` — generates random DEK, wraps with PIN + recovery, creates owner user, creates settings row.
8. `db` triggers in migration: `stock_movements_ai` (maintains stock_balances), `stock_movements_bu` and `stock_movements_bd` (BEFORE UPDATE/DELETE → RAISE(ABORT), per Momus fix).
9. `commands::recovery::restore_from_recovery(passphrase: String)` — derives K_recovery, unwraps DEK, opens DB.
10. `state::AppState` (Tauri-managed) — `Mutex<Option<Db>>` for the unlocked DB; `Mutex<Option<Session>>` for current user; `Arc<AtomicU64>` for last-activity timestamp (for auto-lock).

**E-scenarios** (from plan §15):
- DB1: empty DB → migrations apply → schema matches §5.1.
- DB2: schema verification (all tables, indexes, triggers present).
- DB3: append-only enforcement — `UPDATE stock_movements` → fail; `DELETE` → fail (E88).
- DB4: trigger maintains stock_balances — insert movement, verify `stock_balances.qty` updates.
- DB5: lockouts table — 5 wrong PINs → row updated; after wipe action, table reset.
- DB6: settings singleton — `id=1` row exists; updates persist.
- E1-E5: first-launch wizard.
- E6-E10: lock + auto-lock.
- E11-E13: bad-PIN lockout.
- E81-E83: recovery new device.
- E84-E88: security negative tests.

**Out of scope for this slice** (others do):
- Sales/inward/day-close logic → Slice C
- Items/vendors/customers domain logic → Slice B
- Scanner, hardening, backup, settings UI → Slice D

**Touch points for integration**:
- Slice B's items/vendors/customers commands call `Db::with_conn`.
- Slice C's sales/purchases/day_close commands call `Db::with_conn_immediate` for transactional writes.
- Slice D's backup uses `Db::dek()` to get current DEK for snapshot.
- Slice D's hardening uses `Session` to enforce role gates.

**Merge order**: Slice A first. Then B, C, D can merge in any order (no compile-time circular deps).

---

## 3. Slice B — Domain (items, vendors, customers, locations, customer_types)

**Owner**: TBD
**Worktree**: `../paintkiduakan-slice-B-domain`
**Branch**: `slice/B/domain`
**Plan references**: §5.1 (tables), §7.1 (Inventory), §7.4 (Customers), §7.5 (Reports), §7.7 (Settings)

**Files to create**:
```
src-tauri/src/commands/
  items.rs                  # CRUD: create_item, update_item, list_items, lookup_item, get_item
  locations.rs              # CRUD: list_locations, create_location, rename_location, deactivate
  vendors.rs                # CRUD: create_vendor, list_vendors, get_vendor, record_vendor_payment, vendor_outstanding
  customers.rs              # CRUD: create_customer, update_customer, lookup_customer, customer_outstanding
  customer_types.rs         # CRUD: list_types, add_type, rename_type, deactivate_type

src/domain/
  items/
    api.ts                  # typed wrapper around invoke('list_items'), invoke('lookup_item'), etc.
    ItemForm.tsx            # <ItemForm mode='create'|'edit' />
    ItemList.tsx            # <ItemList /> grouped by brand/category
    ItemDetail.tsx          # <ItemDetail /> with print-barcode button
    LocationAutocomplete.tsx # <LocationAutocomplete /> with datalist
  customers/
    api.ts
    CustomerForm.tsx
    CustomerList.tsx
    CustomerDetail.tsx
    KhataRecord.tsx
  vendors/
    api.ts
    VendorForm.tsx
    VendorList.tsx
    VendorPaymentForm.tsx
  customerTypes/
    api.ts
    ManageTypes.tsx
```

**Critical paths to implement**:

1. `commands::items::create_item` — mints next SKU from `sequences.sku`; validates phone-not-used; sets `barcode = sku_code` by default.
2. `commands::items::lookup_item(scope: ItemScope)` — owner sees all fields, cashier sees only `(name, in_stock, location_text)`, stocker sees `(name, location_text, qty_per_loc)`. **Server-side role check.**
3. `commands::items::list_items(filter: ItemFilter)` — supports name/barcode/sku search, brand/category group, low-stock toggle.
4. `commands::items::box_unit_conversion` — helper: `qty_in_sell_unit * units_per_box` → base units.
5. `commands::locations::*` — soft rename (no hard delete); preserves FK.
6. `commands::customers::*` — phone validation `^[6-9]\d{9}$`; uniqueness check; `is_flagged` only settable by owner.
7. `commands::customers::customer_outstanding(id)` — `opening_balance + Σ(sales.total - sales.paid_amount) - Σ(customer_payments.amount)`. No aging buckets (M3).
8. `commands::vendors::record_vendor_payment` — `INSERT INTO vendor_payments`, returns updated outstanding.
9. `commands::vendors::vendor_outstanding` — `opening_balance + Σ(purchases.total) - Σ(vendor_payments.amount)`.
10. `commands::customer_types::add_type` — checks uniqueness; can be added to at runtime.

**E-scenarios**:
- E14-E19: Items CRUD + per-item location_text.
- E20-E24: Box/unit conversion.
- E-V1, E-V2: Vendors + payments.
- E-U1-E-U3: Users (but auth flow is Slice A; this slice doesn't own user CRUD UI beyond admin listing — Slice D owns Settings UI).
- E-L1: Locations CRUD.
- E65-E66: Customer types.

**Out of scope**:
- Sales/purchase flows (Slice C).
- Settings UI, hardening, scanner (Slice D).
- Auth flow itself (Slice A).

**Touch points**:
- Reads/writes `items`, `customers`, `vendors`, `locations`, `customer_types` tables via `Db::with_conn`.
- Exports `Item`, `Customer`, `Vendor` TS interfaces.

**Merge order**: After Slice A. No dependency on C or D.

---

## 4. Slice C — POS (sales, purchases, day-close, reports, print)

**Owner**: TBD
**Worktree**: `../paintkiduakan-slice-C-pos`
**Branch**: `slice/C/pos`
**Plan references**: §5.1 (sales, purchase, sale_items, purchase_items, day_close), §7.2 (Inward), §7.3 (Sales/POS), §7.5 (Reports), §7.6 (Day Close), §8.9 (Scanner target)

**Files to create**:
```
src-tauri/src/commands/
  sales.rs                  # create_quotation, create_final_bill, convert_quotation, cancel_sale
  purchases.rs              # create_inward, list_purchases, vendor_payables
  day_close.rs              # trigger_day_close, get_day_close, list_day_closes
  reports.rs                # daily_sales, stock_report, outstanding_report, low_stock
  sequences.rs              # mint_next_sale_no, mint_next_sku

src/pos/
  sales/
    api.ts
    SalesScreen.tsx         # <SalesScreen /> toggle Quotation|Final
    Cart.tsx                # <Cart /> line items, bill discount, payment split
    LineItem.tsx
    CustomerPicker.tsx      # <CustomerPicker /> search-by-phone + walk-in
    PaymentSplit.tsx        # <PaymentSplit /> per-tender UI
    FlaggedBanner.tsx       # <FlaggedBanner /> warning for is_flagged=1
  purchases/
    api.ts
    InwardScreen.tsx        # <InwardScreen /> with sticky cost
    PurchaseItemRow.tsx
    UnknownBarcodeModal.tsx # inline create on unknown scan
  dayClose/
    api.ts
    DayCloseScreen.tsx
    BackupGatePrompt.tsx    # "Back up & close / Skip once / Cancel close"
  reports/
    api.ts
    DailySalesReport.tsx
    StockReport.tsx
    OutstandingReport.tsx
  heldBills/
    api.ts
    HeldBillsPanel.tsx
    HoldCartModal.tsx
  print/
    receiptPdf.ts           # A4 receipt via jsPDF
    labelPdf.ts             # 50x25mm Code128 label via jsPDF
    print.ts                # window.print() helper
```

**Critical paths to implement**:

1. `commands::sequences::mint_next_sale_no(kind: 'quotation'|'final')` — `UPDATE sequences SET last_value = last_value + 1 WHERE name IN ('sale_inv','sale_qtn') RETURNING last_value`; format as `INV-{YYYY}-{seq:04}`.
2. `commands::sales::create_final_bill` — wrap in `TransactionBehavior::Immediate`:
   - Validate paid_amount rules (per §7.3):
     - Walk-in or `credit_limit IS NULL OR =0` → `paid_amount == total` else error.
     - Customer attached with `credit_limit > 0` → `paid_amount ∈ [0, total]`.
   - Insert `sales` row.
   - Insert `sale_items` rows.
   - Insert `stock_movements` rows with `type='sale'`, `qty = -line_qty_base_units`.
   - All atomic.
3. `commands::sales::create_quotation` — same as above but `status='quotation'`, no stock movements, `validity_days` default 7.
4. `commands::sales::convert_quotation(id)` — set `status='final'`, mint new INV-no, create stock movements, link `converted_from_id`.
5. `commands::purchases::create_inward` — same atomic pattern: insert `purchases`, `purchase_items`, `stock_movements` with `type='inward'`, `qty=+line_qty`.
6. `commands::purchases::sticky_cost` — frontend tracks last item_id+cost across lines; backend takes cost from request payload.
7. `commands::day_close::trigger_day_close` — compute `cash_sales = Σ(payment_modes_json where mode='cash' for this user/date)`, compute `expected_cash = opening + cash_sales + cash_in - cash_out`, write `day_close` row.
8. `commands::day_close::backup_gate_check` — returns `(needs_prompt: bool, age_hours: i64)` based on `settings.last_backup_at`.
9. `commands::reports::daily_sales` — range filter, group by date, sum totals/discounts.
10. `commands::reports::outstanding_report` — list customers with `outstanding > 0`; no aging buckets (M3).
11. `print::labelPdf` — jsPDF, 50×25mm landscape, `JsBarcode` Code128 + `label_line1` + `label_line2`.
12. `print::receiptPdf` — jsPDF, A4 portrait, shop header from `settings`, sale details, payment breakdown.

**E-scenarios**:
- E25-E30: Inward (with sticky cost, unknown barcode inline create, auto-print).
- E-IA1: Inward auto-print toggle.
- E31-E35: Quotation.
- E36-E40: Final bill, credit rules.
- E41, E42, E42b: Flagged customer.
- E43, E44: Khata.
- E45, E46: Hold/park bill.
- E47-E52: Day close.
- E53-E56: Reports.
- E71-E73: Print labels + receipts.

**Out of scope**:
- Auth, DB, crypto (Slice A).
- Items/vendors/customers CRUD (Slice B; this slice reads from them).
- Scanner global hook (Slice D; this slice consumes `setScanTarget` + `onScanEvent`).
- Backup trigger, settings UI, hardening (Slice D).

**Touch points**:
- Imports `Db` from Slice A.
- Imports `Item`, `Customer`, `Vendor` types from Slice B (read-only).
- Imports `setScanTarget`, `onScanEvent` from Slice D.
- Writes `sales`, `sale_items`, `purchases`, `purchase_items`, `day_close`, `sequences` tables.

**Merge order**: After Slice A. Independent of B (read-only uses) and D (scan target is just a setter; works even if D isn't merged yet, just routes to nowhere).

---

## 5. Slice D — Shell (scanner, hardening, settings, backup, recovery)

**Owner**: TBD
**Worktree**: `../paintkiduakan-slice-D-shell`
**Branch**: `slice/D/shell`
**Plan references**: §8.9 (Scanner), §9 (Production Hardening), §10 (Backup & Recovery), §7.7 (Settings UI)

**Files to create**:
```
src-tauri/src/
  scan.rs                   # rdev global listener, emits "barcode:scan" event
  backup.rs                 # PKB1 envelope format, snapshot via rusqlite::backup, encrypt with Argon2id(recovery_pass, backup_salt)
  hardening.rs              # autostart, powercfg, single-instance, tray, WebView2 check, BitLocker check, Master Health
  commands/
    settings.rs             # get_setting, set_setting, list_users (admin view), create_user, reset_pin, etc.
    backup.rs               # backup_now, restore, test_restore, list_targets

src/shell/
  routes/
    App.tsx                 # routes for first-launch, lock, unlocked
    Dashboard.tsx           # owner home
    Settings.tsx            # <Settings /> with tabs: Shop, Label, Receipt, Users, Devices, Locations, Customer Types, Backup, Security, Scanner, Master Health
    AdminLogs.tsx           # /admin/logs route (dev)
  components/
    Numpad.tsx              # touch numpad
    BarcodeInput.tsx
    ConfirmDialog.tsx
    EmptyState.tsx
    SkeletonRow.tsx
  store/
    scanTarget.ts           # Zustand: { target: 'sales'|'inward'|'stocktake'|'locked'|null }
    session.ts              # current user, lock state
  hooks/
    useIdleLock.ts          # 5-min auto-lock (configurable)
    useScanTarget.ts        # set target on route mount
  health/
    api.ts
    MasterHealthPage.tsx
  backup/
    api.ts
    BackupPanel.tsx
    RestoreDialog.tsx
```

**Critical paths to implement**:

1. `scan::init` — `rdev::listen` in a tokio task; emit `barcode:scan` event on detection per §8.9 rule. Detection logic is extracted into a pure `evaluate_scan(...)` function for unit testing; Shift-key state is tracked so uppercase barcode characters are accepted.
2. `scan::set_target(target: ScanTarget)` — Tauri command; stores in state.
3. `backup::snapshot_and_encrypt(dek, dest_path, recovery_passphrase)`:
   - `rusqlite::Connection::backup` to a `NamedTempFile` in the OS temporary directory.
   - Open temp with same DEK.
   - Encrypt with AES-256-GCM using `Argon2id(recovery_passphrase, backup_salt)`.
   - Write PKB1 envelope (per §10.1).
   - Compute `ciphertext_sha256` for trailer.
   - Zeroize the recovery passphrase immediately after encryption.
4. `backup::decrypt_and_verify(path, recovery_passphrase)`:
   - Read header, verify magic + ciphertext SHA-256.
   - Decrypt body to a `NamedTempFile` in the OS temporary directory.
   - Open temp SQLCipher, run `PRAGMA quick_check`.
   - Return temp path.
5. `backup::atomic_swap(temp_path)` — moves live → `.prev`, temp → live, reopens DB; falls back to copy+remove when `fs::rename` cannot cross filesystems.
6. `backup::test_restore(path, recovery_passphrase)` — runs full restore path to a separate `NamedTempFile`, verifies `quick_check`, deletes temp, updates `last_test_restore_at`, and zeroizes the recovery passphrase.
7. `hardening::autostart_enable` / `autostart_disable` — `tauri-plugin-autostart`.
8. `hardening::prevent_sleep` — PowerShell `powercfg /change standby-timeout-ac 0`, etc.
9. `hardening::single_instance` — `tauri-plugin-single-instance` (register early in builder).
10. `hardening::tray_menu` — `tauri::tray::TrayIconBuilder` with Show / Lock now (calls `LockWorkStation` via Win32) / Quit.
11. `hardening::bitlocker_status` — `powershell Get-BitLockerVolume -MountPoint C:`.
12. `hardening::master_health` — aggregates all of the above.
13. `commands::settings::*` — full CRUD on settings, users, devices, locations, customer_types (admin UI). User PINs are hashed with Argon2id (m=64 MiB, t=2, p=1) and stored as PHC strings (salt embedded). Device IDs are cryptographically random 16-character hex strings.
14. `commands::settings::reset_pin` — owner-only, re-hashes the PIN with Argon2id and replaces the stored PHC verifier.
15. `commands::settings::verify_pin` — constant-time PIN verification for login/unlock flows.
15. `commands::backup::backup_now` → calls `backup::snapshot_and_encrypt`. `commands::backup::restore` → calls decrypt + atomic_swap.

**E-scenarios**:
- E57-E64: Backup/restore + test restore.
- E67-E70: Scanner wedge.
- E74-E80: Production hardening.
- E-S1, E-S2: Settings persistence.
- E-U1, E-U2, E-U3: Users CRUD + PIN reset (backend here, UI in Settings).
- E89, E90: Localization (Intl.NumberFormat en-IN, dd/mm/yyyy).

**Out of scope**:
- DB schema, crypto primitives (Slice A).
- Items/vendors/customers domain (Slice B).
- POS flows (Slice C).

**Touch points**:
- Reads `settings` table for config (Slice A owns schema).
- Reads `Db::dek()` for backup (Slice A).
- `setScanTarget` consumed by Slice C routes.
- `onScanEvent` consumed by Slice C components (cart, inward line, stocktake row).

**Merge order**: After Slice A. Independent of B. Scan target works without C; C just doesn't react until merged.

---

## 6. Integration points summary

| Source | Exports | Consumed by |
|---|---|---|
| Slice A | `Db`, `AppState`, `Session`, `User`, `current_user()` | B, C, D |
| Slice B | `Item`, `Customer`, `Vendor` (TS types) | C (read), D (settings/admin) |
| Slice C | `Sale`, `Purchase`, `DayClose` (TS types) | D (reports, master health) |
| Slice D | `setScanTarget`, `onScanEvent`, `MasterHealth`, `useIdleLock` | C (consumes scan), A (consumes idle lock signal) |

**No circular deps at the module level**. Slices can be merged in any order after A.

---

## 7. M1 verification (per slice, then integration)

After each slice merges to main:

```bash
# Slice A
cd /Users/lucif3rhun1/Windows/Files/Scripts/PaintKiDukaan
cargo test --manifest-path src-tauri/Cargo.toml  # Rust unit tests
pnpm tsc --noEmit                                # TS still compiles
cargo check --manifest-path src-tauri/Cargo.toml # build clean
# E2E: launch app, verify first-launch wizard, lock, recovery
```

Same pattern for B, C, D. After all merged:

```bash
# Integration
cargo build --release --manifest-path src-tauri/Cargo.toml
pnpm build
# E2E: run full E1-E90 scenarios from plan §15
```

---

## 8. Git workflow (per slice owner)

```bash
# In your slice worktree
git checkout slice/A/db   # or B/C/D
# ... make changes ...
git add -A
git commit -m "slice A: SQLCipher init + keywrap + auth commands"
git push origin slice/A/db
# Open PR: slice/A/db → main
# After CI green + code review: squash-merge to main
```

**One PR per slice**. Don't mix.

---

## 9. Risks / open issues

1. **WebView2 install mode** (currently `downloadBootstrapper` for dev). For production offline master, need `fixedRuntime` + explicit `path` to bundled WebView2. Track as Slice D hardening polish.
2. **SQLCipher on Windows**: `bundled-sqlcipher` is Unix-only. For Windows .msi build (M1.SHIP), need vcpkg or system install + env vars (`SQLCIPHER_LIB_DIR`, `SQLCIPHER_INCLUDE_DIR`).
3. **Scanner on Windows**: `rdev` works without admin per docs, but needs testing on the actual kiosk laptop. Slice D should include a manual smoke test in E74.
4. **PowerShell elevation**: `powercfg` may need admin on first run. Slice D should detect and surface a banner if not admin.
5. **mDNS** is in plan §3 but M1 doesn't need it (master-only). Defer to M2.

---

## 10. M1 sign-off (after all slices merged)

- [ ] `cargo test` passes (Rust unit tests in Slice A: append-only, KDF, AES-GCM wrap/unwrap, sequence gap, backup envelope)
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm vitest run` passes (if any TS unit tests added)
- [ ] `pnpm build` produces `dist/`
- [ ] `cargo build --release` produces `target/release/paintkiduakan-master.exe`
- [ ] `cargo tauri build` produces `.msi` installer (Windows host)
- [ ] E1-E90 manual scenarios pass per plan §15
- [ ] DB1-DB6 pass
- [ ] S1-S5 pass
- [ ] `.msi` installs on Windows 11
- [ ] First-launch wizard works
- [ ] Lock screen + auto-lock + bad-PIN lockout work
- [ ] Backup → restore round-trip works
- [ ] Test restore works
- [ ] BitLocker, autostart, single-instance, tray all verified

**Then**: M1 done. Ready for M2 (mTLS + Android client).

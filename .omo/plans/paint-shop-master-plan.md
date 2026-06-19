# PaintKiDukaan — Master Plan v1 (Spec-Strict)

> **Spec authority**: `/Users/lucif3rhun1/Downloads/paint-shop-master-spec-v2.md` (read in full, 2026-06-19).
> **Locked decisions**: see §0.
> **Out of v1 (Deferred §13)**: anything not in spec or not explicitly approved.

---

## 0. Locked Decisions (Interview Log)

All decisions are final. Reversing any requires explicit user re-confirmation.

| # | Decision | Locked at |
|---|---|---|
| 0.1 | Strict 4-milestone spec order. M1 master-only Windows; M2 adds Android client | b1 |
| 0.2 | Currency INR (₹), `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})` — keep paise, no round-off | b1 |
| 0.3 | Customer phone: 10-digit Indian mobile, `/^[6-9]\d{9}$/`, unique per customer, search by 4–10 digits | b1 |
| 0.4 | Owner PIN: 6-digit, 5 wrong → configurable (timeout lockout OR auto-erase/wipe, settings) | b1 |
| 0.5 | Cashier/Stocker PIN: 4 OR 6 digit (their choice) | b1 |
| 0.6 | Idle auto-lock: 5 min (zeroizes RAM keys) | b1 |
| 0.7 | Master discovery: mDNS primary (`master.local`), manual IP + QR fallback, first-launch wizard | b1 |
| 0.8 | Print: Bills = A4 paper via `window.print()`; SKU labels = 50×25mm thermal landscape via jsPDF. No ESC/POS in v1. | b1 |
| 0.9 | Label default: 50×25mm landscape | b1 |
| 0.10 | Flagged customer: cashier sees `⚠️ Outstanding ₹X` at bill attach, must confirm to proceed (no block) | b1 |
| 0.11 | Argon2id: PIN 64 MiB / t=2 / p=1; Recovery 256 MiB / t=3 / p=1 | b1 |
| 0.12 | Bill number: `INV-{YYYY}-{seq:04}` master-issued, monotonic, gap-tracked. Quotation: `QTN-{YYYY}-{seq:04}` | b1 |
| 0.13 | Quotation validity: 7 days default, configurable per-quote | b1 |
| 0.14 | Backup password = `Argon2id(recovery_passphrase, backup_salt)` (user accepted single-point-of-failure risk m0044) | m0026, m0044 |
| 0.15 | Backup schedule: manual always; auto-prompt at day-close if `last_backup_at` is null or >24h. Day close blocks until owner confirms backup or "skip once" (recorded in `day_close.notes`). | m0026 |
| 0.16 | Day close lock: per-user. Cashier's day close locks for that cashier only. Owner can always edit (audit via `stock_movements`). | m0026 |
| 0.17 | Customer type: `customer_types` lookup table seeded with `retail / painter / contractor / dealer`. Settings → "Manage types" (add/rename/deactivate). Owner-expandable without code change. | m0026 |
| 0.18 | Per-item `location_text` (free-text, optional, nullable). Different from `locations` table (Shop/Godown). HTML `<datalist>` autocomplete from existing distinct values. Visible in item detail, lookup, sale line, stock-take. | m0031 |
| 0.19 | Box-to-unit conversion: `items.units_per_box INTEGER NULL`, `items.sell_unit TEXT DEFAULT 'unit'` ('box' or 'unit'). Sale/inward lines: pick unit, enter qty; stock movement always records in base units (`qty * units_per_box` if box). UI shows both ("5 boxes (50 buckets)"). Label prints in `sell_unit`. | m0037 |
| 0.20 | Shade optional: no `shade_code` on items. `sale_items.shade_note` is OPTIONAL text. Counter tints manually. Customer history saves shade_note when entered. | m0037 |
| 0.21 | Tauri updater: SKIPPED for v1 (out-of-scope per user direction). Manual MSI install + recovery flow. | b6 |
| 0.22 | No Tally export, UPI QR, WhatsApp share, HSN codes, GSTIN, logo/letterhead, multi-language, DPDP consent, audit_log table, self-check page. All in §13 Deferred. | m0024 |

**Sensible defaults (locked without asking)**:
- Time zone: `Asia/Kolkata` (uses `Intl.DateTimeFormat('en-IN', {timeZone:'Asia/Kolkata'})` for display; DB stores UTC)
- Customer name: single field
- Brand/category: free-text fields on items, grouped in UI
- Stock-adjustment reasons: `damage / theft / miscount / other` (typed enum, `other` requires notes)
- Day close: manual trigger, anytime, per-user (16), per-tender variance computed (not stored)
- Reports: default "today" + "this month" + custom range
- Multiple cashiers OK; `sales.no` is master-issued sequence
- mTLS enrollment: owner approves; device generates keypair, stores privkey in OS keychain (DPAPI Windows, Keystore Android via Tauri stronghold)
- mTLS device cert mapping: `SHA-256(cert_DER)` fingerprint → `devices.pubkey_fingerprint`
- Receipt: keep paise, no round-off. No logo, no T&Cs footer.
- Per-tender payment reference: skip (no cheque no, no UPI txn id)
- Day-close opening cash: manual entry + carry-from-last-close option (default: carry)

---

## 1. Overview

**PaintKiDukaan** is a single-shop LAN-only paint-shop management system. The shop laptop is the **master**; cashier tablet and godown phone are thin **client** terminals that talk to the master over the local wifi. The master is the only thing that holds a database. Clients hold nothing but their device cert in OS keychain.

**Three roles** (device-bound, per-person PINs):
- **Owner** — full access; can override anything; sets up shop, users, devices, locations, items, customers, vendors, backups, recovery
- **Cashier** — POS billing, quotations, day-close, customer attach (no stock qty/cost/margin visible, just `in_stock` flag + `location_text`)
- **Stocker** — stock-take, Shop↔Godown transfers, adjustment (no retail price, no customer data)

**Threat model honest** (per spec §5): protects against stolen disk/DB, role data leakage, wifi sniffing, unenrolled devices, direct DB inspection. **Does NOT** protect against attacker with OS-level control of running unlocked master. Therefore: OS full-disk encryption (BitLocker) on, physical owner-only access, auto-lock.

---

## 2. Architecture & Topology

```
┌──────────────────┐                                    ┌──────────────────────┐
│  MASTER (Win)    │                                    │ CLIENT (Android)     │
│  Tauri 2 + axum  │  ◀──── mTLS over LAN (port NNNN) ──▶│  Tauri 2 + React     │
│  SQLCipher DB    │                                    │  RAM-only state      │
│  mDNS master.local│                                    │  Device cert in KStore│
└──────────────────┘                                    └──────────────────────┘
       ▲                                                          ▲
       │  Same wifi (single AP, no internet needed)               │
       └──────────────────────────────────────────────────────────┘
                          (no clients M1; live in M2)
```

- **Master never leaves** the shop. Battery-as-UPS, never-sleep on lid close, auto-launch on boot.
- **Clients are RAM-only**: state, cached item names, drafts — all in memory. Only the device cert (privkey) persists, in OS keychain.
- **Network**: mDNS primary, manual IP + QR fallback. First-launch wizard on each client offers both.
- **No internet required** for runtime. Internet only for Google Drive backup (optional, mTLS over LAN otherwise).

---

## 3. Tech Stack (pinned, June 2026)

### 3.1 Frontend (shared master + client)
```jsonc
// package.json
{
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "typescript": "6.0.3",
    "vite": "8.0.16",
    "@vitejs/plugin-react": "6.0.2",
    "tailwindcss": "4.3.1",
    "@tailwindcss/vite": "4.3.1",
    "shadcn": "4.11.0",
    "react-hook-form": "7.79.0",
    "@hookform/resolvers": "5.4.0",
    "zod": "4.4.3",
    "@tanstack/react-query": "5.101.0",
    "@tanstack/react-router": "1.170.16",
    "zustand": "5.0.14",
    "lucide-react": "1.21.0",
    "jsbarcode": "3.12.3",
    "@zxing/browser": "0.2.0",
    "jspdf": "4.2.1"
  },
  "devDependencies": {
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3"
  }
}
```

### 3.2 Rust (master + client, Tauri core)
```toml
# Cargo.toml workspace members: src-tauri (shared lib), master, client
[workspace.dependencies]
tauri = { version = "2.10", features = ["tray-icon"] }
tauri-plugin-autostart = "2.5.1"
tauri-plugin-single-instance = "2.4.2"
tauri-plugin-global-shortcut = "2.3.2"
tauri-plugin-log = "2.9.0"
tauri-plugin-oauth = "2.0.0"          # Drive OAuth
tauri-plugin-keyring-store = "0.2.0"  # device cert privkey + Drive refresh token
rdev = "0.5.3"                         # global barcode wedge (desktop)
rusqlite = { version = "0.40.1", features = ["bundled-sqlcipher", "backup"] }
rusqlite_migration = "2.6.0"
argon2 = { version = "0.5.3", features = ["zeroize"] }
aes-gcm = "0.10.3"
zeroize = { version = "1.8.2", features = ["derive"] }
password-hash = "0.5"
rand_core = "0.6"
axum = "0.8.9"
axum-server = { version = "0.8.0", features = ["tls-rustls"] }
axum-server-mtls = "0.1.2"
rustls = { version = "0.23.40", default-features = false, features = ["aws_lc_rs"] }
rcgen = "0.14.8"                       # CA + device cert generation
mdns-sd = "0.20.0"                     # pure Rust mDNS, beta but works
sha2 = "0.10"
hex = "0.4"
chrono = { version = "0.4", features = ["serde"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
tokio-cron-scheduler = "0.15.1"        # only if scheduled backup enabled
anyhow = "1"
thiserror = "1"
```

**SQLCipher Windows caveat**: `bundled-sqlcipher` is Unix-only. On Windows, link against system SQLCipher 4.16.0 (vcpkg or manual install) via `SQLCIPHER_LIB_DIR` / `SQLCIPHER_INCLUDE_DIR` env vars during `cargo build`.

### 3.3 Build / packaging
- Tauri `bundle.targets = ["msi", "nsis"]` for Windows; `"apk"` for Android
- `bundle.windows.webviewInstallMode.type = "fixedRuntime"` (offline-friendly)
- MSI/NSIS bundle ID: `in.paintkiduakan.master`
- APK package: `in.paintkiduakan.client`

---

## 4. Security Model

### 4.1 Key hierarchy

```
                    ┌──────────────────────┐
                    │  Recovery passphrase │  (long, owner remembers, NEVER on disk)
                    └──────────┬───────────┘
                               │ Argon2id(passphrase, recovery_salt) 256MiB/t=3/p=1
                               ▼
                       K_recovery (32B)
                               │
                               ├──► Unwrap DEK (full DB recovery, new device)
                               │
                               └──► Argon2id(passphrase, backup_salt) → backup_key
                                    └─► AES-256-GCM backup blob encryption

                    ┌──────────────────────┐
                    │    Owner PIN (6d)    │  (daily unlock)
                    └──────────┬───────────┘
                               │ Argon2id(PIN, pin_salt) 64MiB/t=2/p=1
                               ▼
                       KEK_owner (32B)
                               │
                               └──► Wrap/unwrap DEK (during unlock, change PIN)

                    ┌──────────────────────┐
                    │   DEK (32B random)   │  (SQLCipher DB key)
                    └──────────────────────┘
                               │
                               ├──► Stored on disk as Argon2id-wrapped blob
                               ├──► In RAM only while unlocked
                               └──► Zeroized on idle/lock/exit
```

### 4.2 On disk
- Argon2id verifiers (PIN + recovery)
- Wrapped DEK (both KEK_owner-wrapped and K_recovery-wrapped variants)
- Wrapped mTLS device-cert private keys (per-device)
- `recovery_salt`, `pin_salt`, `backup_salt` (all 16 bytes random)
- **NEVER** PINs, recovery passphrase, or unwrapped DEK

### 4.3 In RAM (only while unlocked)
- DEK
- Session mTLS key
- Decryption keys for transient blobs
- **Zeroize** on:
  - Idle auto-lock (5 min, 0.9)
  - Manual "Lock now" (tray menu / Ctrl+L)
  - Window close
  - App exit

### 4.4 Lockout / backoff
- 5 wrong PINs → configurable action (Settings → Security):
  - **Timeout lockout** (default 15 min, exponential: 15 → 30 → 60 → 240 → 1440 min)
  - **Auto-erase/wipe** (DB + keys destroyed; needs recovery passphrase to rebuild)
- Configurable per owner preference; same option applies to owner + cashier + stocker

### 4.5 mTLS device enrollment
1. Owner generates CA cert (first launch, `rcgen`).
2. Owner approves new device in Settings → Devices.
3. Device generates keypair, sends CSR to master.
4. Master signs device cert with CA, stores `pubkey_fingerprint = SHA-256(cert_DER)`.
5. Device stores privkey in OS keychain (DPAPI Windows, Keystore Android via Tauri stronghold).
6. Master mTLS allow-list: only enrolled certs accepted.
7. Owner can revoke any device → cert removed from allow-list.

### 4.6 Recovery on new device (M1)
- Detected at app start: no local `devices.privkey_blob` found OR DB unwrappable with current PIN salt.
- "New Master Device" wizard: enter recovery passphrase → unwrap DEK → set new owner PIN → re-enroll this laptop as master.
- For full client re-enrollment, M2: revoke old device certs, force re-enroll.

### 4.7 No unattended auto-unlock
- App never auto-unlocks. PIN is always required.
- Tray menu has no "unlock" action; only "Show window" and "Lock now" (which locks, doesn't unlock).

---

## 5. Data Model

All tables per spec §6. Schema below is the canonical SQLite (via rusqlite) DDL.

### 5.1 Core tables

```sql
-- Locations (Shop, Godown by default; owner can rename)
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rack TEXT,                  -- optional default rack hint for this location
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Devices
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                                  -- e.g. "Cashier Tablet 1"
  role TEXT NOT NULL CHECK(role IN ('owner','cashier','stocker')),
  pubkey_fingerprint TEXT NOT NULL UNIQUE,             -- SHA-256(cert_DER) hex
  cert_pem TEXT NOT NULL,                              -- issued cert
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  enrolled_by INTEGER NOT NULL REFERENCES users(id),
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

-- Users
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','cashier','stocker')),
  pin_salt BLOB NOT NULL,                              -- 16B
  pin_verifier BLOB NOT NULL,                          -- Argon2id hash
  pin_length INTEGER NOT NULL CHECK(pin_length IN (4,6)),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_users_name ON users(name) WHERE active = 1;

-- Key-wrapping metadata lives in a separate UNENCRYPTED SQLite sidecar file
-- `<db_path>.keystore` (single row, system). Keeping it outside the SQLCipher
-- main DB avoids a bootstrap chicken-and-egg problem: we must read the wrapped
-- DEK before we can derive the SQLCipher key to open the main database.
--
-- Sidecar `keywrap` table schema:
--   id INTEGER PRIMARY KEY CHECK(id = 1),
--   pin_salt BLOB NOT NULL,                            -- 16B
--   pin_params BLOB NOT NULL,                          -- JSON Argon2id params
--   pin_wrapped_dek BLOB NOT NULL,                     -- AES-GCM(DEK, KEK_PIN)
--   rec_salt BLOB NOT NULL,                            -- 16B
--   rec_params BLOB NOT NULL,                          -- JSON Argon2id params
--   rec_wrapped_dek BLOB NOT NULL,                     -- AES-GCM(DEK, KEK_recovery)
--   backup_salt BLOB NOT NULL,                         -- 16B
--   version INTEGER NOT NULL DEFAULT 1,
--   created_at INTEGER NOT NULL,                       -- unix seconds
--   updated_at INTEGER NOT NULL                        -- unix seconds
-- )

-- Lockout state
CREATE TABLE lockouts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                                   -- ISO timestamp
  wipe_on_next_fail INTEGER NOT NULL DEFAULT 0
);

-- Customer types (lookup)
CREATE TABLE customer_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                           -- retail, painter, contractor, dealer, ...
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO customer_types(name) VALUES ('retail'),('painter'),('contractor'),('dealer');

-- Customers
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,                                 -- 10-digit, /^[6-9]\d{9}$/
  type_id INTEGER REFERENCES customer_types(id),
  is_flagged INTEGER NOT NULL DEFAULT 0,               -- owner toggle, cashier sees warning
  credit_limit INTEGER,                                -- paise (NULL = no credit)
  opening_balance INTEGER NOT NULL DEFAULT 0,          -- paise
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_name ON customers(name);

-- Vendors
CREATE TABLE vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  opening_balance INTEGER NOT NULL DEFAULT 0,          -- paise
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Items
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,                       -- master-issued Code128
  barcode TEXT,                                        -- usually same as sku_code; nullable for items w/o barcode
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  unit TEXT NOT NULL CHECK(unit IN ('L','ml','kg','g','pc','box','bundle','roll','sqft','sqm')),
  pack_size TEXT,                                      -- e.g. "1L", "4L", "10L", "drum"; free-text
  units_per_box INTEGER,                               -- m0037: NULL unless box-pack item
  sell_unit TEXT NOT NULL DEFAULT 'unit' CHECK(sell_unit IN ('unit','box')),
  retail_price INTEGER NOT NULL,                       -- paise
  cost_price INTEGER NOT NULL,                         -- paise
  label_line1 TEXT,                                    -- default: name
  label_line2 TEXT,                                    -- default: formatted retail_price
  location_text TEXT,                                  -- m0031: free-text rack hint, autocomplete
  reorder_level INTEGER NOT NULL DEFAULT 0,            -- base units
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_name ON items(name);
CREATE INDEX idx_items_brand ON items(brand);
CREATE INDEX idx_items_category ON items(category);
CREATE INDEX idx_items_barcode ON items(barcode);

-- Stock movements (append-only ledger)
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty INTEGER NOT NULL,                                -- signed (base units)
  type TEXT NOT NULL CHECK(type IN ('inward','sale','transfer','adjust')),
  ref_type TEXT,                                       -- 'sale','purchase','transfer','adjust'
  ref_id INTEGER,                                      -- polymorphic FK
  reason TEXT,                                         -- for type='adjust': damage/theft/miscount/other + notes
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mov_item_loc_qty ON stock_movements(item_id, location_id, qty);
CREATE INDEX idx_mov_item_loc_created_id ON stock_movements(item_id, location_id, created_at DESC, id DESC);
CREATE INDEX idx_mov_created ON stock_movements(created_at);
CREATE INDEX idx_mov_ref ON stock_movements(ref_type, ref_id);

-- Derived current stock (maintained by trigger; rebuildable from movements)
CREATE TABLE stock_balances (
  item_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, location_id)
) WITHOUT ROWID;
CREATE INDEX idx_bal_item ON stock_balances(item_id);

CREATE TRIGGER stock_movements_ai
AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO stock_balances(item_id, location_id, qty)
  VALUES (NEW.item_id, NEW.location_id, NEW.qty)
  ON CONFLICT(item_id, location_id)
  DO UPDATE SET qty = qty + excluded.qty;
END;

-- Append-only enforcement: block UPDATE and DELETE on stock_movements
CREATE TRIGGER stock_movements_bu
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only; UPDATE forbidden');
END;

CREATE TRIGGER stock_movements_bd
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only; DELETE forbidden (use compensating movement instead)');
END;

-- Purchases (inward)
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER REFERENCES vendors(id),            -- nullable: inward without vendor
  date TEXT NOT NULL,                                  -- ISO date
  total INTEGER NOT NULL,                              -- paise
  notes TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_purchases_date ON purchases(date);
CREATE INDEX idx_purchases_vendor ON purchases(vendor_id);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL,                                -- base units
  cost_price INTEGER NOT NULL,                         -- paise
  retail_price INTEGER NOT NULL,                      -- paise, set HERE per spec
  location_id INTEGER NOT NULL REFERENCES locations(id)
);
CREATE INDEX idx_pi_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_pi_item ON purchase_items(item_id);

-- Vendor payments (separate, not in cash_ledger)
CREATE TABLE vendor_payments (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  amount INTEGER NOT NULL,                             -- paise
  mode TEXT NOT NULL CHECK(mode IN ('cash','upi','card','bank','cheque')),
  date TEXT NOT NULL,
  notes TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vp_vendor ON vendor_payments(vendor_id);
CREATE INDEX idx_vp_date ON vendor_payments(date);

-- Sales (single table: status='quotation'|'final')
CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,                             -- INV-2026-0001 / QTN-2026-0001
  customer_id INTEGER REFERENCES customers(id),        -- NULL = walk-in
  date TEXT NOT NULL,                                  -- ISO datetime
  status TEXT NOT NULL CHECK(status IN ('quotation','final')),
  subtotal INTEGER NOT NULL,                           -- paise
  bill_discount INTEGER NOT NULL DEFAULT 0,            -- paise
  total INTEGER NOT NULL,                              -- paise
  paid_amount INTEGER NOT NULL DEFAULT 0,              -- paise
  payment_modes_json TEXT NOT NULL DEFAULT '[]',       -- [{"mode":"cash","amount":12300}, ...]
  validity_days INTEGER,                               -- for quotations
  converted_from_id INTEGER REFERENCES sales(id),      -- quotation -> final
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_date ON sales(date);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_user_date ON sales(user_id, date);
CREATE UNIQUE INDEX idx_sales_no ON sales(no);

-- Sale items
CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL,                                -- base units
  price INTEGER NOT NULL,                              -- paise (per base unit at sale time)
  unit_type TEXT NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','box')),
  line_discount INTEGER NOT NULL DEFAULT 0,            -- paise
  shade_note TEXT,                                     -- m0037: optional, no required picker
  line_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_si_sale ON sale_items(sale_id);
CREATE INDEX idx_si_item ON sale_items(item_id);

-- Customer payments (khata settlements, separate from sale)
CREATE TABLE customer_payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,                             -- paise
  mode TEXT NOT NULL CHECK(mode IN ('cash','upi','card','bank','cheque')),
  date TEXT NOT NULL,
  notes TEXT,                                          -- may reference a sale_id
  sale_id INTEGER REFERENCES sales(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cp_customer ON customer_payments(customer_id);
CREATE INDEX idx_cp_date ON customer_payments(date);

-- Day close (per-user, per-tender variance computed)
CREATE TABLE day_close (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,                                  -- ISO date
  user_id INTEGER NOT NULL REFERENCES users(id),
  opening_cash INTEGER NOT NULL DEFAULT 0,             -- paise
  cash_sales INTEGER NOT NULL DEFAULT 0,               -- computed sum of cash mode for this user/date
  cash_in INTEGER NOT NULL DEFAULT 0,                  -- manual inflows (petty cash top-up)
  cash_out INTEGER NOT NULL DEFAULT 0,                 -- manual outflows
  counted_cash INTEGER NOT NULL,                       -- paise
  expected_cash INTEGER NOT NULL,                      -- paise: opening + cash_sales + cash_in - cash_out
  variance INTEGER NOT NULL,                           -- paise: counted - expected
  notes TEXT,                                          -- "skipped backup" or override reason
  backup_check_status TEXT NOT NULL CHECK(backup_check_status IN ('fresh','stale','skipped')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_day_close_user_date ON day_close(user_id, date);

-- Sequence tracking for master-issued numbers (gap-aware)
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,                               -- 'sale_inv', 'sale_qtn', 'sku'
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sequences(name) VALUES ('sale_inv'),('sale_qtn'),('sku');

-- Settings (singleton, JSON-blob)
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  shop_name TEXT,
  address TEXT,
  phone TEXT,
  label_cfg_json TEXT,                                 -- default label_line1/2 template
  receipt_cfg_json TEXT,                               -- A4 receipt template
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK(tax_mode IN ('none')),  -- GST is post-v1
  idle_lock_minutes INTEGER NOT NULL DEFAULT 5,
  lockout_action TEXT NOT NULL DEFAULT 'timeout' CHECK(lockout_action IN ('timeout','wipe')),
  lockout_timeout_minutes INTEGER NOT NULL DEFAULT 15,
  last_backup_at TEXT,
  last_test_restore_at TEXT,
  scanner_avg_ms_per_char INTEGER NOT NULL DEFAULT 30,
  scanner_suffix_keycodes TEXT NOT NULL DEFAULT '[9,13]',  -- Tab, Enter
  scanner_min_length INTEGER NOT NULL DEFAULT 6,
  master_lan_ip TEXT,                                  -- manual IP fallback
  master_lan_port INTEGER NOT NULL DEFAULT 7842,       -- 7842 = "PKIN" on phone keypad
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO settings(id) VALUES (1);
```

### 5.2 Migrations

- `rusqlite_migration` 2.6.0, `user_version`-based, atomic per-migration transactions.
- **PRAGMAs set AFTER migrations**: `journal_mode = WAL`, `busy_timeout = 5000`, `cipher_compatibility = 4`, `cipher_page_size = 4096` (BEFORE WAL).
- **No `PRAGMA journal_mode` inside migrations** (no effect inside transactions).

### 5.3 Derived values (no stored counter)

| Derived | SQL |
|---|---|
| `current_stock(item, loc)` | `SELECT qty FROM stock_balances WHERE item_id=? AND location_id=?` (cached) OR `SELECT SUM(qty) FROM stock_movements WHERE item_id=? AND location_id=?` (audit) |
| `in_stock_flag(item)` | `current_stock > 0` (any location) |
| `customer_outstanding(id)` | `(opening_balance + Σ(sales.total - sales.paid_amount)) - Σ(customer_payments.amount)` |
| `customer_spend(id, since?)` | `Σ(sale_items.qty * sale_items.price - sale_items.line_discount)` for sales WHERE customer_id=? AND status='final' |
| `vendor_outstanding(id)` | `(opening_balance + Σ(purchases.total)) - Σ(vendor_payments.amount)` |
| `low_stock_items()` | `items` WHERE `reorder_level > 0` AND `Σ(stock_balances.qty) < reorder_level` |

---

## 6. Roles & Permissions (Server-Side Enforcement)

| Action | Owner | Cashier | Stocker |
|---|:---:|:---:|:---:|
| Unlock master with PIN | ✅ | ✅ | ✅ |
| Items: list / lookup | ✅ all fields | name + `in_stock` flag + `location_text` | name + `location_text` |
| Items: create / edit | ✅ | ❌ | ❌ |
| Items: print labels | ✅ | ✅ (read-only items) | ❌ |
| Purchase/Inward: create | ✅ | ❌ | ✅ |
| Purchases: history | ✅ | ❌ | ❌ |
| Vendors: CRUD | ✅ | ❌ | ❌ |
| Vendor payments: record | ✅ | ❌ | ❌ |
| Sales: create quotation | ✅ | ✅ | ❌ |
| Sales: create final bill | ✅ | ✅ | ❌ |
| Sales: convert quotation | ✅ | ✅ (own quotations) | ❌ |
| Sales: cancel (within grace) | ✅ | ✅ (own + today) | ❌ |
| Customers: list / search | ✅ all | name + phone + outstanding + flagged | ❌ |
| Customers: CRUD | ✅ | ✅ create (with type) | ❌ |
| Customer payments: record | ✅ | ✅ | ❌ |
| Day close: trigger | ✅ | ✅ (own user only) | ❌ |
| Day close: override | ✅ | ❌ | ❌ |
| Reports | ✅ | ❌ | ❌ |
| Stock-take | ✅ | ❌ | ✅ |
| Transfers Shop↔Godown | ✅ | ❌ | ✅ |
| Adjustment (damage/theft/miscount/other) | ✅ | ❌ | ❌ |
| Settings | ✅ | ❌ | ❌ |
| Users CRUD + PIN reset | ✅ | ❌ | ❌ |
| Devices enroll / revoke | ✅ | ❌ | ❌ |
| Locations CRUD | ✅ | ❌ | ❌ |
| Backup trigger / restore | ✅ | ❌ | ❌ |
| Recovery | ✅ | ❌ | ❌ |

**Server-side enforcement**: every API handler (axum middleware) validates `(device.role, user.role)` against the action. UI hiding is cosmetic; backend is authoritative. The mTLS cert is bound to a device role; a cashier device cannot talk to owner endpoints.

---

## 7. Business Workflows (per spec §8)

### 7.1 Inventory
- **List view** (owner): grouped by brand → category, search by name/barcode/SKU, low-stock toggle, drill-down
- **Item detail** (owner): stock per location, retail, cost, label config, print-barcode button, `location_text`
- **Add/Edit item** (owner): name, brand, category, unit, pack_size, `units_per_box`, `sell_unit`, retail, cost, label_line1, label_line2, `location_text`, reorder_level, is_active
- **Print labels**: single (from item detail) or batch (multi-select → all items or filter result). Output: jsPDF 50×25mm landscape, Code128 barcode + `label_line1` + `label_line2`. `window.print()` to thermal printer.
- **Low-stock view** (owner + stocker read): items where `current_stock < reorder_level`, with quick-action "create inward"
- **Transfer Shop↔Godown** (owner + stocker): select item, qty, from → to. Creates 2 movements (-from, +to).
- **Adjustment** (owner only): item, location, signed qty, reason (damage/theft/miscount/other), notes (required for `other`)
- **Stock-take** (owner + stocker): scan items into count grid, expected vs counted, save creates adjustment movements for deltas

### 7.2 Purchase/Inward
- Optional vendor (or "no vendor")
- Scan / pick item → qty · cost · retail_price (set HERE per spec) · location
- **Sticky cost**: same item's cost carries to next line of same item until changed
- **Unknown barcode**: inline create item → continue
- **Box/unit**: user picks unit type per line; if `units_per_box` set, UI shows "5 boxes (50 buckets)"
- Save → +movements + optional auto-print labels (toggle in Settings)

### 7.3 Sales/POS
- **Toggle**: Quotation | Final bill (default Final, owner-configurable)
- **Customer**: search-by-phone (≥4 digits), new customer, walk-in (default option)
- **Scan / search → cart**: line item, qty, price (default retail, editable by owner), line_discount, shade_note (optional text)
- **Box/unit**: per line, similar to inward
- **Bill discount**: per-bill percent or flat (owner only); cashier cannot apply
- **Payment mode(s)**: cash / upi / card / bank / cheque. Per-tender splits. Sum of `payment_modes_json[].amount` = `paid_amount`.
- **Flagged customer**: if `customer.is_flagged = 1` (regardless of outstanding amount — including ₹0), show `⚠️ Outstanding ₹X` banner; cashier must tap "Proceed" to continue. **Does NOT block**, applies regardless of payment mode.
- **Save** (Final) — credit rules (resolved from Momus review):
  - **Customer attached AND `customer.credit_limit > 0`** (owner sets per-customer): `paid_amount ∈ [0, total]`. `outstanding += (total - paid_amount)`.
  - **Walk-in (no customer) OR `customer.credit_limit IS NULL` OR `credit_limit = 0`**: `paid_amount` MUST equal `total`. Save blocked otherwise.
  - Credit-limit ceiling enforcement: out of v1 scope (v1 always allows full credit up to total for credit-enabled customers; ceiling warning deferred to M3).
  - Stock movements created SYNCHRONOUSLY before receipt prints (per spec §9).
- **Save** (Quotation): no stock movement; `validity_days` (default 7) sets expiry
- **Print receipt**: A4 via `window.print()`; jsPDF template from `settings.receipt_cfg_json`
- **Convert quotation → final**: open quotation, tap "Convert" → moves stock, mints new `no = INV-...`, original `QTN-...` linked via `converted_from_id`
- **Hold / Park bill**: stash current cart with optional note, return later. Owner + cashier. (M1 deliverable; do not re-tag in M3.)
- **History** (owner): all sales; (cashier): own + today
- **Reprint** (owner + cashier own): reprint receipt, no DB change

### 7.4 Customers
- **List** (owner all fields, cashier limited): name, phone, type, outstanding, flagged
- **Search**: by 4–10 digit phone substring, or name
- **Add** (owner + cashier): name, phone (validated), type (from `customer_types`), is_flagged (owner only), credit_limit (owner only), opening_balance (owner only), notes
- **Detail** (owner + cashier): order history, total spend, outstanding, shade notes (from sale_items)
- **Customer payments (khata)**: record settlement, optional link to a specific sale_id

### 7.5 Reports (owner only)
- **Daily sales**: range, count, by mode, total discount, total
- **Stock report**: by location, low-stock, group totals (brand/category)
- **Outstanding** (M1): customers (with current outstanding total, vendor outstanding total)
- **Movements audit**: per-item history
- **Top items / top customers** (M3+): data already modelled, just views
- Default ranges: "today", "this month", custom date range picker

### 7.6 Day Close
- Per user (cashier)
- Form: opening_cash (default = carry from last close for this user) → auto cash_sales (sum of `payment_modes_json` where `mode='cash'` for this user/date) → manual cash_in / cash_out → counted_cash → variance
- **Backup gate**: if `last_backup_at` is null or >24h, prompt: "Last backup N hours ago. Back up now?" Buttons: "Back up & close" | "Skip once" (records in `notes`) | "Cancel close"
- **Lock**: per-user (decision 0.16). After write, the cashier's sales for that date become read-only to that cashier. Owner can still edit (audit via `stock_movements` and `customer_payments`).
- Override notes always recorded.

### 7.7 Settings (owner only)
- Shop header: name, address, phone
- Label template (default `label_line1` / `label_line2`)
- Receipt template (A4 layout)
- Users CRUD + PIN reset
- Devices: enroll new / revoke existing
- Locations CRUD
- Manage `customer_types` (add/rename/deactivate)
- Backup config: enable Gdrive, mount-point for USB
- Security: idle_lock_minutes, lockout_action, lockout_timeout_minutes
- Scanner: avg_ms_per_char, suffix_keycodes, min_length (settings.json)
- Master Health page (read-only): see §9.10 schema

---

## 8. UI/UX Patterns

### 8.1 Indian conventions
- `Intl.NumberFormat('en-IN', { style:'currency', currency:'INR' })` → `₹1,23,456.50` (lakhs/crores grouping, paise always shown)
- Dates: `dd/mm/yyyy` (`Intl.DateTimeFormat('en-IN', { dateStyle: 'short', timeZone: 'Asia/Kolkata' })`)
- Time: `HH:mm` 24h
- Currency stored as INTEGER paise (₹1.00 = 100). No float math.

### 8.2 Touch-friendly POS
- Big buttons (min 48×48 dp, recommended 56×56 dp)
- Touch numpad for amount entry (not native keyboard) — always
- Cart list with swipe-to-remove line
- Quick-action "Paid exact" button (fills `paid_amount` = `total`)
- Per-tender split UI: tap "+ Add tender" → mode + amount row

### 8.3 Per-role UI hiding
- Routes the role can't access are not in nav. Direct URL → 403.
- Item lookup variants:
  - **Owner**: name, brand, category, retail, cost, qty per location, `location_text`, reorder_level
  - **Cashier**: name, `in_stock` flag (yes/no), `location_text`. NO qty/cost/margin.
  - **Stocker**: name, `location_text`, qty per location. NO retail.

### 8.4 Walk-in customer
- Default: new sale starts with "Walk-in" (no customer attached).
- Tap customer field → search → pick existing or "+ New" inline form.

### 8.5 Unknown barcode inline create
- Inward or stock-take: scan unknown barcode → modal "Item not found. Create now?" → quick form (name, unit, retail, cost, `location_text`, `units_per_box`, `sell_unit`) → save → continue inward line

### 8.6 Hold / Park bill
- Top bar button "Hold" → confirms save of current cart as draft, clears screen, "Held bills" panel shows parked items
- Resume = re-loads cart, no DB change until final save

### 8.7 Loading / empty states
- Every list: skeleton rows on initial load, "No data" with icon + primary action on empty
- Mutations: optimistic updates with rollback on error
- Errors: toast + (if 5xx) link to logs

### 8.8 Hot keys (desktop only)
- `Ctrl+L` → Lock now
- `Ctrl+B` → Focus barcode input / simulate scan
- `Ctrl+N` → New sale
- `Ctrl+H` → Hold cart
- `F1` → Help
- All configurable in Settings (owner)

### 8.9 Barcode scanner wedge
- Single Rust global listener (`rdev::listen`) emits `barcode:scan` event with `{ barcode: string, ts, terminator: 'enter'|'tab' }`.
- Frontend: `useScanTargetStore` (Zustand) with `target: 'sales'|'inward'|'stocktake'|'locked'|null`.
- Active route sets `target` on mount; lock screen sets `'locked'`; modals can set `'locked'` temporarily.
- Barcode as STRING always (preserve leading zeros, never parse to number).
- Detection rule: `terminator seen && length >= settings.scanner_min_length && totalTime <= max(150ms, len * settings.scanner_avg_ms_per_char)`.

### 8.10 Amount entry
- Touch numpad component: 0-9, `00`, `.`, ⌫, clear
- Auto-format on display only; paise storage
- Rounding: NONE. paise preserved exactly.

---

## 9. Production Hardening (Master Only)

### 9.1 Auto-launch on boot
- `tauri-plugin-autostart` 2.5.1 first (per-user Run key, no admin)
- Fallback: PowerShell `schtasks /Create /SC ONLOGON /TR "..." /F` if GPO blocks
- Permissions: `autostart:allow-enable/disable/is-enabled`
- Owner can disable in Settings

### 9.2 No-sleep / never-idle
- App calls `powercfg /change standby-timeout-ac 0`, `...-dc 0`, `powercfg /change hibernate-timeout-dc 0`, `powercfg -setacvalueindex SCHEME_CURRENT 238c9fa8-0aad-41ed-83f4-97be242c8f20 29bcbc9b-25c4-4706-8db1-08c2a2c2df06 0` (lidaction 0 on AC)
- On DC: `15-30` standby, `30-60` hibernate (preserve battery but not too aggressive)
- Validate: `powercfg /a`, `powercfg /requests`
- **Auto-lock ≠ sleep** (covered by 9.7)

### 9.3 Kiosk mode on master
- DO NOT use Windows Assigned Access from Tauri
- Use: `window.set_decorations(false)` + `set_fullscreen(true)` + `set_always_on_top(true)`
- Escape: PIN-gated modal (NOT a global hotkey — conflicts with Windows)
- Permissions: `core:window:allow-set-fullscreen`, `...-set-always-on-top`, `...-set-decorations`
- Per-user Tauri settings, not OS-level

### 9.4 Single instance
- `tauri-plugin-single-instance` 2.4.2 (register early in builder, plugin order matters)
- Absorbs second launch, focuses existing window

### 9.5 Tray icon with quick actions
- `tauri::tray::TrayIconBuilder::new().menu(&menu).on_menu_event(...)`, `show_menu_on_left_click(false)` (left-click opens window)
- Menu: "Show window", "Lock now" (calls `LockWorkStation` via Win32 FFI), "Quit"

### 9.6 WebView2 hardening
- `bundle.windows.webviewInstallMode.type = "fixedRuntime"`
- Health check shows WebView2 runtime version

### 9.7 Idle auto-lock
- 5 min default (decision 0.6), configurable in Settings
- On trigger: zeroize DEK in RAM, transition to lock screen
- Re-unlock requires PIN
- All UI shows lock screen; no data visible

### 9.8 Lockout backoff
- 5 wrong PINs → action from `settings.lockout_action`:
  - `timeout`: exponential (15 → 30 → 60 → 240 → 1440 min)
  - `wipe`: zeroize DEK + wrapped DEK, destroy keywrap row, log event. Owner must use recovery passphrase to re-derive on next launch.
- Tracks per-user in `lockouts` table

### 9.9 Logging
- `tauri-plugin-log` 2.9.0 with `FileOpenStrategy::Rotate` (10 MB × 5 files)
- Targets: file + webview console
- In-app `/admin/logs` route tails file via Tauri command (poll every 2s)

### 9.10 Master Health page (Settings → Master Health)
Read-only dashboard rendering the schema from research:
```ts
type MasterHealth = {
  checkedAt: string;
  overall: 'ok' | 'warn' | 'error';
  app: { version: string; webview2: string; sqlcipher: string; lastBackup: string; lastTestRestore: string };
  system: { bitlocker: { cDrive: 'on'|'off'|'unknown' }; diskFreeGB: number; sleepPrevented: boolean; autoLockPolicy: 'ok'|'warn' };
  data: { dbIntegrity: 'ok'|'corrupt'; rowsCount: { sales: number; items: number; customers: number }; backupAgeHours: number };
  network: { mdnsActive: boolean; lanIp: string; connectedDevices: number };
  ops: { dayCloseAge: number; lowStockCount: number; pendingSales: number };
};
```
- **BitLocker check**: `powershell Get-BitLockerVolume -MountPoint "C:"` (fallback `manage-bde -status C:`). Banner yellow if Off/Suspended, red if not on C:.
- **Sleep check**: `powercfg /requests` (look for `NONE` in "Display" / "System")
- **DB integrity**: `PRAGMA quick_check`
- **Backup age**: `now - last_backup_at`

---

## 10. Backup & Recovery

### 10.1 File format: PKB1 binary envelope

```
HEADER (cleartext):
  magic: "PKB1"
  version: u16 = 1
  flags: u16 = 0
  created_at_unix_ms: i64
  plaintext_db_len: u64
  salt: [16]                              # backup_salt
  nonce_prefix: [4]
  argon2 m_cost_kib: u32                  # same as recovery (256 MiB)
  argon2 t_cost: u32
  argon2 p_cost: u32
  chunk_size: u32 = 65536
  manifest_len: u32

BODY (AES-256-GCM, AAD = HEADER):
  manifest { section_count, sqlcipher_db_len, key_wrappers_len, metadata }
  sqlcipher_db bytes (chunked, sequential nonce = nonce_prefix || chunk_idx)
  key_wrappers bytes (chunked)

TRAILER:
  ciphertext_sha256: [32]                 # pre-decrypt corruption reject
```

Backup key: `Argon2id(recovery_passphrase, backup_salt, m=256MiB, t=3, p=1)` → 32-byte key.
**Ciphertext SHA-256** (not plaintext) for pre-decrypt corruption reject.

### 10.2 Snapshot method
- `rusqlite::Connection::backup` API to a temp file (not raw file copy)
- Temp file is the unencrypted SQLCipher DB
- After backup completes, open temp with same DEK as live, encrypt with backup key, write envelope
- Delete temp

### 10.3 Targets
- **Google Drive** (M4): OAuth via `tauri-plugin-oauth` 2.0, refresh token in `tauri-plugin-keyring-store`
- **Local USB**: detect mount, write `{label}-{date}.pkb1`
- **Local file** (always available): write to user-chosen path

### 10.4 Triggers
- **Manual**: Settings → Backup → "Back up now" → choose target → enter backup password (recovery passphrase)
- **Day-close gate**: if `last_backup_at` is null or >24h old, prompt with 3 options (Back up & close / Skip once / Cancel)
- **Scheduled (optional, off by default)**: `tokio-cron-scheduler` 0.15.1, e.g. `0 22 * * *` local. **Even if scheduled, MUST prompt for password** — scheduled = reminder + one-click, never silent.

### 10.5 Restore flow (non-destructive)
1. Pick source (Drive / USB / file)
2. Enter backup password
3. Verify header magic + ciphertext SHA-256
4. Decrypt body to temp file
5. Open temp with SQLCipher; `PRAGMA cipher_compatibility = 4;`
6. `PRAGMA quick_check;` (or `integrity_check;`)
7. Atomic swap: live → `.prev`, temp → live, reopen, `.prev` deleted
8. If any step fails: temp deleted, no change to live

### 10.6 Test restore
- First-class button: Settings → Backup → "Test restore latest backup"
- Runs full restore path to a separate temp file in the OS temporary directory, runs `quick_check`, deletes temp, updates `last_test_restore_at`, and zeroizes the recovery passphrase
- Banner: "Last tested restore: 35 days ago" (yellow if >30d, red if >90d)

### 10.7 Retention
- Keep last 30 per target. Older = archive (rename `.pkb1` → `.archive-{date}.pkb1`, don't delete).

### 10.8 Recovery on new device (M1)
- App start, no local keywrap OR DEK unwrapping fails
- "New Master Device" screen → enter recovery passphrase → derive K_recovery → unwrap DEK
- Set new owner PIN
- Optionally set up users + devices fresh
- For client re-enrollment (M2): revoke old device certs

---

## 11. Milestones

### M1: Master-only single-machine (this milestone, target for build)

**Scope**: Tauri 2 app on Windows laptop. Local DB. No network. No clients. Core sales + inventory + day-close + manual backup.

**Deliverables**:
- [ ] Project scaffold: Tauri 2 + React 19 + TS 6 + Vite 8 + Tailwind 4 + shadcn 4
- [ ] SQLCipher DB initialization, migrations, unencrypted keywrap sidecar, PRAGMAs
- [ ] First-launch wizard: set owner PIN, set recovery passphrase, set shop name/address/phone
- [ ] Lock screen with PIN entry + 5-attempt counter
- [ ] Idle auto-lock (5 min, configurable)
- [ ] Bad-PIN lockout (configurable timeout vs wipe)
- [ ] Owner dashboard (home)
- [ ] Inventory CRUD (items + locations + per-item `location_text`)
- [ ] Box/unit conversion (decision 0.19)
- [ ] Stock movements (append-only) + derived `stock_balances` via trigger
- [ ] Inward (purchase) flow with vendor + sticky cost + unknown barcode inline-create + auto-print labels toggle
- [ ] Sales/POS: quotation + final bill, customer search, walk-in, payment split, flagged-customer warning, A4 print
- [ ] Hold / Park bill
- [ ] Customers CRUD + khata (customer_payments)
- [ ] Vendors CRUD + vendor_payments
- [ ] Day close: opening + auto-cash + in/out + counted + variance + backup gate
- [ ] Reports: daily sales, stock, low-stock, outstanding
- [ ] Settings: shop, label, receipt, users, locations, customer_types, security, scanner, master health
- [ ] Master Health page (read-only)
- [ ] Barcode scanner wedge (rdev) with route-aware target
- [ ] Label print (jsPDF 50×25mm Code128)
- [ ] Receipt print (A4 via window.print)
- [ ] Manual backup (local file) + restore (non-destructive) + test restore
- [ ] Auto-launch on boot (autostart plugin)
- [ ] No-sleep config (powercfg)
- [ ] Single instance
- [ ] Tray icon (Show / Lock / Quit)
- [ ] Logging with rotation
- [ ] All sensible defaults (0.x) applied

**NOT in M1** (M2+): mTLS LAN, axum server, Android client, Drive backup, USB backup, scheduled backup, kiosk mode (deferred to M2 polish), advanced reports (top items/customers out of M1 scope — data is there, just the views), batch label UX (single label works, multi-select batch is M3).

### M2: axum + mTLS + roles + Android client
- [ ] axum-server-mtls 0.1.2 server (master listens on `settings.master_lan_port`)
- [ ] mDNS advertise `master.local` (mdns-sd 0.20.0)
- [ ] mDNS browse from client; manual IP + QR fallback
- [ ] rcgen CA + device cert issuance
- [ ] First-launch client wizard: scan QR from master → enroll
- [ ] Android client (Tauri 2 mobile): RAM-only state, device cert in Keystore
- [ ] All master modules callable from client
- [ ] Camera/ZXing scanner on client (Android; desktop wedge from M1 still works)
- [ ] Kiosk mode polish (M1 has tray + autostart, M2 adds fullscreen + escape)
- [ ] Client cert revocation
- [ ] WebView2 runtime check on master health

### M3: Money / people / polish
- [ ] Drive backup (OAuth)
- [ ] USB backup
- [ ] Scheduled backup (off by default)
- [ ] Batch label print (multi-select)
- [ ] Advanced reports: top items, top customers, margin report
- [ ] Outstandings aging buckets (0-7/8-30/31-60/60+)
- [ ] Quotation validity expiry indicator
- [ ] Stock-take scan-and-count flow polish
- [ ] All UX gaps from §8 fully polished

### M4: Durability / hardening
- [ ] Test restore automation
- [ ] Recovery polish (M1 has it working, M4 makes it bulletproof)
- [ ] Log rotation tuning
- [ ] DB integrity scheduled check
- [ ] Performance pass: query plans, indexes, VACUUM cadence
- [ ] Penetration test (light)
- [ ] User manual PDF
- [ ] First-customer deployment

---

## 12. Sequence numbering

`sales.no` and `items.sku_code` are master-issued sequences. Each has a row in `sequences`:

```sql
-- Mint next INV number
UPDATE sequences SET last_value = last_value + 1, updated_at = datetime('now')
  WHERE name = 'sale_inv' RETURNING last_value;
-- Use as: 'INV-' || strftime('%Y','now') || '-' || printf('%04d', last_value)
-- Gap-aware: if app crashes between UPDATE and INSERT, sequence has a gap.
-- For v1, gap-tracked (visible gap in number sequence) is acceptable.
-- To detect gaps: re-number by date on demand (admin tool, M3+).
```

For `sale_qtn`: same pattern with `name = 'sale_qtn'`.
For `sku_code`: same with `name = 'sku'`, formatted as Code128 (e.g. `00001`, `00002`...). 5 digits, 99999 max before rollover. If more than 99999 items ever, switch to alphanumeric; for v1, 5 digits is fine for any single shop.

---

## 13. Deferred (post-v1, pull-in candidates)

These are intentionally NOT in v1. Pull into a milestone only with explicit user request.

- **Tax / GST**: GST rates, GSTIN, HSN codes, place of supply, e-invoicing, e-way bill. Currently `tax_mode = 'none'` only.
- **Tally / accounting export**: TDL/XML export, ledger push.
- **UPI QR on bill**: dynamic QR generation, payment confirmation.
- **WhatsApp bill share**: share receipt PDF/image via WhatsApp.
- **Logo / letterhead**: per-shop branding on receipts.
- **Multi-language UI**: Hindi, Marathi, etc. v1 is en-IN.
- **DPDP consent flow**: India's Digital Personal Data Protection Act consent capture.
- **Audit log table**: beyond `stock_movements` (e.g. login attempts, settings changes). Currently covered by `tauri-plugin-log` files.
- **Self-check page**: broader diagnostics beyond Master Health.
- **Tauri updater plugin**: in-app update. v1 uses manual MSI install + recovery flow.
- **Batch / expiry tracking**: per-batch lot numbers, FEFO.
- **Tint formulas**: color mixing recipes, base paint dispensing.
- **Multi-price tiers**: customer-type-based pricing, painter rates, dealer rates.
- **Painter loyalty**: visits, rewards, redeemable.
- **Schemes / landing cost**: manufacturer scheme tracking, true landed cost per unit.
- **Delivery tracking**: van routes, undelivered bills, delivery receipt.
- **In-system returns**: refund flow, credit-note → inventory reverse. Spec excludes v1; cancel-only with stock-reverse.
- **Field-level column encryption**: customer phone/name/address encrypted at column level. v1 encrypts at DB level only.
- **Multi-shop / multi-premise**: separate godown across town. Spec excludes v1.

---

## 14. Spec mapping

| Spec § | Topic | Plan § |
|---|---|---|
| §2 Topology | Master + clients, LAN, mDNS | 2 |
| §3 Stack | Tauri 2 + React + SQLCipher + axum | 3 |
| §4 Roles | Owner/cashier/stocker scope | 6 |
| §5 Security | Key hierarchy, lockout, recovery | 4, 10.8 |
| §6 Data model | All tables, derived stock | 5 |
| §7 Barcode | sku_code = Code128, scanner wedge | 8.9, 12 |
| §8 Modules | Inventory, Inward, Sales, Customers, Reports, Day Close, Settings | 7 |
| §9 Sync | Master SoT, sync bill write | 7.3 (Save final) |
| §10 Build order | M1-M4 | 11 |
| §11 Future | GST, Tally, schemes | 13 |
| Per-item location | `location_text` | 5.1 (items), 7.1 |
| Box-to-unit | `units_per_box`, `sell_unit` | 5.1, 7.2, 7.3 |
| Shade optional | `shade_note` TEXT nullable | 5.1, 7.3 |

---

## 15. Verification (per milestone)

**Tool legend**:
- **S** = shell command (cargo, pnpm, powershell)
- **R** = Rust unit/integration test (`cargo test`)
- **F** = Frontend test (Vitest)
- **E** = End-to-end manual (human-driven, on real Windows machine)
- **DB** = Direct DB inspection (sqlcipher CLI or test helper)

All scenarios must pass before M2 begins. Record evidence in `.omo/plans/m1-verification-evidence.md` (screenshot, log snippet, query result).

### 15.1 Build & static checks (S)

- **S1** `pnpm install && pnpm tsc --noEmit` in `client/` and `master/` → exit 0, no type errors.
- **S2** `cargo build --release` in `master/src-tauri/` (Windows) → links system SQLCipher 4.16.0, exit 0.
- **S3** `cargo test --release` in `master/src-tauri/` → all unit + integration tests pass.
- **S4** `pnpm vitest run` in `client/` → all unit tests pass.
- **S5** `cargo tauri build` produces `.msi` and `.nsis` installers → both >5MB, valid Windows installers.

### 15.2 DB & migrations (DB, R)

- **DB1** Delete DB, launch app → wizard runs, on completion DB exists at `%APPDATA%\PaintKiDukaan\master.db`, open with `sqlcipher master.db` + same DEK → `.tables` lists all §5.1 tables.
- **DB2** Schema dump via `.schema` on `master.db` → matches §5.1 exactly for all encrypted main-DB tables, indexes, and triggers. The keywrap sidecar `master.db.keystore` is a separate SQLite file and is excluded from the main-DB schema dump.
- **DB3** PRAGMAs: `journal_mode = wal`, `busy_timeout = 5000`, `cipher_compatibility = 4`, `cipher_page_size = 4096`. Verified via `PRAGMA journal_mode;` etc.
- **DB4** Witness file rejection: rename `master.db` to `master.db.bak`, app should refuse to open (DEK wrong) and surface a recovery flow, NOT silently start.
- **DB5** Stock trigger: insert row into `stock_movements(item_id=1, location_id=1, qty=10)`, then `SELECT qty FROM stock_balances WHERE item_id=1 AND location_id=1` → returns 10. Insert another with qty=-3, returns 7. SUM from `stock_movements` matches.
- **DB6** Lockout table exists with 0 rows initially, increments per failed PIN attempt.

### 15.3 First-launch wizard (E, DB)

- **E1** Delete all app data, launch app → wizard Step 1 (set owner PIN) appears. Enter `123456` → Step 2 (set recovery passphrase) appears. Enter `correct horse battery staple` → Step 3 (shop name/address/phone) appears. Enter values → Step 4 (review) → Submit.
- **E2** After submit, the keywrap sidecar (`master.db.keystore`) has 1 row with non-null `pin_wrapped_dek`, `rec_wrapped_dek`, `pin_salt`, `rec_salt`, `backup_salt`. All salts are 16 bytes.
- **E3** Re-launch app → no wizard, goes directly to lock screen.
- **E4** Wrong PIN 5 times → 15 min lockout. Wait 15 min, try right PIN → unlocks.
- **E5** Force wrong-PIN wipe (set `lockout_action=wipe` in settings first): 5 wrong → app destroys the keywrap sidecar row, shows recovery screen.

### 15.4 Lock + auto-lock (E, R)

- **E6** Unlock with correct PIN → home dashboard loads.
- **E7** Wait 5 min idle (configurable) → app locks automatically. RAM dump (via task manager or test helper) shows DEK memory region is zeroed.
- **E8** Set `idle_lock_minutes=1` in Settings, wait 1 min → locks.
- **E9** Lock via tray menu "Lock now" → immediate lock, DEK zeroed.
- **E10** During lock, all routes (other than unlock) → 403 / lock screen.

### 15.5 Bad-PIN lockout (E)

- **E11** Enter 1 wrong PIN → small toast "1 failed attempt".
- **E12** Enter 5 wrong PINs within 5 min → app locks for 15 min, lockout banner shows "Locked until HH:MM".
- **E13** 5 wrong PINs after timeout reset: 15 → 30 → 60 → 240 → 1440 min. Verify by checking `lockouts.locked_until` after each.

### 15.6 Items + per-item location (E, DB)

- **E14** Create item: name="Asian Paints Ace 4L Exterior", brand="Asian Paints", category="exterior emulsion", unit="L", pack_size="4L", retail_price=₹1200, cost_price=₹900, reorder_level=10, `location_text`="Rack 1, Bay A" → save → item appears in inventory list.
- **E15** Edit item, change `location_text`="Rack 2, Bay B" → save → list reflects new value.
- **E16** Create second item with `location_text`="Rack 1, Bay A" (same) → autocomplete offers "Rack 1, Bay A" in suggestion list.
- **E17** Cashier role: item lookup shows only name + `in_stock` (yes/no) + `location_text` ("Rack 1, Bay A"). Does NOT show retail_price, cost_price, qty.
- **E18** Stocker role: lookup shows name + `location_text` + qty per location. Does NOT show retail_price.
- **E19** Owner: lookup shows all fields.

### 15.7 Box/unit conversion (E, DB)

- **E20** Create item: name="Asian Paints Ace 4L", unit="L", `units_per_box`=4, `sell_unit`="box" → save. Default label line shows "1 box (4 L)".
- **E21** Sale: pick this item, choose "box", enter qty=2 → cart line shows "2 boxes (8 L)", total = 2 × 4 × retail_per_L.
- **E22** Save final bill → `stock_movements` has qty=-8 (base units). `stock_balances` decreases by 8.
- **E23** Reprint label for this item → label says "Asian Paints Ace 4L" + retail_price (per box, computed as 4 × retail_per_L). Code128 encodes sku_code.
- **E24** Try to sell "box" for item where `units_per_box IS NULL` → UI shows "Unit only" (box option disabled).

### 15.8 Inward (E, DB)

- **E25** Create vendor "Asian Paints Distributor". Inward: select vendor, scan (or pick) item "Ace 4L", qty=10 boxes, cost=₹800/box, retail=₹1200/L, location=Shop. Save.
- **E26** DB: `purchases` row with vendor_id, total=8000. `purchase_items` row with qty=40 (base units, 10 boxes × 4 L), cost_price=80000 paise (₹800), retail_price=120000 paise. `stock_movements` has qty=+40 to Shop.
- **E27** Add second line for same item, qty=5 boxes → cost field pre-filled with ₹800 (sticky).
- **E28** Inward with `units_per_box`=4, qty=2 boxes → UI shows "2 boxes (8 L)" → DB records qty=8 base units.
- **E29** Inward total = 10×800 + 5×800 = ₹12000. `purchases.total` = 1200000 paise.

### 15.9 Unknown barcode inline create (E)

- **E30** In inward, type/scan `9999999999999` (unknown) → modal "Item not found. Create now?" → form: name="Test Item", unit="pc", retail=₹100, cost=₹50, `units_per_box`=NULL, `sell_unit`="unit", `location_text`="Rack 3" → save → returns to inward with new item selected, qty ready to enter.

### 15.10 Sales — quotation (E, DB, R)

- **E31** New sale, toggle "Quotation", walk-in customer → scan "Ace 4L", qty=2 boxes (8 L), price=₹4800/L (default retail × 1 — or whatever owner configures) → save.
- **E32** DB: `sales` row with `no='QTN-2026-0001'`, `status='quotation'`, `subtotal=3840000`, no `stock_movements` for this sale.
- **E33** History shows quotation. Reprint receipt. Receipt has "QUOTATION" header + validity date (today + 7 days).
- **E34** Open quotation → tap "Convert to final" → modal shows items + total + asks for payment mode → save → new `sales` row `no='INV-2026-0001'`, `converted_from_id=QTN-2026-0001`. `stock_movements` now has 2 rows of qty=-8 from Shop.
- **E35** Atomicity test (R): simulate panic between `INSERT INTO sales (status='final')` and `INSERT INTO stock_movements`. After restart, either both committed or neither (no orphan final without movements). Verified via `cargo test sale_final_atomicity`.

### 15.11 Sales — final bill, credit rules (E, DB)

- **E36** Create customer C1 with `credit_limit=NULL`. New sale, attach C1, scan item, total=₹1000. Try to save with `paid_amount=500` → blocked with "Walk-in / no-credit customer must pay in full".
- **E37** Same customer, `paid_amount=1000` → saves, `customer_outstanding(C1)=0` (sale not credit, opening_balance=0).
- **E38** Edit customer C1, set `credit_limit=5000`. New sale, attach C1, total=₹1000, `paid_amount=500` → saves, `customer_outstanding(C1)=500`.
- **E39** Same customer, total=₹2000, `paid_amount=0` → saves, outstanding += 2000.
- **E40** Walk-in customer, partial payment → blocked.

### 15.12 Flagged customer (E)

- **E41** Customer C1 with `is_flagged=1`, outstanding=₹500. New sale, attach C1 → `⚠️ Outstanding ₹500` banner shown at bill attach. Tap "Proceed" → can continue, banner persists during cart.
- **E42** Same customer, total=₹1000, `paid_amount=1000` (full pay) → warning STILL shown (flagged = warning, not credit). Owner can clear flag in customer detail.
- **E42b** Customer C2 with `is_flagged=1`, outstanding=₹0 (no past bills, no opening balance). New sale, attach C2 → `⚠️ Outstanding ₹0` banner STILL shown (flagged alone triggers warning; outstanding amount is just informational). Proceeds normally.

### 15.13 Customer khata (E, DB)

- **E43** Customer C1 outstanding=₹500. Record customer_payment amount=₹300, mode=cash → `customer_payments` row. `customer_outstanding(C1)=200`.
- **E44** Customer C1 has 2 unpaid sales (₹300 + ₹200), record customer_payment=₹400 → outstanding drops to ₹100. Verified by DB query: `customer_outstanding(C1)=10000` paise.

### 15.14 Hold/park bill (E, DB)

- **E45** Start sale, add 2 lines, total=₹2000. Tap "Hold" → modal asks for note "Wedding order for Sharma" → confirm. Cart clears, dashboard shows "Held bills: 1".
- **E46** Open held bill → cart reloads with 2 lines + note. Continue, save as final → held bill deleted, final sale created.

### 15.15 Day close (E, DB)

- **E47** Cashier C1 has 3 sales today, all paid in cash, total=₹5000. Trigger day close → form: opening_cash=₹500 (auto-filled from last close), cash_sales=₹5000, cash_in=₹0, cash_out=₹0, counted_cash=₹5500 → save.
- **E48** DB: `day_close` row with `variance=0` (expected=5500, counted=5500). `backup_check_status='fresh'` (assuming last_backup <24h).
- **E49** Same cashier tries to create new sale after day close → blocked: "Day already closed for today. Owner can override."
- **E50** Owner login → can edit C1's closed day sale (with audit log entry).
- **E51** Set `last_backup_at` to >24h ago, trigger day close → backup prompt appears. "Back up & close" → runs backup, then closes. "Skip once" → closes with `notes='skipped backup'`. "Cancel close" → no row written.
- **E52** Variance ≠ 0 → day close row written anyway, with non-zero variance. Report shows variance.

### 15.16 Reports (E, DB)

- **E53** Run "Today" daily sales report → count of final sales today, total amount, total discount, breakdown by payment mode.
- **E54** Run "This month" report → all final sales this month, grouped by date.
- **E55** Stock report: by location, low-stock filter shows only items where `current_stock < reorder_level`.
- **E56** Outstandings: customers with outstanding > 0 (total amount, no aging buckets in M1 — aging buckets is M3).

### 15.16a Vendors + vendor payments (E, DB)

- **E-V1** Create vendor V1 (name="Asian Paints Ltd", phone="9876543210", opening_balance=₹0). DB: `vendors` row. `vendor_outstanding(V1) = 0`. Edit V1 phone and deactivation toggles is_active. List view shows V1, search by partial name finds it.
- **E-V2** Create inward purchase for V1, total=₹8000, no payment → `vendor_outstanding(V1) = ₹8000`. Record vendor_payment amount=₹3000, mode=upi → `vendor_outstanding(V1) = ₹5000`. DB: `vendor_payments` row with mode='upi', date=today. Report vendor outstanding shows V1 with ₹5000.

### 15.16b Users CRUD + PIN reset (E, DB, S)

- **E-U1** Settings → Users → Add user "Anita" role=cashier, PIN=1234 (4 digits, cashier choice). DB: `users` row with `pin_verifier` Argon2id hash (length=32B raw), `pin_length=4`. Login as Anita on lock screen with PIN=1234 → unlocks. Wrong PIN 5x → lockout (E11).
- **E-U2** Add user "Bharat" role=stocker, PIN=654321 (6 digits). Login as Bharat. Both PIN lengths (4 and 6) supported. Cannot login as Bharat on a cashier-restricted screen (server-side role check).
- **E-U3** Owner → Users → select Anita → "Reset PIN" → enter new PIN 5678 (no length change) → `pin_verifier` re-derived with existing `pin_salt`, login with new PIN works. Old PIN rejected.

### 15.16c Locations CRUD (E, DB)

- **E-L1** Settings → Locations → rename "Godown" to "Back Store" (only if no movements reference old name? No — soft rename via `name`, FK still works). Rename persists. Add new location "Site-1" (is_active=1). Inward into Site-1 → `stock_movements.location_id=Site-1.id`. Deactivate Site-1 → does NOT show in inward location dropdown. Existing movements keep `location_id`.

### 15.16d Settings persistence (E, DB)

- **E-S1** Settings → Shop → change shop_name to "XYZ Paints", address="123 Main St", phone="9876543210". Restart app → values persist. `settings` row has the new values, `updated_at` updated.
- **E-S2** Settings → Label template → change `label_line1` default to "{brand} {name}" → "Print label" on an item shows the new template. Settings → Receipt template → change header text → "Print receipt" shows new header. Both persist across restarts.

### 15.16e Inward auto-print toggle (E, S)

- **E-IA1** Settings → Inward → toggle "Auto-print labels after save" ON (default OFF). Save a 2-line inward (2 distinct items, 1 unit each) → after save, PDF auto-generates with 2 labels and `window.print()` opens with both labels. Toggle OFF → save inward, no auto-print. Setting persists across restarts (DB: `settings` row).

### 15.17 Backup/restore (E, DB, S)

- **E57** Settings → Backup → "Back up now" → choose local file → enter recovery passphrase → choose path → save. File created at chosen path, > 100KB.
- **E58** Inspect file: starts with `PKB1` magic (4 bytes), then 64-byte header, body, 32-byte trailer. Use `hexdump -C backup.pkb1 | head -5` to verify magic.
- **E59** Add a new sale after backup. Settings → Backup → Restore → pick backup file → enter recovery passphrase → "Test restore" → success banner, `last_test_restore_at` updated.
- **E60** Real restore: pick backup, enter passphrase → atomic swap. Live DB now has the pre-backup state, new sale is gone. App auto-restarts, prompts for PIN.
- **E61** Tamper test: edit 1 byte in backup file body, attempt restore → fails with "Integrity check failed" before any decrypt.
- **E62** Wrong passphrase: attempt restore → fails with "Decryption failed" (without leaking whether passphrase or key was wrong).
- **E63** Round-trip backup → restore: 100 sales, backup, restore, verify all 100 sales present.
- **E64** Round-trip via offline restore: same as 63 but on a fresh machine (just SQLCipher + the file). Verified in CI by spinning up a Linux container with SQLCipher 4.16, opening the file, dumping all tables.

### 15.18 Customer types (E, DB)

- **E65** Settings → Manage customer types → add "wholesale". New customer form now has type=retail/painter/contractor/dealer/wholesale. Save customer with type=wholesale.
- **E66** Deactivate "wholesale" → does NOT show in new-customer form dropdown. Existing customers keep their type_id (soft-deactivated, not hard-deleted).

### 15.19 Scanner wedge (E, R)

- **E67** Locked screen, scan a Code128 barcode → no effect (target='locked').
- **E68** On Sales route, scan a known item's sku_code → cart adds the line within 100ms of terminator key.
- **E69** On Inward route, scan → adds to current line.
- **E70** Buffering test (R): simulate 200 keystrokes in 100ms (faster than `scanner_avg_ms_per_char=30`) → still treated as a single scan if terminator + min_length met. Slower than threshold → keystrokes not buffered.

### 15.20 Print labels + receipts (E)

- **E71** From item detail, click "Print label" → jsPDF generates PDF with 50×25mm page, Code128 barcode, line1 (item name), line2 (₹retail_price). `window.print()` opens, prints to default printer.
- **E72** From a final sale, click "Print receipt" → A4 page, shop header, sale no, date, customer, line items, totals, payment breakdown. `window.print()` opens.
- **E73** Receipt without logo (per decision 0.21) → no logo image, no T&Cs footer.

### 15.21 Production hardening (E, S)

- **E74** Run `powercfg /requests` while app is idle → "Display" and "System" rows show "NONE".
- **E75** Reboot Windows, log in → app auto-launches (autostart enabled in Settings).
- **E76** Launch app twice quickly → second launch focuses existing window (single instance). No second process.
- **E77** Right-click tray icon → menu: Show / Lock now / Quit. Each works.
- **E78** Settings → Master Health → page loads with current health. BitLocker status matches `Get-BitLockerVolume C: ProtectionStatus`.
- **E79** Logs: trigger 100 log lines, check `%APPDATA%\PaintKiDukaan\logs\app.log` exists, rotated when > 10MB.
- **E80** `/admin/logs` route in dev build → tails log file, latest line at top.

### 15.22 Recovery new device (E)

- **E81** Backup the live DB. Uninstall app. Reinstall. Launch → "New Master Device" wizard.
- **E82** Enter recovery passphrase (from E57) → DEK unwrapped, DB opens. App shows empty (no items, no users except what's in DB).
- **E83** Re-enroll this laptop as master (auto via wizard, since it's the first device). Restore: trigger restore from backup → live state returns.

### 15.23 Security negative tests (R, DB)

- **E84** With app running and unlocked, copy `master.db` to another location → that copy is encrypted (cannot open with `sqlite3`, only with SQLCipher + same DEK).
- **E85** With app locked, inspect RAM via OS tool → DEK bytes are zeroed (compare against unlocked snapshot).
- **E86** Ciphertext SHA-256 mismatch: write a backup, modify 1 byte, attempt restore → fails immediately on header check.
- **E87** Sequence gap test (R): in a Rust test, run 10 sale creations, force 1 to fail mid-way, verify the next sale gets a gap-tracked next number (not a duplicate).
- **E88** Stock-movement immutability (R): in a Rust test, attempt `UPDATE stock_movements SET qty=999 WHERE id=1` → fails (revoked UPDATE permission via SQL or trigger).

### 15.24 Localization (E, F)

- **E89** Cart total: ₹12,345.50 → displays as "₹12,345.50" (with comma grouping, no lakh notation needed for small amounts). Cart total: ₹12,34,567.50 → displays as "₹12,34,567.50" (lakh grouping).
- **E90** Date in receipt: today is 2026-06-19 → "19/06/2026". Time: 14:35 → "14:35".

### M1 sign-off criterion
All S1-S5, DB1-DB6, E1-E90, R-* (referenced in E35, E70, E87, E88) pass. App runs as standalone .msi installer on Windows 11 with no admin required (other than initial SQLCipher install if using vcpkg). Ready for M2 hand-off.

---

## 16. Open Items (require future decisions, NOT blockers for M1)

None for M1. M2-M4 will surface:
- mTLS CA rotation cadence (M2)
- Drive OAuth flow UX (M3)
- Scheduled backup default time (M3)
- Top-N cutoffs for "top items/customers" (M3)
- Per-tender reference field (cheque no, UPI txn id) — user said skip, re-evaluate if paint shops ask

These are tracked in the `.omo/plans/` directory under each milestone file when started.

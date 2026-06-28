-- =====================================================================
-- PaintKiDukaan Master — canonical final schema
-- =====================================================================
-- THIS IS the single source of truth for a fresh database.  Every table,
-- index, and seed row that any Rust command expects lives here.
--
-- How this differs from schema.sql (the intermediate baseline):
--   * units has a `dimension` column (was M002)
--   * sales / sale_items / customers use the flat, Rust-expected shape
--     (was M009 — payment_modes_json, not payment_modes; price, not
--      unit_price_paise; no email/address on customers; …)
--   * sale_returns has a `no` column (was M007)
--   * daily_counters / sale_return_payments / printers / printer_mappings
--     are inlined (were M005 / M008)
--   * All other tables and seed data match schema.sql
-- =====================================================================
--
-- Design axioms (locked in the schema redesign grilling sessions):
--   * Soft-delete only — every entity has is_active. FKs use ON DELETE
--     NO ACTION (the default) so historical transactions keep their
--     references valid forever.
--   * Money is INTEGER paise. Sign enforcement lives in the app layer;
--     DB does not constrain sign on *_paise columns.
--   * Timestamps are INTEGER epoch milliseconds UTC.  day_close.day is
--     the only TEXT date (calendar day, 'YYYY-MM-DD').
--   * Audit columns (created_by/updated_by) are nullable; NULL means
--     "system row" (wizard, migration, seed).
--   * Polymorphic references (stock_movements.ref_kind/ref_id,
--     alerts.entity_kind/entity_id) are by convention, not FK.
--   * Every index has a comment naming the query it serves.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- =====================================================================
-- SECTION A — Identity & access
-- =====================================================================

-- A1. Users (owners + cashiers + stockers)
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  role            TEXT    NOT NULL CHECK(role IN ('owner','cashier','stocker')),
  pin_salt        BLOB    NOT NULL,
  pin_verifier    BLOB    NOT NULL,
  pin_length      INTEGER NOT NULL DEFAULT 6,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,                        -- epoch ms; NULL = not locked
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by      INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "list active cashiers for shift handover dropdown"
CREATE INDEX idx_users_role_active ON users(role) WHERE is_active = 1;

-- serves: "user picker" / "settings → user management list"
CREATE INDEX idx_users_is_active_name ON users(is_active, name);

-- A2. Lockouts (audit log of past lockout events)
CREATE TABLE lockouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  locked_until INTEGER NOT NULL,                  -- epoch ms
  reason       TEXT,
  created_at   INTEGER NOT NULL
);

-- serves: "show lockout history for this user"
CREATE INDEX idx_lockouts_user_id ON lockouts(user_id);

-- A3. Devices (workstations/registers)
CREATE TABLE devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  last_seen_at INTEGER,                           -- epoch ms; NULL = never
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "device dropdown / active register list"
CREATE INDEX idx_devices_is_active_name ON devices(is_active, name);

-- A4. Settings (singleton row, id = 1)
CREATE TABLE settings (
  id                       INTEGER PRIMARY KEY CHECK(id = 1),
  shop_name                TEXT    NOT NULL DEFAULT 'My Shop',
  address                  TEXT,
  phone                    TEXT,
  currency_code            TEXT    NOT NULL DEFAULT 'INR',
  currency_symbol          TEXT    NOT NULL DEFAULT '₹',
  currency_decimal_places  INTEGER NOT NULL DEFAULT 2,
  label_size               TEXT,
  failed_attempts_lockout  INTEGER NOT NULL DEFAULT 5,
  alerts_retention_days    INTEGER NOT NULL DEFAULT 30,
  last_backup_unix_ms      INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  created_by               INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by               INTEGER REFERENCES users(id) ON DELETE NO ACTION
);
-- (default_location_id intentionally absent — locations.is_default is the
--  single source of truth, enforced by uniq_one_default_location below.)

-- =====================================================================
-- SECTION B — Locations & topology
-- =====================================================================

-- B1. Locations (Shop, Godown, etc.)
CREATE TABLE locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  zone       TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "location dropdown"
CREATE INDEX idx_locations_is_active_name ON locations(is_active, name);

-- DB invariant: at most one location has is_default = 1
CREATE UNIQUE INDEX uniq_one_default_location ON locations(is_default) WHERE is_default = 1;

-- B2. Sub-locations (racks / bins within a location)
CREATE TABLE sub_locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  name        TEXT    NOT NULL,
  position    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by  INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  UNIQUE(location_id, name)
);

-- serves: "list sublocations at this Shop"
CREATE INDEX idx_sub_locations_location_active ON sub_locations(location_id) WHERE is_active = 1;

-- B3. Units (master list — seeded with the 10 known units)
CREATE TABLE units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  dimension  TEXT    NOT NULL DEFAULT 'count',    -- M002: volume | mass | area | count
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- B3.5. Item categories (managed in Settings → Catalog)
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- B4. Unit conversions (e.g. 1 L = 1000 ml)
CREATE TABLE unit_conversions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  to_unit_id   INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  factor       REAL    NOT NULL CHECK(factor > 0),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  UNIQUE(from_unit_id, to_unit_id),
  CHECK(from_unit_id <> to_unit_id)
);

-- serves: "find conversion X → Y when scanning a barcode in ml for an L item"
CREATE INDEX idx_uc_from ON unit_conversions(from_unit_id) WHERE is_active = 1;
CREATE INDEX idx_uc_to   ON unit_conversions(to_unit_id)   WHERE is_active = 1;

-- =====================================================================
-- SECTION C — Parties
-- =====================================================================

-- C1. Customer types (lookup)
CREATE TABLE customer_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- unique-while-active so you can re-add a deactivated type later
CREATE UNIQUE INDEX uniq_customer_types_active_name ON customer_types(name) WHERE is_active = 1;

-- C2. Customers
-- NOTE: email/address columns were removed in M009 — Rust code never
-- reads or writes them.  The flattened shape matches the backend struct.
-- created_at/updated_at are TEXT with DEFAULT because the production
-- INSERT in commands/customers.rs never supplies them explicitly.
CREATE TABLE customers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  phone                TEXT,
  customer_type_id     INTEGER REFERENCES customer_types(id) ON DELETE NO ACTION,
  is_flagged           INTEGER NOT NULL DEFAULT 0 CHECK(is_flagged IN (0,1)),
  opening_balance_paise INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  created_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "customer picker / search"
CREATE INDEX idx_customers_is_active_name ON customers(is_active, name);

-- serves: "lookup by phone at billing time"
CREATE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL AND is_active = 1;

-- C3. Vendors
CREATE TABLE vendors (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  phone                TEXT,
  email                TEXT,
  address              TEXT,
  contact_person       TEXT,
  credit_limit_paise   INTEGER NOT NULL DEFAULT 0 CHECK(credit_limit_paise >= 0),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "vendor picker / search"
CREATE INDEX idx_vendors_is_active_name ON vendors(is_active, name);

-- serves: "lookup vendor by phone"
CREATE INDEX idx_vendors_phone ON vendors(phone) WHERE phone IS NOT NULL AND is_active = 1;

-- =====================================================================
-- SECTION D — Catalog
-- =====================================================================

-- D1. Brands
CREATE TABLE brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  prefix     TEXT,                                 -- barcode prefix (e.g. "APA" for APACE)
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- unique-while-active
CREATE UNIQUE INDEX uniq_brands_active_name ON brands(name) WHERE is_active = 1;

-- D2. Per-brand barcode sequence (UPDATE...RETURNING for atomic mint)
CREATE TABLE brand_sequences (
  brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE NO ACTION,
  prefix   TEXT    NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq >= 1),
  padding  INTEGER NOT NULL DEFAULT 4 CHECK(padding BETWEEN 1 AND 12),
  updated_at INTEGER NOT NULL
);

-- D3. Global sequences (sku, sale_number, ...)
CREATE TABLE sequences (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 1 CHECK(value >= 1)
);

-- D4. Items (the catalog)
CREATE TABLE items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_code            TEXT    NOT NULL UNIQUE,
  barcode             TEXT,                       -- nullable; unique when set
  name                TEXT    NOT NULL,
  brand_id            INTEGER REFERENCES brands(id) ON DELETE NO ACTION,
  brand               TEXT,                       -- denormalized brand name for cashier projection
  category            TEXT,
  unit_id             INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  unit_code           TEXT    NOT NULL,           -- denormalized for cashier projection
  unit_label          TEXT    NOT NULL,           -- denormalized for cashier projection
  unit                TEXT    NOT NULL DEFAULT 'pc',  -- denormalized unit code (legacy compat)
  sell_unit           TEXT    NOT NULL DEFAULT 'unit', -- "unit" or "box"
  sell_unit_id        INTEGER REFERENCES units(id) ON DELETE NO ACTION,
  retail_price_paise  INTEGER NOT NULL CHECK(retail_price_paise >= 0),
  cost_paise          INTEGER NOT NULL CHECK(cost_paise >= 0),
  promo_price_paise   INTEGER CHECK(promo_price_paise >= 0),
  label_line1         TEXT,
  label_line2         TEXT,
  primary_location_id INTEGER REFERENCES locations(id) ON DELETE NO ACTION,
  min_qty             INTEGER NOT NULL DEFAULT 0 CHECK(min_qty >= 0),
  min_stock           REAL    NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
  barcode_format      TEXT,
  units_per_pack      INTEGER NOT NULL DEFAULT 1 CHECK(units_per_pack >= 1),
  sub_location_id     INTEGER REFERENCES sub_locations(id) ON DELETE NO ACTION,
  position            TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "lookup by SKU"
CREATE UNIQUE INDEX uniq_items_sku ON items(sku_code);

-- serves: "scan barcode at POS"
CREATE UNIQUE INDEX uniq_items_barcode ON items(barcode) WHERE barcode IS NOT NULL;

-- serves: "item picker / search by name"
CREATE INDEX idx_items_is_active_name ON items(is_active, name);

-- serves: "filter by brand in catalog"
CREATE INDEX idx_items_brand_id ON items(brand_id) WHERE is_active = 1;

-- serves: "list items at this location"
CREATE INDEX idx_items_primary_location_id ON items(primary_location_id) WHERE is_active = 1;

-- serves: "fast partial barcode prefix match" (e.g. typeahead scan)
CREATE INDEX idx_items_is_active_barcode ON items(barcode) WHERE is_active = 1 AND barcode IS NOT NULL;

-- D5. Formulas (custom shade mixes sold on demand — base items move stock when with_base=1)
-- See ADR-011 (first-class entity) and ADR-012 (id_code as primary identifier).
CREATE TABLE formulas (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id_code             TEXT    NOT NULL UNIQUE,
  name                TEXT,
  with_base           INTEGER NOT NULL DEFAULT 0 CHECK(with_base IN (0,1)),
  base_item_id        INTEGER REFERENCES items(id) ON DELETE SET NULL,
  retail_price_paise  INTEGER NOT NULL CHECK(retail_price_paise >= 0),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  created_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  CHECK(with_base = 0 OR base_item_id IS NOT NULL)
);

-- serves: "search by id_code prefix on POS search bar"
CREATE INDEX idx_formulas_id_code ON formulas(id_code);

-- serves: "formulas list with active/inactive filter"
CREATE INDEX idx_formulas_is_active ON formulas(is_active);

-- =====================================================================
-- SECTION E — Stock
-- =====================================================================

-- E1. Stock movement kinds (lookup; new kinds are INSERTs, never schema changes)
-- sign: -1=outbound, 0=adjustment/recount (no direction), 1=inbound
CREATE TABLE stock_movement_kinds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  sign       INTEGER NOT NULL CHECK(sign IN (-1, 0, 1)),
  is_inbound INTEGER NOT NULL DEFAULT 0 CHECK(is_inbound IN (0,1))
);

-- E2. Stock movements (append-only ledger)
CREATE TABLE stock_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  kind_id      INTEGER NOT NULL REFERENCES stock_movement_kinds(id) ON DELETE NO ACTION,
  qty          INTEGER NOT NULL CHECK(qty <> 0),  -- sign comes from kinds, but we still ban 0
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  ref_kind     TEXT    CHECK(ref_kind IN ('sale','purchase','return','adjustment') OR ref_kind IS NULL),
  ref_id       INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "current stock at location" / "stock history for item"
CREATE INDEX idx_stock_movements_item_loc_created ON stock_movements(item_id, location_id, created_at DESC);

-- serves: "stock movement report for location"
CREATE INDEX idx_stock_movements_loc_created ON stock_movements(location_id, created_at DESC);

-- serves: "find the movement(s) behind this sale/purchase/return"
CREATE INDEX idx_stock_movements_ref ON stock_movements(ref_kind, ref_id) WHERE ref_id IS NOT NULL;

-- serves: "kind-based reports (all damages / all adjustments)"
CREATE INDEX idx_stock_movements_kind_id ON stock_movements(kind_id);

-- E3. Stock balances (hot read path; maintained by trigger)
CREATE TABLE stock_balances (
  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  location_id      INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  qty              INTEGER NOT NULL DEFAULT 0,
  last_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE NO ACTION,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (item_id, location_id)
);

-- serves: "list all balances for this item" (e.g. for stocker view)
CREATE INDEX idx_stock_balances_item ON stock_balances(item_id);

CREATE INDEX idx_stock_balances_item_qty ON stock_balances(item_id, qty);

-- E4. Trigger: refresh stock_balances on every stock_movements INSERT
CREATE TRIGGER stock_movements_ai
AFTER INSERT ON stock_movements
FOR EACH ROW
BEGIN
  INSERT INTO stock_balances (item_id, location_id, qty, last_movement_id, updated_at)
  VALUES (NEW.item_id, NEW.location_id, NEW.qty, NEW.id, NEW.created_at)
  ON CONFLICT(item_id, location_id) DO UPDATE SET
    qty            = stock_balances.qty + excluded.qty,
    last_movement_id = excluded.last_movement_id,
    updated_at     = excluded.updated_at;
END;

-- Block UPDATE on the ledger
CREATE TRIGGER stock_movements_bu
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only; insert a corrective movement instead');
END;

-- Block DELETE on the ledger
CREATE TRIGGER stock_movements_bd
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- =====================================================================
-- SECTION F — Purchases
-- =====================================================================

-- F1. Purchase documents (header)
CREATE TABLE purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_number TEXT    NOT NULL UNIQUE,
  vendor_id       INTEGER REFERENCES vendors(id) ON DELETE NO ACTION,
  location_id     INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  subtotal_paise  INTEGER NOT NULL DEFAULT 0,
  discount_paise  INTEGER NOT NULL DEFAULT 0,
  tax_paise       INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL DEFAULT 0,
  paid_paise      INTEGER NOT NULL DEFAULT 0,
  balance_paise   INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'open'
                    CHECK(status IN ('open','finalized','cancelled')),
  bill_number     TEXT,
  bill_date       INTEGER,                        -- epoch ms (vendor's invoice date)
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by      INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "purchases by vendor, newest first"
CREATE INDEX idx_purchases_vendor_created ON purchases(vendor_id, created_at DESC);

-- serves: "purchases received at this location"
CREATE INDEX idx_purchases_location_created ON purchases(location_id, created_at DESC);

-- serves: "open purchase orders" / "finalized purchase reports"
CREATE INDEX idx_purchases_status ON purchases(status) WHERE is_active = 1;

-- F2. Purchase lines
CREATE TABLE purchase_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id        INTEGER NOT NULL REFERENCES purchases(id) ON DELETE NO ACTION,
  item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  qty                INTEGER NOT NULL CHECK(qty > 0),
  unit_id            INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  unit_price_paise   INTEGER NOT NULL CHECK(unit_price_paise >= 0),
  line_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK(line_discount_paise >= 0),
  line_total_paise   INTEGER NOT NULL CHECK(line_total_paise >= 0),
  created_at         INTEGER NOT NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "lines for this purchase"
CREATE INDEX idx_purchase_items_purchase_id ON purchase_items(purchase_id);

-- serves: "purchase history for this item"
CREATE INDEX idx_purchase_items_item_id ON purchase_items(item_id);

-- F3. Vendor payments (settlements against purchases)
CREATE TABLE vendor_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id    INTEGER NOT NULL REFERENCES vendors(id) ON DELETE NO ACTION,
  purchase_id  INTEGER REFERENCES purchases(id) ON DELETE NO ACTION,
  mode         TEXT    NOT NULL,
  amount_paise INTEGER NOT NULL CHECK(amount_paise <> 0),
  reference    TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "vendor ledger"
CREATE INDEX idx_vendor_payments_vendor_created ON vendor_payments(vendor_id, created_at DESC);

-- serves: "settlements for this purchase"
CREATE INDEX idx_vendor_payments_purchase_id ON vendor_payments(purchase_id) WHERE purchase_id IS NOT NULL;

-- =====================================================================
-- SECTION G — Sales
-- =====================================================================

-- G1. Sales (quotations + invoices in one table)
-- NOTE: This uses the FLAT shape the Rust code expects (M009):
--   - `no` (not `sale_number`)
--   - `status` is 'quotation'|'final' (NOT the schema.sql multi-value enum)
--   - `payment_modes_json` TEXT (not `payment_modes` — the Rust INSERT/SELECT
--     consistently use `payment_modes_json`)
--   - integer columns without `_paise` suffix: subtotal, bill_discount, etc.
--   - `created_at` is TEXT with a DEFAULT because the production INSERT in
--     commands/sales.rs never supplies it explicitly
CREATE TABLE sales (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  no                 TEXT    NOT NULL UNIQUE,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE NO ACTION,
  date               TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL DEFAULT 'quotation'
                       CHECK(status IN ('quotation','final')),
  subtotal           INTEGER NOT NULL DEFAULT 0,
  bill_discount      INTEGER NOT NULL DEFAULT 0,
  total              INTEGER NOT NULL DEFAULT 0,
  paid_amount        INTEGER NOT NULL DEFAULT 0,
  payment_modes_json TEXT    NOT NULL DEFAULT '[]',
  validity_days      INTEGER,
  converted_from_id  INTEGER REFERENCES sales(id) ON DELETE NO ACTION,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  created_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "sales by cashier, newest first"
CREATE INDEX idx_sales_user_created ON sales(user_id, created_at DESC);

-- serves: "sales for this customer"
CREATE INDEX idx_sales_customer_created ON sales(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

-- serves: "open / voided / final filter"
CREATE INDEX idx_sales_status ON sales(status);

-- serves: "all quotations / invoices, newest first"
CREATE INDEX idx_sales_kind_created ON sales(status, created_at DESC);

-- G2. Sale lines — polymorphic (item OR formula) per ADR-011.
-- A line carries EXACTLY ONE of item_id / formula_id via the CHECK.
CREATE TABLE sale_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
  kind          TEXT    NOT NULL DEFAULT 'item' CHECK(kind IN ('item','formula')),
  item_id       INTEGER REFERENCES items(id) ON DELETE NO ACTION,
  formula_id    INTEGER REFERENCES formulas(id) ON DELETE NO ACTION,
  qty           INTEGER NOT NULL CHECK(qty > 0),
  price         INTEGER NOT NULL CHECK(price >= 0),
  unit_type     TEXT    NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','box')),
  line_discount INTEGER NOT NULL DEFAULT 0,
  shade_note    TEXT,
  line_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  created_by    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  CHECK ((item_id IS NOT NULL AND formula_id IS NULL)
      OR (item_id IS NULL AND formula_id IS NOT NULL))
);

-- serves: "lines for this sale"
CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);

-- serves: "sale history for this item"
CREATE INDEX idx_sale_items_item_id ON sale_items(item_id);

-- serves: "history sub-section of FormulaDetailsPage" (ADR-016)
CREATE INDEX idx_sale_items_formula_id ON sale_items(formula_id);

-- G3. Sale payments — source of truth for payment splits
CREATE TABLE sale_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
  mode         TEXT    NOT NULL,
  amount_paise INTEGER NOT NULL CHECK(amount_paise <> 0),
  reference    TEXT,
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "payments for this sale"
CREATE INDEX idx_sale_payments_sale_id ON sale_payments(sale_id);

-- serves: "all UPI sales today"
CREATE INDEX idx_sale_payments_mode_created ON sale_payments(mode, created_at DESC);

-- G4. Customer payments (khata settlements)
CREATE TABLE customer_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE NO ACTION,
  sale_id      INTEGER REFERENCES sales(id) ON DELETE NO ACTION,
  mode         TEXT    NOT NULL,
  amount_paise INTEGER NOT NULL CHECK(amount_paise <> 0),
  reference    TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "customer ledger"
CREATE INDEX idx_customer_payments_customer_created ON customer_payments(customer_id, created_at DESC);

-- serves: "settlements for this sale"
CREATE INDEX idx_customer_payments_sale_id ON customer_payments(sale_id) WHERE sale_id IS NOT NULL;

-- =====================================================================
-- SECTION H — Returns
-- =====================================================================

-- H1. Sale return documents
CREATE TABLE sale_returns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id           INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
  refund_total_paise INTEGER NOT NULL DEFAULT 0,
  reason            TEXT,
  no                TEXT,                          -- M007: human-readable return number
  created_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "returns for this sale"
CREATE INDEX idx_sale_returns_sale_id ON sale_returns(sale_id);

-- serves: "returns report by date"
CREATE INDEX idx_sale_returns_created ON sale_returns(created_at DESC);

-- H2. Sale return lines
CREATE TABLE sale_return_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_return_id   INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE NO ACTION,
  sale_item_id     INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE NO ACTION,
  qty              INTEGER NOT NULL CHECK(qty > 0),
  refund_paise     INTEGER NOT NULL CHECK(refund_paise >= 0),
  created_at       INTEGER NOT NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "lines for this return"
CREATE INDEX idx_sale_return_lines_return_id ON sale_return_lines(sale_return_id);

-- H3. Sale return payments (M005)
CREATE TABLE sale_return_payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_return_id    INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE NO ACTION,
  mode              TEXT    NOT NULL,
  amount_paise      INTEGER NOT NULL CHECK(amount_paise <> 0),
  reference         TEXT,
  created_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "payments for this return"
CREATE INDEX idx_sale_return_payments_return_id ON sale_return_payments(sale_return_id);

-- serves: "all UPI refunds today"
CREATE INDEX idx_sale_return_payments_mode_created ON sale_return_payments(mode, created_at DESC);

-- =====================================================================
-- SECTION I — Day close
-- =====================================================================

-- I1. Per-location end-of-day settlement
CREATE TABLE day_close (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  day                 TEXT    NOT NULL,           -- 'YYYY-MM-DD' (calendar day, NOT epoch)
  location_id         INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  opening_cash_paise  INTEGER NOT NULL DEFAULT 0,
  cash_sales_paise    INTEGER NOT NULL DEFAULT 0,
  card_sales_paise    INTEGER NOT NULL DEFAULT 0,
  upi_sales_paise     INTEGER NOT NULL DEFAULT 0,
  expenses_paise      INTEGER NOT NULL DEFAULT 0,
  closing_cash_paise  INTEGER NOT NULL DEFAULT 0,
  actual_cash_paise   INTEGER,                    -- counted; NULL until counted
  variance_paise      INTEGER,                    -- actual_cash - closing_cash; can be negative
  note                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  UNIQUE(day, location_id)
);

-- serves: "show day-close history for this location"
CREATE INDEX idx_day_close_location_day ON day_close(location_id, day DESC);

-- serves: "show day-close history for this user"
CREATE INDEX idx_day_close_user_id ON day_close(user_id);

-- =====================================================================
-- SECTION J — Daily counters (M005)
-- =====================================================================

-- J1. Invoice / quotation / return numbering
CREATE TABLE daily_counters (
  prefix       TEXT    NOT NULL,
  date         TEXT    NOT NULL,                  -- 'YYYY-MM-DD'
  last_serial  INTEGER NOT NULL DEFAULT 0 CHECK(last_serial >= 0),
  PRIMARY KEY (prefix, date)
);

-- =====================================================================
-- SECTION K — Alerts
-- =====================================================================

-- K1. Alerts
CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  severity     TEXT    NOT NULL CHECK(severity IN ('info','warning','error')),
  title        TEXT    NOT NULL,
  message      TEXT,
  entity_kind  TEXT,                              -- 'item' | 'sale' | 'purchase' | ...
  entity_id    TEXT,                              -- polymorphic (sku_code, sale_number, ...)
  resolved_at  INTEGER,                           -- NULL = open
  resolved_by  INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "active alerts, newest first"
CREATE INDEX idx_alerts_is_active_created ON alerts(is_active, created_at DESC) WHERE is_active = 1;

-- serves: "alerts about this thing"
CREATE INDEX idx_alerts_kind_entity ON alerts(kind, entity_kind, entity_id) WHERE entity_kind IS NOT NULL;

-- serves: retention GC — "drop alerts resolved more than N days ago"
CREATE INDEX idx_alerts_resolved ON alerts(resolved_at) WHERE resolved_at IS NOT NULL;

-- K2. Alert visibility per role
CREATE TABLE alert_roles (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE NO ACTION,
  role     TEXT    NOT NULL CHECK(role IN ('owner','cashier','stocker')),
  PRIMARY KEY (alert_id, role)
);

-- serves: "what alerts should this cashier see?"
CREATE INDEX idx_alert_roles_role ON alert_roles(role);

-- K3. Per-user read receipts
CREATE TABLE alert_reads (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE NO ACTION,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  read_at  INTEGER NOT NULL,
  PRIMARY KEY (alert_id, user_id)
);

-- serves: "which alerts has this user read?"
CREATE INDEX idx_alert_reads_user ON alert_reads(user_id);

-- =====================================================================
-- SECTION L — Printers (M008)
-- =====================================================================

CREATE TABLE printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  use_case TEXT NOT NULL CHECK(use_case IN ('receipt','label')),
  connection_type TEXT NOT NULL CHECK(connection_type IN ('usb','bluetooth','network','serial','system')),
  address TEXT NOT NULL DEFAULT '',
  driver_name TEXT,
  port_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE printer_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id INTEGER NOT NULL UNIQUE REFERENCES printers(id) ON DELETE CASCADE,
  label_width_mm INTEGER,
  label_height_mm INTEGER,
  paper_size TEXT CHECK(paper_size IN ('thermal-58mm','thermal-80mm','A4','A5') OR paper_size IS NULL),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (label_width_mm IS NOT NULL AND label_height_mm IS NOT NULL AND paper_size IS NULL) OR
    (paper_size IS NOT NULL AND label_width_mm IS NULL AND label_height_mm IS NULL) OR
    (label_width_mm IS NULL AND label_height_mm IS NULL AND paper_size IS NULL)
  )
);

CREATE UNIQUE INDEX idx_printers_default_per_usecase
  ON printers(use_case) WHERE is_default = 1;

-- Label print audit log
CREATE TABLE label_print_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  barcode    TEXT    NOT NULL,
  qty        INTEGER NOT NULL CHECK(qty > 0),
  format     TEXT    NOT NULL,
  line1      TEXT,
  line2      TEXT,
  user_id    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  created_at INTEGER NOT NULL,
  tspl_config   TEXT,
  printer       TEXT,
  label_size    TEXT,
  labels_per_row INTEGER
);
CREATE INDEX idx_label_print_log_item_created ON label_print_log(item_id, created_at DESC);
CREATE INDEX idx_label_print_log_created     ON label_print_log(created_at DESC);

-- =====================================================================
-- SEED DATA — reference lookups only
-- =====================================================================
-- User data (Owner, settings singleton, locations Shop/Godown) is seeded
-- by the Rust first_launch_setup wizard, NOT here. This section only
-- inserts lookup values that the wizard and every command assume exist.

-- Stock movement kinds (8)
INSERT INTO stock_movement_kinds (code, label, sign, is_inbound) VALUES
  ('purchase',     'Purchase (vendor inward)',     1, 1),
  ('sale',         'Sale (POS outward)',          -1, 0),
  ('return',       'Customer return',              1, 1),
  ('adjustment',   'Manual adjustment',            0, 0),
  ('transfer_in',  'Transfer in (from another loc)', 1, 1),
  ('transfer_out', 'Transfer out (to another loc)', -1, 0),
  ('damage',       'Damage / write-off',          -1, 0),
  ('recount',      'Recount correction',           0, 0);

-- Units (10 known units)
INSERT INTO units (code, label, dimension, created_at, updated_at) VALUES
  ('L',      'Liter',       'volume', 0, 0),
  ('ml',     'Milliliter',  'volume', 0, 0),
  ('kg',     'Kilogram',    'mass',   0, 0),
  ('g',      'Gram',        'mass',   0, 0),
  ('pc',     'Piece',       'count',  0, 0),
  ('box',    'Box',         'count',  0, 0),
  ('bundle', 'Bundle',      'count',  0, 0),
  ('roll',   'Roll',        'count',  0, 0),
  ('sqft',   'Square foot', 'area',   0, 0),
  ('sqm',    'Square meter','area',   0, 0);

-- Unit conversions (8 well-known pairs)
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 1000.0, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'L'   AND to_u.code = 'ml';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 0.001,  0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'ml'  AND to_u.code = 'L';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 1000.0, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'kg'  AND to_u.code = 'g';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 0.001,  0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'g'   AND to_u.code = 'kg';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 0.092903, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'sqft' AND to_u.code = 'sqm';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 10.7639, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'sqm' AND to_u.code = 'sqft';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 12.0, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'box' AND to_u.code = 'pc';
INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor, created_at, updated_at)
SELECT from_u.id, to_u.id, 1.0/12.0, 0, 0
  FROM units from_u JOIN units to_u ON from_u.code = 'pc'  AND to_u.code = 'box';

-- Customer types (4 known; Retailer is the default)
INSERT INTO customer_types (name, created_at, updated_at) VALUES
  ('Retailer',   0, 0),
  ('Dealer',     0, 0),
  ('Painter',    0, 0),
  ('Contractor', 0, 0);

-- Global sequences
INSERT INTO sequences (name, value) VALUES
  ('sku',         1),
  ('sale_number', 1);

-- Brands (13 reputed Indian paint brands)
INSERT OR IGNORE INTO brands (name, prefix, created_at, updated_at) VALUES
  ('Asian Paints',   'AP', 0, 0),
  ('Berger Paints',  'BG', 0, 0),
  ('Kansai Nerolac', 'KN', 0, 0),
  ('Dulux',          'DL', 0, 0),
  ('Shalimar',       'SH', 0, 0),
  ('British Paints', 'BR', 0, 0),
  ('Nippon Paint',   'NP', 0, 0),
  ('Indigo Paints',  'IN', 0, 0),
  ('Birla Opus',     'BO', 0, 0),
  ('Kamdhenu Paints','KA', 0, 0),
  ('Snowcem',        'SC', 0, 0),
  ('Jenson & Nicholson','JN', 0, 0),
  ('Mysore Paints',  'MY', 0, 0);

-- Brand sequences for seeded brands (each starts at seq = 1)
INSERT OR IGNORE INTO brand_sequences (brand_id, prefix, next_seq, padding, updated_at)
  SELECT id, prefix, 1, 4, 0 FROM brands;

-- =====================================================================
-- SECTION M — Drafts (autosave)
-- =====================================================================

CREATE TABLE IF NOT EXISTS drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  form_type  TEXT    NOT NULL CHECK(form_type IN ('sale','purchase','return')),
  data_json  TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, form_type)
);

-- ============================================================
-- FTS5 full-text search index for items
-- Indexes: name, sku_code, barcode, brand (denormalized text)
-- content='items' → reads original text from items table (no duplication)
-- content_rowid='id' → maps FTS rowid to items.id
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name,
  sku_code,
  barcode,
  brand,
  content='items',
  content_rowid='id'
);

-- Sync triggers: keep items_fts in lockstep with items
CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name, sku_code, barcode, brand)
  VALUES (new.id, new.name, new.sku_code, new.barcode, new.brand);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.id;
  INSERT INTO items_fts(rowid, name, sku_code, barcode, brand)
  VALUES (new.id, new.name, new.sku_code, new.barcode, new.brand);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.id;
END;

-- Bootstrap: populate FTS index from any pre-existing items
-- (no-op on fresh DB; catches data on schema re-apply/migration)
INSERT INTO items_fts(rowid, name, sku_code, barcode, brand)
  SELECT id, name, sku_code, barcode, brand FROM items;

-- SECTION M: Drafts (autosave-as-draft for POS forms)
CREATE TABLE IF NOT EXISTS drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  form_type  TEXT    NOT NULL CHECK(form_type IN ('sale','purchase','return')),
  data_json  TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, form_type)
);

-- =====================================================================
-- MIGRATION: 3-unit system (unit/mtr/kg)
-- =====================================================================
-- Replaces the old 10-unit system (pc, box, bundle, roll, kg, g, L, ml, sqft, sqm)
-- with 3 sale units: unit, mtr, kg.
--
-- Key changes:
--   * New sale_units / purchase_units / item_purchase_packaging tables
--   * Items sell_unit migrated: pc/box/bundle/roll/L/ml → unit, kg/g → kg, sqft/sqm → mtr
--   * Box items: prices divided by units_per_pack, units_per_pack set to 1
--   * stock_balances.qty, stock_movements.qty, sale_items.qty, purchase_items.qty: INTEGER → REAL
--   * sale_items.unit_type CHECK: 'unit','box' → 'unit','mtr','kg'
--   * New columns on items: sell_unit_id, min_stock (REAL)
--   * unit_conversions table dropped
-- =====================================================================

-- N1. Sale units lookup table
CREATE TABLE IF NOT EXISTS sale_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  quantity_precision INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO sale_units (code, label, quantity_precision) VALUES
  ('unit', 'Unit', 0),
  ('mtr', 'Metre', 3),
  ('kg', 'Kg', 3);

-- N2. Purchase units lookup table (packaging labels)
CREATE TABLE IF NOT EXISTS purchase_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO purchase_units (label) VALUES
  ('Carton'), ('Roll'), ('Sack'), ('Piece'), ('Box'), ('Bundle');

-- N3. Per-item purchase packaging (how items are bought)
CREATE TABLE IF NOT EXISTS item_purchase_packaging (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  purchase_unit_id INTEGER NOT NULL REFERENCES purchase_units(id),
  qty_per_purchase_unit REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, purchase_unit_id)
);

-- N4. Migrate items.sell_unit to new values
-- pc/box/bundle/roll/L/ml → unit, kg/g → kg, sqft/sqm → mtr
UPDATE items SET sell_unit = 'unit'
  WHERE sell_unit IN ('pc','box','bundle','roll','L','ml') OR sell_unit IS NULL;
UPDATE items SET sell_unit = 'kg'
  WHERE sell_unit IN ('kg','g');
UPDATE items SET sell_unit = 'mtr'
  WHERE sell_unit IN ('sqft','sqm');

-- N5. For old box items (sell_unit was 'box' and units_per_pack > 1):
--     divide retail_price_paise and cost_paise by units_per_pack,
--     set units_per_pack = 1
UPDATE items
  SET retail_price_paise = CAST(retail_price_paise / units_per_pack AS INTEGER),
      cost_paise = CAST(cost_paise / units_per_pack AS INTEGER),
      units_per_pack = 1
  WHERE sell_unit = 'unit' AND units_per_pack > 1
    AND retail_price_paise > 0;

-- N6. Seed purchase_units from distinct unit_code values in items
INSERT OR IGNORE INTO purchase_units (label)
  SELECT DISTINCT unit_code FROM items WHERE unit_code IS NOT NULL AND unit_code != '';

-- N7. Seed item_purchase_packaging for items with units_per_pack > 1
-- (after N5 these should all be 1, but for safety handle any remaining)
INSERT OR IGNORE INTO item_purchase_packaging (item_id, purchase_unit_id, qty_per_purchase_unit)
  SELECT i.id, pu.id, CAST(i.units_per_pack AS REAL)
  FROM items i
  JOIN purchase_units pu ON pu.label = i.unit_code
  WHERE i.units_per_pack > 1;

-- N8. Add sell_unit_id to items table
ALTER TABLE items ADD COLUMN sell_unit_id INTEGER REFERENCES sale_units(id);

-- N9. Set sell_unit_id from sale_units where code matches items.sell_unit
UPDATE items SET sell_unit_id = (
  SELECT id FROM sale_units WHERE code = items.sell_unit
);

-- N10. Add min_stock (REAL) to items table
ALTER TABLE items ADD COLUMN min_stock REAL NOT NULL DEFAULT 0;

-- N11. Migrate min_qty to min_stock
UPDATE items SET min_stock = CAST(min_qty AS REAL) WHERE min_qty IS NOT NULL;

-- N12. Recreate stock_balances with REAL qty
CREATE TABLE IF NOT EXISTS stock_balances_new (
  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  location_id      INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  qty              REAL NOT NULL DEFAULT 0,
  last_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE NO ACTION,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (item_id, location_id)
);
INSERT INTO stock_balances_new (item_id, location_id, qty, last_movement_id, updated_at)
  SELECT item_id, location_id, CAST(qty AS REAL), last_movement_id, updated_at FROM stock_balances;
DROP TABLE stock_balances;
ALTER TABLE stock_balances_new RENAME TO stock_balances;
CREATE INDEX idx_stock_balances_item ON stock_balances(item_id);
CREATE INDEX idx_stock_balances_item_qty ON stock_balances(item_id, qty);

-- N13. Recreate stock_movements with REAL qty
CREATE TABLE IF NOT EXISTS stock_movements_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,
  kind_id      INTEGER NOT NULL REFERENCES stock_movement_kinds(id) ON DELETE NO ACTION,
  qty          REAL NOT NULL CHECK(qty <> 0),
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  ref_kind     TEXT    CHECK(ref_kind IN ('sale','purchase','return','adjustment') OR ref_kind IS NULL),
  ref_id       INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE NO ACTION
);
INSERT INTO stock_movements_new (id, item_id, location_id, kind_id, qty, unit_id, ref_kind, ref_id, note, created_at, created_by)
  SELECT id, item_id, location_id, kind_id, CAST(qty AS REAL), unit_id, ref_kind, ref_id, note, created_at, created_by FROM stock_movements;
DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;
CREATE INDEX idx_stock_movements_item_loc_created ON stock_movements(item_id, location_id, created_at DESC);
CREATE INDEX idx_stock_movements_loc_created ON stock_movements(location_id, created_at DESC);
CREATE INDEX idx_stock_movements_ref ON stock_movements(ref_kind, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX idx_stock_movements_kind_id ON stock_movements(kind_id);

-- Recreate the stock_movements_ai trigger for REAL qty
CREATE TRIGGER IF NOT EXISTS stock_movements_ai
AFTER INSERT ON stock_movements
FOR EACH ROW
BEGIN
  INSERT INTO stock_balances (item_id, location_id, qty, last_movement_id, updated_at)
  VALUES (NEW.item_id, NEW.location_id, NEW.qty, NEW.id, NEW.created_at)
  ON CONFLICT(item_id, location_id) DO UPDATE SET
    qty            = stock_balances.qty + excluded.qty,
    last_movement_id = excluded.last_movement_id,
    updated_at     = excluded.updated_at;
END;

-- Recreate the append-only triggers
CREATE TRIGGER IF NOT EXISTS stock_movements_bu
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only; insert a corrective movement instead');
END;

CREATE TRIGGER IF NOT EXISTS stock_movements_bd
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- N14. Recreate sale_items with REAL qty and new unit_type CHECK
CREATE TABLE IF NOT EXISTS sale_items_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
  kind          TEXT    NOT NULL DEFAULT 'item' CHECK(kind IN ('item','formula')),
  item_id       INTEGER REFERENCES items(id) ON DELETE NO ACTION,
  formula_id    INTEGER REFERENCES formulas(id) ON DELETE NO ACTION,
  qty           REAL NOT NULL CHECK(qty > 0),
  price         INTEGER NOT NULL CHECK(price >= 0),
  unit_type     TEXT    NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','mtr','kg')),
  line_discount INTEGER NOT NULL DEFAULT 0,
  shade_note    TEXT,
  line_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  created_by    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  CHECK ((item_id IS NOT NULL AND formula_id IS NULL)
      OR (item_id IS NULL AND formula_id IS NOT NULL))
);
INSERT INTO sale_items_new (id, sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order, created_at, created_by)
  SELECT id, sale_id, kind, item_id, formula_id, CAST(qty AS REAL), price,
         CASE WHEN unit_type = 'box' THEN 'unit' ELSE 'unit' END,
         line_discount, shade_note, line_order, created_at, created_by
  FROM sale_items;
DROP TABLE sale_items;
ALTER TABLE sale_items_new RENAME TO sale_items;
CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX idx_sale_items_item_id ON sale_items(item_id);
CREATE INDEX idx_sale_items_formula_id ON sale_items(formula_id);

-- N15. Recreate purchase_items with REAL qty
CREATE TABLE IF NOT EXISTS purchase_items_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id        INTEGER NOT NULL REFERENCES purchases(id) ON DELETE NO ACTION,
  item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  qty                REAL NOT NULL CHECK(qty > 0),
  unit_id            INTEGER NOT NULL REFERENCES units(id) ON DELETE NO ACTION,
  unit_price_paise   INTEGER NOT NULL CHECK(unit_price_paise >= 0),
  line_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK(line_discount_paise >= 0),
  line_total_paise   INTEGER NOT NULL CHECK(line_total_paise >= 0),
  created_at         INTEGER NOT NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION
);
INSERT INTO purchase_items_new (id, purchase_id, item_id, qty, unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at, created_by)
  SELECT id, purchase_id, item_id, CAST(qty AS REAL), unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at, created_by
  FROM purchase_items;
DROP TABLE purchase_items;
ALTER TABLE purchase_items_new RENAME TO purchase_items;
CREATE INDEX idx_purchase_items_purchase_id ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_item_id ON purchase_items(item_id);

-- N16. Drop unit_conversions table (no longer needed with 3 fixed units)
DROP TABLE IF EXISTS unit_conversions;

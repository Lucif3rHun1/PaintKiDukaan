-- Slice B domain tables (M_B1).
-- Authoritative schema lives in Slice A; this file is the dev/in-memory copy
-- so B can compile and unit-test before A merges. At integration time the
-- migrations are idempotent (IF NOT EXISTS) and Slice A's DB already has
-- these tables, so this is a no-op there.
--
-- Money fields are stored as INTEGER (whole rupees/paise not used).

-- Customer types (seeded: retail/painter/contractor/dealer).
CREATE TABLE IF NOT EXISTS customer_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Locations: soft delete only. items.location_text is free text referencing
-- the name (denormalised for fast barcode lookup); a foreign key would force
-- hard deletes when an item is sold/moved.
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  rack        TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Vendors.
CREATE TABLE IF NOT EXISTS vendors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  phone            TEXT,
  opening_balance  INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendors_phone ON vendors(phone);
CREATE INDEX IF NOT EXISTS idx_vendors_active ON vendors(is_active);

-- Customers.
CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL UNIQUE
                    CHECK(LENGTH(phone) = 10 AND phone GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  type_id           INTEGER REFERENCES customer_types(id),
  is_flagged        INTEGER NOT NULL DEFAULT 0,  -- owner-only set
  opening_balance   INTEGER NOT NULL DEFAULT 0 CHECK(opening_balance >= 0),
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_type  ON customers(type_id);
CREATE INDEX IF NOT EXISTS idx_customers_flag  ON customers(is_flagged);

-- Items.
CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_code        TEXT NOT NULL UNIQUE,                 -- minted from sequences.sku
  barcode         TEXT,                                  -- defaults to sku_code
  name            TEXT NOT NULL,
  brand           TEXT,
  category        TEXT,
  unit            TEXT NOT NULL DEFAULT 'pc'
                  CHECK(unit IN ('L','ml','kg','g','pc','box','bundle','roll','sqft','sqm')),
  pack_size       TEXT,                                  -- e.g. "4L", "1kg"
  units_per_box   INTEGER,                               -- for box→unit conversion
  sell_unit       TEXT NOT NULL DEFAULT 'unit'
                  CHECK(sell_unit IN ('unit','box')),
  retail_price    INTEGER NOT NULL DEFAULT 0,
  cost_price      INTEGER NOT NULL DEFAULT 0,
  label_line1     TEXT,
  label_line2     TEXT,
  location_text   TEXT,                                  -- free-text "Rack A / Bay 3"
  reorder_level   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_barcode   ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_sku       ON items(sku_code);
CREATE INDEX IF NOT EXISTS idx_items_name      ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_brand_cat ON items(brand, category);
CREATE INDEX IF NOT EXISTS idx_items_active    ON items(is_active);

-- Sequences (sku, sale_inv, sale_qtn). Slice B only mints sku.
CREATE TABLE IF NOT EXISTS sequences (
  name        TEXT PRIMARY KEY,
  last_value  INTEGER NOT NULL DEFAULT 0
);

-- ---- Stub tables from Slice C that B reads from for outstanding calc. ----
-- These are placeholders so B's read-side works in dev/tests. Slice A
-- integration replaces these with the real Slice C schema.

-- Customer payments against a sale (or on-account).
CREATE TABLE IF NOT EXISTS customer_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  sale_id      INTEGER REFERENCES sales(id),
  amount       INTEGER NOT NULL,
  mode         TEXT NOT NULL
              CHECK(mode IN ('cash','upi','card','bank','cheque')),
  date         TEXT NOT NULL,
  notes        TEXT,
  user_id      INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cust_pay_cust ON customer_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_cust_pay_date ON customer_payments(date);

-- Vendor payments.
CREATE TABLE IF NOT EXISTS vendor_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id),
  amount      INTEGER NOT NULL,
  mode        TEXT NOT NULL
              CHECK(mode IN ('cash','upi','card','bank','cheque')),
  date        TEXT NOT NULL,
  notes       TEXT,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_pay_vendor ON vendor_payments(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_pay_date   ON vendor_payments(date);

-- Sales (stub: just enough for B to compute customer_outstanding).
CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER REFERENCES customers(id),
  total         INTEGER NOT NULL DEFAULT 0,
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'final',     -- 'quotation' | 'final' | 'cancelled'
  date          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status   ON sales(status);

-- Purchases (stub: just enough for B to compute vendor_outstanding).
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id),
  total       INTEGER NOT NULL DEFAULT 0,
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_vendor ON purchases(vendor_id);

-- Stock movements (stub; Slice C writes here, B reads qty_per_loc for
-- the role-aware lookup_item).
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  qty         REAL NOT NULL,    -- signed: +inward, -sale
  type        TEXT NOT NULL,    -- 'inward' | 'sale' | 'adjust'
  location    TEXT,             -- text label
  date        TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_mv_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_mv_loc  ON stock_movements(location);

-- Aggregated per-item-per-location stock. Slice C maintains it via trigger;
-- B reads it for the stocker role in lookup_item.
CREATE TABLE IF NOT EXISTS stock_balances (
  item_id     INTEGER NOT NULL REFERENCES items(id),
  location    TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, location)
);

-- Stock movement append-only enforcement (Momus fix: BEFORE triggers RAISE).
CREATE TRIGGER IF NOT EXISTS stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;
CREATE TRIGGER IF NOT EXISTS stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

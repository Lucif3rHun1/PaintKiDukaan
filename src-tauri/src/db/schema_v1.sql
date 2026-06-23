PRAGMA foreign_keys = ON;

-- Locations (Shop, Godown by default; owner can rename)
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rack TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Devices
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','cashier','stocker')),
  pubkey_fingerprint TEXT NOT NULL UNIQUE,
  cert_pem TEXT NOT NULL,
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
  pin_salt BLOB NOT NULL,
  pin_verifier BLOB NOT NULL,
  pin_length INTEGER NOT NULL CHECK(pin_length IN (4,6)),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_users_name ON users(name) WHERE active = 1;

-- Lockout state
CREATE TABLE lockouts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  wipe_on_next_fail INTEGER NOT NULL DEFAULT 0
);

-- Customer types (lookup)
CREATE TABLE customer_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO customer_types(name) VALUES ('retailer'),('dealer'),('painter'),('contractor');

-- Customers
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  type_id INTEGER REFERENCES customer_types(id),
  is_flagged INTEGER NOT NULL DEFAULT 0,
  credit_limit INTEGER,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_name ON customers(name);

-- Vendors
CREATE TABLE vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Items
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,
  barcode TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  unit TEXT NOT NULL CHECK(unit IN ('L','ml','kg','g','pc','box','bundle','roll','sqft','sqm')),
  pack_size TEXT,
  units_per_box INTEGER,
  sell_unit TEXT NOT NULL DEFAULT 'unit' CHECK(sell_unit IN ('unit','box')),
  retail_price INTEGER NOT NULL,
  cost_price INTEGER NOT NULL,
  label_line1 TEXT,
  label_line2 TEXT,
  location_text TEXT,
  reorder_level INTEGER NOT NULL DEFAULT 0,
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
  qty INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('inward','sale','transfer','adjust')),
  ref_type TEXT,
  ref_id INTEGER,
  reason TEXT,
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

-- Trigger: after insert on stock_movements, upsert stock_balances
CREATE TRIGGER stock_movements_ai
AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO stock_balances(item_id, location_id, qty)
  VALUES (NEW.item_id, NEW.location_id, NEW.qty)
  ON CONFLICT(item_id, location_id)
  DO UPDATE SET qty = qty + excluded.qty;
END;

-- Append-only enforcement: block UPDATE on stock_movements
CREATE TRIGGER stock_movements_bu
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- Append-only enforcement: block DELETE on stock_movements
CREATE TRIGGER stock_movements_bd
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- Purchases (inward)
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER REFERENCES vendors(id),
  date TEXT NOT NULL,
  total INTEGER NOT NULL,
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
  qty INTEGER NOT NULL,
  cost_price INTEGER NOT NULL,
  retail_price INTEGER NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id)
);
CREATE INDEX idx_pi_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_pi_item ON purchase_items(item_id);

-- Vendor payments
CREATE TABLE vendor_payments (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  amount INTEGER NOT NULL,
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
  no TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('quotation','final')),
  subtotal INTEGER NOT NULL,
  bill_discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  payment_modes_json TEXT NOT NULL DEFAULT '[]',
  validity_days INTEGER,
  converted_from_id INTEGER REFERENCES sales(id),
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
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  unit_type TEXT NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','box')),
  line_discount INTEGER NOT NULL DEFAULT 0,
  shade_note TEXT,
  line_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_si_sale ON sale_items(sale_id);
CREATE INDEX idx_si_item ON sale_items(item_id);

-- Customer payments (khata settlements)
CREATE TABLE customer_payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('cash','upi','card','bank','cheque')),
  date TEXT NOT NULL,
  notes TEXT,
  sale_id INTEGER REFERENCES sales(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cp_customer ON customer_payments(customer_id);
CREATE INDEX idx_cp_date ON customer_payments(date);

-- Day close (per-user, per-tender variance computed)
CREATE TABLE day_close (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opening_cash INTEGER NOT NULL DEFAULT 0,
  cash_sales INTEGER NOT NULL DEFAULT 0,
  cash_in INTEGER NOT NULL DEFAULT 0,
  cash_out INTEGER NOT NULL DEFAULT 0,
  counted_cash INTEGER NOT NULL,
  expected_cash INTEGER NOT NULL,
  variance INTEGER NOT NULL,
  notes TEXT,
  backup_check_status TEXT NOT NULL CHECK(backup_check_status IN ('fresh','stale','skipped')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_day_close_user_date ON day_close(user_id, date);

-- Sequence tracking for master-issued numbers
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
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
  label_cfg_json TEXT,
  receipt_cfg_json TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK(tax_mode IN ('none')),
  idle_lock_minutes INTEGER NOT NULL DEFAULT 5,
  lockout_action TEXT NOT NULL DEFAULT 'timeout' CHECK(lockout_action IN ('timeout','wipe')),
  lockout_timeout_minutes INTEGER NOT NULL DEFAULT 15,
  last_backup_at TEXT,
  last_test_restore_at TEXT,
  scanner_avg_ms_per_char INTEGER NOT NULL DEFAULT 30,
  scanner_suffix_keycodes TEXT NOT NULL DEFAULT '[9,13]',
  scanner_min_length INTEGER NOT NULL DEFAULT 6,
  master_lan_ip TEXT,
  master_lan_port INTEGER NOT NULL DEFAULT 7842,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO settings(id) VALUES (1);

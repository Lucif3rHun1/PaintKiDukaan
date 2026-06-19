-- Slice B cleanup: drop stale credit_limit column, convert money fields to INTEGER,
-- and add CHECK constraints for customer phone / opening_balance.
--
-- SQLite does not support ALTER COLUMN; we recreate affected tables.

PRAGMA foreign_keys = OFF;

-- customers: drop credit_limit, convert opening_balance to INTEGER, add CHECKs.
CREATE TABLE customers_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL UNIQUE CHECK(LENGTH(phone) = 10 AND phone GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  type_id           INTEGER REFERENCES customer_types(id),
  is_flagged        INTEGER NOT NULL DEFAULT 0,
  opening_balance   INTEGER NOT NULL DEFAULT 0 CHECK(opening_balance >= 0),
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO customers_new (
  id, name, phone, type_id, is_flagged, opening_balance, notes, is_active, created_at, updated_at
)
SELECT
  id, name, phone, type_id, is_flagged, COALESCE(ROUND(opening_balance), 0), notes, is_active, created_at, updated_at
FROM customers;
DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;

-- customer_payments.amount -> INTEGER
CREATE TABLE customer_payments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount      INTEGER NOT NULL CHECK(amount >= 0),
  mode        TEXT NOT NULL,
  date        TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO customer_payments_new (id, customer_id, amount, mode, date, user_id, created_at)
SELECT id, customer_id, COALESCE(ROUND(amount), 0), mode, date, user_id, created_at
FROM customer_payments;
DROP TABLE customer_payments;
ALTER TABLE customer_payments_new RENAME TO customer_payments;

-- vendors.opening_balance -> INTEGER
CREATE TABLE vendors_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  phone             TEXT,
  email             TEXT,
  gstin             TEXT,
  opening_balance   INTEGER NOT NULL DEFAULT 0 CHECK(opening_balance >= 0),
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO vendors_new (
  id, name, phone, email, gstin, opening_balance, notes, is_active, created_at, updated_at
)
SELECT
  id, name, phone, email, gstin, COALESCE(ROUND(opening_balance), 0), notes, is_active, created_at, updated_at
FROM vendors;
DROP TABLE vendors;
ALTER TABLE vendors_new RENAME TO vendors;

-- vendor_payments.amount -> INTEGER
CREATE TABLE vendor_payments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id),
  amount      INTEGER NOT NULL CHECK(amount >= 0),
  mode        TEXT NOT NULL,
  date        TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO vendor_payments_new (id, vendor_id, amount, mode, date, user_id, created_at)
SELECT id, vendor_id, COALESCE(ROUND(amount), 0), mode, date, user_id, created_at
FROM vendor_payments;
DROP TABLE vendor_payments;
ALTER TABLE vendor_payments_new RENAME TO vendor_payments;

-- sales.total/paid_amount -> INTEGER
CREATE TABLE sales_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  total       INTEGER NOT NULL CHECK(total >= 0),
  paid_amount INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
  status      TEXT NOT NULL DEFAULT 'draft',
  date        TEXT NOT NULL,
  user_id     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_new (id, customer_id, total, paid_amount, status, date, user_id, created_at, updated_at)
SELECT id, customer_id, COALESCE(ROUND(total), 0), COALESCE(ROUND(paid_amount), 0), status, date, user_id, created_at, updated_at
FROM sales;
DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;

-- purchases.total -> INTEGER
CREATE TABLE purchases_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER REFERENCES vendors(id),
  total       INTEGER NOT NULL CHECK(total >= 0),
  status      TEXT NOT NULL DEFAULT 'draft',
  date        TEXT NOT NULL,
  user_id     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO purchases_new (id, vendor_id, total, status, date, user_id, created_at, updated_at)
SELECT id, vendor_id, COALESCE(ROUND(total), 0), status, date, user_id, created_at, updated_at
FROM purchases;
DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;

-- items.retail_price/cost_price/reorder_level -> INTEGER
CREATE TABLE items_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id),
  unit_id       INTEGER NOT NULL REFERENCES units(id),
  brand         TEXT,
  retail_price  INTEGER NOT NULL CHECK(retail_price >= 0),
  cost_price    INTEGER NOT NULL CHECK(cost_price >= 0),
  in_stock      REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO items_new (
  id, sku, name, category_id, unit_id, brand, retail_price, cost_price, in_stock,
  reorder_level, notes, is_active, created_at, updated_at
)
SELECT
  id, sku, name, category_id, unit_id, brand, COALESCE(ROUND(retail_price), 0),
  COALESCE(ROUND(cost_price), 0), in_stock, reorder_level, notes, is_active,
  created_at, updated_at
FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

PRAGMA foreign_keys = ON;

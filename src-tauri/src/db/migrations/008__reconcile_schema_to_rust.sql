-- 008 — Reconcile canonical schema to Rust command shape.
--
-- The Rust commands (commands/sales.rs, commands/customers.rs) use a flatter
-- shape than the schema: integer paise columns, embedded payment_modes JSON,
-- `no` (not `sale_number`), `kind` (not `status`), `unit_type: "unit"|"box"`
-- (not `unit_id`+`unit_price_paise`+`line_total_paise`).
--
-- No production data exists; this migration aligns columns to what the
-- working Rust code expects so tests can run against a coherent schema.

-- 1) Rename sale_number → no on the sales header.
ALTER TABLE sales RENAME COLUMN sale_number TO no;

-- 2) Add the columns the Rust code reads but the schema lacks.
ALTER TABLE sales ADD COLUMN customer_name TEXT;
ALTER TABLE sales ADD COLUMN payment_modes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sales ADD COLUMN date TEXT NOT NULL DEFAULT '';

-- 3) The Rust status enum is 'quotation' | 'final'; the schema currently
--    enforces 'open' | 'finalized' | 'voided' | 'converted' AND has a
--    separate `kind` column with 'quotation' | 'invoice'. We collapse to
--    a single `status` column with the Rust enum. Drop the old CHECK
--    (SQLite cannot drop a CHECK, so we recreate the table).
PRAGMA foreign_keys = OFF;
CREATE TABLE sales_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  no                 TEXT    NOT NULL UNIQUE,
  status             TEXT    NOT NULL DEFAULT 'quotation'
                       CHECK(status IN ('quotation','final')),
  customer_id        INTEGER REFERENCES customers(id) ON DELETE NO ACTION,
  customer_name      TEXT,
  date               TEXT    NOT NULL DEFAULT '',
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  subtotal           INTEGER NOT NULL DEFAULT 0,
  bill_discount      INTEGER NOT NULL DEFAULT 0,
  total              INTEGER NOT NULL DEFAULT 0,
  paid_amount        INTEGER NOT NULL DEFAULT 0,
  payment_modes      TEXT    NOT NULL DEFAULT '[]',
  validity_days      INTEGER,
  converted_from_id  INTEGER REFERENCES sales(id) ON DELETE NO ACTION,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_new (
  id, no, status, customer_id, customer_name, date, user_id,
  subtotal, bill_discount, total, paid_amount, payment_modes,
  validity_days, converted_from_id, created_at
)
SELECT
  id,
  no,
  CASE
    WHEN kind = 'quotation' AND status = 'open'           THEN 'quotation'
    WHEN kind = 'quotation' AND status = 'converted'     THEN 'final'
    WHEN kind = 'invoice'   AND status = 'open'           THEN 'final'
    WHEN kind = 'invoice'   AND status = 'finalized'      THEN 'final'
    WHEN kind = 'invoice'   AND status = 'voided'         THEN 'final'
    ELSE 'final'
  END,
  customer_id,
  NULL,
  COALESCE(date(date(substr(created_at, 1, 4) || '-' || substr(created_at, 5, 2) || '-' || substr(created_at, 7, 2))), ''),
  user_id,
  subtotal_paise,
  discount_paise,
  total_paise,
  paid_paise,
  '[]',
  validity_days,
  converted_from_id,
  COALESCE(created_at, datetime('now'))
FROM sales;
DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;
CREATE INDEX idx_sales_user_created    ON sales(user_id, created_at DESC);
CREATE INDEX idx_sales_customer_created ON sales(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_sales_status          ON sales(status);

-- 4) sale_items: align to the Rust SaleItem shape
--    (unit_type TEXT, price INTEGER, line_discount INTEGER, shade_note TEXT,
--    line_order INTEGER, qty in BASE units).
PRAGMA foreign_keys = OFF;
CREATE TABLE sale_items_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  qty           INTEGER NOT NULL CHECK(qty > 0),
  price         INTEGER NOT NULL CHECK(price >= 0),
  unit_type     TEXT    NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','box')),
  line_discount INTEGER NOT NULL DEFAULT 0,
  shade_note    TEXT,
  line_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sale_items_new (id, sale_id, item_id, qty, price, unit_type, line_discount, shade_note, line_order, created_at)
SELECT
  id, sale_id, item_id, qty, unit_price_paise,
  CASE WHEN u.code = 'box' THEN 'box' ELSE 'unit' END,
  line_discount_paise, NULL, 0, COALESCE(created_at, datetime('now'))
FROM sale_items
LEFT JOIN units u ON u.id = sale_items.unit_id;
DROP TABLE sale_items;
ALTER TABLE sale_items_new RENAME TO sale_items;
CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX idx_sale_items_item_id ON sale_items(item_id);

-- 5) sale_returns: drop unused refund_total_paise (Rust computes it from
--    sale_return_lines); keep reason + audit columns and add the `no` column
--    that migration 007 added.
--    Migration 007 already added `no TEXT`; nothing to do here.

-- 6) customers: align to the Rust Customer shape.
--    - Drop `email`/`address` (Rust doesn't read them).
--    - Add `is_flagged` (Rust reads it for the flagged-customer banner).
--    - Rename `customer_type_id` → keep as-is (matches Rust).
PRAGMA foreign_keys = OFF;
CREATE TABLE customers_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  phone                TEXT,
  customer_type_id     INTEGER REFERENCES customer_types(id) ON DELETE NO ACTION,
  is_flagged           INTEGER NOT NULL DEFAULT 0 CHECK(is_flagged IN (0,1)),
  opening_balance_paise INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  updated_by           INTEGER REFERENCES users(id) ON DELETE NO ACTION
);
INSERT INTO customers_new (id, name, phone, customer_type_id, is_flagged, opening_balance_paise, notes, is_active, created_at, updated_at, created_by, updated_by)
SELECT id, name, phone, customer_type_id, 0, opening_balance_paise, notes, is_active,
       COALESCE(created_at, datetime('now')), COALESCE(updated_at, datetime('now')),
       created_by, updated_by
FROM customers;
DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;
CREATE INDEX idx_customers_is_active_name ON customers(is_active, name);
CREATE INDEX idx_customers_phone          ON customers(phone) WHERE phone IS NOT NULL AND is_active = 1;

PRAGMA foreign_keys = ON;

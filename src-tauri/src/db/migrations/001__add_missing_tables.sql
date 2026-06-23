-- Migration 001: Add tables that were added to schema.sql after initial release.
-- Uses IF NOT EXISTS so it's safe to run on databases that already have some of these.

-- B2. Units helper
CREATE TABLE IF NOT EXISTS unit_conversions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_unit_id   INTEGER NOT NULL REFERENCES units(id),
  to_unit_id     INTEGER NOT NULL REFERENCES units(id),
  factor         REAL    NOT NULL CHECK(factor > 0),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  created_by     INTEGER REFERENCES users(id),
  updated_by     INTEGER REFERENCES users(id),
  UNIQUE(from_unit_id, to_unit_id)
);

-- D1. Brand sequences
CREATE TABLE IF NOT EXISTS brand_sequences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id   INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  next_seq   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(brand_id)
);

-- B1. Sub-locations
CREATE TABLE IF NOT EXISTS sub_locations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  position      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  created_by    INTEGER REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  UNIQUE(location_id, name)
);

-- H1. Sale return lines
CREATE TABLE IF NOT EXISTS sale_return_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_return_id  INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id    INTEGER NOT NULL REFERENCES sale_items(id),
  item_id         INTEGER NOT NULL REFERENCES items(id),
  qty             INTEGER NOT NULL CHECK(qty > 0),
  unit_price_paise INTEGER NOT NULL,
  line_total_paise INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

-- F3. Vendor payments
CREATE TABLE IF NOT EXISTS vendor_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id     INTEGER NOT NULL REFERENCES vendors(id),
  amount_paise  INTEGER NOT NULL,
  method        TEXT    NOT NULL DEFAULT 'cash',
  note          TEXT,
  sale_id       INTEGER REFERENCES sales(id),
  purchase_id   INTEGER REFERENCES purchases(id),
  user_id       INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL
);

-- Label print audit log
CREATE TABLE IF NOT EXISTS label_print_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE NO ACTION,
  barcode    TEXT    NOT NULL,
  qty        INTEGER NOT NULL CHECK(qty > 0),
  format     TEXT    NOT NULL,
  line1      TEXT,
  line2      TEXT,
  user_id    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_label_print_log_item_created ON label_print_log(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_label_print_log_created     ON label_print_log(created_at DESC);

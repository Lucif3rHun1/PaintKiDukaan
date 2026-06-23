-- V14: customer sale returns.
--
-- A `sale_return` is the inverse of a sale: stock comes back into the chosen
-- location, the customer's outstanding is reduced, and any cash/UPI/card
-- refund is recorded.  Lines can reference one or more original sales or be
-- standalone (e.g. customer has no invoice handy).

-- We need to add 'return' to the stock_movements type CHECK. SQLite does not
-- support ALTER TABLE ... DROP CONSTRAINT, so the table must be recreated.
PRAGMA foreign_keys = OFF;

CREATE TABLE stock_movements_new (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('inward','sale','transfer','adjust','return')),
  ref_type TEXT,
  ref_id INTEGER,
  reason TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO stock_movements_new SELECT * FROM stock_movements;
DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;

CREATE INDEX idx_mov_item_loc_qty ON stock_movements(item_id, location_id, qty);
CREATE INDEX idx_mov_item_loc_created_id ON stock_movements(item_id, location_id, created_at DESC, id DESC);
CREATE INDEX idx_mov_created ON stock_movements(created_at);
CREATE INDEX idx_mov_ref ON stock_movements(ref_type, ref_id);

CREATE TRIGGER stock_movements_ai
AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO stock_balances(item_id, location_id, qty)
  VALUES (NEW.item_id, NEW.location_id, NEW.qty)
  ON CONFLICT(item_id, location_id)
  DO UPDATE SET qty = qty + excluded.qty;
END;

CREATE TRIGGER stock_movements_bu
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER stock_movements_bd
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

PRAGMA foreign_keys = ON;

-- Return document header.
CREATE TABLE sale_returns (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  date TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  total INTEGER NOT NULL,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  outstanding_reduction INTEGER NOT NULL DEFAULT 0,
  payment_modes_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','voided')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_sale_returns_date ON sale_returns(date);
CREATE INDEX idx_sale_returns_customer ON sale_returns(customer_id);
CREATE INDEX idx_sale_returns_status ON sale_returns(status);
CREATE INDEX idx_sale_returns_user_date ON sale_returns(user_id, date);
CREATE UNIQUE INDEX idx_sale_returns_no ON sale_returns(no);

-- Return lines.
CREATE TABLE sale_return_lines (
  id INTEGER PRIMARY KEY,
  sale_return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id),
  sale_item_id INTEGER REFERENCES sale_items(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  line_total INTEGER NOT NULL,
  reason TEXT,
  line_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_srl_return ON sale_return_lines(sale_return_id);
CREATE INDEX idx_srl_item ON sale_return_lines(item_id);
CREATE INDEX idx_srl_sale ON sale_return_lines(sale_id);

-- Sequence for return numbers (RET-YYYY-XXXX).
INSERT INTO sequences(name) VALUES ('sale_return');

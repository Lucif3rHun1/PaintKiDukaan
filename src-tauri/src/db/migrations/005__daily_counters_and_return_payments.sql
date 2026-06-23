-- =====================================================================
-- Migration 005 — Daily invoice/quotation counters + sale return payments
-- =====================================================================

-- Daily counters for POS invoice and quotation numbering.
-- Format exposed to frontend: INV/DD-MM-YYYY/001 and QTN/DD-MM-YYYY/001.
-- The counter resets for each calendar day automatically because the date
-- is part of the primary key.
CREATE TABLE IF NOT EXISTS daily_counters (
  prefix       TEXT    NOT NULL,
  date         TEXT    NOT NULL,                  -- 'DD-MM-YYYY'
  last_serial  INTEGER NOT NULL DEFAULT 0 CHECK(last_serial >= 0),
  PRIMARY KEY (prefix, date)
);

-- Refund payment modes for sales returns (mirror of sale_payments).
CREATE TABLE IF NOT EXISTS sale_return_payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_return_id    INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE NO ACTION,
  mode              TEXT    NOT NULL,
  amount_paise      INTEGER NOT NULL CHECK(amount_paise <> 0),
  reference         TEXT,
  created_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE NO ACTION
);

-- serves: "payments for this return"
CREATE INDEX IF NOT EXISTS idx_sale_return_payments_return_id ON sale_return_payments(sale_return_id);

-- serves: "all UPI refunds today"
CREATE INDEX IF NOT EXISTS idx_sale_return_payments_mode_created ON sale_return_payments(mode, created_at DESC);

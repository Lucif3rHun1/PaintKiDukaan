-- V6: Normalized sale payments.
--
-- Replaces the JSON blob in `sales.payment_modes_json` with a relational table.
-- ADR-006: sale_payments table is the source of truth for how a sale was paid.
-- Per ADR-008: credit is NOT a payment mode; it is implicit when paid < total.
--
-- Adds:
--   * sale_payments — one row per (sale, mode, amount) triple.
--   * idx_sp_sale, idx_sp_mode_date — query indexes.
--
-- Note: payment_modes_json column on sales is retained (set to '[]' on writes)
-- so older code paths that still read it don't blow up. New reads MUST use
-- sale_payments.

CREATE TABLE IF NOT EXISTS sale_payments (
  id         INTEGER PRIMARY KEY,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  mode       TEXT    NOT NULL CHECK(mode IN ('cash','upi','card','bank','cheque')),
  amount     INTEGER NOT NULL CHECK(amount > 0),
  date       TEXT    NOT NULL,
  notes      TEXT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sp_sale ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sp_mode_date ON sale_payments(mode, date);

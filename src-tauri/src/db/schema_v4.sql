-- V3: brands table + per-brand barcode sequence.
-- Does not share idx_*_is_active_name or UNIQUE-on-name patterns; see M-INLINE-026 in mod.rs.
--
-- Adds:
--   * brands            — lookup of paint-brand short codes (e.g. "AP" → Asian Paints).
--   * brand_sequences   — per-brand next-N counter (APACE001, APACE002, …).
--   * items.brand_id    — FK to brands (NULL allowed; existing free-text items.brand kept).
--   * idx_items_brand_id
--
-- Backfills:
--   * UPDATE items SET barcode = sku_code WHERE barcode IS NULL OR barcode = ''
--     so every item is immediately scannable by the POS lookup_item command.
--
-- All statements are idempotent (IF NOT EXISTS / OR IGNORE / column-add guarded
-- via SQLite error tolerance — see migrations.rs which uses rusqlite_migration's
-- no-transaction per-statement mode for v3).

-- ── Brands ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  code_prefix TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Per-brand barcode sequence counter ───────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_sequences (
  brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL DEFAULT 1
);

-- ── Seed 13 reputed Indian paint brands (idempotent) ─────────────────────
INSERT OR IGNORE INTO brands (id, name, code_prefix) VALUES
  (1,  'Asian Paints',   'AP'),
  (2,  'Birla Opus',     'BO'),
  (3,  'Berger Paints',  'BG'),
  (4,  'Kansai Nerolac', 'KN'),
  (5,  'Dulux',          'DL'),
  (6,  'Indigo',         'IN'),
  (7,  'Nippon',         'NP'),
  (8,  'British',        'BR'),
  (9,  'Shalimar',       'SH'),
  (10, 'Snowcem',        'SC'),
  (11, 'Kamdhenu',       'KA'),
  (12, 'Jenson',         'JN'),
  (13, 'Mysore',         'MY');

-- Each brand starts at seq = 1.
INSERT OR IGNORE INTO brand_sequences (brand_id, next_seq)
  SELECT id, 1 FROM brands;

-- ── FK from items.brand_id → brands.id ───────────────────────────────────
-- SQLite ALTER TABLE ADD COLUMN does not support IF NOT EXISTS pre-3.35, so
-- we guard via pragma table_info check (migrations.rs wraps v3 in
-- rusqlite_migration's no-tx mode which lets us recover from the duplicate-
-- column error).
ALTER TABLE items ADD COLUMN brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_items_brand_id ON items(brand_id);

-- ── Backfill: every existing item gets a scannable barcode ───────────────
UPDATE items SET barcode = sku_code WHERE barcode IS NULL OR barcode = '';
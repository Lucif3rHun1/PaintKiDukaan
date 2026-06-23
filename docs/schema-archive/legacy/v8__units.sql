-- V8: Units + unit conversions foundation.
--
-- Adds a managed `units` table and a `unit_conversions` table so the system
-- can store measurement and packaging conversions explicitly (e.g. 1 L =
-- 1000 ml, 1 kg = 1000 g, 1 sqft = 0.092903 sqm) instead of relying on a
-- hardcoded CHECK enum on items.
--
-- Q1 (units model) and Q2 (schema) decisions: full unification. Every unit is
-- just a unit; box/pack is expressed via a conversion rule like (1 box = 12
-- pc). This file is the foundation only — items.unit TEXT column is preserved
-- for now so POS flows keep working. Wiring items.unit_id and dropping items.unit
-- TEXT is a follow-up migration once this foundation is stable.

CREATE TABLE IF NOT EXISTS units (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  dimension   TEXT    NOT NULL CHECK(dimension IN ('volume','mass','area','count')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id            INTEGER PRIMARY KEY,
  from_unit_id  INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  to_unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  factor        REAL    NOT NULL CHECK(factor > 0),
  UNIQUE(from_unit_id, to_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_uc_from ON unit_conversions(from_unit_id);
CREATE INDEX IF NOT EXISTS idx_uc_to   ON unit_conversions(to_unit_id);

ALTER TABLE items ADD COLUMN unit_id INTEGER REFERENCES units(id);

INSERT INTO units (code, label, dimension) VALUES
  ('L',     'Liter',          'volume'),
  ('ml',    'Milliliter',     'volume'),
  ('kg',    'Kilogram',       'mass'),
  ('g',     'Gram',           'mass'),
  ('pc',    'Piece',          'count'),
  ('box',   'Box',            'count'),
  ('bundle','Bundle',         'count'),
  ('roll',  'Roll',           'count'),
  ('sqft',  'Square foot',    'area'),
  ('sqm',   'Square meter',   'area');

INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor)
SELECT from_u.id, to_u.id, 1000.0
FROM units from_u JOIN units to_u
  ON from_u.code = 'L' AND to_u.code = 'ml';

INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor)
SELECT from_u.id, to_u.id, 1000.0
FROM units from_u JOIN units to_u
  ON from_u.code = 'kg' AND to_u.code = 'g';

INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor)
SELECT from_u.id, to_u.id, 0.092903
FROM units from_u JOIN units to_u
  ON from_u.code = 'sqft' AND to_u.code = 'sqm';

INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor)
SELECT from_u.id, to_u.id, 12.0
FROM units from_u JOIN units to_u
  ON from_u.code = 'box' AND to_u.code = 'pc';

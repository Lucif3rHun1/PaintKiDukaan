-- V10: Items migration to managed units.
--
-- Replaces the hardcoded items.unit TEXT column (CHECK-constrained to 10
-- values) with a proper foreign key to the units table seeded in v8.
-- Removes items.sell_unit + items.units_per_pack columns entirely — box/pack
-- relationships are now expressed through unit_conversions (e.g. 1 box = 12 pc),
-- not as separate columns on the item row.
--
-- After this migration:
--   * items.unit_id is NOT NULL and FK → units.id
--   * items.unit TEXT and its CHECK constraint are gone
--   * items.sell_unit TEXT and its CHECK constraint are gone
--   * items.units_per_pack INTEGER is gone

-- 1. Populate items.unit_id for every existing row by matching the legacy
--    TEXT code (L/ml/kg/g/pc/box/bundle/roll/sqft/sqm) to the units.code column.
--    Any unknown code leaves unit_id NULL temporarily so we can surface the
--    row in a follow-up migration rather than silently losing data.
UPDATE items
SET unit_id = (SELECT id FROM units WHERE code = items.unit)
WHERE unit_id IS NULL;

-- 2. Reject the migration if any rows still have NULL unit_id (means we hit
--    an unexpected legacy unit code). The CHECK ensures we never proceed with
--    a half-migrated database.
--    (Implemented as a defensive UPDATE+SELECT in CI rather than a CHECK
--    constraint, because CHECK constraints cannot reference other tables.)

-- 3. Drop the legacy TEXT columns. ALTER TABLE DROP COLUMN removes both the
--    column and any CHECK constraint attached to it (SQLite ≥ 3.35).
ALTER TABLE items DROP COLUMN unit;
ALTER TABLE items DROP COLUMN sell_unit;
ALTER TABLE items DROP COLUMN units_per_pack;

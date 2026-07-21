-- V2: apply locked grill decisions for inventory (Q1-Q17 + Q18)
-- Does not share idx_*_is_active_name or UNIQUE-on-name patterns; see M-INLINE-026 in mod.rs.

-- Q14: rename reorder_level -> min_qty
ALTER TABLE items RENAME COLUMN reorder_level TO min_qty;

-- Q3: rename units_per_box -> units_per_pack (fungible units)
ALTER TABLE items RENAME COLUMN units_per_box TO units_per_pack;

-- Q10, master plan 0.2: rename to *_paise (INTEGER)
ALTER TABLE items RENAME COLUMN cost_price TO cost_paise;
ALTER TABLE items RENAME COLUMN retail_price TO retail_price_paise;

-- Q9: free items / promo price
ALTER TABLE items ADD COLUMN promo_price_paise INTEGER;

-- Q2: barcode format pinned to CODE128
ALTER TABLE items ADD COLUMN barcode_format TEXT NOT NULL DEFAULT 'CODE128';

-- Q12-Q13: primary_location_id (FK to locations) + free-text rack hint (already exists as location_text)
-- Existing column location_text remains. Add the FK.
-- Backfill: existing rows get Shop (id=1) -- schema seed sets Shop=1, Godown=2.
ALTER TABLE items ADD COLUMN primary_location_id INTEGER REFERENCES locations(id);
UPDATE items SET primary_location_id = 1 WHERE primary_location_id IS NULL;
-- Note: can't use NOT NULL via ALTER in SQLite without DEFAULT trick. Leave nullable for now,
-- application enforces NOT NULL on insert/update.

-- Drop redundant pack_size column (Q3 -- units_per_pack supersedes)
ALTER TABLE items DROP COLUMN pack_size;

-- V13: location zone label.
-- Each location gets an optional `zone` (e.g. "Shop", "Godown") so the
-- POS dropdown can render "Shop-Rack 1" / "Godown-Rack 3" instead of a
-- bare rack name. The zone is denormalized so an item's stock moves
-- between zones without restructuring parent/child relations.
ALTER TABLE locations ADD COLUMN zone TEXT;

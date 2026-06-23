-- V12: Sub-locations + item positioning.
-- Sub-locations give structured rack/shelf/position tracking per location.
-- items get sub_location_id (FK) and position (INTEGER) for ordering within a sub-location.

CREATE TABLE sub_locations (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(location_id, name)
);

ALTER TABLE items ADD COLUMN sub_location_id INTEGER REFERENCES sub_locations(id);
ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

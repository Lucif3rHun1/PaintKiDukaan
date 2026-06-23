ALTER TABLE units ADD COLUMN dimension TEXT NOT NULL DEFAULT 'count';

UPDATE units SET dimension = 'volume' WHERE code IN ('L', 'ml');
UPDATE units SET dimension = 'mass'   WHERE code IN ('kg', 'g');
UPDATE units SET dimension = 'area'   WHERE code IN ('sqft', 'sqm');

INSERT OR IGNORE INTO brands (name, prefix, created_at, updated_at) VALUES
  ('Asian Paints',       'AP', 0, 0),
  ('Berger Paints',      'BG', 0, 0),
  ('Kansai Nerolac',     'KN', 0, 0),
  ('Dulux',              'DL', 0, 0),
  ('Shalimar',           'SH', 0, 0),
  ('British Paints',     'BR', 0, 0),
  ('Nippon Paint',       'NP', 0, 0),
  ('Indigo Paints',      'IN', 0, 0),
  ('Birla Opus',         'BO', 0, 0),
  ('Kamdhenu Paints',    'KA', 0, 0),
  ('Snowcem',            'SC', 0, 0),
  ('Jenson & Nicholson', 'JN', 0, 0),
  ('Mysore Paints',      'MY', 0, 0);

INSERT OR IGNORE INTO brand_sequences (brand_id, prefix, next_seq, padding, updated_at)
  SELECT id, prefix, 1, 4, 0 FROM brands;

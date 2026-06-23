BEGIN;

CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  use_case TEXT NOT NULL CHECK(use_case IN ('receipt','label')),
  connection_type TEXT NOT NULL CHECK(connection_type IN ('usb','bluetooth','network','serial','system')),
  address TEXT NOT NULL DEFAULT '',
  driver_name TEXT,
  port_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS printer_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id INTEGER NOT NULL UNIQUE REFERENCES printers(id) ON DELETE CASCADE,
  label_width_mm INTEGER,
  label_height_mm INTEGER,
  paper_size TEXT CHECK(paper_size IN ('thermal-58mm','thermal-80mm','A4','A5') OR paper_size IS NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (label_width_mm IS NOT NULL AND label_height_mm IS NOT NULL AND paper_size IS NULL) OR
    (paper_size IS NOT NULL AND label_width_mm IS NULL AND label_height_mm IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_default_per_usecase
  ON printers(use_case) WHERE is_default = 1;

INSERT OR IGNORE INTO printers (name, use_case, connection_type, address, driver_name, port_name, is_default)
SELECT
  json_extract(p.value, '$.name'),
  CASE lower(coalesce(json_extract(p.value, '$.kind'), json_extract(p.value, '$.use_case'), 'label'))
    WHEN 'receipt' THEN 'receipt'
    ELSE 'label'
  END,
  CASE lower(coalesce(json_extract(p.value, '$.connection_type'), 'usb'))
    WHEN 'usb' THEN 'usb'
    WHEN 'bluetooth' THEN 'bluetooth'
    WHEN 'network' THEN 'network'
    WHEN 'serial' THEN 'serial'
    ELSE 'system'
  END,
  coalesce(json_extract(p.value, '$.address'), ''),
  json_extract(p.value, '$.driver_name'),
  json_extract(p.value, '$.port_name'),
  CASE WHEN json_extract(p.value, '$.is_default') IN (1, 'true') THEN 1 ELSE 0 END
FROM settings s, json_each(s.printers) p
WHERE s.id = 1
  AND json_valid(s.printers);

INSERT OR IGNORE INTO printer_mappings (printer_id, label_width_mm, label_height_mm, paper_size)
SELECT
  pr.id,
  CASE WHEN pr.use_case = 'label' THEN CAST(json_extract(p.value, '$.label_width_mm') AS INTEGER) END,
  CASE WHEN pr.use_case = 'label' THEN CAST(json_extract(p.value, '$.label_height_mm') AS INTEGER) END,
  CASE WHEN pr.use_case = 'receipt' THEN json_extract(p.value, '$.paper_size') END
FROM settings s, json_each(s.printers) p
JOIN printers pr ON pr.name = json_extract(p.value, '$.name')
WHERE s.id = 1
  AND json_valid(s.printers);

COMMIT;
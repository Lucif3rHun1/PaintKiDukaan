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

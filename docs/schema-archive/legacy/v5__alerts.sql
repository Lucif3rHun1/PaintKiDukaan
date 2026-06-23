-- V5: role-scoped alerts/notifications feed.
--
-- Adds:
--   * alerts            — persisted notification feed with role-based visibility.
--   * settings.alerts_retention_days — how long resolved alerts live (min 1).
--
-- All statements are idempotent.

-- ── Alerts feed ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK(kind IN ('low_stock','day_close_overdue','backup_overdue','sale_edited','sale_voided','flagged_customer')),
  severity    TEXT    NOT NULL CHECK(severity IN ('info','warning','error')),
  title       TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  roles       TEXT    NOT NULL DEFAULT '["owner"]',
  entity_id   TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  read_by     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_kind ON alerts(kind);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved_at ON alerts(resolved_at);

-- ── Alert retention setting ───────────────────────────────────────────────
ALTER TABLE settings ADD COLUMN alerts_retention_days INTEGER NOT NULL DEFAULT 7 CHECK(alerts_retention_days >= 1);

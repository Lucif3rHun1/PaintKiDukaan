-- V9: Settings — failed_attempts_lockout column.
--
-- Adds the configurable cap for wrong PIN attempts before the lockout
-- engine kicks in. Default 5 keeps the existing behaviour; owners can raise
-- or lower it from Settings → System.

ALTER TABLE settings ADD COLUMN failed_attempts_lockout INTEGER NOT NULL DEFAULT 5;

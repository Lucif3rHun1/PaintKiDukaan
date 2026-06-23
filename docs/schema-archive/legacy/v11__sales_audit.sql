-- V11: sale edit/void audit columns.
-- Adds voided_at/voided_by and edited_at/edited_by to sales for alert generation.

ALTER TABLE sales ADD COLUMN voided_at INTEGER;
ALTER TABLE sales ADD COLUMN voided_by INTEGER REFERENCES users(id);
ALTER TABLE sales ADD COLUMN edited_at INTEGER;
ALTER TABLE sales ADD COLUMN edited_by INTEGER REFERENCES users(id);

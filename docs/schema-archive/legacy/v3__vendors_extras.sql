-- V3: Add missing vendors columns + contact_person + credit_limit

-- Add updated_at column to vendors (missing from v1, present in code)
ALTER TABLE vendors ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Add contact_person column (new feature)
ALTER TABLE vendors ADD COLUMN contact_person TEXT;

-- Add credit_limit column (new feature, mirrors customers table)
ALTER TABLE vendors ADD COLUMN credit_limit INTEGER;

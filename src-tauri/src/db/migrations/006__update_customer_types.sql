-- Normalize customer types to the current default set:
-- Retailer (default), Dealer, Painter, Contractor.
-- Renames the legacy "Retail" type, adds missing types, and deactivates "Walk-in".
UPDATE customer_types SET name = 'Retailer', updated_at = 0 WHERE name = 'Retail' AND is_active = 1;

INSERT OR IGNORE INTO customer_types (name, is_active, created_at, updated_at) VALUES ('Retailer', 1, 0, 0);
INSERT OR IGNORE INTO customer_types (name, is_active, created_at, updated_at) VALUES ('Dealer', 1, 0, 0);
INSERT OR IGNORE INTO customer_types (name, is_active, created_at, updated_at) VALUES ('Painter', 1, 0, 0);
INSERT OR IGNORE INTO customer_types (name, is_active, created_at, updated_at) VALUES ('Contractor', 1, 0, 0);

UPDATE customer_types SET is_active = 0, updated_at = 0 WHERE name = 'Walk-in';

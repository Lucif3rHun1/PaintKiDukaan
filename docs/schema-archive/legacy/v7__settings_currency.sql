-- V7: Settings table — currency triple + separate label/receipt printer columns.
--
-- Adds a typed currency triple so the Money component can render the correct
-- symbol from the database, and separates the legacy single printer_name into
-- label_printer_name and receipt_printer_name so shops can route shelf labels
-- to a thermal printer and invoices to a different A4 printer.
--
-- Older columns that V7 supersedes (currency, tax_mode, printer_kind) are
-- intentionally left in place: SQLite ALTER TABLE DROP COLUMN would fail on
-- databases that never had them, and leaving them is harmless because nothing
-- reads them any more. Code that used to read them now reads the new columns.
--
-- The legacy printer_name → receipt_printer_name migration UPDATE has been
-- removed: the printer_name column never existed in the v1 settings table,
-- so the UPDATE would fail on a fresh install. If a future V8 ever needs to
-- port data from an older external DB that had printer_name, it must guard
-- the UPDATE with a pragma_table_info existence check.

ALTER TABLE settings ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE settings ADD COLUMN currency_symbol TEXT NOT NULL DEFAULT '₹';
ALTER TABLE settings ADD COLUMN currency_decimal_places INTEGER NOT NULL DEFAULT 2;

ALTER TABLE settings ADD COLUMN label_printer_name TEXT;
ALTER TABLE settings ADD COLUMN receipt_printer_name TEXT;
ALTER TABLE settings ADD COLUMN label_size TEXT;

// Slice A — auth & security
pub mod auth;
pub mod recovery;

// Slice B — domain commands
pub mod brands;
pub mod categories;
pub mod customer_ledger;
pub mod customer_types;
pub mod customers;
pub mod formulas;
pub mod items;
pub mod label_log;
pub mod locations;
pub mod sub_locations;
pub mod units;
pub mod vendors;

// Slice C — POS commands
pub mod day_close;
pub mod purchases;
pub mod reports;
pub mod sales;
pub mod sequences;

// CSV import
pub mod import;

// Slice D — shell commands
pub mod backup;
pub mod discover_printers;
pub mod printers;
pub mod printing;
pub mod settings;

// Slice E — cross-cutting alerts feed
pub mod alerts;

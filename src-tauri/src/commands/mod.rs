// Slice A — auth & security
pub mod auth;
pub mod recovery;

// Slice B — domain commands
pub mod brands;
pub mod customer_types;
pub mod customers;
pub mod items;
pub mod locations;
pub mod vendors;

// Slice C — POS commands
pub mod day_close;
pub mod purchases;
pub mod reports;
pub mod sales;
pub mod sequences;

// Slice D — shell commands
pub mod backup;
pub mod settings;

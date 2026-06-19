//! Tauri command handlers for Slice B (domain).
//!
//! All commands take `State<Db>` and return `Result<T, AppError>`.
//! Role enforcement happens server-side via `current_user` + `require_role`.

pub mod customer_types;
pub mod customers;
pub mod items;
pub mod locations;
pub mod vendors;

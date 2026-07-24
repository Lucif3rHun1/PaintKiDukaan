//! Bridge: tests authored under `src-tauri/tests/rust/` are surfaced as a
//! single Cargo integration-test binary so `cargo test --tests` finds them.
//! Each submodule is independent and shares the `common` fixture.
//!
//! `#[path]` is required because Cargo only auto-discovers `.rs` files at
//! the top of `tests/`; nested directories need an explicit pointer.

#[path = "rust/common.rs"]
mod common;

#[path = "rust/sales.rs"]
mod sales;

#[path = "rust/day_close.rs"]
mod day_close;

#[path = "rust/purchases.rs"]
mod purchases;

#[path = "rust/settings.rs"]
mod settings;

#[path = "rust/stock_movements.rs"]
mod stock_movements;

#[path = "rust/items.rs"]
mod items;

#[path = "rust/customer_ledger.rs"]
mod customer_ledger;

#[path = "rust/vendor_ledger.rs"]
mod vendor_ledger;

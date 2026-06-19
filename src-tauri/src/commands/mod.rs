//! Tauri command surface owned by Slice D.
//!
//! Two submodules:
//! - `settings` — admin CRUD on settings, users, devices, locations,
//!   customer types (E-S1, E-S2, E-U1–E-U3, E65–E66).
//! - `backup` — manual backup, restore, test-restore, target discovery
//!   (E57–E64).

pub mod backup;
pub mod settings;

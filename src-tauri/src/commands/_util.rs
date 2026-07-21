//! Internal helpers shared across command modules.
//!
//! Kept private to `commands/` — not re-exported to the app crate root.

#[inline]
pub fn case_fold_lower(s: &str) -> String {
    s.to_lowercase()
}

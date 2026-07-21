//! Shared role definitions for authentication and authorization.
//!
//! This module provides a single source of truth for user roles across
//! the application. It is used by both the session layer (for user identity
//! and DB serialization) and the IPC auth layer (for command authorization).

use serde::{Deserialize, Serialize};

/// Role hierarchy — ordered from least to most privileged.
///
/// `Ord` is derived so `Role::Owner >= Role::Cashier >= Role::Stocker >= Role::Public`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// No authentication required. Commands callable before DB unlock.
    Public = 0,
    /// Lowest authenticated role — read-only items, brands, units, locations.
    Stocker = 1,
    /// Cashier — sales, purchases, day-close, customer/vendor CRUD, reports.
    Cashier = 2,
    /// Owner — admin functions: settings, backup, hardening, user management.
    Owner = 3,
}

impl Role {
    /// Parse the role string stored in the `users` table.
    /// Returns `None` for unknown roles (fail-closed for auth).
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Role::Owner),
            "cashier" => Some(Role::Cashier),
            "stocker" => Some(Role::Stocker),
            _ => None,
        }
    }

    /// Parse the role string stored in the `users` table.
    /// Falls back to `Stocker` for unknown roles (fail-open for UI).
    pub fn from_db_fallible(s: &str) -> Self {
        Self::from_db(s).unwrap_or(Role::Stocker)
    }

    /// Get the lowercase string representation for DB storage.
    pub fn as_db(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Cashier => "cashier",
            Role::Stocker => "stocker",
            Role::Public => "public", // Should never be stored in DB
        }
    }

    /// Check if this role is an authenticated role (not Public).
    pub fn is_authenticated(&self) -> bool {
        *self != Role::Public
    }

    /// Check if this role meets or exceeds the required minimum.
    pub fn meets(&self, min: Role) -> bool {
        *self >= min
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_ordering() {
        assert!(Role::Owner > Role::Cashier);
        assert!(Role::Cashier > Role::Stocker);
        assert!(Role::Stocker > Role::Public);
        assert!(Role::Owner >= Role::Owner);
    }

    #[test]
    fn from_db() {
        assert_eq!(Role::from_db("owner"), Some(Role::Owner));
        assert_eq!(Role::from_db("cashier"), Some(Role::Cashier));
        assert_eq!(Role::from_db("stocker"), Some(Role::Stocker));
        assert_eq!(Role::from_db("public"), None);
        assert_eq!(Role::from_db("admin"), None);
    }

    #[test]
    fn as_db() {
        assert_eq!(Role::Owner.as_db(), "owner");
        assert_eq!(Role::Cashier.as_db(), "cashier");
        assert_eq!(Role::Stocker.as_db(), "stocker");
        assert_eq!(Role::Public.as_db(), "public");
    }

    #[test]
    fn meets() {
        assert!(Role::Owner.meets(Role::Cashier));
        assert!(Role::Cashier.meets(Role::Stocker));
        assert!(Role::Stocker.meets(Role::Stocker));
        assert!(!Role::Stocker.meets(Role::Cashier));
        assert!(!Role::Public.meets(Role::Stocker));
    }
}
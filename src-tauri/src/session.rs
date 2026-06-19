//! Session / current-user stub.
//!
//! Slice A owns the real session store. While it is not merged, every command
//! that needs a user gets one from `current_user` which reads from a process-
//! local `OnceCell`. In production (after A merges) `current_user` will be
//! re-exported from Slice A's `auth` module and these tests will be replaced.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Cashier,
    Stocker,
}

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: Role,
}

impl User {
    pub fn is_owner(&self) -> bool { self.role == Role::Owner }
    pub fn is_cashier(&self) -> bool { self.role == Role::Cashier }
    pub fn is_stocker(&self) -> bool { self.role == Role::Stocker }
}

// Process-local current user. Slice A replaces this with a Tauri State.
static CURRENT: Mutex<Option<User>> = Mutex::new(None);

/// Test/dev helper: set the current user. Slice A's real impl will override.
pub fn set_current_user(user: Option<User>) {
    *CURRENT.lock().expect("session mutex") = user;
}

/// Return the currently signed-in user. Stub for Slice B.
pub fn current_user() -> AppResult<User> {
    CURRENT
        .lock()
        .expect("session mutex")
        .clone()
        .ok_or_else(|| AppError::Unauthorized("no user signed in".into()))
}

/// Test helper: set current user with a given role (ignores db param).
#[cfg(test)]
pub fn __test_set_role(_db: &crate::db::Db, role: Role) {
    set_current_user(Some(User {
        id: 1,
        name: "Test User".into(),
        role,
    }));
}

/// Convenience: assert the current user has a specific role (or higher).
pub fn require_role(user: &User, allowed: &[Role]) -> AppResult<()> {
    if allowed.contains(&user.role) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "role {:?} not allowed (need one of {:?})",
            user.role, allowed
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_role_passes_for_matching() {
        let u = User { id: 1, name: "x".into(), role: Role::Cashier };
        assert!(require_role(&u, &[Role::Owner, Role::Cashier]).is_ok());
    }

    #[test]
    fn require_role_rejects_other() {
        let u = User { id: 1, name: "x".into(), role: Role::Stocker };
        assert!(require_role(&u, &[Role::Owner]).is_err());
    }
}

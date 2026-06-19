use std::sync::LazyLock;

use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

/// Full schema v1 embedded as a string literal.
const SCHEMA_V1: &str = include_str!("schema_v1.sql");

/// Migration set — currently a single schema v1.
pub static MIGRATIONS: LazyLock<Migrations<'static>> =
    LazyLock::new(|| Migrations::new(vec![M::up(SCHEMA_V1)]));

/// Run all pending migrations against `conn`.
pub fn run(conn: &mut Connection) -> Result<(), rusqlite_migration::Error> {
    MIGRATIONS.to_latest(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_migrations_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        // SQLCipher in-memory still needs a key pragma.
        conn.execute_batch("PRAGMA key = 'test';").unwrap();

        // First apply.
        run(&mut conn).expect("first migration run should succeed");

        // Second apply: rusqlite_migration should be idempotent
        // (returns Ok(()) when already at latest version).
        match run(&mut conn) {
            Ok(()) => {} // idempotent — acceptable
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                assert!(
                    msg.contains("already at latest")
                        || msg.contains("no migration")
                        || msg.contains("up to date"),
                    "unexpected migration error: {e}"
                );
            }
        }
    }
}

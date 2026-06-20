use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

/// Full schema v1 embedded as a string literal.
const SCHEMA_V1: &str = include_str!("schema_v1.sql");

/// V2 migration: locked grill decisions for inventory (Q1-Q17 + Q18).
const SCHEMA_V2: &str = include_str!("schema_v2.sql");

/// V3 migration: add missing vendors columns (updated_at, contact_person, credit_limit).
const SCHEMA_V3: &str = include_str!("schema_v3.sql");

/// V4 migration: brands table + per-brand barcode sequence (APACE001-style generator).
const SCHEMA_V4: &str = include_str!("schema_v4.sql");

/// Migration set — v1 baseline followed by v2, v3, v4 ALTER TABLE migrations.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(SCHEMA_V1),
        M::up(SCHEMA_V2),
        M::up(SCHEMA_V3),
        M::up(SCHEMA_V4),
    ])
}

/// Run all pending migrations against `conn`.
pub fn run(conn: &mut Connection) -> Result<(), rusqlite_migration::Error> {
    migrations().to_latest(conn)
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

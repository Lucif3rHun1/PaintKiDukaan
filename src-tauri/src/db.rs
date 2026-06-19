//! Database facade for Slice B (domain).
//!
//! Slice B does not own the real SQLCipher-wrapped, key-managed `Db` — Slice A does.
//! This module provides a self-contained, thread-safe facade with the same surface
//! (`with_conn`, `with_conn_immediate`) so Slice B can compile, unit-test, and
//! run in dev without Slice A being merged yet.
//!
//! The migration here includes only the tables Slice B reads/writes plus minimal
//! stubs of `sales` / `customer_payments` so `customer_outstanding` can be
//! computed. Slice A's real DB carries the authoritative schema; once merged,
//! integration is a 1-line swap of the `Db` initializer (and the migrations
//! become no-ops because tables already exist).

use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use rusqlite_migration::{Migrations, M};
use std::path::Path;
use std::sync::Mutex;
use thiserror::Error;

/// Public error type for the DB layer. `AppError` wraps this.
#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("db not initialised")]
    NotInitialised,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Thread-safe handle to the database.
///
/// `with_conn` borrows the connection for read work; `with_conn_immediate`
/// starts a write transaction. In Slice A's real DB these will use the
/// shared SQLCipher connection; here we serialise via `Mutex`.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open an in-memory database with all Slice B migrations applied.
    /// Used for unit tests and the dev shell before Slice A lands.
    pub fn open_in_memory() -> Result<Self, DbError> {
        let mut conn = Connection::open_in_memory()?;
        Self::apply_pragmas(&conn)?;
        MIGRATIONS_M_B.to_latest(&mut conn)?;
        Self::seed_minimum(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Open a file-backed database. Used when Slice A integration is wired
    /// in (the file is the SQLCipher-encrypted DB). For Slice B dev we
    /// still apply migrations — they are idempotent because of `IF NOT EXISTS`.
    pub fn open_file(path: &Path) -> Result<Self, DbError> {
        let mut conn = Connection::open(path)?;
        Self::apply_pragmas(&conn)?;
        MIGRATIONS_M_B.to_latest(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn apply_pragmas(conn: &Connection) -> Result<(), DbError> {
        // SQLCipher PRAGMAs in production. In dev (non-cipher conn) some are
        // ignored, which is fine.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    /// Seed customer_types and locations with their defaults if empty.
    /// Idempotent: re-running is a no-op.
    fn seed_minimum(conn: &Connection) -> Result<(), DbError> {
        let type_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM customer_types", [], |r| r.get(0),
        )?;
        if type_count == 0 {
            let tx = conn.unchecked_transaction()?;
            // Per master plan §5.1 — seeded as lowercase.
            for name in ["retail", "painter", "contractor", "dealer"] {
                tx.execute(
                    "INSERT INTO customer_types (name, is_active) VALUES (?1, 1)",
                    [name],
                )?;
            }
            tx.commit()?;
        }
        let loc_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM locations", [], |r| r.get(0),
        )?;
        if loc_count == 0 {
            let tx = conn.unchecked_transaction()?;
            // Per master plan §7.7 — Shop and Godown are the default locations.
            let defaults: [(&str, Option<&str>); 2] = [("Shop", None), ("Godown", None)];
            for (name, rack) in defaults {
                tx.execute(
                    "INSERT INTO locations (name, rack, is_active) VALUES (?1, ?2, 1)",
                    params![name, rack],
                )?;
            }
            tx.commit()?;
        }
        // Seed sequences used by Slice B (Slice C seeds its own sale sequences).
        conn.execute(
            "INSERT OR IGNORE INTO sequences (name, last_value) VALUES ('sku', 0)",
            [],
        )?;
        Ok(())
    }

    pub fn with_conn<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R,
    {
        let guard = self.conn.lock().expect("db mutex poisoned");
        f(&guard)
    }

    /// Run a write inside `BEGIN IMMEDIATE ... COMMIT`. Use for commands
    /// that must atomically update multiple rows.
    ///
    /// If the callback returns `Ok`, the transaction commits; on `Err` it
    /// rolls back and the error is re-raised.
    ///
    /// The callback may return any error type `E` that can be constructed
    /// from a `DbError`. Commands use `AppError` (which wraps `DbError`);
    /// internal callers can use `DbError` directly.
    pub fn with_conn_immediate<F, R, E>(&self, f: F) -> Result<R, E>
    where
        F: FnOnce(&Transaction<'_>) -> Result<R, E>,
        E: From<DbError>,
    {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Into::into)?;
        let out = f(&tx)?;
        tx.commit().map_err(Into::into)?;
        Ok(out)
    }
}

/// Slice B migrations. M suffix = "B slice, draft N" so we never collide
/// with Slice A's authoritative `M_B` (a) migration id at integration time.
static MIGRATIONS_M_B: std::sync::LazyLock<Migrations> = std::sync::LazyLock::new(|| {
    Migrations::new(vec![
        // ---- M_B1: customer_types, locations, customers, vendors, items, sequences,
        //              customer_payments (stub), vendor_payments (stub), sales (stub),
        //              stock_movements (stub), stock_balances, append-only triggers. ----
        M::up(include_str!("../migrations/20240101000001_m_b1_domain.sql")),
    ])
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_db_opens_and_seeds() {
        let db = Db::open_in_memory().expect("open");
        let n: i64 = db.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM customer_types", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(n, 4, "seeded with retail/painter/contractor/dealer");

        let sku: i64 = db.with_conn(|c| {
            c.query_row("SELECT last_value FROM sequences WHERE name='sku'", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(sku, 0);
    }

    #[test]
    fn with_conn_immediate_rolls_back_on_err() {
        let db = Db::open_in_memory().expect("open");
        let res: Result<(), DbError> = db.with_conn_immediate(|tx| {
            tx.execute(
                "INSERT INTO customer_types (name, is_active) VALUES ('Tmp', 1)",
                [],
            )?;
            // Force an error after the insert to trigger rollback.
            tx.execute("INSERT INTO bogus_table VALUES (1)", [])?;
            Ok(())
        });
        assert!(res.is_err(), "expected error from bogus insert");
        let n: i64 = db.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM customer_types WHERE name='Tmp'", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(n, 0, "txn must roll back on error");
    }
}

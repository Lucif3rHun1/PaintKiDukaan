//! Database layer — SQLCipher connection management with zeroize-on-drop DEK.

pub mod keywrap;
pub mod migrations;

/// Canonical final schema for a fresh database — absorbs every table, index,
/// and seed row from schema.sql plus migrations 001–009 so that a new DB
/// needs zero migrations.
pub(crate) const SCHEMA_FINAL: &str = include_str!("schema_final.sql");

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use zeroize::Zeroize;
use zeroize::Zeroizing;

/// A thin wrapper over an open SQLCipher connection.
///
/// The DEK is stored inside a `Zeroizing` container so it is scrubbed from
/// memory when the `Db` is dropped or when `lock()` replaces it with `None`.
/// Manual Debug impl — `Connection` doesn't implement Debug.
impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("conn", &"<Mutex<Connection>>")
            .field("dek", &"[redacted; 32B]")
            .finish()
    }
}

pub struct Db {
    conn: Mutex<Connection>,
    /// Data Encryption Key (32 random bytes) — zeroized on drop.
    dek: Zeroizing<[u8; 32]>,
}

impl Db {
    /// Open (or create) a SQLCipher database at `path`, encrypted with `dek`.
    ///
    /// PRAGMAs are applied in order:
    ///   1. `key`                — set the encryption key
    ///   2. `cipher_compatibility=4` — SQLCipher 4 compat
    ///   3. `cipher_page_size=4096`  — before any schema work
    ///   4. Schema bootstrap: every DB gets the complete final schema.
    ///      Fresh DBs apply it directly; existing DBs are wiped first.
    ///   5. `journal_mode=WAL`
    ///   6. `busy_timeout=5000`
    ///   7. `foreign_keys=ON`
    pub fn open(path: &Path, dek: &[u8; 32]) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;

        // -- Key material --------------------------------------------------
        let key_hex = hex::encode(dek);
        conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))?;

        // -- Cipher settings (BEFORE any schema reads) --------------------
        conn.execute_batch(
            "PRAGMA cipher_compatibility = 4;\
             PRAGMA cipher_page_size = 4096;",
        )?;

        // -- Schema bootstrap ---------------------------------------------
        // Hard cutover: fresh DBs apply the final schema directly. Existing DBs
        // that do not yet have the `_schema_final_applied` marker are wiped and
        // re-bootstrapped from scratch exactly once.
        if Self::is_fresh_database(&conn)? {
            conn.execute_batch(SCHEMA_FINAL)?;
        } else if !Self::has_final_schema(&conn)? {
            Self::wipe_schema(&conn)?;
            conn.execute_batch(SCHEMA_FINAL)?;
        }
        // Marker table so tooling can recognise a schema_final-bootstrapped DB.
        conn.execute_batch("CREATE TABLE IF NOT EXISTS _schema_final_applied (dummy INTEGER)")?;

        // -- Performance / safety (AFTER schema, outside txn) ------------
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA foreign_keys = ON;",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            dek: Zeroizing::new(*dek),
        })
    }

    /// Return `true` when the database at `conn` has never been initialised.
    ///
    /// "Fresh" means: neither `_rusqlite_migrations` nor any user table
    /// exists.  This is safe to call after the SQLCipher key + cipher
    /// PRAGMAs have been applied.
    fn is_fresh_database(conn: &Connection) -> Result<bool, rusqlite::Error> {
        // Check if the rusqlite_migration tracking table exists.
        let has_migrations: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='_rusqlite_migrations'",
            [],
            |r| r.get(0),
        )?;
        if has_migrations {
            return Ok(false);
        }

        // No migration table — check for any user table.
        let has_user_tables: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' \
               AND name NOT LIKE 'sqlite_%' \
               AND name != '_rusqlite_migrations'",
            [],
            |r| r.get(0),
        )?;
        Ok(!has_user_tables)
    }

    /// Return `true` when the database was bootstrapped with `schema_final.sql`
    /// (indicated by the `_schema_final_applied` marker table).  Such databases
    /// already have the final schema and must not be wiped again.
    fn has_final_schema(conn: &Connection) -> Result<bool, rusqlite::Error> {
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='_schema_final_applied'",
            [],
            |r| r.get(0),
        )
    }

    /// Drop every user-created table so `SCHEMA_FINAL` can be applied cleanly.
    /// Foreign keys are disabled during the drop to avoid dependency-order
    /// problems; they are re-enabled before the schema is re-created.
    fn wipe_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type='table' \
                   AND name NOT LIKE 'sqlite_%' \
                   AND name != '_schema_final_applied' \
                 ORDER BY name",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for tbl in tables {
            conn.execute(&format!("DROP TABLE IF EXISTS \"{tbl}\""), [])?;
        }
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(())
    }

    /// Open an in-memory SQLCipher database for unit tests.
    #[cfg(any(test, feature = "test-harness"))]
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        let dek = [0x42u8; 32];
        let key_hex = hex::encode(dek);
        conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))?;
        conn.execute_batch(
            "PRAGMA cipher_compatibility = 4;\
             PRAGMA cipher_page_size = 4096;",
        )?;
        if Self::is_fresh_database(&conn)? {
            conn.execute_batch(SCHEMA_FINAL)?;
        } else if !Self::has_final_schema(&conn)? {
            Self::wipe_schema(&conn)?;
            conn.execute_batch(SCHEMA_FINAL)?;
        }
        conn.execute_batch("CREATE TABLE IF NOT EXISTS _schema_final_applied (dummy INTEGER)")?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            dek: Zeroizing::new(dek),
        })
    }

    /// Count user-defined tables for transaction logging.
    fn user_table_count(conn: &Connection) -> Result<i64, rusqlite::Error> {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
    }

    /// Run a closure inside a deferred transaction (`BEGIN … COMMIT`).
    pub fn with_conn<F, R, E>(&self, f: F) -> Result<R, E>
    where
        F: FnOnce(&Connection) -> Result<R, E>,
        E: From<rusqlite::Error>,
    {
        let conn = self.conn.lock().expect("db lock poisoned");
        let cid = crate::obs::correlation_id();
        let tables = Self::user_table_count(&conn).unwrap_or(-1);
        log::info!("[DB] BEGIN cid={cid} tables={tables}");
        conn.execute("BEGIN", []).map_err(E::from)?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", []).map_err(E::from)?;
                log::info!("[DB] COMMIT cid={cid} tables={tables}");
                Ok(val)
            }
            Err(e) => {
                if let Err(rb_err) = conn.execute("ROLLBACK", []) {
                    log::error!("[DB] ROLLBACK failed cid={cid}: {rb_err}");
                } else {
                    log::warn!("[DB] ROLLBACK cid={cid} tables={tables}");
                }
                Err(e)
            }
        }
    }

    /// Run a closure inside an immediate transaction (`BEGIN IMMEDIATE …`).
    pub fn with_conn_immediate<F, R, E>(&self, f: F) -> Result<R, E>
    where
        F: FnOnce(&Connection) -> Result<R, E>,
        E: From<rusqlite::Error>,
    {
        let conn = self.conn.lock().expect("db lock poisoned");
        let cid = crate::obs::correlation_id();
        let tables = Self::user_table_count(&conn).unwrap_or(-1);
        log::info!("[DB] BEGIN IMMEDIATE cid={cid} tables={tables}");
        conn.execute("BEGIN IMMEDIATE", []).map_err(E::from)?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", []).map_err(E::from)?;
                log::info!("[DB] COMMIT cid={cid} tables={tables}");
                Ok(val)
            }
            Err(e) => {
                if let Err(rb_err) = conn.execute("ROLLBACK", []) {
                    log::error!("[DB] ROLLBACK (immediate) failed cid={cid}: {rb_err}");
                } else {
                    log::warn!("[DB] ROLLBACK (immediate) cid={cid} tables={tables}");
                }
                Err(e)
            }
        }
    }

    /// Raw read access — gives the closure a `&Connection` without
    /// transaction wrapping. Slice-B compatibility alias.
    pub fn with_raw<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R,
    {
        let conn = self.conn.lock().expect("db lock poisoned");
        f(&conn)
    }

    /// Write with `BEGIN IMMEDIATE`. Gives the closure a `&Connection`
    /// inside a transaction that is committed on `Ok` or rolled back on `Err`.
    /// Slice-B compatibility alias.
    pub fn with_tx<F, R, E>(&self, f: F) -> Result<R, E>
    where
        F: FnOnce(&Connection) -> Result<R, E>,
        E: From<rusqlite::Error>,
    {
        let conn = self.conn.lock().expect("db lock poisoned");
        let cid = crate::obs::correlation_id();
        let tables = Self::user_table_count(&conn).unwrap_or(-1);
        log::info!("[DB] BEGIN IMMEDIATE cid={cid} tables={tables}");
        conn.execute("BEGIN IMMEDIATE", [])?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", [])?;
                log::info!("[DB] COMMIT cid={cid} tables={tables}");
                Ok(val)
            }
            Err(e) => {
                if let Err(rb_err) = conn.execute("ROLLBACK", []) {
                    log::error!("[DB] ROLLBACK (tx) failed cid={cid}: {rb_err}");
                } else {
                    log::warn!("[DB] ROLLBACK (tx) cid={cid} tables={tables}");
                }
                Err(e)
            }
        }
    }

    /// Return a reference to the DEK (still inside `Zeroizing` — caller
    /// receives `&[u8; 32]`).
    pub fn dek(&self) -> &[u8; 32] {
        &self.dek
    }

    /// Create a SQLCipher backup into `dest` via `VACUUM INTO`.
    ///
    /// Single quotes in the destination path are escaped.
    pub fn backup_to(&self, dest: &Path) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let escaped = dest.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        // AFT (zeroize crate) handles zeroize on its own Drop, but we are
        // explicit here for clarity.
        self.dek.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// Reproduce `first_launch_setup`'s INSERT statements against production
    /// SQLCipher (raw-hex key + cipher_compatibility=4 + cipher_page_size=4096).
    ///
    /// `migrations::tests::test_migrations_idempotent` uses
    /// `PRAGMA key = 'test'` (string mode) and never exercises prod cipher.
    /// This test fills that gap. If it fails, the failure message is the
    /// real reason `first_launch_setup` errors out on the wizard's final step.
    #[test]
    fn first_launch_setup_inserts_against_prod_cipher() {
        let db = Db::open_in_memory().expect("Db::open_in_memory should open with prod cipher");

        // Exact pattern from recovery.rs::first_launch_setup:
        db.with_conn::<_, _, rusqlite::Error>(|c| {
            c.execute(
                "INSERT OR IGNORE INTO users \
                 (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
                 VALUES (?1, 'owner', ?2, ?3, 6, 1, 0, 0)",
                params!["Owner", &[0u8; 16][..], &[0u8; 32][..]],
            )?;
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, address, phone, created_at, updated_at) \
                 VALUES (1, 'Test Shop', 'Test Address', 'Test Phone', 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) \
                 VALUES ('Shop', NULL, 1, 1, 0, 0), ('Godown', NULL, 0, 1, 0, 0)",
                [],
            )?;

            // Verify we can read them back.
            let shop_name: String = c.query_row(
                "SELECT shop_name FROM settings WHERE id = 1",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(shop_name, "Test Shop");

            let owner: String = c.query_row(
                "SELECT name FROM users WHERE role = 'owner' AND is_active = 1",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(owner, "Owner");

            Ok(())
        })
        .expect("first_launch_setup INSERTs should succeed against prod cipher");
    }
}

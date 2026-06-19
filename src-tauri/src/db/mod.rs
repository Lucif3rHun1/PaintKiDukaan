//! Database layer — SQLCipher connection management with zeroize-on-drop DEK.

pub mod keywrap;
pub mod migrations;
pub mod queries;

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
    ///   4. Run migrations
    ///   5. `journal_mode=WAL`
    ///   6. `busy_timeout=5000`
    ///   7. `foreign_keys=ON`
    pub fn open(path: &Path, dek: &[u8; 32]) -> Result<Self, rusqlite::Error> {
        let mut conn = Connection::open(path)?;

        // -- Key material --------------------------------------------------
        let key_hex = hex::encode(dek);
        conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))?;

        // -- Cipher settings (BEFORE any schema reads) --------------------
        conn.execute_batch(
            "PRAGMA cipher_compatibility = 4;\
             PRAGMA cipher_page_size = 4096;",
        )?;

        // -- Run schema migrations ----------------------------------------
        migrations::run(&mut conn).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                e.to_string(),
            )))
        })?;

        // -- Performance / safety (AFTER migrations, outside txn) ---------
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

    /// Open an in-memory SQLCipher database for unit tests.
    #[cfg(any(test, feature = "test-harness"))]
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let mut conn = Connection::open_in_memory()?;
        let dek = [0x42u8; 32];
        let key_hex = hex::encode(dek);
        conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))?;
        conn.execute_batch(
            "PRAGMA cipher_compatibility = 4;\
             PRAGMA cipher_page_size = 4096;",
        )?;
        migrations::run(&mut conn).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                e.to_string(),
            )))
        })?;
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

    /// Run a closure inside a deferred transaction (`BEGIN … COMMIT`).
    pub fn with_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, rusqlite::Error>,
    ) -> Result<R, rusqlite::Error> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute("BEGIN", [])?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", [])?;
                Ok(val)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Run a closure inside an immediate transaction (`BEGIN IMMEDIATE …`).
    pub fn with_conn_immediate<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, rusqlite::Error>,
    ) -> Result<R, rusqlite::Error> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute("BEGIN IMMEDIATE", [])?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", [])?;
                Ok(val)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
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
        conn.execute("BEGIN IMMEDIATE", [])?;
        match f(&conn) {
            Ok(val) => {
                conn.execute("COMMIT", [])?;
                Ok(val)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
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

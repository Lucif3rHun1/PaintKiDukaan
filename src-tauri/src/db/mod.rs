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
        conn.execute_batch("ANALYZE;")?;

        // -- Inline migrations for marker-DBs --------------------------------
        // Marker-DBs skipped the wipe-and-rebootstrap above, so they keep
        // their old column constraints. Apply targeted ALTERs here. Each
        // migration must be idempotent (safe to re-run on already-migrated DBs).
        //
        // M-INLINE-001: make purchases.vendor_id nullable so opening-stock
        // entries can omit a vendor.
        {
            let notnull: i64 = conn
                .query_row(
                    "SELECT NOT NULL as notnull FROM pragma_table_info('purchases') WHERE name='vendor_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if notnull == 1 {
                conn.execute_batch("ALTER TABLE purchases ALTER COLUMN vendor_id DROP NOT NULL")?;
            }
        }

        // M-INLINE-002: relax printer_mappings CHECK constraint to allow
        // label printers without explicit dimensions (per-item stock size
        // is authoritative).
        {
            let has_strict: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_schema WHERE name = 'printer_mappings' AND sql NOT LIKE '%label_width_mm IS NULL AND label_height_mm IS NULL AND paper_size IS NULL%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if has_strict {
                conn.execute_batch(
                    "CREATE TABLE printer_mappings_new (\
                       id INTEGER PRIMARY KEY AUTOINCREMENT,\
                       printer_id INTEGER NOT NULL UNIQUE REFERENCES printers(id) ON DELETE CASCADE,\
                       label_width_mm INTEGER,\
                       label_height_mm INTEGER,\
                       paper_size TEXT \
                         CHECK(paper_size IN ('thermal-58mm','thermal-80mm','A4','A5') OR paper_size IS NULL),\
                       created_at INTEGER NOT NULL,\
                       updated_at INTEGER NOT NULL,\
                       CHECK (\
                         (label_width_mm IS NOT NULL AND label_height_mm IS NOT NULL AND paper_size IS NULL) OR\
                         (paper_size IS NOT NULL AND label_width_mm IS NULL AND label_height_mm IS NULL) OR\
                         (label_width_mm IS NULL AND label_height_mm IS NULL AND paper_size IS NULL)\
                       )\
                     );\
                     INSERT INTO printer_mappings_new SELECT * FROM printer_mappings;\
                     DROP TABLE printer_mappings;\
                     ALTER TABLE printer_mappings_new RENAME TO printer_mappings;",
                )?;
            }
        }

        // M-INLINE-003: add `formulas` table for custom shade mixes (ADR-011).
        // CREATE TABLE IF NOT EXISTS is a no-op when the table already exists.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS formulas (\
               id                  INTEGER PRIMARY KEY AUTOINCREMENT,\
               id_code             TEXT    NOT NULL UNIQUE,\
               name                TEXT,\
               with_base           INTEGER NOT NULL DEFAULT 0 CHECK(with_base IN (0,1)),\
               base_item_id        INTEGER REFERENCES items(id) ON DELETE SET NULL,\
               retail_price_paise  INTEGER NOT NULL CHECK(retail_price_paise >= 0),\
               is_active           INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
               created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),\
               created_by          INTEGER REFERENCES users(id) ON DELETE NO ACTION\
             );\
             CREATE INDEX IF NOT EXISTS idx_formulas_id_code ON formulas(id_code);\
             CREATE INDEX IF NOT EXISTS idx_formulas_is_active ON formulas(is_active);",
        )?;

        // M-INLINE-004: rebuild `sale_items` to make item_id nullable and add
        // `kind` / `formula_id` / polymorphic CHECK (ADR-011). Idempotent —
        // skipped when the new `kind` column is already present.
        {
            let has_kind: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_items') WHERE name = 'kind'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_kind {
                // Determine recovery state — a previous failed migration may have
                // left the tables in any combination of renamed/partial states.
                let table_exists = |name: &str| -> bool {
                    conn.query_row(
                        &format!(
                            "SELECT COUNT(*) > 0 FROM sqlite_master \
                             WHERE type='table' AND name='{name}'"
                        ),
                        [],
                        |r| r.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
                };

                let sale_items_exists     = table_exists("sale_items");
                let sale_items_old_exists = table_exists("sale_items_old");

                // Clean up any leftover partial new table from a previous failed run.
                conn.execute_batch("DROP TABLE IF EXISTS sale_items_new;")?;

                // Rename the current live table to _old (skip if already done by a
                // previous failed run that stalled after the rename).
                if sale_items_exists {
                    conn.execute_batch(
                        "ALTER TABLE sale_items RENAME TO sale_items_old;",
                    )?;
                }
                // At this point sale_items_old exists (either was already there or
                // we just renamed it). If neither existed, we'll create an empty table.

                // Create the new table with the correct final schema.
                conn.execute_batch(
                    "CREATE TABLE sale_items_new (\
                       id            INTEGER PRIMARY KEY AUTOINCREMENT,\
                       sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,\
                       kind          TEXT    NOT NULL DEFAULT 'item' CHECK(kind IN ('item','formula')),\
                       item_id       INTEGER REFERENCES items(id) ON DELETE NO ACTION,\
                       formula_id    INTEGER REFERENCES formulas(id) ON DELETE NO ACTION,\
                       qty           INTEGER NOT NULL CHECK(qty > 0),\
                       price         INTEGER NOT NULL CHECK(price >= 0),\
                       unit_type     TEXT    NOT NULL DEFAULT 'unit' CHECK(unit_type IN ('unit','box')),\
                       line_discount INTEGER NOT NULL DEFAULT 0,\
                       shade_note    TEXT,\
                       line_order    INTEGER NOT NULL DEFAULT 0,\
                       created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),\
                       created_by    INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                       CHECK ((item_id IS NOT NULL AND formula_id IS NULL)\
                           OR (item_id IS NULL     AND formula_id IS NOT NULL))\
                     );",
                )?;

                // Copy data if a source table exists (either the original or the
                // one left by a previous failed migration attempt).
                if sale_items_exists || sale_items_old_exists {
                    // Defensively check which columns exist — early/dev builds used
                    // different names (unit_price_paise, unit_id, etc.).
                    let col_exists = |name: &str| -> bool {
                        conn.query_row(
                            &format!(
                                "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_items_old') \
                                 WHERE name = '{name}'"
                            ),
                            [],
                            |r| r.get::<_, bool>(0),
                        )
                        .unwrap_or(false)
                    };

                    let has_sale_id    = col_exists("sale_id");
                    let has_item_id    = col_exists("item_id");
                    let has_price      = col_exists("price");
                    let has_unit_type  = col_exists("unit_type");
                    let has_discount   = col_exists("line_discount");
                    let has_shade      = col_exists("shade_note");
                    let has_order      = col_exists("line_order");
                    let has_created_at = col_exists("created_at");
                    let has_created_by = col_exists("created_by");

                    if has_sale_id && has_item_id && has_price && has_unit_type {
                        let discount_expr   = if has_discount   { "line_discount" }           else { "0" };
                        let shade_expr      = if has_shade      { "shade_note" }               else { "NULL" };
                        let order_expr      = if has_order      { "line_order" }               else { "0" };
                        let created_at_expr = if has_created_at { "created_at" }               else { "datetime('now','localtime')" };
                        let created_by_expr = if has_created_by { "created_by" }               else { "NULL" };

                        conn.execute_batch(&format!(
                            "INSERT INTO sale_items_new \
                               (sale_id, kind, item_id, formula_id, qty, price, unit_type, \
                                line_discount, shade_note, line_order, created_at, created_by) \
                             SELECT sale_id, 'item', item_id, NULL, qty, price, unit_type, \
                                    {discount_expr}, {shade_expr}, {order_expr}, \
                                    {created_at_expr}, {created_by_expr} \
                             FROM sale_items_old;"
                        ))?;
                    } else {
                        log::warn!(
                            "db: M-INLINE-004 skipped data copy — \
                             sale_items_old has incompatible schema \
                             (sale_id={has_sale_id}, item_id={has_item_id}, \
                              price={has_price}, unit_type={has_unit_type})"
                        );
                    }

                    conn.execute_batch("DROP TABLE IF EXISTS sale_items_old;")?;
                }

                conn.execute_batch(
                    "ALTER TABLE sale_items_new RENAME TO sale_items;\
                     CREATE INDEX IF NOT EXISTS idx_sale_items_formula_id ON sale_items(formula_id);",
                )?;
            }
        }

        // M-INLINE-005: add `base_item_id` column to `formulas` table so formulas
        // with_base=1 can link to an inventory item for automatic stock deduction.
        {
            let has_base_item: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('formulas') WHERE name = 'base_item_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_base_item {
                conn.execute_batch(
                    "ALTER TABLE formulas ADD COLUMN base_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL;",
                )?;
            }
        }

        // M-INLINE-006: drafts table for autosave
        {
            let has_drafts = conn
                .prepare("PRAGMA table_info(drafts)")
                .and_then(|mut p| {
                    let mut rows = p.query([])?;
                    Ok(rows.next()?.is_some())
                })
                .unwrap_or(false);
            if !has_drafts {
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS drafts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
                form_type  TEXT    NOT NULL CHECK(form_type IN ('sale','purchase','return')),
                data_json  TEXT    NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(user_id, form_type)
            );",
                )?;
            }
        }

        // M-INLINE-007: add print config columns to label_print_log
        {
            let has_tspl_config: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('label_print_log') WHERE name = 'tspl_config'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_tspl_config {
                conn.execute_batch(
                    "ALTER TABLE label_print_log ADD COLUMN tspl_config TEXT;\
                     ALTER TABLE label_print_log ADD COLUMN printer TEXT;\
                     ALTER TABLE label_print_log ADD COLUMN label_size TEXT;\
                     ALTER TABLE label_print_log ADD COLUMN labels_per_row INTEGER;",
                )?;
            }
        }

        // -- Performance / safety (AFTER schema, outside txn) ------------
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
              PRAGMA busy_timeout = 5000;\
              PRAGMA foreign_keys = ON;\
              PRAGMA cache_size = -64000;\
              PRAGMA mmap_size = 268435456;\
              PRAGMA temp_store = MEMORY;\
              PRAGMA synchronous = NORMAL;\
              PRAGMA auto_vacuum = INCREMENTAL;\
              PRAGMA secure_delete = OFF;",
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

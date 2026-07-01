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

                let sale_items_exists = table_exists("sale_items");
                let sale_items_old_exists = table_exists("sale_items_old");

                // Clean up any leftover partial new table from a previous failed run.
                conn.execute_batch("DROP TABLE IF EXISTS sale_items_new;")?;

                // Rename the current live table to _old (skip if already done by a
                // previous failed run that stalled after the rename).
                if sale_items_exists {
                    conn.execute_batch("ALTER TABLE sale_items RENAME TO sale_items_old;")?;
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
                       qty           REAL NOT NULL CHECK(qty > 0),\
                       price         INTEGER NOT NULL CHECK(price >= 0),\
                        unit_type     TEXT    NOT NULL DEFAULT 'pcs' CHECK(unit_type IN ('pcs','mtr','kg')),\
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

                    let has_sale_id = col_exists("sale_id");
                    let has_item_id = col_exists("item_id");
                    let has_price = col_exists("price");
                    let has_unit_type = col_exists("unit_type");
                    let has_discount = col_exists("line_discount");
                    let has_shade = col_exists("shade_note");
                    let has_order = col_exists("line_order");
                    let has_created_at = col_exists("created_at");
                    let has_created_by = col_exists("created_by");

                    if has_sale_id && has_item_id && has_price && has_unit_type {
                        let discount_expr = if has_discount { "line_discount" } else { "0" };
                        let shade_expr = if has_shade { "shade_note" } else { "NULL" };
                        let order_expr = if has_order { "line_order" } else { "0" };
                        let created_at_expr = if has_created_at {
                            "created_at"
                        } else {
                            "datetime('now','localtime')"
                        };
                        let created_by_expr = if has_created_by { "created_by" } else { "NULL" };

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
            let columns: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('label_print_log')")?
                .query_map([], |r| r.get::<_, String>(0))?
                .filter_map(Result::ok)
                .collect();
            let mut batch = String::new();
            if !columns.contains(&"tspl_config".to_string()) {
                batch.push_str("ALTER TABLE label_print_log ADD COLUMN tspl_config TEXT;");
            }
            if !columns.contains(&"printer".to_string()) {
                batch.push_str("ALTER TABLE label_print_log ADD COLUMN printer TEXT;");
            }
            if !columns.contains(&"label_size".to_string()) {
                batch.push_str("ALTER TABLE label_print_log ADD COLUMN label_size TEXT;");
            }
            if !columns.contains(&"labels_per_row".to_string()) {
                batch.push_str("ALTER TABLE label_print_log ADD COLUMN labels_per_row INTEGER;");
            }
            if !batch.is_empty() {
                conn.execute_batch(&batch)?;
            }
        }

        // M-INLINE-008: add sell_unit_id and min_stock columns to items table
        {
            let has_sell_unit_id: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('items') WHERE name = 'sell_unit_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_sell_unit_id {
                conn.execute_batch(
                    "ALTER TABLE items ADD COLUMN sell_unit_id INTEGER REFERENCES sale_units(id) ON DELETE NO ACTION;",
                )?;
            }
            let has_min_stock: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('items') WHERE name = 'min_stock'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_min_stock {
                conn.execute_batch(
                    "ALTER TABLE items ADD COLUMN min_stock REAL NOT NULL DEFAULT 0;",
                )?;
            }
        }

        // M-INLINE-009: create sale_units, purchase_units, item_purchase_packaging
        // tables for the 3-unit system. Idempotent — skipped when tables already exist.
        {
            let has_sale_units: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='sale_units'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_sale_units {
                conn.execute_batch(
                    "CREATE TABLE sale_units (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        code TEXT NOT NULL UNIQUE,
                        label TEXT NOT NULL,
                        quantity_precision INTEGER NOT NULL DEFAULT 0,
                        is_active INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                     );
                     INSERT INTO sale_units (code, label, quantity_precision) VALUES
                        ('pcs', 'Pcs', 0),
                        ('mtr', 'Metre', 3),
                        ('kg', 'Kg', 3);",
                )?;
            }
        }
        {
            let has_purchase_units: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='purchase_units'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_purchase_units {
                conn.execute_batch(
                    "CREATE TABLE purchase_units (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        label TEXT NOT NULL UNIQUE,
                        is_active INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                     );
                     INSERT INTO purchase_units (label) VALUES
                        ('Carton'), ('Roll'), ('Sack'), ('Piece'), ('Box'), ('Bundle');",
                )?;
            }
        }
        {
            let has_ipp: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='item_purchase_packaging'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_ipp {
                conn.execute_batch(
                    "CREATE TABLE item_purchase_packaging (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        purchase_unit_id INTEGER NOT NULL REFERENCES purchase_units(id),
                        qty_per_purchase_unit REAL NOT NULL DEFAULT 1.0,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                        UNIQUE(item_id, purchase_unit_id)
                     );",
                )?;
            }
        }

        // M-INLINE-010: add `date` column to `sale_returns` for user-provided
        // logical return date (YYYY-MM-DD). Fresh DBs get it from schema_final.
        {
            let has_date: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_returns') WHERE name = 'date'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_date {
                conn.execute_batch(
                    "ALTER TABLE sale_returns ADD COLUMN date TEXT;",
                )?;
            }
        }

        // M-INLINE-011: add `shade_note` column to `sale_return_lines` so
        // return lines can carry the shade/formula note from the original sale.
        {
            let has_shade_note: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_return_lines') WHERE name = 'shade_note'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_shade_note {
                conn.execute_batch(
                    "ALTER TABLE sale_return_lines ADD COLUMN shade_note TEXT;",
                )?;
            }
        }

        // M-INLINE-012: add `notes` column to `vendors` so vendor notes
        // can be persisted instead of always returning None.
        {
            let has_notes: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('vendors') WHERE name = 'notes'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_notes {
                conn.execute_batch(
                    "ALTER TABLE vendors ADD COLUMN notes TEXT;",
                )?;
            }
        }

        // M-INLINE-013: canonicalize min_stock, drop min_qty column.
        // backfill min_stock from min_qty where min_stock was still 0.
        {
            let has_min_qty: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('items') WHERE name = 'min_qty'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if has_min_qty {
                conn.execute_batch(
                    "UPDATE items SET min_stock = CAST(min_qty AS REAL) \
                     WHERE min_stock = 0 AND min_qty > 0; \
                     ALTER TABLE items DROP COLUMN min_qty;",
                )?;
            }
        }

        // M-INLINE-014: add `gstin` column to `settings` so GSTIN persists across restarts.
        {
            let has_gstin: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('settings') WHERE name = 'gstin'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_gstin {
                conn.execute_batch("ALTER TABLE settings ADD COLUMN gstin TEXT;")?;
            }
        }

        // M-INLINE-015: Recreate sales table to add 'fbill' to the CHECK constraint.
        // SQLite has no ALTER TABLE ... ALTER CONSTRAINT, so we must recreate the
        // table with the updated CHECK. Indexes are auto-dropped with the old table
        // and recreated below.
        {
            let has_fbill_clause: bool = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sales'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap_or_default()
                .contains("'fbill'");
            if !has_fbill_clause {
                conn.execute_batch("DROP TABLE IF EXISTS sales_new;")?;
                conn.execute_batch(
                    "PRAGMA foreign_keys = OFF;
                     CREATE TABLE sales_new (
                        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                        no                 TEXT    NOT NULL UNIQUE,
                        customer_id        INTEGER REFERENCES customers(id) ON DELETE NO ACTION,
                        date               TEXT    NOT NULL DEFAULT '',
                        status             TEXT    NOT NULL DEFAULT 'quotation'
                                             CHECK(status IN ('quotation','final','fbill')),
                        subtotal           INTEGER NOT NULL DEFAULT 0,
                        bill_discount      INTEGER NOT NULL DEFAULT 0,
                        total              INTEGER NOT NULL DEFAULT 0,
                        paid_amount        INTEGER NOT NULL DEFAULT 0,
                        payment_modes_json TEXT    NOT NULL DEFAULT '[]',
                        validity_days      INTEGER,
                        converted_from_id  INTEGER REFERENCES sales(id) ON DELETE NO ACTION,
                        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
                        created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                        updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                        created_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION,
                        updated_by         INTEGER REFERENCES users(id) ON DELETE NO ACTION
                     );
                     INSERT INTO sales_new SELECT * FROM sales;
                     DROP TABLE sales;
                     ALTER TABLE sales_new RENAME TO sales;
                     CREATE INDEX IF NOT EXISTS idx_sales_user_created ON sales(user_id, created_at DESC);
                     CREATE INDEX IF NOT EXISTS idx_sales_customer_created ON sales(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
                     CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
                     CREATE INDEX IF NOT EXISTS idx_sales_kind_created ON sales(status, created_at DESC);
                     PRAGMA foreign_keys = ON;",
                )?;
            }
        }

        // M-INLINE-016: Add display_name column to sale_items if missing.
        {
            let has_display_name: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_items') WHERE name = 'display_name'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_display_name {
                conn.execute_batch("ALTER TABLE sale_items ADD COLUMN display_name TEXT;")?;
            }
        }

        // M-INLINE-018: Remove CHECK constraint from sale_items that blocks custom fbill lines.
        // The old CHECK required exactly one of (item_id, formula_id) to be set, but
        // custom fbill lines may have both null. SQLite cannot ALTER CONSTRAINT, so we
        // recreate the table without it.
        {
            let has_old_check: bool = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sale_items'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap_or_default()
                .contains("item_id IS NOT NULL AND formula_id IS NULL");
            if has_old_check {
                conn.execute_batch(
                    "PRAGMA foreign_keys = OFF;
                     CREATE TABLE sale_items_new (
                         id            INTEGER PRIMARY KEY AUTOINCREMENT,
                         sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
                         kind          TEXT    NOT NULL DEFAULT 'item' CHECK(kind IN ('item','formula')),
                         item_id       INTEGER REFERENCES items(id) ON DELETE NO ACTION,
                         formula_id    INTEGER REFERENCES formulas(id) ON DELETE NO ACTION,
                         qty           REAL NOT NULL CHECK(qty > 0),
                         price         INTEGER NOT NULL CHECK(price >= 0),
                         unit_type     TEXT    NOT NULL DEFAULT 'pcs' CHECK(unit_type IN ('pcs','mtr','kg')),
                         line_discount INTEGER NOT NULL DEFAULT 0,
                         shade_note    TEXT,
                         line_order    INTEGER NOT NULL DEFAULT 0,
                         created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                         created_by    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
                         display_name  TEXT
                     );
                     INSERT INTO sale_items_new
                         SELECT id, sale_id, kind, item_id, formula_id, qty, price,
                                unit_type, line_discount, shade_note, line_order,
                                created_at, created_by, display_name
                         FROM sale_items;
                     DROP TABLE sale_items;
                     ALTER TABLE sale_items_new RENAME TO sale_items;
                     CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
                     CREATE INDEX IF NOT EXISTS idx_sale_items_item_id ON sale_items(item_id);
                     CREATE INDEX IF NOT EXISTS idx_sale_items_formula_id ON sale_items(formula_id);
                     PRAGMA foreign_keys = ON;",
                )?;
            }
        }

        // M-INLINE-017: Drop legacy unit_id from items, stock_movements, purchase_items.
        // Each step is independently idempotent to survive partial prior runs.
        //
        // BUGFIX: The BEFORE UPDATE trigger on stock_movements must be dropped
        // BEFORE the backfill UPDATE runs, and recreated AFTER. Previously the
        // trigger was created inside the `!has_col` block; on a re-run where
        // sale_unit_id already existed the block was skipped, but the trigger
        // from the prior run still fired on the UPDATE → abort → unit_id
        // never dropped → "NOT NULL constraint failed: items.unit_id".
        {
            fn has_col(conn: &Connection, table: &str, col: &str) -> bool {
                conn.query_row(
                    &format!(
                        "SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'",
                        table, col
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false)
            }

            // --- stock_movements (independently idempotent) ---
            if has_col(&conn, "stock_movements", "unit_id") {
                conn.execute_batch("DROP TRIGGER IF EXISTS stock_movements_bu;")?;
                if !has_col(&conn, "stock_movements", "sale_unit_id") {
                    conn.execute_batch(
                        "ALTER TABLE stock_movements ADD COLUMN sale_unit_id INTEGER REFERENCES sale_units(id);",
                    )?;
                }
                conn.execute_batch(
                    "UPDATE stock_movements SET sale_unit_id = \
                     (SELECT sell_unit_id FROM items WHERE id = stock_movements.item_id) \
                     WHERE sale_unit_id IS NULL;",
                )?;
                conn.execute_batch("ALTER TABLE stock_movements DROP COLUMN unit_id;")?;
                conn.execute_batch(
                    "CREATE TRIGGER IF NOT EXISTS stock_movements_bu \
                     BEFORE UPDATE ON stock_movements \
                     BEGIN \
                       SELECT RAISE(ABORT, 'stock_movements is append-only; insert a corrective movement instead'); \
                     END;",
                )?;
            }

            // --- purchase_items (independently idempotent) ---
            if has_col(&conn, "purchase_items", "unit_id") {
                if !has_col(&conn, "purchase_items", "sale_unit_id") {
                    conn.execute_batch(
                        "ALTER TABLE purchase_items ADD COLUMN sale_unit_id INTEGER REFERENCES sale_units(id);",
                    )?;
                }
                conn.execute_batch(
                    "UPDATE purchase_items SET sale_unit_id = \
                     (SELECT sell_unit_id FROM items WHERE id = purchase_items.item_id) \
                     WHERE sale_unit_id IS NULL;",
                )?;
                conn.execute_batch("ALTER TABLE purchase_items DROP COLUMN unit_id;")?;
            }

            // --- items (last, independently idempotent) ---
            if has_col(&conn, "items", "unit_id") {
                conn.execute_batch("ALTER TABLE items DROP COLUMN unit_id;")?;
            }
        }

        // M-INLINE-020: Rename default sale unit code from "unit" to "pcs" (guard: runs once).
        // Atomic — both the simple UPDATE and the sale_items table recreation must succeed or
        // roll back together, otherwise we'd leave a half-renamed schema behind.
        {
            let needs_unit_rename: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sale_units WHERE code = 'unit'
                      OR EXISTS (SELECT 1 FROM sale_items WHERE unit_type = 'unit')
                      OR EXISTS (SELECT 1 FROM items WHERE sell_unit = 'unit')",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if needs_unit_rename {
                conn.execute_batch("BEGIN")?;
                let result: Result<(), rusqlite::Error> = (|| {
                    conn.execute_batch(
                        "UPDATE sale_units SET code = 'pcs', label = 'Pcs' WHERE code = 'unit';
                         UPDATE items SET sell_unit = 'pcs' WHERE sell_unit = 'unit';",
                    )?;
                    // Recreate sale_items with updated CHECK constraint
                    conn.execute_batch(
                        "PRAGMA foreign_keys = OFF;
                         CREATE TABLE sale_items_new (
                                     id            INTEGER PRIMARY KEY AUTOINCREMENT,
                                     sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
                                     kind          TEXT    NOT NULL DEFAULT 'item' CHECK(kind IN ('item','formula')),
                                     item_id       INTEGER REFERENCES items(id) ON DELETE NO ACTION,
                                     formula_id    INTEGER REFERENCES formulas(id) ON DELETE NO ACTION,
                                     qty           REAL NOT NULL CHECK(qty > 0),
                                     price         INTEGER NOT NULL CHECK(price >= 0),
                                     unit_type     TEXT    NOT NULL DEFAULT 'pcs' CHECK(unit_type IN ('pcs','mtr','kg')),
                                     line_discount INTEGER NOT NULL DEFAULT 0,
                                     shade_note    TEXT,
                                     line_order    INTEGER NOT NULL DEFAULT 0,
                                     created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                                     created_by    INTEGER REFERENCES users(id) ON DELETE NO ACTION,
                                     display_name  TEXT
                                 );
                                 INSERT INTO sale_items_new
                                     SELECT id, sale_id, kind, item_id, formula_id, qty, price,
                                            CASE WHEN unit_type = 'unit' THEN 'pcs' ELSE unit_type END,
                                            line_discount, shade_note, line_order, created_at, created_by, display_name
                                     FROM sale_items;
                                 DROP TABLE sale_items;
                                 ALTER TABLE sale_items_new RENAME TO sale_items;
                                 CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
                                 CREATE INDEX IF NOT EXISTS idx_sale_items_item_id ON sale_items(item_id);
                                 CREATE INDEX IF NOT EXISTS idx_sale_items_formula_id ON sale_items(formula_id);
                                 PRAGMA foreign_keys = ON;",
                    )?;
                    Ok(())
                })();
                match result {
                    Ok(()) => conn.execute_batch("COMMIT")?,
                    Err(e) => {
                        // Best-effort rollback; surface the original error either way.
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(e);
                    }
                }
            }
        }

        // M-INLINE-021: Add cash_in_paise and cash_out_paise columns to day_close.
        // Fixes B2 (cash_out bound to expenses_paise) and B3 (cash_in never stored).
        {
            let has_cash_in: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('day_close') WHERE name = 'cash_in_paise'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_cash_in {
                conn.execute_batch(
                    "ALTER TABLE day_close ADD COLUMN cash_in_paise INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            let has_cash_out: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('day_close') WHERE name = 'cash_out_paise'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_cash_out {
                conn.execute_batch(
                    "ALTER TABLE day_close ADD COLUMN cash_out_paise INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
        }

        // M-INLINE-022: Add day_close re-model tables (header, lines, audit, categories).
        // Old `day_close` table remains untouched and in use; new tables are empty placeholders
        // for #6 and #7 to fill. Rename old -> _day_close_legacy and day_close_v2 -> day_close
        // happens in a later migration once all queries are rewritten.
        {
            let has_categories: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='cash_movement_categories'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_categories {
                conn.execute_batch(
                    "CREATE TABLE cash_movement_categories (\
                         id INTEGER PRIMARY KEY AUTOINCREMENT,\
                         name TEXT UNIQUE NOT NULL,\
                         kind TEXT NOT NULL CHECK (kind IN ('expense','cash_in','cash_out')),\
                         active INTEGER NOT NULL DEFAULT 1,\
                         created_at INTEGER NOT NULL\
                     );",
                )?;
            }

            let has_dcv2: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='day_close_v2'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_dcv2 {
                conn.execute_batch(
                    "CREATE TABLE day_close_v2 (\
                         id INTEGER PRIMARY KEY AUTOINCREMENT,\
                         business_day TEXT NOT NULL,\
                         location_id INTEGER NOT NULL,\
                         status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','amended','voided')),\
                         opened_by INTEGER NOT NULL,\
                         opened_at INTEGER NOT NULL,\
                         closed_by INTEGER,\
                         closed_at INTEGER,\
                         opening_cash_paise INTEGER NOT NULL,\
                         closing_cash_paise INTEGER NOT NULL,\
                         actual_cash_paise INTEGER NOT NULL,\
                         variance_paise INTEGER NOT NULL,\
                         note TEXT,\
                         backup_id TEXT,\
                         created_at INTEGER NOT NULL,\
                         updated_at INTEGER NOT NULL,\
                         UNIQUE (business_day, location_id)\
                     );\
                     CREATE INDEX idx_day_close_v2_business_day ON day_close_v2(business_day);\
                     CREATE INDEX idx_day_close_v2_location_day ON day_close_v2(location_id, business_day DESC);",
                )?;
            }

            let has_lines: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='day_close_lines'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_lines {
                conn.execute_batch(
                    "CREATE TABLE day_close_lines (\
                         id INTEGER PRIMARY KEY AUTOINCREMENT,\
                         day_close_id INTEGER NOT NULL REFERENCES day_close_v2(id) ON DELETE CASCADE,\
                         kind TEXT NOT NULL CHECK (kind IN ('cash_in','cash_out','expense','held_bill','return','credit','stock_ack')),\
                         category_id INTEGER REFERENCES cash_movement_categories(id),\
                         amount_paise INTEGER NOT NULL,\
                         reference_id INTEGER,\
                         reference_type TEXT,\
                         note TEXT,\
                         created_by INTEGER NOT NULL,\
                         created_at INTEGER NOT NULL\
                     );\
                     CREATE INDEX idx_day_close_lines_close ON day_close_lines(day_close_id);\
                     CREATE INDEX idx_day_close_lines_kind ON day_close_lines(kind);",
                )?;
            }

            let has_audit: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='day_close_audit'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if !has_audit {
                conn.execute_batch(
                    "CREATE TABLE day_close_audit (\
                         id INTEGER PRIMARY KEY AUTOINCREMENT,\
                         day_close_id INTEGER NOT NULL REFERENCES day_close_v2(id) ON DELETE CASCADE,\
                         action TEXT NOT NULL CHECK (action IN ('open','submit','amend','void','reopen')),\
                         actor_user_id INTEGER NOT NULL,\
                         payload_json TEXT,\
                         created_at INTEGER NOT NULL\
                     );\
                     CREATE INDEX idx_day_close_audit_close ON day_close_audit(day_close_id);",
                )?;
            }
        }

        // M-INLINE-023: Relax drafts CHECK constraint to accept sale-final/fbill/quotation.
        // SalesPage uses useAutosave(`sale-${kind}`, ...) sending form_type values like
        // "sale-final", "sale-fbill", "sale-quotation" which the old CHECK rejected.
        {
            let current_check: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='drafts'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            if current_check.contains("'sale','purchase','return')") {
                conn.execute_batch(
                    "CREATE TABLE drafts_new (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
                        form_type  TEXT    NOT NULL CHECK(form_type IN ('sale','sale-final','sale-fbill','sale-quotation','purchase','return')),
                        data_json  TEXT    NOT NULL DEFAULT '{}',
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        UNIQUE(user_id, form_type)
                    );
                    INSERT INTO drafts_new SELECT * FROM drafts;
                    DROP TABLE drafts;
                    ALTER TABLE drafts_new RENAME TO drafts;
                    CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);",
                )?;
            }
        }

        // -- Performance / safety (AFTER schema, outside txn) ------------
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;\
              PRAGMA journal_mode = WAL;\
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

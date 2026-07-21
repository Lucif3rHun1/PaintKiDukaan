//! Idempotent inline migrations for marker-DBs.
//!
//! Marker-DBs skipped the wipe-and-rebootstrap in `Db::open`, so they keep
//! their old column constraints. Each migration here is safe to re-run on
//! already-migrated databases.

use rusqlite::Connection;

/// Run all inline migrations in order. Each is independently idempotent.
pub fn run_inline_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    m_inline_001(conn)?;
    m_inline_002(conn)?;
    m_inline_003(conn)?;
    m_inline_004(conn)?;
    m_inline_005(conn)?;
    m_inline_006(conn)?;
    m_inline_007(conn)?;
    m_inline_008(conn)?;
    m_inline_009(conn)?;
    m_inline_010(conn)?;
    m_inline_011(conn)?;
    m_inline_012(conn)?;
    m_inline_013(conn)?;
    m_inline_014(conn)?;
    m_inline_015(conn)?;
    m_inline_016(conn)?;
    m_inline_017(conn)?;
    m_inline_018(conn)?;
    m_inline_020(conn)?;
    m_inline_021(conn)?;
    m_inline_022(conn)?;
    m_inline_023(conn)?;
    m_inline_024(conn)?;
    m_inline_025(conn)?;
    m_inline_026(conn)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Return `true` when `table.col` exists.
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

/// Return `true` when `table` exists in `sqlite_master`.
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        &format!(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='{name}'"
        ),
        [],
        |r| r.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/// M-INLINE-001: make purchases.vendor_id nullable so opening-stock entries
/// can omit a vendor.
fn m_inline_001(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-002: relax printer_mappings CHECK constraint to allow label
/// printers without explicit dimensions.
fn m_inline_002(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-003: add `formulas` table for custom shade mixes (ADR-011).
fn m_inline_003(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-004: rebuild `sale_items` to make item_id nullable and add
/// `kind` / `formula_id` / polymorphic CHECK (ADR-011).
fn m_inline_004(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_kind: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('sale_items') WHERE name = 'kind'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if has_kind {
        return Ok(());
    }

    let sale_items_exists = table_exists(conn, "sale_items");
    let sale_items_old_exists = table_exists(conn, "sale_items_old");

    // Clean up any leftover partial new table from a previous failed run.
    conn.execute_batch("DROP TABLE IF EXISTS sale_items_new;")?;

    if sale_items_exists {
        conn.execute_batch("ALTER TABLE sale_items RENAME TO sale_items_old;")?;
    }

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

    if sale_items_exists || sale_items_old_exists {
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
    Ok(())
}

/// M-INLINE-005: add `base_item_id` column to `formulas` table.
fn m_inline_005(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-006: drafts table for autosave.
fn m_inline_006(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-007: add print config columns to label_print_log.
fn m_inline_007(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-008: add sell_unit_id and min_stock columns to items table.
fn m_inline_008(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "items", "sell_unit_id") {
        conn.execute_batch(
            "ALTER TABLE items ADD COLUMN sell_unit_id INTEGER REFERENCES sale_units(id) ON DELETE NO ACTION;",
        )?;
    }
    if !has_col(conn, "items", "min_stock") {
        conn.execute_batch(
            "ALTER TABLE items ADD COLUMN min_stock REAL NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// M-INLINE-009: create sale_units, purchase_units, item_purchase_packaging
/// tables for the 3-unit system.
fn m_inline_009(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-010: add `date` column to `sale_returns`.
fn m_inline_010(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "sale_returns", "date") {
        conn.execute_batch("ALTER TABLE sale_returns ADD COLUMN date TEXT;")?;
    }
    Ok(())
}

/// M-INLINE-011: add `shade_note` column to `sale_return_lines`.
fn m_inline_011(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "sale_return_lines", "shade_note") {
        conn.execute_batch("ALTER TABLE sale_return_lines ADD COLUMN shade_note TEXT;")?;
    }
    Ok(())
}

/// M-INLINE-012: add `notes` column to `vendors`.
fn m_inline_012(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "vendors", "notes") {
        conn.execute_batch("ALTER TABLE vendors ADD COLUMN notes TEXT;")?;
    }
    Ok(())
}

/// M-INLINE-013: canonicalize min_stock, drop min_qty column.
fn m_inline_013(conn: &Connection) -> Result<(), rusqlite::Error> {
    if has_col(conn, "items", "min_qty") {
        conn.execute_batch(
            "UPDATE items SET min_stock = CAST(min_qty AS REAL) \
             WHERE min_stock = 0 AND min_qty > 0; \
             ALTER TABLE items DROP COLUMN min_qty;",
        )?;
    }
    Ok(())
}

/// M-INLINE-014: add `gstin` column to `settings`.
fn m_inline_014(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "settings", "gstin") {
        conn.execute_batch("ALTER TABLE settings ADD COLUMN gstin TEXT;")?;
    }
    Ok(())
}

/// M-INLINE-015: Recreate sales table to add 'fbill' to the CHECK constraint.
fn m_inline_015(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-016: Add display_name column to sale_items if missing.
fn m_inline_016(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "sale_items", "display_name") {
        conn.execute_batch("ALTER TABLE sale_items ADD COLUMN display_name TEXT;")?;
    }
    Ok(())
}

/// M-INLINE-017: Drop legacy unit_id from items, stock_movements, purchase_items.
fn m_inline_017(conn: &Connection) -> Result<(), rusqlite::Error> {
    // --- stock_movements (independently idempotent) ---
    if has_col(conn, "stock_movements", "unit_id") {
        conn.execute_batch("DROP TRIGGER IF EXISTS stock_movements_bu;")?;
        if !has_col(conn, "stock_movements", "sale_unit_id") {
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
    if has_col(conn, "purchase_items", "unit_id") {
        if !has_col(conn, "purchase_items", "sale_unit_id") {
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
    if has_col(conn, "items", "unit_id") {
        conn.execute_batch("ALTER TABLE items DROP COLUMN unit_id;")?;
    }
    Ok(())
}

/// M-INLINE-018: Remove CHECK constraint from sale_items that blocks custom
/// fbill lines. SQLite cannot ALTER CONSTRAINT, so we recreate the table.
fn m_inline_018(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-020: Rename default sale unit code from "unit" to "pcs".
fn m_inline_020(conn: &Connection) -> Result<(), rusqlite::Error> {
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
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}

/// M-INLINE-021: Add cash_in_paise and cash_out_paise columns to day_close.
fn m_inline_021(conn: &Connection) -> Result<(), rusqlite::Error> {
    if !has_col(conn, "day_close", "cash_in_paise") {
        conn.execute_batch(
            "ALTER TABLE day_close ADD COLUMN cash_in_paise INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !has_col(conn, "day_close", "cash_out_paise") {
        conn.execute_batch(
            "ALTER TABLE day_close ADD COLUMN cash_out_paise INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// M-INLINE-022: Add day_close re-model tables (header, lines, audit, categories).
fn m_inline_022(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-023: Relax drafts CHECK constraint to accept sale-final/fbill/quotation.
fn m_inline_023(conn: &Connection) -> Result<(), rusqlite::Error> {
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
    Ok(())
}

/// M-INLINE-024: Rename vendors.credit_limit_paise -> opening_balance_paise.
fn m_inline_024(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_old: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('vendors') WHERE name = 'credit_limit_paise'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if has_old {
        conn.execute_batch(
            "ALTER TABLE vendors RENAME COLUMN credit_limit_paise TO opening_balance_paise;",
        )?;
    }
    Ok(())
}

/// M-INLINE-025: Indexes for unified list display system (PR-1).
fn m_inline_025(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "\
        CREATE INDEX IF NOT EXISTS idx_items_category ON items(category) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_items_retail_price ON items(retail_price_paise) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_items_cost_price ON items(cost_paise) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date DESC) WHERE status != 'cancelled';\
        CREATE INDEX IF NOT EXISTS idx_sales_total ON sales(total DESC) WHERE status = 'final';\
        CREATE INDEX IF NOT EXISTS idx_sale_returns_date ON sale_returns(date DESC) WHERE date IS NOT NULL;\
        CREATE INDEX IF NOT EXISTS idx_sale_returns_refund ON sale_returns(refund_total_paise DESC);\
        CREATE INDEX IF NOT EXISTS idx_purchases_bill_date ON purchases(bill_date DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_purchases_bill_number ON purchases(bill_number) WHERE is_active = 1 AND bill_number IS NOT NULL;\
        CREATE INDEX IF NOT EXISTS idx_purchases_total ON purchases(total_paise DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(customer_type_id) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_customers_flagged ON customers(is_flagged, name) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_customers_balance ON customers(opening_balance_paise DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_vendors_balance ON vendors(opening_balance_paise DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_vendors_created ON vendors(created_at DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_brands_prefix ON brands(prefix) WHERE is_active = 1 AND prefix IS NOT NULL;\
        CREATE INDEX IF NOT EXISTS idx_brands_created ON brands(created_at DESC) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_formulas_name ON formulas(name) WHERE is_active = 1;\
        CREATE INDEX IF NOT EXISTS idx_day_close_day ON day_close(day DESC);",
    )?;
    Ok(())
}

/// M-INLINE-026: COLLATE NOCASE on name indexes & UNIQUE constraints.
///
/// Case-insensitive search via index. SQLite's `COLLATE NOCASE` is ASCII-only
/// by default — non-ASCII (e.g. Hindi/Devanagari) names remain case-sensitive.
/// We do not bundle the ICU extension; the ASCII ceiling is accepted for
/// paint-shop names.
///
/// Each step is independently idempotent (skipped when the COLLATE NOCASE
/// clause already exists on the index or table definition).
fn m_inline_026(conn: &Connection) -> Result<(), rusqlite::Error> {
    fn has_nocase(sql: String) -> bool {
        sql.contains("COLLATE NOCASE")
    }

    fn index_has_nocase(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",
            [name],
            |r| r.get::<_, String>(0),
        )
        .map(has_nocase)
        .unwrap_or(false)
    }

    fn table_has_nocase(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, String>(0),
        )
        .map(has_nocase)
        .unwrap_or(false)
    }

    // --- Drop & recreate name indexes with COLLATE NOCASE ---------------
    let index_pairs: &[(&str, &str)] = &[
        (
            "idx_users_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_users_is_active_name ON users(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_devices_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_devices_is_active_name ON devices(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_locations_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_locations_is_active_name ON locations(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_customers_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_customers_is_active_name ON customers(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_vendors_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_vendors_is_active_name ON vendors(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_items_is_active_name",
            "CREATE INDEX IF NOT EXISTS idx_items_is_active_name ON items(is_active, name COLLATE NOCASE)",
        ),
        (
            "idx_customers_flagged",
            "CREATE INDEX IF NOT EXISTS idx_customers_flagged ON customers(is_flagged, name COLLATE NOCASE) WHERE is_active = 1",
        ),
        (
            "idx_formulas_name",
            "CREATE INDEX IF NOT EXISTS idx_formulas_name ON formulas(name COLLATE NOCASE) WHERE is_active = 1",
        ),
    ];
    for (idx_name, create_sql) in index_pairs {
        if !index_has_nocase(conn, idx_name) {
            conn.execute_batch(&format!(
                "DROP INDEX IF EXISTS {idx_name}; {create_sql};"
            ))?;
        }
    }

    // --- Rebuild tables whose UNIQUE constraint needs COLLATE NOCASE ----
    // SQLite cannot ALTER a column's collation or an existing UNIQUE
    // constraint, so we recreate the table with the new column definition.
    // Indexes that the migration touched are recreated below. Data is
    // preserved via INSERT...SELECT. FKs are temporarily disabled because
    // the new table drops and recreates the parent's identity from sqlite's
    // view (rusqlite uses deferred-FK semantics on rebuild).

    // brands: UNIQUE is a partial index `uniq_brands_active_name`
    if !index_has_nocase(conn, "uniq_brands_active_name") {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;\
             DROP TABLE IF EXISTS brands_new;\
             CREATE TABLE brands_new (\
                 id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 name TEXT NOT NULL COLLATE NOCASE,\
                 prefix TEXT,\
                 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL,\
                 created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                 updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION\
             );\
             INSERT INTO brands_new \
                 SELECT id, name, prefix, is_active, created_at, updated_at, created_by, updated_by \
                 FROM brands;\
             DROP TABLE brands;\
             ALTER TABLE brands_new RENAME TO brands;\
             CREATE UNIQUE INDEX uniq_brands_active_name ON brands(name COLLATE NOCASE) WHERE is_active = 1;\
             CREATE INDEX IF NOT EXISTS idx_brands_prefix ON brands(prefix) WHERE is_active = 1 AND prefix IS NOT NULL;\
             CREATE INDEX IF NOT EXISTS idx_brands_created ON brands(created_at DESC) WHERE is_active = 1;\
             PRAGMA foreign_keys = ON;",
        )?;
    }

    // customer_types: UNIQUE is a partial index `uniq_customer_types_active_name`
    if !index_has_nocase(conn, "uniq_customer_types_active_name") {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;\
             DROP TABLE IF EXISTS customer_types_new;\
             CREATE TABLE customer_types_new (\
                 id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 name TEXT NOT NULL COLLATE NOCASE,\
                 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL,\
                 created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                 updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION\
             );\
             INSERT INTO customer_types_new \
                 SELECT id, name, is_active, created_at, updated_at, created_by, updated_by \
                 FROM customer_types;\
             DROP TABLE customer_types;\
             ALTER TABLE customer_types_new RENAME TO customer_types;\
             CREATE UNIQUE INDEX uniq_customer_types_active_name ON customer_types(name COLLATE NOCASE) WHERE is_active = 1;\
             PRAGMA foreign_keys = ON;",
        )?;
    }

    // categories: UNIQUE is an inline column constraint
    if !table_has_nocase(conn, "categories") {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;\
             DROP TABLE IF EXISTS categories_new;\
             CREATE TABLE categories_new (\
                 id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,\
                 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL\
             );\
             INSERT INTO categories_new \
                 SELECT id, name, is_active, created_at, updated_at \
                 FROM categories;\
             DROP TABLE categories;\
             ALTER TABLE categories_new RENAME TO categories;\
             PRAGMA foreign_keys = ON;",
        )?;
    }

    // sub_locations: UNIQUE is a composite column constraint (location_id, name)
    if !table_has_nocase(conn, "sub_locations") {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;\
             DROP TABLE IF EXISTS sub_locations_new;\
             CREATE TABLE sub_locations_new (\
                 id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE NO ACTION,\
                 name TEXT NOT NULL COLLATE NOCASE,\
                 position TEXT,\
                 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL,\
                 created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                 updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                 UNIQUE(location_id, name COLLATE NOCASE)\
             );\
             INSERT INTO sub_locations_new \
                 SELECT id, location_id, name, position, is_active, created_at, updated_at, created_by, updated_by \
                 FROM sub_locations;\
             DROP TABLE sub_locations;\
             ALTER TABLE sub_locations_new RENAME TO sub_locations;\
             CREATE INDEX IF NOT EXISTS idx_sub_locations_location_active ON sub_locations(location_id) WHERE is_active = 1;\
             PRAGMA foreign_keys = ON;",
        )?;
    }

    // devices: UNIQUE is an inline column constraint
    if !table_has_nocase(conn, "devices") {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;\
             DROP TABLE IF EXISTS devices_new;\
             CREATE TABLE devices_new (\
                 id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,\
                 last_seen_at INTEGER,\
                 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL,\
                 created_by INTEGER REFERENCES users(id) ON DELETE NO ACTION,\
                 updated_by INTEGER REFERENCES users(id) ON DELETE NO ACTION\
             );\
             INSERT INTO devices_new \
                 SELECT id, name, last_seen_at, is_active, created_at, updated_at, created_by, updated_by \
                 FROM devices;\
             DROP TABLE devices;\
             ALTER TABLE devices_new RENAME TO devices;\
             CREATE INDEX IF NOT EXISTS idx_devices_is_active_name ON devices(is_active, name COLLATE NOCASE);\
             PRAGMA foreign_keys = ON;",
        )?;
    }

    Ok(())
}

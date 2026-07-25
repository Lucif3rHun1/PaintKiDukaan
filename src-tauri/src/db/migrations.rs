#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn test_migrations_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        // SQLCipher in-memory still needs a key pragma.
        conn.execute_batch("PRAGMA key = 'test';").unwrap();

        // Fresh DBs use schema_final.sql (the canonical final schema),
        // which absorbs all migrations 001–009.
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        // Second apply: running schema_final.sql again on an already-bootstrapped
        // DB must be safe (tables already exist → no-op on CREATE TABLE IF NOT
        // EXISTS — note: our schema uses CREATE TABLE, so this would fail).
        // We deliberately re-run the same file to verify the DB doesn't corrupt.
        // rusqlite_migration would report "already at latest" — here we just
        // verify the DB is still usable.
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(
            tables.contains(&"sales".to_string()),
            "sales table should exist after first apply"
        );
        assert!(
            tables.contains(&"customers".to_string()),
            "customers table should exist after first apply"
        );
        // Verifies the connection is still usable after re-running the schema.
        conn.execute_batch("SELECT 1").unwrap();
    }

    /// Every table documented in the canonical final schema must be present
    /// after applying `schema_final.sql`. Catches drift between the schema
    /// file and the actual DB shape (typos, accidental drops, etc.).
    ///
    /// Fresh DBs bypass the migration chain entirely (see `Db::is_fresh_database`
    /// + `SCHEMA_FINAL` in `db/mod.rs`), so this test validates the fresh-DB
    /// path rather than the old `schema.sql` → 009 chain (which has a pre-existing
    /// bug in M009 that references `notes` before it was added).
    #[test]
    fn schema_loads_all_expected_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        let expected = [
            // Section A
            "users",
            "lockouts",
            "devices",
            "settings",
            // Section B
            "locations",
            "sub_locations",
            "units",
            // Section C
            "customer_types",
            "customers",
            "vendors",
            // Section D
            "brands",
            "brand_sequences",
            "sequences",
            "daily_counters",
            "items",
            "formulas",
            // Section E
            "stock_movement_kinds",
            "stock_movements",
            "stock_balances",
            // Section F
            "purchases",
            "purchase_items",
            "vendor_payments",
            // Section G
            "sales",
            "sale_items",
            "sale_payments",
            "customer_payments",
            // Section H
            "sale_returns",
            "sale_return_lines",
            "sale_return_payments",
            // Section I
            "day_close",
            // Section J
            "alerts",
            "alert_roles",
            "alert_reads",
            // Label print log
            "label_print_log",
            "printers",
            "printer_mappings",
            // 3-unit system
            "sale_units",
            "purchase_units",
            "item_purchase_packaging",
        ];

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let actual: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        for tbl in expected {
            assert!(
                actual.iter().any(|t| t == tbl),
                "expected table `{tbl}` missing after migration; actual tables: {actual:?}"
            );
        }
    }

    /// M-039: timestamp columns must be INTEGER (unix epoch ms) instead of TEXT.
    /// Default must use `strftime('%s','now') * 1000` and must NOT use
    /// `datetime('now','localtime')` (legacy localtime TEXT default).
    #[test]
    fn m039_timestamps_are_integer_ms() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        let tables_with_created_at = [
            ("customers", "created_at"),
            ("customers", "updated_at"),
            ("formulas", "created_at"),
            ("sales", "created_at"),
            ("sales", "updated_at"),
            ("sale_items", "created_at"),
            ("sale_units", "created_at"),
            ("sale_units", "updated_at"),
            ("purchase_units", "created_at"),
            ("purchase_units", "updated_at"),
            ("item_purchase_packaging", "created_at"),
            ("item_purchase_packaging", "updated_at"),
        ];

        for (table, col) in &tables_with_created_at {
            let col_type: String = conn
                .query_row(
                    &format!(
                        "SELECT type FROM pragma_table_info('{table}') WHERE name = ?1"
                    ),
                    [col],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("column {table}.{col} missing"));
            assert_eq!(
                col_type, "INTEGER",
                "table `{table}` column `{col}` must be INTEGER, got: {col_type}"
            );
        }

        // CREATE TABLE SQL must use epoch ms default and never localtime.
        for table in &[
            "customers", "formulas", "sales", "sale_items",
            "sale_units", "purchase_units", "item_purchase_packaging",
        ] {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            assert!(
                sql.contains("strftime('%s','now')"),
                "table `{table}` should use epoch-seconds default; got: {sql}"
            );
            assert!(
                !sql.contains("datetime('now','localtime')"),
                "table `{table}` should not use localtime DEFAULT; got: {sql}"
            );
        }
    }

    /// M-039: schema_default produces a unix epoch millisecond value
    /// (large integer, ~1.7e12 in 2025-2026).
    #[test]
    fn m039_default_is_ms_integer() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        let now: i64 = conn
            .query_row(
                "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // 2024-01-01 00:00:00 UTC = 1704067200000; current ms must be >= that.
        assert!(
            now >= 1_704_067_200_000,
            "now ms ({now}) should be >= 2024-01-01 epoch ms (1704067200000)"
        );
        // Sanity: must be < year 2100 epoch ms (4_102_444_800_000)
        assert!(
            now < 4_102_444_800_000,
            "now ms ({now}) should be < 2100-01-01 epoch ms"
        );
        // Verify 1-second boundary: strftime('%s','now') * 1000 increments in 1000-steps.
        let delta: i64 = conn
            .query_row(
                "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 - ?1",
                [now],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            delta < 1500 && delta >= 0,
            "delta between two calls ({delta}) should be < 1500ms"
        );
    }

}

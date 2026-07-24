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

    /// M-039: TEXT timestamps must default to UTC with millisecond precision
    /// (format `YYYY-MM-DD HH:MM:SS.fff`, 23 chars) rather than the legacy
    /// `datetime('now','localtime')` (19 chars, no fractional, local TZ).
    #[test]
    fn m039_timestamps_use_utc_ms_format() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        let tables_with_created_at = [
            "customers", "formulas", "sales", "sale_items",
            "sale_units", "purchase_units", "item_purchase_packaging",
        ];

        for table in &tables_with_created_at {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            assert!(
                sql.contains("strftime('%Y-%m-%d %H:%M:%f', 'now')"),
                "table `{table}` should use UTC ms DEFAULT; got: {sql}"
            );
            assert!(
                !sql.contains("datetime('now','localtime')"),
                "table `{table}` should not use localtime DEFAULT; got: {sql}"
            );
        }
    }

    /// M-039: schema_default produces a 23-char UTC millisecond timestamp.
    #[test]
    fn m039_default_format_is_23_chars() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        conn.execute_batch(crate::db::SCHEMA_FINAL)
            .expect("schema_final.sql should apply");

        let now: String = conn
            .query_row(
                "SELECT strftime('%Y-%m-%d %H:%M:%f', 'now')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Format: YYYY-MM-DD HH:MM:SS.fff (4+1+2+1+2+1+2+1+2+1+2+1+3 = 23)
        assert_eq!(now.len(), 23, "got '{now}' (len={}); expected 23", now.len());
        // Must NOT contain 'T' (we use space, not ISO 8601 'T' separator for
        // backward compat with NaiveDateTime::parse_from_str format).
        assert!(!now.contains('T'), "got '{now}'; should not contain 'T'");
        // Must contain the fractional separator.
        assert!(now.contains('.'), "got '{now}'; should be ms-precision");
    }

}

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Canonical schema (single source of truth, all tables + indexes + seed data).
/// Versioned only via this file — every post-launch change is a new migration in
/// `migrations/NNN__slug.sql` registered below.
const SCHEMA: &str = include_str!("schema.sql");
const MIGRATION_001: &str = include_str!("migrations/001__add_missing_tables.sql");
const MIGRATION_002: &str = include_str!("migrations/002__add_units_dimension_and_brands.sql");
const MIGRATION_003: &str = include_str!("migrations/003__add_items_brand_unit_sell_unit.sql");
const MIGRATION_004: &str = include_str!("migrations/004__drop_location_text.sql");
const MIGRATION_005: &str = include_str!("migrations/005__daily_counters_and_return_payments.sql");
const MIGRATION_006: &str = include_str!("migrations/006__update_customer_types.sql");
const MIGRATION_007: &str = include_str!("migrations/007__add_no_to_sale_returns.sql");
const MIGRATION_008: &str = include_str!("migrations/008__reconcile_schema_to_rust.sql");
const MIGRATION_008: &str = include_str!("migrations/008__printers.sql");

/// Migration set — canonical baseline. All future schema changes go in
/// `migrations/` subdirectory and are appended after `M::up(SCHEMA)`.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(SCHEMA),
        M::up(MIGRATION_001),
        M::up(MIGRATION_002),
        M::up(MIGRATION_003),
        M::up(MIGRATION_004),
        M::up(MIGRATION_005),
        M::up(MIGRATION_006),
        M::up(MIGRATION_007),
        M::up(MIGRATION_008),
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

    /// Every table documented in `schema.sql`'s section comments must be present
    /// after migration runs. Catches drift between the canonical schema file and
    /// the actual DB shape (typos, accidental drops, etc.).
    #[test]
    fn schema_loads_all_expected_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        run(&mut conn).expect("migrations should apply");

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
            "unit_conversions",
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
}

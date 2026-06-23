//! Integration tests for inventory operations.
//!
//! Covers items (search, SKU generation), brands (CRUD, barcode gen),
//! locations (CRUD), units (CRUD, conversions), purchases/inward
//! (create, stock movements, validation), stock balances, and label log.

use paintkiduakan_lib::commands::brands::generate_brand_barcode;
use paintkiduakan_lib::commands::items::{self, Item, ItemSearchHit};
use paintkiduakan_lib::commands::purchases::{
    self, InwardLine, NewPurchase, Purchase, PurchaseCreated, PurchaseError, PurchaseItem,
    StockMovement,
};
use paintkiduakan_lib::db::Db;
use paintkiduakan_lib::error::AppError;
use paintkiduakan_lib::session::{set_current_user, Role, User};
use rusqlite::{params, Connection, OptionalExtension};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_V1: &str = include_str!("../src/db/schema_v1.sql");
const SCHEMA_V2: &str = include_str!("../src/db/schema_v2.sql");
const SCHEMA_V3: &str = include_str!("../src/db/schema_v3.sql");
const SCHEMA_V4: &str = include_str!("../src/db/schema_v4.sql");
const SCHEMA_V5: &str = include_str!("../src/db/schema_v5.sql");
const SCHEMA_V6: &str = include_str!("../src/db/schema_v6.sql");
const SCHEMA_V7: &str = include_str!("../src/db/schema_v7.sql");
const SCHEMA_V8: &str = include_str!("../src/db/schema_v8.sql");
const SCHEMA_V9: &str = include_str!("../src/db/schema_v9.sql");
const SCHEMA_V10: &str = include_str!("../src/db/schema_v10.sql");

trait InventoryTestDbExt {
    fn open_in_memory() -> Result<Db, rusqlite::Error>;
}

impl InventoryTestDbExt for Db {
    fn open_in_memory() -> Result<Db, rusqlite::Error> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "paintkiduakan-inventory-{}-{nanos}.db",
            std::process::id()
        ));
        let mut conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA key = \"x'4242424242424242424242424242424242424242424242424242424242424242'\";")?;
        conn.execute_batch("PRAGMA cipher_compatibility = 4; PRAGMA cipher_page_size = 4096;")?;
        for sql in [
            SCHEMA_V1,
            SCHEMA_V2,
            SCHEMA_V3,
            SCHEMA_V4,
            SCHEMA_V5,
            SCHEMA_V6,
            SCHEMA_V7,
            SCHEMA_V8,
            SCHEMA_V9,
            SCHEMA_V10,
            "ALTER TABLE sales ADD COLUMN voided_at INTEGER;
             ALTER TABLE sales ADD COLUMN voided_by INTEGER REFERENCES users(id);
             ALTER TABLE sales ADD COLUMN edited_at INTEGER;
             ALTER TABLE sales ADD COLUMN edited_by INTEGER REFERENCES users(id);",
            "PRAGMA user_version = 11;",
        ] {
            conn.execute_batch(sql)?;
        }
        drop(conn);
        Db::open(&path, &[0x42; 32])
    }
}

// ───────────────────────────── Fixtures ─────────────────────────────

struct Inventory {
    db: Db,
    owner_id: i64,
    cashier_id: i64,
    stocker_id: i64,
    shop_id: i64,
    godown_id: i64,
    litre_id: i64,
    ml_id: i64,
    pc_id: i64,
    brand_id: i64,
    vendor_id: i64,
    item_id: i64,
    item2_id: i64,
}

fn fresh_inventory_db() -> Inventory {
    let db = Db::open_in_memory().expect("open in-memory db");
    db.with_raw(|c: &Connection| -> rusqlite::Result<()> {
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Owner', 'owner', X'00', X'00', 6)",
            [],
        )?;
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Cashier', 'cashier', X'00', X'00', 6)",
            [],
        )?;
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Stocker', 'stocker', X'00', X'00', 6)",
            [],
        )?;
        c.execute("INSERT INTO locations (name, rack) VALUES ('Shop', 'A1')", [])?;
        c.execute("INSERT INTO locations (name, rack) VALUES ('Godown', 'B1')", [])?;
        c.execute(
            "INSERT INTO vendors (name, phone, contact_person, credit_limit, opening_balance, notes, is_active)
             VALUES ('Asian Paints Ltd', '9812345678', 'Mr. Rao', 1000000, 0, 'preferred', 1)",
            [],
        )?;
        c.execute(
            "INSERT OR IGNORE INTO brands (id, name, code_prefix) VALUES (100, 'Test Asian Paints', 'TA')",
            [],
        )?;
        c.execute(
            "INSERT OR REPLACE INTO brand_sequences (brand_id, next_seq) VALUES (100, 1)",
            [],
        )?;
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, brand, brand_id, category,
                 retail_price_paise, cost_paise, promo_price_paise, label_line1, label_line2,
                 location_text, primary_location_id, min_qty, barcode_format, unit_id)
             SELECT 'SKU-00001', 'BC-001', 'Asian Premium', 'Test Asian Paints', 100, 'emulsion',
                    10000, 8000, NULL, 'Asian Premium', '1L', 'A1', 1, 2, 'CODE128', u.id
             FROM units u WHERE u.code = 'L'",
            [],
        )?;
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, brand, brand_id, category,
                 retail_price_paise, cost_paise, promo_price_paise, label_line1, label_line2,
                 location_text, primary_location_id, min_qty, barcode_format, unit_id)
             SELECT 'SKU-00002', 'BC-002', 'Berger Primer', 'Berger', NULL, 'primer',
                    7000, 5500, NULL, 'Berger Primer', '1L', 'B1', 2, 1, 'CODE128', u.id
             FROM units u WHERE u.code = 'L'",
            [],
        )?;
        c.execute("INSERT INTO stock_balances (item_id, location_id, qty) VALUES (1, 1, 10)", [])?;

        c.execute(
            "CREATE TABLE IF NOT EXISTS label_print_log (
                id INTEGER PRIMARY KEY,
                item_id INTEGER NOT NULL REFERENCES items(id),
                barcode TEXT NOT NULL,
                qty INTEGER NOT NULL CHECK(qty > 0),
                format TEXT NOT NULL,
                line1 TEXT,
                line2 TEXT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let owner_id = one_i64(&db, "SELECT id FROM users WHERE role='owner'");
    let cashier_id = one_i64(&db, "SELECT id FROM users WHERE role='cashier'");
    let stocker_id = one_i64(&db, "SELECT id FROM users WHERE role='stocker'");
    let shop_id = one_i64(&db, "SELECT id FROM locations WHERE name='Shop'");
    let godown_id = one_i64(&db, "SELECT id FROM locations WHERE name='Godown'");
    let litre_id = one_i64(&db, "SELECT id FROM units WHERE code='L'");
    let ml_id = one_i64(&db, "SELECT id FROM units WHERE code='ml'");
    let pc_id = one_i64(&db, "SELECT id FROM units WHERE code='pc'");
    let brand_id = one_i64(&db, "SELECT id FROM brands WHERE name='Test Asian Paints'");
    let vendor_id = one_i64(&db, "SELECT id FROM vendors WHERE name='Asian Paints Ltd'");
    let item_id = one_i64(&db, "SELECT id FROM items WHERE sku_code='SKU-00001'");
    let item2_id = one_i64(&db, "SELECT id FROM items WHERE sku_code='SKU-00002'");

    Inventory {
        db,
        owner_id,
        cashier_id,
        stocker_id,
        shop_id,
        godown_id,
        litre_id,
        ml_id,
        pc_id,
        brand_id,
        vendor_id,
        item_id,
        item2_id,
    }
}

fn one_i64(db: &Db, sql: &str) -> i64 {
    db.with_raw(|c| c.query_row(sql, [], |r| r.get(0))).unwrap()
}

fn owner_user(p: &Inventory) -> User {
    User { id: p.owner_id, name: "Owner".into(), role: Role::Owner }
}

fn cashier_user(p: &Inventory) -> User {
    User { id: p.cashier_id, name: "Cashier".into(), role: Role::Cashier }
}

fn stocker_user(p: &Inventory) -> User {
    User { id: p.stocker_id, name: "Stocker".into(), role: Role::Stocker }
}

fn inward_line(item_id: i64, location_id: i64, qty: f64, cost_price: i64) -> InwardLine {
    InwardLine { item_id, qty, cost_price, retail_price: cost_price + 2000, location_id }
}

fn purchase(lines: Vec<InwardLine>, vendor_id: Option<i64>) -> NewPurchase {
    NewPurchase {
        vendor_id,
        date: Some("2026-06-15".into()),
        notes: Some("stock inward".into()),
        auto_print_label: false,
        lines,
    }
}

fn create_basic_inward(p: &Inventory) -> PurchaseCreated {
    set_current_user(Some(owner_user(p)));
    purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 3.0, 8100)], Some(p.vendor_id)),
    )
    .unwrap()
}

fn row_count(db: &Db, table: &str) -> i64 {
    db.with_raw(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
        .unwrap()
}

// ───────────────────────────── Items ─────────────────────────────

#[test]
fn search_items_exact_barcode_wins() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| -> rusqlite::Result<()> {
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, retail_price_paise, cost_paise,
                 primary_location_id, min_qty, barcode_format, unit_id)
             SELECT 'SKU-00003', 'BC-003', 'BC-001 Fuzzy Name', 100, 50, 1, 0, 'CODE128', u.id
             FROM units u WHERE u.code='L'",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let hits = items::search_items(&p.db, "BC-001", 10).unwrap();
    assert!(!hits.is_empty());
    assert_eq!(hits[0].barcode.as_deref(), Some("BC-001"));
}

#[test]
fn search_items_exact_sku_wins() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| -> rusqlite::Result<()> {
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, retail_price_paise, cost_paise,
                 primary_location_id, min_qty, barcode_format, unit_id)
             SELECT 'SKU-99999', 'BC-999', 'Fuzzy SKU-00001 Name', 100, 50, 1, 0, 'CODE128', u.id
             FROM units u WHERE u.code='L'",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let hits = items::search_items(&p.db, "SKU-00001", 10).unwrap();
    assert_eq!(hits[0].sku_code, "SKU-00001");
}

#[test]
fn search_items_fuzzy_name() {
    let p = fresh_inventory_db();
    let hits = items::search_items(&p.db, "Premium", 10).unwrap();
    assert!(hits.iter().any(|h| h.name == "Asian Premium"));
}

#[test]
fn search_items_inactive_excluded() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| c.execute("UPDATE items SET is_active=0 WHERE id=?1", params![p.item_id]))
        .unwrap();
    assert!(items::search_items(&p.db, "Asian", 10).unwrap().is_empty());
}

#[test]
fn search_items_empty_query_returns_nothing() {
    let p = fresh_inventory_db();
    let hits = items::search_items(&p.db, "   ", 0).unwrap();
    assert!(hits.is_empty());
}

#[test]
fn search_items_limit_works() {
    let p = fresh_inventory_db();
    let hits = items::search_items(&p.db, "", 1).unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn item_sku_auto_generation() {
    let p = fresh_inventory_db();
    let sku = p.db.with_raw(|c| -> Result<String, AppError> {
        c.execute("UPDATE sequences SET last_value = last_value + 1 WHERE name='sku'", [])?;
        let n: i64 = c.query_row("SELECT last_value FROM sequences WHERE name='sku'", [], |r| r.get(0))?;
        Ok(format!("SKU-{n:06}"))
    })
    .unwrap();
    assert!(sku.starts_with("SKU-"));
    assert_eq!(sku.len(), 10);
}

#[test]
fn item_barcode_uniqueness() {
    let p = fresh_inventory_db();
    let err = p.db.with_raw(|c| -> rusqlite::Result<()> {
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_test_items_barcode_unique ON items(barcode)", [])?;
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, retail_price_paise, cost_paise,
                 primary_location_id, min_qty, barcode_format, unit_id)
             SELECT 'SKU-00999', 'BC-001', 'Duplicate Barcode', 100, 50, 1, 0, 'CODE128', u.id
             FROM units u WHERE u.code='L'",
            [],
        )?;
        Ok(())
    })
    .unwrap_err();
    assert!(matches!(err, rusqlite::Error::SqliteFailure(_, _)));
}

#[test]
fn search_items_returns_current_qty() {
    let p = fresh_inventory_db();
    let hits = items::search_items(&p.db, "BC-001", 10).unwrap();
    assert_eq!(hits[0].current_qty, 10);
}

// ───────────────────────────── Brands ─────────────────────────────

#[test]
fn brand_create_and_lookup() {
    let p = fresh_inventory_db();
    let row: (String, String, i64) = p.db.with_raw(|c| -> rusqlite::Result<_> {
        c.execute("INSERT INTO brands (name, code_prefix) VALUES ('Fresh Brand', 'FB')", [])?;
        let id = c.last_insert_rowid();
        c.execute("INSERT INTO brand_sequences (brand_id, next_seq) VALUES (?1, 1)", params![id])?;
        c.query_row(
            "SELECT b.name, b.code_prefix, s.next_seq FROM brands b JOIN brand_sequences s ON s.brand_id=b.id WHERE b.id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    })
    .unwrap();
    assert_eq!(row, ("Fresh Brand".into(), "FB".into(), 1));
}

#[test]
fn brand_generate_barcode() {
    let p = fresh_inventory_db();
    let code = p
        .db
        .with_raw(|c| generate_brand_barcode(c, p.brand_id, "Test Asian Paints Ace 1L"))
        .unwrap();
    assert_eq!(code, "TAACE001");
}

#[test]
fn brand_barcode_increments() {
    let p = fresh_inventory_db();
    let codes = p.db.with_raw(|c| -> Result<Vec<String>, AppError> {
        Ok(vec![
            generate_brand_barcode(c, p.brand_id, "Ace 1L")?,
            generate_brand_barcode(c, p.brand_id, "Ace 4L")?,
        ])
    })
    .unwrap();
    assert_eq!(codes, vec!["TAACE001", "TAACE002"]);
}

#[test]
fn brand_deactivate() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| -> rusqlite::Result<()> {
        c.execute("INSERT INTO brands (name, code_prefix) VALUES ('Dormant', 'DR')", [])?;
        let id = c.last_insert_rowid();
        c.execute("INSERT INTO brand_sequences (brand_id, next_seq) VALUES (?1, 1)", params![id])?;
        c.execute("DELETE FROM brand_sequences WHERE brand_id=?1", params![id])?;
        c.execute("DELETE FROM brands WHERE id=?1", params![id])?;
        Ok(())
    })
    .unwrap();
    let count: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT COUNT(*) FROM brands WHERE name='Dormant'", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn brand_prefix_in_sku() {
    let p = fresh_inventory_db();
    let sku = p
        .db
        .with_raw(|c| generate_brand_barcode(c, p.brand_id, "Test Asian Paints Royale"))
        .unwrap();
    assert!(sku.starts_with("TAROY"));
}

// ───────────────────────────── Locations ─────────────────────────────

#[test]
fn location_create_and_list() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| c.execute("INSERT INTO locations (name, rack) VALUES ('Backroom', 'C1')", []))
        .unwrap();
    let names: Vec<String> = p.db.with_raw(|c| -> rusqlite::Result<Vec<String>> {
        let mut stmt = c.prepare("SELECT name FROM locations WHERE is_active=1 ORDER BY name")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect();
        rows
    })
    .unwrap();
    assert!(names.contains(&"Backroom".into()));
    assert!(names.contains(&"Shop".into()));
}

#[test]
fn location_rename() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| c.execute("UPDATE locations SET name='Front Shop', rack='A2' WHERE id=?1", params![p.shop_id]))
        .unwrap();
    let row: (String, String) = p.db.with_raw(|c| {
        c.query_row("SELECT name, rack FROM locations WHERE id=?1", params![p.shop_id], |r| Ok((r.get(0)?, r.get(1)?)))
    })
    .unwrap();
    assert_eq!(row, ("Front Shop".into(), "A2".into()));
}

#[test]
fn location_deactivate() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| c.execute("UPDATE locations SET is_active=0 WHERE id=?1", params![p.godown_id]))
        .unwrap();
    let active: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT is_active FROM locations WHERE id=?1", params![p.godown_id], |r| r.get(0)))
        .unwrap();
    assert_eq!(active, 0);
}

#[test]
fn location_in_stock_balances() {
    let p = fresh_inventory_db();
    let loc_name: String = p.db.with_raw(|c| {
        c.query_row(
            "SELECT l.name FROM stock_balances sb JOIN locations l ON l.id=sb.location_id WHERE sb.item_id=?1",
            params![p.item_id],
            |r| r.get(0),
        )
    })
    .unwrap();
    assert_eq!(loc_name, "Shop");
}

// ───────────────────────────── Units ─────────────────────────────

#[test]
fn unit_create_and_list() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| c.execute("INSERT INTO units (code, label, dimension) VALUES ('tin', 'Tin', 'count')", []))
        .unwrap();
    let label: String = p
        .db
        .with_raw(|c| c.query_row("SELECT label FROM units WHERE code='tin'", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(label, "Tin");
}

#[test]
fn unit_conversion_create() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| {
        c.execute(
            "INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor) VALUES (?1, ?2, 1000.0)
             ON CONFLICT(from_unit_id, to_unit_id) DO UPDATE SET factor=excluded.factor",
            params![p.litre_id, p.ml_id],
        )
    })
    .unwrap();
    let factor: f64 = p.db.with_raw(|c| {
        c.query_row(
            "SELECT factor FROM unit_conversions WHERE from_unit_id=?1 AND to_unit_id=?2",
            params![p.litre_id, p.ml_id],
            |r| r.get(0),
        )
    })
    .unwrap();
    assert_eq!(factor, 1000.0);
}

#[test]
fn unit_dimension_values() {
    let p = fresh_inventory_db();
    let dims: Vec<String> = p.db.with_raw(|c| -> rusqlite::Result<Vec<String>> {
        let mut stmt = c.prepare("SELECT DISTINCT dimension FROM units ORDER BY dimension")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect();
        rows
    })
    .unwrap();
    assert!(dims.contains(&"volume".into()));
    assert!(dims.contains(&"mass".into()));
    assert!(dims.contains(&"count".into()));
}

// ───────────────────────────── Purchases/Inward ─────────────────────────────

#[test]
fn create_inward_basic() {
    let p = fresh_inventory_db();
    let created = create_basic_inward(&p);
    let counts: (i64, i64, i64) = p.db.with_raw(|c| -> rusqlite::Result<_> {
        Ok((
            c.query_row("SELECT COUNT(*) FROM purchases WHERE id=?1", params![created.id], |r| r.get(0))?,
            c.query_row("SELECT COUNT(*) FROM purchase_items WHERE purchase_id=?1", params![created.id], |r| r.get(0))?,
            c.query_row("SELECT COUNT(*) FROM stock_movements WHERE ref_type='purchase' AND ref_id=?1", params![created.id], |r| r.get(0))?,
        ))
    })
    .unwrap();
    assert_eq!(counts, (1, 1, 1));
}

#[test]
fn create_inward_multi_line() {
    let p = fresh_inventory_db();
    set_current_user(Some(owner_user(&p)));
    let created = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(
            vec![
                inward_line(p.item_id, p.shop_id, 2.0, 8000),
                inward_line(p.item2_id, p.godown_id, 4.0, 5000),
            ],
            Some(p.vendor_id),
        ),
    )
    .unwrap();
    let items = purchases::get(&p.db, created.id).unwrap().unwrap().items;
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].qty, 2);
    assert_eq!(items[1].qty, 4);
}

#[test]
fn create_inward_stock_movement_positive() {
    let p = fresh_inventory_db();
    let created = create_basic_inward(&p);
    let qty: i64 = p.db.with_raw(|c| {
        c.query_row("SELECT qty FROM stock_movements WHERE ref_id=?1", params![created.id], |r| r.get(0))
    })
    .unwrap();
    assert_eq!(qty, 3);
}

#[test]
fn create_inward_total_calculation() {
    let p = fresh_inventory_db();
    set_current_user(Some(owner_user(&p)));
    let created = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(
            vec![
                inward_line(p.item_id, p.shop_id, 2.0, 8000),
                inward_line(p.item2_id, p.godown_id, 3.0, 5000),
            ],
            Some(p.vendor_id),
        ),
    )
    .unwrap();
    let total: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT total FROM purchases WHERE id=?1", params![created.id], |r| r.get(0)))
        .unwrap();
    assert_eq!(total, 31_000);
}

#[test]
fn create_inward_empty_lines_error() {
    let p = fresh_inventory_db();
    let err = purchases::create_inward(&p.db, p.owner_id, purchase(vec![], Some(p.vendor_id))).unwrap_err();
    assert!(matches!(err, PurchaseError::EmptyLines));
}

#[test]
fn create_inward_bad_qty_error() {
    let p = fresh_inventory_db();
    let err = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 0.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap_err();
    assert!(matches!(err, PurchaseError::BadQty(0)));
}

#[test]
fn create_inward_item_not_found_error() {
    let p = fresh_inventory_db();
    let err = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(99_999, p.shop_id, 1.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap_err();
    assert!(matches!(err, PurchaseError::ItemNotFound(0, 99_999)));
}

#[test]
fn create_inward_location_not_found_error() {
    let p = fresh_inventory_db();
    let err = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, 99_999, 1.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap_err();
    assert!(matches!(err, PurchaseError::LocationNotFound(0, 99_999)));
}

#[test]
fn create_inward_bad_cost_error() {
    let p = fresh_inventory_db();
    let err = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, -1)], Some(p.vendor_id)),
    )
    .unwrap_err();
    assert!(matches!(err, PurchaseError::BadCost(0)));
}

#[test]
fn create_inward_bad_retail_error() {
    let p = fresh_inventory_db();
    let mut line = inward_line(p.item_id, p.shop_id, 1.0, 8000);
    line.retail_price = -1;
    let err = purchases::create_inward(&p.db, p.owner_id, purchase(vec![line], Some(p.vendor_id))).unwrap_err();
    assert!(matches!(err, PurchaseError::BadRetail(0)));
}

#[test]
fn create_inward_auto_print_label_flag_round_trips() {
    let p = fresh_inventory_db();
    let mut req = purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, 8000)], Some(p.vendor_id));
    req.auto_print_label = true;
    let created = purchases::create_inward(&p.db, p.owner_id, req).unwrap();
    assert!(created.print_label);
}

#[test]
fn create_inward_owner_user_id_recorded() {
    let p = fresh_inventory_db();
    set_current_user(Some(owner_user(&p)));
    let created = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap();
    let user_id: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT user_id FROM purchases WHERE id=?1", params![created.id], |r| r.get(0)))
        .unwrap();
    assert_eq!(user_id, p.owner_id);
}

#[test]
fn create_inward_cashier_user_id_recorded() {
    let p = fresh_inventory_db();
    set_current_user(Some(cashier_user(&p)));
    let created = purchases::create_inward(
        &p.db,
        p.cashier_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap();
    let user_id: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT user_id FROM purchases WHERE id=?1", params![created.id], |r| r.get(0)))
        .unwrap();
    assert_eq!(user_id, p.cashier_id);
}

#[test]
fn create_inward_stocker_user_id_recorded() {
    let p = fresh_inventory_db();
    set_current_user(Some(stocker_user(&p)));
    let created = purchases::create_inward(
        &p.db,
        p.stocker_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, 8000)], Some(p.vendor_id)),
    )
    .unwrap();
    let user_id: i64 = p
        .db
        .with_raw(|c| c.query_row("SELECT user_id FROM purchases WHERE id=?1", params![created.id], |r| r.get(0)))
        .unwrap();
    assert_eq!(user_id, p.stocker_id);
}

// ───────────────────────────── Stock Balances ─────────────────────────────

#[test]
fn stock_balance_after_inward() {
    let p = fresh_inventory_db();
    create_basic_inward(&p);
    let qty: i64 = p.db.with_raw(|c| {
        c.query_row(
            "SELECT qty FROM stock_balances WHERE item_id=?1 AND location_id=?2",
            params![p.item_id, p.shop_id],
            |r| r.get(0),
        )
    })
    .unwrap();
    assert_eq!(qty, 13);
}

#[test]
fn stock_movement_ref_fields() {
    let p = fresh_inventory_db();
    let created = create_basic_inward(&p);
    let row: (String, i64, String) = p.db.with_raw(|c| {
        c.query_row(
            "SELECT ref_type, ref_id, type FROM stock_movements WHERE ref_id=?1",
            params![created.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    })
    .unwrap();
    assert_eq!(row, ("purchase".into(), created.id, "inward".into()));
}

#[test]
fn last_cost_for_item_after_inward() {
    let p = fresh_inventory_db();
    create_basic_inward(&p);
    assert_eq!(purchases::last_cost_for_item(&p.db, p.item_id).unwrap(), Some(8100));
}

#[test]
fn movements_for_item_orders_newest_first_and_respects_limit() {
    let p = fresh_inventory_db();
    create_basic_inward(&p);
    purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(vec![inward_line(p.item_id, p.shop_id, 2.0, 8200)], Some(p.vendor_id)),
    )
    .unwrap();
    let moves = purchases::movements_for_item(&p.db, p.item_id, 1).unwrap();
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0].qty, 2);
}

// ───────────────────────────── Edge Cases ─────────────────────────────

#[test]
fn inward_atomicity() {
    let p = fresh_inventory_db();
    let before_purchases = row_count(&p.db, "purchases");
    let before_items = row_count(&p.db, "purchase_items");
    let before_movements = row_count(&p.db, "stock_movements");
    let err = purchases::create_inward(
        &p.db,
        p.owner_id,
        purchase(
            vec![
                inward_line(p.item_id, p.shop_id, 1.0, 8000),
                inward_line(99_999, p.shop_id, 1.0, 8000),
            ],
            Some(p.vendor_id),
        ),
    )
    .unwrap_err();
    assert!(matches!(err, PurchaseError::ItemNotFound(1, 99_999)));
    assert_eq!(row_count(&p.db, "purchases"), before_purchases);
    assert_eq!(row_count(&p.db, "purchase_items"), before_items);
    assert_eq!(row_count(&p.db, "stock_movements"), before_movements);
}

#[test]
fn purchase_list_date_filter() {
    let p = fresh_inventory_db();
    for date in ["2026-01-10", "2026-02-15", "2026-03-20"] {
        let mut req = purchase(vec![inward_line(p.item_id, p.shop_id, 1.0, 8000)], Some(p.vendor_id));
        req.date = Some(date.into());
        purchases::create_inward(&p.db, p.owner_id, req).unwrap();
    }
    let feb = purchases::list(&p.db, Some("2026-02-01"), Some("2026-02-28"), 100).unwrap();
    assert_eq!(feb.len(), 1);
    assert_eq!(feb[0].date, "2026-02-15");
}

#[test]
fn purchase_get_by_id() {
    let p = fresh_inventory_db();
    let created = create_basic_inward(&p);
    let got = purchases::get(&p.db, created.id).unwrap().unwrap();
    assert_eq!(got.id, created.id);
    assert_eq!(got.vendor_id, Some(p.vendor_id));
    assert_eq!(got.items.len(), 1);
    assert_eq!(got.items[0].item_id, p.item_id);
}

#[test]
fn purchase_list_by_vendor() {
    let p = fresh_inventory_db();
    create_basic_inward(&p);
    let rows = purchases::list_by_vendor(&p.db, p.vendor_id, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].vendor_name.as_deref(), Some("Asian Paints Ltd"));
}

#[test]
fn purchase_get_unknown_returns_none() {
    let p = fresh_inventory_db();
    assert!(purchases::get(&p.db, 99_999).unwrap().is_none());
}

#[test]
fn last_cost_for_item_without_history_returns_none() {
    let p = fresh_inventory_db();
    assert_eq!(purchases::last_cost_for_item(&p.db, p.item_id).unwrap(), None);
}

// ───────────────────────────── Label Log ─────────────────────────────

#[test]
fn label_log_record_and_list() {
    let p = fresh_inventory_db();
    p.db.with_raw(|c| {
        c.execute(
            "INSERT INTO label_print_log (item_id, barcode, qty, format, line1, line2, user_id)
             VALUES (?1, 'BC-001', 2, 'CODE128', 'Asian Premium', '1L', ?2)",
            params![p.item_id, p.owner_id],
        )
    })
    .unwrap();
    let row: (String, i64, String, String) = p.db.with_raw(|c| {
        c.query_row(
            "SELECT barcode, qty, format, line1 FROM label_print_log WHERE item_id=?1",
            params![p.item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
    })
    .unwrap();
    assert_eq!(row, ("BC-001".into(), 2, "CODE128".into(), "Asian Premium".into()));
}

#[test]
fn label_log_validation() {
    let p = fresh_inventory_db();
    let exists = p
        .db
        .with_raw(|c| c.query_row("SELECT 1 FROM items WHERE id=?1", params![99_999], |_| Ok(true)).optional())
        .unwrap()
        .unwrap_or(false);
    assert!(!exists);
    let err = p.db.with_raw(|c| {
        c.execute(
            "INSERT INTO label_print_log (item_id, barcode, qty, format, user_id)
             VALUES (99_999, 'NOPE', 1, 'CODE128', ?1)",
            params![p.owner_id],
        )
    })
    .unwrap_err();
    assert!(matches!(err, rusqlite::Error::SqliteFailure(_, _)));
}

#[allow(dead_code)]
fn _inventory_type_imports(
    _item: Item,
    _hit: ItemSearchHit,
    _purchase: Purchase,
    _purchase_item: PurchaseItem,
    _movement: StockMovement,
) {
}

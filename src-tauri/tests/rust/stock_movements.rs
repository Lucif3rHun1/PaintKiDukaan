//! Integration tests for `commands::_stock_movements::insert_stock_movement`.
//!
//! Locks the shape of every row the helper writes — column order, kind_id
//! lookup, sale_unit_id fallback, and the FK / CHECK errors — so the 10
//! production call sites that migrated onto this helper can never silently
//! drop a column or pass a wrong enumerator (the bug class that audit-3 A5
//! flagged at `sales.rs:629`).
//!
//! Tests run against a real SQLCipher database with the production
//! `schema_final` applied — see `common.rs` for the shared fixture.

mod common;

use common::*;
use paintkiduakan_lib::commands::_stock_movements::{insert_stock_movement, StockMovementKind};
use paintkiduakan_lib::db::Db;

#[derive(Debug)]
struct MovementRow {
    item_id: i64,
    location_id: i64,
    qty: f64,
    kind_id: i64,
    sale_unit_id: i64,
    ref_kind: Option<String>,
    ref_id: Option<i64>,
    note: Option<String>,
    created_at: i64,
    created_by: i64,
}

fn read_movement(db: &Db, id: i64) -> MovementRow {
    db.with_raw(|c| {
        c.query_row(
            "SELECT item_id, location_id, qty, kind_id, sale_unit_id, \
                    ref_kind, ref_id, note, created_at, created_by \
             FROM stock_movements WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok(MovementRow {
                    item_id: r.get(0)?,
                    location_id: r.get(1)?,
                    qty: r.get(2)?,
                    kind_id: r.get(3)?,
                    sale_unit_id: r.get(4)?,
                    ref_kind: r.get(5)?,
                    ref_id: r.get::<_, Option<i64>>(6)?,
                    note: r.get::<_, Option<String>>(7)?,
                    created_at: r.get(8)?,
                    created_by: r.get(9)?,
                })
            },
        )
        .expect("row written by helper")
    })
}

fn kind_id_for(db: &Db, code: &str) -> i64 {
    db.with_raw(|c| {
        c.query_row(
            "SELECT id FROM stock_movement_kinds WHERE code = ?1",
            rusqlite::params![code],
            |r| r.get(0),
        )
        .expect("kind code missing — schema seed issue")
    })
}

fn assert_stock_balance(db: &Db, item_id: i64, location_id: i64, expected_qty: f64, last_movement_id: i64) {
    let qty: f64 = db.with_raw(|c| {
        c.query_row(
            "SELECT COALESCE(qty, 0) FROM stock_balances \
             WHERE item_id = ?1 AND location_id = ?2",
            rusqlite::params![item_id, location_id],
            |r| r.get(0),
        )
        .unwrap_or(0.0)
    });
    assert_eq!(qty, expected_qty, "stock_balances.qty drift");
    let lmid: i64 = db.with_raw(|c| {
        c.query_row(
            "SELECT last_movement_id FROM stock_balances \
             WHERE item_id = ?1 AND location_id = ?2",
            rusqlite::params![item_id, location_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    });
    assert_eq!(lmid, last_movement_id);
}

#[test]
fn sale_movement_writes_complete_row() {
    let fx = setup();
    let now = 1_700_000_000_000_i64;
    let id = fx
        .db
        .with_tx(|tx| {
            insert_stock_movement(
                tx,
                ITEM_RED_ID,
                LOCATION_ID,
                -3.0,
                StockMovementKind::Sale,
                Some(42),
                None,
                now,
                CASHIER_ID,
            )
        })
        .expect("sale insert should succeed");

    let row = read_movement(&fx.db, id);
    assert_eq!(row.item_id, ITEM_RED_ID);
    assert_eq!(row.location_id, LOCATION_ID);
    assert_eq!(row.qty, -3.0);
    assert_eq!(row.kind_id, kind_id_for(&fx.db, "sale"));
    assert_eq!(row.ref_kind.as_deref(), Some("sale"));
    assert_eq!(row.ref_id, Some(42));
    assert_eq!(row.note, None);
    assert_eq!(row.created_at, now);
    assert_eq!(row.created_by, CASHIER_ID);
    assert_stock_balance(&fx.db, ITEM_RED_ID, LOCATION_ID, PRELOADED_STOCK - 3.0, id);
}

#[test]
fn purchase_movement_writes_complete_row() {
    let fx = setup();
    let now = 1_700_000_001_000_i64;
    let id = fx
        .db
        .with_tx(|tx| {
            insert_stock_movement(
                tx,
                ITEM_BLUE_ID,
                LOCATION_ID,
                5.0,
                StockMovementKind::Purchase,
                Some(7),
                Some("opening stock"),
                now,
                OWNER_ID,
            )
        })
        .expect("purchase insert should succeed");

    let row = read_movement(&fx.db, id);
    assert_eq!(row.qty, 5.0);
    assert_eq!(row.kind_id, kind_id_for(&fx.db, "purchase"));
    assert_eq!(row.ref_kind.as_deref(), Some("purchase"));
    assert_eq!(row.ref_id, Some(7));
    assert_eq!(row.note.as_deref(), Some("opening stock"));
    assert_eq!(row.created_by, OWNER_ID);
}

#[test]
fn return_movement_writes_complete_row() {
    let fx = setup();
    let now = 1_700_000_002_000_i64;
    let id = fx
        .db
        .with_tx(|tx| {
            insert_stock_movement(
                tx,
                ITEM_RED_ID,
                LOCATION_ID,
                1.0,
                StockMovementKind::Return,
                Some(99),
                None,
                now,
                CASHIER_ID,
            )
        })
        .expect("return insert should succeed");

    let row = read_movement(&fx.db, id);
    assert_eq!(row.qty, 1.0);
    assert_eq!(row.kind_id, kind_id_for(&fx.db, "return"));
    assert_eq!(row.ref_kind.as_deref(), Some("return"));
    assert_eq!(row.ref_id, Some(99));
}

#[test]
fn adjustment_movement_writes_complete_row() {
    let fx = setup();
    let now = 1_700_000_003_000_i64;
    let id = fx
        .db
        .with_tx(|tx| {
            insert_stock_movement(
                tx,
                ITEM_RED_ID,
                LOCATION_ID,
                -2.5,
                StockMovementKind::Adjustment,
                None,
                Some("manual recount"),
                now,
                OWNER_ID,
            )
        })
        .expect("adjustment insert should succeed");

    let row = read_movement(&fx.db, id);
    assert_eq!(row.qty, -2.5);
    assert_eq!(row.kind_id, kind_id_for(&fx.db, "adjustment"));
    assert_eq!(row.ref_kind.as_deref(), Some("adjustment"));
    assert_eq!(row.ref_id, None, "adjustments never carry a domain ref_id");
    assert_eq!(row.note.as_deref(), Some("manual recount"));
}

#[test]
fn sale_unit_id_falls_back_to_pcs_when_item_has_no_sell_unit_id() {
    let fx = setup();
    let expected: i64 = fx.db.with_raw(|c| {
        c.query_row(
            "SELECT id FROM sale_units WHERE code = 'pcs'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    let id = fx
        .db
        .with_tx(|tx| {
            insert_stock_movement(
                tx,
                ITEM_RED_ID,
                LOCATION_ID,
                -1.0,
                StockMovementKind::Sale,
                Some(1),
                None,
                0,
                OWNER_ID,
            )
        })
        .unwrap();
    let row = read_movement(&fx.db, id);
    assert_eq!(row.sale_unit_id, expected);
}

#[test]
fn sale_with_nonexistent_item_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            999_999,
            LOCATION_ID,
            -1.0,
            StockMovementKind::Sale,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn purchase_with_nonexistent_item_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            999_999,
            LOCATION_ID,
            1.0,
            StockMovementKind::Purchase,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn return_with_nonexistent_item_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            999_999,
            LOCATION_ID,
            1.0,
            StockMovementKind::Return,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn adjustment_with_nonexistent_item_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            999_999,
            LOCATION_ID,
            1.0,
            StockMovementKind::Adjustment,
            None,
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn sale_with_zero_qty_rejected_by_check_constraint() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            LOCATION_ID,
            0.0,
            StockMovementKind::Sale,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "CHECK(qty <> 0) must reject zero qty");
}

#[test]
fn purchase_with_zero_qty_rejected_by_check_constraint() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            LOCATION_ID,
            0.0,
            StockMovementKind::Purchase,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "CHECK(qty <> 0) must reject zero qty");
}

#[test]
fn return_with_zero_qty_rejected_by_check_constraint() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            LOCATION_ID,
            0.0,
            StockMovementKind::Return,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "CHECK(qty <> 0) must reject zero qty");
}

#[test]
fn adjustment_with_zero_qty_rejected_by_check_constraint() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            LOCATION_ID,
            0.0,
            StockMovementKind::Adjustment,
            None,
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "CHECK(qty <> 0) must reject zero qty");
}

#[test]
fn sale_with_nonexistent_location_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            999_999,
            -1.0,
            StockMovementKind::Sale,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn purchase_with_nonexistent_location_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            999_999,
            1.0,
            StockMovementKind::Purchase,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn return_with_nonexistent_location_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            999_999,
            1.0,
            StockMovementKind::Return,
            Some(1),
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn adjustment_with_nonexistent_location_rejected_by_fk() {
    let fx = setup();
    let res = fx.db.with_tx(|tx| {
        insert_stock_movement(
            tx,
            ITEM_RED_ID,
            999_999,
            1.0,
            StockMovementKind::Adjustment,
            None,
            None,
            0,
            OWNER_ID,
        )
    });
    assert!(res.is_err(), "FK violation should bubble up");
}

#[test]
fn every_kind_code_matches_a_stock_movement_kinds_row() {
    let fx = setup();
    for kind in [
        StockMovementKind::Sale,
        StockMovementKind::Purchase,
        StockMovementKind::Return,
        StockMovementKind::Adjustment,
    ] {
        let code = kind.code();
        let count: i64 = fx.db.with_raw(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stock_movement_kinds WHERE code = ?1",
                rusqlite::params![code],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(count, 1, "stock_movement_kinds has no row for code = {code}");
    }
}

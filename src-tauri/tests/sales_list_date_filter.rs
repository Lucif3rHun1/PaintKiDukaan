//! Regression test for sales list date-range filter.
//!
//! Bug: `commands::sales::list` compared the `sales.date` column (TEXT in
//! `YYYY-MM-DD` format) against epoch-millisecond integers built from
//! `date_to_ms()`. SQLite type affinity puts INTEGER above TEXT, so
//! `WHERE date >= 1782230400000` matched zero rows even when `date`
//! held `"2026-07-01"`. The Sales tab showed "No sales yet" for the
//! default Last-7-Days filter despite saved bills existing.
//!
//! These tests pin the contract: a sale dated within the supplied range
//! must be returned by `sales::list`.

use paintkiduakan_lib::commands::sales;
use paintkiduakan_lib::db::Db;

fn open_db() -> Db {
    Db::open_in_memory().expect("open_in_memory failed")
}

fn insert_owner(db: &Db) -> i64 {
    db.with_conn(|c| -> Result<i64, rusqlite::Error> {
        c.execute(
            "INSERT INTO users
                 (name, role, pin_salt, pin_verifier, pin_length,
                  created_at, updated_at)
             VALUES ('owner', 'owner', X'00', X'00', 6, 0, 0)",
            [],
        )?;
        Ok(c.last_insert_rowid())
    })
    .expect("insert owner")
}

fn insert_sale(db: &Db, user_id: i64, no: &str, date: &str, status: &str) -> i64 {
    db.with_conn(|c| -> Result<i64, rusqlite::Error> {
        c.execute(
            "INSERT INTO sales
                 (no, date, status, user_id, payment_modes_json)
             VALUES (?1, ?2, ?3, ?4, '[]')",
            rusqlite::params![no, date, status, user_id],
        )?;
        Ok(c.last_insert_rowid())
    })
    .expect("insert sale")
}

#[test]
fn list_returns_sale_within_date_range() {
    let db = open_db();
    let user_id = insert_owner(&db);
    insert_sale(&db, user_id, "INV/01-07-2026/001", "2026-07-01", "final");

    let rows = sales::list(&db, None, Some("2026-06-25"), Some("2026-07-01"), 100)
        .expect("list sales");

    assert_eq!(
        rows.len(),
        1,
        "sale dated 2026-07-01 must be returned for range [2026-06-25, 2026-07-01]; got {} rows",
        rows.len()
    );
    assert_eq!(rows[0].no, "INV/01-07-2026/001");
}

#[test]
fn list_excludes_sale_outside_date_range() {
    let db = open_db();
    let user_id = insert_owner(&db);
    insert_sale(&db, user_id, "INV/01-06-2026/001", "2026-06-01", "final");
    insert_sale(&db, user_id, "INV/01-08-2026/001", "2026-08-01", "final");

    let rows = sales::list(&db, None, Some("2026-07-01"), Some("2026-07-31"), 100)
        .expect("list sales");

    assert_eq!(
        rows.len(),
        0,
        "no sales in July; got {} rows: {:?}",
        rows.len(),
        rows.iter().map(|s| &s.no).collect::<Vec<_>>()
    );
}

#[test]
fn list_with_no_date_filter_returns_all() {
    let db = open_db();
    let user_id = insert_owner(&db);
    insert_sale(&db, user_id, "INV/01-06-2026/001", "2026-06-01", "final");
    insert_sale(&db, user_id, "INV/01-07-2026/001", "2026-07-01", "final");
    insert_sale(&db, user_id, "INV/01-08-2026/001", "2026-08-01", "final");

    let rows = sales::list(&db, None, None, None, 100).expect("list sales");

    assert_eq!(
        rows.len(),
        3,
        "all three sales must be returned when no date filter; got {}",
        rows.len()
    );
}

#[test]
fn list_returns_sale_on_to_date_boundary() {
    // to_date is inclusive — a sale dated exactly on `to_date` must come back.
    let db = open_db();
    let user_id = insert_owner(&db);
    insert_sale(&db, user_id, "INV/01-07-2026/001", "2026-07-01", "final");

    let rows = sales::list(&db, None, Some("2026-07-01"), Some("2026-07-01"), 100)
        .expect("list sales");

    assert_eq!(
        rows.len(),
        1,
        "to_date must be inclusive; sale dated 2026-07-01 must match range ending 2026-07-01"
    );
}

#[test]
fn list_includes_quotations_and_fbills() {
    // The Sales tab should show every kind — not just `final`.
    let db = open_db();
    let user_id = insert_owner(&db);
    insert_sale(&db, user_id, "INV/01-07-2026/001", "2026-07-01", "final");
    insert_sale(&db, user_id, "FBL/01-07-2026/001", "2026-07-01", "fbill");
    insert_sale(&db, user_id, "QTN/01-07-2026/001", "2026-07-01", "quotation");

    let rows = sales::list(&db, None, Some("2026-07-01"), Some("2026-07-01"), 100)
        .expect("list sales");

    assert_eq!(
        rows.len(),
        3,
        "final + fbill + quotation on the same day must all show; got {}",
        rows.len()
    );
}
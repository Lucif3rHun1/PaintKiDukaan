//! Regression: cmd_list_sale_returns_paged + sibling SELECTs in commands::sales
//! must not raise AppError::Db on rows where sale_returns.date IS NULL. The
//! previous SELECT used COALESCE(sr.date, sr.created_at), which yields INTEGER
//! when date is NULL; the mapper called r.get::<_, String>(3)? on that
//! column and rusqlite rejected it with InvalidColumnType. The AppError::Db
//! path then surfaced the user-facing
//! "Something went wrong with the local database." toast. Same problem for
//! sr.created_at (INTEGER) being read as String.
//!
//! Two scenarios cover it:
//!   1. The exact SELECT + mapper as used by the production code, against
//!      a mix of NULL-date and non-NULL-date rows.
//!   2. End-to-end through list_returns and get_return, which run the same
//!      SELECT and the same SaleReturnHeader mapper as the failing
//!      cmd_list_sale_returns_paged command.

use paintkiduakan_lib::commands::sales as sales_mod;
use paintkiduakan_lib::db::Db;

fn seed_minimum(db: &Db) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
             VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO locations (name, is_active, created_at, updated_at) VALUES ('Main', 1, 0, 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO customers (name, phone, opening_balance_paise, created_at, updated_at) \
             VALUES ('Cust', '999', 0, 0, 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO sales (id, no, status, date, subtotal, bill_discount, total, paid_amount, customer_id, user_id) \
             VALUES (1, 'INV-1', 'final', '2025-01-01', 100, 0, 100, 100, 1, 1)",
            [],
        )
        .unwrap();
    });
}

fn seed_return_with_date(db: &Db, id: i64, date: Option<&str>, created_at: i64) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO sale_returns (id, sale_id, refund_total_paise, reason, no, date, created_at, created_by) \
             VALUES (?1, 1, 100, NULL, 'R-1', ?2, ?3, 1)",
            rusqlite::params![id, date, created_at],
        )
        .unwrap();
    });
}

#[test]
fn raw_select_handles_null_date_row() {
    let db = Db::open_in_memory().unwrap();
    seed_minimum(&db);
    seed_return_with_date(&db, 1, None, 1_700_000_000_000);
    seed_return_with_date(&db, 2, Some("2025-06-01"), 1_730_000_000_000);

    db.with_raw(|c| {
        let mut stmt = c
            .prepare(
                "SELECT sr.id, COALESCE(sr.no, ''), sr.sale_id, \
                        COALESCE(sr.date, CAST(sr.created_at AS TEXT)) AS date, \
                        sr.reason, sr.refund_total_paise, \
                        CAST(sr.created_at AS TEXT) AS created_at, sr.created_by \
                 FROM sale_returns sr \
                 JOIN sales s ON s.id = sr.sale_id \
                 ORDER BY sr.id",
            )
            .unwrap();

        let rows: Vec<(i64, String, i64, String, Option<String>, i64, String, i64)> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(rows.len(), 2);
    });
}

#[test]
fn list_and_get_return_handles_null_date_row() {
    let db = Db::open_in_memory().unwrap();
    seed_minimum(&db);
    seed_return_with_date(&db, 1, None, 1_700_000_000_000);
    seed_return_with_date(&db, 2, Some("2025-06-01"), 1_730_000_000_000);

    let returns = sales_mod::list_returns(&db, None, None, None, 50)
        .expect("list_returns must succeed for NULL-date rows");
    assert_eq!(returns.len(), 2);

    let one = sales_mod::get_return(&db, 1)
        .expect("get_return must succeed for NULL-date row");
    assert!(one.is_some());
}

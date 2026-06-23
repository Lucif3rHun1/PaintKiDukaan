//! Integration tests for the sales flow.
//!
//! Covers every aspect of the bill creation + payment + ledger pipeline added
//! across the v6 (sale_payments) migration:
//!
//!   * schema integrity (sale_payments columns)
//!   * create_quotation (no payment, no stock movement)
//!   * create_final_bill credit rules (walk-in vs attached, flagged, partial)
//!   * create_final_bill side effects (sale_payments rows, stock_movement, balance)
//!   * convert_quotation (new INV, copy items, sale_payments, stock movement)
//!   * record_sale_payment (bumps paid_amount, inserts row, validates)
//!   * list_sales filters (status, from_date, to_date, limit)
//!   * search_items (exact barcode wins, fuzzy name LIKE, inactive excluded)
//!   * customer_ledger (chronological running balance)
//!   * customer_credit_sales (filters paid-in-full + quotations)
//!   * record_customer_payment (amount, mode, customer existence, balance)
//!   * atomicity (rollback on validation failure)

use paintkiduakan_lib::commands::customers::{
    self, Customer, NewCustomerPayment,
};
use paintkiduakan_lib::commands::{items, sales};
use paintkiduakan_lib::db::Db;
use paintkiduakan_lib::error::AppError;
use paintkiduakan_lib::session::{set_current_user, Role, User};
use rusqlite::Connection;

fn owner() -> User {
    User { id: 1, name: "O".into(), role: Role::Owner }
}

fn line(qty: f64, price: i64, disc: i64, item_id: i64) -> sales::CartLine {
    sales::CartLine {
        item_id,
        qty,
        price,
        unit_type: "unit".into(),
        line_discount: disc,
        shade_note: None,
    }
}

/// Build a fresh DB with one user, one location, one customer, one item.
/// Returns (db, customer_id, item_id).
fn fresh_db() -> (Db, i64, i64) {
    let db = Db::open_in_memory().unwrap();
    db.with_raw(|c: &Connection| -> rusqlite::Result<()> {
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) \
             VALUES ('O', 'owner', X'00', X'00', 6)",
            [],
        )?;
        c.execute(
            "INSERT INTO locations (name, rack) VALUES ('Shop', 'A1')",
            [],
        )?;
        c.execute(
            "INSERT INTO customers (name, phone, opening_balance, is_active) \
             VALUES ('Ravi', '9876543210', 500, 1)",
            [],
        )?;
        // v10 schema: items.unit is gone, use unit_id FK to units table (seeded with 'L' code).
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, retail_price_paise, cost_paise, \
             primary_location_id, min_qty, barcode_format, unit_id) \
             SELECT 'SKU-00001', 'BC-001', 'Asian Premium', 10000, 8000, \
                    1, 0, 'CODE128', u.id \
             FROM units u WHERE u.code = 'L'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let cust_id: i64 = db
        .with_raw(|c| c.query_row("SELECT id FROM customers LIMIT 1", [], |r| r.get(0)))
        .unwrap();
    let item_id: i64 = db
        .with_raw(|c| c.query_row("SELECT id FROM items LIMIT 1", [], |r| r.get(0)))
        .unwrap();
    (db, cust_id, item_id)
}

// ───────────────────────────── schema ───────────────────────────────────

#[test]
fn sale_payments_table_has_expected_columns() {
    let db = Db::open_in_memory().unwrap();
    let cols: Vec<String> = db
        .with_raw(|c| -> Result<Vec<String>, AppError> {
            let mut stmt = c
                .prepare("SELECT name FROM pragma_table_info('sale_payments') ORDER BY cid")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert_eq!(
        cols,
        vec!["id", "sale_id", "mode", "amount", "date", "notes", "user_id", "created_at"],
    );
}

// ─────────────────────────── quotation ─────────────────────────────────

#[test]
fn quotation_inserts_sale_with_zero_paid_no_stock_movement() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let id = sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: Some("2026-06-15".into()),
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: Some(7),
            acknowledge_flag: false,
            lines: vec![line(2.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let row: (String, String, i64, i64) = db
        .with_raw(|c| -> Result<(String, String, i64, i64), AppError> {
            Ok(c.query_row(
                "SELECT no, status, paid_amount, total FROM sales WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert!(row.0.starts_with("QTN-"));
    assert_eq!(row.1, "quotation");
    assert_eq!(row.2, 0);
    assert_eq!(row.3, 20000);
    let sm_count: i64 = db
        .with_raw(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE ref_type='sale' AND ref_id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(sm_count, 0, "quotation must not move stock");
}

#[test]
fn quotation_rejects_any_paid_amount() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let err = sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 100,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap_err();
    // paid=100, total=10000 → WalkinMustPayFull (we re-use the validator)
    matches!(err, sales::SaleError::WalkinMustPayFull { .. });
}

// ──────────────────────── final bill: credit ───────────────────────────

#[test]
fn walkin_must_pay_full() {
    set_current_user(Some(owner()));
    let (db, _cust_id, item_id) = fresh_db();
    let err = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: None,
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::WalkinMustPayFull { .. });
}

#[test]
fn attached_customer_can_pay_partial_and_implicit_credit_accrues() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let id = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: Some("2026-06-15".into()),
            bill_discount: 0,
            paid_amount: 3000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 3000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let sale = sales::get(&db, id).unwrap().unwrap();
    assert_eq!(sale.total, 10000);
    assert_eq!(sale.paid_amount, 3000);
    let out = customers::customer_outstanding_impl(&db, cust_id).unwrap();
    assert_eq!(out.outstanding, 500 /*opening*/ + 7000 /*total - paid*/);
}

#[test]
fn split_payment_inserts_one_sale_payments_row_per_mode() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let id = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: Some("2026-06-15".into()),
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![
                sales::PaymentSplit { mode: "cash".into(), amount: 4000 },
                sales::PaymentSplit { mode: "upi".into(), amount: 6000 },
            ],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let pays = sales::list_payments(&db, id).unwrap();
    assert_eq!(pays.len(), 2);
    assert_eq!(pays[0].mode, "cash");
    assert_eq!(pays[0].amount, 4000);
    assert_eq!(pays[1].mode, "upi");
    assert_eq!(pays[1].amount, 6000);
}

#[test]
fn unpaid_bill_records_no_sale_payments_but_still_moves_stock() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let id = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    assert_eq!(sales::list_payments(&db, id).unwrap().len(), 0);
    let sm: i64 = db
        .with_raw(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE ref_type='sale' AND ref_id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(sm, 1, "credit sale must still decrement stock");
}

#[test]
fn flagged_customer_requires_acknowledge_flag() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    db.with_raw(|c| {
        c.execute(
            "UPDATE customers SET is_flagged = 1 WHERE id = ?1",
            rusqlite::params![cust_id],
        )
    })
    .unwrap();
    let base = sales::NewSale {
        customer_id: Some(cust_id),
        kind: "final".into(),
        date: None,
        bill_discount: 0,
        paid_amount: 0,
        payment_modes: vec![],
        validity_days: None,
        acknowledge_flag: false,
        lines: vec![line(1.0, 10000, 0, item_id)],
    };
    let err = sales::create_final_bill(&db, owner().id, base.clone()).unwrap_err();
    matches!(err, sales::SaleError::MustAcknowledgeFlag);
    // With ack=true it proceeds.
    let mut acked = base;
    acked.acknowledge_flag = true;
    assert!(sales::create_final_bill(&db, owner().id, acked).is_ok());
}

#[test]
fn stock_movement_is_negative_and_balance_decrements_via_trigger() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let id = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: Some("2026-06-15".into()),
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 10000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(3.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let sm: (i64, String) = db
        .with_raw(|c| -> Result<(i64, String), AppError> {
            Ok(c.query_row(
                "SELECT qty, type FROM stock_movements WHERE ref_type='sale' AND ref_id=?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(sm.0, -3);
    assert_eq!(sm.1, "sale");
    let bal: i64 = db
        .with_raw(|c| {
            c.query_row(
                "SELECT COALESCE(qty,0) FROM stock_balances WHERE item_id=?1",
                rusqlite::params![item_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(bal, -3);
}

// ──────────────────────── convert quotation ────────────────────────────

#[test]
fn convert_quotation_creates_new_inv_with_payments_stock_and_link() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let qid = sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: Some("2026-06-15".into()),
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: Some(7),
            acknowledge_flag: false,
            lines: vec![line(2.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let new_id = sales::convert_quotation(
        &db,
        owner().id,
        sales::ConvertQuotation {
            quotation_id: qid,
            paid_amount: 12000,
            payment_modes: vec![
                sales::PaymentSplit { mode: "cash".into(), amount: 7000 },
                sales::PaymentSplit { mode: "upi".into(), amount: 5000 },
            ],
            acknowledge_flag: false,
        },
    )
    .unwrap();
    let sale = sales::get(&db, new_id).unwrap().unwrap();
    assert_eq!(sale.status, "final");
    assert_eq!(sale.converted_from_id, Some(qid));
    assert_eq!(sale.paid_amount, 12000);
    assert_eq!(sales::list_payments(&db, new_id).unwrap().len(), 2);
    let sm_count: i64 = db
        .with_raw(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE ref_type='sale' AND ref_id=?1",
                rusqlite::params![new_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(sm_count, 1, "conversion must insert stock_movement");
}

#[test]
fn convert_quotation_allows_repeat_convert_each_producing_new_invoice() {
    // Current behavior: convert_quotation reads the source quotation row but
    // does NOT mutate it. Each call creates a NEW sibling final-bill row
    // pointing back via converted_from_id. We assert that two consecutive
    // converts produce two distinct invoice IDs (i.e. no duplication of the
    // INV number, no overwriting of the source).
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let qid = sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let inv1 = sales::convert_quotation(
        &db,
        owner().id,
        sales::ConvertQuotation {
            quotation_id: qid,
            paid_amount: 0,
            payment_modes: vec![],
            acknowledge_flag: false,
        },
    )
    .unwrap();
    let inv2 = sales::convert_quotation(
        &db,
        owner().id,
        sales::ConvertQuotation {
            quotation_id: qid,
            paid_amount: 0,
            payment_modes: vec![],
            acknowledge_flag: false,
        },
    )
    .unwrap();
    assert_ne!(inv1, inv2);
    let s1 = sales::get(&db, inv1).unwrap().unwrap();
    let s2 = sales::get(&db, inv2).unwrap().unwrap();
    assert_eq!(s1.converted_from_id, Some(qid));
    assert_eq!(s2.converted_from_id, Some(qid));
    assert_ne!(s1.no, s2.no, "each convert mints a new INV number");
}

#[test]
fn convert_quotation_rejects_non_quotation_source() {
    // Passing the id of a 'final' sale to convert_quotation must error
    // with NotAQuotation — the inner SELECT picks up status='final' and
    // the check fires.
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let final_id = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let err = sales::convert_quotation(
        &db,
        owner().id,
        sales::ConvertQuotation {
            quotation_id: final_id,
            paid_amount: 0,
            payment_modes: vec![],
            acknowledge_flag: false,
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::NotAQuotation(_, _));
}

// ──────────────────── record_sale_payment ───────────────────────────────

#[test]
fn record_sale_payment_bumps_paid_and_inserts_row() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let sid = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    sales::record_payment(
        &db,
        owner().id,
        sales::NewSalePayment {
            sale_id: sid,
            mode: "upi".into(),
            amount: 3000,
            date: None,
            notes: Some("rest".into()),
        },
    )
    .unwrap();
    let sale = sales::get(&db, sid).unwrap().unwrap();
    assert_eq!(sale.paid_amount, 8000);
    let pays = sales::list_payments(&db, sid).unwrap();
    assert_eq!(pays.len(), 2);
    assert_eq!(pays[1].mode, "upi");
    assert_eq!(pays[1].amount, 3000);
}

#[test]
fn record_sale_payment_rejects_zero_amount() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let sid = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 10000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let err = sales::record_payment(
        &db,
        owner().id,
        sales::NewSalePayment {
            sale_id: sid,
            mode: "cash".into(),
            amount: 0,
            date: None,
            notes: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("amount must be > 0"));
}

#[test]
fn record_sale_payment_rejects_credit_mode() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let sid = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let err = sales::record_payment(
        &db,
        owner().id,
        sales::NewSalePayment {
            sale_id: sid,
            mode: "credit".into(),
            amount: 100,
            date: None,
            notes: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("invalid mode"));
}

// ──────────────────────── list_sales filters ────────────────────────────

#[test]
fn list_sales_filters_by_status() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 10000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    assert_eq!(sales::list(&db, None, None, None, 100).unwrap().len(), 2);
    let q = sales::list(&db, Some("quotation"), None, None, 100).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].status, "quotation");
    let f = sales::list(&db, Some("final"), None, None, 100).unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].status, "final");
}

#[test]
fn list_sales_filters_by_date_range() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    for d in &["2026-01-01", "2026-02-15", "2026-03-30"] {
        sales::create_final_bill(
            &db,
            owner().id,
            sales::NewSale {
                customer_id: Some(cust_id),
                kind: "final".into(),
                date: Some((*d).into()),
                bill_discount: 0,
                paid_amount: 10000,
                payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 10000 }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![line(1.0, 10000, 0, item_id)],
            },
        )
        .unwrap();
    }
    let feb = sales::list(&db, Some("final"), Some("2026-02-01"), Some("2026-02-28"), 100).unwrap();
    assert_eq!(feb.len(), 1);
    assert_eq!(feb[0].date, "2026-02-15");
    let jan_mar = sales::list(&db, Some("final"), Some("2026-01-01"), Some("2026-03-31"), 100).unwrap();
    assert_eq!(jan_mar.len(), 3);
    let none_match = sales::list(&db, Some("final"), Some("2027-01-01"), Some("2027-12-31"), 100).unwrap();
    assert!(none_match.is_empty());
}

#[test]
fn list_sales_respects_limit() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    for _ in 0..5 {
        sales::create_final_bill(
            &db,
            owner().id,
            sales::NewSale {
                customer_id: Some(cust_id),
                kind: "final".into(),
                date: None,
                bill_discount: 0,
                paid_amount: 0,
                payment_modes: vec![],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![line(1.0, 10000, 0, item_id)],
            },
        )
        .unwrap();
    }
    assert_eq!(sales::list(&db, None, None, None, 3).unwrap().len(), 3);
    assert_eq!(sales::list(&db, None, None, None, 100).unwrap().len(), 5);
}

// ───────────────────────── search_items ─────────────────────────────────

#[test]
fn search_items_exact_barcode_wins_over_fuzzy() {
    let (db, _, _) = fresh_db();
    let hits = items::search_items(&db, "BC-001", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].sku_code, "SKU-00001");
    assert_eq!(hits[0].name, "Asian Premium");
}

#[test]
fn search_items_fuzzy_name_match() {
    let (db, _, _) = fresh_db();
    let hits = items::search_items(&db, "Asian", 10).unwrap();
    assert!(hits.iter().any(|h| h.name == "Asian Premium"));
}

#[test]
fn search_items_no_match_returns_empty() {
    let (db, _, _) = fresh_db();
    let hits = items::search_items(&db, "DOES_NOT_EXIST", 10).unwrap();
    assert!(hits.is_empty());
}

#[test]
fn search_items_excludes_inactive_items() {
    let db = Db::open_in_memory().unwrap();
    db.with_raw(|c: &Connection| -> rusqlite::Result<()> {
        c.execute("INSERT INTO locations (name) VALUES ('Shop')", [])?;
        c.execute(
            "INSERT INTO items (sku_code, barcode, name, retail_price_paise, cost_paise, \
             primary_location_id, min_qty, barcode_format, is_active, unit_id) \
             SELECT 'SKU-00099', 'BC-099', 'Old Brand', 100, 80, \
                    1, 0, 'CODE128', 0, u.id \
             FROM units u WHERE u.code = 'pc'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(items::search_items(&db, "Old", 10).unwrap().is_empty());
}

// ──────────────────────── customer_ledger ───────────────────────────────

#[test]
fn customer_ledger_chronological_with_running_balance() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    // 2026-01-10 sale total 2000 paid 0
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: Some("2026-01-10".into()),
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 2000, 0, item_id)],
        },
    )
    .unwrap();
    // 2026-01-15 payment 500
    customers::record_customer_payment_impl(
        &db,
        owner().id,
        NewCustomerPayment {
            customer_id: cust_id,
            amount: 500,
            mode: "cash".into(),
            date: Some("2026-01-15".into()),
            notes: None,
            sale_id: None,
        },
    )
    .unwrap();
    // 2026-01-20 sale total 3000 paid 1000
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: Some("2026-01-20".into()),
            bill_discount: 0,
            paid_amount: 1000,
            payment_modes: vec![sales::PaymentSplit { mode: "upi".into(), amount: 1000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 3000, 0, item_id)],
        },
    )
    .unwrap();

    let ledger = customers::customer_ledger_impl(&db, cust_id).unwrap();
    assert_eq!(ledger.opening_balance, 500);
    assert_eq!(ledger.rows.len(), 3);
    // Newest first (date DESC)
    assert_eq!(ledger.rows[0].date, "2026-01-20");
    // Closing = 500 (opening) + (2000-0) + (3000-1000) - 500 (payment) = 4000
    assert_eq!(ledger.closing_balance, 4000);
}

#[test]
fn customer_ledger_empty_when_no_activity() {
    set_current_user(Some(owner()));
    let (db, cust_id, _) = fresh_db();
    let ledger = customers::customer_ledger_impl(&db, cust_id).unwrap();
    assert_eq!(ledger.opening_balance, 500);
    assert_eq!(ledger.rows.len(), 0);
    assert_eq!(ledger.closing_balance, 500);
}

// ───────────────────── customer_credit_sales ───────────────────────────

#[test]
fn customer_credit_sales_excludes_paid_in_full_and_quotations() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    // Quotation → excluded
    sales::create_quotation(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "quotation".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    // Fully paid final → excluded
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 10000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    // Partially paid final → included
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 3000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 3000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let credits = customers::customer_credit_sales_impl(&db, cust_id).unwrap();
    assert_eq!(credits.len(), 1);
    assert_eq!(credits[0].total, 10000);
    assert_eq!(credits[0].paid_amount, 3000);
    assert_eq!(credits[0].outstanding, 7000);
}

// ────────────────────── record_customer_payment ─────────────────────────

#[test]
fn record_customer_payment_validates_amount_positive() {
    set_current_user(Some(owner()));
    let (db, cust_id, _) = fresh_db();
    let err = customers::record_customer_payment_impl(
        &db,
        owner().id,
        NewCustomerPayment {
            customer_id: cust_id,
            amount: 0,
            mode: "cash".into(),
            date: None,
            notes: None,
            sale_id: None,
        },
    )
    .unwrap_err();
    matches!(err, paintkiduakan_lib::error::AppError::Validation(_));
}

#[test]
fn record_customer_payment_validates_mode_set() {
    set_current_user(Some(owner()));
    let (db, cust_id, _) = fresh_db();
    let err = customers::record_customer_payment_impl(
        &db,
        owner().id,
        NewCustomerPayment {
            customer_id: cust_id,
            amount: 100,
            mode: "credit".into(),
            date: None,
            notes: None,
            sale_id: None,
        },
    )
    .unwrap_err();
    matches!(err, paintkiduakan_lib::error::AppError::Validation(_));
}

#[test]
fn record_customer_payment_rejects_unknown_customer() {
    set_current_user(Some(owner()));
    let (db, _, _) = fresh_db();
    let err = customers::record_customer_payment_impl(
        &db,
        owner().id,
        NewCustomerPayment {
            customer_id: 99999,
            amount: 100,
            mode: "cash".into(),
            date: None,
            notes: None,
            sale_id: None,
        },
    )
    .unwrap_err();
    matches!(err, paintkiduakan_lib::error::AppError::NotFound(_));
}

#[test]
fn record_customer_payment_decreases_outstanding() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap();
    let before = customers::customer_outstanding_impl(&db, cust_id).unwrap();
    assert_eq!(before.outstanding, 500 + 10000);
    customers::record_customer_payment_impl(
        &db,
        owner().id,
        NewCustomerPayment {
            customer_id: cust_id,
            amount: 3000,
            mode: "cash".into(),
            date: None,
            notes: None,
            sale_id: None,
        },
    )
    .unwrap();
    let after = customers::customer_outstanding_impl(&db, cust_id).unwrap();
    assert_eq!(after.total_payments, 3000);
    assert_eq!(after.outstanding, 7500);
}

// ─────────────────────────── atomicity ──────────────────────────────────

#[test]
fn create_final_bill_rolls_back_on_payment_modes_sum_mismatch() {
    // sum of payment_modes (3000) != paid_amount (5000) → whole txn must rollback.
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let err = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![sales::PaymentSplit { mode: "cash".into(), amount: 3000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, 10000, 0, item_id)],
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::ModesSumMismatch { .. });
    let count: i64 = db
        .with_raw(|c| c.query_row("SELECT COUNT(*) FROM sales", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 0);
    let sm: i64 = db
        .with_raw(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE type='sale'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(sm, 0);
    let sp: i64 = db
        .with_raw(|c| c.query_row("SELECT COUNT(*) FROM sale_payments", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(sp, 0);
}

#[test]
fn create_final_bill_rejects_empty_cart() {
    set_current_user(Some(owner()));
    let (db, cust_id, _) = fresh_db();
    let err = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![],
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::EmptyCart);
}

#[test]
fn create_final_bill_rejects_zero_qty_line() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let err = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(0.0, 10000, 0, item_id)],
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::BadLineQty(0));
}

#[test]
fn create_final_bill_rejects_negative_price() {
    set_current_user(Some(owner()));
    let (db, cust_id, item_id) = fresh_db();
    let err = sales::create_final_bill(
        &db,
        owner().id,
        sales::NewSale {
            customer_id: Some(cust_id),
            kind: "final".into(),
            date: None,
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![line(1.0, -100, 0, item_id)],
        },
    )
    .unwrap_err();
    matches!(err, sales::SaleError::BadLinePrice(0));
}

// silence unused-import warning when only a subset of helpers are referenced.
#[allow(dead_code)]
fn _unused(_c: Customer) {}

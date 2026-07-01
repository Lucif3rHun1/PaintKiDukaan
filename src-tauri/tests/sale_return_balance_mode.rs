//! Regression suite for: balance tender in returns + SaleItem.returned_qty
//! plus mixed cash/balance tender decomposition.

use paintkiduakan_lib::commands::sales as sales_mod;
use paintkiduakan_lib::db::Db;

fn seed_env(db: &Db) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
             VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)",
            [],
        ).unwrap();
        c.execute(
            "INSERT INTO items (sku_code, name, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
             VALUES ('SK001', 'Test Item', 'L', 'Liter', 100, 50, 0, 0)",
            [],
        ).unwrap();
        // create_sale_return (and create_sale on standalone path) require an
        // active location for stock_movements; without it they bail with
        // 'No active location' before our assertions run.
        c.execute(
            "INSERT INTO locations (name, is_active, created_at, updated_at) VALUES ('Main', 1, 0, 0)",
            [],
        ).unwrap();
    });
}

fn seed_customer(db: &Db, id: i64, phone: &str) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO customers (id, name, phone, opening_balance_paise, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 0, 0, 0)",
            rusqlite::params![id, format!("Customer {id}"), phone],
        ).unwrap();
    });
}

fn seed_final_sale(db: &Db, sale_id: i64, total: i64, paid: i64, customer_id: Option<i64>) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, customer_id, user_id) \
             VALUES (?1, 'final', '2025-01-01', 100, 0, ?2, ?3, ?4, 1)",
            rusqlite::params![format!("INV-X-{sale_id}"), total, paid, customer_id],
        ).unwrap();
        c.execute(
            "INSERT INTO sale_items (sale_id, item_id, qty, price, unit_type, line_discount, line_order) \
             VALUES (?1, 1, 10, 10, 'pcs', 0, 0)",
            rusqlite::params![sale_id],
        ).unwrap();
    });
}

#[test]
fn sale_return_balance_tender_does_not_decrement_paid_amount() {
    // Refund paid entirely via balance tender — sale.paid_amount must NOT change
    // because no cash flowed; the customer's outstanding balance is adjusted instead
    // via a separate customer_payments row (covered in the next test).
    let db = Db::open_in_memory().unwrap();
    seed_env(&db);
    seed_customer(&db, 10, "phone-paid-no-decrement");
    seed_final_sale(&db, 1, 1000, 1000, Some(10)); // fully paid

    let payload = sales_mod::CreateSaleReturnPayload {
        sale_id: 1,
        customer_id: Some(10),
        date: None,
        reason: Some("balance refund".into()),
        payment_modes: vec![sales_mod::PaymentSplit {
            mode: "balance".into(),
            amount: 300,
        }],
        owner_pin: String::new(),
        lines: vec![sales_mod::CreateSaleReturnLine {
            sale_item_id: 1,
            item_id: Some(1),
            qty: 3.0,
            refund_paise: 100,
            shade_note: None,
        }],
    };
    let _ = sales_mod::create_sale_return(&db, 1, payload).unwrap();

    let paid_after: i64 = db.with_raw(|c| {
        c.query_row(
            "SELECT paid_amount FROM sales WHERE id = 1",
            [],
            |r| r.get(0),
        ).unwrap()
    });
    assert_eq!(paid_after, 1000, "balance tender must not decrement paid_amount");
}

#[test]
fn sale_return_balance_tender_writes_customer_payments_row() {
    let db = Db::open_in_memory().unwrap();
    seed_env(&db);
    seed_customer(&db, 11, "phone-balance-writes");
    seed_final_sale(&db, 1, 1000, 1000, Some(11));

    let payload = sales_mod::CreateSaleReturnPayload {
        sale_id: 1,
        customer_id: Some(1),
        date: None,
        reason: Some("balance refund".into()),
        payment_modes: vec![sales_mod::PaymentSplit {
            mode: "balance".into(),
            amount: 300,
        }],
        owner_pin: String::new(),
        lines: vec![sales_mod::CreateSaleReturnLine {
            sale_item_id: 1,
            item_id: Some(1),
            qty: 3.0,
            refund_paise: 100,
            shade_note: None,
        }],
    };
    let _ = sales_mod::create_sale_return(&db, 1, payload).unwrap();

    let (cnt, sum): (i64, i64) = db.with_raw(|c| {
        let cnt: i64 = c.query_row(
            "SELECT COUNT(*) FROM customer_payments WHERE customer_id = 11 AND mode = 'balance'",
            [],
            |r| r.get(0),
        ).unwrap();
        let sum: i64 = c.query_row(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM customer_payments WHERE customer_id = 11 AND mode = 'balance'",
            [],
            |r| r.get(0),
        ).unwrap();
        (cnt, sum)
    });
    assert_eq!(cnt, 1, "exactly one customer_payments row written for the balance tender");
    assert_eq!(sum, 300, "balance tender amount must equal refund_total");
}

#[test]
fn sale_return_mixed_cash_and_balance_only_decrements_paid_by_cash_share() {
    let db = Db::open_in_memory().unwrap();
    seed_env(&db);
    seed_customer(&db, 12, "phone-mixed-cash-balance");
    seed_final_sale(&db, 1, 1000, 1000, Some(12)); // fully paid

    // Refund 300 (200 cash back, 100 balance). Sale.paid_amount should drop by 200 only.
    let payload = sales_mod::CreateSaleReturnPayload {
        sale_id: 1,
        customer_id: Some(1),
        date: None,
        reason: Some("split refund".into()),
        payment_modes: vec![
            sales_mod::PaymentSplit { mode: "cash".into(), amount: 200 },
            sales_mod::PaymentSplit { mode: "balance".into(), amount: 100 },
        ],
        owner_pin: String::new(),
        lines: vec![sales_mod::CreateSaleReturnLine {
            sale_item_id: 1,
            item_id: Some(1),
            qty: 3.0,
            refund_paise: 100,
            shade_note: None,
        }],
    };
    let _ = sales_mod::create_sale_return(&db, 1, payload).unwrap();

    let paid_after: i64 = db.with_raw(|c| {
        c.query_row("SELECT paid_amount FROM sales WHERE id = 1", [], |r| r.get(0)).unwrap()
    });
    assert_eq!(paid_after, 800, "paid_amount drops by the cash share only");

    let balance_total: i64 = db.with_raw(|c| {
        c.query_row(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM customer_payments WHERE customer_id = 12 AND mode = 'balance'",
            [],
            |r| r.get(0),
        ).unwrap()
    });
    assert_eq!(balance_total, 100);
}

#[test]
fn sale_item_returned_qty_reflects_aggregate_across_returns() {
    let db = Db::open_in_memory().unwrap();
    seed_env(&db);
    seed_final_sale(&db, 1, 1000, 1000, None);

    // No returns yet — returned_qty should be 0 for the item.
    let initial = sales_mod::get(&db, 1).unwrap().unwrap();
    assert_eq!(initial.items[0].returned_qty, 0.0);

    // Return 4 units.
    let payload = sales_mod::CreateSaleReturnPayload {
        sale_id: 1,
        customer_id: None,
        date: None,
        reason: None,
        payment_modes: vec![sales_mod::PaymentSplit {
            mode: "cash".into(),
            amount: 400,
        }],
        owner_pin: String::new(),
        lines: vec![sales_mod::CreateSaleReturnLine {
            sale_item_id: 1,
            item_id: Some(1),
            qty: 4.0,
            refund_paise: 100,
            shade_note: None,
        }],
    };
    sales_mod::create_sale_return(&db, 1, payload).unwrap();

    let after = sales_mod::get(&db, 1).unwrap().unwrap();
    assert_eq!(after.items[0].returned_qty, 4.0);
}

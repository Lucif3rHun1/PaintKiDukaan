//! Shared fixtures for the sales / day_close / purchases integration tests.
//!
//! Tests run against a real SQLCipher database (`Db::open_in_memory()`) with
//! the production `schema_final` applied — same path the binary uses at first
//! launch. No mocks of the DB, no mocks of the `Db` wrapper, no mocks of the
//! command bodies. Migrations 001–026 run exactly as in production.
//!
//! `setup()` returns a `Fixture` with:
//!   * one active owner user (id 1),
//!   * one active cashier user (id 2),
//!   * one active default location (id 1),
//!   * one customer (id 1) with zero opening balance,
//!   * one vendor (id 1) with zero opening balance,
//!   * two items (`Red`, `Blue`) each with 100 base units of stock
//!     pre-loaded via `purchases::create_inward`, and
//!   * a `paintkiduakan_lib::session::User` per role for command functions
//!     that take `&User` instead of `i64`.
//!
//! Test bodies call the underlying business functions the Tauri commands
//! delegate to (`sales::create_final_bill`, `day_close::trigger_day_close`,
//! `purchases::create_inward`, `customer_ledger::record_customer_payment_impl`,
//! `vendors::record_vendor_payment`). This exercises the same write path the
//! Tauri command body runs without standing up a Tauri runtime. See
//! `.omo/notepads/integration-tests/learnings.md` §2 for the production-code
//! friction this surfaces.

#![allow(dead_code)] // Per-test binaries only use a subset of helpers.

use paintkiduakan_lib::commands::day_close::NewDayClose;
use paintkiduakan_lib::commands::purchases::{self, InwardLine, NewPurchase};
use paintkiduakan_lib::commands::sales::{CartLine, NewSale, PaymentSplit};
use paintkiduakan_lib::commands::vendors::VendorPayment;
use paintkiduakan_lib::db::Db;
use paintkiduakan_lib::error::{AppError, AppResult};
use paintkiduakan_lib::session::{Role, User};

/// Stable test ids — the seed runs in a fixed order so tests can refer to
/// specific rows by id without a SELECT round-trip.
pub const OWNER_ID: i64 = 1;
pub const CASHIER_ID: i64 = 2;
pub const STOCKER_ID: i64 = 3;
pub const LOCATION_ID: i64 = 1;
pub const CUSTOMER_ID: i64 = 1;
pub const VENDOR_ID: i64 = 1;
pub const ITEM_RED_ID: i64 = 1;
pub const ITEM_BLUE_ID: i64 = 2;

/// The single closing day used by the day-close cross-command flow tests.
pub const TEST_DAY: &str = "2026-06-19";

/// All per-item stock is pre-loaded at 100 base units via a single inward.
pub const PRELOADED_STOCK: f64 = 100.0;

/// All money values in this fixture are paise (integer). 1 INR = 100 paise.
pub const RED_RETAIL: i64 = 10_000; // ₹100.00
pub const RED_COST: i64 = 5_000; // ₹50.00
pub const BLUE_RETAIL: i64 = 20_000; // ₹200.00
pub const BLUE_COST: i64 = 10_000; // ₹100.00

/// Owned snapshot of the in-memory database plus the seed ids and session
/// users. Dropping the fixture drops the in-memory DB.
pub struct Fixture {
    pub db: Db,
    pub owner: User,
    pub cashier: User,
    pub stocker: User,
    pub customer_phone: &'static str,
    pub vendor_phone: Option<&'static str>,
}

/// Build a fresh in-memory database, apply the production schema + inline
/// migrations, and seed the canonical fixture.
pub fn setup() -> Fixture {
    let db = Db::open_in_memory().expect("Db::open_in_memory should open with prod cipher");

    // `Db::open_in_memory` only applies SCHEMA_FINAL; the production
    // startup path additionally runs inline migrations inline (e.g.
    // M-INLINE-021 adds `cash_in_paise` and `cash_out_paise` to
    // `day_close`). Day-close tests depend on these columns, so replay
    // them here via raw SQL.
    db.with_raw(|c| {
        c.execute_batch(
            "ALTER TABLE day_close ADD COLUMN cash_in_paise INTEGER NOT NULL DEFAULT 0;\
             ALTER TABLE day_close ADD COLUMN cash_out_paise INTEGER NOT NULL DEFAULT 0;",
        )
        .expect("day_close columns");
    });

    seed_users(&db);
    seed_location(&db);
    seed_customer(&db);
    seed_vendor(&db);
    seed_items(&db);
    seed_initial_stock(&db);

    let owner = User {
        id: OWNER_ID,
        name: "Owner".into(),
        role: Role::Owner,
    };
    let cashier = User {
        id: CASHIER_ID,
        name: "Cashier".into(),
        role: Role::Cashier,
    };
    let stocker = User {
        id: STOCKER_ID,
        name: "Stocker".into(),
        role: Role::Stocker,
    };

    Fixture {
        db,
        owner,
        cashier,
        stocker,
        customer_phone: "9876543210",
        vendor_phone: Some("9876501234"),
    }
}

fn seed_users(db: &Db) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO users \
                (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
             VALUES ('Owner','owner',   X'00',X'00',6,1,0,0)",
            [],
        )
        .expect("seed owner");
        c.execute(
            "INSERT INTO users \
                (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
             VALUES ('Cashier','cashier',X'00',X'00',6,1,0,0)",
            [],
        )
        .expect("seed cashier");
        c.execute(
            "INSERT INTO users \
                (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
             VALUES ('Stocker','stocker',X'00',X'00',6,1,0,0)",
            [],
        )
        .expect("seed stocker");
    });
}

fn seed_location(db: &Db) {
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO locations \
                (name, zone, is_default, is_active, created_at, updated_at) \
             VALUES ('Shop',NULL,1,1,0,0)",
            [],
        )
        .expect("seed location");
    });
}

fn seed_customer(db: &Db) {
    // The production `create_customer` Tauri command body is inline (no
    // `create_customer_impl(db, &user, payload)` export). Replay the same
    // INSERT here so the row is byte-identical to what the command would
    // write.
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO customers \
                (name, phone, customer_type_id, is_flagged, opening_balance_paise, notes, is_active, created_at, updated_at) \
             VALUES ('Walk-in Customer', '9876543210', NULL, 0, 0, NULL, 1, \
                     datetime('now','localtime'), datetime('now','localtime'))",
            [],
        )
        .expect("seed customer");
    });
    let id: i64 = db.with_raw(|c| {
        c.query_row(
            "SELECT id FROM customers WHERE phone = '9876543210'",
            [],
            |r| r.get(0),
        )
        .expect("customer id")
    });
    assert_eq!(id, CUSTOMER_ID, "customer id drift broke fixture");
}

fn seed_vendor(db: &Db) {
    // The production `create_vendor` is a `#[tauri::command]` whose body is
    // inline (no separate `create_vendor_impl(db, &user, payload)` export).
    // We replay the same INSERT here to keep the fixture honest: the row
    // produced must be byte-identical to what the Tauri command would write.
    let now = chrono::Utc::now().timestamp_millis();
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO vendors \
                (name, phone, opening_balance_paise, notes, is_active, created_at, updated_at) \
             VALUES ('Acme Paints', '9876501234', 0, NULL, 1, ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed vendor");
    });
    let id: i64 = db.with_raw(|c| {
        c.query_row("SELECT id FROM vendors WHERE name = 'Acme Paints'", [], |r| {
            r.get(0)
        })
        .expect("vendor id")
    });
    assert_eq!(id, VENDOR_ID, "vendor id drift broke fixture");
}

fn seed_items(db: &Db) {
    // Schema final seeds `sale_units` (pcs, mtr, kg) and `units` (L, ml, kg, g,
    // pc, box, bundle, roll, sqft, sqm). Items use the legacy `unit_code` /
    // `unit_label` denormalized strings; the `sell_unit_id` falls back to
    // (SELECT id FROM sale_units WHERE code = 'pcs') at write time, so we
    // leave it NULL.
    db.with_raw(|c| {
        c.execute(
            "INSERT INTO items \
                (sku_code, barcode, name, unit_code, unit_label, retail_price_paise, cost_paise, is_active, created_at, updated_at) \
             VALUES ('TEST-RED','8900000001','Red',  'pc','Piece', ?1, ?2, 1, 0, 0)",
            rusqlite::params![RED_RETAIL, RED_COST],
        )
        .expect("seed red item");
        c.execute(
            "INSERT INTO items \
                (sku_code, barcode, name, unit_code, unit_label, retail_price_paise, cost_paise, is_active, created_at, updated_at) \
             VALUES ('TEST-BLU','8900000002','Blue', 'pc','Piece', ?1, ?2, 1, 0, 0)",
            rusqlite::params![BLUE_RETAIL, BLUE_COST],
        )
        .expect("seed blue item");
    });
}

fn seed_initial_stock(db: &Db) {
    // One opening-stock inward with no vendor for each item. The `pcs` unit
    // type is the default the schema seeds into `sale_units`.
    let inward = |item_id: i64, qty: f64| NewPurchase {
        vendor_id: None,
        date: Some(TEST_DAY.into()),
        notes: Some("opening stock".into()),
        lines: vec![InwardLine {
            item_id,
            qty,
            unit_type: "pcs".into(),
            unit_price_paise: 0,
            location_id: LOCATION_ID,
        }],
    };
    let _ = purchases::create_inward(db, OWNER_ID, inward(ITEM_RED_ID, PRELOADED_STOCK))
        .expect("seed red stock");
    let _ = purchases::create_inward(db, OWNER_ID, inward(ITEM_BLUE_ID, PRELOADED_STOCK))
        .expect("seed blue stock");
}

// ---- Domain builders ------------------------------------------------------

/// Build a `CartLine` for an item. `qty` is base units; the production
/// conversion table (box→base, etc.) is the front-end's job.
pub fn item_line(item_id: i64, qty: f64, price_paise: i64) -> CartLine {
    CartLine {
        kind: "item".into(),
        item_id: Some(item_id),
        formula_id: None,
        display_name: None,
        qty,
        price: price_paise,
        unit_type: "pcs".into(),
        line_discount: 0,
        shade_note: None,
    }
}

/// Build a single-mode payment split.
pub fn pay(mode: &str, amount_paise: i64) -> PaymentSplit {
    PaymentSplit {
        mode: mode.into(),
        amount: amount_paise,
    }
}

/// Build a final-bill `NewSale` for the canonical walk-in case. Caller
/// controls `date`, `paid_amount`, and `payment_modes` so the same builder
/// powers both happy-path and validation tests.
pub fn final_sale(
    customer_id: Option<i64>,
    date: &str,
    paid_amount: i64,
    payment_modes: Vec<PaymentSplit>,
    lines: Vec<CartLine>,
) -> NewSale {
    NewSale {
        customer_id,
        kind: "final".into(),
        date: Some(date.into()),
        bill_discount: 0,
        paid_amount,
        payment_modes,
        validity_days: None,
        acknowledge_flag: false,
        lines,
    }
}

/// Build a NewDayClose request.
pub fn close_day(date: &str, opening: i64, counted: i64) -> NewDayClose {
    NewDayClose {
        date: Some(date.into()),
        opening_cash: opening,
        cash_in: 0,
        cash_out: 0,
        counted_cash: counted,
        notes: None,
        backup_decision: "fresh".into(),
    }
}

/// Build a vendor payment payload.
pub fn vendor_payment(vendor_id: i64, amount: i64, mode: &str, date: &str) -> VendorPayment {
    VendorPayment {
        vendor_id,
        amount,
        mode: mode.into(),
        date: date.into(),
        notes: None,
    }
}

// ---- Convenience accessors ------------------------------------------------

/// Read the current stock balance for `(item_id, location_id)`. Returns
/// 0.0 if the row does not exist.
pub fn stock_qty(db: &Db, item_id: i64, location_id: i64) -> f64 {
    db.with_raw(|c| {
        c.query_row(
            "SELECT COALESCE(SUM(qty), 0) FROM stock_balances WHERE item_id = ?1 AND location_id = ?2",
            rusqlite::params![item_id, location_id],
            |r| r.get(0),
        )
        .unwrap_or(0.0)
    })
}

/// Read the latest day_close row for a `(day, location_id)`. Returns
/// `None` if no close exists yet.
pub fn day_close_for(db: &Db, day: &str, location_id: i64) -> Option<paintkiduakan_lib::commands::day_close::DayClose> {
    use paintkiduakan_lib::commands::day_close::DayClose;
    db.with_raw(|c| {
        c.query_row(
            "SELECT id, day, location_id, user_id, opening_cash_paise, cash_sales_paise, \
                    card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise, \
                    actual_cash_paise, variance_paise, note, created_at, updated_at, \
                    cash_in_paise, cash_out_paise \
             FROM day_close WHERE day = ?1 AND location_id = ?2",
            rusqlite::params![day, location_id],
            |r| {
                Ok(DayClose {
                    id: r.get(0)?,
                    day: r.get(1)?,
                    location_id: r.get(2)?,
                    user_id: r.get(3)?,
                    opening_cash_paise: r.get(4)?,
                    cash_sales_paise: r.get(5)?,
                    card_sales_paise: r.get(6)?,
                    upi_sales_paise: r.get(7)?,
                    expenses_paise: r.get(8)?,
                    closing_cash_paise: r.get(9)?,
                    actual_cash_paise: r.get(10)?,
                    variance_paise: r.get(11)?,
                    note: r.get(12)?,
                    created_at: r.get::<_, i64>(13)?.to_string(),
                    updated_at: r.get::<_, i64>(14)?.to_string(),
                    cash_in_paise: r.get(15)?,
                    cash_out_paise: r.get(16)?,
                })
            },
        )
        .ok()
    })
}

/// Read a sale row by id and project to the fields tests assert on.
pub fn sale_total(db: &Db, sale_id: i64) -> i64 {
    db.with_raw(|c| {
        c.query_row(
            "SELECT total FROM sales WHERE id = ?1",
            rusqlite::params![sale_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    })
}

pub fn sale_status(db: &Db, sale_id: i64) -> String {
    db.with_raw(|c| {
        c.query_row(
            "SELECT status FROM sales WHERE id = ?1",
            rusqlite::params![sale_id],
            |r| r.get(0),
        )
        .unwrap_or_default()
    })
}

pub fn sale_no(db: &Db, sale_id: i64) -> String {
    db.with_raw(|c| {
        c.query_row(
            "SELECT no FROM sales WHERE id = ?1",
            rusqlite::params![sale_id],
            |r| r.get(0),
        )
        .unwrap_or_default()
    })
}

/// Read the per-mode payment totals for a sale from `sale_payments` (the
/// source of truth for `cash_sales_for` and the day-close summary).
pub fn sale_payment_totals(db: &Db, sale_id: i64) -> Vec<(String, i64)> {
    db.with_raw(|c| {
        let mut stmt = c
            .prepare(
                "SELECT mode, amount_paise FROM sale_payments \
                 WHERE sale_id = ?1 ORDER BY id",
            )
            .expect("prepare sale_payments");
        let rows = stmt
            .query_map(rusqlite::params![sale_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .expect("query sale_payments");
        rows.filter_map(Result::ok).collect()
    })
}

pub fn purchase_total_in_db(db: &Db, purchase_id: i64) -> i64 {
    db.with_raw(|c| {
        c.query_row(
            "SELECT total_paise FROM purchases WHERE id = ?1",
            rusqlite::params![purchase_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    })
}

pub fn vendor_outstanding_in_db(db: &Db, vendor_id: i64) -> i64 {
    db.with_raw(|c| {
        let opening: i64 = c
            .query_row(
                "SELECT COALESCE(opening_balance_paise, 0) FROM vendors WHERE id = ?1",
                rusqlite::params![vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let total_purchases: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
                rusqlite::params![vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let total_payments: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
                rusqlite::params![vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        opening + total_purchases - total_payments
    })
}

pub fn customer_outstanding_in_db(db: &Db, customer_id: i64) -> i64 {
    paintkiduakan_lib::commands::customers::customer_outstanding_impl(db, customer_id)
        .map(|o| o.outstanding)
        .unwrap_or(0)
}

// Re-export the AppError matcher to keep the call sites readable.
pub fn assert_app_error<T: std::fmt::Debug>(result: AppResult<T>, matcher: impl Fn(&AppError) -> bool) {
    match result {
        Ok(value) => panic!(
            "expected AppError, got Ok({value:?}) — test asserted on a happy path but the code returned success"
        ),
        Err(e) => assert!(
            matcher(&e),
            "AppError did not match expected predicate: {e:?} (code = {}, user_message = {})",
            e.code(),
            e.user_message()
        ),
    }
}

pub fn assert_app_error_msg<T: std::fmt::Debug>(result: AppResult<T>, expected_msg_substr: &str) {
    assert_app_error(result, |e| {
        e.to_string().contains(expected_msg_substr)
            || e.user_message().contains(expected_msg_substr)
    })
}

// ---- Vendor payment replication ------------------------------------------
//
// The production `record_vendor_payment` Tauri command is inline (no
// `_impl(db, &user, payload)` export). We exercise the same SQL with the
// same validation order the command body runs, so the test is the real
// public surface minus the Tauri-state plumbing.

/// Validate and persist a vendor payment, returning the new outstanding.
/// Mirrors `record_vendor_payment` (commands/vendors.rs:267-313) without the
/// `tauri::State` lookup.
pub fn record_vendor_payment_impl(
    db: &Db,
    user: &User,
    payload: VendorPayment,
) -> AppResult<i64> {
    if payload.amount <= 0 {
        return Err(AppError::Validation("amount must be > 0".into()));
    }
    if payload.mode.trim().is_empty() {
        return Err(AppError::Validation("mode is required".into()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let date_ms = chrono::NaiveDate::parse_from_str(&payload.date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|t| t.and_utc().timestamp_millis())
        .unwrap_or(now);
    // Compute outstanding inside the same transaction (not after commit).
    // Calling `vendor_outstanding_in_db(db, ...)` from inside the closure
    // would re-acquire `db.conn` and deadlock (the closure already holds
    // the lock).
    db.with_tx(|tx| {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = ?1)",
                rusqlite::params![payload.vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!(
                "vendor {}",
                payload.vendor_id
            )));
        }
        tx.execute(
            "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) \
             VALUES (?1, NULL, ?2, ?3, NULL, ?4, ?5, ?6)",
            rusqlite::params![
                payload.vendor_id,
                payload.mode,
                payload.amount,
                payload.notes,
                date_ms,
                user.id,
            ],
        )?;
        let opening: i64 = tx
            .query_row(
                "SELECT COALESCE(opening_balance_paise, 0) FROM vendors WHERE id = ?1",
                rusqlite::params![payload.vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let total_purchases: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
                rusqlite::params![payload.vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let total_payments: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
                rusqlite::params![payload.vendor_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(opening + total_purchases - total_payments)
    })
}

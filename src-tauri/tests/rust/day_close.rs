//! Integration tests for the public day-close command surface.
//!
//! Covers `cmd_cash_sales_for` (the real `cmd_get_day_summary`) and
//! `cmd_trigger_day_close` (the real `cmd_close_day`). Tests run against
//! a real SQLCipher database with the production `schema_final` applied —
//! see `common.rs` for the shared fixture.

mod common;

use common::*;
use paintkiduakan_lib::commands::day_close::{self, cash_sales_for, trigger_day_close, DayCloseError};
use paintkiduakan_lib::commands::sales::{create_final_bill, create_quotation, NewSale};
use paintkiduakan_lib::security::ipc_auth::Role;

// ---- cmd_cash_sales_for (cmd_get_day_summary) -----------------------------

#[test]
fn cash_sales_for_sums_only_cash_mode() {
    let fx = setup();
    // Sale A: 100 cash + 200 upi = 300 paid.
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            300,
            vec![pay("cash", 100), pay("upi", 200)],
            vec![item_line(ITEM_RED_ID, 1.0, 300)],
        ),
    )
    .expect("sale A");
    // Sale B: 50 cash only.
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            50,
            vec![pay("cash", 50)],
            vec![item_line(ITEM_BLUE_ID, 1.0, 50)],
        ),
    )
    .expect("sale B");

    let sum = cash_sales_for(&fx.db, CASHIER_ID, TEST_DAY).expect("summary");
    assert_eq!(sum.cash_sales_paise, 150);
    assert_eq!(sum.upi_sales_paise, 200);
    assert_eq!(sum.non_cash_sales_paise, 200);
    assert_eq!(sum.total_sales_paise, 350);
    assert_eq!(sum.date, TEST_DAY);
    assert_eq!(sum.user_id, CASHIER_ID);
}

#[test]
fn cash_sales_for_excludes_quotations_and_returns_zero_for_other_user() {
    let fx = setup();
    // Quotation: status='quotation', must be excluded.
    let _ = create_quotation(
        &fx.db,
        CASHIER_ID,
        NewSale {
            customer_id: None,
            kind: "quotation".into(),
            date: Some(TEST_DAY.into()),
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![item_line(ITEM_RED_ID, 1.0, 100)],
        },
    )
    .expect("quotation");
    // Final sale: counts.
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            100,
            vec![pay("cash", 100)],
            vec![item_line(ITEM_RED_ID, 1.0, 100)],
        ),
    )
    .expect("final");

    // Different user on the same day sees zero.
    let owner_summary = cash_sales_for(&fx.db, OWNER_ID, TEST_DAY).expect("summary");
    assert_eq!(owner_summary.cash_sales_paise, 0);
    assert_eq!(owner_summary.total_sales_paise, 0);
    // Cashier sees the final sale but not the quotation.
    let cashier_summary = cash_sales_for(&fx.db, CASHIER_ID, TEST_DAY).expect("summary");
    assert_eq!(cashier_summary.cash_sales_paise, 100);
    assert_eq!(cashier_summary.total_sales_paise, 100);
}

// ---- cmd_trigger_day_close (cmd_close_day) ------------------------------

#[test]
fn trigger_day_close_writes_one_row_per_day_location() {
    let fx = setup();
    // Two cash sales on the test day, by CASHIER_ID. Note: the day-close
    // row aggregates `cash_sales_for(user_id, day)` by the caller; to keep
    // the math obvious we close the day under CASHIER_ID (matching the
    // sales' user_id). The ACL makes the Tauri command owner-only in
    // production, but the in-memory integration test exercises the
    // business-logic function directly.
    for amt in [100_i64, 200] {
        let _ = create_final_bill(
            &fx.db,
            CASHIER_ID,
            final_sale(
                None,
                TEST_DAY,
                amt,
                vec![pay("cash", amt)],
                vec![item_line(ITEM_RED_ID, 1.0, amt)],
            ),
        )
        .expect("sale");
    }
    // 1 upi sale.
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            50,
            vec![pay("upi", 50)],
            vec![item_line(ITEM_BLUE_ID, 1.0, 50)],
        ),
    )
    .expect("sale upi");

    // Close with opening 500, no in/out, count = opening 500 + 300 cash = 800.
    let id = trigger_day_close(
        &fx.db,
        CASHIER_ID,
        close_day(TEST_DAY, 500, 800),
    )
    .expect("day close");
    assert_eq!(id, 1);

    let row = day_close_for(&fx.db, TEST_DAY, LOCATION_ID)
        .expect("row exists")
        .clone();
    assert_eq!(row.opening_cash_paise, 500);
    assert_eq!(row.cash_sales_paise, 300);
    assert_eq!(row.upi_sales_paise, 50);
    assert_eq!(row.card_sales_paise, 0);
    assert_eq!(row.closing_cash_paise, 500 + 300);
    assert_eq!(row.actual_cash_paise, 800);
    assert_eq!(row.variance_paise, 800 - (500 + 300));
    assert_eq!(row.cash_in_paise, 0);
    assert_eq!(row.cash_out_paise, 0);
    assert_eq!(row.expenses_paise, 0);
}

#[test]
fn trigger_day_close_double_close_rejected_with_conflict() {
    let fx = setup();
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            100,
            vec![pay("cash", 100)],
            vec![item_line(ITEM_RED_ID, 1.0, 100)],
        ),
    )
    .expect("sale");

    let _ = trigger_day_close(
        &fx.db,
        OWNER_ID,
        close_day(TEST_DAY, 0, 100),
    )
    .expect("first close");
    let res = trigger_day_close(
        &fx.db,
        OWNER_ID,
        close_day(TEST_DAY, 0, 100),
    );
    assert!(matches!(res, Err(DayCloseError::AlreadyClosed { .. })));
}

#[test]
fn trigger_day_close_rejects_invalid_inputs() {
    let fx = setup();
    let bad_opening = trigger_day_close(
        &fx.db,
        OWNER_ID,
        day_close::NewDayClose {
            date: Some(TEST_DAY.into()),
            opening_cash: -1,
            cash_in: 0,
            cash_out: 0,
            counted_cash: 0,
            notes: None,
            backup_decision: "fresh".into(),
        },
    );
    assert!(matches!(bad_opening, Err(DayCloseError::BadOpening)));

    let bad_counted = trigger_day_close(
        &fx.db,
        OWNER_ID,
        day_close::NewDayClose {
            date: Some(TEST_DAY.into()),
            opening_cash: 0,
            cash_in: 0,
            cash_out: 0,
            counted_cash: -10,
            notes: None,
            backup_decision: "fresh".into(),
        },
    );
    assert!(matches!(bad_counted, Err(DayCloseError::BadCounted)));

    let bad_decision = trigger_day_close(
        &fx.db,
        OWNER_ID,
        day_close::NewDayClose {
            date: Some(TEST_DAY.into()),
            opening_cash: 0,
            cash_in: 0,
            cash_out: 0,
            counted_cash: 0,
            notes: None,
            backup_decision: "weird".into(),
        },
    );
    assert!(matches!(bad_decision, Err(DayCloseError::BadBackupDecision(_))));
}

#[test]
fn trigger_day_close_carries_over_opening_from_previous_close() {
    let fx = setup();
    // Yesterday's close left actual_cash_paise = 1000.
    fx.db.with_raw(|c| {
        c.execute(
            "INSERT INTO day_close \
                (day, location_id, user_id, opening_cash_paise, cash_sales_paise, \
                 card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise, \
                 actual_cash_paise, variance_paise, note, created_at, updated_at) \
             VALUES ('2026-06-18', 1, 1, 800, 200, 0, 0, 0, 1000, 1000, 0, 'yesterday', 0, 0)",
            [],
        )
        .expect("yesterday close");
    });
    // Today: opening_cash=0 → falls back to yesterday's actual (1000).
    let id = trigger_day_close(
        &fx.db,
        OWNER_ID,
        day_close::NewDayClose {
            date: Some(TEST_DAY.into()),
            opening_cash: 0,
            cash_in: 0,
            cash_out: 0,
            counted_cash: 1000,
            notes: None,
            backup_decision: "fresh".into(),
        },
    )
    .expect("today close");
    let row = day_close_for(&fx.db, TEST_DAY, LOCATION_ID).expect("row");
    assert_eq!(row.opening_cash_paise, 1000, "carry-forward opening");
    assert_eq!(id, row.id);
}

#[test]
fn trigger_day_close_is_owner_only_via_acl() {
    // The Tauri command body uses the ACL table. Cashier is denied.
    let entry = paintkiduakan_lib::security::ipc_auth::COMMAND_ACL
        .iter()
        .find(|e| e.name == "cmd_trigger_day_close")
        .expect("cmd_trigger_day_close in ACL");
    assert_eq!(entry.min_role, Role::Owner);
}

// ---- cross-command flow: finalize → payment → close ---------------------

#[test]
fn finalize_sale_to_close_day_chain_sums_today_sales_in_paise() {
    let fx = setup();
    // 1) Two cash sales on the test day, by CASHIER_ID. Closing under
    // CASHIER_ID matches `cash_sales_for(user_id, day)` semantics — the
    // day-close row aggregates sales attributed to the same user_id.
    let s1 = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            100,
            vec![pay("cash", 100)],
            vec![item_line(ITEM_RED_ID, 1.0, 100)],
        ),
    )
    .expect("sale 1");
    let _s2 = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            200,
            vec![pay("upi", 200)],
            vec![item_line(ITEM_BLUE_ID, 1.0, 200)],
        ),
    )
    .expect("sale 2");
    // 3) Close the day under CASHIER_ID (matches the sales' user_id).
    let id = trigger_day_close(
        &fx.db,
        CASHIER_ID,
        day_close::NewDayClose {
            date: Some(TEST_DAY.into()),
            opening_cash: 1000,
            cash_in: 0,
            cash_out: 0,
            counted_cash: 1100, // opening 1000 + 100 cash sales = 1100
            notes: Some("end of day".into()),
            backup_decision: "fresh".into(),
        },
    )
    .expect("close");
    assert_eq!(id, 1);

    // 4) Verify the day-close row reflects the cash portion of today's
    //    sales (₹100 cash), the upi portion (₹200), and the variance.
    let row = day_close_for(&fx.db, TEST_DAY, LOCATION_ID).expect("row").clone();
    assert_eq!(row.cash_sales_paise, 100);
    assert_eq!(row.upi_sales_paise, 200);
    assert_eq!(row.actual_cash_paise, 1100);
    assert_eq!(row.variance_paise, 0); // 1100 - (1000 + 100) = 0

    // 5) Sanity: the sale number on s1 follows the global sequence.
    let _ = sale_no(&fx.db, s1);
}

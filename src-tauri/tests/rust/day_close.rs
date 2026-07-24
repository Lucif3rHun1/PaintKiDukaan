//! Integration tests for the public day-close command surface.
//!
//! Covers `cmd_cash_sales_for` (the real `cmd_get_day_summary`) and
//! `cmd_trigger_day_close` (the real `cmd_close_day`). Tests run against
//! a real SQLCipher database with the production `schema_final` applied —
//! see `common.rs` for the shared fixture.

mod common;

use common::*;
use paintkiduakan_lib::commands::day_close::{
    self, cash_sales_for, count_active_cashiers, trigger_day_close, trigger_day_close_auto_mode,
    trigger_day_close_shop, DayCloseError, DayCloseMode,
};
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


// ---- C5 / audit-3 A2: runtime mode per active cashier count ---------------

/// Helper: seed a second cashier so the fixture represents a 2-cashier shop.
/// Returns the new user's id.
fn seed_second_cashier(fx: &Fixture) -> i64 {
    fx.db.with_raw(|c| {
        c.execute(
            "INSERT INTO users \
                (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
             VALUES ('Cashier2','cashier',X'00',X'00',6,1,0,0)",
            [],
        )
        .expect("seed cashier2");
        c.query_row(
            "SELECT id FROM users WHERE name='Cashier2'",
            [],
            |r| r.get(0),
        )
        .expect("cashier2 id")
    })
}

#[test]
fn single_cashier_mode_writes_shop_level_close_with_null_user() {
    // Given: a shop with exactly one active cashier and one sale on TEST_DAY.
    let fx = setup();
    assert_eq!(count_active_cashiers(&fx.db).unwrap(), 1);
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

    // When: the auto-mode dispatcher closes the day.
    let preview = trigger_day_close_auto_mode(
        &fx.db,
        CASHIER_ID,
        close_day(TEST_DAY, 500, 600), // 500 opening + 100 cash sales = 600 expected
    )
    .expect("auto-mode close");

    // Then: mode is Shop, shop_total is the close row, per_cashier is empty,
    // the persisted row has user_id IS NULL, totals are correct.
    assert_eq!(preview.mode, DayCloseMode::Shop);
    assert_eq!(preview.per_cashier.len(), 0);
    assert_eq!(preview.shop_total.user_id, None);
    assert_eq!(preview.shop_total.user_name, "Shop");
    assert_eq!(preview.shop_total.opening_cash_paise, 500);
    assert_eq!(preview.shop_total.cash_sales_paise, 100);
    assert_eq!(preview.shop_total.closing_cash_paise, 600);
    assert_eq!(preview.shop_total.actual_cash_paise, 600);
    assert_eq!(preview.shop_total.variance_paise, 0);

    let row = day_close_for(&fx.db, TEST_DAY, LOCATION_ID)
        .expect("row")
        .clone();
    assert_eq!(row.user_id, None, "shop-level close must have NULL user_id");
    assert_eq!(row.cash_sales_paise, 100);
    assert_eq!(row.closing_cash_paise, 600);
}

#[test]
fn single_cashier_mode_rejects_double_close_with_conflict() {
    // Given: 1 active cashier, one close already done.
    let fx = setup();
    let _ = trigger_day_close_shop(&fx.db, close_day(TEST_DAY, 0, 0)).expect("first close");

    // When + Then: a second shop-level close for the same (day, location_id)
    // is rejected. The partial unique index `day_close_shop_uniq` makes this
    // impossible at the DB level; the application check returns a friendly
    // error.
    let res = trigger_day_close_shop(&fx.db, close_day(TEST_DAY, 0, 0));
    assert!(matches!(res, Err(DayCloseError::AlreadyClosed { .. })));
}

#[test]
fn two_cashier_mode_writes_per_cashier_rows_with_distinct_user_ids() {
    // Given: a shop with 2 active cashiers and one sale per cashier.
    let fx = setup();
    let cashier2 = seed_second_cashier(&fx);
    assert_eq!(count_active_cashiers(&fx.db).unwrap(), 2);

    // Cashier 1: 100 cash sale.
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
    .expect("sale 1");
    // Cashier 2: 200 upi sale.
    let _ = create_final_bill(
        &fx.db,
        cashier2,
        final_sale(
            None,
            TEST_DAY,
            200,
            vec![pay("upi", 200)],
            vec![item_line(ITEM_BLUE_ID, 1.0, 200)],
        ),
    )
    .expect("sale 2");

    // When: each cashier closes their own shift via the auto-mode dispatcher.
    let preview1 = trigger_day_close_auto_mode(
        &fx.db,
        CASHIER_ID,
        close_day(TEST_DAY, 1000, 1100), // 1000 + 100 cash sales = 1100
    )
    .expect("close 1");
    let preview2 = trigger_day_close_auto_mode(
        &fx.db,
        cashier2,
        close_day(TEST_DAY, 500, 500), // 500 + 0 cash sales = 500 (their 200 was upi)
    )
    .expect("close 2");

    // Then: each preview is in Cashier mode, the per_cashier list now has 2
    // rows with distinct user_ids, and shop_total equals their element-wise
    // sum. The second preview reflects the full picture of the day.
    assert_eq!(preview1.mode, DayCloseMode::Cashier);
    assert_eq!(preview1.per_cashier.len(), 1);
    assert_eq!(preview1.per_cashier[0].user_id, Some(CASHIER_ID));

    assert_eq!(preview2.mode, DayCloseMode::Cashier);
    assert_eq!(preview2.per_cashier.len(), 2);
    let user_ids: Vec<Option<i64>> =
        preview2.per_cashier.iter().map(|p| p.user_id).collect();
    assert!(user_ids.contains(&Some(CASHIER_ID)));
    assert!(user_ids.contains(&Some(cashier2)));
    assert!(user_ids.iter().all(|u| u.is_some()), "all per-cashier rows have real user_id");

    // Shop total = sum of per_cashier totals.
    let sum_opening: i64 = preview2.per_cashier.iter().map(|p| p.opening_cash_paise).sum();
    let sum_cash: i64 = preview2.per_cashier.iter().map(|p| p.cash_sales_paise).sum();
    let sum_upi: i64 = preview2.per_cashier.iter().map(|p| p.upi_sales_paise).sum();
    let sum_closing: i64 = preview2.per_cashier.iter().map(|p| p.closing_cash_paise).sum();
    let sum_actual: i64 = preview2.per_cashier.iter().map(|p| p.actual_cash_paise).sum();
    let sum_variance: i64 = preview2.per_cashier.iter().map(|p| p.variance_paise).sum();
    assert_eq!(preview2.shop_total.opening_cash_paise, sum_opening);
    assert_eq!(preview2.shop_total.cash_sales_paise, sum_cash);
    assert_eq!(preview2.shop_total.upi_sales_paise, sum_upi);
    assert_eq!(preview2.shop_total.closing_cash_paise, sum_closing);
    assert_eq!(preview2.shop_total.actual_cash_paise, sum_actual);
    assert_eq!(preview2.shop_total.variance_paise, sum_variance);
    // 1000 + 500 = 1500 opening, 100 + 0 = 100 cash, 0 + 200 = 200 upi,
    // 1100 + 500 = 1600 closing, 0 + 0 = 0 variance.
    assert_eq!(sum_opening, 1500);
    assert_eq!(sum_cash, 100);
    assert_eq!(sum_upi, 200);
    assert_eq!(sum_closing, 1600);
    assert_eq!(sum_variance, 0);
    assert_eq!(preview2.shop_total.user_id, None);
    assert_eq!(preview2.shop_total.user_name, "Shop");
}

#[test]
fn two_cashier_mode_rejects_double_close_per_cashier_with_conflict() {
    // Given: 2 active cashiers. Cashier 1 closes their shift.
    let fx = setup();
    let cashier2 = seed_second_cashier(&fx);
    let _ = trigger_day_close(
        &fx.db,
        CASHIER_ID,
        close_day(TEST_DAY, 0, 0),
    )
    .expect("first close");

    // When + Then: the per-cashier partial unique index `day_close_user_uniq`
    // rejects a second close for the same (day, location_id, user_id) with a
    // friendly error.
    let res = trigger_day_close(&fx.db, CASHIER_ID, close_day(TEST_DAY, 0, 0));
    assert!(matches!(res, Err(DayCloseError::AlreadyClosed { .. })));

    // And: a different cashier can still close their own shift.
    let _ = trigger_day_close(&fx.db, cashier2, close_day(TEST_DAY, 0, 0))
        .expect("cashier 2 close");
}

#[test]
fn day_close_partial_unique_indexes_coexist() {
    // Schema invariant (audit-3 A2): the partial unique indexes let the
    // shop-level row (user_id IS NULL) and per-cashier rows
    // (user_id IS NOT NULL) coexist on the same (day, location_id).
    let fx = setup();
    let cashier2 = seed_second_cashier(&fx);
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

    // Insert one shop-level close and one per-cashier close on the same day.
    let _ = trigger_day_close_shop(&fx.db, close_day(TEST_DAY, 0, 0)).expect("shop close");
    let _ = trigger_day_close(&fx.db, cashier2, close_day(TEST_DAY, 0, 0))
        .expect("cashier close");

    // Then: both rows exist on the same (day, location_id) with no constraint
    // violation. The partial unique indexes are the contract.
    let rows: Vec<(i64, Option<i64>)> = fx.db.with_raw(|c| {
        let mut stmt = c
            .prepare("SELECT id, user_id FROM day_close WHERE day = ?1 AND location_id = ?2")
            .expect("prepare");
        stmt.query_map(rusqlite::params![TEST_DAY, LOCATION_ID], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
        })
        .expect("query")
        .map(|r| r.expect("row"))
        .collect()
    });
    assert_eq!(rows.len(), 2, "both shop and per-cashier rows coexist");
    let nulls = rows.iter().filter(|(_, u)| u.is_none()).count();
    let non_nulls = rows.iter().filter(|(_, u)| u.is_some()).count();
    assert_eq!(nulls, 1, "one shop-level row (user_id IS NULL)");
    assert_eq!(non_nulls, 1, "one per-cashier row (user_id IS NOT NULL)");
}

#[test]
fn day_close_acl_grants_cashier_to_count_active_cashiers() {
    // The cashier count is needed for the runtime mode dispatch; cashiers
    // themselves can call it (the UI uses it to choose the form layout).
    let entry = paintkiduakan_lib::security::ipc_auth::COMMAND_ACL
        .iter()
        .find(|e| e.name == "cmd_count_active_cashiers")
        .expect("cmd_count_active_cashiers in ACL");
    assert_eq!(entry.min_role, Role::Cashier);
}

#[test]
fn day_close_acl_keeps_trigger_owner_only() {
    // Day-close writes money; only the owner can trigger it.
    let entry = paintkiduakan_lib::security::ipc_auth::COMMAND_ACL
        .iter()
        .find(|e| e.name == "cmd_trigger_day_close")
        .expect("cmd_trigger_day_close in ACL");
    assert_eq!(entry.min_role, Role::Owner);
}

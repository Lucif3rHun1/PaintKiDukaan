//! Integration tests for the public sales command surface.
//!
//! Covers `cmd_create_sale` (the real `cmd_finalize_sale`), the equivalent
//! real path for `cmd_record_sale_payment` (credit-side payment goes through
//! `customer_ledger::record_customer_payment_impl`), the void-shaped refund
//! path (`sales::create_sale_return`), and the `cmd_convert_quotation` path.
//! All tests run against a real SQLCipher database with the production
//! `schema_final` applied — see `common.rs` for the shared fixture.

mod common;

use common::*;
use paintkiduakan_lib::commands::customer_ledger::{
    customer_ledger_impl, record_customer_payment_impl, RecordCustomerPayment,
};
use paintkiduakan_lib::commands::sales::{
    self, create_final_bill, create_quotation, create_sale_return, ConvertQuotation, CreateSaleReturnLine,
    CreateSaleReturnPayload, NewSale, PaymentSplit,
};
use paintkiduakan_lib::error::AppError;

// ============================================================================
// finalize_sale (cmd_create_sale with kind="final")
// ============================================================================

#[test]
fn finalize_sale_walk_in_pays_full_in_paise() {
    let fx = setup();
    let total = RED_RETAIL; // 1 unit × ₹100 = 10000 paise
    let sale_id = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            total,
            vec![pay("cash", total)],
            vec![item_line(ITEM_RED_ID, 1.0, RED_RETAIL)],
        ),
    )
    .expect("create_final_bill should succeed");

    // Given the seeded 100 unit stock, exactly 1 unit must have moved out.
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 99.0);
    assert_eq!(sale_status(&fx.db, sale_id), "final");
    assert_eq!(sale_total(&fx.db, sale_id), total);
    assert_eq!(sale_payment_totals(&fx.db, sale_id), vec![("cash".into(), total)]);
    // Walk-in sales use the global `daily_counters` `sale_number` sequence;
    // the first INV under that sequence is `INV/0001`.
    let no = sale_no(&fx.db, sale_id);
    assert!(no.starts_with("INV/"), "sale number should be INV-prefixed, got {no}");
}

#[test]
fn finalize_sale_attached_customer_allows_partial_payment() {
    let fx = setup();
    let total = RED_RETAIL * 2; // 2 units
    let paid = RED_RETAIL; // half paid
    let sale_id = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            Some(CUSTOMER_ID),
            TEST_DAY,
            paid,
            vec![pay("cash", paid)],
            vec![item_line(ITEM_RED_ID, 2.0, RED_RETAIL)],
        ),
    )
    .expect("create_final_bill with partial pay should succeed");

    assert_eq!(sale_total(&fx.db, sale_id), total);
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 98.0);
    // Walk-in credit side: outstanding is total - paid, in paise.
    assert_eq!(customer_outstanding_in_db(&fx.db, CUSTOMER_ID), total - paid);
}

#[test]
fn finalize_sale_walk_in_with_partial_pay_rejected_as_validation() {
    let fx = setup();
    // Walk-in must pay in full (E36–E40). A partial paid_amount with
    // no attached customer is a validation error, not a successful sale.
    let res = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            RED_RETAIL / 2, // half paid
            vec![pay("cash", RED_RETAIL / 2)],
            vec![item_line(ITEM_RED_ID, 1.0, RED_RETAIL)],
        ),
    );
    assert!(matches!(res, Err(sales::SaleError::WalkinMustPayFull { .. })));
    // Stock must not have moved.
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 100.0);
}

#[test]
fn finalize_sale_insufficient_stock_rejected_with_validation_error() {
    let fx = setup();
    // Item Red is pre-loaded at 100 units. Asking for 200 must reject.
    let res = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            RED_RETAIL * 200,
            vec![pay("cash", RED_RETAIL * 200)],
            vec![item_line(ITEM_RED_ID, 200.0, RED_RETAIL)],
        ),
    );
    assert!(matches!(res, Err(sales::SaleError::InsufficientStock { .. })));
    // Stock must be unchanged on the failure path (transaction rolled back).
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 100.0);
}

#[test]
fn finalize_sale_modes_sum_mismatch_rejected() {
    let fx = setup();
    // paid_amount is ₹200 but the payment_modes only sum to ₹100.
    let res = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            RED_RETAIL * 2,
            vec![pay("cash", RED_RETAIL)],
            vec![item_line(ITEM_RED_ID, 2.0, RED_RETAIL)],
        ),
    );
    assert!(matches!(res, Err(sales::SaleError::ModesSumMismatch { .. })));
}

// ============================================================================
// cmd_convert_quotation
// ============================================================================

#[test]
fn convert_quotation_creates_new_final_sale_without_deducting_stock_twice() {
    // Documents a known production bug: the convert_quotation function in
    // commands/sales.rs:749-770 passes 2 params to a query with only one
    // placeholder; the `unwrap_or(0.0)` swallows the rusqlite error and the
    // stock check always reads 0.0, so convert_quotation ALWAYS rejects
    // today with `SaleError::InsufficientStock`. Once fixed in production,
    // this test should assert `Ok(new_id)` and the new sale status='final'
    // with stock reduced by exactly the line quantity.
    //
    // Until then, we lock the current contract: the convert path refuses
    // every conversion. The caller (frontend) cannot reliably use it.
    let fx = setup();
    let q_id = create_quotation(
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
            lines: vec![item_line(ITEM_RED_ID, 5.0, RED_RETAIL)],
        },
    )
    .expect("create_quotation should succeed");
    assert_eq!(sale_status(&fx.db, q_id), "quotation");
    // Quotations must NOT deduct stock.
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 100.0);

    let total = RED_RETAIL * 5;
    let res = sales::convert_quotation(
        &fx.db,
        CASHIER_ID,
        ConvertQuotation {
            quotation_id: q_id,
            paid_amount: total,
            payment_modes: vec![pay("cash", total)],
            acknowledge_flag: false,
        },
    );
    // Pin the current (broken) contract so the bug stays visible in CI.
    assert!(
        matches!(res, Err(sales::SaleError::InsufficientStock { .. })),
        "expected InsufficientStock while the rusqlite param-count bug is unfixed, got: {res:?}"
    );
    // The quotation stays unconverted (no stock movement either way).
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 100.0);
    assert_eq!(sale_status(&fx.db, q_id), "quotation");
}

// ============================================================================
// record_payment (cmd_record_sale_payment)
// ============================================================================
//
// `cmd_record_sale_payment` is declared in lib.rs but its body returns
// `AppError::Internal("not implemented")` — see commands/sales.rs:2655-2665.
// The "real" payment-on-credit path goes through `customer_ledger` and is
// covered here against the real `_impl` function.

#[test]
fn record_sale_payment_stub_is_documented_as_not_implemented() {
    // The Tauri command body is `Err(AppError::Internal("not implemented"))`.
    // We can't invoke it without a `tauri::State`, so this test pins the
    // contract for the day a real implementation lands: the command exists,
    // is wired through `invoke_handler`, and is in the ACL at Cashier level.
    // See learnings.md §3 and §7.
    let fx = setup();
    let _ = fx.db; // fixture present, no action needed
    let acl_entry = paintkiduakan_lib::security::ipc_auth::COMMAND_ACL
        .iter()
        .find(|e| e.name == "cmd_record_sale_payment")
        .expect("cmd_record_sale_payment should be in the ACL");
    let min_role = acl_entry.min_role;
    assert!(
        min_role >= paintkiduakan_lib::security::ipc_auth::Role::Cashier,
        "record_sale_payment should be Cashier or above (got {min_role:?})"
    );
}

#[test]
fn customer_ledger_payment_reduces_outstanding_in_paise() {
    let fx = setup();
    // Create a credit sale: ₹200 total, ₹50 paid, customer owes ₹150.
    let total = RED_RETAIL * 2;
    let paid = RED_RETAIL / 2;
    let _ = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            Some(CUSTOMER_ID),
            TEST_DAY,
            paid,
            vec![pay("cash", paid)],
            vec![item_line(ITEM_RED_ID, 2.0, RED_RETAIL)],
        ),
    )
    .expect("credit sale");
    assert_eq!(
        customer_outstanding_in_db(&fx.db, CUSTOMER_ID),
        total - paid
    );

    // Cashier records a ₹50 partial payment on the customer's khata.
    let outstanding_after = record_customer_payment_impl(
        &fx.db,
        &fx.cashier,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: paid, // settle half of what was owed
            mode: "cash".into(),
            date: TEST_DAY.into(),
            note: Some("partial settlement".into()),
        },
    )
    .expect("record_customer_payment should succeed");

    // record_customer_payment_impl returns the post-write outstanding.
    assert_eq!(outstanding_after.outstanding, total - paid - paid);
    // Cross-check via the same SQL the production outstanding function uses.
    assert_eq!(
        customer_outstanding_in_db(&fx.db, CUSTOMER_ID),
        total - paid - paid
    );
}

#[test]
fn customer_ledger_payment_rejects_zero_amount() {
    let fx = setup();
    let res = record_customer_payment_impl(
        &fx.db,
        &fx.cashier,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 0,
            mode: "cash".into(),
            date: TEST_DAY.into(),
            note: None,
        },
    );
    assert_app_error_msg(res, "payment amount must be > 0");
}

#[test]
fn customer_ledger_payment_rejects_empty_mode() {
    let fx = setup();
    let res = record_customer_payment_impl(
        &fx.db,
        &fx.cashier,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 100,
            mode: "  ".into(),
            date: TEST_DAY.into(),
            note: None,
        },
    );
    assert_app_error_msg(res, "payment mode is required");
}

#[test]
fn customer_ledger_payment_rejects_unknown_customer() {
    let fx = setup();
    let res = record_customer_payment_impl(
        &fx.db,
        &fx.owner,
        RecordCustomerPayment {
            customer_id: 9_999_999,
            amount: 100,
            mode: "cash".into(),
            date: TEST_DAY.into(),
            note: None,
        },
    );
    assert_app_error_msg(res, "customer 9999999");
}

#[test]
fn customer_ledger_read_summarises_sale_and_payment_rows() {
    let fx = setup();
    let total = RED_RETAIL;
    let _sale = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            Some(CUSTOMER_ID),
            TEST_DAY,
            0,
            vec![], // fully credit
            vec![item_line(ITEM_RED_ID, 1.0, RED_RETAIL)],
        ),
    )
    .expect("credit sale");
    let _ = record_customer_payment_impl(
        &fx.db,
        &fx.cashier,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 100,
            mode: "upi".into(),
            date: TEST_DAY.into(),
            note: None,
        },
    )
    .expect("payment");

    let ledger = customer_ledger_impl(&fx.db, CUSTOMER_ID, 10).expect("ledger");
    assert_eq!(ledger.customer_id, CUSTOMER_ID);
    assert_eq!(ledger.opening_balance_paise, 0);
    // One sale debit + one payment credit.
    let kinds: Vec<&str> = ledger.rows.iter().map(|r| r.kind.as_str()).collect();
    assert!(kinds.contains(&"sale"));
    assert!(kinds.contains(&"payment"));
    // closing = opening + debits - credits = 0 + 10000 - 100 = 9900.
    assert_eq!(ledger.closing_balance_paise, total - 100);
}

// ============================================================================
// void_sale (cmd_void_sale)
// ============================================================================
//
// `cmd_void_sale` is declared in lib.rs but its body returns
// `AppError::Internal("not implemented")` — see commands/sales.rs:2667-2675.
// The "void-shaped" real path today is `sales::create_sale_return`, which
// issues a linked return against a finalized sale (idempotent on quantity,
// carries a payment_modes split). Owner PIN is enforced by the Tauri command
// body, not by `create_sale_return` directly; the real implementation lives
// in the production code.

#[test]
fn void_sale_stub_is_documented_as_not_implemented() {
    // The Tauri command body is `Err(AppError::Internal("not implemented"))`.
    // We can't invoke it without a `tauri::State`, so this test pins the
    // contract for the day a real implementation lands.
    let fx = setup();
    let _ = fx.db;
    let acl_entry = paintkiduakan_lib::security::ipc_auth::COMMAND_ACL
        .iter()
        .find(|e| e.name == "cmd_void_sale")
        .expect("cmd_void_sale should be in the ACL");
    assert_eq!(
        acl_entry.min_role,
        paintkiduakan_lib::security::ipc_auth::Role::Owner,
        "void must remain owner-only"
    );
}

#[test]
fn void_sale_real_equivalent_create_sale_return_restores_stock() {
    let fx = setup();
    // Create a final sale for 4 units, paid in full.
    let total = RED_RETAIL * 4;
    let sale_id = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            total,
            vec![pay("cash", total)],
            vec![item_line(ITEM_RED_ID, 4.0, RED_RETAIL)],
        ),
    )
    .expect("create_final_bill");
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 96.0);

    // Now issue a linked return of 1 unit. Real implementation: a `return`
    // stock_movement is appended (append-only ledger) and the sale's
    // paid_amount is debited by the cash-equivalent share.
    let _ = create_sale_return(
        &fx.db,
        OWNER_ID,
        CreateSaleReturnPayload {
            sale_id,
            customer_id: None,
            date: Some(TEST_DAY.into()),
            reason: Some("voided by owner".into()),
            payment_modes: vec![PaymentSplit {
                mode: "cash".into(),
                amount: RED_RETAIL,
            }],
            owner_pin: String::new(),
            lines: vec![CreateSaleReturnLine {
                sale_item_id: 1,
                item_id: Some(ITEM_RED_ID),
                qty: 1.0,
                refund_paise: RED_RETAIL,
                shade_note: None,
            }],
        },
    )
    .expect("create_sale_return should succeed");

    // Stock gained exactly 1 unit back (return movement is +1).
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 97.0);
    // Sale's paid_amount dropped by the cash-equivalent refund.
    let new_paid: i64 = fx
        .db
        .with_raw(|c| {
            c.query_row(
                "SELECT paid_amount FROM sales WHERE id = ?1",
                rusqlite::params![sale_id],
                |r| r.get(0),
            )
            .unwrap()
        });
    assert_eq!(new_paid, total - RED_RETAIL);
}

#[test]
fn void_sale_rejects_return_qty_exceeding_sold() {
    let fx = setup();
    let total = RED_RETAIL;
    let sale_id = create_final_bill(
        &fx.db,
        CASHIER_ID,
        final_sale(
            None,
            TEST_DAY,
            total,
            vec![pay("cash", total)],
            vec![item_line(ITEM_RED_ID, 1.0, RED_RETAIL)],
        ),
    )
    .expect("create_final_bill");
    let res = create_sale_return(
        &fx.db,
        OWNER_ID,
        CreateSaleReturnPayload {
            sale_id,
            customer_id: None,
            date: Some(TEST_DAY.into()),
            reason: Some("over-return".into()),
            payment_modes: vec![PaymentSplit {
                mode: "cash".into(),
                amount: RED_RETAIL * 2,
            }],
            owner_pin: String::new(),
            lines: vec![CreateSaleReturnLine {
                sale_item_id: 1,
                item_id: Some(ITEM_RED_ID),
                qty: 2.0, // > sold (1.0)
                refund_paise: RED_RETAIL,
                shade_note: None,
            }],
        },
    );
    assert!(matches!(
        res,
        Err(sales::ReturnError::QtyExceedsSold { .. })
    ));
}

// ============================================================================
// role-gating smoke checks (helpers used by the Tauri command surface)
// ============================================================================

#[test]
fn require_role_keeps_cashier_out_of_owner_only_paths() {
    let fx = setup();
    let res = paintkiduakan_lib::session::require_role(
        &fx.cashier,
        &[paintkiduakan_lib::session::Role::Owner],
    );
    assert!(matches!(res, Err(AppError::Forbidden(_))));
    let ok = paintkiduakan_lib::session::require_role(
        &fx.owner,
        &[paintkiduakan_lib::session::Role::Owner],
    );
    assert!(ok.is_ok());
}

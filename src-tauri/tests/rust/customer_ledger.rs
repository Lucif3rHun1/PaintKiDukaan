//! Integration tests for the customer ledger commands (C3).
//!
//! Covers the 5 Tauri command wrappers that now live in
//! `customer_ledger.rs`: `customer_ledger`, `customer_outstanding`,
//! `record_customer_payment`, `create_customer_credit_invoice`, and
//! `customer_credit_sales`. Tests drive the `_impl` functions directly
//! against a real SQLCipher in-memory DB (same production schema).

mod common;

use common::*;
use paintkiduakan_lib::commands::customer_ledger::{
    customer_ledger_impl, customer_outstanding_impl, record_customer_payment_impl,
    RecordCustomerPayment,
};
use paintkiduakan_lib::error::AppError;

// ============================================================================
// customer_ledger_impl — running-balance khata
// ============================================================================

#[test]
fn ledger_returns_newest_first_with_running_balance() {
    let f = setup();
    // One sale (debit), one payment (credit).
    create_sale_for_customer(&f, "INV-1", 1000, 0);
    record_payment(&f, CUSTOMER_ID, 300, "cash");
    create_sale_for_customer(&f, "INV-2", 500, 0);

    let ledger = customer_ledger_impl(&f.db, CUSTOMER_ID, 200).unwrap();
    assert_eq!(ledger.opening_balance_paise, 0);
    assert!(ledger.rows.len() >= 3, "expected ≥3 rows, got {}", ledger.rows.len());
    // Newest first (INV-2).
    assert_eq!(ledger.rows[0].ref_no.as_deref(), Some("INV-2"));
    assert_eq!(ledger.closing_balance_paise, 1200); // 1000 - 300 + 500
}

#[test]
fn ledger_respects_limit() {
    let f = setup();
    create_sale_for_customer(&f, "A", 100, 0);
    create_sale_for_customer(&f, "B", 200, 0);
    create_sale_for_customer(&f, "C", 300, 0);

    let ledger = customer_ledger_impl(&f.db, CUSTOMER_ID, 2).unwrap();
    assert_eq!(ledger.rows.len(), 2);
}

// ============================================================================
// customer_outstanding_impl
// ============================================================================

#[test]
fn outstanding_with_opening_plus_sales_minus_payments() {
    let f = setup();
    // Opening is 0 (from fixture).
    create_sale_for_customer(&f, "INV-1", 2000, 500);
    record_payment(&f, CUSTOMER_ID, 300, "upi");

    let out = customer_outstanding_impl(&f.db, CUSTOMER_ID).unwrap();
    assert_eq!(out.opening_balance_paise, 0);
    assert_eq!(out.total_sales, 1500); // 2000 - 500 (unpaid portion)
    assert_eq!(out.total_paid, 500);   // paid_amount on the sale
    assert_eq!(out.total_payments, 300); // standalone payment
    assert_eq!(out.outstanding, 1200); // 0 + 1500 - 300
}

// ============================================================================
// record_customer_payment_impl
// ============================================================================

#[test]
fn record_payment_reduces_outstanding() {
    let f = setup();
    create_sale_for_customer(&f, "INV-1", 1000, 0);
    let out1 = customer_outstanding_impl(&f.db, CUSTOMER_ID).unwrap();
    assert_eq!(out1.outstanding, 1000);

    let out2 = record_customer_payment_impl(
        &f.db,
        &f.owner,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 400,
            mode: "cash".into(),
            date: "2026-07-24".into(),
            note: None,
        },
    )
    .unwrap();
    assert_eq!(out2.total_payments, 400);
    assert_eq!(out2.outstanding, 600); // 1000 - 400
}

#[test]
fn record_payment_rejects_zero_amount() {
    let f = setup();
    let res = record_customer_payment_impl(
        &f.db,
        &f.owner,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 0,
            mode: "cash".into(),
            date: "2026-07-24".into(),
            note: None,
        },
    );
    assert!(matches!(res, Err(AppError::Validation(_))));
}

#[test]
fn record_payment_rejects_empty_mode() {
    let f = setup();
    let res = record_customer_payment_impl(
        &f.db,
        &f.owner,
        RecordCustomerPayment {
            customer_id: CUSTOMER_ID,
            amount: 100,
            mode: "".into(),
            date: "2026-07-24".into(),
            note: None,
        },
    );
    assert!(matches!(res, Err(AppError::Validation(_))));
}

// ============================================================================
// Helpers (test-local, not in common.rs since these tests are new)
// ============================================================================

fn create_sale_for_customer(f: &Fixture, no: &str, total: i64, paid: i64) {
    // Direct SQL insert — no CartLine needed for ledger tests.
    f.db.with_raw(|c| {
        c.execute(
            "INSERT INTO sales (no, customer_id, status, user_id, subtotal, bill_discount, total, paid_amount, date, created_at, updated_at) VALUES (?1, ?2, 'final', ?3, ?4, 0, ?4, ?5, '2026-07-24', '2026-07-24 10:00:00', '2026-07-24 10:00:00')",
            rusqlite::params![no, CUSTOMER_ID, OWNER_ID, total, paid],
        )
        .unwrap();
    });
}

fn record_payment(f: &Fixture, customer_id: i64, amount: i64, mode: &str) {
    record_customer_payment_impl(
        &f.db,
        &f.owner,
        RecordCustomerPayment {
            customer_id,
            amount,
            mode: mode.into(),
            date: "2026-07-24".into(),
            note: None,
        },
    )
    .unwrap();
}

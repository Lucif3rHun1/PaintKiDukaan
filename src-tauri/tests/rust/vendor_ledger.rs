//! Integration tests for vendor ledger commands (C3).
//!
//! Covers `vendor_outstanding_impl` and `record_vendor_payment` flow.

mod common;

use common::*;
use paintkiduakan_lib::commands::vendor_ledger::vendor_outstanding_impl;

#[test]
fn vendor_outstanding_with_purchases_and_payments() {
    let f = setup();
    // Create a purchase and a payment via direct SQL (fixture already has vendor+location).
    f.db.with_raw(|c| {
        c.execute(
            "INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, created_at, updated_at) VALUES ('P-1', ?1, ?2, 8000, ?3, 0, 0)",
            rusqlite::params![VENDOR_ID, LOCATION_ID, OWNER_ID],
        )
        .unwrap();
        c.execute(
            "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (?1, NULL, 'bank', 3000, NULL, NULL, 0, ?2)",
            rusqlite::params![VENDOR_ID, OWNER_ID],
        )
        .unwrap();
    });
    let out = vendor_outstanding_impl(&f.db, VENDOR_ID).unwrap();
    assert_eq!(out.opening_balance, 0);
    assert_eq!(out.total_purchases, 8000);
    assert_eq!(out.total_payments, 3000);
    assert_eq!(out.outstanding, 5000);
}

#[test]
fn vendor_outstanding_no_activity() {
    let f = setup();
    let out = vendor_outstanding_impl(&f.db, VENDOR_ID).unwrap();
    assert_eq!(out.outstanding, 0);
}

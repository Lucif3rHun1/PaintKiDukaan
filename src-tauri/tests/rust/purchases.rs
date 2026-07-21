//! Integration tests for the public purchase and vendor-payment command
//! surface.
//!
//! Covers `cmd_create_inward` (the real `cmd_record_inward`) and
//! `record_vendor_payment` (the real `cmd_record_supplier_payment`). All
//! tests run against a real SQLCipher database with the production
//! `schema_final` applied — see `common.rs` for the shared fixture.

mod common;

use common::*;
use paintkiduakan_lib::commands::purchases::{self, create_inward, InwardLine, NewPurchase, PurchaseError};

// ---- cmd_create_inward (happy) -------------------------------------------

#[test]
fn create_inward_with_vendor_inserts_purchase_lines_and_stock_movements() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: Some(VENDOR_ID),
            date: Some(TEST_DAY.into()),
            notes: Some("test inward".into()),
            lines: vec![
                InwardLine {
                    item_id: ITEM_RED_ID,
                    qty: 10.0,
                    unit_type: "pcs".into(),
                    unit_price_paise: RED_COST,
                    location_id: LOCATION_ID,
                },
                InwardLine {
                    item_id: ITEM_BLUE_ID,
                    qty: 5.0,
                    unit_type: "pcs".into(),
                    unit_price_paise: BLUE_COST,
                    location_id: LOCATION_ID,
                },
            ],
        },
    )
    .expect("create_inward should succeed");

    let purchase = purchases::get(&fx.db, res.id)
        .expect("query")
        .expect("row exists");
    let total = 10 * RED_COST + 5 * BLUE_COST;
    assert_eq!(purchase.total, total);
    assert_eq!(purchase.vendor_id, Some(VENDOR_ID));
    assert_eq!(purchase.items.len(), 2);
    // Stock_balances is the source of truth for the POS — verify the
    // trigger maintained the pre-existing 100 units plus the new inward.
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 110.0);
    assert_eq!(stock_qty(&fx.db, ITEM_BLUE_ID, LOCATION_ID), 105.0);
    // Stock movements are append-only; the new purchase should add exactly
    // one `purchase` movement per line. (No sale movements yet on this
    // inventory because seed_initial_stock uses an opening-stock inward
    // whose movement kind is also `purchase` — see below.)
    let moves = purchases::movements_for_item(&fx.db, ITEM_RED_ID, 50).expect("moves");
    let purchase_moves: i64 = moves
        .iter()
        .filter(|m| m.r#type == "purchase")
        .map(|m| m.qty as i64)
        .sum();
    assert_eq!(purchase_moves, 110, "expected 100 seed + 10 new for Red");
}

#[test]
fn create_inward_with_null_vendor_succeeds_for_opening_stock() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None, // opening stock / no traceable vendor
            date: Some(TEST_DAY.into()),
            notes: Some("opening stock".into()),
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 3.0,
                unit_type: "pcs".into(),
                unit_price_paise: 0,
                location_id: LOCATION_ID,
            }],
        },
    )
    .expect("create_inward with null vendor should succeed");

    let purchase = purchases::get(&fx.db, res.id).expect("query").expect("row");
    assert_eq!(purchase.vendor_id, None);
    assert_eq!(purchase.vendor_name, None);
    assert_eq!(purchase.total, 0);
    assert_eq!(stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID), 103.0);
}

#[test]
fn create_inward_atomic_rolls_back_on_unknown_item() {
    let fx = setup();
    let pre = stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID);
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: Some(VENDOR_ID),
            date: Some(TEST_DAY.into()),
            notes: None,
            lines: vec![InwardLine {
                item_id: 9_999_999, // does not exist
                qty: 1.0,
                unit_type: "pcs".into(),
                unit_price_paise: 100,
                location_id: LOCATION_ID,
            }],
        },
    );
    assert!(res.is_err());
    // ItemNotFound → NotFound, mapped at the command boundary.
    let err = res.unwrap_err();
    assert!(
        matches!(err, PurchaseError::ItemNotFound(_, _)),
        "expected PurchaseError::ItemNotFound, got: {err:?}"
    );
    // No partial write must have leaked: the header row, lines, and
    // stock movement all live in the same transaction.
    let post = stock_qty(&fx.db, ITEM_RED_ID, LOCATION_ID);
    assert_eq!(pre, post, "stock must not move on failure path");
}

// ---- cmd_create_inward (errors) -----------------------------------------

#[test]
fn create_inward_rejects_empty_lines() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![],
        },
    );
    assert!(matches!(res, Err(PurchaseError::EmptyLines)));
}

#[test]
fn create_inward_rejects_zero_qty() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 0.0,
                unit_type: "pcs".into(),
                unit_price_paise: 100,
                location_id: LOCATION_ID,
            }],
        },
    );
    assert!(matches!(res, Err(PurchaseError::BadQty(_))));
}

#[test]
fn create_inward_rejects_negative_qty() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: -1.0,
                unit_type: "pcs".into(),
                unit_price_paise: 100,
                location_id: LOCATION_ID,
            }],
        },
    );
    assert!(matches!(res, Err(PurchaseError::BadQty(_))));
}

#[test]
fn create_inward_rejects_unknown_unit_type() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 1.0,
                unit_type: "roll".into(), // not in ('pcs','mtr','kg')
                unit_price_paise: 100,
                location_id: LOCATION_ID,
            }],
        },
    );
    assert!(matches!(res, Err(PurchaseError::BadUnitType(_))));
}

#[test]
fn create_inward_rejects_negative_unit_price() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 1.0,
                unit_type: "pcs".into(),
                unit_price_paise: -100,
                location_id: LOCATION_ID,
            }],
        },
    );
    assert!(matches!(res, Err(PurchaseError::BadCost(_))));
}

#[test]
fn create_inward_rejects_unknown_location() {
    let fx = setup();
    let res = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: None,
            date: None,
            notes: None,
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 1.0,
                unit_type: "pcs".into(),
                unit_price_paise: 100,
                location_id: 9_999_999,
            }],
        },
    );
    assert!(matches!(res, Err(PurchaseError::LocationNotFound(_, _))));
}

// ---- cmd_record_supplier_payment (record_vendor_payment) ----------------

#[test]
fn record_vendor_payment_reduces_outstanding_in_paise() {
    let fx = setup();
    // First, build up a vendor balance: an inward of ₹1000 owed to Acme.
    let _ = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: Some(VENDOR_ID),
            date: Some(TEST_DAY.into()),
            notes: Some("invoice PINV-1".into()),
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 20.0,
                unit_type: "pcs".into(),
                unit_price_paise: RED_COST, // 20 × 5000 = 100000 paise = ₹1000
                location_id: LOCATION_ID,
            }],
        },
    )
    .expect("inward");
    let pre = vendor_outstanding_in_db(&fx.db, VENDOR_ID);
    assert_eq!(pre, 100_000);

    // Pay ₹300 via UPI.
    let payment_amount = 30_000; // ₹300
    let outstanding_after = record_vendor_payment_impl(
        &fx.db,
        &fx.owner,
        vendor_payment(VENDOR_ID, payment_amount, "upi", TEST_DAY),
    )
    .expect("record_vendor_payment should succeed");
    assert_eq!(outstanding_after, 100_000 - payment_amount);
    assert_eq!(
        vendor_outstanding_in_db(&fx.db, VENDOR_ID),
        100_000 - payment_amount
    );
}

#[test]
fn record_vendor_payment_rejects_zero_amount() {
    let fx = setup();
    let res = record_vendor_payment_impl(
        &fx.db,
        &fx.owner,
        vendor_payment(VENDOR_ID, 0, "cash", TEST_DAY),
    );
    assert_app_error_msg(res, "amount must be > 0");
}

#[test]
fn record_vendor_payment_rejects_empty_mode() {
    let fx = setup();
    let res = record_vendor_payment_impl(
        &fx.db,
        &fx.owner,
        vendor_payment(VENDOR_ID, 100, "   ", TEST_DAY),
    );
    assert_app_error_msg(res, "mode is required");
}

#[test]
fn record_vendor_payment_rejects_unknown_vendor() {
    let fx = setup();
    let res = record_vendor_payment_impl(
        &fx.db,
        &fx.owner,
        vendor_payment(9_999_999, 100, "cash", TEST_DAY),
    );
    assert_app_error_msg(res, "vendor 9999999");
}

#[test]
fn record_vendor_payment_is_owner_only() {
    // The Tauri command body does `require_role(&user, &[Role::Owner])?`; the
    // gate helper rejects Cashier / Stocker at the role layer.
    let fx = setup();
    let res_cashier =
        paintkiduakan_lib::session::require_role(&fx.cashier, &[paintkiduakan_lib::session::Role::Owner]);
    assert!(res_cashier.is_err());
    let res_stocker =
        paintkiduakan_lib::session::require_role(&fx.stocker, &[paintkiduakan_lib::session::Role::Owner]);
    assert!(res_stocker.is_err());
    let res_owner =
        paintkiduakan_lib::session::require_role(&fx.owner, &[paintkiduakan_lib::session::Role::Owner]);
    assert!(res_owner.is_ok());
}

// ---- last-cost helper (read path exercised by the command surface) -------

#[test]
fn last_cost_for_item_returns_most_recent_inward_unit_price() {
    let fx = setup();
    // Two inwards at different costs. The most recent one wins.
    let _ = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: Some(VENDOR_ID),
            date: Some("2026-05-01".into()),
            notes: Some("first".into()),
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 1.0,
                unit_type: "pcs".into(),
                unit_price_paise: 4_000,
                location_id: LOCATION_ID,
            }],
        },
    )
    .expect("inward 1");
    let _ = create_inward(
        &fx.db,
        OWNER_ID,
        NewPurchase {
            vendor_id: Some(VENDOR_ID),
            date: Some("2026-06-01".into()),
            notes: Some("second".into()),
            lines: vec![InwardLine {
                item_id: ITEM_RED_ID,
                qty: 1.0,
                unit_type: "pcs".into(),
                unit_price_paise: 4_500,
                location_id: LOCATION_ID,
            }],
        },
    )
    .expect("inward 2");

    let last = purchases::last_cost_for_item(&fx.db, ITEM_RED_ID)
        .expect("query")
        .expect("exists");
    assert_eq!(last, 4_500);
}

#[test]
fn last_cost_for_unknown_item_returns_none() {
    let fx = setup();
    let v = purchases::last_cost_for_item(&fx.db, 9_999_999).expect("query");
    assert!(v.is_none());
}

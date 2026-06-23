//! Integration tests for customer + vendor commands (parties).
//!
//! Covers:
//!   - Customers: create / update / list / lookup / outstanding / ledger / credit sales / payments.
//!   - Vendors:   create / update / list / get / outstanding / payments.
//!
//! All money is in **paise (i64)**, never rupees. Phone numbers follow the
//! 10-digit / 6-9 first-digit rule enforced by the validator.

use paintkiduakan_lib::commands::customers::{
    create_customer_impl, customer_credit_sales_impl, customer_ledger_impl,
    customer_outstanding_impl, list_customer_bills_impl, list_customers_impl, lookup_customer_impl,
    record_customer_payment_impl, update_customer_impl, Customer, CustomerUpdate, NewCustomer,
    NewCustomerPayment,
};
use paintkiduakan_lib::commands::vendors::{
    create_vendor_impl, get_vendor_impl, list_vendor_payments_impl, list_vendors_impl,
    record_vendor_payment_impl, update_vendor_impl, vendor_outstanding_impl, NewVendor,
    VendorPayment, VendorUpdate,
};
use paintkiduakan_lib::db::Db;
use paintkiduakan_lib::error::AppError;
use paintkiduakan_lib::session::{set_current_user, Role, User};
use rusqlite::Connection;

// ───────────────────────────── Fixtures ─────────────────────────────

struct Parties {
    db: Db,
    owner_id: i64,
    cashier_id: i64,
    stocker_id: i64,
}

fn fresh_parties_db() -> Parties {
    let db = Db::open_in_memory().expect("open in-memory db");
    db.with_raw(|c: &Connection| -> rusqlite::Result<()> {
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Owner', 'owner', X'00', X'00', 6)",
            [],
        )?;
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Cashier', 'cashier', X'00', X'00', 6)",
            [],
        )?;
        c.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length)
             VALUES ('Stocker', 'stocker', X'00', X'00', 6)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let owner_id: i64 = db
        .with_raw(|c| c.query_row("SELECT id FROM users WHERE role='owner'", [], |r| r.get(0)))
        .unwrap();
    let cashier_id: i64 = db
        .with_raw(|c| c.query_row("SELECT id FROM users WHERE role='cashier'", [], |r| r.get(0)))
        .unwrap();
    let stocker_id: i64 = db
        .with_raw(|c| c.query_row("SELECT id FROM users WHERE role='stocker'", [], |r| r.get(0)))
        .unwrap();

    Parties { db, owner_id, cashier_id, stocker_id }
}

fn owner_user(p: &Parties) -> User {
    User { id: p.owner_id, name: "Owner".into(), role: Role::Owner }
}
fn cashier_user(p: &Parties) -> User {
    User { id: p.cashier_id, name: "Cashier".into(), role: Role::Cashier }
}
fn stocker_user(p: &Parties) -> User {
    User { id: p.stocker_id, name: "Stocker".into(), role: Role::Stocker }
}

fn new_customer(phone: &str, name: &str) -> NewCustomer {
    NewCustomer {
        name: name.into(),
        phone: phone.into(),
        type_id: None,
        is_flagged: None,
        opening_balance: None,
        notes: None,
    }
}

// ───────────────────────────── Customers — Create ─────────────────────────────

#[test]
fn create_customer_owner_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let c = create_customer_impl(&p.db, &owner_user(&p), new_customer("9876543210", "Ravi"))
        .expect("owner creates");
    assert_eq!(c.phone, "9876543210");
    assert_eq!(c.name, "Ravi");
    assert!(!c.is_flagged);
    assert_eq!(c.opening_balance, 0);
}

#[test]
fn create_customer_cashier_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(cashier_user(&p)));
    let c = create_customer_impl(&p.db, &cashier_user(&p), new_customer("9876543211", "Sita"))
        .expect("cashier creates");
    assert_eq!(c.name, "Sita");
}

#[test]
fn create_customer_stocker_forbidden() {
    let p = fresh_parties_db();
    set_current_user(Some(stocker_user(&p)));
    let err = create_customer_impl(&p.db, &stocker_user(&p), new_customer("9876543212", "Golu"))
        .unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn create_customer_phone_too_short_rejected() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let err = create_customer_impl(&p.db, &owner_user(&p), new_customer("98765", "Shorty"))
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn create_customer_phone_bad_first_digit_rejected() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let err = create_customer_impl(&p.db, &owner_user(&p), new_customer("5876543210", "Bad"))
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn create_customer_phone_non_digit_rejected() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let err = create_customer_impl(&p.db, &owner_user(&p), new_customer("98765abcde", "Letters"))
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn create_customer_duplicate_phone_conflicts() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    create_customer_impl(&p.db, &owner_user(&p), new_customer("9876543210", "Ravi")).unwrap();
    let err =
        create_customer_impl(&p.db, &owner_user(&p), new_customer("9876543210", "Dup")).unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
}

#[test]
fn create_customer_flagged_by_cashier_forbidden() {
    let p = fresh_parties_db();
    set_current_user(Some(cashier_user(&p)));
    let mut req = new_customer("9876543213", "Fraud");
    req.is_flagged = Some(true);
    let err = create_customer_impl(&p.db, &cashier_user(&p), req).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn create_customer_flagged_by_owner_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let mut req = new_customer("9876543214", "Risky");
    req.is_flagged = Some(true);
    let c = create_customer_impl(&p.db, &owner_user(&p), req).expect("owner flags");
    assert!(c.is_flagged);
}

// ───────────────────────────── Customers — Update ─────────────────────────────

fn insert_customer(p: &Parties, phone: &str, name: &str) -> i64 {
    set_current_user(Some(owner_user(p)));
    create_customer_impl(&p.db, &owner_user(p), new_customer(phone, name))
        .unwrap()
        .id
}

#[test]
fn update_customer_owner_can_rename() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Old Name");
    set_current_user(Some(owner_user(&p)));
    let upd = CustomerUpdate { name: Some("New Name".into()), ..Default::default() };
    let c = update_customer_impl(&p.db, &owner_user(&p), id, upd).unwrap();
    assert_eq!(c.name, "New Name");
}

#[test]
fn update_customer_cashier_succeeds() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Old");
    set_current_user(Some(cashier_user(&p)));
    let upd = CustomerUpdate { name: Some("New".into()), ..Default::default() };
    update_customer_impl(&p.db, &cashier_user(&p), id, upd).unwrap();
}

#[test]
fn update_customer_stocker_forbidden() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Old");
    set_current_user(Some(stocker_user(&p)));
    let upd = CustomerUpdate { name: Some("New".into()), ..Default::default() };
    let err = update_customer_impl(&p.db, &stocker_user(&p), id, upd).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn update_customer_empty_patch_rejected() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Old");
    set_current_user(Some(owner_user(&p)));
    let err = update_customer_impl(&p.db, &owner_user(&p), id, CustomerUpdate::default())
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn update_customer_unknown_id_not_found() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let upd = CustomerUpdate { name: Some("X".into()), ..Default::default() };
    let err = update_customer_impl(&p.db, &owner_user(&p), 99_999, upd).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn update_customer_duplicate_phone_conflicts() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "A");
    let b = insert_customer(&p, "9876543211", "B");
    set_current_user(Some(owner_user(&p)));
    let upd = CustomerUpdate { phone: Some("9876543210".into()), ..Default::default() };
    let err = update_customer_impl(&p.db, &owner_user(&p), b, upd).unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
}

#[test]
fn update_customer_flagged_by_cashier_forbidden() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "X");
    set_current_user(Some(cashier_user(&p)));
    let upd = CustomerUpdate { is_flagged: Some(true), ..Default::default() };
    let err = update_customer_impl(&p.db, &cashier_user(&p), id, upd).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn update_customer_opening_balance_by_cashier_forbidden() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "X");
    set_current_user(Some(cashier_user(&p)));
    let upd = CustomerUpdate { opening_balance: Some(1000), ..Default::default() };
    let err = update_customer_impl(&p.db, &cashier_user(&p), id, upd).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn update_customer_deactivate_hides_from_default_list() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "X");
    set_current_user(Some(owner_user(&p)));
    let upd = CustomerUpdate { is_active: Some(false), ..Default::default() };
    update_customer_impl(&p.db, &owner_user(&p), id, upd).unwrap();
    let active = list_customers_impl(&p.db, None, false).unwrap();
    assert!(active.iter().all(|c: &Customer| c.id != id));
    let all = list_customers_impl(&p.db, None, true).unwrap();
    assert!(all.iter().any(|c: &Customer| c.id == id));
}

// ───────────────────────────── Customers — List / Lookup ─────────────────────────────

#[test]
fn list_customers_query_matches_name() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "Ravi Kumar");
    insert_customer(&p, "9876543211", "Sita Devi");
    let r = list_customers_impl(&p.db, Some("ravi"), false).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].name, "Ravi Kumar");
}

#[test]
fn list_customers_query_matches_phone() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "A");
    insert_customer(&p, "9876543211", "B");
    let r = list_customers_impl(&p.db, Some("543210"), false).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].phone, "9876543210");
}

#[test]
fn list_customers_empty_query_returns_all_active() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "A");
    insert_customer(&p, "9876543211", "B");
    let r = list_customers_impl(&p.db, None, false).unwrap();
    assert_eq!(r.len(), 2);
}

#[test]
fn list_customers_ordered_by_name() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "Zebra");
    insert_customer(&p, "9876543211", "Apple");
    let r = list_customers_impl(&p.db, None, false).unwrap();
    assert_eq!(r[0].name, "Apple");
    assert_eq!(r[1].name, "Zebra");
}

#[test]
fn lookup_customer_full_phone_match() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "Ravi");
    let c = lookup_customer_impl(&p.db, "9876543210").unwrap();
    assert_eq!(c.unwrap().name, "Ravi");
}

#[test]
fn lookup_customer_substring_match() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "Ravi");
    let c = lookup_customer_impl(&p.db, "543210").unwrap();
    assert_eq!(c.unwrap().phone, "9876543210");
}

#[test]
fn lookup_customer_invalid_input_rejected() {
    let p = fresh_parties_db();
    let err = lookup_customer_impl(&p.db, "abc").unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn lookup_customer_no_match_returns_none() {
    let p = fresh_parties_db();
    assert!(lookup_customer_impl(&p.db, "9999999999").unwrap().is_none());
}

// ───────────────────────────── Customers — Outstanding / Ledger ─────────────────────────────

#[test]
fn customer_outstanding_zeros_when_no_activity() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    let o = customer_outstanding_impl(&p.db, id).unwrap();
    assert_eq!(o.total_sales, 0);
    assert_eq!(o.total_payments, 0);
    assert_eq!(o.opening_balance, 0);
    assert_eq!(o.outstanding, 0);
}

#[test]
fn customer_outstanding_includes_opening_balance() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let mut req = new_customer("9876543210", "Ravi");
    req.opening_balance = Some(5000);
    let id = create_customer_impl(&p.db, &owner_user(&p), req).unwrap().id;
    let o = customer_outstanding_impl(&p.db, id).unwrap();
    assert_eq!(o.opening_balance, 5000);
    assert_eq!(o.outstanding, 5000);
}

#[test]
fn customer_outstanding_unknown_id_not_found() {
    let p = fresh_parties_db();
    let err = customer_outstanding_impl(&p.db, 99_999).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn customer_ledger_empty_when_no_activity() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    let l = customer_ledger_impl(&p.db, id).unwrap();
    assert_eq!(l.opening_balance, 0);
    assert_eq!(l.closing_balance, 0);
    assert!(l.rows.is_empty());
}

#[test]
fn customer_ledger_excludes_opening_balance_from_rows() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let mut req = new_customer("9876543210", "Ravi");
    req.opening_balance = Some(5000);
    let id = create_customer_impl(&p.db, &owner_user(&p), req).unwrap().id;
    let l = customer_ledger_impl(&p.db, id).unwrap();
    assert_eq!(l.opening_balance, 5000);
    assert!(l.rows.is_empty(), "opening_balance must not appear as a ledger row");
}

#[test]
fn list_customer_bills_unknown_customer_returns_empty() {
    let p = fresh_parties_db();
    let bills = list_customer_bills_impl(&p.db, 99_999).unwrap();
    assert!(bills.is_empty());
}

#[test]
fn customer_credit_sales_excludes_zero_outstanding() {
    let p = fresh_parties_db();
    insert_customer(&p, "9876543210", "Ravi");
    let id = list_customers_impl(&p.db, None, false).unwrap()[0].id;
    let credits = customer_credit_sales_impl(&p.db, id).unwrap();
    assert!(credits.is_empty());
}

#[test]
fn customer_credit_sales_unknown_customer_returns_empty() {
    let p = fresh_parties_db();
    let credits = customer_credit_sales_impl(&p.db, 99_999).unwrap();
    assert!(credits.is_empty());
}

// ───────────────────────────── Customers — Record payment ─────────────────────────────

#[test]
fn record_customer_payment_succeeds() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    set_current_user(Some(owner_user(&p)));
    let req = NewCustomerPayment {
        customer_id: id,
        amount: 1000,
        mode: "cash".into(),
        date: None,
        notes: None,
        sale_id: None,
    };
    let o = record_customer_payment_impl(&p.db, p.owner_id, req).unwrap();
    assert_eq!(o.total_payments, 1000);
}

#[test]
fn record_customer_payment_rejects_zero_amount() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    set_current_user(Some(owner_user(&p)));
    let req = NewCustomerPayment {
        customer_id: id,
        amount: 0,
        mode: "cash".into(),
        date: None,
        notes: None,
        sale_id: None,
    };
    let err = record_customer_payment_impl(&p.db, p.owner_id, req).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_customer_payment_rejects_negative_amount() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    set_current_user(Some(owner_user(&p)));
    let req = NewCustomerPayment {
        customer_id: id,
        amount: -500,
        mode: "cash".into(),
        date: None,
        notes: None,
        sale_id: None,
    };
    let err = record_customer_payment_impl(&p.db, p.owner_id, req).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_customer_payment_rejects_bad_mode() {
    let p = fresh_parties_db();
    let id = insert_customer(&p, "9876543210", "Ravi");
    set_current_user(Some(owner_user(&p)));
    let req = NewCustomerPayment {
        customer_id: id,
        amount: 100,
        mode: "bitcoin".into(),
        date: None,
        notes: None,
        sale_id: None,
    };
    let err = record_customer_payment_impl(&p.db, p.owner_id, req).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_customer_payment_unknown_customer_not_found() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let req = NewCustomerPayment {
        customer_id: 99_999,
        amount: 100,
        mode: "cash".into(),
        date: None,
        notes: None,
        sale_id: None,
    };
    let err = record_customer_payment_impl(&p.db, p.owner_id, req).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn record_customer_payment_decreases_outstanding() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let mut req = new_customer("9876543210", "Ravi");
    req.opening_balance = Some(5000);
    let id = create_customer_impl(&p.db, &owner_user(&p), req).unwrap().id;
    let pay = NewCustomerPayment {
        customer_id: id,
        amount: 1500,
        mode: "upi".into(),
        date: Some("2026-06-15 10:30:00".into()),
        notes: Some("UTR 12345".into()),
        sale_id: None,
    };
    record_customer_payment_impl(&p.db, p.owner_id, pay).unwrap();
    let o = customer_outstanding_impl(&p.db, id).unwrap();
    assert_eq!(o.total_payments, 1500);
    // opening=5000, sales=0, paid=0, payments=1500 → 5000 + 0 - 1500 = 3500
    assert_eq!(o.outstanding, 3500);
}

// ───────────────────────────── Vendors — Create ─────────────────────────────

fn new_vendor(name: &str) -> NewVendor {
    NewVendor {
        name: name.into(),
        phone: None,
        contact_person: None,
        credit_limit: None,
        opening_balance: Some(0),
        notes: None,
    }
}

#[test]
fn create_vendor_owner_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let v = create_vendor_impl(&p.db, &owner_user(&p), new_vendor("Asian Paints Ltd")).unwrap();
    assert_eq!(v.name, "Asian Paints Ltd");
}

#[test]
fn create_vendor_stocker_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(stocker_user(&p)));
    create_vendor_impl(&p.db, &stocker_user(&p), new_vendor("Berger")).unwrap();
}

#[test]
fn create_vendor_cashier_forbidden() {
    let p = fresh_parties_db();
    set_current_user(Some(cashier_user(&p)));
    let err = create_vendor_impl(&p.db, &cashier_user(&p), new_vendor("Nippon")).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn create_vendor_empty_name_rejected() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let err = create_vendor_impl(&p.db, &owner_user(&p), new_vendor("   ")).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn create_vendor_with_all_fields() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let req = NewVendor {
        name: "Berger Paints".into(),
        phone: Some("9812345678".into()),
        contact_person: Some("Mr. Patel".into()),
        credit_limit: Some(1_000_000),
        opening_balance: Some(5000),
        notes: Some("preferred supplier".into()),
    };
    let v = create_vendor_impl(&p.db, &owner_user(&p), req).unwrap();
    assert_eq!(v.contact_person.as_deref(), Some("Mr. Patel"));
    assert_eq!(v.opening_balance, 5000);
}

// ───────────────────────────── Vendors — Update ─────────────────────────────

fn insert_vendor(p: &Parties, name: &str) -> i64 {
    set_current_user(Some(owner_user(p)));
    create_vendor_impl(&p.db, &owner_user(p), new_vendor(name)).unwrap().id
}

#[test]
fn update_vendor_owner_succeeds() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "Old");
    set_current_user(Some(owner_user(&p)));
    let upd = VendorUpdate { name: Some("New".into()), ..Default::default() };
    let v = update_vendor_impl(&p.db, &owner_user(&p), id, upd).unwrap();
    assert_eq!(v.name, "New");
}

#[test]
fn update_vendor_stocker_succeeds() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "Old");
    set_current_user(Some(stocker_user(&p)));
    let upd = VendorUpdate { name: Some("New".into()), ..Default::default() };
    update_vendor_impl(&p.db, &stocker_user(&p), id, upd).unwrap();
}

#[test]
fn update_vendor_cashier_forbidden() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "Old");
    set_current_user(Some(cashier_user(&p)));
    let upd = VendorUpdate { name: Some("New".into()), ..Default::default() };
    let err = update_vendor_impl(&p.db, &cashier_user(&p), id, upd).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn update_vendor_empty_patch_rejected() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "Old");
    set_current_user(Some(owner_user(&p)));
    let err = update_vendor_impl(&p.db, &owner_user(&p), id, VendorUpdate::default()).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn update_vendor_unknown_id_not_found() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let upd = VendorUpdate { name: Some("X".into()), ..Default::default() };
    let err = update_vendor_impl(&p.db, &owner_user(&p), 99_999, upd).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn update_vendor_deactivate_hides_from_default_list() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "Will Deactivate");
    insert_vendor(&p, "Active");
    set_current_user(Some(owner_user(&p)));
    let upd = VendorUpdate { is_active: Some(false), ..Default::default() };
    update_vendor_impl(&p.db, &owner_user(&p), id, upd).unwrap();
    let active = list_vendors_impl(&p.db, None, false).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].name, "Active");
}

// ───────────────────────────── Vendors — List / Get ─────────────────────────────

#[test]
fn list_vendors_query_matches_name() {
    let p = fresh_parties_db();
    insert_vendor(&p, "Asian Paints");
    insert_vendor(&p, "Berger Paints");
    let r = list_vendors_impl(&p.db, Some("asian"), false).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].name, "Asian Paints");
}

#[test]
fn list_vendors_query_matches_phone() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    create_vendor_impl(
        &p.db,
        &owner_user(&p),
        NewVendor { phone: Some("9812345678".into()), ..new_vendor("A") },
    )
    .unwrap();
    create_vendor_impl(
        &p.db,
        &owner_user(&p),
        NewVendor { phone: Some("9999999999".into()), ..new_vendor("B") },
    )
    .unwrap();
    let r = list_vendors_impl(&p.db, Some("1234"), false).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].phone.as_deref(), Some("9812345678"));
}

#[test]
fn list_vendors_query_matches_contact_person() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    create_vendor_impl(
        &p.db,
        &owner_user(&p),
        NewVendor { contact_person: Some("Anand Kumar".into()), ..new_vendor("Vendor1") },
    )
    .unwrap();
    create_vendor_impl(&p.db, &owner_user(&p), new_vendor("Vendor2")).unwrap();
    let r = list_vendors_impl(&p.db, Some("anand"), false).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].name, "Vendor1");
}

#[test]
fn get_vendor_existing() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    let v = get_vendor_impl(&p.db, id).unwrap();
    assert_eq!(v.name, "X");
}

#[test]
fn get_vendor_unknown_not_found() {
    let p = fresh_parties_db();
    let err = get_vendor_impl(&p.db, 99_999).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

// ───────────────────────────── Vendors — Outstanding / Payments ─────────────────────────────

#[test]
fn vendor_outstanding_zeros_when_no_activity() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    let o = vendor_outstanding_impl(&p.db, id).unwrap();
    assert_eq!(o.opening_balance, 0);
    assert_eq!(o.outstanding, 0);
}

#[test]
fn vendor_outstanding_includes_opening_balance() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let req = NewVendor { opening_balance: Some(7000), ..new_vendor("X") };
    let id = create_vendor_impl(&p.db, &owner_user(&p), req).unwrap().id;
    let o = vendor_outstanding_impl(&p.db, id).unwrap();
    assert_eq!(o.opening_balance, 7000);
    assert_eq!(o.outstanding, 7000);
}

#[test]
fn vendor_outstanding_unknown_not_found() {
    let p = fresh_parties_db();
    let err = vendor_outstanding_impl(&p.db, 99_999).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_owner_succeeds() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let req = NewVendor { opening_balance: Some(5000), ..new_vendor("X") };
    let id = create_vendor_impl(&p.db, &owner_user(&p), req).unwrap().id;
    let payload = VendorPayment {
        vendor_id: id,
        amount: 2000,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let o = record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap();
    assert_eq!(o.total_payments, 2000);
    assert_eq!(o.outstanding, 3000);
}

#[test]
fn record_vendor_payment_cashier_forbidden() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(cashier_user(&p)));
    let payload = VendorPayment {
        vendor_id: id,
        amount: 1000,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &cashier_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_stocker_forbidden() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(stocker_user(&p)));
    let payload = VendorPayment {
        vendor_id: id,
        amount: 1000,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &stocker_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_rejects_zero_amount() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(owner_user(&p)));
    let payload = VendorPayment {
        vendor_id: id,
        amount: 0,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_rejects_negative_amount() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(owner_user(&p)));
    let payload = VendorPayment {
        vendor_id: id,
        amount: -100,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_rejects_empty_mode() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(owner_user(&p)));
    let payload = VendorPayment {
        vendor_id: id,
        amount: 100,
        mode: "".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[test]
fn record_vendor_payment_unknown_vendor_not_found() {
    let p = fresh_parties_db();
    set_current_user(Some(owner_user(&p)));
    let payload = VendorPayment {
        vendor_id: 99_999,
        amount: 100,
        mode: "cash".into(),
        date: "2026-06-15".into(),
        notes: None,
    };
    let err = record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn list_vendor_payments_orders_desc_by_id() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    set_current_user(Some(owner_user(&p)));
    for amt in [100, 200, 300] {
        let payload = VendorPayment {
            vendor_id: id,
            amount: amt,
            mode: "cash".into(),
            date: "2026-06-15".into(),
            notes: None,
        };
        record_vendor_payment_impl(&p.db, &owner_user(&p), payload).unwrap();
    }
    let rows = list_vendor_payments_impl(&p.db, id, None).unwrap();
    assert_eq!(rows.len(), 3);
    // DESC by id → newest first → 300, 200, 100
    assert_eq!(rows[0].amount, 300);
    assert_eq!(rows[1].amount, 200);
    assert_eq!(rows[2].amount, 100);
}

#[test]
fn list_vendor_payments_limit_clamps_minimum_to_1() {
    let p = fresh_parties_db();
    let id = insert_vendor(&p, "X");
    let rows = list_vendor_payments_impl(&p.db, id, Some(0)).unwrap();
    assert!(rows.len() <= 1, "min clamp gives at most 1 row, got {}", rows.len());
}

#[test]
fn list_vendor_payments_unknown_vendor_returns_empty() {
    let p = fresh_parties_db();
    let rows = list_vendor_payments_impl(&p.db, 99_999, None).unwrap();
    assert!(rows.is_empty());
}
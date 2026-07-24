//! Sales / POS commands.
//!
//! Per master plan §7.3. All writes happen in a BEGIN IMMEDIATE transaction so
//! stock movements, sale rows, and the sequence bump are atomic (E31–E35).
//!
//! Credit rules (E36–E40):
//!   - walk-in customer (None): paid_amount MUST equal total (else blocked)
//!   - attached customer (Some): paid_amount ∈ [0, total] (partial payments OK)
//!   - any case: paid_amount < 0 or paid_amount > total → blocked
//!
//! Flagged customer (E41–E42b):
//!   - caller (frontend) must call `is_flagged` first and surface the ⚠️ banner.
//!     This command never blocks based on flag; it only records the fact that
//!     the operator tapped Proceed by including `acknowledge_flag` in the
//!     request (an audit field). Backend rejects if flagged+final without ack.

pub mod edit;
pub mod fbill;
pub mod final_sale;
pub mod helpers;
pub mod list;
pub mod quotation;
pub mod return_sale;

// Re-export everything so existing `sales::*` paths still work.
pub use edit::*;
pub use fbill::*;
pub use final_sale::*;
pub use helpers::*;
pub use list::*;
pub use quotation::*;
pub use return_sale::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::customers;
    use crate::db::Db;

    fn line(qty: f64, price: i64, disc: i64) -> CartLine {
        CartLine {
            kind: "item".into(),
            item_id: Some(1),
            formula_id: None,
            display_name: None,
            qty,
            price,
            unit_type: "pcs".into(),
            line_discount: disc,
            shade_note: None,
        }
    }

    #[test]
    fn line_value_basic() {
        let v = line_value(&line(2.0, 1500, 100));
        assert_eq!(v, 2900);
    }

    #[test]
    fn line_value_does_not_go_negative() {
        let v = line_value(&line(1.0, 100, 200));
        assert_eq!(v, 0);
    }

    #[test]
    fn subtotal_and_total_with_bill_discount() {
        let lines = vec![line(1.0, 1000, 0), line(2.0, 500, 0)];
        assert_eq!(cart_subtotal(&lines), 2000);
        assert_eq!(cart_total(&lines, 200), 1800);
    }

    #[test]
    fn walkin_must_pay_full() {
        let err = validate_paid(900, 1000, None).unwrap_err();
        matches!(err, SaleError::WalkinMustPayFull { .. });
        assert!(validate_paid(1000, 1000, None).is_ok());
    }

    #[test]
    fn attached_customer_allows_partial() {
        let c = customers::Customer {
            id: 1,
            name: "C".into(),
            phone: "9999000001".into(),
            customer_type_id: None,
            type_name: None,
            is_flagged: false,
            opening_balance_paise: 0,
            notes: None,
            is_active: true,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        };
        assert!(validate_paid(0, 1000, Some(&c)).is_ok());
        assert!(validate_paid(500, 1000, Some(&c)).is_ok());
        assert!(validate_paid(1000, 1000, Some(&c)).is_ok());
    }

    #[test]
    fn paid_over_total_blocked() {
        let err = validate_paid(2000, 1000, None).unwrap_err();
        matches!(err, SaleError::PaidExceedsTotal { .. });
    }

    #[test]
    fn payment_modes_sum_must_match_paid() {
        let modes = vec![
            PaymentSplit { mode: "cash".into(), amount: 500 },
            PaymentSplit { mode: "upi".into(), amount: 500 },
        ];
        assert_eq!(modes_sum(&modes), 1000);
    }

    fn ret_line(sale_item_id: i64, qty: f64, refund_paise: i64) -> CreateSaleReturnLine {
        CreateSaleReturnLine {
            sale_item_id,
            item_id: None,
            qty,
            refund_paise,
            shade_note: None,
        }
    }

    #[test]
    fn sale_return_rejects_empty_lines() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 0 }],
            owner_pin: String::new(),
            lines: vec![],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::EmptyLines));
    }

    #[test]
    fn sale_return_rejects_zero_or_negative_qty() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(10, 0.0, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::BadLineQty(0)));
    }

    #[test]
    fn sale_return_rejects_negative_refund() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(10, 1.0, -10)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::BadRefund(0)));
    }

    #[test]
    fn sale_return_rejects_missing_sale() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 999,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 100 }],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 1.0, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::SaleNotFound(999)));
    }

    #[test]
    fn sale_return_rejects_non_final_sale() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO items (sku_code, name, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
                 VALUES ('SK001', 'Test Item', 'L', 'Liter', 100, 50, 0, 0)", [],
            ).unwrap();
        });
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('QTN-X', 'quotation', '2025-01-01', 100, 0, 100, 0, 1)", [],
            ).unwrap();
        });
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 1.0, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::NotAFinalSale(1, s) if s == "quotation"));
    }

    #[test]
    fn sale_return_rejects_modes_sum_mismatch() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO items (sku_code, name, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
                 VALUES ('SK001', 'Test Item', 'L', 'Liter', 100, 50, 0, 0)", [],
            ).unwrap();
        });
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('INV-X', 'final', '2025-01-01', 100, 0, 100, 100, 1)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO sale_items (sale_id, item_id, qty, price, unit_type, line_discount, line_order) \
                 VALUES (1, 1, 10, 10, 'pcs', 0, 0)", [],
            ).unwrap();
        });
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 10 }],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 2.0, 10)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        match err {
            ReturnError::ModesSumMismatch { got, want } => {
                assert_eq!(got, 10);
                assert_eq!(want, 20);
            }
            other => panic!("expected ModesSumMismatch, got {other:?}"),
        }
    }

    fn seed_standalone_returns_env(db: &Db) {
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO items (sku_code, name, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
                 VALUES ('SK001', 'Test Item', 'L', 'Liter', 100, 50, 0, 0)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO locations (name, is_active, created_at, updated_at) \
                 VALUES ('Main Shop', 1, 0, 0)", [],
            ).unwrap();
        });
    }

    #[test]
    fn sale_return_rejects_sale_item_id_not_in_sale() {
        let db = Db::open_in_memory().unwrap();
        seed_standalone_returns_env(&db);
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('INV-X', 'final', '2025-01-01', 100, 0, 100, 100, 1)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO sale_items (sale_id, item_id, qty, price, unit_type, line_discount, line_order) \
                 VALUES (1, 1, 10, 10, 'pcs', 0, 0)", [],
            ).unwrap();
        });
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 100 }],
            owner_pin: String::new(),
            lines: vec![ret_line(999, 1.0, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::SaleItemMismatch(line_idx, 999, expected) if expected == 1 && line_idx == 0));
    }

    #[test]
    fn sale_return_caps_qty_across_multiple_returns() {
        let db = Db::open_in_memory().unwrap();
        seed_standalone_returns_env(&db);
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('INV-Y', 'final', '2025-01-01', 100, 0, 100, 100, 1)", [],
            ).unwrap();
            c.execute(
                "INSERT INTO sale_items (sale_id, item_id, qty, price, unit_type, line_discount, line_order) \
                 VALUES (1, 1, 10, 10, 'pcs', 0, 0)", [],
            ).unwrap();
        });
        let make = |qty: f64| CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            customer_id: None,
            reason: None,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: (qty * 10.0) as i64 }],
            owner_pin: String::new(),
            lines: vec![ret_line(1, qty, 10)],
        };
        create_sale_return(&db, 1, make(7.0)).unwrap();
        let err = create_sale_return(&db, 1, make(5.0)).unwrap_err();
        assert!(matches!(err, ReturnError::QtyExceedsSold { requested, already, sold, .. } if requested == 5.0 && already == 7.0 && sold == 10.0));
    }
}

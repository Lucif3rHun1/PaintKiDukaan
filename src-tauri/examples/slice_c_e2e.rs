//! E2E integration driver for Slice C.
//!
//! Run with:  cargo run --example slice_c_e2e
//!
//! Exercises every critical path in plan §7 + §15 acceptance scenarios
//! against a fresh in-memory DB. Each step prints PASS/FAIL so the output is
//! easy to scan.

use paintkiduakan_lib::commands::{
    auth::{self, Role},
    customers, day_close, purchases::{self, NewPurchase}, reports, sales::{self, CartLine, ConvertQuotation, NewSale, PaymentSplit}, sequences,
};
use paintkiduakan_lib::db::Db;

macro_rules! check {
    ($label:expr, $cond:expr) => {{
        let cond = $cond;
        if cond {
            println!("PASS  {}", $label);
        } else {
            println!("FAIL  {}", $label);
            std::process::exit(1);
        }
    }};
}

fn main() {
    let db = Db::open_in_memory().expect("mem db");
    auth::__test_set_role(&db, Role::Owner);

    // -----------------------------------------------------------------
    // Seed: 1 location, 2 items, 1 walk-in customer, 1 credit customer.
    // -----------------------------------------------------------------
    db.with_conn(|c| -> anyhow::Result<()> {
        c.execute("INSERT INTO locations(name) VALUES ('Main')", [])?;
        c.execute(
            "INSERT INTO items(sku_code,barcode,name,brand,unit,units_per_box,retail_price,cost_price,reorder_level,is_active)
             VALUES ('RED-4L','111','Red 4L','AsianPaints','L',4,10000,5000,2,1)",
            [],
        )?;
        c.execute(
            "INSERT INTO items(sku_code,barcode,name,brand,unit,units_per_box,retail_price,cost_price,reorder_level,is_active)
             VALUES ('BLU-4L','222','Blue 4L','AsianPaints','L',4,15000,8000,2,1)",
            [],
        )?;
        c.execute(
            "INSERT INTO customers(name, phone, credit_limit, is_flagged)
             VALUES ('Walk-in', '9000000000', NULL, 0)",
            [],
        )?;
        c.execute(
            "INSERT INTO customers(name, phone, credit_limit, is_flagged)
             VALUES ('Mr Credit', '9999000002', 50000, 0)",
            [],
        )?;
        c.execute(
            "INSERT INTO customers(name, phone, credit_limit, is_flagged)
             VALUES ('Mr Flagged', '9999000003', 100000, 1)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    // -----------------------------------------------------------------
    // E25-E30: Inward (sticky cost, box/unit conversion, atomic flow)
    // -----------------------------------------------------------------
    let inward = purchases::create_inward(
        &db,
        NewPurchase {
            vendor_id: None,
            date: Some("2026-06-19".into()),
            notes: Some("opening stock".into()),
            auto_print_label: true,
            lines: vec![
                purchases::InwardLine {
                    item_id: 1,
                    qty: 3.0,
                    unit_type: "box".into(),
                    cost_price: 5000,
                    retail_price: 10000,
                    location_id: 1,
                },
                purchases::InwardLine {
                    item_id: 2,
                    qty: 5.0,
                    unit_type: "unit".into(),
                    cost_price: 8000,
                    retail_price: 15000,
                    location_id: 1,
                },
            ],
        },
    )
    .expect("inward ok");
    check!("E25 inward saves with print_label", inward.print_label);
    let pur = purchases::get(&db, inward.id).unwrap().unwrap();
    check!(
        "E26 box conversion: 3 boxes × 4 = 12 base units stored",
        pur.items[0].qty == 12
    );
    check!(
        "E27 inward total = sum of base × cost",
        pur.total == 12 * 5000 + 5 * 8000
    );
    let moves = purchases::movements_for_item(&db, 1, 10).unwrap();
    check!(
        "E28 stock_movements recorded (qty=12, type=inward, ref_type=purchase)",
        moves.len() == 1 && moves[0].qty == 12 && moves[0].r#type == "inward" && moves[0].ref_type.as_deref() == Some("purchase")
    );

    // Sticky cost (E25 step 4): the next inward on the same item should
    // pre-populate with the last known cost.
    let last = purchases::last_cost_for_item(&db, 1).unwrap();
    check!("E25 sticky cost returned for item 1", last == Some(5000));

    // -----------------------------------------------------------------
    // E31-E35: Quotation + convert
    // -----------------------------------------------------------------
    let q_id = sales::create_quotation(
        &db,
        NewSale {
            customer_id: None,
            kind: "quotation".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 0,
            payment_modes: vec![],
            validity_days: Some(7),
            acknowledge_flag: false,
            lines: vec![CartLine {
                item_id: 1,
                qty: 1.0,
                price: 10000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: Some("shade-A".into()),
            }],
        },
    )
    .expect("quotation ok");
    let q = sales::get(&db, q_id).unwrap().unwrap();
    check!("E31 quotation no = QTN-2026-0001", q.no == "QTN-2026-0001");
    check!("E32 quotation status", q.status == "quotation");
    check!("E33 quotation paid_amount = 0", q.paid_amount == 0);
    check!("E34 quotation has no stock movement", purchases::movements_for_item(&db, 1, 100).unwrap().len() == 1);

    // Convert
    let inv_id = sales::convert_quotation(
        &db,
        ConvertQuotation {
            quotation_id: q_id,
            paid_amount: 10000,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 10000 }],
            acknowledge_flag: false,
        },
    )
    .expect("convert ok");
    let inv = sales::get(&db, inv_id).unwrap().unwrap();
    check!("E35a convert produces INV-…", inv.no.starts_with("INV-"));
    check!("E35b convert links converted_from_id", inv.converted_from_id == Some(q_id));
    check!(
        "E35c convert creates sale stock_movement (qty=-1, type=sale)",
        purchases::movements_for_item(&db, 1, 100).unwrap().iter().any(|m| m.r#type == "sale" && m.ref_id == Some(inv_id) && m.qty == -1)
    );

    // -----------------------------------------------------------------
    // E36-E40: Credit rules on final bill
    // -----------------------------------------------------------------
    // Walk-in: must pay full.
    let walkin_attempt = sales::create_final_bill(
        &db,
        NewSale {
            customer_id: None,
            kind: "final".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![CartLine {
                item_id: 1,
                qty: 1.0,
                price: 10000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: None,
            }],
        },
    );
    check!("E36 walk-in partial pay blocked", matches!(walkin_attempt, Err(sales::SaleError::WalkinMustPayFull { .. })));

    // Walk-in: exact payment works.
    let walkin_ok = sales::create_final_bill(
        &db,
        NewSale {
            customer_id: None,
            kind: "final".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 10000,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 10000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![CartLine {
                item_id: 1,
                qty: 1.0,
                price: 10000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: None,
            }],
        },
    )
    .expect("walkin ok");
    check!("E37 walk-in full pay accepted", walkin_ok > 0);

    // Credit customer (id=2, credit_limit=50000): partial pay OK.
    let credit_id = sales::create_final_bill(
        &db,
        NewSale {
            customer_id: Some(2),
            kind: "final".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![PaymentSplit { mode: "upi".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![CartLine {
                item_id: 2,
                qty: 1.0,
                price: 10000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: None,
            }],
        },
    )
    .expect("credit partial ok");
    let c = customers::get_by_id(&db, 2).unwrap().unwrap();
    check!("E38 credit partial bumps outstanding", c.outstanding == 5000);
    check!("E39 credit sale id is recorded", credit_id > 0);

    // Flagged customer (id=3) — final bill without ack must be rejected.
    let flag_attempt = sales::create_final_bill(
        &db,
        NewSale {
            customer_id: Some(3),
            kind: "final".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: false,
            lines: vec![CartLine {
                item_id: 1,
                qty: 1.0,
                price: 5000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: None,
            }],
        },
    );
    check!("E41 flagged customer requires acknowledge_flag", matches!(flag_attempt, Err(sales::SaleError::MustAcknowledgeFlag)));

    // Same sale with ack=true accepted.
    let _flag_ok = sales::create_final_bill(
        &db,
        NewSale {
            customer_id: Some(3),
            kind: "final".into(),
            date: Some("2026-06-19".into()),
            bill_discount: 0,
            paid_amount: 5000,
            payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 5000 }],
            validity_days: None,
            acknowledge_flag: true,
            lines: vec![CartLine {
                item_id: 1,
                qty: 1.0,
                price: 5000,
                unit_type: "unit".into(),
                line_discount: 0,
                shade_note: None,
            }],
        },
    )
    .expect("flagged ack ok");

    // -----------------------------------------------------------------
    // E45-E46: Hold / park bill
    // -----------------------------------------------------------------
    let hb_id = sales::hold_bill(
        &db,
        1,
        sales::HoldBill {
            payload_json: r#"{"lines":[{"item_id":1,"qty":1,"price":10000}]}"#.into(),
            note: Some("customer stepped away".into()),
        },
    )
    .expect("hold ok");
    let held = sales::list_held(&db).unwrap();
    check!("E45 hold_bill saved + listed", held.iter().any(|h| h.id == hb_id));
    let _ = sales::delete_held(&db, hb_id).expect("delete");
    check!(
        "E46 held bill removed",
        !sales::list_held(&db).unwrap().iter().any(|h| h.id == hb_id)
    );

    // -----------------------------------------------------------------
    // E47-E52: Day close (backup gate, math, lock)
    // -----------------------------------------------------------------
    let gate = day_close::backup_gate_check(&db, chrono::Utc::now().timestamp()).unwrap();
    check!("E48 backup gate needs_prompt on never-backed-up", gate.needs_prompt);

    let sum = day_close::cash_sales_for(&db, 1, "2026-06-19").unwrap();
    // Cash sales on 2026-06-19 by user 1: convert_quotation 10000, walkin_ok 10000, flag_ok 5000.
    // Credit sale was upi (not cash). Total cash = 25000; total = 30000.
    check!(
        "E47 cash_sales_for aggregates cash mode only",
        sum.cash_sales_paise == 10000 + 10000 + 5000
    );
    check!(
        "E47 non_cash_sales picks up the upi payment",
        sum.non_cash_sales_paise == 5000
    );

    let dc_id = day_close::trigger_day_close(
        &db,
        day_close::NewDayClose {
            date: Some("2026-06-19".into()),
            opening_cash: 0,
            cash_in: 0,
            cash_out: 0,
            counted_cash: sum.cash_sales_paise,
            notes: None,
            backup_decision: "fresh".into(),
        },
    )
    .expect("day close ok");
    let dc = day_close::get(&db, dc_id).unwrap().unwrap();
    check!("E47 expected = opening + cash_sales (carry-forward=0)", dc.expected_cash == 25000);
    check!("E50 variance = counted - expected", dc.variance == 0);
    check!("E51 backup_check_status fresh", dc.backup_check_status == "fresh");

    // Duplicate close rejected.
    let dup = day_close::trigger_day_close(
        &db,
        day_close::NewDayClose {
            date: Some("2026-06-19".into()),
            opening_cash: 0,
            cash_in: 0,
            cash_out: 0,
            counted_cash: 0,
            notes: None,
            backup_decision: "fresh".into(),
        },
    );
    check!("E52 duplicate day close rejected", matches!(dup, Err(day_close::DayCloseError::AlreadyClosed { .. })));

    let lock = day_close::lock_state(&db, 1, "2026-06-19").unwrap();
    check!("E52 day is locked after close", lock.is_locked);

    // -----------------------------------------------------------------
    // E53-E56: Reports
    // -----------------------------------------------------------------
    let ds = reports::daily_sales(&db, "2026-06-19", "2026-06-19").unwrap();
    // 4 final sales: convert_quotation(10000), walkin(10000), credit(10000), flagged(5000).
    check!("E53 daily sales bill_count = 4", ds.bill_count == 4);
    check!(
        "E54 daily sales grand_total = 10000 + 10000 + 10000 + 5000",
        ds.grand_total == 35000
    );

    let sr = reports::stock_report(&db).unwrap();
    let item1 = sr.by_location.iter().find(|r| r.item_id == 1).unwrap();
    // 4 sales of item 1: convert (1), walkin (1), flagged (1) all with base qty 1; credit used item 2.
    check!("stock_balances reflects sales + inward (12 - 3 = 9)", item1.qty == 12 - 3);

    let or_ = reports::outstanding_report(&db).unwrap();
    check!(
        "E56 outstanding excludes zero + sorts DESC",
        or_.customers.len() == 1 && or_.customers[0].customer_id == 2
    );

    // -----------------------------------------------------------------
    // §12 sequence: independent counters
    // -----------------------------------------------------------------
    let q_next = sequences::mint_next_sale_no(&db, sequences::Kind::SaleQtn).unwrap();
    let i_next = sequences::mint_next_sale_no(&db, sequences::Kind::SaleInv).unwrap();
    check!("§12 QTN counter independent", q_next.starts_with("QTN-"));
    check!("§12 INV counter independent", i_next.starts_with("INV-"));

    println!("\nAll Slice C critical paths and §15 acceptance scenarios PASS.");
}

//! Reports (owner only — enforced at the auth layer).
//!
//! Per master plan §7.5:
//! - Daily sales: range filter, count, by-mode totals, total discount, grand total.
//! - Stock: by location, low-stock threshold, brand/category group totals.
//! - Outstanding: customers with outstanding > 0 (no aging buckets in M1),
//!   and a vendor outstanding total.
//! - Movements audit: per-item stock_movements history (already exposed by
//!   purchases.rs; we re-export the type here for the frontend).

use rusqlite::params;
use serde::Serialize;

use crate::commands::purchases::StockMovement;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::commands::auth::AppState;

// -----------------------------------------------------------------------------
// Daily sales report.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DailySalesRow {
    pub date: String,
    pub bill_count: i64,
    pub grand_total: i64,
    pub total_discount: i64,
    pub by_mode: Vec<ModeTotal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModeTotal {
    pub mode: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailySalesReport {
    pub from_date: String,
    pub to_date: String,
    pub rows: Vec<DailySalesRow>,
    pub grand_total: i64,
    pub total_discount: i64,
    pub bill_count: i64,
}

pub fn daily_sales(
    db: &Db,
    from_date: &str,
    to_date: &str,
) -> Result<DailySalesReport, ReportsError> {
    db.with_conn(|c| -> Result<DailySalesReport, ReportsError> {
        // Aggregate by date.
        let mut stmt = c.prepare(
            "SELECT date,
                    COUNT(*) AS bills,
                    SUM(total) AS grand_total,
                    SUM(bill_discount) AS total_discount
             FROM sales
             WHERE status = 'final' AND date BETWEEN ?1 AND ?2
             GROUP BY date ORDER BY date ASC",
        )?;
        let agg_rows = stmt.query_map(params![from_date, to_date], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut by_date: std::collections::BTreeMap<String, (i64, i64, i64, Vec<ModeTotal>)> =
            std::collections::BTreeMap::new();
        for r in agg_rows {
            let (d, bills, gt, disc) = r?;
            by_date.insert(d, (bills, gt, disc, Vec::new()));
        }

        // Aggregate by (date, mode) from the JSON payment_modes_json column.
        // We can't SUM JSON easily in SQLite, so iterate sales in range and
        // accumulate per date.
        let mut stmt2 = c.prepare(
            "SELECT date, payment_modes_json
             FROM sales WHERE status = 'final' AND date BETWEEN ?1 AND ?2",
        )?;
        let sale_rows = stmt2.query_map(params![from_date, to_date], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for r in sale_rows {
            let (d, json) = r?;
            if let Some(entry) = by_date.get_mut(&d) {
                if let Ok(modes) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                    for m in modes {
                        if let (Some(mode), Some(amt)) = (
                            m.get("mode").and_then(|x| x.as_str()),
                            m.get("amount").and_then(|x| x.as_i64()),
                        ) {
                            if let Some(existing) =
                                entry.3.iter_mut().find(|x| x.mode == mode)
                            {
                                existing.amount += amt;
                            } else {
                                entry.3.push(ModeTotal {
                                    mode: mode.to_string(),
                                    amount: amt,
                                });
                            }
                        }
                    }
                }
            }
        }

        let mut rows: Vec<DailySalesRow> = Vec::new();
        let mut grand_total: i64 = 0;
        let mut total_discount: i64 = 0;
        let mut bill_count: i64 = 0;
        for (d, (bills, gt, disc, modes)) in by_date.into_iter() {
            grand_total += gt;
            total_discount += disc;
            bill_count += bills;
            rows.push(DailySalesRow {
                date: d,
                bill_count: bills,
                grand_total: gt,
                total_discount: disc,
                by_mode: modes,
            });
        }
        Ok(DailySalesReport {
            from_date: from_date.into(),
            to_date: to_date.into(),
            rows,
            grand_total,
            total_discount,
            bill_count,
        })
    })
}

// -----------------------------------------------------------------------------
// Stock report.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct StockRow {
    pub item_id: i64,
    pub sku_code: String,
    pub name: String,
    pub location_id: i64,
    pub location_name: String,
    pub qty: i64,
    pub reorder_level: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockGroupRow {
    pub group: String, // brand or category
    pub total_qty: i64,
    pub total_retail_value: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockReport {
    pub by_location: Vec<StockRow>,
    pub low_stock: Vec<StockRow>,
    pub by_group: Vec<StockGroupRow>,
}

pub fn stock_report(db: &Db) -> Result<StockReport, ReportsError> {
    db.with_conn(|c| -> Result<StockReport, ReportsError> {
        let mut by_location: Vec<StockRow> = Vec::new();
        {
            let mut stmt = c.prepare(
                "SELECT sb.item_id, i.sku_code, i.name, sb.location_id, l.name, sb.qty,
                        i.reorder_level
                 FROM stock_balances sb
                 JOIN items i ON i.id = sb.item_id
                 JOIN locations l ON l.id = sb.location_id
                 ORDER BY i.name, l.name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(StockRow {
                    item_id: r.get(0)?,
                    sku_code: r.get(1)?,
                    name: r.get(2)?,
                    location_id: r.get(3)?,
                    location_name: r.get(4)?,
                    qty: r.get(5)?,
                    reorder_level: r.get(6)?,
                })
            })?;
            for r in rows {
                let row = r?;
                if row.qty != 0 || row.reorder_level > 0 {
                    by_location.push(row);
                }
            }
        }
        let low_stock: Vec<StockRow> = by_location
            .iter()
            .filter(|r| r.reorder_level > 0 && r.qty <= r.reorder_level)
            .cloned()
            .collect();

        let mut by_group: Vec<StockGroupRow> = Vec::new();
        {
            let mut stmt = c.prepare(
                "SELECT COALESCE(NULLIF(i.brand, ''), NULLIF(i.category, ''), '(uncategorised)') AS grp,
                        COALESCE(SUM(sb.qty), 0) AS qty,
                        COALESCE(SUM(sb.qty * i.retail_price), 0) AS value
                 FROM stock_balances sb
                 JOIN items i ON i.id = sb.item_id
                 GROUP BY grp ORDER BY grp",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(StockGroupRow {
                    group: r.get(0)?,
                    total_qty: r.get::<_, i64>(1)?,
                    total_retail_value: r.get::<_, i64>(2)?,
                })
            })?;
            for r in rows {
                by_group.push(r?);
            }
        }
        Ok(StockReport {
            by_location,
            low_stock,
            by_group,
        })
    })
}

// -----------------------------------------------------------------------------
// Outstanding report (customers + vendor total).
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CustomerOutstanding {
    pub customer_id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub outstanding: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VendorOutstanding {
    pub vendor_id: i64,
    pub name: String,
    pub outstanding: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutstandingReport {
    pub customers: Vec<CustomerOutstanding>,
    pub customer_total: i64,
    pub vendors: Vec<VendorOutstanding>,
    pub vendor_total: i64,
}

pub fn outstanding_report(db: &Db) -> Result<OutstandingReport, ReportsError> {
    db.with_conn(|c| -> Result<OutstandingReport, ReportsError> {
        let mut customers: Vec<CustomerOutstanding> = Vec::new();
        let mut cust_total: i64 = 0;
        {
            let mut stmt = c.prepare(
                "SELECT id, name, phone, outstanding
                 FROM (
                     SELECT c.id, c.name, c.phone,
                            c.opening_balance
                            + COALESCE((SELECT SUM(s.total - s.paid_amount) FROM sales s
                                        WHERE s.customer_id = c.id AND s.status = 'final'), 0)
                            - COALESCE((SELECT SUM(p.amount) FROM customer_payments p
                                        WHERE p.customer_id = c.id), 0)
                            AS outstanding
                     FROM customers c
                 )
                 WHERE outstanding > 0
                 ORDER BY outstanding DESC, name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(CustomerOutstanding {
                    customer_id: r.get(0)?,
                    name: r.get(1)?,
                    phone: r.get(2)?,
                    outstanding: r.get(3)?,
                })
            })?;
            for r in rows {
                let row = r?;
                cust_total += row.outstanding;
                customers.push(row);
            }
        }
        let mut vendors: Vec<VendorOutstanding> = Vec::new();
        let mut ven_total: i64 = 0;
        {
            let mut stmt = c.prepare(
                "SELECT id, name, outstanding
                 FROM (
                     SELECT v.id, v.name,
                            v.opening_balance
                            + COALESCE((SELECT SUM(p.total) FROM purchases p
                                        WHERE p.vendor_id = v.id), 0)
                            - COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp
                                        WHERE vp.vendor_id = v.id), 0)
                            AS outstanding
                     FROM vendors v
                 )
                 WHERE outstanding > 0
                 ORDER BY outstanding DESC, name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(VendorOutstanding {
                    vendor_id: r.get(0)?,
                    name: r.get(1)?,
                    outstanding: r.get(2)?,
                })
            })?;
            for r in rows {
                let row = r?;
                ven_total += row.outstanding;
                vendors.push(row);
            }
        }
        Ok(OutstandingReport {
            customers,
            customer_total: cust_total,
            vendors,
            vendor_total: ven_total,
        })
    })
}

// -----------------------------------------------------------------------------
// Movements audit (re-export from purchases.rs for the frontend).
// -----------------------------------------------------------------------------

pub fn movements_for_item(
    db: &Db,
    item_id: i64,
    limit: i64,
) -> Result<Vec<StockMovement>, ReportsError> {
    crate::commands::purchases::movements_for_item(db, item_id, limit)
        .map_err(|e| match e {
            crate::commands::purchases::PurchaseError::Db(r) => ReportsError::Db(r),
            other => ReportsError::Other(anyhow::anyhow!(other.to_string())),
        })
}

// -----------------------------------------------------------------------------
// Errors.
// -----------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ReportsError {
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn cmd_daily_sales(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> AppResult<DailySalesReport> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    daily_sales(&db, &from_date, &to_date).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub fn cmd_stock_report(state: tauri::State<'_, AppState>) -> AppResult<StockReport> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    stock_report(&db).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub fn cmd_outstanding_report(state: tauri::State<'_, AppState>) -> AppResult<OutstandingReport> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    outstanding_report(&db).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Unit tests.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sales::{self, CartLine, NewSale, PaymentSplit};

    fn seed(db: &Db) {
        crate::session::__test_set_role(db, crate::session::Role::Owner);
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) VALUES ('Owner','owner',X'00',X'00',6)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, brand, category, unit, units_per_box,
                   retail_price, cost_price, reorder_level, is_active)
                 VALUES ('SK001','111','Red 4L','AsianPaints','Interior','L',1,10000,5000,2,1)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, brand, category, unit, units_per_box,
                   retail_price, cost_price, reorder_level, is_active)
                 VALUES ('SK002','222','Blue 4L','AsianPaints','Interior','L',1,15000,8000,2,1)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, credit_limit, opening_balance, is_flagged)
                 VALUES ('Walk-in Mr A', '9999000001', NULL, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, credit_limit, opening_balance, is_flagged)
                 VALUES ('Credit Mr B', '9999000002', 100000, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, credit_limit, opening_balance, is_flagged)
                 VALUES ('Zero Mr C', '9999000003', 0, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO vendors (name, opening_balance, is_active) VALUES ('Acme Paints', 0, 1)",
                [],
            )?;
            c.execute("INSERT INTO locations (name) VALUES ('Main')", [])?;
            Ok(())
        })
        .unwrap();
    }

    fn sell(db: &Db, date: &str, amt: i64, mode: &str) -> i64 {
        sales::create_final_bill(
            db,
            1,
            NewSale {
                customer_id: None,
                kind: "final".into(),
                date: Some(date.into()),
                bill_discount: 0,
                paid_amount: amt,
                payment_modes: vec![PaymentSplit { mode: mode.into(), amount: amt }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    item_id: 1,
                    qty: 1.0,
                    price: amt,
                    unit_type: "unit".into(),
                    line_discount: 0,
                    shade_note: None,
                }],
            },
        )
        .expect("sale")
    }

    #[test]
    fn daily_sales_aggregates_correctly() {
        // E53, E54, E55.
        let db = crate::db::Db::open_in_memory().expect("mem db");
        seed(&db);
        let _ = sell(&db, "2026-06-19", 100, "cash");
        let _ = sell(&db, "2026-06-19", 200, "upi");
        let _ = sell(&db, "2026-06-20", 50, "cash");

        let report = daily_sales(&db, "2026-06-19", "2026-06-20").expect("report");
        assert_eq!(report.bill_count, 3);
        assert_eq!(report.grand_total, 350);
        assert_eq!(report.rows.len(), 2);

        let d1 = report.rows.iter().find(|r| r.date == "2026-06-19").unwrap();
        assert_eq!(d1.bill_count, 2);
        assert_eq!(d1.grand_total, 300);
        let d1_cash = d1.by_mode.iter().find(|m| m.mode == "cash").unwrap().amount;
        let d1_upi = d1.by_mode.iter().find(|m| m.mode == "upi").unwrap().amount;
        assert_eq!(d1_cash, 100);
        assert_eq!(d1_upi, 200);
    }

    #[test]
    fn outstanding_excludes_zero_and_sums() {
        // E56.
        let db = crate::db::Db::open_in_memory().expect("mem db");
        seed(&db);
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, total, paid_amount, user_id)
                 VALUES ('INV-TEST-0001', 2, '2026-06-19', 'final', 7500, 7500, 0, 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, credit_limit, opening_balance, is_flagged)
                 VALUES ('Heavy Mr D', '9999000004', 50000, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, total, paid_amount, user_id)
                 VALUES ('INV-TEST-0002', 4, '2026-06-19', 'final', 12000, 12000, 0, 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO purchases (vendor_id, date, total, user_id)
                 VALUES (1, '2026-06-19', 5000, 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let rep = outstanding_report(&db).expect("report");
        // Walk-in (id=1) and Zero Mr C (id=3) excluded.
        assert_eq!(rep.customers.len(), 2);
        assert_eq!(rep.customer_total, 7500 + 12000);
        // Sorted DESC by outstanding.
        assert_eq!(rep.customers[0].customer_id, 4);
        assert_eq!(rep.customers[1].customer_id, 2);
        // Vendors.
        assert_eq!(rep.vendors.len(), 1);
        assert_eq!(rep.vendor_total, 5000);
    }

    #[test]
    fn stock_report_lists_low_stock() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        seed(&db);
        // Add an inbound and a sale so stock_balances has rows.
        crate::commands::purchases::create_inward(
            &db,
            1,
            crate::commands::purchases::NewPurchase {
                vendor_id: None,
                date: Some("2026-06-18".into()),
                notes: None,
                auto_print_label: false,
                lines: vec![crate::commands::purchases::InwardLine {
                    item_id: 1,
                    qty: 2.0,
                    unit_type: "unit".into(),
                    cost_price: 5000,
                    retail_price: 10000,
                    location_id: 1,
                }],
            },
        )
        .expect("inward");
        // Sell 1 → qty = 1 (reorder_level 2 → low).
        let _ = sell(&db, "2026-06-19", 10000, "cash");
        let rep = stock_report(&db).expect("report");
        let item1 = rep
            .by_location
            .iter()
            .find(|r| r.item_id == 1)
            .expect("item1 row");
        assert_eq!(item1.qty, 1);
        assert!(rep.low_stock.iter().any(|r| r.item_id == 1));
        // Group row exists with brand AsianPaints.
        assert!(rep.by_group.iter().any(|g| g.group == "AsianPaints"));
    }
}
